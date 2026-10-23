using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Integrations;

public class WebhookOptions
{
    public const string Section = "Webhooks";
    public bool WorkerEnabled { get; set; } = true;
    public int IntervalSeconds { get; set; } = 5;
    /// <summary>Development and tests only: allow plain http and addresses on private networks (normally refused so a webhook cannot probe the server's own network).</summary>
    public bool AllowPrivateTargets { get; set; }
    /// <summary>How long new activity waits before it is turned into deliveries, so events that are still being saved are not missed.</summary>
    public double SettleSeconds { get; set; } = 2;
}

public record WebhookSendResult(int? Status, string? Error, string? Snippet);

/// <summary>Sends one signed request. The real implementation refuses private addresses and redirects.</summary>
public interface IWebhookTransport
{
    Task<WebhookSendResult> SendAsync(string url, IReadOnlyDictionary<string, string> headers, string body, CancellationToken ct);
}

/// <summary>What a webhook may be told about, in groups so a receiver can subscribe with "task.*".</summary>
public static class WebhookEvents
{
    public static readonly string[] All =
    [
        "task.created", "task.updated", "task.status_changed", "task.assigned", "task.priority_changed", "task.due_changed", "task.commented", "task.deleted",
        "task.dependency_added", "task.dependency_removed", "task.time_logged", "task.checklist_completed", "task.fields_changed", "task.imported",
        "project.created", "project.updated", "project.status_changed", "project.due_changed", "project.member_added", "project.deleted",
        "milestone.created", "milestone.status_changed", "milestone.deleted",
        "sprint.created", "sprint.started", "sprint.completed", "sprint.deleted",
        "attachment.added", "attachment.deleted", "member.invited", "member.role_changed", "team.created", "team.deleted",
        "worktask.created", "worktask.updated", "worktask.status", "worktask.comment", "worktask.deleted",
        "timesheet.submitted", "timesheet.approved", "timesheet.rejected",
        "document.created", "document.updated", "document.submitted", "document.approved", "document.changes_requested", "document.published",
        "document.comment_added", "document.moved", "document.restored", "document.deleted",
        "issue.reported", "issue.updated", "issue.assigned", "issue.status", "issue.deleted",
        "actionitem.created", "actionitem.updated", "actionitem.status", "actionitem.deleted",
        "meeting.scheduled", "meeting.rescheduled", "meeting.cancelled",
        "reminder.fired", "reminder.completed",
        "whatsapp.chat_started", "whatsapp.handed_over", "whatsapp.ticket_created", "whatsapp.rated",
        Audit,
    ];

    /// <summary>Never sent, whatever a webhook asks for: they say a secret or personal data was looked at (the audit stream carries them).</summary>
    public static bool IsSensitive(string action) => action.Contains("secret", StringComparison.Ordinal) || action.Contains("pii", StringComparison.Ordinal)
        || action.StartsWith("document.access", StringComparison.Ordinal);

    /// <summary>What each group is about, for the event explorer.</summary>
    public static readonly IReadOnlyDictionary<string, string> Groups = new Dictionary<string, string>
    {
        ["task"] = "Project tasks", ["project"] = "Projects", ["milestone"] = "Milestones", ["sprint"] = "Sprints", ["attachment"] = "Files",
        ["member"] = "People", ["team"] = "Teams", ["worktask"] = "Operations tickets", ["timesheet"] = "Timesheets", ["document"] = "DocTracker pages",
        ["issue"] = "Issues", ["actionitem"] = "Action items", ["meeting"] = "Meetings", ["reminder"] = "Reminders about work",
        ["whatsapp"] = "WhatsApp chats", ["audit"] = "Audit log (for a SIEM)",
    };

    private static readonly Dictionary<string, (string Entity, string Summary, string? Old, string? New)> SampleText = new()
    {
        ["task.created"] = ("Task", "Created PAY-12 \u201cFix refund rounding\u201d", null, null),
        ["task.status_changed"] = ("Task", "PAY-12: status In Progress \u2192 Done", "In Progress", "Done"),
        ["task.assigned"] = ("Task", "PAY-12 assigned to Ravi Kumar", null, "Ravi Kumar"),
        ["task.priority_changed"] = ("Task", "PAY-12: priority Medium \u2192 High", "Medium", "High"),
        ["task.due_changed"] = ("Task", "PAY-12: due 12 Nov \u2192 15 Nov", "2026-11-12", "2026-11-15"),
        ["task.commented"] = ("Task", "Asha commented on PAY-12", null, null),
        ["project.status_changed"] = ("Project", "Refunds: Active \u2192 On hold", "Active", "OnHold"),
        ["worktask.created"] = ("WorkTask", "Created WT-48 \u201cCore banking EOD job failed\u201d", null, null),
        ["worktask.status"] = ("WorkTask", "WT-48: In progress \u2192 Completed", "InProgress", "Completed"),
        ["document.published"] = ("Document", "Published DOC-7 version 2.0", null, "2.0"),
        ["document.approved"] = ("Document", "Approved DOC-7 \u201cRefund policy\u201d", null, null),
        ["issue.reported"] = ("Issue", "Reported issue PAY-I3 \u201cWrong EMI on statement\u201d in UAT", null, "Observed"),
        ["issue.status"] = ("Issue", "Issue PAY-I3: Observed \u2192 Fixed", "Observed", "Fixed"),
        ["meeting.scheduled"] = ("Meeting", "Scheduled \u201cRefunds stand-up\u201d for 24 Oct 10:00", null, null),
        ["actionitem.created"] = ("ActionItem", "Created AI-9 \u201cShare the UAT sign-off\u201d", null, null),
    };

    /// <summary>A realistic example of an event's data (the same shape a real delivery has), for the explorer and "send me a test of this event".</summary>
    public static object Sample(string eventType)
    {
        var group = eventType.Split('.')[0];
        if (eventType == Audit)
            return new { action = "member.role_changed", entityType = "TenantMember", entityId = Guid.Empty, ipAddress = "203.0.113.7", userAgent = "Mozilla/5.0",
                user = new { id = Guid.Empty, name = "Asha Rao", email = "asha@example.com" }, oldValue = "{\"role\":\"Member\"}", newValue = "{\"role\":\"Admin\"}" };
        if (group == "reminder")
            return new { reminderId = Guid.Empty, title = "PAY-12 is due tomorrow", source = "DueDate", user = new { id = Guid.Empty, name = "Ravi Kumar" },
                target = new { type = "Task", id = Guid.Empty, key = "PAY-12", title = "Fix refund rounding", link = "/projects/…?task=…" }, projectId = Guid.Empty };
        if (group == "whatsapp")
            return eventType switch
            {
                "whatsapp.rated" => new { conversationId = Guid.Empty, channel = "Support", contactName = "Kavya", rating = 5 },
                "whatsapp.handed_over" => new { conversationId = Guid.Empty, channel = "Support", contactName = "Kavya", reason = "unsure" },
                "whatsapp.ticket_created" => new { conversationId = Guid.Empty, channel = "Support", contactName = "Kavya", ticket = new { id = Guid.Empty, key = "WT-48" } },
                _ => (object)new { conversationId = Guid.Empty, channel = "Support", contactName = "Kavya", language = "te" },
            };
        var entity = group switch
        {
            "task" => "Task", "project" => "Project", "milestone" => "Milestone", "sprint" => "Sprint", "attachment" => "Attachment", "member" => "TenantMember",
            "team" => "Team", "worktask" => "WorkTask", "timesheet" => "Timesheet", "document" => "Document", "issue" => "Issue", "actionitem" => "ActionItem",
            "meeting" => "Meeting", _ => "Item",
        };
        (string Entity, string Summary, string? Old, string? New) text = SampleText.TryGetValue(eventType, out var t) ? t
            : (entity, $"{char.ToUpperInvariant(eventType[0])}{eventType[1..].Replace('.', ' ').Replace('_', ' ')} (example)", null, null);
        return new { summary = text.Summary, entity = new { type = text.Entity, id = Guid.Empty }, projectId = (Guid?)Guid.Empty,
            actor = new { id = Guid.Empty, name = "Asha Rao" }, oldValue = text.Old, newValue = text.New };
    }

    /// <summary>Every audit record (sign-ins, permission and security changes...), for a SIEM. Only sent to webhooks that name it - "*" does not include it.</summary>
    public const string Audit = "audit.logged";

    public static bool IsValidPattern(string p) => p == "*" || All.Contains(p) || (p.EndsWith(".*") && All.Any(e => e.StartsWith(p[..^1])));
    public static bool Matches(string patterns, string action) => !IsSensitive(action) &&
        patterns.Split(',', StringSplitOptions.RemoveEmptyEntries).Any(p => (p == "*" && !action.StartsWith("audit.")) || p == action || (p.EndsWith(".*") && action.StartsWith(p[..^1])));
    public static bool WantsAudit(string patterns) => Matches(patterns, Audit);
}

/// <summary>Which addresses a webhook may point at. Anything that reaches the server's own or an internal network is refused (SSRF).</summary>
public static class WebhookUrlRules
{
    public static bool IsBlocked(IPAddress ip)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (IPAddress.IsLoopback(ip) || ip.Equals(IPAddress.Any) || ip.Equals(IPAddress.IPv6Any) || ip.Equals(IPAddress.None)) return true;
        if (ip.AddressFamily == AddressFamily.InterNetworkV6)
        {
            if (ip.IsIPv6LinkLocal || ip.IsIPv6SiteLocal || ip.IsIPv6Multicast) return true;
            var b6 = ip.GetAddressBytes();
            if ((b6[0] & 0xFE) == 0xFC) return true; // fc00::/7 unique local
            if (b6[0] == 0x20 && b6[1] == 0x02) return true; // 2002::/16 6to4: embeds an IPv4 address that may be internal
            // 64:ff9b::/96 NAT64: translated to the IPv4 address in its last four bytes, which may be internal
            return b6[0] == 0x00 && b6[1] == 0x64 && b6[2] == 0xFF && b6[3] == 0x9B && b6.Skip(4).Take(8).All(x => x == 0);
        }
        var b = ip.GetAddressBytes();
        return b[0] == 10 || b[0] == 0 || b[0] >= 224
            || (b[0] == 172 && b[1] is >= 16 and <= 31)
            || (b[0] == 192 && b[1] == 168)
            || (b[0] == 169 && b[1] == 254)            // link-local, includes cloud metadata services
            || (b[0] == 100 && b[1] is >= 64 and <= 127)  // carrier-grade NAT
            || (b[0] == 198 && b[1] is 18 or 19);         // 198.18.0.0/15 benchmarking, used for internal networks
    }

    /// <summary>Returns the reason a URL cannot be used, or null when it is fine.</summary>
    public static async Task<string?> CheckAsync(string? url, bool allowPrivate, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(url) || url.Length > 500 || !Uri.TryCreate(url.Trim(), UriKind.Absolute, out var uri)) return "Enter a full web address, such as https://example.com/hooks.";
        if (uri.Scheme != Uri.UriSchemeHttps && !(allowPrivate && uri.Scheme == Uri.UriSchemeHttp)) return "Webhook addresses must start with https://.";
        if (!string.IsNullOrEmpty(uri.UserInfo)) return "Do not put a user name or password in the address.";
        if (allowPrivate) return null;
        try
        {
            var addresses = IPAddress.TryParse(uri.Host, out var literal) ? [literal] : await Dns.GetHostAddressesAsync(uri.Host, ct);
            if (addresses.Length == 0) return "That address could not be found.";
            if (addresses.Any(IsBlocked)) return "That address points to a private or internal network, which webhooks cannot use.";
        }
        catch (SocketException) { return "That address could not be found."; }
        return null;
    }
}

/// <summary>
/// Outgoing filters: only some projects, priorities, or status changes to some statuses. A filter that does not apply to an event (a project
/// event has no priority) lets it through; an event about something deleted since lets it through too.
/// </summary>
public static class WebhookFilters
{
    public record Facts(Guid? ProjectId, Priority? Priority);

    public static IReadOnlyList<string> List(string? s) => (s ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    public static bool Any(Webhook h) => !string.IsNullOrWhiteSpace(h.FilterProjects) || !string.IsNullOrWhiteSpace(h.FilterPriorities) || !string.IsNullOrWhiteSpace(h.FilterStatuses);
    public static bool IsStatusChange(string action) => action.EndsWith(".status_changed", StringComparison.Ordinal) || action.EndsWith(".status", StringComparison.Ordinal);

    private static string Norm(string s) => new string(s.Where(char.IsLetterOrDigit).ToArray()).ToLowerInvariant();
    /// <summary>"Done" also matches Completed, Resolved and Fixed; otherwise names are compared without spaces or case.</summary>
    public static bool StatusMatches(string wanted, string? actual)
    {
        if (string.IsNullOrWhiteSpace(actual)) return false;
        var w = Norm(wanted); var a = Norm(actual);
        if (w == a) return true;
        string[] done = ["done", "completed", "complete", "resolved", "fixed", "closed"];
        return done.Contains(w) && done.Contains(a);
    }

    public static bool Passes(Webhook h, string action, string? newValue, Facts facts)
    {
        var projects = List(h.FilterProjects);
        if (projects.Count > 0 && facts.ProjectId is { } pid && !projects.Contains(pid.ToString(), StringComparer.OrdinalIgnoreCase)) return false;
        if (projects.Count > 0 && facts.ProjectId is null && !action.StartsWith("member.") && !action.StartsWith("team.") && !action.StartsWith("audit.")) return false;
        var priorities = List(h.FilterPriorities);
        if (priorities.Count > 0 && facts.Priority is { } pr && !priorities.Contains(pr.ToString(), StringComparer.OrdinalIgnoreCase)) return false;
        var statuses = List(h.FilterStatuses);
        if (statuses.Count > 0 && IsStatusChange(action) && !statuses.Any(st => StatusMatches(st, newValue))) return false;
        return true;
    }
}

/// <summary>
/// Events that are not activity records (a reminder going off, a WhatsApp chat starting): queued straight to the matching webhooks of one
/// workspace, filtered by project. The caller saves.
/// </summary>
public sealed class WebhookOutbox(IAppDbContext db)
{
    private readonly Dictionary<Guid, List<Webhook>> _hooks = new();

    public async Task EmitAsync(Guid tenantId, string eventType, DateTime now, object data, Guid? projectId, CancellationToken ct)
    {
        if (!_hooks.TryGetValue(tenantId, out var hooks))
            _hooks[tenantId] = hooks = await db.Webhooks.IgnoreQueryFilters().Where(w => w.TenantId == tenantId && w.IsActive).ToListAsync(ct);
        foreach (var h in hooks.Where(h => WebhookEvents.Matches(h.Events, eventType) && WebhookFilters.Passes(h, eventType, null, new WebhookFilters.Facts(projectId, null))))
            db.WebhookDeliveries.Add(WebhookProcessor.NewDelivery(h, null, eventType, now, data));
    }
}

/// <summary>The reminder events: only reminders about work (a task, an issue, a ticket…) and escalations, never someone's private notes.</summary>
public static class ReminderWebhook
{
    public static bool IsAboutWork(Reminder r) => r.TargetType is not (ReminderTarget.None or ReminderTarget.ChatMessage) || r.Source == ReminderSource.Escalation;
    public static object Data(Reminder r, string? userName) => new
    {
        reminderId = r.SeriesId ?? r.Id, title = r.Title, source = r.Source.ToString(), user = new { id = r.UserId, name = userName },
        target = r.TargetId is null ? null : new { type = r.TargetType.ToString(), id = r.TargetId, key = r.TargetKey, title = r.TargetTitle, link = r.Link },
        projectId = r.TargetProjectId,
    };
}

public record WebhookHealthSummary(int Total, int Succeeded, int Failed, decimal? SuccessRate, int? AverageMs);
public record WebhookDto(Guid Id, string Name, string Url, IReadOnlyList<string> Events, bool IsActive, string? DisabledReason, DateTime CreatedAt,
    DateTime? LastDeliveryAt, string? LastStatus, int ConsecutiveFailures, WebhookFormat Format = WebhookFormat.Json,
    IReadOnlyList<Guid>? FilterProjects = null, IReadOnlyList<string>? FilterPriorities = null, IReadOnlyList<string>? FilterStatuses = null,
    WebhookHealthSummary? Health = null, int DisableAfter = 10);
public record CreatedWebhookDto(WebhookDto Webhook, string Secret);
/// <summary><see cref="Format"/>: Json (signed, for your own systems), Slack or Teams (a message for a channel's incoming webhook). Filters: null keeps them, an empty list clears.</summary>
public record UpsertWebhookRequest(string Name, string Url, IReadOnlyList<string>? Events, bool? IsActive, WebhookFormat? Format = null,
    IReadOnlyList<Guid>? FilterProjects = null, IReadOnlyList<string>? FilterPriorities = null, IReadOnlyList<string>? FilterStatuses = null);
public record WebhookDeliveryDto(Guid Id, string EventType, WebhookDeliveryStatus Status, int Attempts, int? ResponseStatus, string? Error, DateTime CreatedAt, DateTime? DeliveredAt, DateTime? NextAttemptAt,
    int? DurationMs = null, Guid? ReplayOf = null);
public record WebhookDeliveryDetailDto(WebhookDeliveryDto Delivery, string Payload, string? ResponseSnippet);
public record WebhookDeliveryPageDto(IReadOnlyList<WebhookDeliveryDto> Items, int Total, int Page, int PageSize);
public record WebhookEventInfo(string Event, string Group, string GroupLabel, object Sample);
public record WebhookReplayRequest(DateTime? From, DateTime? To, bool OnlyFailed = true, string? Event = null);
public record WebhookTestRequest(string? Event);
public record WebhookHealthDay(DateOnly Day, int Total, int Failed, int? AverageMs);
public record WebhookHealthDto(int Days, int Total, int Succeeded, int Failed, int Pending, decimal? SuccessRate, int? AverageMs, int? P95Ms,
    IReadOnlyList<WebhookHealthDay> Series, string? LastError, DateTime? LastFailureAt, int ConsecutiveFailures, int WarnAfter, int DisableAfter, bool Warned);

/// <summary>Managing a workspace's webhooks. Owners and admins only, on plans with API access.</summary>
public class WebhookService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, EntitlementService entitlements,
    ISecretProtector protector, Microsoft.Extensions.Options.IOptions<WebhookOptions> options)
{
    private const int MaxWebhooks = 10;

    private void RequireAdmin()
    {
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only owners and admins can manage webhooks.", "PERMISSION_DENIED");
    }

    public static WebhookDto ToDto(Webhook w, WebhookHealthSummary? health = null) => new(w.Id, w.Name, w.Url, w.Events.Split(',', StringSplitOptions.RemoveEmptyEntries), w.IsActive, w.DisabledReason,
        w.CreatedAt, w.LastDeliveryAt, w.LastStatus, w.ConsecutiveFailures, w.Format,
        WebhookFilters.List(w.FilterProjects).Select(x => Guid.TryParse(x, out var g) ? g : Guid.Empty).Where(g => g != Guid.Empty).ToList(),
        WebhookFilters.List(w.FilterPriorities), WebhookFilters.List(w.FilterStatuses), health, WebhookProcessor.DisableAfterFailures);

    public static string NewSecret() => "whsec_" + Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public IReadOnlyList<string> Catalogue() => WebhookEvents.All;

    /// <summary>The event explorer: every event with its group and a sample of its data.</summary>
    public IReadOnlyList<WebhookEventInfo> Explorer() => WebhookEvents.All.Select(e =>
    {
        var g = e.Split('.')[0];
        return new WebhookEventInfo(e, g, WebhookEvents.Groups.GetValueOrDefault(g, g), WebhookEvents.Sample(e));
    }).ToList();

    public async Task<IReadOnlyList<WebhookDto>> ListAsync(CancellationToken ct = default)
    {
        RequireAdmin();
        var hooks = await db.Webhooks.AsNoTracking().OrderBy(w => w.CreatedAt).ToListAsync(ct);
        var since = clock.Now.AddDays(-7);
        var ids = hooks.Select(h => h.Id).ToList();
        var stats = (await db.WebhookDeliveries.AsNoTracking().Where(d => ids.Contains(d.WebhookId) && d.CreatedAt >= since && d.Status != WebhookDeliveryStatus.Pending)
                .Select(d => new { d.WebhookId, d.Status, d.DurationMs }).ToListAsync(ct))
            .GroupBy(d => d.WebhookId).ToDictionary(g => g.Key, g =>
            {
                var ok = g.Count(x => x.Status == WebhookDeliveryStatus.Succeeded); var total = g.Count();
                var times = g.Where(x => x.DurationMs is not null).Select(x => x.DurationMs!.Value).ToList();
                return new WebhookHealthSummary(total, ok, total - ok, total == 0 ? null : Math.Round(ok * 100m / total, 1), times.Count == 0 ? null : (int)times.Average());
            });
        return hooks.Select(h => ToDto(h, stats.GetValueOrDefault(h.Id) ?? new WebhookHealthSummary(0, 0, 0, null, null))).ToList();
    }

    private async Task ApplyFiltersAsync(Webhook hook, UpsertWebhookRequest req, CancellationToken ct)
    {
        if (req.FilterProjects is { } projects)
        {
            var wanted = projects.Distinct().Take(50).ToList();
            var found = await db.Projects.AsNoTracking().Where(p => wanted.Contains(p.Id)).Select(p => p.Id).ToListAsync(ct);
            if (found.Count != wanted.Count) throw new ValidationException("filterProjects", "One of the projects was not found.");
            hook.FilterProjects = wanted.Count == 0 ? null : string.Join(',', wanted);
        }
        if (req.FilterPriorities is { } priorities)
        {
            var clean = priorities.Select(p => (p ?? "").Trim()).Where(p => p.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            if (clean.Any(p => !Enum.TryParse<Priority>(p, true, out _))) throw new ValidationException("filterPriorities", "Priorities are Low, Medium, High and Critical.");
            hook.FilterPriorities = clean.Count == 0 ? null : string.Join(',', clean.Select(p => Enum.Parse<Priority>(p, true).ToString()));
        }
        if (req.FilterStatuses is { } statuses)
        {
            var clean = statuses.Select(p => (p ?? "").Trim().Replace(",", " ")).Where(p => p.Length is > 0 and <= 40).Distinct(StringComparer.OrdinalIgnoreCase).Take(10).ToList();
            hook.FilterStatuses = clean.Count == 0 ? null : string.Join(',', clean);
        }
    }

    private async Task<(string Name, string Url, string Events)> CleanAsync(UpsertWebhookRequest req, CancellationToken ct)
    {
        var name = (req.Name ?? "").Trim();
        if (name.Length is < 1 or > 60) throw new ValidationException("name", "Give the webhook a name (up to 60 characters).");
        if (await WebhookUrlRules.CheckAsync(req.Url, options.Value.AllowPrivateTargets, ct) is { } problem) throw new ValidationException("url", problem);
        var events = (req.Events is { Count: > 0 } ? req.Events : ["*"]).Select(e => (e ?? "").Trim()).Where(e => e.Length > 0).Distinct().ToList();
        var bad = events.FirstOrDefault(e => !WebhookEvents.IsValidPattern(e));
        if (bad is not null) throw new ValidationException("events", $"“{bad}” is not an event this system sends.");
        var joined = string.Join(',', events);
        // Streaming the audit log is part of the audit log feature.
        if (WebhookEvents.WantsAudit(joined) && await entitlements.GetValueAsync(FeatureKeys.AuditLog, ct) <= 0)
            throw new ValidationException("events", "Streaming the audit log needs a plan with the audit log.");
        if (req.Format is { } f && !Enum.IsDefined(f)) throw new ValidationException("format", "Choose JSON, Slack or Teams.");
        return (name, req.Url!.Trim(), joined);
    }

    public async Task<CreatedWebhookDto> CreateAsync(UpsertWebhookRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        await entitlements.EnsureFeatureAsync(FeatureKeys.ApiAccess, ct);
        var (name, url, events) = await CleanAsync(req, ct);
        if (await db.Webhooks.CountAsync(ct) >= MaxWebhooks) throw new ConflictException($"A workspace can have at most {MaxWebhooks} webhooks.", "LIMIT_REACHED");

        var secret = NewSecret();
        var hook = new Webhook
        {
            TenantId = ctx.RequireTenantId(), Name = name, Url = url, Events = events, SecretProtected = protector.Protect(secret),
            CursorAt = clock.Now, AuditCursorAt = clock.Now, CreatedAt = clock.Now, CreatedBy = ctx.RequireUserId(), Format = req.Format ?? WebhookFormat.Json,
        };
        await ApplyFiltersAsync(hook, req, ct);
        db.Webhooks.Add(hook);
        recorder.Audit("webhook.created", "Webhook", hook.Id, newValue: new { hook.Name, hook.Url, hook.Events });
        await db.SaveChangesAsync(ct);
        return new CreatedWebhookDto(ToDto(hook), secret);
    }

    public async Task<WebhookDto> UpdateAsync(Guid id, UpsertWebhookRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        var hook = await db.Webhooks.FirstOrDefaultAsync(w => w.Id == id, ct) ?? throw new NotFoundException("Webhook not found.");
        var (name, url, events) = await CleanAsync(req, ct);
        // Newly asking for the audit stream starts it from now, not from the beginning of the log.
        if (WebhookEvents.WantsAudit(events) && !WebhookEvents.WantsAudit(hook.Events)) hook.AuditCursorAt = clock.Now;
        hook.Name = name; hook.Url = url; hook.Events = events; hook.UpdatedAt = clock.Now;
        if (req.Format is { } format) hook.Format = format;
        await ApplyFiltersAsync(hook, req, ct);
        if (req.IsActive is { } active && active != hook.IsActive)
        {
            if (active) await entitlements.EnsureFeatureAsync(FeatureKeys.ApiAccess, ct);
            hook.IsActive = active; hook.DisabledReason = active ? null : "Turned off by an administrator.";
            if (active) { hook.ConsecutiveFailures = 0; hook.CursorAt = clock.Now; hook.AuditCursorAt = clock.Now; } // do not flood it with what happened while it was off
        }
        recorder.Audit("webhook.updated", "Webhook", id, newValue: new { hook.Name, hook.Url, hook.Events, hook.IsActive, hook.Format, hook.FilterProjects, hook.FilterPriorities, hook.FilterStatuses });
        await db.SaveChangesAsync(ct);
        return ToDto(hook);
    }

    public async Task<CreatedWebhookDto> RotateSecretAsync(Guid id, CancellationToken ct = default)
    {
        RequireAdmin();
        var hook = await db.Webhooks.FirstOrDefaultAsync(w => w.Id == id, ct) ?? throw new NotFoundException("Webhook not found.");
        var secret = NewSecret();
        hook.SecretProtected = protector.Protect(secret); hook.UpdatedAt = clock.Now;
        recorder.Audit("webhook.secret_rotated", "Webhook", id);
        await db.SaveChangesAsync(ct);
        return new CreatedWebhookDto(ToDto(hook), secret);
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        RequireAdmin();
        var hook = await db.Webhooks.FirstOrDefaultAsync(w => w.Id == id, ct) ?? throw new NotFoundException("Webhook not found.");
        db.WebhookDeliveries.RemoveRange(await db.WebhookDeliveries.Where(d => d.WebhookId == id).ToListAsync(ct));
        db.Webhooks.Remove(hook);
        recorder.Audit("webhook.deleted", "Webhook", id, oldValue: new { hook.Name, hook.Url });
        await db.SaveChangesAsync(ct);
    }

    public async Task<IReadOnlyList<WebhookDeliveryDto>> DeliveriesAsync(Guid id, CancellationToken ct = default)
    {
        RequireAdmin();
        if (!await db.Webhooks.AnyAsync(w => w.Id == id, ct)) throw new NotFoundException("Webhook not found.");
        return (await db.WebhookDeliveries.AsNoTracking().Where(d => d.WebhookId == id).OrderByDescending(d => d.CreatedAt).Take(50).ToListAsync(ct)).Select(Dto).ToList();
    }

    private static WebhookDeliveryDto Dto(WebhookDelivery d) => new(d.Id, d.EventType, d.Status, d.Attempts, d.ResponseStatus, d.Error, d.CreatedAt, d.DeliveredAt,
        d.Status == WebhookDeliveryStatus.Pending ? d.NextAttemptAt : null, d.DurationMs, d.ReplayOf);

    /// <summary>The whole delivery history (kept 30 days), newest first, a page at a time, by status, event and time.</summary>
    public async Task<WebhookDeliveryPageDto> HistoryAsync(Guid id, int page, int pageSize, string? status, string? eventType, DateTime? from, DateTime? to, CancellationToken ct = default)
    {
        RequireAdmin();
        if (!await db.Webhooks.AnyAsync(w => w.Id == id, ct)) throw new NotFoundException("Webhook not found.");
        page = Math.Max(1, page); pageSize = Math.Clamp(pageSize, 10, 200);
        var q = db.WebhookDeliveries.AsNoTracking().Where(d => d.WebhookId == id);
        if (Enum.TryParse<WebhookDeliveryStatus>(status, true, out var st)) q = q.Where(d => d.Status == st);
        if (!string.IsNullOrWhiteSpace(eventType)) { var e = eventType.Trim(); q = e.EndsWith(".*") ? q.Where(d => d.EventType.StartsWith(e.Substring(0, e.Length - 1))) : q.Where(d => d.EventType == e); }
        if (from is { } f) q = q.Where(d => d.CreatedAt >= f);
        if (to is { } t) q = q.Where(d => d.CreatedAt <= t);
        var total = await q.CountAsync(ct);
        var rows = await q.OrderByDescending(d => d.CreatedAt).ThenByDescending(d => d.Id).Skip((page - 1) * pageSize).Take(pageSize).ToListAsync(ct);
        return new WebhookDeliveryPageDto(rows.Select(Dto).ToList(), total, page, pageSize);
    }

    /// <summary>One delivery with what was sent and what the receiver answered.</summary>
    public async Task<WebhookDeliveryDetailDto> DeliveryAsync(Guid id, Guid deliveryId, CancellationToken ct = default)
    {
        RequireAdmin();
        var d = await db.WebhookDeliveries.AsNoTracking().FirstOrDefaultAsync(x => x.Id == deliveryId && x.WebhookId == id, ct) ?? throw new NotFoundException("Delivery not found.");
        return new WebhookDeliveryDetailDto(Dto(d), d.Payload, d.ResponseSnippet);
    }

    /// <summary>Sends one delivery's event again, whatever became of it (after the receiver was fixed).</summary>
    public async Task<WebhookDeliveryDto> ReplayAsync(Guid id, Guid deliveryId, CancellationToken ct = default)
    {
        RequireAdmin();
        var hook = await db.Webhooks.FirstOrDefaultAsync(w => w.Id == id, ct) ?? throw new NotFoundException("Webhook not found.");
        var d = await db.WebhookDeliveries.AsNoTracking().FirstOrDefaultAsync(x => x.Id == deliveryId && x.WebhookId == id, ct) ?? throw new NotFoundException("Delivery not found.");
        var copy = Copy(hook, d);
        db.WebhookDeliveries.Add(copy);
        recorder.Audit("webhook.replayed", "Webhook", id, newValue: new { delivery = deliveryId });
        await db.SaveChangesAsync(ct);
        return Dto(copy);
    }

    private WebhookDelivery Copy(Webhook hook, WebhookDelivery d) => new()
    {
        TenantId = hook.TenantId, WebhookId = hook.Id, EventType = d.EventType, Payload = d.Payload, NextAttemptAt = clock.Now, CreatedAt = clock.Now, ReplayOf = d.ReplayOf ?? d.Id,
    };

    public const int MaxReplay = 500;

    /// <summary>Sends again every delivery (by default only the failed ones) in a time window, oldest first, up to 500 at a time.</summary>
    public async Task<int> ReplayManyAsync(Guid id, WebhookReplayRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        var hook = await db.Webhooks.FirstOrDefaultAsync(w => w.Id == id, ct) ?? throw new NotFoundException("Webhook not found.");
        if (!hook.IsActive) throw new ConflictException("Turn the webhook on before sending events again.", "WEBHOOK_OFF");
        var from = req.From ?? clock.Now.AddDays(-1); var to = req.To ?? clock.Now;
        if (to < from) (from, to) = (to, from);
        var q = db.WebhookDeliveries.AsNoTracking().Where(d => d.WebhookId == id && d.CreatedAt >= from && d.CreatedAt <= to && d.Status != WebhookDeliveryStatus.Pending);
        if (req.OnlyFailed) q = q.Where(d => d.Status == WebhookDeliveryStatus.Failed);
        if (!string.IsNullOrWhiteSpace(req.Event)) q = q.Where(d => d.EventType == req.Event);
        var rows = await q.OrderBy(d => d.CreatedAt).Take(MaxReplay).ToListAsync(ct);
        // An event already replayed and waiting is not queued twice.
        var waiting = (await db.WebhookDeliveries.AsNoTracking().Where(d => d.WebhookId == id && d.Status == WebhookDeliveryStatus.Pending && d.ReplayOf != null).Select(d => d.ReplayOf!.Value).ToListAsync(ct)).ToHashSet();
        var queued = 0;
        foreach (var d in rows.Where(d => !waiting.Contains(d.ReplayOf ?? d.Id))) { db.WebhookDeliveries.Add(Copy(hook, d)); queued++; }
        recorder.Audit("webhook.replayed", "Webhook", id, newValue: new { from, to, req.OnlyFailed, req.Event, queued });
        await db.SaveChangesAsync(ct);
        return queued;
    }

    /// <summary>Success rate, response time and failures over the last days, day by day, and how close it is to being switched off.</summary>
    public async Task<WebhookHealthDto> HealthAsync(Guid id, int days, CancellationToken ct = default)
    {
        RequireAdmin();
        var hook = await db.Webhooks.AsNoTracking().FirstOrDefaultAsync(w => w.Id == id, ct) ?? throw new NotFoundException("Webhook not found.");
        days = Math.Clamp(days, 1, 30);
        var since = clock.Now.Date.AddDays(-(days - 1));
        var rows = await db.WebhookDeliveries.AsNoTracking().Where(d => d.WebhookId == id && d.CreatedAt >= since)
            .Select(d => new { d.CreatedAt, d.Status, d.DurationMs, d.Error, d.DeliveredAt }).ToListAsync(ct);
        var done = rows.Where(r => r.Status != WebhookDeliveryStatus.Pending).ToList();
        var ok = done.Count(r => r.Status == WebhookDeliveryStatus.Succeeded);
        var times = done.Where(r => r.DurationMs is not null).Select(r => r.DurationMs!.Value).OrderBy(x => x).ToList();
        var series = Enumerable.Range(0, days).Select(i =>
        {
            var day = since.AddDays(i); var inDay = done.Where(r => r.CreatedAt >= day && r.CreatedAt < day.AddDays(1)).ToList();
            var t = inDay.Where(r => r.DurationMs is not null).Select(r => r.DurationMs!.Value).ToList();
            return new WebhookHealthDay(DateOnly.FromDateTime(day), inDay.Count, inDay.Count(r => r.Status == WebhookDeliveryStatus.Failed), t.Count == 0 ? null : (int)t.Average());
        }).ToList();
        var lastFail = await db.WebhookDeliveries.AsNoTracking().Where(d => d.WebhookId == id && d.Error != null).OrderByDescending(d => d.CreatedAt).Select(d => new { d.Error, d.CreatedAt }).FirstOrDefaultAsync(ct);
        return new WebhookHealthDto(days, done.Count, ok, done.Count - ok, rows.Count - done.Count, done.Count == 0 ? null : Math.Round(ok * 100m / done.Count, 1),
            times.Count == 0 ? null : (int)times.Average(), times.Count == 0 ? null : times[Math.Min(times.Count - 1, (int)Math.Ceiling(times.Count * 0.95) - 1)],
            series, lastFail?.Error, lastFail?.CreatedAt, hook.ConsecutiveFailures, WebhookProcessor.WarnAfterFailures, WebhookProcessor.DisableAfterFailures, hook.WarnedAt is not null);
    }

    /// <summary>Queues a harmless "ping", or a sample of one event (marked as a test), so an administrator can check the receiver end to end.</summary>
    public async Task<WebhookDeliveryDto> SendTestAsync(Guid id, CancellationToken ct = default, string? eventType = null)
    {
        RequireAdmin();
        var hook = await db.Webhooks.FirstOrDefaultAsync(w => w.Id == id, ct) ?? throw new NotFoundException("Webhook not found.");
        if (eventType is not null && !WebhookEvents.All.Contains(eventType)) throw new ValidationException("event", $"“{eventType}” is not an event this system sends.");
        var delivery = eventType is null
            ? WebhookProcessor.NewDelivery(hook, null, "ping", clock.Now, new { message = "This is a test from your workspace.", webhookId = hook.Id })
            : WebhookProcessor.NewDelivery(hook, null, eventType, clock.Now, WebhookEvents.Sample(eventType), test: true);
        db.WebhookDeliveries.Add(delivery);
        await db.SaveChangesAsync(ct);
        return Dto(delivery);
    }

    public async Task RetryAsync(Guid id, Guid deliveryId, CancellationToken ct = default)
    {
        RequireAdmin();
        var d = await db.WebhookDeliveries.FirstOrDefaultAsync(x => x.Id == deliveryId && x.WebhookId == id, ct) ?? throw new NotFoundException("Delivery not found.");
        if (d.Status != WebhookDeliveryStatus.Failed) throw new ConflictException("Only failed deliveries can be retried.", "NOT_FAILED");
        d.Status = WebhookDeliveryStatus.Pending; d.Attempts = 0; d.NextAttemptAt = clock.Now; d.Error = null;
        await db.SaveChangesAsync(ct);
    }
}

/// <summary>
/// Background work for webhooks, in two steps: turn new activity into deliveries (one per matching webhook), then send what is due, with
/// growing delays between retries. A receiver that keeps failing is switched off so it does not stay in the queue for ever.
/// </summary>
public class WebhookProcessor(IServiceScopeFactory scopes, TimeProvider time, ILogger<WebhookProcessor> log, Microsoft.Extensions.Options.IOptions<WebhookOptions> options)
{
    public const int MaxAttempts = 6;
    public const int DisableAfterFailures = 10;
    /// <summary>Half way to the switch-off, the people who set the webhook up are told, so it can be fixed in time.</summary>
    public const int WarnAfterFailures = 5;
    private static readonly TimeSpan[] Backoff = [TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(30), TimeSpan.FromHours(2), TimeSpan.FromHours(12)];
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private DateTime Now => time.GetUtcNow().UtcDateTime;

    public static WebhookDelivery NewDelivery(Webhook hook, Guid? activityId, string eventType, DateTime now, object data, bool test = false) => new()
    {
        TenantId = hook.TenantId, WebhookId = hook.Id, ActivityId = activityId, EventType = eventType, NextAttemptAt = now, CreatedAt = now,
        Payload = test
            ? JsonSerializer.Serialize(new { id = Guid.NewGuid(), @event = eventType, occurredAt = now, workspaceId = hook.TenantId, test = true, data }, Json)
            : JsonSerializer.Serialize(new { id = Guid.NewGuid(), @event = eventType, occurredAt = now, workspaceId = hook.TenantId, data }, Json),
    };

    /// <summary>The project and priority of what each activity is about, for the outgoing filters (only read when a webhook has filters).</summary>
    private static async Task<Dictionary<Guid, WebhookFilters.Facts>> FactsAsync(IAppDbContext db, IReadOnlyList<Activity> activities, CancellationToken ct)
    {
        var facts = new Dictionary<Guid, WebhookFilters.Facts>();
        List<Guid> Ids(string type) => activities.Where(a => a.EntityType == type && a.EntityId != null).Select(a => a.EntityId!.Value).Distinct().ToList();
        var tasks = Ids("Task"); var work = Ids("WorkTask"); var issues = Ids("Issue");
        var tp = new List<(Guid Id, Guid? Project, Priority Priority)>();
        if (tasks.Count > 0) tp.AddRange((await db.Tasks.IgnoreQueryFilters().AsNoTracking().Where(t => tasks.Contains(t.Id)).Select(t => new { t.Id, t.ProjectId, t.Priority }).ToListAsync(ct)).Select(t => (t.Id, (Guid?)t.ProjectId, t.Priority)));
        var wp = new List<(Guid Id, Guid? Project, Priority Priority)>();
        if (work.Count > 0) wp.AddRange((await db.WorkTasks.IgnoreQueryFilters().AsNoTracking().Where(t => work.Contains(t.Id)).Select(t => new { t.Id, t.RelatedProjectId, t.Priority }).ToListAsync(ct)).Select(t => (t.Id, t.RelatedProjectId, t.Priority)));
        var ip = new List<(Guid Id, Guid? Project, Priority Priority)>();
        if (issues.Count > 0) ip.AddRange((await db.StageIssues.IgnoreQueryFilters().AsNoTracking().Where(t => issues.Contains(t.Id)).Select(t => new { t.Id, t.ProjectId, t.Severity }).ToListAsync(ct)).Select(t => (t.Id, (Guid?)t.ProjectId, t.Severity)));
        foreach (var a in activities)
        {
            Guid? project = a.ProjectId; Priority? priority = null;
            if (a.EntityId is { } eid)
            {
                var hit = a.EntityType switch { "Task" => tp, "WorkTask" => wp, "Issue" => ip, _ => null }
                    is { } list && list.FindIndex(x => x.Id == eid) is var at and >= 0 ? list[at] : ((Guid Id, Guid? Project, Priority Priority)?)null;
                if (hit is { } h) { project ??= h.Project; priority = h.Priority; }
                else if (a.EntityType == "Project") project ??= eid;
            }
            facts[a.Id] = new WebhookFilters.Facts(project, priority);
        }
        return facts;
    }

    /// <summary>One round: fan out new events, then deliver. Returns how many requests were sent.</summary>
    public async Task<int> RunAsync(CancellationToken ct = default)
    {
        await DispatchAsync(ct);
        return await DeliverAsync(ct);
    }

    // ---------------------------------------------------------------- activity → deliveries

    public async Task DispatchAsync(CancellationToken ct = default)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IAppDbContext>();
        var until = Now - TimeSpan.FromSeconds(options.Value.SettleSeconds); // give in-flight requests time to commit, so nothing is skipped
        var hooks = await db.Webhooks.IgnoreQueryFilters().Where(w => w.IsActive && db.Tenants.IgnoreQueryFilters().Any(t => t.Id == w.TenantId && t.Status == TenantStatus.Active && !t.IsDeleted)).ToListAsync(ct);

        foreach (var hook in hooks)
        {
            var activities = await db.Activities.IgnoreQueryFilters().AsNoTracking().Where(a => a.TenantId == hook.TenantId && a.CreatedAt >= hook.CursorAt && a.CreatedAt <= until)
                .OrderBy(a => a.CreatedAt).ThenBy(a => a.Id).Take(200).ToListAsync(ct);
            if (activities.Count == 0) continue;

            var ids = activities.Select(a => a.Id).ToList();
            var done = (await db.WebhookDeliveries.IgnoreQueryFilters().Where(d => d.WebhookId == hook.Id && d.ActivityId != null && ids.Contains(d.ActivityId.Value)).Select(d => d.ActivityId!.Value).ToListAsync(ct)).ToHashSet();
            var actors = activities.Where(a => a.ActorId != null).Select(a => a.ActorId!.Value).Distinct().ToList();
            var names = await db.Users.IgnoreQueryFilters().Where(u => actors.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);

            var facts = WebhookFilters.Any(hook) ? await FactsAsync(db, activities, ct) : null;
            foreach (var a in activities.Where(a => !done.Contains(a.Id) && WebhookEvents.Matches(hook.Events, a.Action)
                         && (facts is null || WebhookFilters.Passes(hook, a.Action, a.NewValue, facts[a.Id]))))
                db.WebhookDeliveries.Add(NewDelivery(hook, a.Id, a.Action, a.CreatedAt, new
                {
                    summary = a.Summary, entity = new { type = a.EntityType, id = a.EntityId }, projectId = a.ProjectId,
                    actor = a.ActorId is { } id ? new { id, name = names.GetValueOrDefault(id) } : null, oldValue = a.OldValue, newValue = a.NewValue,
                }));
            hook.CursorAt = activities[^1].CreatedAt;
            await db.SaveChangesAsync(ct);
        }

        // Audit log streaming: the same delivery queue, from the tenant's audit records.
        foreach (var hook in hooks.Where(h => WebhookEvents.WantsAudit(h.Events)))
        {
            var since = hook.AuditCursorAt ?? hook.CreatedAt;
            var records = await db.AuditLogs.IgnoreQueryFilters().AsNoTracking().Where(a => a.TenantId == hook.TenantId && a.CreatedAt >= since && a.CreatedAt <= until)
                .OrderBy(a => a.CreatedAt).ThenBy(a => a.Id).Take(200).ToListAsync(ct);
            if (records.Count == 0) continue;
            var ids = records.Select(a => a.Id).ToList();
            var done = (await db.WebhookDeliveries.IgnoreQueryFilters().Where(d => d.WebhookId == hook.Id && d.ActivityId != null && ids.Contains(d.ActivityId.Value)).Select(d => d.ActivityId!.Value).ToListAsync(ct)).ToHashSet();
            var people = records.Where(a => a.UserId != null).Select(a => a.UserId!.Value).Distinct().ToList();
            var names = await db.Users.IgnoreQueryFilters().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => new { u.DisplayName, u.Email }, ct);
            foreach (var a in records.Where(a => !done.Contains(a.Id)))
                db.WebhookDeliveries.Add(NewDelivery(hook, a.Id, WebhookEvents.Audit, a.CreatedAt, new
                {
                    action = a.Action, entityType = a.EntityType, entityId = a.EntityId, ipAddress = a.IpAddress, userAgent = a.UserAgent,
                    user = a.UserId is { } u ? new { id = u, name = names.GetValueOrDefault(u)?.DisplayName, email = names.GetValueOrDefault(u)?.Email } : null,
                    oldValue = a.OldValue, newValue = a.NewValue,
                }));
            hook.AuditCursorAt = records[^1].CreatedAt;
            await db.SaveChangesAsync(ct);
        }
    }

    // ---------------------------------------------------------------- deliveries → HTTP

    public async Task<int> DeliverAsync(CancellationToken ct = default)
    {
        var claimed = new List<Guid>();
        using (var scope = scopes.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IAppDbContext>();
            var now = Now;
            var due = await db.WebhookDeliveries.IgnoreQueryFilters().Where(d => d.Status == WebhookDeliveryStatus.Pending && d.NextAttemptAt <= now).OrderBy(d => d.NextAttemptAt).Take(25).Select(d => d.Id).ToListAsync(ct);
            foreach (var id in due)
            {
                // Claim by pushing the next attempt out, so two servers never send the same delivery at once.
                var lockUntil = now.AddMinutes(2);
                if (await db.WebhookDeliveries.IgnoreQueryFilters().Where(d => d.Id == id && d.Status == WebhookDeliveryStatus.Pending && d.NextAttemptAt <= now)
                        .ExecuteUpdateAsync(s => s.SetProperty(d => d.NextAttemptAt, lockUntil), ct) == 1) claimed.Add(id);
            }
        }
        foreach (var id in claimed)
        {
            try { await SendOneAsync(id, ct); }
            catch (Exception ex) when (ex is not OperationCanceledException) { log.LogError(ex, "Webhook delivery {Id} failed unexpectedly", id); }
        }
        return claimed.Count;
    }

    private async Task SendOneAsync(Guid id, CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var sp = scope.ServiceProvider;
        var db = sp.GetRequiredService<IAppDbContext>();
        var d = await db.WebhookDeliveries.IgnoreQueryFilters().FirstAsync(x => x.Id == id, ct);
        var hook = await db.Webhooks.IgnoreQueryFilters().FirstOrDefaultAsync(w => w.Id == d.WebhookId, ct);
        var now = Now;

        if (hook is null || !hook.IsActive && d.EventType != "ping")
        {
            d.Status = WebhookDeliveryStatus.Failed; d.Error = "The webhook is switched off or was removed."; await db.SaveChangesAsync(ct);
            return;
        }

        // Slack and Teams want a message, not our event: it is written now from the stored event (which the delivery log keeps showing).
        var body = d.Payload;
        if (hook.Format != WebhookFormat.Json)
        {
            var tenant = await db.Tenants.IgnoreQueryFilters().Where(t => t.Id == hook.TenantId).Select(t => new { t.Name, t.Slug }).FirstOrDefaultAsync(ct);
            var web = ProjectManagement.Application.Features.Sso.PublicUrls.Web(sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<ProjectManagement.Application.Common.AppOptions>>().Value);
            // Links in the message open inside this workspace: https://app/acme-bank/projects/…
            body = ChatMessages.Render(hook.Format, d.Payload, tenant is null ? web : $"{web}/{tenant.Slug}", tenant?.Name ?? "Workspace");
        }
        var secret = sp.GetRequiredService<ISecretProtector>().Unprotect(hook.SecretProtected);
        var stamp = new DateTimeOffset(now).ToUnixTimeSeconds();
        var signature = Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes($"{stamp}.{body}"))).ToLowerInvariant();
        var headers = new Dictionary<string, string>
        {
            ["X-PM-Event"] = d.EventType, ["X-PM-Delivery"] = d.Id.ToString(), ["X-PM-Timestamp"] = stamp.ToString(), ["X-PM-Signature"] = $"t={stamp},v1={signature}",
        };

        using var span = ProjectManagement.Application.Common.AppTelemetry.Source.StartActivity("webhook.deliver");
        span?.SetTag("webhook.event", d.EventType);
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var result = await sp.GetRequiredService<IWebhookTransport>().SendAsync(hook.Url, headers, body, ct);
        d.DurationMs = (int)Math.Min(int.MaxValue, watch.ElapsedMilliseconds);
        d.Attempts++;
        d.ResponseStatus = result.Status; d.ResponseSnippet = result.Snippet;
        var ok = result.Status is >= 200 and < 300;
        hook.LastDeliveryAt = now;

        ProjectManagement.Application.Common.AppTelemetry.Count(ProjectManagement.Application.Common.AppTelemetry.WebhookDeliveries, ok ? "succeeded" : d.Attempts >= MaxAttempts ? "failed" : "retry");
        span?.SetTag("http.response.status_code", result.Status);
        if (ok)
        {
            d.Status = WebhookDeliveryStatus.Succeeded; d.DeliveredAt = now; d.Error = null;
            hook.LastStatus = "ok"; hook.ConsecutiveFailures = 0; hook.WarnedAt = null;
        }
        else
        {
            d.Error = result.Error ?? $"The receiver answered {result.Status}.";
            hook.LastStatus = "failed";
            if (d.Attempts >= MaxAttempts)
            {
                d.Status = WebhookDeliveryStatus.Failed;
                if (d.EventType != "ping" && ++hook.ConsecutiveFailures >= DisableAfterFailures && hook.IsActive)
                {
                    hook.IsActive = false; hook.DisabledReason = $"Switched off automatically after {DisableAfterFailures} deliveries in a row failed.";
                    await TellOwnersAsync(db, hook, now, $"Webhook “{hook.Name}” was switched off",
                        $"{DisableAfterFailures} deliveries in a row failed (last: {d.Error}). Fix the receiver, turn it back on, then replay the failed events.", ct);
                }
                else if (d.EventType != "ping" && hook.ConsecutiveFailures >= WarnAfterFailures && hook.WarnedAt is null && hook.IsActive)
                {
                    hook.WarnedAt = now;
                    await TellOwnersAsync(db, hook, now, $"Webhook “{hook.Name}” keeps failing",
                        $"{hook.ConsecutiveFailures} deliveries in a row failed (last: {d.Error}). It is switched off after {DisableAfterFailures}.", ct);
                }
            }
            else d.NextAttemptAt = now + Backoff[Math.Min(d.Attempts - 1, Backoff.Length - 1)];
        }
        await db.SaveChangesAsync(ct);
    }

    /// <summary>The person who created the webhook and the workspace's owners and admins hear about it in the app.</summary>
    private static async Task TellOwnersAsync(IAppDbContext db, Webhook hook, DateTime now, string title, string body, CancellationToken ct)
    {
        var people = await db.TenantMembers.IgnoreQueryFilters().AsNoTracking()
            .Where(m => m.TenantId == hook.TenantId && (m.UserId == hook.CreatedBy || m.Role == TenantRole.Owner || m.Role == TenantRole.Admin))
            .Select(m => m.UserId).Distinct().Take(10).ToListAsync(ct);
        foreach (var user in people)
            db.Notifications.Add(new Notification
            {
                TenantId = hook.TenantId, UserId = user, Type = NotificationType.Security, CreatedAt = now, Link = "/settings/webhooks",
                Title = title.Length > 200 ? title[..200] : title, Body = body.Length > 500 ? body[..500] : body, DedupeKey = $"webhook-health:{hook.Id:N}:{user:N}:{now:yyyyMMddHH}",
            });
    }

    /// <summary>Removes old delivery history (kept 30 days).</summary>
    public async Task<int> PurgeAsync(CancellationToken ct = default)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IAppDbContext>();
        var cutoff = Now.AddDays(-30);
        return await db.WebhookDeliveries.IgnoreQueryFilters().Where(d => d.CreatedAt < cutoff && d.Status != WebhookDeliveryStatus.Pending).ExecuteDeleteAsync(ct);
    }
}
