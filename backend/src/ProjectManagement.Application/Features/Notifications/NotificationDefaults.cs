using System.Globalization;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Notifications;

public record ChannelSetDto(bool InApp, bool Email, bool Browser);
/// <param name="Following">Members who have not chosen for themselves, so this default is what they get.</param>
public record NotificationDefaultKindDto(NotificationType Type, string Label, string Description, bool Locked, bool NeedsYou, ChannelSetDto Platform,
    ChannelSetDto Workspace, bool Changed, int Following, int ChoseOwn);
public record NotificationDefaultsDto(IReadOnlyList<NotificationDefaultKindDto> Kinds, bool QuietCustom, string? QuietStart, string? QuietEnd,
    bool DigestCustom, string? DigestTime, int Members, int MembersWithOwnSchedule, string PlatformQuiet, bool CanEdit, DateTime? UpdatedAt);
public record SaveNotificationDefaultsRequest(IReadOnlyList<PreferenceInput>? Kinds, bool QuietCustom, string? QuietStart, string? QuietEnd, bool DigestCustom, string? DigestTime);

/// <summary>Reading and writing a workspace's notification defaults ("TaskAssigned=ieb;Briefing=").</summary>
public static class NotificationDefaultsCodec
{
    public static Dictionary<NotificationType, Channels> Parse(string? stored)
    {
        var map = new Dictionary<NotificationType, Channels>();
        if (string.IsNullOrWhiteSpace(stored)) return map;
        foreach (var part in stored.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var eq = part.IndexOf('=');
            if (eq <= 0 || !Enum.TryParse<NotificationType>(part[..eq], out var type) || !Enum.IsDefined(type)) continue;
            var f = part[(eq + 1)..];
            map[type] = new Channels(f.Contains('i'), f.Contains('e'), f.Contains('b'));
        }
        return map;
    }

    public static Channels? Find(string? stored, NotificationType type) =>
        string.IsNullOrEmpty(stored) || !stored.Contains(type.ToString(), StringComparison.Ordinal) ? null
        : Parse(stored).TryGetValue(type, out var c) ? c : null;

    /// <summary>Only the kinds that differ from the platform are written; security alerts cannot be changed.</summary>
    public static string Write(IReadOnlyDictionary<NotificationType, Channels> map) => string.Join(';', map
        .Where(kv => !NotificationCatalog.For(kv.Key).Locked && kv.Value != NotificationRouter.Defaults(kv.Key))
        .OrderBy(kv => kv.Key.ToString(), StringComparer.Ordinal)
        .Select(kv => $"{kv.Key}={(kv.Value.InApp ? "i" : "")}{(kv.Value.Email ? "e" : "")}{(kv.Value.Browser ? "b" : "")}"));

    /// <summary>Fills a person's unsaved schedule with the workspace's quiet hours and digest, when it set them.</summary>
    public static ReminderSettings Apply(ReminderSettings s, WorkspaceNotificationDefaults? w)
    {
        if (w is null) return s;
        if (w.QuietCustom) { s.QuietStart = w.QuietStart; s.QuietEnd = w.QuietEnd; }
        if (w.DigestCustom) s.DigestTime = w.DigestTime;
        return s;
    }

    public static string? Time(TimeOnly? t) => t?.ToString("HH:mm", CultureInfo.InvariantCulture);

    public static TimeOnly? ParseTime(string? text, string field)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        return TimeOnly.TryParseExact(text.Trim(), ["HH:mm", "H:mm", "HH:mm:ss"], CultureInfo.InvariantCulture, DateTimeStyles.None, out var t)
            ? t : throw new ValidationException(field, "Use a time like 21:00.");
    }
}

/// <summary>
/// Workspace settings → Notifications: what members get until they choose for themselves. Owners and admins set it; a person's own choice
/// (Notification Center) always wins, and security alerts always reach the bell and e-mail. Every change is audited with the values before
/// and after, so Settings can show who changed it and undo it.
/// </summary>
public class NotificationDefaultsService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder)
{
    private bool IsAdmin => ctx.Role is TenantRole.Owner or TenantRole.Admin;

    public async Task<NotificationDefaultsDto> GetAsync(CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        if (!IsAdmin) throw new ForbiddenException("Only owners and admins can see the workspace's notification defaults.", "PERMISSION_DENIED");
        var row = await db.WorkspaceNotificationDefaults.AsNoTracking().FirstOrDefaultAsync(x => x.TenantId == tid, ct);
        var map = NotificationDefaultsCodec.Parse(row?.Channels);
        var members = await (from m in db.TenantMembers.AsNoTracking()
                             join u in db.Users.AsNoTracking() on m.UserId equals u.Id
                             where m.TenantId == tid && u.IsActive
                             select m.UserId).ToListAsync(ct);
        var chose = await db.NotificationPreferences.AsNoTracking().Where(p => members.Contains(p.UserId))
            .GroupBy(p => p.Type).Select(g => new { g.Key, Count = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.Count, ct);
        var ownSchedule = await db.ReminderSettings.AsNoTracking().CountAsync(s => members.Contains(s.UserId), ct);
        var kinds = NotificationCatalog.All.Select(k =>
        {
            var platform = new ChannelSetDto(k.InApp, k.Email, k.Browser);
            var w = map.TryGetValue(k.Type, out var c) && !k.Locked ? new ChannelSetDto(c.InApp, c.Email, c.Browser) : platform;
            var own = chose.GetValueOrDefault(k.Type);
            return new NotificationDefaultKindDto(k.Type, k.Label, k.Description, k.Locked, NotificationLanes.IsNeedsYou(k.Type), platform, w, w != platform,
                Math.Max(0, members.Count - own), own);
        }).ToList();
        var platformQuiet = new ReminderSettings();
        return new NotificationDefaultsDto(kinds, row?.QuietCustom ?? false, NotificationDefaultsCodec.Time(row?.QuietStart), NotificationDefaultsCodec.Time(row?.QuietEnd),
            row?.DigestCustom ?? false, NotificationDefaultsCodec.Time(row?.DigestTime), members.Count, ownSchedule,
            $"{NotificationDefaultsCodec.Time(platformQuiet.QuietStart)}–{NotificationDefaultsCodec.Time(platformQuiet.QuietEnd)}", true, row?.UpdatedAt ?? row?.CreatedAt);
    }

    public async Task<NotificationDefaultsDto> SaveAsync(SaveNotificationDefaultsRequest req, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        if (ctx.ViaApiKey) throw new ForbiddenException("API keys cannot change notification defaults.", "API_KEY_NOT_ALLOWED");
        if (!IsAdmin) throw new ForbiddenException("Only owners and admins can change the workspace's notification defaults.", "PERMISSION_DENIED");
        var quietStart = NotificationDefaultsCodec.ParseTime(req.QuietStart, "quietStart");
        var quietEnd = NotificationDefaultsCodec.ParseTime(req.QuietEnd, "quietEnd");
        if (req.QuietCustom && (quietStart is null) != (quietEnd is null)) throw new ValidationException("quietEnd", "Give both the start and the end of quiet hours, or neither for none.");
        if (req.QuietCustom && quietStart is not null && quietStart == quietEnd) throw new ValidationException("quietEnd", "Quiet hours need to end at a different time than they start.");
        var digest = NotificationDefaultsCodec.ParseTime(req.DigestTime, "digestTime");

        var row = await db.WorkspaceNotificationDefaults.FirstOrDefaultAsync(x => x.TenantId == tid, ct);
        var before = row is null ? Snapshot(null) : Snapshot(row);
        if (row is null) db.WorkspaceNotificationDefaults.Add(row = new WorkspaceNotificationDefaults { TenantId = tid, CreatedAt = clock.Now, CreatedBy = ctx.UserId });
        var map = NotificationDefaultsCodec.Parse(row.Channels);
        foreach (var k in (req.Kinds ?? []).GroupBy(k => k.Type).Select(g => g.Last()))
        {
            if (!Enum.IsDefined(k.Type)) throw new ValidationException("kinds", "Unknown kind of notification.");
            if (NotificationCatalog.For(k.Type).Locked) continue;
            map[k.Type] = new Channels(k.InApp, k.Email, k.Browser && k.InApp);
        }
        row.Channels = NotificationDefaultsCodec.Write(map);
        row.QuietCustom = req.QuietCustom;
        row.QuietStart = req.QuietCustom ? quietStart : null;
        row.QuietEnd = req.QuietCustom ? quietEnd : null;
        row.DigestCustom = req.DigestCustom;
        row.DigestTime = req.DigestCustom ? digest : null;
        row.UpdatedAt = clock.Now; row.UpdatedBy = ctx.UserId;
        var after = Snapshot(row);
        if (!Equals(before, after)) recorder.Audit("notifications.defaults_changed", "WorkspaceNotificationDefaults", row.Id, before, after, tenantId: tid);
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    /// <summary>Puts back an earlier version (Settings → undo the last change), through the same checks as saving.</summary>
    public Task<NotificationDefaultsDto> RestoreAsync(DefaultsSnapshot s, CancellationToken ct = default)
    {
        var map = NotificationDefaultsCodec.Parse(s.Channels);
        var kinds = NotificationCatalog.All.Where(k => !k.Locked).Select(k =>
        {
            var c = map.TryGetValue(k.Type, out var v) ? v : NotificationRouter.Defaults(k.Type);
            return new PreferenceInput(k.Type, c.InApp, c.Email, c.Browser);
        }).ToList();
        return SaveAsync(new SaveNotificationDefaultsRequest(kinds, s.QuietCustom, s.QuietStart, s.QuietEnd, s.DigestCustom, s.DigestTime), ct);
    }

    public record DefaultsSnapshot(string Channels, bool QuietCustom, string? QuietStart, string? QuietEnd, bool DigestCustom, string? DigestTime);

    public static DefaultsSnapshot Snapshot(WorkspaceNotificationDefaults? r) => r is null
        ? new DefaultsSnapshot("", false, null, null, false, null)
        : new DefaultsSnapshot(r.Channels, r.QuietCustom, NotificationDefaultsCodec.Time(r.QuietStart), NotificationDefaultsCodec.Time(r.QuietEnd), r.DigestCustom, NotificationDefaultsCodec.Time(r.DigestTime));
}
