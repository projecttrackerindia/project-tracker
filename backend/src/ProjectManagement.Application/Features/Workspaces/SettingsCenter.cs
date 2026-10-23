using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Compliance;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Organization;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Workspaces;

// ====================================================================== who changed what

/// <param name="Summary">What the change did, in words ("Off → On", "Webhook added: Ops alerts").</param>
/// <param name="UndoTo">What undoing puts back ("Off", "90 days"); null when the change cannot be undone here.</param>
/// <param name="UndoBlocked">Why undo is not offered, when the setting can normally be undone.</param>
/// <param name="WasUndo">This change was itself an undo of the one before it.</param>
public record SettingChangeDto(string Key, string Section, string Setting, string Summary, string Action, DateTime At, Guid? ById, string? ByName, Guid AuditId,
    bool CanUndo, string? UndoTo, string? UndoBlocked, bool WasUndo);
public record SettingChangesDto(IReadOnlyList<SettingChangeDto> Items, bool CanUndo);
public record UndoSettingRequest(string Key);
public record UndoSettingResultDto(string Key, string Message, SettingChangeDto? Latest);

/// <summary>One workspace setting as Settings knows it: where it lives, which audit actions change it and, for shared actions, which fields.</summary>
/// <param name="Fields">Properties of the audit's old/new values that make up this setting; null = the whole value (or an item kept in a list).</param>
/// <param name="Undo">Settings can put the previous value back through the same service and checks as saving it by hand.</param>
public sealed record SettingDef(string Key, string Section, string Label, string[] Actions, string[]? Fields = null, bool Undo = false);

/// <summary>Every workspace setting whose changes are audited, by section of Workspace settings.</summary>
public static class SettingsCatalog
{
    private const string Security = "org.security_changed", Data = "data_policy.changed";

    public static readonly SettingDef[] All =
    [
        new("workspace.name", "general", "Workspace name", ["workspace.updated"], ["name"], true),
        new("workspace.description", "general", "Description", ["workspace.updated"], ["description"], true),
        new("workspace.logo", "general", "Logo", ["workspace.logo_changed", "workspace.logo_removed"]),
        new("workspace.timeZone", "general", "Workspace time zone", ["workspace.time_zone"], null, true),
        new("workspace.costCurrency", "general", "Currency for costs and budgets", ["workspace.cost_currency"], null, true),

        new("members.roles", "members", "Access levels of members", ["member.role_changed", "org.member_role_assigned", "org.reports_to_changed"]),
        new("members.invitations", "members", "Invitations", ["member.invited", "member.invitation_revoked", "member.joined"]),
        new("members.accounts", "members", "Members added or removed", ["member.created", "member.provisioned", "member.deprovisioned", "member.rates_changed"]),
        new("access.jobRoles", "access", "Job roles and their access", ["org.role_created", "org.role_updated", "org.role_deleted", "org.role_moved", "org.role_restored", "org.template_applied", "org.access_changed", "org.access_reset"]),
        new("access.levels", "access", "Access level permissions", ["permission.changed"]),
        new("access.projectVisibility", "visibility", "Who sees which projects", ["org.project_visibility_changed"], ["projectVisibility"], true),

        new("security.requireMfa", "security", "Require two-step sign-in", [Security], ["requireMfa"], true),
        new("security.ipAllowlist", "security", "Allowed networks (IP allow-list)", [Security], ["ipAllowlistEnabled", "ipRanges"], true),
        new("security.minPasswordLength", "security", "Minimum password length", [Security], ["minPasswordLength"], true),
        new("security.sessionHours", "security", "Sign in again after", [Security], ["sessionHours"], true),
        new("security.allowedSignIn", "security", "Allowed ways to sign in", [Security], ["allowedSignIn"], true),
        new("security.revealSeconds", "security", "How long a revealed secret stays visible", ["org.reveal_duration_changed"], ["seconds"], true),
        new("security.reminders", "security", "Security reminders to members", ["org.security_reminded"]),
        new("sso.connection", "sso", "Single sign-on connection", ["sso.connection_saved"]),
        new("sso.domains", "sso", "Verified domains", ["sso.domain_added", "sso.domain_removed", "sso.domain_verified"]),
        new("sso.groups", "sso", "Group mapping", ["sso.group_mapped", "sso.group_unmapped"]),
        new("sso.scim", "sso", "User provisioning (SCIM)", ["scim.token_created", "scim.token_revoked"]),
        new("data.activity", "data", "Keep activity", [Data], ["activityRetentionDays"], true),
        new("data.notifications", "data", "Keep notifications", [Data], ["notificationRetentionDays"], true),
        new("data.chat", "data", "Keep chat messages", [Data], ["chatRetentionDays"], true),
        new("data.audit", "data", "Keep the audit log", [Data], ["auditRetentionDays"], true),
        new("data.key", "data", "Encryption key", ["org.data_key_rotated"]),
        new("data.masking", "data", "Masking of personal data in documents", ["document.masking_changed", "document.masking_rule_removed"]),

        new("notifications.defaults", "notifications", "Notification defaults for members", ["notifications.defaults_changed"], null, true),
        new("reminders.escalation", "reminders", "Escalation of overdue work", ["reminder.policy"], ["escalationEnabled", "steps"], true),

        new("ai.enabled", "ai", "AI assistant in this workspace", ["ai.workspace_switch"], ["allowed"], true),
        new("ai.instructions", "ai", "What the assistant knows about the organization", ["ai.instructions_changed"], ["text", "length"], true),
        new("ai.budget", "ai", "AI credit budget", ["ai.budget_changed"]),
        new("ai.agents", "ai", "Agents and their alerts", ["agent.workspace_saved", "agent.alerts_saved"]),
        new("apps.connected", "connected-apps", "Connected AI apps", ["oauth.app_connected", "oauth.app_disconnected"]),

        new("integrations.apiKeys", "api-keys", "API keys", ["apikey.created", "apikey.revoked"]),
        new("integrations.webhooks", "webhooks", "Webhooks", ["webhook.created", "webhook.updated", "webhook.deleted", "webhook.secret_rotated"]),
        new("integrations.incoming", "webhooks", "Incoming addresses", ["incoming_webhook.*"]),
        new("integrations.slack", "slack", "Slack workspace", ["slack.connected", "slack.disconnected", "slack.revoked"]),
        new("integrations.whatsapp", "whatsapp", "WhatsApp Business number", ["whatsapp.connected", "whatsapp.disconnected"]),
        new("integrations.email", "email", "Email to work", ["inbound_mailbox.saved", "inbound_mailbox.reset", "mailbox.company_set"]),
        new("integrations.git", "git", "GitHub and Azure DevOps", ["git_connection.created", "git_connection.deleted", "github.app_installed", "github.app_disconnected", "github.settings_changed"]),

        new("config.projectGroups", "project-groups", "Project groups", ["projectgroup.*"]),
        new("config.timelines", "timeline-templates", "Timeline templates", ["timeline_template.*"]),
        new("config.priorities", "priorities", "Priorities", ["priorities.updated", "priorities.reset"]),
        new("config.customFields", "custom-fields", "Custom fields", ["customfield.*"]),
        new("config.workTypes", "work-types", "Work types and service levels", ["worktype.*", "sla.saved", "sla.override_removed", "operations.settings", "operations.routing", "operations.routing_removed"]),
        new("config.automation", "automation", "Automation rules", ["automation.*"]),

        new("billing.plan", "billing", "Plan and subscription", ["subscription.changed", "subscription.cancelled", "subscription.resumed", "admin.subscription_changed"]),
        new("billing.details", "billing", "Billing details", ["billing.details_changed"]),
    ];

    public static SettingDef? Find(string? key) => All.FirstOrDefault(d => d.Key == key);

    public static bool Matches(SettingDef d, string action) =>
        d.Actions.Any(a => a.EndsWith(".*", StringComparison.Ordinal) ? action.StartsWith(a[..^1], StringComparison.Ordinal) : a == action);

    /// <summary>What an older row's previous value was when the setting had never been saved before.</summary>
    public static JsonNode? Initial(SettingDef d) => d.Actions[0] switch
    {
        Security => new JsonObject { ["requireMfa"] = false, ["ipAllowlistEnabled"] = false, ["ipRanges"] = "", ["minPasswordLength"] = 0, ["sessionHours"] = 0, ["allowedSignIn"] = "" },
        Data => new JsonObject { ["activityRetentionDays"] = null, ["notificationRetentionDays"] = null, ["chatRetentionDays"] = null, ["auditRetentionDays"] = null },
        "org.reveal_duration_changed" => new JsonObject { ["seconds"] = 15 },
        "ai.workspace_switch" => new JsonObject { ["allowed"] = true },
        "ai.instructions_changed" => new JsonObject { ["length"] = 0, ["text"] = null },
        "reminder.policy" => new JsonObject { ["escalationEnabled"] = false, ["steps"] = new ReminderPolicy().Steps },
        "notifications.defaults_changed" => JsonSerializer.SerializeToNode(NotificationDefaultsService.Snapshot(null), SettingsJson.Web),
        "org.project_visibility_changed" => new JsonObject { ["projectVisibility"] = (int)ProjectVisibility.Organization },
        _ => null,
    };
}

internal static class SettingsJson
{
    public static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    /// <summary>Audit values are JSON, except a few written as plain text (a time zone, a currency).</summary>
    public static JsonNode? Parse(string? v)
    {
        if (v is null) return null;
        var t = v.TrimStart();
        if (t.StartsWith('{') || t.StartsWith('['))
            try { return JsonNode.Parse(v); } catch (JsonException) { }
        return JsonValue.Create(v);
    }

    public static JsonNode? Field(JsonNode? n, string f) =>
        n is JsonObject o ? o.FirstOrDefault(kv => string.Equals(kv.Key, f, StringComparison.OrdinalIgnoreCase)).Value : null;

    public static string Text(JsonNode? n) => n?.ToJsonString() ?? "null";

    public static string? Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : n is null ? null : n.ToJsonString().Trim('"');
    public static int? Int(JsonNode? n) => n is JsonValue v && v.TryGetValue<int>(out var i) ? i : n is JsonValue d && d.TryGetValue<double>(out var x) ? (int)x : null;
    public static bool Bool(JsonNode? n) => n is JsonValue v && v.TryGetValue<bool>(out var b) && b;
}

/// <summary>
/// "Who changed what": each setting's last change and who made it, from the audit log, with undo for the last change where the setting
/// can be put back through its own service (so the same lock-out checks apply as saving it by hand). Owners and admins can undo;
/// people who may read the audit log can see the history.
/// </summary>
public class SettingsHistoryService(IAppDbContext db, ICurrentContext ctx, Recorder recorder, PermissionService permissions, IServiceProvider services)
{
    private sealed record Hit(SettingDef Def, AuditLog Row, JsonNode? Old, JsonNode? New);

    private bool IsAdmin => ctx.Role is TenantRole.Owner or TenantRole.Admin;

    private async Task RequireViewAsync(CancellationToken ct)
    {
        if (IsAdmin) return;
        if (!await permissions.HasAsync(Permissions.AuditView, ct)) throw new ForbiddenException("Only owners, admins and people who may read the audit log can see who changed settings.", "PERMISSION_DENIED");
    }

    /// <summary>The last change of every setting in a section (or all of them), newest first. Settings never changed are left out.</summary>
    public async Task<SettingChangesDto> SectionAsync(string? section, CancellationToken ct = default)
    {
        await RequireViewAsync(ct);
        var defs = SettingsCatalog.All.Where(d => string.IsNullOrWhiteSpace(section) || d.Section == section).ToList();
        if (defs.Count == 0) throw new NotFoundException("There is no such settings section.");
        var rows = await RowsAsync(defs, 600, ct);
        var undone = await UndoMarksAsync(ct);
        var items = new List<SettingChangeDto>();
        foreach (var d in defs)
            if (Latest(d, rows) is { } hit) items.Add(await DescribeAsync(hit, true, undone, ct));
        return new SettingChangesDto(items.OrderByDescending(i => i.At).ToList(), IsAdmin);
    }

    /// <summary>The latest setting changes across the workspace, for the Settings home.</summary>
    public async Task<SettingChangesDto> RecentAsync(int take, CancellationToken ct = default)
    {
        await RequireViewAsync(ct);
        take = Math.Clamp(take, 1, 50);
        var rows = await RowsAsync(SettingsCatalog.All, 400, ct);
        var undone = await UndoMarksAsync(ct);
        var latest = SettingsCatalog.All.Select(d => Latest(d, rows)).Where(h => h is not null).ToDictionary(h => (h!.Def.Key, h.Row.Id), h => h!);
        var items = new List<SettingChangeDto>();
        foreach (var row in rows)
        {
            foreach (var d in SettingsCatalog.All.Where(x => SettingsCatalog.Matches(x, row.Action)))
            {
                var hit = Make(d, row);
                if (!Changed(hit)) continue;
                items.Add(await DescribeAsync(hit, latest.ContainsKey((d.Key, row.Id)), undone, ct));
            }
            if (items.Count >= take) break;
        }
        return new SettingChangesDto(items.Take(take).ToList(), IsAdmin);
    }

    /// <summary>Puts back what the setting was before its last change. Refused when it is no longer the last change or was changed since.</summary>
    public async Task<UndoSettingResultDto> UndoAsync(Guid auditId, UndoSettingRequest req, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        if (ctx.ViaApiKey) throw new ForbiddenException("API keys cannot undo setting changes.", "API_KEY_NOT_ALLOWED");
        if (!IsAdmin) throw new ForbiddenException("Only owners and admins can undo setting changes.", "PERMISSION_DENIED");
        var def = SettingsCatalog.Find(req.Key) ?? throw new NotFoundException("There is no such setting.");
        if (!def.Undo) throw new ConflictException($"{def.Label} cannot be undone from here. Open it and change it back by hand.", "UNDO_NOT_SUPPORTED");
        var rows = await RowsAsync([def], 300, ct);
        var hit = Latest(def, rows);
        if (hit is null || hit.Row.Id != auditId)
            throw new ConflictException($"That is no longer the last change to {def.Label.ToLowerInvariant()}. Refresh to see the latest one.", "NOT_LAST_CHANGE");
        if (await BlockedAsync(hit, ct) is { } blocked) throw new ConflictException(blocked, "CHANGED_SINCE");
        var old = hit.Old ?? SettingsCatalog.Initial(def);
        if (def.Key == "ai.instructions" && SettingsJson.Field(old, "text") is null && (SettingsJson.Int(SettingsJson.Field(old, "length")) ?? 0) > 0)
            throw new ConflictException("The earlier text was too long to keep in the audit log, so it cannot be put back automatically.", "UNDO_NOT_AVAILABLE");

        recorder.Audit("settings.undone", "AuditLog", auditId, null, new { key = def.Key }, tenantId: tid);
        await ApplyAsync(def, old, ct);
        await db.SaveChangesAsync(ct);
        var after = await SectionAsync(def.Section, ct);
        return new UndoSettingResultDto(def.Key, $"Undone: {def.Label} is back to {State(def, old)}.", after.Items.FirstOrDefault(i => i.Key == def.Key));
    }

    // ------------------------------------------------------------------ reading the audit log

    private async Task<List<AuditLog>> RowsAsync(IReadOnlyCollection<SettingDef> defs, int take, CancellationToken ct)
    {
        var tid = ctx.RequireTenantId();
        var exact = defs.SelectMany(d => d.Actions).Where(a => !a.EndsWith(".*", StringComparison.Ordinal)).Distinct().ToList();
        var prefixes = defs.SelectMany(d => d.Actions).Where(a => a.EndsWith(".*", StringComparison.Ordinal)).Select(a => a[..^1]).Distinct().ToList();
        var all = db.AuditLogs.AsNoTracking().Where(a => a.TenantId == tid);
        var rows = await all.Where(a => exact.Contains(a.Action)).OrderByDescending(a => a.CreatedAt).Take(take).ToListAsync(ct);
        // A family of actions ("customfield.*") is one LIKE query each, so the database does the matching.
        foreach (var prefix in prefixes)
            rows.AddRange(await all.Where(a => a.Action.StartsWith(prefix)).OrderByDescending(a => a.CreatedAt).Take(take).ToListAsync(ct));
        return rows.DistinctBy(a => a.Id).OrderByDescending(a => a.CreatedAt).ThenByDescending(a => a.Seq ?? 0).Take(take).ToList();
    }

    private async Task<List<(Guid UserId, string Key, DateTime At)>> UndoMarksAsync(CancellationToken ct)
    {
        var tid = ctx.RequireTenantId();
        var marks = await db.AuditLogs.AsNoTracking().Where(a => a.TenantId == tid && a.Action == "settings.undone")
            .OrderByDescending(a => a.CreatedAt).Take(200).Select(a => new { a.UserId, a.NewValue, a.CreatedAt }).ToListAsync(ct);
        return marks.Select(m => (m.UserId ?? Guid.Empty, SettingsJson.Str(SettingsJson.Field(SettingsJson.Parse(m.NewValue), "key")) ?? "", m.CreatedAt)).ToList();
    }

    private static Hit Make(SettingDef d, AuditLog r) => new(d, r, SettingsJson.Parse(r.OldValue), SettingsJson.Parse(r.NewValue));

    private static Hit? Latest(SettingDef d, IEnumerable<AuditLog> rows) =>
        rows.Where(r => SettingsCatalog.Matches(d, r.Action)).Select(r => Make(d, r)).FirstOrDefault(Changed);

    /// <summary>A row of a shared action (all sign-in rules are saved together) counts for this setting only when one of its fields moved.</summary>
    private static bool Changed(Hit h)
    {
        if (h.Def.Fields is null) return true;
        var old = h.Old ?? SettingsCatalog.Initial(h.Def);
        return h.Def.Fields.Any(f => SettingsJson.Text(SettingsJson.Field(old, f)) != SettingsJson.Text(SettingsJson.Field(h.New, f))
            && !(f == "length" && h.Def.Key == "ai.instructions" && SettingsJson.Field(h.New, "text") is not null));
    }

    private async Task<SettingChangeDto> DescribeAsync(Hit h, bool isLatest, List<(Guid UserId, string Key, DateTime At)> undone, CancellationToken ct)
    {
        var by = h.Row.UserId is { } uid ? await db.Users.AsNoTracking().Where(u => u.Id == uid).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) : null;
        var wasUndo = undone.Any(m => m.Key == h.Def.Key && m.UserId == (h.Row.UserId ?? Guid.Empty) && Math.Abs((m.At - h.Row.CreatedAt).TotalSeconds) < 15);
        string? blocked = null, undoTo = null;
        var can = false;
        if (h.Def.Undo && isLatest)
        {
            var old = h.Old ?? SettingsCatalog.Initial(h.Def);
            undoTo = State(h.Def, old);
            blocked = await BlockedAsync(h, ct);
            if (blocked is null && h.Def.Key == "ai.instructions" && SettingsJson.Field(old, "text") is null && (SettingsJson.Int(SettingsJson.Field(old, "length")) ?? 0) > 0)
                blocked = "The earlier text was too long to keep, so it cannot be put back automatically.";
            if (!IsAdmin) blocked ??= "Only owners and admins can undo.";
            can = blocked is null;
        }
        else if (h.Def.Undo) blocked = "Only the last change can be undone.";
        return new SettingChangeDto(h.Def.Key, h.Def.Section, h.Def.Label, Summary(h), h.Row.Action, h.Row.CreatedAt, h.Row.UserId, by ?? (h.Row.UserId is null ? "The system" : "A former member"),
            h.Row.Id, can, can ? undoTo : null, blocked, wasUndo);
    }

    /// <summary>Null when the setting still has the value this change gave it; otherwise why it cannot be undone.</summary>
    private async Task<string?> BlockedAsync(Hit h, CancellationToken ct)
    {
        var current = await CurrentAsync(h.Def, ct);
        if (current is null) return null;
        var fields = h.Def.Fields?.Where(f => f != "length").ToArray();
        var same = fields is null
            ? Normalize(h.Def, current) == Normalize(h.Def, h.New)
            : fields.All(f => SettingsJson.Text(SettingsJson.Field(current, f)) == SettingsJson.Text(SettingsJson.Field(h.New, f)));
        return same ? null : "It was changed again since in another way, so this is not its current value.";
    }

    private static string Normalize(SettingDef d, JsonNode? n) => d.Key == "notifications.defaults"
        ? string.Join("|", new[] { "channels", "quietCustom", "quietStart", "quietEnd", "digestCustom", "digestTime" }.Select(f => SettingsJson.Text(SettingsJson.Field(n, f))))
        : SettingsJson.Text(n);

    /// <summary>The setting's value now, in the shape its audit rows use (null when it cannot be read back).</summary>
    private async Task<JsonNode?> CurrentAsync(SettingDef d, CancellationToken ct)
    {
        var tid = ctx.RequireTenantId();
        switch (d.Key)
        {
            case var sk when sk.StartsWith("security.", StringComparison.Ordinal) && d.Undo:
                var s = await db.TenantSecuritySettings.AsNoTracking().FirstOrDefaultAsync(x => x.TenantId == tid, ct);
                return new JsonObject
                {
                    ["requireMfa"] = s?.RequireMfa ?? false, ["ipAllowlistEnabled"] = s?.IpAllowlistEnabled ?? false, ["ipRanges"] = s?.IpRanges ?? "",
                    ["minPasswordLength"] = s?.MinPasswordLength ?? 0, ["sessionHours"] = s?.SessionHours ?? 0, ["allowedSignIn"] = s?.AllowedSignIn ?? "", ["seconds"] = s?.RevealSeconds ?? 15,
                };
            case var dk when dk.StartsWith("data.", StringComparison.Ordinal) && d.Undo:
                var p = await db.TenantDataPolicies.AsNoTracking().FirstOrDefaultAsync(ct);
                return new JsonObject
                {
                    ["activityRetentionDays"] = p?.ActivityRetentionDays, ["notificationRetentionDays"] = p?.NotificationRetentionDays,
                    ["chatRetentionDays"] = p?.ChatRetentionDays, ["auditRetentionDays"] = p?.AuditRetentionDays,
                };
            case "workspace.name" or "workspace.description" or "workspace.timeZone" or "workspace.costCurrency" or "access.projectVisibility" or "ai.enabled" or "ai.instructions":
                var t = await db.Tenants.AsNoTracking().Where(x => x.Id == tid)
                    .Select(x => new { x.Name, x.Description, x.TimeZone, x.CostCurrency, x.ProjectVisibility, x.AiDisabled, x.AiInstructions }).FirstAsync(ct);
                return d.Key switch
                {
                    "workspace.timeZone" => t.TimeZone is null ? null : JsonValue.Create(t.TimeZone),
                    "workspace.costCurrency" => t.CostCurrency is null ? null : JsonValue.Create(t.CostCurrency),
                    _ => new JsonObject
                    {
                        ["name"] = t.Name, ["description"] = t.Description, ["projectVisibility"] = (int)t.ProjectVisibility, ["allowed"] = !t.AiDisabled,
                        ["text"] = t.AiInstructions, ["length"] = t.AiInstructions?.Length ?? 0,
                    },
                };
            case "reminders.escalation":
                var r = await db.ReminderPolicies.AsNoTracking().FirstOrDefaultAsync(x => x.TenantId == tid, ct);
                return new JsonObject { ["escalationEnabled"] = r?.EscalationEnabled ?? false, ["steps"] = r?.Steps ?? new ReminderPolicy().Steps };
            case "notifications.defaults":
                var n = await db.WorkspaceNotificationDefaults.AsNoTracking().FirstOrDefaultAsync(x => x.TenantId == tid, ct);
                return JsonSerializer.SerializeToNode(NotificationDefaultsService.Snapshot(n), SettingsJson.Web);
            default:
                return null;
        }
    }

    // ------------------------------------------------------------------ putting the old value back

    private async Task ApplyAsync(SettingDef d, JsonNode? old, CancellationToken ct)
    {
        int? I(string f) => SettingsJson.Int(SettingsJson.Field(old, f));
        string? S(string f) => SettingsJson.Str(SettingsJson.Field(old, f));
        bool B(string f) => SettingsJson.Bool(SettingsJson.Field(old, f));
        switch (d.Key)
        {
            case "security.revealSeconds":
                await services.GetRequiredService<DocumentSecurityService>().SetRevealAsync(new SetRevealRequest(I("seconds") ?? 15), ct);
                return;
            case var securityKey when securityKey.StartsWith("security.", StringComparison.Ordinal):
            {
                var k = securityKey;
                var security = services.GetRequiredService<OrgSecurityService>();
                var now = await security.GetAsync(ct);
                var req = new SetOrgSecurityRequest(now.RequireMfa, now.IpAllowlistEnabled, now.IpRanges, now.MinPasswordLength, now.SessionHours, now.AllowedSignIn);
                req = k switch
                {
                    "security.requireMfa" => req with { RequireMfa = B("requireMfa") },
                    "security.ipAllowlist" => req with { IpAllowlistEnabled = B("ipAllowlistEnabled"), IpRanges = IpAllowlist.ParseEntries(S("ipRanges") ?? "") },
                    "security.minPasswordLength" => req with { MinPasswordLength = I("minPasswordLength") ?? 0 },
                    "security.sessionHours" => req with { SessionHours = I("sessionHours") ?? 0 },
                    "security.allowedSignIn" => req with
                    {
                        AllowedSignIn = string.IsNullOrWhiteSpace(S("allowedSignIn")) ? OrgSecurityService.AllMethods
                            : S("allowedSignIn")!.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
                    },
                    _ => req,
                };
                await security.SetAsync(req, ct);
                return;
            }
            case var dataKey when dataKey.StartsWith("data.", StringComparison.Ordinal):
            {
                var k = dataKey;
                var data = services.GetRequiredService<DataPolicyService>();
                var now = await data.GetAsync(ct);
                var req = new SaveDataPolicyRequest(now.ActivityRetentionDays, now.NotificationRetentionDays, now.ChatRetentionDays, now.AuditRetentionDays);
                req = k switch
                {
                    "data.activity" => req with { ActivityRetentionDays = I("activityRetentionDays") },
                    "data.notifications" => req with { NotificationRetentionDays = I("notificationRetentionDays") },
                    "data.chat" => req with { ChatRetentionDays = I("chatRetentionDays") },
                    "data.audit" => req with { AuditRetentionDays = I("auditRetentionDays") },
                    _ => req,
                };
                await data.SaveAsync(req, ct);
                return;
            }
            case "workspace.name" or "workspace.description":
            {
                var tid = ctx.RequireTenantId();
                var t = await db.Tenants.AsNoTracking().Where(x => x.Id == tid).Select(x => new { x.Name, x.Description }).FirstAsync(ct);
                var name = d.Key == "workspace.name" ? S("name") ?? t.Name : t.Name;
                var description = d.Key == "workspace.description" ? S("description") : t.Description;
                await services.GetRequiredService<WorkspaceService>().UpdateAsync(new UpdateWorkspaceRequest(name, description), ct);
                return;
            }
            case "workspace.timeZone":
                await services.GetRequiredService<WorkspaceService>().SetTimeZoneAsync(new SetWorkspaceTimeZoneRequest(SettingsJson.Str(old)), ct);
                return;
            case "workspace.costCurrency":
                if (SettingsJson.Str(old) is not { Length: > 0 } currency) throw new ConflictException("There was no currency before, so there is nothing to go back to.", "UNDO_NOT_AVAILABLE");
                await services.GetRequiredService<CapacityService>().SetCurrencyAsync(new SetCurrencyRequest(currency), ct);
                return;
            case "access.projectVisibility":
                await services.GetRequiredService<OrgSecurityService>().SetVisibilityAsync(new SetProjectVisibilityRequest(I("projectVisibility") == (int)ProjectVisibility.Teams ? "teams" : "organization"), ct);
                return;
            case "ai.enabled":
                await services.GetRequiredService<AiAssistant>().SetAllowedAsync(B("allowed"), ct);
                return;
            case "ai.instructions":
                await services.GetRequiredService<AiAgent>().SetInstructionsAsync(S("text"), ct);
                return;
            case "reminders.escalation":
                await services.GetRequiredService<ReminderService>().SavePolicyAsync(new SavePolicyRequest(B("escalationEnabled"), S("steps")), ct);
                return;
            case "notifications.defaults":
                var snap = old?.Deserialize<NotificationDefaultsService.DefaultsSnapshot>(SettingsJson.Web) ?? NotificationDefaultsService.Snapshot(null);
                await services.GetRequiredService<NotificationDefaultsService>().RestoreAsync(snap, ct);
                return;
            default:
                throw new ConflictException($"{d.Label} cannot be undone from here.", "UNDO_NOT_SUPPORTED");
        }
    }

    // ------------------------------------------------------------------ words

    private static string Summary(Hit h)
    {
        var d = h.Def;
        if (d.Undo)
        {
            var old = h.Old ?? SettingsCatalog.Initial(d);
            return $"{State(d, old)} → {State(d, h.New)}";
        }
        var verb = h.Row.Action[(h.Row.Action.LastIndexOf('.') + 1)..] switch
        {
            "created" or "added" or "invited" or "provisioned" or "connected" or "installed" or "app_installed" or "mapped" or "app_connected" => "Added",
            "deleted" or "removed" or "revoked" or "deprovisioned" or "disconnected" or "app_disconnected" or "unmapped" or "invitation_revoked" or "logo_removed" or "routing_removed" or "override_removed" => "Removed",
            "secret_rotated" or "rotated" or "data_key_rotated" => "Key rotated",
            "verified" or "domain_verified" => "Verified",
            "joined" => "Joined",
            "reset" or "access_reset" => "Reset to the defaults",
            "role_changed" => "Access level changed",
            "cancelled" => "Cancelled",
            "resumed" => "Resumed",
            "logo_changed" => "New logo",
            "security_reminded" => "Reminders sent",
            _ => "Changed",
        };
        var name = Name(h.New) ?? Name(h.Old);
        return name is null ? verb : $"{verb}: {name}";
    }

    private static string? Name(JsonNode? n)
    {
        foreach (var f in new[] { "name", "title", "displayName", "email", "label", "domain", "role", "plan" })
            if (SettingsJson.Field(n, f) is JsonValue v && v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s))
                return s.Length > 60 ? s[..60] + "…" : s;
        return null;
    }

    /// <summary>The setting's value in a few words.</summary>
    public static string State(SettingDef d, JsonNode? n)
    {
        JsonNode? F(string f) => SettingsJson.Field(n, f);
        static string Days(int? x) => x is null ? "kept forever" : x == 1 ? "1 day" : $"{x:N0} days";
        static string Hours(int h) => h == 0 ? "the platform's session length" : h % 24 == 0 ? (h == 24 ? "1 day" : $"{h / 24} days") : h == 1 ? "1 hour" : $"{h} hours";
        static string Quote(string? s) => string.IsNullOrWhiteSpace(s) ? "empty" : $"“{(s.Length > 40 ? s[..40] + "…" : s)}”";
        switch (d.Key)
        {
            case "security.requireMfa" or "ai.enabled":
                return SettingsJson.Bool(F(d.Fields![0])) ? "On" : "Off";
            case "security.ipAllowlist":
                var count = IpAllowlist.ParseEntries(SettingsJson.Str(F("ipRanges")) ?? "").Count;
                return SettingsJson.Bool(F("ipAllowlistEnabled")) ? $"On, {count} address{(count == 1 ? "" : "es")}" : "Off";
            case "security.minPasswordLength":
                var min = SettingsJson.Int(F("minPasswordLength")) ?? 0;
                return min == 0 ? "the platform's rule" : $"{min} characters";
            case "security.sessionHours":
                return Hours(SettingsJson.Int(F("sessionHours")) ?? 0);
            case "security.allowedSignIn":
                var m = SettingsJson.Str(F("allowedSignIn"));
                return string.IsNullOrWhiteSpace(m) ? "any way" : string.Join(", ", m.Split(',', StringSplitOptions.RemoveEmptyEntries));
            case "security.revealSeconds":
                return $"{SettingsJson.Int(F("seconds")) ?? 15} seconds";
            case var retentionKey when retentionKey.StartsWith("data.", StringComparison.Ordinal):
                return Days(SettingsJson.Int(F(d.Fields![0])));
            case "workspace.name" or "workspace.description":
                return Quote(SettingsJson.Str(F(d.Fields![0])));
            case "workspace.timeZone":
                return SettingsJson.Str(n) ?? "the platform's time zone";
            case "workspace.costCurrency":
                return SettingsJson.Str(n) ?? "none";
            case "access.projectVisibility":
                return SettingsJson.Int(F("projectVisibility")) == (int)ProjectVisibility.Teams ? "by team" : "everyone sees every project";
            case "ai.instructions":
                var len = SettingsJson.Int(F("length")) ?? SettingsJson.Str(F("text"))?.Length ?? 0;
                return len == 0 ? "nothing written" : $"{len:N0} characters";
            case "reminders.escalation":
                return SettingsJson.Bool(F("escalationEnabled")) ? $"on ({SettingsJson.Str(F("steps"))})" : "off";
            case "notifications.defaults":
                var kinds = NotificationDefaultsCodec.Parse(SettingsJson.Str(F("channels"))).Count;
                var parts = new List<string> { kinds == 0 ? "platform channels" : $"{kinds} kind{(kinds == 1 ? "" : "s")} changed" };
                if (SettingsJson.Bool(F("quietCustom"))) parts.Add(SettingsJson.Str(F("quietStart")) is { } qs ? $"quiet {qs}–{SettingsJson.Str(F("quietEnd"))}" : "no quiet hours");
                if (SettingsJson.Bool(F("digestCustom"))) parts.Add(SettingsJson.Str(F("digestTime")) is { } dt ? $"digest at {dt}" : "no digest");
                return string.Join(", ", parts);
            default:
                return "changed";
        }
    }
}

// ====================================================================== safe changes: who a risky switch affects

/// <param name="Kind">security (sign-in rules) or retention.</param>
public record SettingImpactRequest(string Kind, bool? RequireMfa = null, bool? IpAllowlistEnabled = null, IReadOnlyList<string>? IpRanges = null, int? MinPasswordLength = null,
    int? SessionHours = null, IReadOnlyList<string>? AllowedSignIn = null, int? ActivityRetentionDays = null, int? NotificationRetentionDays = null,
    int? ChatRetentionDays = null, int? AuditRetentionDays = null);
public record ImpactPersonDto(Guid UserId, string Name, string Email, string Role, IReadOnlyList<string> Reasons);
public record ImpactRecordsDto(string Label, long Count, DateTime Before);
/// <param name="Enforced">The plan includes the rule, so it takes effect on saving (otherwise it is saved and waits).</param>
public record SettingImpactDto(string Kind, string Headline, int People, IReadOnlyList<ImpactPersonDto> Affected, IReadOnlyList<ImpactRecordsDto> Records,
    bool IncludesYou, string? Warning, bool Enforced, IReadOnlyList<string> Changes);

/// <summary>
/// Before a risky switch is saved (require two-step sign-in, an IP allow-list, stricter passwords, shorter sessions, fewer sign-in methods,
/// shorter retention), who it will affect and how, so nobody is surprised. Nothing is changed here.
/// </summary>
public class SettingsImpactService(IAppDbContext db, ICurrentContext ctx, AppClock clock, EntitlementService entitlements)
{
    public async Task<SettingImpactDto> ImpactAsync(SettingImpactRequest req, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only owners and admins can preview setting changes.", "PERMISSION_DENIED");
        return (req.Kind ?? "").Trim().ToLowerInvariant() switch
        {
            "security" => await SecurityAsync(tid, req, ct),
            "retention" => await RetentionAsync(tid, req, ct),
            _ => throw new ValidationException("kind", "Preview security or retention."),
        };
    }

    private async Task<SettingImpactDto> SecurityAsync(Guid tid, SettingImpactRequest req, CancellationToken ct)
    {
        var now = clock.Now;
        var cur = await db.TenantSecuritySettings.AsNoTracking().FirstOrDefaultAsync(s => s.TenantId == tid, ct) ?? new TenantSecuritySettings { TenantId = tid };
        var requireMfa = req.RequireMfa ?? cur.RequireMfa;
        var ipOn = req.IpAllowlistEnabled ?? cur.IpAllowlistEnabled;
        var ranges = req.IpRanges is null ? IpAllowlist.ParseEntries(cur.IpRanges) : IpAllowlist.ParseEntries(string.Join('\n', req.IpRanges));
        var minLength = req.MinPasswordLength ?? cur.MinPasswordLength;
        var hours = req.SessionHours ?? cur.SessionHours;
        var methods = req.AllowedSignIn is { Count: > 0 } wanted ? wanted.Select(m => m.Trim().ToLowerInvariant()).ToHashSet()
            : req.AllowedSignIn is null && cur.AllowedSignIn.Length > 0 ? cur.AllowedSignIn.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToHashSet()
            : OrgSecurityService.AllMethods.ToHashSet();
        var curMethods = cur.AllowedSignIn.Length > 0 ? cur.AllowedSignIn.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToHashSet() : OrgSecurityService.AllMethods.ToHashSet();
        var curRanges = IpAllowlist.ParseEntries(cur.IpRanges);

        var changes = new List<string>();
        if (requireMfa && !cur.RequireMfa) changes.Add("Two-step sign-in becomes required.");
        if (ipOn && (!cur.IpAllowlistEnabled || !ranges.SequenceEqual(curRanges))) changes.Add($"Only {ranges.Count} listed network{(ranges.Count == 1 ? "" : "s")} may open the workspace.");
        if (minLength > 0 && minLength > cur.MinPasswordLength) changes.Add($"Passwords need at least {minLength} characters.");
        if (hours > 0 && (cur.SessionHours == 0 || hours < cur.SessionHours)) changes.Add($"Everyone signs in again after {(hours % 24 == 0 ? $"{hours / 24} day(s)" : $"{hours} hour(s)")}.");
        if (methods.Count < curMethods.Count || !methods.IsSupersetOf(curMethods)) changes.Add($"Only {string.Join(", ", methods.OrderBy(m => m))} sign-in is accepted.");

        var people = await (from m in db.TenantMembers.AsNoTracking()
                            join u in db.Users.AsNoTracking() on m.UserId equals u.Id
                            where m.TenantId == tid && u.IsActive
                            select new { u.Id, u.DisplayName, u.Email, m.Role, u.MfaEnabled, u.PasswordLength, u.PasswordHash }).Take(3000).ToListAsync(ct);
        var ids = people.Select(p => p.Id).ToList();
        var passkeys = await db.PasskeyCredentials.AsNoTracking().Where(k => ids.Contains(k.UserId)).Select(k => k.UserId).Distinct().ToListAsync(ct);
        var since = now.AddDays(-30);
        var sessions = await db.UserSessions.AsNoTracking().Where(s => ids.Contains(s.UserId) && s.LastSeenAt >= since)
            .Select(s => new { s.UserId, s.IpAddress, s.AuthMethod, s.CreatedAt, s.RevokedAt, s.ExpiresAt, s.SsoTenantId }).ToListAsync(ct);
        var byUser = sessions.GroupBy(s => s.UserId).ToDictionary(g => g.Key, g => g.ToList());

        var affected = new List<ImpactPersonDto>();
        foreach (var p in people.OrderBy(x => x.DisplayName))
        {
            var reasons = new List<string>();
            var mine = byUser.GetValueOrDefault(p.Id) ?? [];
            if (requireMfa && !cur.RequireMfa && !p.MfaEnabled && !passkeys.Contains(p.Id) && !mine.Any(s => s.SsoTenantId == tid))
                reasons.Add("Has no two-step sign-in: is asked to set it up before entering.");
            if (ipOn && (!cur.IpAllowlistEnabled || !ranges.SequenceEqual(curRanges)))
            {
                var outside = mine.Select(s => s.IpAddress).Where(ip => !string.IsNullOrEmpty(ip) && !IpAllowlist.Matches(ranges, ip)).Distinct().ToList();
                if (outside.Count > 0) reasons.Add($"Recently signed in from {string.Join(", ", outside.Take(3))}, which is not on the list: is blocked from there.");
            }
            if (minLength > 0 && minLength > cur.MinPasswordLength && !string.IsNullOrEmpty(p.PasswordHash) && p.PasswordLength is { } len && len < minLength)
                reasons.Add($"Password has {len} characters: must change it to enter (when signing in with it).");
            if (hours > 0 && (cur.SessionHours == 0 || hours < cur.SessionHours))
            {
                var cutoff = now.AddHours(-hours);
                if (mine.Any(s => s.RevokedAt == null && s.ExpiresAt > now && s.CreatedAt < cutoff)) reasons.Add("Signed in longer ago than that: is asked to sign in again.");
            }
            if (methods.Count < OrgSecurityService.AllMethods.Length)
            {
                var used = mine.Select(s => OrgSecurityService.Category(s.AuthMethod)).Where(m => m != "device").Distinct().ToList();
                if (used.Count > 0 && !used.Any(methods.Contains)) reasons.Add($"Signs in with {string.Join(" or ", used)}, which would no longer be accepted.");
            }
            if (reasons.Count > 0) affected.Add(new ImpactPersonDto(p.Id, p.DisplayName, p.Email, p.Role.ToString(), reasons));
        }
        var you = affected.Any(a => a.UserId == ctx.UserId);
        var enforced = await entitlements.GetValueAsync(FeatureKeys.AdvancedSecurity, ct) > 0;
        var headline = changes.Count == 0 ? "Nothing gets stricter, so nobody is affected."
            : affected.Count == 0 ? "Nobody is affected: everyone already meets the new rules."
            : $"{affected.Count} of {people.Count} member{(people.Count == 1 ? "" : "s")} would be affected.";
        return new SettingImpactDto("security", headline, affected.Count, affected.Take(200).ToList(), [], you,
            you ? "This includes you. Fix it for your own account first, or you would be locked out (saving will refuse it)." : null, enforced, changes);
    }

    private async Task<SettingImpactDto> RetentionAsync(Guid tid, SettingImpactRequest req, CancellationToken ct)
    {
        var now = clock.Now;
        var cur = await db.TenantDataPolicies.AsNoTracking().FirstOrDefaultAsync(ct);
        var records = new List<ImpactRecordsDto>();
        var changes = new List<string>();
        async Task Add(string label, int? days, int? was, Func<DateTime, Task<long>> count)
        {
            if (days is not { } d || (was is { } w && w <= d)) return;
            var before = now.AddDays(-d);
            changes.Add($"{label} older than {d:N0} days {(was is null ? "(kept forever until now)" : $"(kept {was:N0} days until now)")}.");
            records.Add(new ImpactRecordsDto(label, await count(before), before));
        }
        await Add("Activity entries", req.ActivityRetentionDays, cur?.ActivityRetentionDays, async b => await db.Activities.AsNoTracking().LongCountAsync(x => x.TenantId == tid && x.CreatedAt < b, ct));
        await Add("Notifications", req.NotificationRetentionDays, cur?.NotificationRetentionDays, async b => await db.Notifications.AsNoTracking().LongCountAsync(x => x.TenantId == tid && x.CreatedAt < b, ct));
        await Add("Chat messages", req.ChatRetentionDays, cur?.ChatRetentionDays, async b => await db.ChatMessages.AsNoTracking().LongCountAsync(x => x.TenantId == tid && x.CreatedAt < b, ct));
        await Add("Audit log rows", req.AuditRetentionDays, cur?.AuditRetentionDays, async b => await db.AuditLogs.AsNoTracking().LongCountAsync(x => x.TenantId == tid && x.CreatedAt < b, ct));
        var total = records.Sum(r => r.Count);
        var headline = records.Count == 0 ? "Nothing is kept for a shorter time, so nothing more is deleted."
            : total == 0 ? "Nothing is old enough to be deleted yet."
            : $"{total:N0} record{(total == 1 ? "" : "s")} would be deleted permanently at the next nightly clean-up.";
        return new SettingImpactDto("retention", headline, 0, [], records, false, total > 0 ? "Deleted records cannot be brought back. Export first if you may need them." : null, true, changes);
    }
}

// ====================================================================== setup health

public record SetupFixDto(string Label, string To);
/// <param name="Action">An extra one-click fix the screen can run ("remind-two-step").</param>
public record SetupCheckDto(string Id, string Title, string Detail, string Severity, bool Ok, bool Dismissed, string? DismissReason, SetupFixDto? Fix, string? Action, string? ActionLabel, bool CanDismiss);
public record SetupHealthDto(int Score, int Done, int Total, int Open, IReadOnlyList<SetupCheckDto> Checks);
public record DismissCheckRequest(string? Reason);

/// <summary>
/// Setup health: a short checklist of what this workspace still lacks (two-step sign-in not required, no backup admin, WhatsApp not
/// connected, webhooks without signing, stale API keys...), each with the button that fixes it. A check that does not apply can be
/// marked "not needed here". Owners and admins only.
/// </summary>
public class SetupHealthService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, EntitlementService entitlements, IServiceProvider services)
{
    public static readonly string[] Ids = ["two-step", "backup-admin", "audit-chain", "webhook-signing", "api-keys", "whatsapp", "time-zone", "retention", "logo"];

    private void RequireAdmin()
    {
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only owners and admins can see setup health.", "PERMISSION_DENIED");
    }

    public async Task<SetupHealthDto> GetAsync(CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        RequireAdmin();
        var now = clock.Now;
        var personal = ctx.WorkspaceType == WorkspaceType.Personal;
        var tenant = await db.Tenants.AsNoTracking().Where(t => t.Id == tid).Select(t => new { t.TimeZone, t.LogoKey }).FirstAsync(ct);
        var security = await db.TenantSecuritySettings.AsNoTracking().FirstOrDefaultAsync(s => s.TenantId == tid, ct);
        var dismissed = await db.SetupCheckDismissals.AsNoTracking().Where(x => x.TenantId == tid).ToDictionaryAsync(x => x.CheckId, x => x.Reason, ct);
        var checks = new List<SetupCheckDto>();
        SetupCheckDto Check(string id, string title, string detail, string severity, bool ok, SetupFixDto? fix, bool canDismiss = true, string? action = null, string? actionLabel = null) =>
            new(id, title, detail, severity, ok, !ok && canDismiss && dismissed.ContainsKey(id), dismissed.GetValueOrDefault(id), ok ? null : fix, ok ? null : action, ok ? null : actionLabel, canDismiss);

        var members = await (from m in db.TenantMembers.AsNoTracking()
                             join u in db.Users.AsNoTracking() on m.UserId equals u.Id
                             where m.TenantId == tid && u.IsActive
                             select new { u.Id, u.DisplayName, m.Role, u.MfaEnabled }).ToListAsync(ct);
        var ids = members.Select(m => m.Id).ToList();
        var withPasskey = await db.PasskeyCredentials.AsNoTracking().Where(k => ids.Contains(k.UserId)).Select(k => k.UserId).Distinct().ToListAsync(ct);
        var without = members.Count(m => !m.MfaEnabled && !withPasskey.Contains(m.Id));

        // 1. Two-step sign-in required for everyone.
        var advanced = await entitlements.GetValueAsync(FeatureKeys.AdvancedSecurity, ct) > 0;
        if (!personal)
        {
            var on = security?.RequireMfa == true && advanced;
            checks.Add(Check("two-step", on ? "Two-step sign-in is required" : "Two-step sign-in is not required",
                on ? $"Everyone signs in with a second step. {(without == 0 ? "All members have it." : $"{without} still need to set it up on their next visit.")}"
                : advanced ? $"{(without == 0 ? "Every member already uses it, so requiring it changes nothing for them today and protects new members." : $"{without} of {members.Count} members sign in with a password alone.")} A stolen password is then enough to get in."
                : "Requiring it for everyone is part of the Business plan and above. Until then, ask members to turn it on themselves.",
                "high", on,
                advanced ? new SetupFixDto("Require two-step", "/settings/security#s-security.requireMfa") : new SetupFixDto("See plans", "/settings/billing"),
                action: without > 0 ? "remind-two-step" : null, actionLabel: without > 0 ? $"Remind {without} member{(without == 1 ? "" : "s")}" : null));
        }

        // 2. A second person who can manage the workspace.
        if (!personal)
        {
            var admins = members.Where(m => m.Role is TenantRole.Owner or TenantRole.Admin).ToList();
            checks.Add(Check("backup-admin", admins.Count >= 2 ? "There is a backup admin" : "No backup admin",
                admins.Count >= 2 ? $"{admins.Count} people can manage this workspace." : $"Only {admins.FirstOrDefault()?.DisplayName ?? "one person"} can manage settings, members and billing. If they are away or leave, nobody can.",
                "high", admins.Count >= 2, new SetupFixDto("Make someone an admin", "/settings/members")));
        }

        // 3. The tamper-evident audit trail.
        var broken = security?.ChainBrokenAt;
        checks.Add(Check("audit-chain", broken is null ? "The audit trail is intact" : "The audit trail failed its tamper check",
            broken is null ? security?.ChainVerifiedAt is { } at ? $"Last checked {at:d MMM yyyy}." : "It is checked every night." : $"A row was changed or removed outside the app (found {broken:d MMM yyyy}). Find out who had database access.",
            "high", broken is null, new SetupFixDto("Open the audit log", "/settings/audit"), canDismiss: false));

        // 4. Webhooks that cannot prove where they came from.
        var unsignedIn = await db.IncomingWebhooks.AsNoTracking().CountAsync(w => w.TenantId == tid && w.IsActive && w.SecretProtected == null, ct);
        var plainOut = await db.Webhooks.AsNoTracking().CountAsync(w => w.TenantId == tid && w.IsActive && w.Url.StartsWith("http://"), ct);
        var anyHooks = unsignedIn + plainOut > 0 || await db.Webhooks.AnyAsync(w => w.TenantId == tid, ct) || await db.IncomingWebhooks.AnyAsync(w => w.TenantId == tid, ct);
        var hookProblems = new List<string>();
        if (unsignedIn > 0) hookProblems.Add($"{unsignedIn} incoming address{(unsignedIn == 1 ? "" : "es")} accept{(unsignedIn == 1 ? "s" : "")} requests without a secret or signature, so anyone who learns the address can create work");
        if (plainOut > 0) hookProblems.Add($"{plainOut} webhook{(plainOut == 1 ? "" : "s")} send{(plainOut == 1 ? "s" : "")} to an address without https, so the data travels unencrypted");
        checks.Add(Check("webhook-signing", hookProblems.Count == 0 ? "Webhooks are signed" : "Webhooks without signing",
            hookProblems.Count > 0 ? string.Join(". ", hookProblems) + "." : anyHooks ? "Every outgoing request is signed and every incoming address checks a secret." : "No webhooks yet. Outgoing ones are always signed.",
            "medium", hookProblems.Count == 0, new SetupFixDto(unsignedIn > 0 ? "Add a secret" : "Fix the address", "/settings/webhooks")));

        // 5. API keys nobody uses.
        var stale = await db.ApiKeys.AsNoTracking().Where(k => k.TenantId == tid && k.RevokedAt == null && (k.ExpiresAt == null || k.ExpiresAt > now)
            && ((k.LastUsedAt != null && k.LastUsedAt < now.AddDays(-90)) || (k.LastUsedAt == null && k.CreatedAt < now.AddDays(-30)))).CountAsync(ct);
        checks.Add(Check("api-keys", stale == 0 ? "No forgotten API keys" : "API keys nobody uses",
            stale == 0 ? "Every active key was used in the last 90 days." : $"{stale} key{(stale == 1 ? " has" : "s have")} not been used for 90 days (or never). A forgotten key is a door left open: revoke what is not needed.",
            "medium", stale == 0, new SetupFixDto("Review API keys", "/settings/api-keys")));

        // 6. WhatsApp for customers and notifications.
        if (!personal)
        {
            var wa = await db.WhatsAppConnections.AsNoTracking().AnyAsync(w => w.TenantId == tid && w.Active, ct);
            checks.Add(Check("whatsapp", wa ? "WhatsApp is connected" : "WhatsApp is not connected",
                wa ? "Customers can chat with your team and members can get notifications on WhatsApp." : "Connect your business number so customers reach the support desk on WhatsApp and members can get reminders there.",
                "medium", wa, new SetupFixDto("Connect WhatsApp", "/settings/whatsapp")));
        }

        // 7. The workspace's own time zone.
        checks.Add(Check("time-zone", tenant.TimeZone is null ? "No workspace time zone" : "The workspace time zone is set",
            tenant.TimeZone is null ? "Digests, reminders and service-level clocks for people without their own zone follow the platform's. Set yours so they run on your working hours." : $"Things run on {tenant.TimeZone} time for people without their own zone.",
            "low", tenant.TimeZone is not null, new SetupFixDto("Set the time zone", "/settings/general#s-workspace.timeZone")));

        // 8. How long history is kept.
        var policy = await db.TenantDataPolicies.AsNoTracking().FirstOrDefaultAsync(ct);
        var anyRetention = policy is not null && (policy.ActivityRetentionDays ?? policy.NotificationRetentionDays ?? policy.ChatRetentionDays ?? policy.AuditRetentionDays) is not null;
        checks.Add(Check("retention", anyRetention ? "Retention is set" : "History is kept forever",
            anyRetention ? "Old records are cleaned up every night by your rules." : "Activity, notifications and chat are kept forever. Many companies keep personal data only as long as needed; set how long.",
            "low", anyRetention, new SetupFixDto("Set retention", "/settings/data")));

        // 9. The workspace's look.
        if (!personal)
            checks.Add(Check("logo", tenant.LogoKey is null ? "No logo yet" : "Your logo is set",
                tenant.LogoKey is null ? "Your logo appears in the top bar, on e-mails and on the sign-in page for your people." : "It shows in the top bar and on e-mails.",
                "low", tenant.LogoKey is not null, new SetupFixDto("Add your logo", "/settings/general#s-workspace.logo")));

        static int Weight(string s) => s == "high" ? 3 : s == "medium" ? 2 : 1;
        var total = checks.Sum(c => Weight(c.Severity));
        var done = checks.Where(c => c.Ok || c.Dismissed).Sum(c => Weight(c.Severity));
        var order = checks.OrderBy(c => c.Ok || c.Dismissed).ThenByDescending(c => Weight(c.Severity)).ToList();
        return new SetupHealthDto(total == 0 ? 100 : (int)Math.Round(100.0 * done / total), checks.Count(c => c.Ok || c.Dismissed), checks.Count, checks.Count(c => !c.Ok && !c.Dismissed), order);
    }

    public async Task<SetupHealthDto> DismissAsync(string id, DismissCheckRequest req, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        RequireAdmin();
        if (!Ids.Contains(id)) throw new NotFoundException("There is no such check.");
        if (id == "audit-chain") throw new ValidationException("id", "A broken audit trail cannot be marked as not needed.");
        if (!await db.SetupCheckDismissals.AnyAsync(x => x.TenantId == tid && x.CheckId == id, ct))
        {
            var reason = string.IsNullOrWhiteSpace(req.Reason) ? null : req.Reason.Trim()[..Math.Min(200, req.Reason.Trim().Length)];
            db.SetupCheckDismissals.Add(new SetupCheckDismissal { TenantId = tid, CheckId = id, Reason = reason, CreatedAt = clock.Now, CreatedBy = ctx.UserId });
            recorder.Audit("settings.check_dismissed", "SetupCheckDismissal", null, null, new { check = id, reason }, tenantId: tid);
            await db.SaveChangesAsync(ct);
        }
        return await GetAsync(ct);
    }

    public async Task<SetupHealthDto> RestoreAsync(string id, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        RequireAdmin();
        var row = await db.SetupCheckDismissals.FirstOrDefaultAsync(x => x.TenantId == tid && x.CheckId == id, ct);
        if (row is not null)
        {
            db.SetupCheckDismissals.Remove(row);
            recorder.Audit("settings.check_restored", "SetupCheckDismissal", row.Id, new { check = id }, null, tenantId: tid);
            await db.SaveChangesAsync(ct);
        }
        return await GetAsync(ct);
    }

    /// <summary>The "Remind them" fix: a reminder to every member without two-step sign-in (at most once a day each).</summary>
    public async Task<int> RemindTwoStepAsync(CancellationToken ct = default)
    {
        RequireAdmin();
        var security = services.GetRequiredService<OrgSecurityService>();
        var overview = await security.OverviewAsync(ct);
        var ids = overview.People.Where(p => p.Issues.Contains("no-two-step")).Select(p => p.UserId).ToList();
        if (ids.Count == 0) return 0;
        return await security.RemindAsync(new SecurityReminderRequest(ids, "two-step"), ct);
    }
}
