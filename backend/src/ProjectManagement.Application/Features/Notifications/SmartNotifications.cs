using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Notifications;

/// <summary>
/// Priority: urgent notifications ring and pop up (approvals, mentions, what is due today or overdue, incidents and service-level breaches,
/// calls, security, the reminders a person set for a time); everything else is normal and only adds to the quiet badge. A person can move
/// any kind between the two (security alerts stay urgent).
/// </summary>
public static class NotificationPriority
{
    public const string Urgent = "urgent", Normal = "normal";

    public static readonly NotificationType[] DefaultUrgent =
    [
        NotificationType.Approval, NotificationType.Mention, NotificationType.DueSoon, NotificationType.Overdue, NotificationType.Issue,
        NotificationType.ServiceLevel, NotificationType.Call, NotificationType.Security, NotificationType.Reminder,
    ];

    public static string Default(NotificationType t) => Array.IndexOf(DefaultUrgent, t) >= 0 || NotificationCatalog.For(t).Locked ? Urgent : Normal;

    public static string Of(NotificationType t, IReadOnlyDictionary<NotificationType, string>? overrides) =>
        NotificationCatalog.For(t).Locked ? Urgent : overrides is not null && overrides.TryGetValue(t, out var p) ? p : Default(t);

    /// <summary>"Approval=urgent,Message=normal" → the choices; unknown kinds and values are skipped.</summary>
    public static Dictionary<NotificationType, string> Parse(string? text)
    {
        var map = new Dictionary<NotificationType, string>();
        foreach (var part in (text ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var kv = part.Split('=', 2, StringSplitOptions.TrimEntries);
            if (kv.Length == 2 && Enum.TryParse<NotificationType>(kv[0], true, out var t) && Enum.IsDefined(t) && (kv[1] == Urgent || kv[1] == Normal)) map[t] = kv[1];
        }
        return map;
    }

    /// <summary>Only the choices that differ from the default are kept.</summary>
    public static string Write(IReadOnlyDictionary<NotificationType, string> map) =>
        string.Join(",", map.Where(kv => kv.Value != Default(kv.Key) && !NotificationCatalog.For(kv.Key).Locked).OrderBy(kv => kv.Key.ToString()).Select(kv => $"{kv.Key}={kv.Value}"));
}

/// <summary>
/// What a notification is about, read from its link: a project (/projects/{id}…), a conversation (/chat/{id}) or a work item (/work?item={id},
/// /desk/{id}). Updates about the same thing close together are one group ("6 updates on CIBIL Integration"), and only the first of them pings.
/// </summary>
public static partial class NotificationGroups
{
    public const string Project = "project", Thread = "thread";

    [GeneratedRegex(@"^/projects/([0-9a-fA-F-]{36})", RegexOptions.CultureInvariant)]
    private static partial Regex ProjectLink();
    [GeneratedRegex(@"^/chat/([0-9a-fA-F-]{36})", RegexOptions.CultureInvariant)]
    private static partial Regex ChatLink();
    [GeneratedRegex(@"[?&](?:task|item|thread)=([0-9a-fA-F-]{36})", RegexOptions.CultureInvariant)]
    private static partial Regex ItemParam();
    [GeneratedRegex(@"^/(?:desk|work/items)/([0-9a-fA-F-]{36})", RegexOptions.CultureInvariant)]
    private static partial Regex ItemLink();

    public static Guid? ProjectOf(string? link) => link is not null && ProjectLink().Match(link) is { Success: true } m && Guid.TryParse(m.Groups[1].Value, out var id) ? id : null;

    /// <summary>The thread inside it: a task, work item or chat thread named in the link, else the conversation.</summary>
    public static Guid? ThreadOf(string? link)
    {
        if (link is null) return null;
        if (ItemParam().Match(link) is { Success: true } p && Guid.TryParse(p.Groups[1].Value, out var item)) return item;
        if (ChatLink().Match(link) is { Success: true } c && Guid.TryParse(c.Groups[1].Value, out var conv)) return conv;
        if (ItemLink().Match(link) is { Success: true } w && Guid.TryParse(w.Groups[1].Value, out var wi)) return wi;
        return null;
    }

    /// <summary>The group key ("project:{id}", "chat:{id}", "item:{id}"), or null for notifications about nothing in particular.</summary>
    public static string? KeyOf(string? link)
    {
        if (ProjectOf(link) is { } p) return $"project:{p:N}";
        if (link is not null && ChatLink().Match(link) is { Success: true } c && Guid.TryParse(c.Groups[1].Value, out var conv)) return $"chat:{conv:N}";
        if (ThreadOf(link) is { } t) return $"item:{t:N}";
        return null;
    }

    /// <summary>The start every link of the same group shares, for finding its earlier notifications in the database.</summary>
    public static string? LinkPrefix(string? link)
    {
        if (ProjectOf(link) is { } p) return $"/projects/{p}";
        if (link is not null && ChatLink().Match(link) is { Success: true } c) return c.Value;
        if (link is not null && ItemLink().Match(link) is { Success: true } w) return w.Value;
        return null;
    }

    /// <summary>Whether one of these mutes covers a notification with this link (now).</summary>
    public static bool IsMuted(IEnumerable<NotificationMute> mutes, string? link, DateTime now)
    {
        if (string.IsNullOrEmpty(link)) return false;
        var project = ProjectOf(link);
        foreach (var m in mutes)
        {
            if (m.Until is { } u && u <= now) continue;
            if (m.Scope == Project && project == m.TargetId) return true;
            if (m.Scope == Thread && link.Contains(m.TargetId.ToString(), StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }
}

public record SmartKindDto(NotificationType Type, string Label, string Priority, string DefaultPriority, bool Locked);
public record NotificationMuteDto(Guid Id, string Scope, Guid TargetId, string Label, DateTime? Until, DateTime CreatedAt);
public record SmartSettingsDto(bool Grouping, int GroupWindowMinutes, IReadOnlyList<SmartKindDto> Kinds, IReadOnlyList<NotificationMuteDto> Mutes);
public record SmartPriorityInput(NotificationType Type, string Priority);
public record SaveSmartSettingsRequest(bool? Grouping = null, int? GroupWindowMinutes = null, IReadOnlyList<SmartPriorityInput>? Priorities = null);
/// <param name="Scope">project or thread.</param>
/// <param name="Hours">Mute for this many hours; null = until unmuted.</param>
public record MuteRequest(string Scope, Guid TargetId, string? Label = null, int? Hours = null);
/// <param name="Scope">project (the project the notification is about) or thread (its task, conversation or work item).</param>
public record MuteFromNotificationRequest(string Scope, int? Hours = null);

/// <summary>A person's own smart-notification choices: grouping, priority per kind, and what they muted. Only ever their own rows.</summary>
public class SmartNotificationService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ProjectAccess access)
{
    public const int MinWindow = 5, MaxWindow = 24 * 60, MaxMutes = 200;

    public async Task<SmartSettingsDto> GetAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var row = await db.NotificationTunings.AsNoTracking().FirstOrDefaultAsync(t => t.UserId == uid, ct);
        var map = NotificationPriority.Parse(row?.PriorityOverrides);
        var kinds = NotificationCatalog.All.Select(k => new SmartKindDto(k.Type, k.Label, NotificationPriority.Of(k.Type, map), NotificationPriority.Default(k.Type), k.Locked)).ToList();
        var now = clock.Now;
        var mutes = await db.NotificationMutes.AsNoTracking().Where(m => m.UserId == uid && (m.Until == null || m.Until > now)).OrderByDescending(m => m.CreatedAt)
            .Select(m => new NotificationMuteDto(m.Id, m.Scope, m.TargetId, m.Label, m.Until, m.CreatedAt)).ToListAsync(ct);
        return new SmartSettingsDto(row?.Grouping ?? true, row?.GroupWindowMinutes ?? 60, kinds, mutes);
    }

    public async Task<SmartSettingsDto> SaveAsync(SaveSmartSettingsRequest req, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var tid = ctx.RequireTenantId();
        if (req.GroupWindowMinutes is { } w && (w < MinWindow || w > MaxWindow)) throw new ValidationException("groupWindowMinutes", $"Choose between {MinWindow} minutes and 24 hours.");
        var row = await db.NotificationTunings.FirstOrDefaultAsync(t => t.UserId == uid, ct);
        if (row is null) db.NotificationTunings.Add(row = new NotificationTuning { TenantId = tid, UserId = uid, CreatedAt = clock.Now, CreatedBy = uid });
        if (req.Grouping is { } g) row.Grouping = g;
        if (req.GroupWindowMinutes is { } win) row.GroupWindowMinutes = win;
        if (req.Priorities is { Count: > 0 } list)
        {
            var map = NotificationPriority.Parse(row.PriorityOverrides);
            foreach (var p in list)
            {
                if (!Enum.IsDefined(p.Type)) throw new ValidationException("priorities", "Unknown kind of notification.");
                var v = (p.Priority ?? "").Trim().ToLowerInvariant();
                if (v != NotificationPriority.Urgent && v != NotificationPriority.Normal) throw new ValidationException("priorities", "Priority is urgent or normal.");
                map[p.Type] = v;
            }
            row.PriorityOverrides = NotificationPriority.Write(map);
        }
        row.UpdatedAt = clock.Now; row.UpdatedBy = uid;
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    public async Task<NotificationMuteDto> MuteAsync(MuteRequest req, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var tid = ctx.RequireTenantId();
        var scope = (req.Scope ?? "").Trim().ToLowerInvariant();
        if (scope != NotificationGroups.Project && scope != NotificationGroups.Thread) throw new ValidationException("scope", "Mute a project or a thread.");
        if (req.TargetId == Guid.Empty) throw new ValidationException("targetId", "Say what to mute.");
        if (req.Hours is { } h && (h < 1 || h > 24 * 90)) throw new ValidationException("hours", "Mute for 1 hour to 90 days, or until you unmute.");
        var label = Text.Truncate((req.Label ?? "").Trim(), 200) ?? "";
        if (scope == NotificationGroups.Project) label = (await access.GetProjectAsync(req.TargetId, ct)).Name;   // 404 unless they may see it
        if (label.Length == 0) label = "A thread";
        var until = req.Hours is { } hours ? clock.Now.AddHours(hours) : (DateTime?)null;
        var row = await db.NotificationMutes.FirstOrDefaultAsync(m => m.UserId == uid && m.Scope == scope && m.TargetId == req.TargetId, ct);
        if (row is null)
        {
            if (await db.NotificationMutes.CountAsync(m => m.UserId == uid, ct) >= MaxMutes) throw new ValidationException("targetId", $"You can mute up to {MaxMutes} things; unmute some first.");
            db.NotificationMutes.Add(row = new NotificationMute { TenantId = tid, UserId = uid, Scope = scope, TargetId = req.TargetId, CreatedAt = clock.Now, CreatedBy = uid });
        }
        row.Label = label; row.Until = until; row.UpdatedAt = clock.Now; row.UpdatedBy = uid;
        await db.SaveChangesAsync(ct);
        return new NotificationMuteDto(row.Id, row.Scope, row.TargetId, row.Label, row.Until, row.CreatedAt);
    }

    /// <summary>Mutes what one of the person's own notifications is about: its project, or its thread.</summary>
    public async Task<NotificationMuteDto> MuteFromNotificationAsync(Guid notificationId, MuteFromNotificationRequest req, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var n = await db.Notifications.AsNoTracking().Where(x => x.Id == notificationId && x.UserId == uid).Select(x => new { x.Link, x.Title }).FirstOrDefaultAsync(ct)
            ?? throw new NotFoundException("Notification not found.");
        var scope = (req.Scope ?? "").Trim().ToLowerInvariant();
        var target = scope == NotificationGroups.Project ? NotificationGroups.ProjectOf(n.Link) : NotificationGroups.ThreadOf(n.Link);
        if (target is not { } id) throw new ValidationException("scope", scope == NotificationGroups.Project ? "This notification is not about a project." : "This notification is not about a thread.");
        return await MuteAsync(new MuteRequest(scope, id, n.Title, req.Hours), ct);
    }

    public async Task UnmuteAsync(Guid id, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var row = await db.NotificationMutes.FirstOrDefaultAsync(m => m.Id == id && m.UserId == uid, ct) ?? throw new NotFoundException("Mute not found.");
        db.NotificationMutes.Remove(row);
        await db.SaveChangesAsync(ct);
    }
}
