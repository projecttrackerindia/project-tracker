using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Agent;

/// <summary>
/// One tick of the project agent, for every workspace: collect new chat, run the live bots and fetch finished meetings' transcripts, read
/// what is new, send the morning updates, and look in the inboxes people opted in. Each project is handled in its own scope, acting as the
/// person who switched its agent on.
/// </summary>
public class AgentEngine(IAppDbContext db, IServiceScopeFactory scopes, ILogger<AgentEngine> log)
{
    public record TickResult(int Projects, int Runs, int Signals, int Bots, int Updates, int Inboxes);

    public async Task<TickResult> TickAsync(CancellationToken ct = default)
    {
        var projects = await db.ProjectAgentSettings.IgnoreQueryFilters().AsNoTracking()
            .Where(s => s.Enabled && db.Tenants.IgnoreQueryFilters().Any(t => t.Id == s.TenantId && t.Status == TenantStatus.Active && !t.IsDeleted)
                && db.Projects.IgnoreQueryFilters().Any(p => p.Id == s.ProjectId && !p.IsDeleted && p.Status != ProjectStatus.Archived))
            .Select(s => new { s.Id, s.TenantId, s.ActingUserId }).Take(500).ToListAsync(ct);
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
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogWarning(ex, "Project agent tick failed for {Settings}", p.Id);
            }
        }

        var optIns = await db.AgentInboxOptIns.IgnoreQueryFilters().AsNoTracking()
            .Where(o => o.Enabled && db.Tenants.IgnoreQueryFilters().Any(t => t.Id == o.TenantId && t.Status == TenantStatus.Active && !t.IsDeleted))
            .Select(o => new { o.Id, o.TenantId, o.UserId }).Take(1000).ToListAsync(ct);
        foreach (var o in optIns)
        {
            try
            {
                using var scope = scopes.CreateScope();
                var sp = scope.ServiceProvider;
                await WorkspaceExecutionPrincipal.ConfigureAsync(sp, o.UserId, o.TenantId, null, ct);
                inboxes += await sp.GetRequiredService<AgentInboxScanner>().ScanAsync(o.Id, ct);
            }
            catch (ForbiddenException) { await db.AgentInboxOptIns.IgnoreQueryFilters().Where(x => x.Id == o.Id).ExecuteUpdateAsync(u => u.SetProperty(x => x.Enabled, false), ct); }
            catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "Project agent inbox scan failed for {OptIn}", o.Id); }
        }
        return new TickResult(projects.Count, runs, signals, bots, updates, inboxes);
    }
}

/// <summary>Everything the agent does for one project in one tick, inside that project's workspace context.</summary>
public class AgentProjectTick(IAppDbContext db, AppClock clock, AgentSignalService signals, AgentMeetingService meetings, AgentAnalysisService analysis,
    AgentDailyUpdateService daily, ILogger<AgentProjectTick> log)
{
    public record Result(int Runs, int Signals, int Bots, int Updates);

    public async Task<Result> RunAsync(Guid settingsId, CancellationToken ct)
    {
        var s = await db.ProjectAgentSettings.FirstOrDefaultAsync(x => x.Id == settingsId, ct);
        if (s is null || !s.Enabled) return new(0, 0, 0, 0);
        var w = await db.AgentWorkspaceSettings.FirstOrDefaultAsync(ct);
        int added = 0, bots = 0, runs = 0, updates = 0;

        if (s.ReadChat && await signals.CollectChatAsync(s, ct)) added++;
        await db.SaveChangesAsync(ct);

        if (s.ReadMeetings)
        {
            try
            {
                if (s.LiveBot && w is not null)
                {
                    bots += await meetings.ScheduleBotsAsync(s, w, ct);
                    await meetings.NudgeAsync(s, w, ct);
                }
                added += await meetings.FinishBotsAsync(s, w, ct);
                added += await meetings.FetchTranscriptsAsync(s, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "Project agent meetings step failed for {Project}", s.ProjectId); }
        }

        // Read what is new: a meeting or mail right away, chat once it has settled; never retry a failed reading sooner than half an hour.
        var unread = await db.AgentSignals.Where(x => x.ProjectId == s.ProjectId && x.ProcessedAt == null).Select(x => new { x.Source, x.CreatedAt }).ToListAsync(ct);
        if (unread.Count > 0)
        {
            var lastFailed = await db.AgentRuns.Where(r => r.ProjectId == s.ProjectId).OrderByDescending(r => r.StartedAt).Select(r => new { r.Status, r.StartedAt }).FirstOrDefaultAsync(ct);
            var cooling = lastFailed is { Status: "failed" } && clock.Now - lastFailed.StartedAt < TimeSpan.FromMinutes(30);
            var urgent = unread.Any(x => x.Source is AgentSourceKind.MeetingTranscript or AgentSourceKind.LiveMeeting or AgentSourceKind.ProjectMailbox or AgentSourceKind.PersonalMail or AgentSourceKind.Manual);
            if (!cooling && (urgent || unread.Count >= 5 || unread.Min(x => x.CreatedAt) < clock.Now.AddMinutes(-30)))
            {
                var trigger = unread.Any(x => x.Source is AgentSourceKind.MeetingTranscript or AgentSourceKind.LiveMeeting) ? "meeting"
                    : unread.Any(x => x.Source is AgentSourceKind.ProjectMailbox or AgentSourceKind.PersonalMail) ? "mail" : "schedule";
                if (await analysis.RunAsync(s, trigger, null, ct) is not null) runs++;
            }
        }

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
            .Select(p => new { p.Id, p.TenantId, p.Key, p.Name }).Take(10).ToListAsync(ct);
        if (projects.Count == 0) { o.ScannedUntil = now; await db.SaveChangesAsync(ct); return 0; }
        var since = o.ScannedUntil is { } s0 && s0 > now.AddDays(-7) ? s0 : now.AddDays(-2);
        var terms = projects.SelectMany(p => new[] { p.Name, p.Key }).ToList();
        int added = 0;
        try
        {
            var mails = await inbox.SearchForAgentAsync(o.Provider, since, terms, 20, ct);
            foreach (var mail in mails)
            {
                var text = $"{mail.Subject}\n{mail.Body}";
                var matched = projects.Where(p => text.Contains(p.Name, StringComparison.OrdinalIgnoreCase)
                    || Regex.IsMatch(text, $@"\b{Regex.Escape(p.Key)}(-I?\d+)?\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)).Take(2);
                foreach (var p in matched)
                {
                    var content = $"From: {mail.Sender}\nSubject: {mail.Subject}\n\n{mail.Body}";
                    if (await signals.AddAsync(p.TenantId, p.Id, AgentSourceKind.PersonalMail, $"pm:{o.Provider}:{mail.Id}", mail.Subject.Length == 0 ? "(no subject)" : mail.Subject,
                            mail.Sender, content, mail.ReceivedAt?.UtcDateTime ?? now, uid, null, ct) is not null) added++;
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
