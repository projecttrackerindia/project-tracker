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

public record WeeklyReportDto(Guid ProjectId, string ProjectName, DateOnly From, DateOnly To, string Health, string Text, int Moved, int Slipped, int Risks, int Next, bool CanSend);
public record SendWeeklyReportRequest(string? Text);

/// <summary>
/// The weekly status report of a project, written from its data (no AI needed, so it is always right): what moved (finished in the last
/// seven days), what slipped and why (date changes with their reasons), risks (blocked and overdue work, a status set by hand), and next
/// week (open work due in the next seven days). The project manager reads it, edits it, and sends it to the project chat.
/// </summary>
public class WeeklyReportService(IAppDbContext db, AppClock clock, ProjectStatusService status, ChatService chat, Recorder recorder)
{
    private static string D(DateOnly? d) => d is { } x ? x.ToString("d MMM", CultureInfo.InvariantCulture) : "no date";

    public async Task<WeeklyReportDto> DraftAsync(Guid projectId, CancellationToken ct = default)
    {
        var report = await status.ReportAsync(projectId, ct);   // access-checked: only people who may open the project
        var p = report.Project;
        var today = clock.Today; var from = today.AddDays(-6); var next = today.AddDays(7);
        var since = from.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
        var done = await db.Tasks.AsNoTracking().Where(t => t.ProjectId == projectId && t.CompletedAt != null && t.CompletedAt >= since)
            .OrderByDescending(t => t.CompletedAt).Select(t => new { t.Number, t.Title }).Take(25).ToListAsync(ct);
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
        return new WeeklyReportDto(projectId, p.Name, from, today, health, sb.ToString().TrimEnd(), done.Count, slipped.Count, risks, coming.Count, canSend);
    }

    /// <summary>Posts the (edited) report in the project chat, where the team and anyone following the project sees it.</summary>
    public async Task SendAsync(Guid projectId, SendWeeklyReportRequest req, CancellationToken ct = default)
    {
        await status.ReportAsync(projectId, ct);   // access check
        var text = (req.Text ?? "").Trim();
        if (text.Length == 0) throw new ValidationException("text", "The report is empty.");
        if (text.Length > 8000) throw new ValidationException("text", "Keep the report under 8,000 characters.");
        var conv = await db.Conversations.AsNoTracking().Where(c => c.ProjectId == projectId && c.Type == ConversationType.Project).Select(c => (Guid?)c.Id).FirstOrDefaultAsync(ct)
            ?? throw new ConflictException("This project has no chat yet. Open its chat once, then send the report.", "NO_PROJECT_CHAT");
        await chat.SendAsync(conv, new SendMessageRequest(text, null), ct);
        recorder.Audit("project.weekly_report_sent", "Project", projectId, null, new { length = text.Length });
    }
}
