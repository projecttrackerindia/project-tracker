using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Notifications;

/// <param name="ShownAt">When it belongs in the inbox: when it arrived, or when its snooze ended.</param>
/// <param name="Actions">What can be done straight from it: done, take, reply, approve, reject, snooze (worked out per person when listed).</param>
public record NotificationDto(Guid Id, NotificationType Type, string Title, string? Body, string? Link, bool IsRead, DateTime CreatedAt, bool Browser, bool NeedsYou = false,
    bool Archived = false, DateTime? SnoozedUntil = null, DateTime? ShownAt = null, IReadOnlyList<string>? Actions = null,
    string Category = NotificationCategories.Work, DateTime? StartsAt = null, string? JoinLink = null, string? Reason = null);
/// <summary>
/// The inbox at a glance: unread overall, in each lane, and in each category of the Notification Centre (the badges on the bell, the app
/// icon and the tabs all read this one answer).
/// </summary>
public record NotificationCountsDto(int Unread, int NeedsYou, int ForInfo, int Snoozed = 0, int Messages = 0, int Reminders = 0, int Meetings = 0, int Work = 0);
/// <param name="Category">messages, reminders, meetings or work; empty for every category.</param>
/// <param name="Ids">These notifications only (a stacked group cleared at once). Wins over the category.</param>
public record NotificationClearRequest(string? Category = null, IReadOnlyList<Guid>? Ids = null);
public record NotificationSnoozeRequest(DateTime? Until);

/// <summary>
/// The Notification Centre's filters: messages (chat, @mentions, calls), reminders (reminders, nudges, due and overdue work), meetings
/// (invitations, changes and the "starts in 10 minutes" reminders, which point at a meeting) and work (everything else).
/// </summary>
public static class NotificationCategories
{
    public const string Messages = "messages", Reminders = "reminders", Meetings = "meetings", Work = "work";
    public static readonly string[] All = [Messages, Reminders, Meetings, Work];
    public static readonly NotificationType[] MessageTypes = [NotificationType.Message, NotificationType.Mention, NotificationType.Call];
    public static readonly NotificationType[] ReminderTypes =
        [NotificationType.Reminder, NotificationType.Nudge, NotificationType.DueSoon, NotificationType.Overdue, NotificationType.TimesheetReminder, NotificationType.CertificationExpiry];
    public const string CallMeetingPrefix = "/calls/meeting/", MeetPrefix = "/meet?open=";

    public static bool IsMeetingLink(string? link) => link is not null && (link.StartsWith(CallMeetingPrefix, StringComparison.Ordinal) || link.StartsWith(MeetPrefix, StringComparison.Ordinal));

    public static string Of(NotificationType type, string? link) =>
        type == NotificationType.Meeting || (type == NotificationType.Reminder && IsMeetingLink(link)) ? Meetings
        : Array.IndexOf(MessageTypes, type) >= 0 ? Messages
        : Array.IndexOf(ReminderTypes, type) >= 0 ? Reminders
        : Work;

    /// <summary>The same split as <see cref="Of"/>, as a database filter. Unknown names filter nothing.</summary>
    public static IQueryable<Notification> Where(IQueryable<Notification> q, string? category)
    {
        var msg = MessageTypes;
        var rem = ReminderTypes;
        return (category ?? "").Trim().ToLowerInvariant() switch
        {
            Messages => q.Where(n => msg.Contains(n.Type)),
            Meetings => q.Where(n => n.Type == NotificationType.Meeting
                || (n.Type == NotificationType.Reminder && n.Link != null && (n.Link.StartsWith(CallMeetingPrefix) || n.Link.StartsWith(MeetPrefix)))),
            Reminders => q.Where(n => rem.Contains(n.Type)
                && !(n.Type == NotificationType.Reminder && n.Link != null && (n.Link.StartsWith(CallMeetingPrefix) || n.Link.StartsWith(MeetPrefix)))),
            Work => q.Where(n => n.Type != NotificationType.Meeting && !msg.Contains(n.Type) && !rem.Contains(n.Type)),
            _ => q,
        };
    }
}

/// <summary>
/// Which notifications ask something of the person (approve, answer, act, sign in safely) and which only tell them something. The inbox shows
/// the first lane on top, so what needs someone is never buried under updates.
/// </summary>
public static class NotificationLanes
{
    public static readonly NotificationType[] NeedsYou =
    [
        NotificationType.TaskAssigned, NotificationType.Mention, NotificationType.Approval, NotificationType.Overdue, NotificationType.DueSoon,
        NotificationType.Reminder, NotificationType.Nudge, NotificationType.Invitation, NotificationType.Security, NotificationType.ServiceLevel,
        NotificationType.Message, NotificationType.Support, NotificationType.AgentAlert, NotificationType.CertificationExpiry, NotificationType.TimesheetReminder,
        NotificationType.Call,
    ];
    public static bool IsNeedsYou(NotificationType t) => Array.IndexOf(NeedsYou, t) >= 0;
}
public record UnreadCountDto(int Count);

/// <param name="Source">Where the shown channels come from: "you" (your own choice), "workspace" (this workspace's default) or "default" (the platform's).</param>
public record NotificationPreferenceDto(NotificationType Type, string Label, string Description, bool InApp, bool Email, bool Browser, bool Locked, string Source = "default");
public record PreferenceInput(NotificationType Type, bool InApp, bool Email, bool Browser);
public record SetPreferencesRequest(IReadOnlyList<PreferenceInput> Items);
public record TestEmailResultDto(string Provider, bool Delivered, string Message);

/// <summary>Which channels a notification uses for one recipient.</summary>
public readonly record struct Channels(bool InApp, bool Email, bool Browser)
{
    public bool Any => InApp || Email || Browser;
}

/// <summary>
/// Quiet hours for e-mail and push: what is created while the recipient's quiet hours are on (Notifications → Schedule) waits until they
/// end. The in-app item always appears at once, and some kinds are never held (see <see cref="NeverHeld"/>).
/// </summary>
public static class QuietHours
{
    /// <summary>Security alerts, reminders the person set for a chosen time, service-level breaches and invitations go out at once.</summary>
    public static bool NeverHeld(NotificationType type) =>
        NotificationCatalog.For(type).Locked || type is NotificationType.Security or NotificationType.Reminder or NotificationType.ServiceLevel or NotificationType.Invitation or NotificationType.Briefing
        || type is NotificationType.Call;   // a call rings now or never: holding it for later would only deliver a dead call

    /// <summary>The next moment (UTC) the local clock shows <paramref name="at"/>: later today, or tomorrow when that time has passed.</summary>
    public static DateTime NextAt(TimeOnly at, NodaTime.DateTimeZone tz, DateTime nowUtc)
    {
        var local = ZoneTime.ToLocal(nowUtc, tz);
        var day = DateOnly.FromDateTime(local);
        var when = ZoneTime.ToUtc(ZoneTime.At(day, at), tz);
        return when > nowUtc ? when : ZoneTime.ToUtc(ZoneTime.At(day.AddDays(1), at), tz);
    }

    /// <summary>When quiet hours that are on at <paramref name="nowUtc"/> end (UTC); null when it is not quiet time now.</summary>
    public static DateTime? Until(ReminderSettings s, NodaTime.DateTimeZone tz, DateTime nowUtc)
    {
        if (s.QuietStart is null || s.QuietEnd is not { } end || s.QuietStart == s.QuietEnd) return null;
        var local = ZoneTime.ToLocal(nowUtc, tz);
        var time = TimeOnly.FromDateTime(local);
        if (!new WorkCalendar(s).InQuietHours(time)) return null;
        var day = DateOnly.FromDateTime(local);
        // Still before the end time: it ends later today (the morning part of a window that runs past midnight, or a daytime window).
        // Otherwise this is the evening part of a window that runs past midnight: it ends tomorrow.
        var endDay = time < end ? day : day.AddDays(1);
        return ZoneTime.ToUtc(ZoneTime.At(endDay, end), tz);
    }
}

/// <summary>Turns a recipient's preferences (or the catalog defaults) into channels. Preferences are loaded once per user and cached for the request.</summary>
public class NotificationRouter(IAppDbContext db, AppClock clock, IOptions<AppOptions> options)
{
    private readonly Dictionary<(Guid, Guid), (ReminderSettings Settings, NodaTime.DateTimeZone Zone)> _quiet = new();
    private readonly Dictionary<Guid, WorkspaceNotificationDefaults?> _workspace = new();

    private readonly Dictionary<(Guid, NotificationType), Channels> _chosen = new();
    private readonly HashSet<Guid> _loaded = [];

    public async Task PreloadAsync(IEnumerable<Guid> userIds, CancellationToken ct = default)
    {
        var missing = userIds.Where(u => !_loaded.Contains(u)).Distinct().ToList();
        if (missing.Count == 0) return;
        var rows = await db.NotificationPreferences.AsNoTracking().Where(p => missing.Contains(p.UserId)).ToListAsync(ct);
        foreach (var r in rows) _chosen[(r.UserId, r.Type)] = new Channels(r.InApp, r.Email, r.Browser);
        foreach (var u in missing) _loaded.Add(u);
    }

    public static Channels Defaults(NotificationType type)
    {
        var k = NotificationCatalog.For(type);
        return new Channels(k.InApp, k.Email, k.Browser);
    }

    /// <summary>A workspace's defaults for its members (null = none saved), loaded once per request. Explicit tenant: background jobs have no current workspace.</summary>
    public async Task<WorkspaceNotificationDefaults?> WorkspaceAsync(Guid tenantId, CancellationToken ct = default)
    {
        if (!_workspace.TryGetValue(tenantId, out var w))
        {
            w = await db.WorkspaceNotificationDefaults.IgnoreQueryFilters().AsNoTracking().FirstOrDefaultAsync(x => x.TenantId == tenantId, ct);
            _workspace[tenantId] = w;
        }
        return w;
    }

    /// <summary>
    /// The channels for one person and kind: their own choice; else, inside a workspace, that workspace's default for its members; else the
    /// platform's. Security alerts always reach the bell and e-mail.
    /// </summary>
    public async Task<Channels> ChannelsAsync(Guid userId, NotificationType type, CancellationToken ct = default, Guid? tenantId = null)
    {
        await PreloadAsync([userId], ct);
        Channels c;
        if (_chosen.TryGetValue((userId, type), out var chosen)) c = chosen;
        else if (tenantId is { } t && NotificationDefaultsCodec.Find((await WorkspaceAsync(t, ct))?.Channels, type) is { } fromWorkspace) c = fromWorkspace;
        else c = Defaults(type);
        if (NotificationCatalog.For(type).Locked) c = c with { InApp = true, Email = true }; // security alerts cannot be switched off
        return c;
    }

    /// <summary>Applies the recipient's channels to a new notification. Returns false when they have switched every channel off.</summary>
    public async Task<bool> ApplyAsync(Notification n, CancellationToken ct = default)
    {
        var c = await ChannelsAsync(n.UserId, n.Type, ct, n.TenantId);
        n.InApp = c.InApp;
        n.EmailPending = c.Email;
        n.Browser = c.Browser && c.InApp; // a desktop notification needs the in-app item to open
        n.PushPending = n.Browser;        // and is also pushed to the person's devices, for when the app is closed
        // Slack direct messages, for people who linked Slack: what needs them, or everything, as they chose (Connected accounts).
        var slack = c.Any ? await SlackChoiceAsync(n.UserId, n.TenantId, ct) : "off";
        n.SlackPending = slack == "all" || slack == "needs" && (NotificationLanes.IsNeedsYou(n.Type) || NotificationCatalog.For(n.Type).Locked);
        if ((n.EmailPending || n.PushPending || n.SlackPending) && options.Value.HoldNotificationsInQuietHours && !QuietHours.NeverHeld(n.Type))
            n.DeliverAfter = await QuietUntilAsync(n.UserId, n.TenantId, ct);
        // Do not disturb (set in chat): nothing pops up on the screen, and e-mail and push wait until it ends. Security alerts still go out.
        if ((!QuietHours.NeverHeld(n.Type) || n.Type == NotificationType.Call) && !NotificationCatalog.For(n.Type).Locked && await DndUntilAsync(n.UserId, n.TenantId, ct) is { } dnd)
        {
            n.Browser = false;
            if ((n.EmailPending || n.PushPending || n.SlackPending) && (n.DeliverAfter is null || n.DeliverAfter < dnd)) n.DeliverAfter = dnd;
        }
        // Digest mode: an update (it asks nothing of the person) is not pushed, and its email waits for the daily digest, sent as one.
        if ((n.EmailPending || n.PushPending || n.SlackPending) && !NotificationLanes.IsNeedsYou(n.Type) && !QuietHours.NeverHeld(n.Type))
        {
            var (settings, zone) = await SettingsAsync(n.UserId, n.TenantId, ct);
            if (settings.DigestTime is { } digest)
            {
                n.PushPending = false;
                var at = QuietHours.NextAt(digest, zone, clock.Now);
                if (n.DeliverAfter is null || n.DeliverAfter < at) n.DeliverAfter = at;
            }
        }
        return c.Any;
    }

    private readonly Dictionary<(Guid, Guid), string> _slack = new();

    /// <summary>"off", "needs" or "all": whether this person gets notifications in Slack here (they linked Slack and chose so). Once per request.</summary>
    private async Task<string> SlackChoiceAsync(Guid userId, Guid tenantId, CancellationToken ct)
    {
        if (_slack.TryGetValue((userId, tenantId), out var known)) return known;
        var choice = await db.PersonalConnectionSettings.IgnoreQueryFilters().Where(s => s.UserId == userId && s.TenantId == tenantId).Select(s => s.SlackMessages).FirstOrDefaultAsync(ct) ?? "off";
        if (choice != "off" && !await db.SlackUserLinks.IgnoreQueryFilters().AnyAsync(l => l.UserId == userId && l.TenantId == tenantId, ct)) choice = "off";
        return _slack[(userId, tenantId)] = choice;
    }

    private readonly Dictionary<(Guid, Guid), DateTime?> _dnd = new();

    /// <summary>When the person's do-not-disturb ends, if it is on now (loaded once per person per request).</summary>
    private async Task<DateTime?> DndUntilAsync(Guid userId, Guid tenantId, CancellationToken ct)
    {
        if (!_dnd.TryGetValue((userId, tenantId), out var until))
        {
            until = await db.ChatUserStatuses.IgnoreQueryFilters().AsNoTracking().Where(s => s.UserId == userId && s.TenantId == tenantId).Select(s => s.DndUntil).FirstOrDefaultAsync(ct);
            _dnd[(userId, tenantId)] = until;
        }
        return until is { } u && u > clock.Now ? u : null;
    }

    /// <summary>The recipient's quiet hours and zone (their own zone, else the workspace's, else the platform default), loaded once per person.</summary>
    private async Task<DateTime?> QuietUntilAsync(Guid userId, Guid tenantId, CancellationToken ct)
    {
        var q = await SettingsAsync(userId, tenantId, ct);
        return QuietHours.Until(q.Settings, q.Zone, clock.Now);
    }

    private async Task<(ReminderSettings Settings, NodaTime.DateTimeZone Zone)> SettingsAsync(Guid userId, Guid tenantId, CancellationToken ct)
    {
        if (!_quiet.TryGetValue((userId, tenantId), out var q))
        {
            // Someone who never opened their schedule follows the workspace's quiet hours and digest, when it set them.
            var settings = await db.ReminderSettings.AsNoTracking().FirstOrDefaultAsync(s => s.UserId == userId, ct)
                ?? NotificationDefaultsCodec.Apply(new ReminderSettings { UserId = userId }, await WorkspaceAsync(tenantId, ct));
            var zone = await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.TimeZone).FirstOrDefaultAsync(ct);
            if (!ZoneTime.IsKnown(zone)) zone = await db.Tenants.IgnoreQueryFilters().AsNoTracking().Where(t => t.Id == tenantId).Select(t => t.TimeZone).FirstOrDefaultAsync(ct);
            q = (settings, ZoneTime.IsKnown(zone) ? ZoneTime.Find(zone) : clock.DefaultZone);
            _quiet[(userId, tenantId)] = q;
        }
        return q;
    }
}

/// <summary>What a notification can be about, for <see cref="NotificationService.MarkReadForTargetAsync"/>.</summary>
public static class NotificationTargets
{
    /// <summary>A direct or group chat (links /chat/{id}, /chat/{id}?thread=...).</summary>
    public const string Conversation = "conversation";
    /// <summary>A project's team chat (link /projects/{projectId}?chat=1): the target id is the project's.</summary>
    public const string ProjectChat = "project-chat";
    public const string WorkTask = "task", WorkItem = "work-item", Issue = "issue", Reminder = "reminder", Meeting = "meeting", Call = "call";
    public static readonly string[] All = [Conversation, ProjectChat, WorkTask, WorkItem, Issue, Reminder, Meeting, Call];
}

public class NotificationService(IAppDbContext db, ICurrentContext ctx, AppClock clock, NotificationRouter router, ProjectManagement.Application.Features.Integrations.WhatsAppDeliveryService whatsapp,
    ProjectManagement.Application.Features.Chat.IChatNotifier notifier, IServiceProvider services, ILogger<NotificationService> log)
{
    /// <summary>
    /// The one place that clears what someone has seen: every unread notification of <paramref name="userId"/> (only theirs, only in this
    /// workspace) about one thing - a conversation they read, a task they opened, a reminder they finished, a meeting they joined - is marked
    /// read and taken off the e-mail / push queues. Matched by the thing's id in the notification's link (every link carries it: /chat/{id},
    /// /projects/{p}?task={id}, /work?item={id}, /r/..., /calls/{id}) or its dedupe key. Saves, then tells the person's open tabs (the bell,
    /// badges and the centre refresh at once) and their devices (the OS notifications close). Returns how many were marked.
    /// </summary>
    /// <param name="tenantId">The workspace, when there is no signed-in context (a reminder's one-time link from a notification).</param>
    public async Task<int> MarkReadForTargetAsync(Guid userId, string targetType, Guid targetId, CancellationToken ct = default, Guid? tenantId = null)
    {
        if (userId == Guid.Empty || targetId == Guid.Empty) return 0;
        var tenant = tenantId ?? ctx.RequireTenantId();
        var id = targetId.ToString();
        var q = db.Notifications.IgnoreQueryFilters().Where(n => n.TenantId == tenant && n.UserId == userId && n.ReadAt == null);
        if (targetType == NotificationTargets.ProjectChat)
        {
            var link = $"/projects/{id}?chat=1";
            q = q.Where(n => n.Link == link);
        }
        else
        {
            var compact = targetId.ToString("N");   // dedupe keys carry ids without dashes ("rem:{id:N}:2"), links with them
            q = q.Where(n => (n.Link != null && n.Link.Contains(id)) || (n.DedupeKey != null && (n.DedupeKey.Contains(id) || n.DedupeKey.Contains(compact))));
        }
        var rows = await q.Take(500).ToListAsync(ct);
        var now = clock.Now;
        var shown = new List<Notification>();
        foreach (var n in rows)
        {
            if (n.Browser && !n.PushPending && (n.DeliverAfter == null || n.DeliverAfter <= now)) shown.Add(n);   // already on their devices
            n.ReadAt = now; n.EmailPending = false; n.PushPending = false; n.SlackPending = false;
        }
        await db.SaveChangesAsync(ct);
        if (rows.Count == 0) return 0;
        var ids = rows.Select(n => n.Id).ToList();
        var links = rows.Select(n => n.Link).Where(l => !string.IsNullOrEmpty(l)).Distinct().ToList();
        await notifier.ToUsersAsync(tenant, [userId], ProjectManagement.Application.Features.Chat.ChatEvents.Notification,
            new { read = ids, links, targetType, targetId }, ct);
        if (shown.Count > 0) await PushReadAsync(tenant, userId, shown.Select(n => n.Id.ToString()).ToList(), links, ct);
        return rows.Count;
    }

    /// <summary>
    /// The signed-in person opened / finished something: their own notifications about it are read. Never fails the request it rides on
    /// (opening a task still works if this does not).
    /// </summary>
    public async Task<int> MarkSeenAsync(string targetType, Guid targetId, CancellationToken ct = default)
    {
        if (ctx.UserId is not { } me || ctx.TenantId is null) return 0;
        try { return await MarkReadForTargetAsync(me, targetType, targetId, ct); }
        catch (Exception ex) when (ex is not OperationCanceledException) { log.LogDebug(ex, "Could not mark notifications about {Target} read", targetType); return 0; }
    }

    /// <summary>A silent "read" data push to the person's devices: their service worker closes those OS notifications and corrects the icon badge.</summary>
    private async Task PushReadAsync(Guid tenant, Guid userId, List<string> tags, List<string?> links, CancellationToken ct)
    {
        try
        {
            var subs = await db.PushSubscriptions.Where(s => s.UserId == userId && s.Failures < 20).ToListAsync(ct);
            if (subs.Count == 0) return;
            if (services.GetService(typeof(IWebPushSender)) is not IWebPushSender sender || services.GetService(typeof(ISecretProtector)) is not ISecretProtector protector) return;
            var push = (services.GetService(typeof(IOptions<PushOptions>)) as IOptions<PushOptions>)?.Value ?? new PushOptions();
            var app = (services.GetService(typeof(IOptions<AppOptions>)) as IOptions<AppOptions>)?.Value ?? new AppOptions();
            var keys = await PushService.KeysAsync(db, protector, PushService.SubjectOf(push, app), ct);
            var now = clock.Now;
            var badge = await db.Notifications.IgnoreQueryFilters().CountAsync(n => n.TenantId == tenant && n.UserId == userId && n.InApp && n.ReadAt == null && n.ArchivedAt == null && (n.SnoozedUntil == null || n.SnoozedUntil <= now), ct);
            var payload = System.Text.Json.JsonSerializer.Serialize(new { kind = "read", tags, links, badge });
            foreach (var s in subs)
            {
                try { await sender.SendAsync(s, payload, keys, new PushDelivery(3600, "low"), ct); }
                catch (Exception ex) when (ex is not OperationCanceledException) { log.LogDebug(ex, "Read push to a device failed"); }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException) { log.LogDebug(ex, "Could not push the read notice"); }
    }

    /// <summary>
    /// Queues a notification in the current unit of work (caller saves), honouring the recipient's channel preferences.
    /// People are not notified about their own actions unless <paramref name="toSelf"/> (security alerts).
    /// </summary>
    public async Task AddAsync(Guid userId, NotificationType type, string title, string? body = null, string? link = null,
        string? dedupeKey = null, bool toSelf = false, CancellationToken ct = default)
    {
        if (userId == ctx.UserId && !toSelf) return;
        var n = new Notification
        {
            TenantId = ctx.RequireTenantId(), UserId = userId, Type = type, Title = Text.Truncate(title, 200)!,
            Body = Text.Truncate(body, 500), Link = link, DedupeKey = dedupeKey, CreatedAt = clock.Now,
        };
        if (await router.ApplyAsync(n, ct) || await whatsapp.HasIntentAsync(n, ct)) db.Notifications.Add(n);
    }

    /// <summary>Whether this person wants this kind of notice in the bell (their own choice, or the default).</summary>
    public async Task<bool> WantsInAppAsync(Guid userId, NotificationType type, CancellationToken ct = default) => (await router.ChannelsAsync(userId, type, ct, ctx.TenantId)).InApp;

    /// <param name="lane">needs (asks something of you), info (tells you something), snoozed (waiting to come back), or empty for both lanes.</param>
    /// <param name="archived">The archive instead of the inbox.</param>
    /// <param name="category">messages, reminders, meetings or work (the Notification Centre's filters); empty for all.</param>
    public async Task<PagedResult<NotificationDto>> ListAsync(bool unreadOnly, int page, int pageSize, CancellationToken ct = default, string? lane = null, bool archived = false,
        string? category = null)
    {
        var uid = ctx.RequireUserId();
        var q = db.Notifications.AsNoTracking().Where(n => n.UserId == uid && n.InApp);
        q = archived ? q.Where(n => n.ArchivedAt != null) : q.Where(n => n.ArchivedAt == null);
        var now = clock.Now;
        var snoozed = string.Equals(lane, "snoozed", StringComparison.OrdinalIgnoreCase);
        if (!archived) q = snoozed ? q.Where(n => n.SnoozedUntil != null && n.SnoozedUntil > now) : q.Where(n => n.SnoozedUntil == null || n.SnoozedUntil <= now);
        var needs = NotificationLanes.NeedsYou;
        if (string.Equals(lane, "needs", StringComparison.OrdinalIgnoreCase)) q = q.Where(n => needs.Contains(n.Type));
        else if (string.Equals(lane, "info", StringComparison.OrdinalIgnoreCase)) q = q.Where(n => !needs.Contains(n.Type));
        if (unreadOnly) q = q.Where(n => n.ReadAt == null);
        q = NotificationCategories.Where(q, category);
        var p = new PageQuery(page, pageSize);
        var total = await q.CountAsync(ct);
        var ordered = snoozed ? q.OrderBy(n => n.SnoozedUntil) : q.OrderByDescending(n => n.SnoozedUntil ?? n.CreatedAt);
        var rows = await ordered.Skip((p.SafePage - 1) * p.SafeSize()).Take(p.SafeSize()).ToListAsync(ct);
        return new PagedResult<NotificationDto>(
            rows.Select(n => new NotificationDto(n.Id, n.Type, n.Title, ProjectManagement.Application.Features.Reminders.DueReminderRules.SplitReason(n.Body).Body, n.Link, n.ReadAt != null, n.CreatedAt, n.Browser, NotificationLanes.IsNeedsYou(n.Type), n.ArchivedAt != null,
                n.SnoozedUntil > now ? n.SnoozedUntil : null, n.SnoozedUntil is { } back && back <= now ? back : n.CreatedAt, null, NotificationCategories.Of(n.Type, n.Link), Reason: ProjectManagement.Application.Features.Reminders.DueReminderRules.SplitReason(n.Body).Reason)).ToList(),
            p.SafePage, p.SafeSize(), total);
    }

    public async Task<UnreadCountDto> UnreadCountAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var now = clock.Now;
        return new UnreadCountDto(await db.Notifications.CountAsync(n => n.UserId == uid && n.InApp && n.ReadAt == null && n.ArchivedAt == null && (n.SnoozedUntil == null || n.SnoozedUntil <= now), ct));
    }

    public async Task<NotificationCountsDto> CountsAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var now = clock.Now;
        var unread = db.Notifications.Where(n => n.UserId == uid && n.InApp && n.ReadAt == null && n.ArchivedAt == null && (n.SnoozedUntil == null || n.SnoozedUntil <= now));
        // One round trip for every badge: unread by kind (and whether a reminder points at a meeting), split up here.
        var groups = await unread
            .GroupBy(n => new { n.Type, Meet = n.Link != null && (n.Link.StartsWith(NotificationCategories.CallMeetingPrefix) || n.Link.StartsWith(NotificationCategories.MeetPrefix)) })
            .Select(g => new { g.Key.Type, g.Key.Meet, Count = g.Count() }).ToListAsync(ct);
        int total = 0, needing = 0, messages = 0, reminders = 0, meetings = 0, work = 0;
        foreach (var g in groups)
        {
            total += g.Count;
            if (NotificationLanes.IsNeedsYou(g.Type)) needing += g.Count;
            switch (NotificationCategories.Of(g.Type, g.Meet ? NotificationCategories.MeetPrefix : null))
            {
                case NotificationCategories.Messages: messages += g.Count; break;
                case NotificationCategories.Reminders: reminders += g.Count; break;
                case NotificationCategories.Meetings: meetings += g.Count; break;
                default: work += g.Count; break;
            }
        }
        var resting = await db.Notifications.CountAsync(n => n.UserId == uid && n.InApp && n.ArchivedAt == null && n.SnoozedUntil != null && n.SnoozedUntil > now, ct);
        return new NotificationCountsDto(total, needing, total - needing, resting, messages, reminders, meetings, work);
    }

    /// <summary>Back to unread (the blue dot), as if it had just arrived.</summary>
    public async Task MarkUnreadAsync(Guid id, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var n = await db.Notifications.FirstOrDefaultAsync(x => x.Id == id && x.UserId == uid, ct) ?? throw new NotFoundException("Notification not found.");
        n.ReadAt = null;
        n.ArchivedAt = null;
        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Clears notifications out of the Notification Centre: a stacked group (its ids), one category, or everything. Cleared ones are put away
    /// for this person only (read and archived, still findable under Archived until the data policy removes them); snoozed ones stay snoozed.
    /// </summary>
    public async Task<int> ClearAsync(NotificationClearRequest req, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var now = clock.Now;
        var q = db.Notifications.Where(x => x.UserId == uid && x.InApp && x.ArchivedAt == null && (x.SnoozedUntil == null || x.SnoozedUntil <= now));
        if (req.Ids is { Count: > 0 } ids)
        {
            if (ids.Count > 500) throw new ValidationException("ids", "Clear at most 500 at a time.");
            var list = ids.Distinct().ToList();
            q = q.Where(x => list.Contains(x.Id));
        }
        else if (!string.IsNullOrWhiteSpace(req.Category))
        {
            if (!NotificationCategories.All.Contains(req.Category.Trim().ToLowerInvariant())) throw new ValidationException("category", "Unknown category.");
            q = NotificationCategories.Where(q, req.Category);
        }
        var rows = await q.Take(5000).ToListAsync(ct);
        foreach (var n in rows) { n.ArchivedAt = now; n.ReadAt ??= now; }
        await db.SaveChangesAsync(ct);
        return rows.Count;
    }

    /// <summary>Puts a notification away (and marks it read), or brings it back to the inbox.</summary>
    public async Task SetArchivedAsync(Guid id, bool archived, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var n = await db.Notifications.FirstOrDefaultAsync(x => x.Id == id && x.UserId == uid, ct) ?? throw new NotFoundException("Notification not found.");
        n.ArchivedAt = archived ? n.ArchivedAt ?? clock.Now : null;
        if (archived) n.ReadAt ??= clock.Now;
        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Hides a notification until the given moment; then it is back on top of the inbox as unread and pushed to the person's devices again
    /// (if they get push for it). Null brings it back now.
    /// </summary>
    public async Task SnoozeAsync(Guid id, DateTime? until, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var n = await db.Notifications.FirstOrDefaultAsync(x => x.Id == id && x.UserId == uid, ct) ?? throw new NotFoundException("Notification not found.");
        var now = clock.Now;
        if (until is { } u && (u < now.AddMinutes(4) || u > now.AddDays(60))) throw new ValidationException("until", "Snooze for at least 5 minutes and at most 60 days.");
        n.SnoozedUntil = until;
        n.ReadAt = null;
        n.ArchivedAt = null;
        if (until is { } at && n.Browser) { n.DeliverAfter = at; n.PushPending = true; }
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Clears the inbox of everything already read.</summary>
    public async Task<int> ArchiveReadAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var now = clock.Now;
        var rows = await db.Notifications.Where(x => x.UserId == uid && x.InApp && x.ReadAt != null && x.ArchivedAt == null).Take(5000).ToListAsync(ct);
        foreach (var n in rows) n.ArchivedAt = now;
        await db.SaveChangesAsync(ct);
        return rows.Count;
    }

    public async Task MarkReadAsync(Guid id, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var n = await db.Notifications.FirstOrDefaultAsync(x => x.Id == id && x.UserId == uid, ct)
            ?? throw new NotFoundException("Notification not found.");
        n.ReadAt ??= clock.Now;
        await db.SaveChangesAsync(ct);
    }

    /// <param name="category">Only this Notification Centre category (messages, reminders, meetings, work); empty for all.</param>
    public async Task MarkAllReadAsync(CancellationToken ct = default, string? category = null)
    {
        var uid = ctx.RequireUserId();
        var now = clock.Now;
        var q = NotificationCategories.Where(db.Notifications.Where(x => x.UserId == uid && x.InApp && x.ReadAt == null), category);
        foreach (var n in await q.ToListAsync(ct)) n.ReadAt = now;
        await db.SaveChangesAsync(ct);
    }
}

/// <summary>A user's own choices: which kinds of notification reach them, and where (in the app, by e-mail, on the desktop).</summary>
public class NotificationPreferenceService(IAppDbContext db, ICurrentContext ctx, IEmailSender email, IOptions<AppOptions> options)
{
    public async Task<IReadOnlyList<NotificationPreferenceDto>> GetAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var mine = await db.NotificationPreferences.AsNoTracking().Where(p => p.UserId == uid).ToDictionaryAsync(p => p.Type, ct);
        var workspace = ctx.TenantId is { } tid
            ? await db.WorkspaceNotificationDefaults.AsNoTracking().Where(x => x.TenantId == tid).Select(x => x.Channels).FirstOrDefaultAsync(ct) : null;
        return NotificationCatalog.All.Select(k =>
        {
            if (mine.TryGetValue(k.Type, out var p))
                return new NotificationPreferenceDto(k.Type, k.Label, k.Description, k.Locked || p.InApp, k.Locked || p.Email, p.Browser, k.Locked, "you");
            var fromWorkspace = k.Locked ? null : NotificationDefaultsCodec.Find(workspace, k.Type);
            var c = fromWorkspace ?? new Channels(k.InApp, k.Email, k.Browser);
            return new NotificationPreferenceDto(k.Type, k.Label, k.Description, k.Locked || c.InApp, k.Locked || c.Email, c.Browser, k.Locked, fromWorkspace is null ? "default" : "workspace");
        }).ToList();
    }

    public async Task<IReadOnlyList<NotificationPreferenceDto>> SetAsync(SetPreferencesRequest req, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var existing = await db.NotificationPreferences.Where(p => p.UserId == uid).ToDictionaryAsync(p => p.Type, ct);
        foreach (var item in req.Items.GroupBy(i => i.Type).Select(g => g.Last()))
        {
            var locked = NotificationCatalog.For(item.Type).Locked;
            var (inApp, mail) = locked ? (true, true) : (item.InApp, item.Email);
            if (existing.TryGetValue(item.Type, out var row)) { row.InApp = inApp; row.Email = mail; row.Browser = item.Browser; }
            else db.NotificationPreferences.Add(new NotificationPreference { UserId = uid, Type = item.Type, InApp = inApp, Email = mail, Browser = item.Browser });
        }
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    /// <summary>Sends a message to the caller right now, so they can confirm delivery works. Reports the outcome instead of throwing.</summary>
    public async Task<TestEmailResultDto> SendTestEmailAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var user = await db.Users.AsNoTracking().FirstAsync(u => u.Id == uid, ct);
        var link = options.Value.WebBaseUrl.TrimEnd('/') + "/account";
        try
        {
            await email.SendAsync(new EmailMessage(user.Email, "Test notification",
                EmailTemplates.Wrap("Your notifications work", WebUtility.HtmlEncode($"Hi {user.DisplayName},"), "This is a test message from your project workspace.", "Open my account", link),
                $"This is a test message from your project workspace. {link}"), ct).WaitAsync(EmailSenderExtensions.DefaultSendTimeout, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new TestEmailResultDto(email.Name, false, $"The message could not be sent: {ex.Message}");
        }
        return email.Name == "log"
            ? new TestEmailResultDto("log", true, "Email is not connected to a mail server yet, so nothing was delivered. The message was written to the server log (see the README to set up SMTP).")
            : new TestEmailResultDto(email.Name, true, $"A test email was sent to {user.Email}.");
    }
}

/// <summary>
/// Background delivery of notification e-mails (spec section 62): the request that creates a notification never waits for the mail server,
/// and a failing server is retried a few times before the message is given up.
/// </summary>
public class NotificationEmailService(IAppDbContext db, IEmailSender email, IOptions<AppOptions> options, AppClock clock, ILogger<NotificationEmailService> log, EmailLinks? links = null)
{
    public const int MaxAttempts = 5;
    /// <summary>Chat messages are live in the app, so their e-mail only goes out when the notice is still unread after this many quiet minutes.</summary>
    public const int ChatEmailDelayMinutes = 5;

    /// <summary>Kinds that can wait a minute and be read together: three or more for the same person and workspace become one e-mail. Time-critical ones (reminders, overdue, service levels) never wait.</summary>
    private static readonly HashSet<NotificationType> Batchable = [NotificationType.TaskAssigned, NotificationType.Mention, NotificationType.Comment, NotificationType.Issue, NotificationType.Approval, NotificationType.ReportReady, NotificationType.TaskUpdated, NotificationType.ProjectUpdated, NotificationType.Message];
    private const int DigestFrom = 3;

    /// <summary>
    /// Where a notification's path lives for the person reading it: inside the workspace it is about (<c>/acme/projects/…</c>), so the link opens the
    /// right organization even when they last used another. The one-time reminder link (<c>/r/…</c>) works without signing in and stays as it is.
    /// </summary>
    public static string OrgLink(string? slug, string? path)
    {
        if (string.IsNullOrEmpty(path)) return string.IsNullOrEmpty(slug) ? "/" : $"/{slug}/";
        if (string.IsNullOrEmpty(slug) || path.StartsWith("/r/", StringComparison.Ordinal) || !path.StartsWith('/')) return path;
        return $"/{slug}{path}";
    }

    private static string WebNet(string s) => WebUtility.HtmlEncode(s);

    public async Task<int> SendPendingAsync(int batch = 50, CancellationToken ct = default)
    {
        var chatCutoff = clock.Now.AddMinutes(-ChatEmailDelayMinutes);
        var deliverableAt = clock.Now;   // held for quiet hours until then
        var rows = await db.Notifications.IgnoreQueryFilters()
            .Where(n => n.EmailPending && n.EmailAttempts < MaxAttempts && (n.Type != NotificationType.Message || n.CreatedAt <= chatCutoff)
                        && (n.DeliverAfter == null || n.DeliverAfter <= deliverableAt))
            .OrderBy(n => n.CreatedAt).Take(batch).ToListAsync(ct);
        if (rows.Count == 0) return 0;

        // A chat notice, or one held through quiet hours, that was read in the meantime has nothing left to say: no e-mail for it.
        foreach (var read in rows.Where(n => (n.Type == NotificationType.Message || n.DeliverAfter != null) && n.ReadAt != null)) read.EmailPending = false;
        rows.RemoveAll(n => !n.EmailPending);
        // Claim each one before sending it: with several servers running this, only the one whose update took it off the queue e-mails it.
        // (A failed send puts it back for another try, below.)
        var claimed = new List<Notification>(rows.Count);
        foreach (var n in rows)
        {
            var id = n.Id;
            var mine = await db.Notifications.IgnoreQueryFilters().Where(x => x.Id == id && x.EmailPending)
                .ExecuteUpdateAsync(u => u.SetProperty(x => x.EmailPending, false), ct) == 1;
            var entry = db.Notifications.Entry(n);
            if (!mine) { entry.State = EntityState.Detached; continue; }
            entry.Property(x => x.EmailPending).OriginalValue = false;   // the row now says false; a retry below writes true again
            n.EmailPending = false;
            claimed.Add(n);
        }
        rows = claimed;
        if (rows.Count == 0) { await db.SaveChangesAsync(ct); return 0; }

        var userIds = rows.Select(n => n.UserId).Distinct().ToList();
        var users = await db.Users.Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, ct);
        var tenantIds = rows.Select(n => n.TenantId).Distinct().ToList();
        var tenants = await db.Tenants.IgnoreQueryFilters().Where(t => tenantIds.Contains(t.Id)).ToDictionaryAsync(t => t.Id, t => new { t.Name, t.Slug }, ct);
        var baseUrl = options.Value.WebBaseUrl.TrimEnd('/');
        var sent = 0;

        // Several updates for one person in one workspace, none of them urgent, go out as a single message.
        var handled = new HashSet<Guid>();
        foreach (var group in rows.Where(n => Batchable.Contains(n.Type) && users.TryGetValue(n.UserId, out var u) && u.IsActive && u.EmailVerified).GroupBy(n => (n.UserId, n.TenantId)).Where(g => g.Count() >= DigestFrom))
        {
            var user = users[group.Key.UserId];
            var slug = tenants.GetValueOrDefault(group.Key.TenantId)?.Slug; var workspace = tenants.GetValueOrDefault(group.Key.TenantId)?.Name;
            var list = group.OrderBy(n => n.CreatedAt).ToList();
            var items = list.Select(n => (n.Title, n.Body, baseUrl + OrgLink(slug, n.Link))).ToList();
                        var title = $"{list.Count} updates{(workspace is null ? "" : " in " + workspace)}";
            try
            {
                await email.SendAsync(new EmailMessage(user.Email, title,
                    EmailTemplates.Digest(title, WebNet($"Hi {user.DisplayName},"), items, "Open in the app", baseUrl + OrgLink(slug, "/"),
                        "You get this email because of your notification settings. Change them under Notification Center → Preferences.", string.Join(" · ", list.Select(n => n.Title).Take(3)), links?.PageUrl(links.Token(user.Id, list[0].Type))),
                    string.Join("\n", list.Select(n => $"- {n.Title}")) + "\n" + baseUrl + OrgLink(slug, "/"), Headers: links?.Headers(user.Id, list[0].Type)), ct).WaitAsync(EmailSenderExtensions.DefaultSendTimeout, ct);
                foreach (var n in list) { n.EmailPending = false; n.EmailedAt = clock.Now; handled.Add(n.Id); }
                sent++;
                AppTelemetry.Count(AppTelemetry.Emails, "sent");
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                foreach (var n in list) { n.EmailAttempts++; n.EmailPending = n.EmailAttempts < MaxAttempts; handled.Add(n.Id); }
                AppTelemetry.Count(AppTelemetry.Emails, "failed");
                log.LogWarning(ex, "Could not e-mail a digest of {Count} notifications", list.Count);
            }
        }

        foreach (var n in rows.Where(n => !handled.Contains(n.Id)))
        {
            if (!users.TryGetValue(n.UserId, out var user) || !user.IsActive || !user.EmailVerified) { n.EmailPending = false; continue; }
            var workspace = tenants.GetValueOrDefault(n.TenantId)?.Name;
            var link = baseUrl + OrgLink(tenants.GetValueOrDefault(n.TenantId)?.Slug, n.Link);
            var body = string.IsNullOrWhiteSpace(n.Body) ? n.Title : n.Body!;
            var headers = links?.Headers(n.UserId, n.Type);
            try
            {
                await email.SendAsync(new EmailMessage(user.Email, workspace is null ? n.Title : $"{n.Title} · {workspace}",
                    EmailTemplates.Wrap(n.Title, WebNet($"Hi {user.DisplayName},"), body, n.Link?.StartsWith("/r/", StringComparison.Ordinal) == true ? "Done, snooze or open" : "Open in the app", link,
                        "You get this email because of your notification settings. Change them under Notification Center → Preferences.", body.Length > 90 ? body[..90] : body, headers is null ? null : links!.PageUrl(links.Token(n.UserId, n.Type)),
                        n.Link?.StartsWith("/r/", StringComparison.Ordinal) == true ? EmailKind.Reminder : n.Type == NotificationType.Subscription ? EmailKind.Billing : EmailKind.Update),
                    $"{n.Title}\n{body}\n{link}", Headers: headers), ct).WaitAsync(EmailSenderExtensions.DefaultSendTimeout, ct);
                n.EmailPending = false;
                n.EmailedAt = clock.Now;
                sent++;
                AppTelemetry.Count(AppTelemetry.Emails, "sent");
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                n.EmailAttempts++;
                AppTelemetry.Count(AppTelemetry.Emails, "failed");
                n.EmailPending = n.EmailAttempts < MaxAttempts; // try again later, or give up; the in-app notification is unaffected
                log.LogWarning(ex, "Could not e-mail notification {Id} (attempt {Attempt}/{Max})", n.Id, n.EmailAttempts, MaxAttempts);
            }
        }
        await db.SaveChangesAsync(ct);
        return sent;
    }
}
