using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Agent;

public record AgentAlertSettingsDto(bool Enabled, int MinSuccessRate, int MaxP95Seconds, int BotFailures, int ReadingFailures, int CreditDays, bool WeeklyDigest);
/// <summary>Severity: critical (something is not working now), warning (heading for trouble), info (worth knowing).</summary>
public record AgentAlertDto(string Key, string Severity, string Agent, string Title, string Detail, string Link, double? Value = null, double? Threshold = null);
public record AgentAlertsDto(AgentAlertSettingsDto Settings, IReadOnlyList<AgentAlertDto> Active, DateTime CheckedAt, DateTime? LastNotifiedCheck);

/// <summary>
/// Agent alerts: rules over the last day (no model, no credits) that tell the owners and admins when an agent needs attention - the assistant's
/// answers failing or slow, the meeting bot missing meetings or having no free worker, readings failing, AI credits running out before they
/// renew, project agents stopped at their monthly cap. The page shows what is wrong now; a notice (in-app, e-mail and push by each person's own
/// settings) goes out at most once a day per problem.
/// </summary>
public class AgentAlertService(IAppDbContext db, ICurrentContext ctx, AppClock clock, AiCreditService credits, MeetingBotClient bots, NotificationService notifications, Recorder recorder)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public const int MinAnswers = 10;

    private void RequireAdmin()
    {
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only workspace owners and admins can manage agent alerts.", "PERMISSION_DENIED");
    }

    public static AgentAlertSettingsDto Dto(AgentWorkspaceSettings w) =>
        new(w.AlertsEnabled, w.AlertMinSuccessRate, w.AlertMaxP95Seconds, w.AlertBotFailures, w.AlertReadingFailures, w.AlertCreditDays, w.WeeklyDigest);

    private async Task<AgentWorkspaceSettings> SettingsAsync(CancellationToken ct) =>
        await db.AgentWorkspaceSettings.AsNoTracking().FirstOrDefaultAsync(ct) ?? new AgentWorkspaceSettings { TenantId = ctx.RequireTenantId() };

    public async Task<AgentAlertsDto> GetAsync(CancellationToken ct = default)
    {
        RequireAdmin();
        var w = await SettingsAsync(ct);
        return new AgentAlertsDto(Dto(w), await EvaluateAsync(w, ct), clock.Now, w.AlertsCheckedAt);
    }

    public async Task<AgentAlertsDto> SaveAsync(AgentAlertSettingsDto req, CancellationToken ct = default)
    {
        RequireAdmin();
        if (req.MinSuccessRate is < 10 or > 100) throw new ValidationException("minSuccessRate", "Choose a success rate from 10% to 100%.");
        if (req.MaxP95Seconds is < 3 or > 300) throw new ValidationException("maxP95Seconds", "Choose from 3 to 300 seconds.");
        if (req.BotFailures is < 1 or > 50) throw new ValidationException("botFailures", "Choose from 1 to 50 missed sessions.");
        if (req.ReadingFailures is < 1 or > 50) throw new ValidationException("readingFailures", "Choose from 1 to 50 failed readings.");
        if (req.CreditDays is < 1 or > 31) throw new ValidationException("creditDays", "Choose from 1 to 31 days.");
        var w = await db.AgentWorkspaceSettings.FirstOrDefaultAsync(ct);
        if (w is null) { w = new AgentWorkspaceSettings { TenantId = ctx.RequireTenantId(), CreatedAt = clock.Now, CreatedBy = ctx.UserId }; db.AgentWorkspaceSettings.Add(w); }
        var before = Dto(w);
        w.AlertsEnabled = req.Enabled; w.AlertMinSuccessRate = req.MinSuccessRate; w.AlertMaxP95Seconds = req.MaxP95Seconds; w.AlertBotFailures = req.BotFailures;
        w.AlertReadingFailures = req.ReadingFailures; w.AlertCreditDays = req.CreditDays; w.WeeklyDigest = req.WeeklyDigest;
        w.UpdatedAt = clock.Now; w.UpdatedBy = ctx.UserId;
        recorder.Audit("agent.alerts_saved", "AgentWorkspaceSettings", w.Id, before, Dto(w));
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    /// <summary>What needs attention now, most serious first.</summary>
    public async Task<IReadOnlyList<AgentAlertDto>> EvaluateAsync(AgentWorkspaceSettings w, CancellationToken ct)
    {
        var now = clock.Now;
        var day = now.AddHours(-24);
        var alerts = new List<AgentAlertDto>();

        // The assistant: success and speed over the last day, once there are enough answers to mean something.
        var traces = await db.AiMessages.AsNoTracking().Where(m => m.Role == "assistant" && m.ExecutionJson != null && m.CreatedAt >= day)
            .OrderByDescending(m => m.CreatedAt).Select(m => m.ExecutionJson!).Take(3000).ToListAsync(ct);
        var runs = traces.Select(j => { try { return JsonSerializer.Deserialize<AiExecutionTrace>(j, Json); } catch (JsonException) { return null; } })
            .Where(t => t is not null && t.Outcome is not ("awaiting_confirmation" or "executing")).Select(t => t!).ToList();
        if (runs.Count >= MinAnswers)
        {
            var ok = runs.Count(r => r.Outcome == "succeeded");
            var rate = (int)Math.Round(ok * 100.0 / runs.Count);
            if (rate < w.AlertMinSuccessRate)
            {
                var top = runs.Where(r => r.Outcome != "succeeded").GroupBy(r => r.ErrorCode ?? r.Outcome).OrderByDescending(g => g.Count()).First().Key;
                alerts.Add(new AgentAlertDto("assistant_success", rate < w.AlertMinSuccessRate - 20 ? "critical" : "warning", "assistant",
                    $"Only {rate}% of the assistant's answers succeeded today",
                    $"{runs.Count - ok} of {runs.Count} answers in the last 24 hours did not succeed; most often: {top.Replace('_', ' ').ToLowerInvariant()}. Your alert is below {w.AlertMinSuccessRate}%.",
                    "/agent-tracker?tab=runs", rate, w.AlertMinSuccessRate));
            }
            var times = runs.Select(r => r.DurationMs).Order().ToList();
            var p95 = times[Math.Max(0, (int)Math.Ceiling(times.Count * .95) - 1)] / 1000.0;
            if (p95 > w.AlertMaxP95Seconds)
                alerts.Add(new AgentAlertDto("assistant_slow", "warning", "assistant", $"The assistant's slowest answers take {Math.Round(p95)}s",
                    $"1 in 20 answers took longer than {Math.Round(p95)} seconds in the last 24 hours (your alert: {w.AlertMaxP95Seconds}s). See where the time goes.",
                    "/agent-tracker?tab=assistant", Math.Round(p95, 1), w.AlertMaxP95Seconds));
        }

        // The meeting bot: sessions it could not attend today, and sessions starting now that no worker has picked up.
        var failedBots = await db.AgentMeetingBots.AsNoTracking().Where(b => b.Kind == "bot" && b.Status == "failed" && b.SessionStartUtc >= day && b.SessionStartUtc <= now)
            .Select(b => b.Error).ToListAsync(ct);
        if (failedBots.Count >= w.AlertBotFailures)
        {
            var reason = failedBots.Where(e => !string.IsNullOrWhiteSpace(e)).GroupBy(e => e!).OrderByDescending(g => g.Count()).Select(g => g.Key).FirstOrDefault();
            alerts.Add(new AgentAlertDto("bot_failures", "warning", "meetings", $"The meeting bot missed {failedBots.Count} session{(failedBots.Count == 1 ? "" : "s")} today",
                (reason is null ? "" : $"Most often: {Text.Truncate(reason, 160)} ") + $"Your alert is {w.AlertBotFailures} or more a day.", "/agent-tracker?tab=meetings",
                failedBots.Count, w.AlertBotFailures));
        }
        if (bots.Configured)
        {
            var waiting = await db.AgentMeetingBots.AsNoTracking().CountAsync(b => b.Kind == "bot" && b.Status == "scheduled" && b.WorkerId == null
                && b.SessionStartUtc <= now.AddMinutes(1) && b.SessionEndUtc > now, ct);
            if (waiting > 0)
            {
                var freeWorker = await db.AgentBotWorkers.AsNoTracking().AnyAsync(x => x.LastSeenAt >= now.AddMinutes(-2) && !x.Draining && x.Active < x.Capacity, ct);
                if (!freeWorker)
                    alerts.Add(new AgentAlertDto("bot_capacity", "critical", "meetings", $"No meeting bot is free for {waiting} meeting{(waiting == 1 ? "" : "s")} starting now",
                        "Every bot worker is busy or offline, so these sessions wait in line and may be missed. Add bot workers (System health › Meeting bots) or check that they are running.",
                        "/agent-tracker?tab=meetings", waiting, 0));
            }
        }

        // The project agent: failed readings today, and projects stopped at their monthly credit cap.
        var failedRuns = await db.AgentRuns.AsNoTracking().Where(r => r.Status == "failed" && r.StartedAt >= day).Select(r => new { r.ProjectId, r.Error }).ToListAsync(ct);
        if (failedRuns.Count >= w.AlertReadingFailures)
        {
            var projectIds = failedRuns.Select(r => r.ProjectId).Distinct().ToList();
            var keys = await db.Projects.AsNoTracking().Where(p => projectIds.Contains(p.Id)).Select(p => p.Key).Take(4).ToListAsync(ct);
            alerts.Add(new AgentAlertDto("reading_failures", "warning", "agent", $"The project agent failed {failedRuns.Count} readings today",
                $"In {string.Join(", ", keys)}{(projectIds.Count > keys.Count ? $" and {projectIds.Count - keys.Count} more" : "")}. " +
                (failedRuns.FirstOrDefault(r => r.Error != null)?.Error is { } e ? $"Last error: {Text.Truncate(e, 160)}" : "It tries again by itself every half hour."),
                "/agent-tracker?tab=agent", failedRuns.Count, w.AlertReadingFailures));
        }
        var month = AgentCredits.MonthStart(now);
        var capped = await db.ProjectAgentSettings.AsNoTracking().Where(s => s.Enabled && s.MonthlyCreditCap > 0
                && db.AgentRuns.Where(r => r.ProjectId == s.ProjectId && r.StartedAt >= month).Sum(r => (int?)r.Credits) >= s.MonthlyCreditCap)
            .Select(s => s.ProjectId).ToListAsync(ct);
        if (capped.Count > 0)
        {
            var keys = await db.Projects.AsNoTracking().Where(p => capped.Contains(p.Id)).Select(p => p.Key).Take(5).ToListAsync(ct);
            alerts.Add(new AgentAlertDto("project_caps", "info", "agent", $"{capped.Count} project agent{(capped.Count == 1 ? " has" : "s have")} used this month's credit cap",
                $"{string.Join(", ", keys)} stopped reading until the 1st. Raise the cap in the project's agent settings if the work needs it.", "/agent-tracker?tab=costs",
                capped.Count, null));
        }

        // AI credits: run out, or about to at the last week's pace before they renew.
        var balance = await credits.BalanceAsync(ct);
        if (!balance.Unlimited && balance.Limit > 0)
        {
            var weekAgo = now.AddDays(-7);
            var spentWeek = await db.AiCreditReservations.AsNoTracking().Where(r => r.Status == "settled" && r.SettledAt >= weekAgo).SumAsync(r => (long?)r.Charged, ct) ?? 0;
            var forecast = AgentCostService.Forecast(balance, spentWeek, now);
            if (balance.Available <= 0)
                alerts.Add(new AgentAlertDto("credits_out", "critical", "credits", "The workspace's AI credits are used up",
                    $"All {balance.Limit:N0} credits for {balance.Month} are used: the agents stop reading and answering until {forecast.ResetsOn:d MMM}. Add seats or change plan in Settings › Billing.",
                    "/agent-tracker?tab=costs", 0, balance.Limit));
            else if (forecast is { RunsOutBeforeReset: true, DaysLeft: { } left } && left <= w.AlertCreditDays)
                alerts.Add(new AgentAlertDto("credits_low", left <= 2 ? "critical" : "warning", "credits", $"AI credits run out in about {Math.Max(left, 1)} day{(left == 1 ? "" : "s")}",
                    $"{balance.Available:N0} of {balance.Limit:N0} left; the last week used about {forecast.DailyAverage:N0} a day, so they run out around {forecast.RunsOutOn:d MMM}, before they renew on {forecast.ResetsOn:d MMM}.",
                    "/agent-tracker?tab=costs", left, w.AlertCreditDays));
        }
        int Rank(string s) => s switch { "critical" => 0, "warning" => 1, _ => 2 };
        return alerts.OrderBy(a => Rank(a.Severity)).ToList();
    }

    /// <summary>
    /// Background (as an owner of the workspace, at most every 15 minutes, one server at a time): checks the rules and tells the owners and
    /// admins about each problem once a day. Returns how many notices were queued.
    /// </summary>
    public async Task<int> NotifyAsync(CancellationToken ct)
    {
        var now = clock.Now;
        var tid = ctx.RequireTenantId();
        var w = await db.AgentWorkspaceSettings.FirstOrDefaultAsync(ct);
        if (w is null)
        {
            w = new AgentWorkspaceSettings { TenantId = tid, CreatedAt = now };
            db.AgentWorkspaceSettings.Add(w);
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException) { return 0; }   // another server made it at the same moment: it checks this time
        }
        if (!w.AlertsEnabled) return 0;
        var last = w.AlertsCheckedAt;
        if (last is { } at && now - at < TimeSpan.FromMinutes(15)) return 0;
        var id = w.Id;
        var claimed = await db.AgentWorkspaceSettings.Where(x => x.Id == id && x.AlertsCheckedAt == last)
            .ExecuteUpdateAsync(u => u.SetProperty(x => x.AlertsCheckedAt, now), ct) == 1;
        if (!claimed) return 0;

        var alerts = (await EvaluateAsync(w, ct)).Where(a => a.Severity != "info" || a.Key == "project_caps").ToList();
        if (alerts.Count == 0) return 0;
        var zone = await db.Tenants.AsNoTracking().Where(t => t.Id == tid).Select(t => t.TimeZone).FirstOrDefaultAsync(ct);
        var today = clock.TodayIn(zone);
        var people = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && (m.Role == TenantRole.Owner || m.Role == TenantRole.Admin)
            && m.User!.IsActive && !m.User.IsPlatformAdmin).Select(m => m.UserId).ToListAsync(ct);
        var sent = 0;
        foreach (var a in alerts)
        {
            var key = $"agent-alert:{a.Key}:{today:yyyyMMdd}";
            foreach (var uid in people)
            {
                if (await db.Notifications.AnyAsync(n => n.UserId == uid && n.DedupeKey == key, ct)) continue;
                await notifications.AddAsync(uid, NotificationType.AgentAlert, a.Title, a.Detail, a.Link, key, toSelf: true, ct: ct);
                sent++;
            }
        }
        await db.SaveChangesAsync(ct);
        return sent;
    }
}

public record AgentDigestDto(string Title, IReadOnlyList<string> Lines, DateTime From, DateTime To, bool Quiet);

/// <summary>
/// The weekly agent summary: every Monday morning (each owner's and admin's own time zone and briefing time) a short notice of what the
/// agents did the week before - readings, proposals and how they were decided, meetings attended, commitments kept and missed, the
/// assistant's answers, the AI credits used and when they would run out, and any kind of work the agent has earned the right to do alone.
/// Built from the records alone (no model). Skipped when the agents did nothing that week.
/// </summary>
public class AgentDigestService(IAppDbContext db, ICurrentContext ctx, AppClock clock, AgentTrackerService tracker, AgentAutonomyHintService hints, AiCreditService credits,
    NotificationService notifications)
{
    public async Task<AgentDigestDto> BuildAsync(DateTime now, CancellationToken ct = default)
    {
        var to = now; var from = now.AddDays(-7);
        var fleet = await tracker.FleetAsync(from, to, ct);
        var lines = new List<string>();
        var a = fleet.ProjectAgent;
        if (a.Readings > 0 || a.Findings > 0)
            lines.Add($"Project agent: {a.Readings} reading{(a.Readings == 1 ? "" : "s")}, {a.Findings} proposal{(a.Findings == 1 ? "" : "s")} - {a.Approved} approved" +
                (a.AutoApplied > 0 ? $" ({a.AutoApplied} by itself)" : "") + $", {a.Dismissed} dismissed, {a.Pending} waiting." +
                (a.AverageDecisionHours is { } h ? $" Decided in {(h < 1 ? "under an hour" : $"{h:0.#} h")} on average." : ""));
        var m = fleet.Meetings;
        if (m.Sessions + m.MeetTranscripts > 0)
            lines.Add($"Meetings: {m.Attended} of {m.Sessions} attended by the bot" + (m.MeetTranscripts > 0 ? $", {m.MeetTranscripts} Meet transcript{(m.MeetTranscripts == 1 ? "" : "s")}" : "") +
                (m.MinutesSent > 0 ? $", {m.MinutesSent} set{(m.MinutesSent == 1 ? "" : "s")} of minutes sent" : "") + (m.Delegations > 0 ? $", {m.Delegations} in someone's place" : "") + ".");
        var f = fleet.FollowUps;
        if (f.Commitments > 0)
            lines.Add($"Commitments due: {f.Commitments} - {f.Kept} kept, {f.Missed} missed, {f.Moved} moved{(f.ChangeRequests > 0 ? $"; {f.ChangeRequests} asked for more time" : "")}.");
        var since = from;
        var answers = await db.AiMessages.AsNoTracking().Where(x => x.Role == "assistant" && x.ExecutionJson != null && x.CreatedAt >= since && x.CreatedAt <= to).CountAsync(ct);
        if (answers > 0) lines.Add($"Assistant: {answers} answer{(answers == 1 ? "" : "s")}.");
        var quiet = lines.Count == 0;
        var balance = await credits.BalanceAsync(ct);
        var used = await db.AiCreditReservations.AsNoTracking().Where(r => r.Status == "settled" && r.SettledAt >= since && r.SettledAt <= to).SumAsync(r => (long?)r.Charged, ct) ?? 0;
        if (used > 0)
        {
            var forecast = AgentCostService.Forecast(balance, used, now);
            lines.Add($"AI credits: {used:N0} used" + (balance.Unlimited ? "." : forecast.RunsOutBeforeReset && forecast.RunsOutOn is { } on
                ? $"; at this pace they run out around {on:d MMM}, before they renew on {forecast.ResetsOn:d MMM}." : $"; {balance.Available:N0} left this month."));
        }
        foreach (var hint in (await hints.WorkspaceAsync(ct)).Take(2))
            lines.Add($"Ready for more: in {hint.ProjectKey} the team approved {hint.Rate}% of {AgentAutonomyHintService.KindLabel(Enum.Parse<AgentFindingKind>(hint.Kind))} unchanged - let the agent create them by itself?");
        var title = quiet ? "Agents last week: nothing to report"
            : $"Agents last week: {a.Findings} proposal{(a.Findings == 1 ? "" : "s")}, {a.Approved} approved, {m.Attended} meeting{(m.Attended == 1 ? "" : "s")}";
        return new AgentDigestDto(title, lines, from, to, quiet);
    }

    /// <summary>
    /// Background (as an owner): on Monday morning, between each person's briefing time and three hours after it, once per person per week.
    /// <paramref name="force"/> sends it now to the current person only (the "send me a sample" button). Returns how many were queued.
    /// </summary>
    public async Task<int> SendDueAsync(CancellationToken ct, bool force = false)
    {
        var tid = ctx.RequireTenantId();
        var now = clock.Now;
        var w = await db.AgentWorkspaceSettings.AsNoTracking().FirstOrDefaultAsync(ct);
        if (!force && w is { WeeklyDigest: false }) return 0;
        var people = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && (m.Role == TenantRole.Owner || m.Role == TenantRole.Admin)
                && m.User!.IsActive && !m.User.IsPlatformAdmin && (!force || m.UserId == ctx.UserId))
            .Select(m => new { m.UserId, m.User!.TimeZone }).ToListAsync(ct);
        if (people.Count == 0) return 0;
        var zone = await db.Tenants.AsNoTracking().Where(t => t.Id == tid).Select(t => t.TimeZone).FirstOrDefaultAsync(ct);
        var ids = people.Select(p => p.UserId).ToList();
        var prefs = await db.ReminderSettings.AsNoTracking().Where(s => ids.Contains(s.UserId)).ToDictionaryAsync(s => s.UserId, ct);
        AgentDigestDto? digest = null;
        var sent = 0;
        foreach (var p in people)
        {
            var local = ZoneTime.ToLocal(now, ZoneTime.Find(ZoneTime.IsKnown(p.TimeZone) ? p.TimeZone : zone));
            var day = DateOnly.FromDateTime(local);
            var key = $"agent-digest:{tid:N}:{p.UserId:N}:{day:yyyyMMdd}";
            if (!force)
            {
                if (local.DayOfWeek != DayOfWeek.Monday) continue;
                var at = TimeOnly.FromDateTime(local);
                var start = prefs.GetValueOrDefault(p.UserId)?.BriefingTime ?? new ReminderSettings().BriefingTime;
                if (at < start || at > start.AddHours(3)) continue;
                if (await db.Notifications.AnyAsync(n => n.UserId == p.UserId && n.DedupeKey == key, ct)) continue;
            }
            digest ??= await BuildAsync(now, ct);
            if (digest.Quiet && !force) return sent;
            await notifications.AddAsync(p.UserId, NotificationType.AgentDigest, digest.Title, Text.Truncate(string.Join("\n", digest.Lines), 500),
                "/agent-tracker", force ? null : key, toSelf: true, ct: ct);
            sent++;
        }
        await db.SaveChangesAsync(ct);
        return sent;
    }
}
