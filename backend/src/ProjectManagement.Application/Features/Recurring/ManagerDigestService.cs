using System.Globalization;
using System.Net;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Recurring;

public record DigestLineDto(string Key, string Title, string? Detail, DateOnly? Date);
public record DigestProjectDto(Guid Id, string Key, string Name, int Progress, int Open, IReadOnlyList<DigestLineDto> Done, IReadOnlyList<DigestLineDto> Slipped,
    IReadOnlyList<DigestLineDto> Blocked, IReadOnlyList<DigestLineDto> Overdue, IReadOnlyList<DigestLineDto> NextWeek);
public record ManagerDigestDto(Guid UserId, string Name, string Email, string TimeZone, DateOnly WeekOf, string Subject, string Html, string Text,
    IReadOnlyList<DigestProjectDto> Projects);

/// <summary>
/// The weekly manager e-mail. Every Monday at 09:00 in the recipient's own time zone (their profile, else their workspace's, else the platform's),
/// each person who owns active projects gets one calm e-mail per workspace: each project's progress, what was done in the last seven days, dates
/// that slipped (with the reason given when the date was moved), what is blocked or overdue, and what is due in the coming week. It follows the
/// person's notification settings for "Weekly manager e-mail" (an unsubscribe link and one-click header switch the e-mail off), is sent at most
/// once per person, workspace and Monday, and is never sent late (after noon it waits for the next Monday).
/// </summary>
public class ManagerDigestService(IAppDbContext db, ICurrentContext ctx, AppClock clock, NotificationRouter router, IEmailSender sender, EmailLinks links,
    IOptions<AppOptions> app)
{
    public static readonly TimeOnly SendAt = new(9, 0);
    private const int PerList = 6;

    private static string Enc(string? s) => WebUtility.HtmlEncode(s ?? "");
    private static string Day(DateOnly d) => d.ToString("ddd d MMM", CultureInfo.InvariantCulture);

    /// <summary>Works out one person's digest in one workspace for the week that starts on <paramref name="today"/> (their local date).</summary>
    public async Task<ManagerDigestDto?> BuildAsync(Guid tenantId, Guid userId, DateOnly today, DateTime nowUtc, string zoneId, CancellationToken ct = default)
    {
        var user = await db.Users.IgnoreQueryFilters().AsNoTracking().FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null) return null;
        var closed = new[] { ProjectStatus.Completed, ProjectStatus.Cancelled, ProjectStatus.Archived };
        var projects = await db.Projects.IgnoreQueryFilters().AsNoTracking()
            .Where(p => p.TenantId == tenantId && p.OwnerId == userId && !p.IsDeleted && p.ArchivedAt == null && !closed.Contains(p.Status))
            .OrderBy(p => p.Name).Select(p => new { p.Id, p.Key, p.Name }).Take(25).ToListAsync(ct);
        if (projects.Count == 0) return null;
        var ids = projects.Select(p => p.Id).ToList();
        var since = nowUtc.AddDays(-7);
        var tasks = await db.Tasks.IgnoreQueryFilters().AsNoTracking()
            .Where(t => t.TenantId == tenantId && ids.Contains(t.ProjectId) && !t.IsDeleted)
            .Select(t => new { t.Id, t.ProjectId, t.Number, t.Title, t.DueDate, t.CompletedAt, t.ParentTaskId, Category = t.Status!.Category, Who = t.Assignee!.DisplayName })
            .ToListAsync(ct);
        var keys = projects.ToDictionary(p => p.Id, p => p.Key);
        string KeyOf(Guid projectId, int number) => $"{keys[projectId]}-{number}";
        bool Open(StatusCategory c) => c is not (StatusCategory.Done or StatusCategory.Cancelled);

        var openIds = tasks.Where(t => Open(t.Category)).Select(t => t.Id).ToList();
        var blocking = await db.TaskDependencies.IgnoreQueryFilters().AsNoTracking()
            .Where(d => d.TenantId == tenantId && openIds.Contains(d.TaskId) && d.Type == DependencyType.FinishToStart
                        && d.DependsOnTask!.Status!.Category != StatusCategory.Done && d.DependsOnTask.Status.Category != StatusCategory.Cancelled && !d.DependsOnTask.IsDeleted)
            .Select(d => new { d.TaskId, On = d.DependsOnTask!.Title }).ToListAsync(ct);
        var changes = await db.DueDateChanges.IgnoreQueryFilters().AsNoTracking()
            .Where(c => c.TenantId == tenantId && ids.Contains(c.ProjectId) && c.CreatedAt >= since)
            .OrderByDescending(c => c.CreatedAt).ToListAsync(ct);

        var list = new List<DigestProjectDto>();
        foreach (var p in projects)
        {
            var mine = tasks.Where(t => t.ProjectId == p.Id).ToList();
            var top = mine.Where(t => t.ParentTaskId == null && t.Category != StatusCategory.Cancelled).ToList();
            var progress = top.Count == 0 ? 0 : (int)Math.Round(100.0 * top.Count(t => t.Category == StatusCategory.Done) / top.Count);
            var done = mine.Where(t => t.CompletedAt >= since && t.Category == StatusCategory.Done).OrderByDescending(t => t.CompletedAt)
                .Select(t => new DigestLineDto(KeyOf(p.Id, t.Number), t.Title, t.Who, null)).ToList();
            var slipped = changes.Where(c => c.ProjectId == p.Id && c.Previous is { } was && (c.Revised is null || c.Revised > was))
                .GroupBy(c => c.TaskId).Select(g => g.First())
                .Select(c =>
                {
                    var t = c.TaskId is { } tid ? mine.FirstOrDefault(x => x.Id == tid) : null;
                    var moved = $"{(c.Previous is { } a ? Day(a) : "no date")} → {(c.Revised is { } b ? Day(b) : "no date")}";
                    var why = string.IsNullOrWhiteSpace(c.Reason) ? "no reason given" : c.Reason!.Trim();
                    if (!string.IsNullOrWhiteSpace(c.Dependency)) why += $" (waiting on {c.Dependency!.Trim()})";
                    return new DigestLineDto(t is null ? p.Key : KeyOf(p.Id, t.Number), t?.Title ?? "Project due date", $"{moved} · {why}", c.Revised);
                }).ToList();
            var blocked = mine.Where(t => Open(t.Category) && blocking.Any(b => b.TaskId == t.Id))
                .Select(t => new DigestLineDto(KeyOf(p.Id, t.Number), t.Title, "Waiting on " + string.Join(", ", blocking.Where(b => b.TaskId == t.Id).Select(b => b.On).Take(2)), t.DueDate)).ToList();
            var overdue = mine.Where(t => Open(t.Category) && t.DueDate is { } d && d < today).OrderBy(t => t.DueDate)
                .Select(t => new DigestLineDto(KeyOf(p.Id, t.Number), t.Title, $"{today.DayNumber - t.DueDate!.Value.DayNumber} days late" + (t.Who is null ? "" : $" · {t.Who}"), t.DueDate)).ToList();
            var next = mine.Where(t => Open(t.Category) && t.DueDate is { } d && d >= today && d <= today.AddDays(6)).OrderBy(t => t.DueDate)
                .Select(t => new DigestLineDto(KeyOf(p.Id, t.Number), t.Title, t.Who, t.DueDate)).ToList();
            list.Add(new DigestProjectDto(p.Id, p.Key, p.Name, progress, mine.Count(t => Open(t.Category)), done, slipped, blocked, overdue, next));
        }

        var doneCount = list.Sum(p => p.Done.Count);
        var attention = list.Sum(p => p.Overdue.Count + p.Blocked.Count);
        var subject = $"Your week ahead: {doneCount} done last week" + (attention > 0 ? $", {attention} need{(attention == 1 ? "s" : "")} a look" : ", nothing blocked");
        var web = app.Value.WebBaseUrl.TrimEnd('/');
        var token = links.Token(userId, NotificationType.ManagerDigest);
        var unsubscribe = links.PageUrl(token);
        var first = (user.DisplayName ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "there";
        var html = EmailTemplates.Rich("Your week ahead", $"Good morning {Enc(first)},", Html(list, web), "Open your projects", web + "/projects",
            $"Sent every Monday at 9:00 ({zoneId}) to owners of active projects.", $"{doneCount} done last week · {attention} blocked or overdue · {list.Sum(p => p.NextWeek.Count)} due this week",
            EmailKind.Update, unsubscribe);
        return new ManagerDigestDto(userId, user.DisplayName ?? "", user.Email, zoneId, today, subject, html, Plain(first, list, web, unsubscribe), list);
    }

    private static string Html(IReadOnlyList<DigestProjectDto> projects, string web)
    {
        var sb = new StringBuilder();
        string Section(string title, string tint, IReadOnlyList<DigestLineDto> lines, bool showDate)
        {
            if (lines.Count == 0) return "";
            var rows = string.Concat(lines.Take(PerList).Select(l =>
                $"<tr><td class=\"line\" style=\"padding:7px 0;border-top:1px solid #efeaf9;font-size:14px;line-height:20px\">" +
                $"<span class=\"tx3\" style=\"color:#8a82a6;font-size:12px;font-weight:600\">{Enc(l.Key)}</span>&nbsp; <span class=\"tx\" style=\"color:#221a3a\">{Enc(l.Title)}</span>" +
                (l.Detail is null && !(showDate && l.Date is not null) ? "" :
                    $"<div class=\"tx2\" style=\"color:#6a6288;font-size:12px;line-height:18px\">{Enc(string.Join(" · ", new[] { showDate && l.Date is { } d ? Day(d) : null, l.Detail }.Where(x => !string.IsNullOrEmpty(x))))}</div>") +
                "</td></tr>"));
            var more = lines.Count > PerList ? $"<tr><td class=\"tx3\" style=\"padding:6px 0;font-size:12px;color:#8a82a6\">and {lines.Count - PerList} more</td></tr>" : "";
            return $"<tr><td style=\"padding:12px 0 2px;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:{tint}\">{Enc(title)} · {lines.Count}</td></tr>{rows}{more}";
        }
        foreach (var p in projects)
        {
            var bar = Math.Clamp(p.Progress, 0, 100);
            sb.Append("<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" class=\"card2\" style=\"margin:0 0 18px;border:1px solid #ece7f8;border-radius:14px\"><tr><td style=\"padding:16px 18px\">");
            sb.Append($"<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tr><td><a class=\"tx\" href=\"{Enc(web + "/projects/" + p.Id)}\" style=\"color:#221a3a;font-weight:700;font-size:16px;text-decoration:none\">{Enc(p.Name)}</a></td>");
            sb.Append($"<td align=\"right\" class=\"tx2\" style=\"font-size:14px;font-weight:700;color:#6d28d9\">{bar}%</td></tr></table>");
            sb.Append("<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin:8px 0 4px\"><tr>");
            sb.Append(bar > 0 ? $"<td width=\"{bar}%\" style=\"height:6px;background:#7c3aed;border-radius:3px;font-size:0;line-height:0\">&nbsp;</td>" : "");
            sb.Append(bar < 100 ? $"<td style=\"height:6px;background:#ede9fe;border-radius:3px;font-size:0;line-height:0\">&nbsp;</td>" : "");
            sb.Append("</tr></table>");
            sb.Append("<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\">");
            var body = Section("Slipped", "#d97706", p.Slipped, false) + Section("Blocked", "#dc2626", p.Blocked, true) + Section("Overdue", "#dc2626", p.Overdue, true)
                + Section("Due this week", "#2563eb", p.NextWeek, true) + Section("Done last week", "#059669", p.Done, false);
            sb.Append(body.Length == 0 ? "<tr><td class=\"tx2\" style=\"padding:10px 0 0;font-size:14px;color:#6a6288\">A quiet week: nothing done, due, late or blocked.</td></tr>" : body);
            sb.Append("</table></td></tr></table>");
        }
        return sb.ToString();
    }

    private static string Plain(string first, IReadOnlyList<DigestProjectDto> projects, string web, string unsubscribe)
    {
        var sb = new StringBuilder();
        sb.Append("Good morning ").Append(first).Append(",\n\nYour week ahead in Project Tracker.\n");
        void Lines(string title, IReadOnlyList<DigestLineDto> lines, bool showDate)
        {
            if (lines.Count == 0) return;
            sb.Append("\n  ").Append(title).Append(" (").Append(lines.Count).Append(")\n");
            foreach (var l in lines.Take(PerList))
            {
                sb.Append("  - ").Append(l.Key).Append(' ').Append(l.Title);
                if (showDate && l.Date is { } d) sb.Append(" · ").Append(Day(d));
                if (!string.IsNullOrEmpty(l.Detail)) sb.Append(" · ").Append(l.Detail);
                sb.Append('\n');
            }
            if (lines.Count > PerList) sb.Append("  and ").Append(lines.Count - PerList).Append(" more\n");
        }
        foreach (var p in projects)
        {
            sb.Append("\n").Append(p.Name).Append(" — ").Append(p.Progress).Append("% done\n");
            Lines("Slipped", p.Slipped, false); Lines("Blocked", p.Blocked, true); Lines("Overdue", p.Overdue, true);
            Lines("Due this week", p.NextWeek, true); Lines("Done last week", p.Done, false);
        }
        sb.Append("\nOpen your projects: ").Append(web).Append("/projects\n");
        sb.Append("Stop these e-mails: ").Append(unsubscribe).Append('\n');
        return sb.ToString();
    }

    /// <summary>
    /// Sends the digests that are due at <paramref name="nowUtc"/>: for each owner of active projects whose local time is Monday 09:00-11:59 and who
    /// has not had this Monday's e-mail for that workspace yet. Returns how many were sent.
    /// </summary>
    public async Task<int> SendAsync(DateTime nowUtc, CancellationToken ct = default)
    {
        var closed = new[] { ProjectStatus.Completed, ProjectStatus.Cancelled, ProjectStatus.Archived };
        var owners = await (from p in db.Projects.IgnoreQueryFilters().AsNoTracking()
                            join t in db.Tenants.IgnoreQueryFilters().AsNoTracking() on p.TenantId equals t.Id
                            join u in db.Users.IgnoreQueryFilters().AsNoTracking() on p.OwnerId equals u.Id
                            where !p.IsDeleted && p.ArchivedAt == null && !closed.Contains(p.Status) && !t.IsDeleted && t.Status == TenantStatus.Active && u.IsActive
                            select new { p.TenantId, p.OwnerId, UserZone = u.TimeZone, OrgZone = t.TimeZone }).Distinct().ToListAsync(ct);
        if (owners.Count == 0) return 0;
        var userIds = owners.Select(o => o.OwnerId).Distinct().ToList();
        var settings = await db.ReminderSettings.AsNoTracking().Where(s => userIds.Contains(s.UserId)).ToDictionaryAsync(s => s.UserId, ct);
        var members = (await db.TenantMembers.IgnoreQueryFilters().AsNoTracking().Where(m => userIds.Contains(m.UserId)).Select(m => new { m.TenantId, m.UserId }).ToListAsync(ct))
            .Select(m => (m.TenantId, m.UserId)).ToHashSet();

        var sent = 0;
        foreach (var o in owners)
        {
            if (!members.Contains((o.TenantId, o.OwnerId))) continue;   // owns a project in a workspace they have since left
            var zone = clock.ZoneFor(o.UserZone, AppClock.Chose(settings.GetValueOrDefault(o.OwnerId)), o.OrgZone);
            var local = ZoneTime.ToLocal(nowUtc, zone);
            if (local.DayOfWeek != DayOfWeek.Monday) continue;
            var at = TimeOnly.FromDateTime(local);
            if (at < SendAt || at >= SendAt.AddHours(3)) continue;          // not yet, or too late: never sent late
            var today = DateOnly.FromDateTime(local);
            var key = $"mgrdigest:{o.TenantId:N}:{o.OwnerId:N}:{today:yyyyMMdd}";
            if (await db.Notifications.IgnoreQueryFilters().AnyAsync(n => n.DedupeKey == key, ct)) continue;
            var channels = await router.ChannelsAsync(o.OwnerId, NotificationType.ManagerDigest, ct, o.TenantId);
            if (!channels.Email && !channels.InApp) continue;
            var digest = await BuildAsync(o.TenantId, o.OwnerId, today, nowUtc, zone.Id, ct);
            if (digest is null) continue;
            if (channels.Email && !string.IsNullOrWhiteSpace(digest.Email))
                await sender.SendAsync(new EmailMessage(digest.Email, digest.Subject, digest.Html, digest.Text, "manager-digest",
                    links.Headers(o.OwnerId, NotificationType.ManagerDigest)), ct);
            db.Notifications.Add(new Notification
            {
                TenantId = o.TenantId, UserId = o.OwnerId, Type = NotificationType.ManagerDigest, CreatedAt = nowUtc, Link = "/projects", DedupeKey = key,
                Title = digest.Subject, Body = Text.Truncate(string.Join("\n", digest.Projects.Select(p => $"{p.Name}: {p.Progress}% · {p.Done.Count} done · {p.Overdue.Count} overdue")), 600),
                InApp = channels.InApp, EmailPending = false, EmailedAt = channels.Email ? nowUtc : null,
            });
            await db.SaveChangesAsync(ct);
            sent++;
        }
        return sent;
    }

    /// <summary>What a person's e-mail would say if it were sent now (workspace owners and admins; any member of the workspace, yourself by default).</summary>
    public async Task<ManagerDigestDto> PreviewAsync(Guid? userId, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var me = ctx.RequireUserId();
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin) && !ctx.IsPlatformAdmin)
            throw new ForbiddenException("Only workspace owners and admins can preview the weekly e-mail.", "PERMISSION_DENIED");
        var who = userId ?? me;
        if (!await db.TenantMembers.AnyAsync(m => m.UserId == who, ct)) throw new NotFoundException("That person is not in this workspace.");
        var user = await db.Users.IgnoreQueryFilters().AsNoTracking().FirstAsync(u => u.Id == who, ct);
        var tenant = await db.Tenants.IgnoreQueryFilters().AsNoTracking().FirstAsync(t => t.Id == tid, ct);
        var s = await db.ReminderSettings.AsNoTracking().FirstOrDefaultAsync(x => x.UserId == who, ct);
        var zone = clock.ZoneFor(user.TimeZone, AppClock.Chose(s), tenant.TimeZone);
        var now = clock.Now;
        var today = DateOnly.FromDateTime(ZoneTime.ToLocal(now, zone));
        return await BuildAsync(tid, who, today, now, zone.Id, ct)
            ?? throw new NotFoundException("This person owns no active projects in this workspace, so there is no weekly e-mail for them.");
    }
}
