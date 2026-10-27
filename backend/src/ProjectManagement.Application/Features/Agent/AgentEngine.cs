using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Agent;

/// <summary>
/// One tick of the project agent, for every workspace: collect new chat, run the live bots and fetch finished meetings' transcripts, read
/// what is new, send the morning updates, and look in the inboxes people opted in. Each project is handled in its own scope, acting as the
/// person who switched its agent on. What Settings › AI allows decides what runs (see <see cref="AgentProjectTick"/>): with the project agent Off
/// nobody's inbox is searched for it, and with the meeting notetaker Off nobody's agent is sent to meetings in their place.
/// </summary>
public class AgentEngine(IAppDbContext db, IServiceScopeFactory scopes, AppClock clock, IOptions<AgentOptions> options, ILogger<AgentEngine> log, AiAgentGate gate)
{
    public record TickResult(int Projects, int Runs, int Signals, int Bots, int Updates, int Inboxes, int Erased = 0);

    private static DateTime _lastPurge;

    public async Task<TickResult> TickAsync(CancellationToken ct = default)
    {
        // What was read is erased after the retention period (hourly is plenty).
        var erased = 0;
        if (clock.Now - _lastPurge > TimeSpan.FromHours(1))
        {
            _lastPurge = clock.Now;
            try { erased = await AgentSignalService.PurgeAsync(db, clock.Now, options.Value.SignalRetentionDays, ct); }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested) { log.LogWarning(ex, "Project agent retention clean-up failed"); }
        }
        var projects = await db.ProjectAgentSettings.IgnoreQueryFilters().AsNoTracking()
            .Where(s => s.Enabled && db.Tenants.IgnoreQueryFilters().Any(t => t.Id == s.TenantId && t.Status == TenantStatus.Active && !t.IsDeleted)
                && db.Projects.IgnoreQueryFilters().Any(p => p.Id == s.ProjectId && !p.IsDeleted && p.Status != ProjectStatus.Archived))
            .OrderBy(s => s.Id).Select(s => new { s.Id, s.TenantId, s.ActingUserId }).Take(500).ToListAsync(ct);
        int runs = 0, signals = 0, bots = 0, updates = 0, inboxes = 0;
        foreach (var p in projects)
        {
            try
            {
                using var scope = scopes.CreateScope();
                var sp = scope.ServiceProvider;
                await WorkspaceExecutionPrincipal.ConfigureAsync(sp, p.ActingUserId, p.TenantId, null, ct);
                var r = await sp.GetRequiredService<AgentProjectTick>().RunAsync(p.Id, ct);
                runs += r.Runs; signals += r.Signals; bots += r.Bots; updates += r.Updates;
            }
            catch (ForbiddenException ex)
            {
                // The person it acts as left the workspace (or the workspace is unavailable): say so on the project, someone has to switch it on again.
                await db.ProjectAgentSettings.IgnoreQueryFilters().Where(x => x.Id == p.Id)
                    .ExecuteUpdateAsync(u => u.SetProperty(x => x.LastError, AgentAnalysisService.Cut($"The agent cannot act as the person who switched it on: {ex.Message} Switch it off and on again.", 500)), ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                log.LogWarning(ex, "Project agent tick failed for {Settings}", p.Id);
            }
        }

        // People who asked the agent to go in their place when they are double-booked.
        var people = await db.AgentPersonalSettings.IgnoreQueryFilters().AsNoTracking()
            .Where(p => p.AutoDelegate && db.Tenants.IgnoreQueryFilters().Any(t => t.Id == p.TenantId && t.Status == TenantStatus.Active && !t.IsDeleted))
            .OrderBy(p => p.Id).Select(p => new { p.Id, p.TenantId, p.UserId }).Take(2000).ToListAsync(ct);
        foreach (var person in people)
        {
            if (await gate.LevelAsync(person.TenantId, AiAgents.Notetaker, ct) == AiAgentLevel.Off) continue;
            try
            {
                using var scope = scopes.CreateScope();
                var sp = scope.ServiceProvider;
                await WorkspaceExecutionPrincipal.ConfigureAsync(sp, person.UserId, person.TenantId, null, ct);
                await sp.GetRequiredService<AgentDelegationService>().AutoDelegateAsync(ct);
            }
            catch (ForbiddenException) { await db.AgentPersonalSettings.IgnoreQueryFilters().Where(x => x.Id == person.Id).ExecuteUpdateAsync(u => u.SetProperty(x => x.AutoDelegate, false), ct); }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested) { log.LogWarning(ex, "Automatic delegation failed for {Settings}", person.Id); }
        }

        var optIns = await db.AgentInboxOptIns.IgnoreQueryFilters().AsNoTracking()
            .Where(o => o.Enabled && db.Tenants.IgnoreQueryFilters().Any(t => t.Id == o.TenantId && t.Status == TenantStatus.Active && !t.IsDeleted))
            .OrderBy(o => o.Id).Select(o => new { o.Id, o.TenantId, o.UserId }).Take(1000).ToListAsync(ct);
        foreach (var o in optIns)
        {
            if (await gate.LevelAsync(o.TenantId, AiAgents.Project, ct) == AiAgentLevel.Off) continue;
            try
            {
                using var scope = scopes.CreateScope();
                var sp = scope.ServiceProvider;
                await WorkspaceExecutionPrincipal.ConfigureAsync(sp, o.UserId, o.TenantId, null, ct);
                inboxes += await sp.GetRequiredService<AgentInboxScanner>().ScanAsync(o.Id, ct);
            }
            catch (ForbiddenException) { await db.AgentInboxOptIns.IgnoreQueryFilters().Where(x => x.Id == o.Id).ExecuteUpdateAsync(u => u.SetProperty(x => x.Enabled, false), ct); }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested) { log.LogWarning(ex, "Project agent inbox scan failed for {OptIn}", o.Id); }
        }
        await WatchAsync(ct);
        return new TickResult(projects.Count, runs, signals, bots, updates, inboxes, erased);
    }

    private static DateTime _lastWatch;

    /// <summary>
    /// Every few minutes: agent alerts and the Monday summary for each organization whose agents are in use (the agent on in a project, or the
    /// assistant used in the last two days). Each runs in that organization's own scope, as one of its owners.
    /// </summary>
    private async Task WatchAsync(CancellationToken ct)
    {
        if (clock.Now - _lastWatch < TimeSpan.FromMinutes(5)) return;
        _lastWatch = clock.Now;
        var since = clock.Now.AddDays(-2);
        List<Guid> tenantIds;
        try
        {
            tenantIds = await db.ProjectAgentSettings.IgnoreQueryFilters().Where(s => s.Enabled).Select(s => s.TenantId)
                .Union(db.AiMessages.IgnoreQueryFilters().Where(m => m.Role == "assistant" && m.CreatedAt >= since).Select(m => m.TenantId))
                .Distinct().Take(2000).ToListAsync(ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested) { log.LogWarning(ex, "Agent alerts: could not list workspaces"); return; }
        var owners = await db.TenantMembers.IgnoreQueryFilters().AsNoTracking()
            .Where(m => tenantIds.Contains(m.TenantId) && m.Role == TenantRole.Owner && m.User!.IsActive
                && db.Tenants.IgnoreQueryFilters().Any(t => t.Id == m.TenantId && t.Status == TenantStatus.Active && !t.IsDeleted && t.Type == WorkspaceType.Organization))
            .OrderBy(m => m.CreatedAt).Select(m => new { m.TenantId, m.UserId }).ToListAsync(ct);
        foreach (var o in owners.GroupBy(x => x.TenantId).Select(g => g.First()))
        {
            try
            {
                using var scope = scopes.CreateScope();
                var sp = scope.ServiceProvider;
                await WorkspaceExecutionPrincipal.ConfigureAsync(sp, o.UserId, o.TenantId, null, ct);
                await sp.GetRequiredService<AgentAlertService>().NotifyAsync(ct);
                await sp.GetRequiredService<AgentDigestService>().SendDueAsync(ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                log.LogWarning(ex, "Agent alerts or summary failed for {Tenant}", o.TenantId);
            }
        }
    }
}

/// <summary>Everything the agent does for one project in one tick, inside that project's workspace context.</summary>
public class AgentProjectTick(IAppDbContext db, AppClock clock, AgentSignalService signals, AgentMeetingService meetings, NotetakerService notetaker, AgentAnalysisService analysis,
    AgentDailyUpdateService daily, AgentSlackReader slack, AgentReviewService review, AgentFollowUpService followUps, AgentBriefService briefs,
    AgentDelegationService delegations, IOptions<AgentOptions> options, ILogger<AgentProjectTick> log, AiAgentGate gate)
{
    public record Result(int Runs, int Signals, int Bots, int Updates);

    public async Task<Result> RunAsync(Guid settingsId, CancellationToken ct)
    {
        var s = await db.ProjectAgentSettings.FirstOrDefaultAsync(x => x.Id == settingsId, ct);
        if (s is null || !s.Enabled) return new(0, 0, 0, 0);
        // What Settings › AI allows: the project agent reads and proposes; the meeting notetaker sends the bot, fetches transcripts and writes
        // minutes. Either at Off does nothing of its own (skipped quietly; the gate logs it once).
        var agentLevel = await gate.LevelAsync(s.TenantId, AiAgents.Project, ct);
        var notesOn = await gate.LevelAsync(s.TenantId, AiAgents.Notetaker, ct) != AiAgentLevel.Off;
        var agentOn = agentLevel != AiAgentLevel.Off;
        if (!agentOn && !notesOn) return new(0, 0, 0, 0);
        // Workspace defaults (bot name, reminders on) until an admin changes them.
        var w = await db.AgentWorkspaceSettings.FirstOrDefaultAsync(ct) ?? new AgentWorkspaceSettings { TenantId = s.TenantId };
        int added = 0, bots = 0, runs = 0, updates = 0;

        if (agentOn && s.ReadChat && await signals.CollectChatAsync(s, ct)) added++;
        await db.SaveChangesAsync(ct);

        // Each step on its own: one failing (a bot service down, Slack unreachable, credits used up) never stops the others.
        async Task<int> Step(string name, Func<Task<int>> work)
        {
            try { return await work(); }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                log.LogWarning(ex, "Project agent step {Step} failed for {Project}", name, s.ProjectId);
                return 0;
            }
        }
        if (agentOn && s.SlackChannelId is not null)
            added += await Step("slack", async () => { var got = await slack.CollectAsync(s, ct); await db.SaveChangesAsync(ct); return got ? 1 : 0; });
        if (s.ReadMeetings && notesOn)
        {
            // With "live bot" on the bot goes to every session; otherwise only where someone sent the agent in their place.
            bots += await Step("schedule bots", () => meetings.ScheduleBotsAsync(s, w, ct));
            if (s.LiveBot && s.AutoJoinCalendar) bots += await Step("calendar calls", () => meetings.ScheduleCalendarBotsAsync(s, w, ct));
            await Step("live reminders", () => meetings.NudgeAsync(s, w, ct));
            if (agentOn) await Step("meeting briefs", () => briefs.SendDueAsync(s, ct));
            await Step("delegation reports", () => delegations.ReportAsync(s, ct));
            await Step("automatic transcripts", () => meetings.EnableAutoTranscriptsAsync(s, ct));
            added += await Step("finish bots", () => meetings.FinishBotsAsync(s, w, ct));
            added += await Step("meet transcripts", () => meetings.FetchTranscriptsAsync(s, ct));
            bots += await Step("notetaker", () => notetaker.TickAsync(s, ct));
        }

        // Read what is new: a meeting or mail right away, chat once it has settled; never retry a failed reading sooner than half an hour.
        if (!agentOn) return new(runs, added, bots, updates);
        var unread = await db.AgentSignals.Where(x => x.ProjectId == s.ProjectId && x.ProcessedAt == null).Select(x => new { x.Source, x.CreatedAt }).ToListAsync(ct);
        if (unread.Count > 0)
        {
            var lastFailed = await db.AgentRuns.Where(r => r.ProjectId == s.ProjectId).OrderByDescending(r => r.StartedAt).Select(r => new { r.Status, r.StartedAt }).FirstOrDefaultAsync(ct);
            var cooling = lastFailed is { Status: "failed" } && clock.Now - lastFailed.StartedAt < TimeSpan.FromMinutes(30);
            // Meetings at once; mail once it has settled for a few minutes (a burst of mail is read together, not one reading each).
            var mailSettled = clock.Now.AddMinutes(-Math.Max(0, options.Value.MailBatchMinutes));
            var urgent = unread.Any(x => x.Source is AgentSourceKind.MeetingTranscript or AgentSourceKind.LiveMeeting or AgentSourceKind.Manual)
                || unread.Any(x => x.Source is AgentSourceKind.ProjectMailbox or AgentSourceKind.PersonalMail && x.CreatedAt <= mailSettled);
            if (!cooling && (urgent || unread.Count >= 5 || unread.Min(x => x.CreatedAt) < clock.Now.AddMinutes(-30)))
            {
                var trigger = unread.Any(x => x.Source is AgentSourceKind.MeetingTranscript or AgentSourceKind.LiveMeeting) ? "meeting"
                    : unread.Any(x => x.Source is AgentSourceKind.ProjectMailbox or AgentSourceKind.PersonalMail) ? "mail" : "schedule";
                if (await analysis.RunAsync(s, trigger, null, ct) is { } run)
                {
                    runs++;
                    if (run.Status == "done") await Step("autonomy", () => review.AutoApplyRunAsync(s, run.Id, ct));
                }
            }
        }

        // Check-ins ask people and turn "I need more time" into proposals for the inbox: not at "Suggest", which interrupts nobody.
        if (agentLevel >= AiAgentLevel.AskFirst) await Step("follow-ups", () => followUps.RunAsync(s, ct));
        var zone = await db.Tenants.Where(t => t.Id == s.TenantId).Select(t => t.TimeZone).FirstOrDefaultAsync(ct);
        if (daily.Due(s, zone, out var day)) updates += await daily.SendAsync(s, day, ct);
        return new(runs, added, bots, updates);
    }
}

/// <summary>Looks in one person's own inbox (they opted in) for mail about the projects they work on that have the agent switched on.</summary>
public class AgentInboxScanner(IAppDbContext db, ICurrentContext ctx, AppClock clock, PersonalInboxService inbox, AgentSignalService signals, IOptions<AgentOptions> options)
{
    public async Task<int> ScanAsync(Guid optInId, CancellationToken ct)
    {
        var o = await db.AgentInboxOptIns.FirstOrDefaultAsync(x => x.Id == optInId, ct);
        if (o is null || !o.Enabled) return 0;
        var now = clock.Now;
        if (o.ScannedUntil is { } until && now - until < TimeSpan.FromMinutes(Math.Max(5, options.Value.InboxScanMinutes))) return 0;
        var uid = ctx.RequireUserId();
        var projects = await db.Projects.AsNoTracking()
            .Where(p => p.Status != ProjectStatus.Archived && db.ProjectAgentSettings.Any(s => s.ProjectId == p.Id && s.Enabled && s.ReadMailbox)
                && (p.OwnerId == uid || db.ProjectMembers.Any(m => m.ProjectId == p.Id && m.UserId == uid) || db.Tasks.Any(t => t.ProjectId == p.Id && t.AssigneeId == uid)))
            .OrderBy(p => p.Name).Select(p => new { p.Id, p.TenantId, p.Key, p.Name }).Take(10).ToListAsync(ct);
        if (projects.Count == 0) { o.ScannedUntil = now; await db.SaveChangesAsync(ct); return 0; }
        var since = o.ScannedUntil is { } s0 && s0 > now.AddDays(-7) ? s0 : now.AddDays(-2);
        // Searched by project name; a bare key ("WEB", "APP") would match too much unrelated mail.
        var terms = projects.Select(p => p.Name).Where(n => n.Trim().Length >= 4).ToList();
        if (terms.Count == 0) { o.ScannedUntil = now; await db.SaveChangesAsync(ct); return 0; }
        int added = 0;
        try
        {
            var mails = await inbox.SearchForAgentAsync(o.Provider, since, terms, 20, ct);
            foreach (var mail in mails)
            {
                var text = $"{mail.Subject}\n{mail.Body}";
                var matched = projects.Where(p => text.Contains(p.Name, StringComparison.OrdinalIgnoreCase)
                    || Regex.IsMatch(text, $@"\b{Regex.Escape(p.Key)}-I?\d+\b", RegexOptions.CultureInvariant)).Take(2);
                foreach (var p in matched)
                {
                    var content = $"From: {mail.Sender}\nSubject: {mail.Subject}\n\n{mail.Body}";
                    // Subject and sender stay inside the encrypted content; the plain columns say no more than "an email".
                    if (await signals.AddAsync(p.TenantId, p.Id, AgentSourceKind.PersonalMail, $"pm:{o.Provider}:{mail.Id}", "Email in a member's inbox",
                            null, content, mail.ReceivedAt?.UtcDateTime ?? now, uid, null, ct) is not null) added++;
                }
            }
            o.ScannedUntil = now; o.Found += added; o.LastError = null;
        }
        catch (AppException ex)
        {
            o.LastError = AgentAnalysisService.Cut(ex.Message, 500);
            o.ScannedUntil = now;   // try again at the next interval, not every tick
        }
        o.UpdatedAt = now;
        await db.SaveChangesAsync(ct);
        return added;
    }
}
