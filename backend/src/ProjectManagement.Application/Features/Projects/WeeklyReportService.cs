using System.Globalization;
using System.Text;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Chat;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Projects;

/// <summary>One line of a report section with where it came from, so a reader can open the task, commit or meeting behind it.</summary>
public record WeeklyItemDto(string Text, string? Owner, string? Source, string? Link, bool External = false);
public record WeeklySourcesDto(int Updates, int Meetings, int Commits);
/// <summary>A report sent earlier (read back from the audit trail): when, by whom, the health it showed and where it went.</summary>
public record WeeklySentDto(DateTime SentAt, string? By, string? Health, int Done, int Slipped, IReadOnlyList<string> Channels);
public record WeeklyScheduleDto(Guid ReminderId, DateTime? NextAt, string TimeZone);
public record WeeklyReportDto(Guid ProjectId, string ProjectName, DateOnly From, DateOnly To, string Health, string Text, int Moved, int Slipped, int Risks, int Next, bool CanSend,
    string? ProjectKey = null, int Week = 0, string Verdict = "", WeeklySourcesDto? Sources = null, int ScopeChange = 0, int Progress = 0, int? ForecastDays = null, DateOnly? ForecastDate = null,
    IReadOnlyList<WeeklyItemDto>? MovedItems = null, IReadOnlyList<WeeklyItemDto>? SlippedItems = null, IReadOnlyList<WeeklyItemDto>? RiskItems = null, IReadOnlyList<WeeklyItemDto>? NextItems = null,
    IReadOnlyList<UserRefDto>? People = null, IReadOnlyList<WeeklySentDto>? History = null, WeeklyScheduleDto? Schedule = null, DateTime? WrittenAt = null);
/// <param name="Chat">Post in the project chat (the default when nothing is chosen, as before).</param>
/// <param name="Mail">E-mail it to <paramref name="Recipients"/> (people on the project).</param>
public record SendWeeklyReportRequest(string? Text, bool? Chat = null, bool? Mail = null, IReadOnlyList<Guid>? Recipients = null, bool? Pdf = null);
public record ScheduleWeeklyReportRequest(string? TimeZone);

/// <summary>
/// The weekly status report of a project, written from its data (no AI needed, so it is always right): what moved (finished in the last
/// seven days), what slipped and why (date changes with their reasons), risks (blocked and overdue work, a status set by hand), and next
/// week (open work due in the next seven days). The project manager reads it, edits it, and sends it to the project chat.
/// </summary>
public class WeeklyReportService(IAppDbContext db, AppClock clock, ProjectStatusService status, ChatService chat, Recorder recorder, ICurrentContext ctx,
    IEmailSender email, ProjectManagement.Application.Features.Reminders.ReminderService reminders)
{
    public const string SentAction = "project.weekly_report_sent";
    public static string PageLink(Guid projectId) => $"/work/projects/{projectId}/report";
    private static string TaskLink(Guid projectId, Guid taskId) => $"/projects/{projectId}?task={taskId}";
    private static string D(DateOnly? d) => d is { } x ? x.ToString("d MMM", CultureInfo.InvariantCulture) : "no date";

    public async Task<WeeklyReportDto> DraftAsync(Guid projectId, CancellationToken ct = default)
    {
        var report = await status.ReportAsync(projectId, ct);   // access-checked: only people who may open the project
        var p = report.Project;
        var today = clock.Today; var from = today.AddDays(-6); var next = today.AddDays(7);
        var since = from.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
        var done = await db.Tasks.AsNoTracking().Where(t => t.ProjectId == projectId && t.CompletedAt != null && t.CompletedAt >= since)
            .OrderByDescending(t => t.CompletedAt).Select(t => new { t.Id, t.Number, t.Title, t.AssigneeId }).Take(25).ToListAsync(ct);
        var hand = await db.Projects.AsNoTracking().Where(x => x.Id == projectId).Select(x => new { x.HealthOverride, x.HealthNote, x.HealthUntil }).FirstAsync(ct);
        var slipped = report.Changes.Where(c => DateOnly.FromDateTime(c.ChangedAt) >= from).Take(10).ToList();
        var open = report.Tasks.Where(t => t.StatusCategory is not (StatusCategory.Done or StatusCategory.Cancelled)).ToList();
        var blocked = open.Where(t => t.BlockedBy.Count > 0).Take(5).ToList();
        var overdue = open.Where(t => t.OverdueDays > 0).OrderByDescending(t => t.OverdueDays).Take(5).ToList();
        var coming = open.Where(t => t.DueDate is { } d && d >= today && d <= next).OrderBy(t => t.DueDate).Take(10).ToList();
        var health = p.Health.ToString() switch { "OnTrack" => "On track", "AtRisk" => "At risk", "Delayed" => "Late", var h => h };

        var sb = new StringBuilder();
        sb.AppendLine($"**{p.Name} — week of {D(from)} to {D(today)}**");
        sb.AppendLine($"Status: **{health}** · {p.Progress}% done · due {D(p.DueDate)}{(p.OriginalDueDate is { } o && p.DueDate is { } dd && o != dd ? $" (was {D(o)})" : "")}");
        if (hand.HealthOverride is not null && (hand.HealthUntil is not { } u || today <= u) && hand.HealthNote is { } why) sb.AppendLine($"Set by hand: {why}");
        sb.AppendLine();
        sb.AppendLine("**What moved**");
        if (done.Count == 0) sb.AppendLine("- Nothing was finished this week.");
        foreach (var t in done.Take(8)) sb.AppendLine($"- {p.Key}-{t.Number} {t.Title}");
        if (done.Count > 8) sb.AppendLine($"- and {done.Count - 8} more");
        sb.AppendLine();
        sb.AppendLine("**What slipped, and why**");
        if (slipped.Count == 0) sb.AppendLine("- No dates moved.");
        foreach (var c in slipped) sb.AppendLine($"- {(c.TaskKey ?? "Project")}: {D(c.Previous)} → {D(c.Revised)}{(c.Reason is { Length: > 0 } r ? $" — {r}" : "")}{(c.Dependency is { Length: > 0 } dep ? $" (waits on {dep})" : "")}");
        sb.AppendLine();
        sb.AppendLine("**Risks**");
        var risks = 0;
        foreach (var t in blocked) { risks++; sb.AppendLine($"- {t.Key} {t.Title} is waiting on {string.Join(", ", t.BlockedBy.Select(b => b.Key))}"); }
        foreach (var t in overdue.Where(t => !blocked.Contains(t))) { risks++; sb.AppendLine($"- {t.Key} {t.Title} is {t.OverdueDays} day{(t.OverdueDays == 1 ? "" : "s")} overdue{(t.Assignee is { } a ? $" ({a.Name})" : " (unassigned)")}"); }
        if (risks == 0) sb.AppendLine("- None that the plan shows.");
        sb.AppendLine();
        sb.AppendLine("**Next week**");
        if (coming.Count == 0) sb.AppendLine("- Nothing is due.");
        foreach (var t in coming) sb.AppendLine($"- {t.Key} {t.Title} · due {D(t.DueDate)}{(t.Assignee is { } a ? $" · {a.Name}" : "")}");
        var canSend = await db.Conversations.AsNoTracking().AnyAsync(c => c.ProjectId == projectId && c.Type == ConversationType.Project, ct);

        // ---- the structured view of the same facts, each line pointing at what it came from
        var until = today.AddDays(1).ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
        var updates = await db.Activities.AsNoTracking().CountAsync(a => a.ProjectId == projectId && a.CreatedAt >= since && a.CreatedAt < until, ct);
        var meetings = await db.ProjectMeetings.AsNoTracking().CountAsync(m => m.ProjectId == projectId && m.Status != MeetingStatus.Cancelled && m.StartTimeUtc >= since && m.StartTimeUtc < until, ct);
        var commitRows = await (from l in db.DevLinks.AsNoTracking()
                                join t in db.Tasks.AsNoTracking() on l.TaskId equals t.Id
                                where t.ProjectId == projectId && l.Kind == "commit" && l.OccurredAt >= since && l.OccurredAt < until
                                select new { l.TaskId, l.Title, l.Url, l.ExternalId }).ToListAsync(ct);
        var created = await db.Tasks.AsNoTracking().CountAsync(t => t.ProjectId == projectId && t.CreatedAt >= since, ct);
        var total = report.Tasks.Count;
        var scope = total - created > 0 ? (int)Math.Round(created * 100.0 / (total - created)) : (created > 0 ? 100 : 0);

        var assignees = done.Where(t => t.AssigneeId != null).Select(t => t.AssigneeId!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => assignees.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var commitByTask = commitRows.Where(c => c.TaskId != null).GroupBy(c => c.TaskId!.Value).ToDictionary(g => g.Key, g => g.First());
        var movedItems = done.Take(8).Select(t => commitByTask.TryGetValue(t.Id, out var c)
            ? new WeeklyItemDto($"{t.Title}", t.AssigneeId is { } a && names.TryGetValue(a, out var n) ? n : null, c.ExternalId.Length > 8 ? c.ExternalId[..7] : (c.ExternalId.Length > 0 ? c.ExternalId : "Commit"), c.Url, true)
            : new WeeklyItemDto(t.Title, t.AssigneeId is { } a2 && names.TryGetValue(a2, out var n2) ? n2 : null, $"{p.Key}-{t.Number}", TaskLink(projectId, t.Id))).ToList();
        var slippedItems = slipped.Select(c => new WeeklyItemDto(
            $"{(c.TaskKey is null ? "Delivery date" : c.Title)} moved {(c.DaysShifted is { } ds ? $"{Math.Abs(ds)} day{(Math.Abs(ds) == 1 ? "" : "s")}" : $"{D(c.Previous)} → {D(c.Revised)}")}{(c.Reason is { Length: > 0 } r ? $" — {r}" : "")}{(c.Dependency is { Length: > 0 } dep ? $" (waits on {dep})" : "")}",
            c.ChangedBy?.Name, c.TaskKey ?? "Timeline", c.TaskId is { } tid ? TaskLink(projectId, tid) : $"/work/projects/{projectId}?tab=overview")).ToList();
        var riskItems = blocked.Select(t => new WeeklyItemDto($"{t.Title} is waiting on {string.Join(", ", t.BlockedBy.Select(b => b.Key))}", t.Assignee?.Name, t.Key, TaskLink(projectId, t.Id)))
            .Concat(overdue.Where(t => !blocked.Contains(t)).Select(t => new WeeklyItemDto($"{t.Title} is {t.OverdueDays} day{(t.OverdueDays == 1 ? "" : "s")} overdue", t.Assignee?.Name, t.Key, TaskLink(projectId, t.Id)))).ToList();
        if (hand.HealthOverride is not null && (hand.HealthUntil is not { } hu || today <= hu) && hand.HealthNote is { Length: > 0 } hn)
            riskItems.Insert(0, new WeeklyItemDto(hn, p.Owner?.Name, "Status", $"/work/projects/{projectId}?tab=overview"));
        var nextItems = coming.Select(t => new WeeklyItemDto($"{t.Title} · due {D(t.DueDate)}", t.Assignee?.Name, t.Key, TaskLink(projectId, t.Id))).ToList();

        var verdict = hand.HealthOverride is not null && hand.HealthNote is { Length: > 0 } note ? note
            : health switch
            {
                "On track" => $"On track for {D(p.DueDate)}{(done.Count > 0 ? $" — {done.Count} item{(done.Count == 1 ? "" : "s")} finished this week" : "")}.",
                "At risk" => $"{D(p.DueDate)} is still possible if {(blocked.Count > 0 ? $"{blocked.Count} blocked item{(blocked.Count == 1 ? "" : "s")} move" : "overdue work catches up")} this week.",
                "Late" => $"Running {p.DelayedDays} day{(p.DelayedDays == 1 ? "" : "s")} behind the plan; now due {D(p.DueDate)}.",
                _ => $"{p.Progress}% done, due {D(p.DueDate)}.",
            };
        var people = await (from m in db.ProjectMembers.AsNoTracking()
                            join u in db.Users.AsNoTracking() on m.UserId equals u.Id
                            where m.ProjectId == projectId
                            orderby u.DisplayName
                            select new UserRefDto(u.Id, u.DisplayName)).Take(100).ToListAsync(ct);
        if (p.Owner is { } owner && people.All(x => x.Id != owner.Id)) people.Insert(0, owner);
        var week = System.Globalization.ISOWeek.GetWeekOfYear(today.ToDateTime(TimeOnly.MinValue));

        return new WeeklyReportDto(projectId, p.Name, from, today, health, sb.ToString().TrimEnd(), done.Count, slipped.Count, risks, coming.Count, canSend,
            p.Key, week, verdict, new WeeklySourcesDto(updates, meetings, commitRows.Count), scope, p.Progress, p.DueDate is null ? null : p.DelayedDays, p.DueDate,
            movedItems, slippedItems, riskItems, nextItems, people, await HistoryAsync(projectId, ct), await ScheduleOfAsync(projectId, ct), clock.Now);
    }

    /// <summary>The last four reports sent for this project, read from the audit trail (no table of their own).</summary>
    private async Task<IReadOnlyList<WeeklySentDto>> HistoryAsync(Guid projectId, CancellationToken ct)
    {
        var tid = ctx.RequireTenantId();
        var rows = await db.AuditLogs.AsNoTracking().Where(a => a.TenantId == tid && a.Action == SentAction && a.EntityId == projectId)
            .OrderByDescending(a => a.CreatedAt).Take(4).Select(a => new { a.CreatedAt, a.NewValue, By = a.User != null ? a.User.DisplayName : null }).ToListAsync(ct);
        return rows.Select(r =>
        {
            string? h = null; int d = 0, s = 0; var ch = new List<string>();
            try
            {
                if (r.NewValue is { Length: > 0 } json)
                {
                    using var doc = System.Text.Json.JsonDocument.Parse(json);
                    var root = doc.RootElement;
                    if (root.TryGetProperty("health", out var hv) && hv.ValueKind == System.Text.Json.JsonValueKind.String) h = hv.GetString();
                    if (root.TryGetProperty("done", out var dv) && dv.ValueKind == System.Text.Json.JsonValueKind.Number) d = dv.GetInt32();
                    if (root.TryGetProperty("slipped", out var sv) && sv.ValueKind == System.Text.Json.JsonValueKind.Number) s = sv.GetInt32();
                    if (root.TryGetProperty("channels", out var cv) && cv.ValueKind == System.Text.Json.JsonValueKind.Array)
                        foreach (var c in cv.EnumerateArray()) if (c.GetString() is { } x) ch.Add(x);
                }
            }
            catch (System.Text.Json.JsonException) { }
            if (ch.Count == 0) ch.Add("chat");
            return new WeeklySentDto(r.CreatedAt, r.By, h, d, s, ch);
        }).ToList();
    }

    /// <summary>My Friday reminder to approve this project's report, if I set one.</summary>
    private async Task<WeeklyScheduleDto?> ScheduleOfAsync(Guid projectId, CancellationToken ct)
    {
        var uid = ctx.RequireUserId();
        var link = PageLink(projectId);
        return await db.Reminders.AsNoTracking()
            .Where(r => r.UserId == uid && r.Link == link && r.Recurrence != null && (r.State == ReminderState.Scheduled || r.State == ReminderState.Fired))
            .OrderByDescending(r => r.CreatedAt).Select(r => new WeeklyScheduleDto(r.Id, r.NextFireAt, r.TimeZone)).FirstOrDefaultAsync(ct);
    }

    /// <summary>
    /// "Every Friday 5 PM · you approve first": a repeating reminder for me (the existing reminders feature, no table of its own) that opens
    /// this project's report page, where I read it and press Approve &amp; send.
    /// </summary>
    public async Task<WeeklyScheduleDto> ScheduleAsync(Guid projectId, ScheduleWeeklyReportRequest req, CancellationToken ct = default)
    {
        var report = await status.ReportAsync(projectId, ct);   // access check
        if (await ScheduleOfAsync(projectId, ct) is { } existing) return existing;
        var today = clock.Today;
        var friday = today.AddDays(((int)DayOfWeek.Friday - (int)today.DayOfWeek + 7) % 7);
        var at = friday.ToDateTime(new TimeOnly(17, 0)).ToString("yyyy-MM-ddTHH:mm", CultureInfo.InvariantCulture);
        var dto = await reminders.CreateAsync(new ProjectManagement.Application.Features.Reminders.SaveReminderRequest(
            $"Approve the weekly report · {report.Project.Name}", "Read this week's report, then Approve & send.", ReminderTarget.None, null, null,
            new ProjectManagement.Application.Features.Reminders.ReminderWhen(at, req.TimeZone, null, null, "FREQ=WEEKLY;BYDAY=FR"), false, true), ct);
        var row = await db.Reminders.FirstAsync(r => r.Id == dto.Id, ct);
        row.Link = PageLink(projectId); row.TargetProjectId = projectId; row.TargetKey = report.Project.Key; row.TargetTitle = ProjectManagement.Application.Common.Text.Truncate(report.Project.Name, 200);
        recorder.Audit("project.weekly_report_scheduled", "Project", projectId, null, new { reminder = row.Id });
        await db.SaveChangesAsync(ct);
        return new WeeklyScheduleDto(row.Id, row.NextFireAt, row.TimeZone);
    }

    /// <summary>Stops the Friday reminder (the reminder is cancelled, as dismissing it would).</summary>
    public async Task UnscheduleAsync(Guid projectId, CancellationToken ct = default)
    {
        await status.ReportAsync(projectId, ct);
        var uid = ctx.RequireUserId();
        var link = PageLink(projectId);
        var rows = await db.Reminders.Where(r => r.UserId == uid && r.Link == link && r.Recurrence != null && (r.State == ReminderState.Scheduled || r.State == ReminderState.Fired)).ToListAsync(ct);
        foreach (var r in rows) { r.State = ReminderState.Cancelled; r.NextFireAt = null; }
        if (rows.Count > 0) recorder.Audit("project.weekly_report_unscheduled", "Project", projectId);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Sends the (edited) report: posted in the project chat and/or e-mailed to the chosen people on the project. Every send is written to
    /// the audit trail, which is where the "last 4 weeks" strip reads from.
    /// </summary>
    public async Task SendAsync(Guid projectId, SendWeeklyReportRequest req, CancellationToken ct = default)
    {
        var report = await status.ReportAsync(projectId, ct);   // access check
        var text = (req.Text ?? "").Trim();
        if (text.Length == 0) throw new ValidationException("text", "The report is empty.");
        if (text.Length > 8000) throw new ValidationException("text", "Keep the report under 8,000 characters.");
        var toChat = req.Chat ?? req.Mail != true;
        var toMail = req.Mail == true;
        if (!toChat && !toMail) throw new ValidationException("channels", "Choose Messages or Mail.");
        var mailTo = new List<(Guid Id, string Email, string Name)>();
        if (toMail)
        {
            var ids = (req.Recipients ?? []).Distinct().Take(100).ToList();
            if (ids.Count == 0) throw new ValidationException("recipients", "Choose who gets the e-mail.");
            var members = await db.ProjectMembers.AsNoTracking().Where(m => m.ProjectId == projectId && ids.Contains(m.UserId)).Select(m => m.UserId).ToListAsync(ct);
            if (report.Project.Owner is { } o && ids.Contains(o.Id)) members.Add(o.Id);
            var users = await db.Users.AsNoTracking().Where(u => members.Contains(u.Id)).Select(u => new { u.Id, u.Email, u.DisplayName }).ToListAsync(ct);
            if (users.Count != ids.Count) throw new ValidationException("recipients", "Reports can only be e-mailed to people on the project.");
            mailTo.AddRange(users.Select(u => (u.Id, u.Email, u.DisplayName)));
        }
        if (toChat)
        {
            var conv = await db.Conversations.AsNoTracking().Where(c => c.ProjectId == projectId && c.Type == ConversationType.Project).Select(c => (Guid?)c.Id).FirstOrDefaultAsync(ct)
                ?? throw new ConflictException("This project has no chat yet. Open its chat once, then send the report.", "NO_PROJECT_CHAT");
            await chat.SendAsync(conv, new SendMessageRequest(text, null), ct);
        }
        if (mailTo.Count > 0)
        {
            var subject = $"{report.Project.Name} — weekly status, {D(clock.Today.AddDays(-6))} to {D(clock.Today)}";
            var html = Html(text);
            foreach (var r in mailTo) await email.SendAsync(new EmailMessage(r.Email, subject, html, text, "weekly-report"), ct);
        }
        var channels = new List<string>();
        if (toChat) channels.Add("chat");
        if (toMail) channels.Add("mail");
        if (req.Pdf == true) channels.Add("pdf");
        var health = report.Project.Health.ToString() switch { "OnTrack" => "On track", "AtRisk" => "At risk", "Delayed" => "Late", var h => h };
        var since = clock.Today.AddDays(-6).ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
        var done = await db.Tasks.AsNoTracking().CountAsync(t => t.ProjectId == projectId && t.CompletedAt != null && t.CompletedAt >= since, ct);
        var slipped = report.Changes.Count(c => c.ChangedAt >= since);
        recorder.Audit(SentAction, "Project", projectId, null, new { length = text.Length, channels, recipients = mailTo.Count, health, done, slipped });
        await db.SaveChangesAsync(ct);
    }

    /// <summary>The report's light markdown (bold, "- " lists) as simple e-mail HTML, every piece of text encoded.</summary>
    public static string Html(string text)
    {
        static string Inline(string line)
        {
            var enc = System.Net.WebUtility.HtmlEncode(line);
            return System.Text.RegularExpressions.Regex.Replace(enc, @"\*\*(.+?)\*\*", "<b>$1</b>");
        }
        var sb = new StringBuilder("<div style=\"font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.55;color:#1d1d1f\">");
        var inList = false;
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.TrimEnd();
            if (line.StartsWith("- "))
            {
                if (!inList) { sb.Append("<ul style=\"padding-left:18px;margin:4px 0 10px\">"); inList = true; }
                sb.Append("<li>").Append(Inline(line[2..])).Append("</li>");
                continue;
            }
            if (inList) { sb.Append("</ul>"); inList = false; }
            if (line.Length > 0) sb.Append("<p style=\"margin:0 0 6px\">").Append(Inline(line)).Append("</p>");
        }
        if (inList) sb.Append("</ul>");
        return sb.Append("</div>").ToString();
    }
}
