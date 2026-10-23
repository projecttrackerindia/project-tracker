using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Features.Sso;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Integrations;

/// <summary>
/// How a request becomes work. Each text is a template: plain words with <c>{{path.in.the.request}}</c> placeholders (array items by number:
/// <c>{{alerts.0.labels.host}}</c>; <c>{{$body}}</c> is the whole request). <see cref="PriorityMap"/> turns the priority text into a priority
/// ("P1" → Critical); without it, common words are understood. <see cref="DedupeKey"/> decides what counts as a repeat. A request whose
/// <see cref="ResolveWhen"/> text is one of <see cref="ResolveValues"/> ("resolved", "ok") closes the open item instead of creating one.
/// </summary>
public record IncomingMapping(string? Title = null, string? Description = null, string? Priority = null, Dictionary<string, string>? PriorityMap = null,
    string? DedupeKey = null, string? Assignee = null, string? ResolveWhen = null, string? ResolveValues = null);

public record IncomingWebhookDto(Guid Id, string Name, string Url, string Target, Guid? ProjectId, string? ProjectName, Guid? WorkTypeId, string? WorkTypeName,
    Guid? AssigneeId, string? AssigneeName, Priority DefaultPriority, IncomingMapping Mapping, int MergeMinutes, bool IsActive, bool RequiresSecret,
    Guid ActingUserId, string? ActingName, int Received, int CreatedCount, int MergedCount, DateTime? LastReceivedAt, string? LastError, bool HasSample, DateTime CreatedAt);
public record CreatedIncomingWebhookDto(IncomingWebhookDto Hook, string? Secret);
/// <summary><see cref="RequireSecret"/>: true creates a secret (shown once), false removes it, null keeps it. <see cref="RaiseAsMe"/>: work is raised as the person saving.</summary>
public record SaveIncomingWebhookRequest(string? Name, string? Target, Guid? ProjectId, Guid? WorkTypeId, Guid? AssigneeId, Priority? DefaultPriority, IncomingMapping? Mapping,
    int? MergeMinutes, bool? IsActive, bool? RequireSecret, bool? RaiseAsMe = null);
public record IncomingPreviewRequest(IncomingMapping? Mapping, string? Sample, Priority? DefaultPriority);
public record IncomingPreviewDto(string Title, string? Description, Priority Priority, string DedupeKey, string? Assignee, bool Resolves, IReadOnlyList<string> Problems,
    IReadOnlyList<IncomingField> Fields);
/// <summary>One value in an example request, with the placeholder that inserts it.</summary>
public record IncomingField(string Path, string Placeholder, string Value);
public record IncomingEventDto(Guid Id, DateTime ReceivedAt, string Status, string? Title, string? DedupeKey, string? TargetType, Guid? TargetId, string? TargetKey, string? Error, int? Count);
public record IncomingEventPageDto(IReadOnlyList<IncomingEventDto> Items, int Total, int Page, int PageSize);
/// <param name="Error">Why nothing was raised (failed or ignored), so the sending system can log it.</param>
public record IncomingReceipt(string Status, string? Key, int? Count, string? Error = null);

/// <summary>Turns an example request into a guess at the mapping, renders templates, and reads requests of any common shape.</summary>
public static class IncomingTemplates
{
    private static readonly Regex Placeholder = new(@"\{\{\s*([^{}]+?)\s*\}\}", RegexOptions.Compiled);

    /// <summary>JSON as it is; a form (a "payload" field holding JSON is opened); anything else becomes {"text": …}.</summary>
    public static JsonNode Parse(string body, string? contentType)
    {
        var text = body.Trim();
        if (text.StartsWith('{') || text.StartsWith('[') || (contentType ?? "").Contains("json", StringComparison.OrdinalIgnoreCase))
        {
            try { if (JsonNode.Parse(text) is { } json) return json; } catch (JsonException) { /* not JSON after all */ }
        }
        if ((contentType ?? "").Contains("x-www-form-urlencoded", StringComparison.OrdinalIgnoreCase) || (text.Contains('=') && !text.Contains(' ') && !text.Contains('\n')))
        {
            var form = new JsonObject();
            foreach (var pair in text.Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                var kv = pair.Split('=', 2);
                var key = Uri.UnescapeDataString(kv[0].Replace('+', ' '));
                var value = kv.Length > 1 ? Uri.UnescapeDataString(kv[1].Replace('+', ' ')) : "";
                if (key.Length == 0 || form.ContainsKey(key)) continue;
                if (key == "payload" && value.TrimStart().StartsWith('{')) { try { if (JsonNode.Parse(value) is JsonObject p) return p; } catch (JsonException) { } }
                form[key] = value;
            }
            if (form.Count > 0) return form;
        }
        return new JsonObject { ["text"] = text.Length > 4000 ? text[..4000] : text };
    }

    public static JsonNode? At(JsonNode? node, string path)
    {
        foreach (var part in path.Split('.', StringSplitOptions.RemoveEmptyEntries))
        {
            node = node switch
            {
                JsonObject o => o.TryGetPropertyValue(part, out var v) ? v : o.FirstOrDefault(p => string.Equals(p.Key, part, StringComparison.OrdinalIgnoreCase)).Value,
                JsonArray a when int.TryParse(part, NumberStyles.None, CultureInfo.InvariantCulture, out var i) && i < a.Count => a[i],
                _ => null,
            };
            if (node is null) return null;
        }
        return node;
    }

    public static string Value(JsonNode? n) => n switch
    {
        null => "",
        JsonValue v when v.GetValueKind() == JsonValueKind.String => v.GetValue<string>(),
        JsonValue v => v.ToJsonString(),
        _ => n.ToJsonString(),
    };

    public static string Render(string? template, JsonNode body)
    {
        if (string.IsNullOrEmpty(template)) return "";
        return Placeholder.Replace(template, m =>
        {
            var path = m.Groups[1].Value.Trim();
            if (path == "$body") { var all = body.ToJsonString(); return all.Length > 3000 ? all[..3000] + "…" : all; }
            return Value(At(body, path));
        }).Trim();
    }

    public static IReadOnlyList<string> PathsIn(string? template) => string.IsNullOrEmpty(template) ? [] : Placeholder.Matches(template).Select(m => m.Groups[1].Value.Trim()).ToList();

    /// <summary>Priority from what a sender wrote: its own map first, then common words (P1, critical, sev2, warning, info…).</summary>
    public static Priority? PriorityOf(string? text, Dictionary<string, string>? map)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var t = text.Trim();
        if (map is not null && map.FirstOrDefault(kv => string.Equals(kv.Key.Trim(), t, StringComparison.OrdinalIgnoreCase)) is { Key: not null } hit
            && Enum.TryParse<Priority>(hit.Value, true, out var mapped)) return mapped;
        if (Enum.TryParse<Priority>(t, true, out var direct) && Enum.IsDefined(direct) && !int.TryParse(t, out _)) return direct;
        return t.ToLowerInvariant() switch
        {
            "p0" or "p1" or "sev0" or "sev1" or "sev 1" or "fatal" or "emergency" or "critical" or "crit" or "disaster" or "blocker" or "urgent" or "1" => Priority.Critical,
            "p2" or "sev2" or "sev 2" or "error" or "err" or "major" or "high" or "2" => Priority.High,
            "p3" or "sev3" or "sev 3" or "warning" or "warn" or "minor" or "average" or "medium" or "moderate" or "3" => Priority.Medium,
            "p4" or "p5" or "sev4" or "info" or "information" or "notice" or "low" or "debug" or "4" or "5" => Priority.Low,
            _ => null,
        };
    }

    /// <summary>Every value in an example request (first 200), with its placeholder, to click into a template.</summary>
    public static IReadOnlyList<IncomingField> Fields(JsonNode body)
    {
        var list = new List<IncomingField>();
        void Walk(JsonNode? n, string path, int depth)
        {
            if (list.Count >= 200 || depth > 6) return;
            switch (n)
            {
                case JsonObject o: foreach (var (k, v) in o) Walk(v, path.Length == 0 ? k : $"{path}.{k}", depth + 1); break;
                case JsonArray a: for (var i = 0; i < Math.Min(a.Count, 5); i++) Walk(a[i], $"{path}.{i}", depth + 1); break;
                case null: break;
                default:
                    var text = Value(n);
                    list.Add(new IncomingField(path, $"{{{{{path}}}}}", text.Length > 120 ? text[..120] + "…" : text));
                    break;
            }
        }
        Walk(body, "", 0);
        return list;
    }

    private static string? Find(JsonNode body, params string[] keys)
    {
        var fields = Fields(body);
        foreach (var key in keys)
        {
            var hit = fields.FirstOrDefault(f => f.Value.Length > 0 && (string.Equals(f.Path, key, StringComparison.OrdinalIgnoreCase)
                || f.Path.EndsWith("." + key, StringComparison.OrdinalIgnoreCase)));
            if (hit is not null) return hit.Path;
        }
        return null;
    }

    /// <summary>A first mapping from an example: the title, a "where" (host, service), the details, the priority, what makes a repeat, and resolved alerts.</summary>
    public static IncomingMapping Suggest(JsonNode body)
    {
        var title = Find(body, "title", "summary", "subject", "alertname", "alert_name", "alertName", "ruleName", "rule_name", "name", "event", "message", "error", "text");
        var where = Find(body, "host", "hostname", "instance", "service", "server", "job", "application", "app");
        var details = Find(body, "description", "details", "detail", "body", "message", "text", "stack", "stacktrace", "output");
        if (details == title) details = Find(body, "description", "details", "detail", "body", "stack", "output");
        var priority = Find(body, "priority", "severity", "level", "urgency", "sev");
        var dedupe = Find(body, "fingerprint", "dedup_key", "dedupKey", "incident_key", "incidentKey", "alert_id", "alertId", "groupKey", "correlation_id", "correlationId");
        var status = Find(body, "status", "state", "event_type");
        var assignee = Find(body, "assignee", "owner", "assigned_to", "email");
        var t = title is null ? "Alert" : $"{{{{{title}}}}}";
        if (where is not null && where != title) t += $" on {{{{{where}}}}}";
        return new IncomingMapping(t, details is null ? null : $"{{{{{details}}}}}", priority is null ? null : $"{{{{{priority}}}}}", null,
            dedupe is null ? null : $"{{{{{dedupe}}}}}", assignee is null ? null : $"{{{{{assignee}}}}}",
            status is null ? null : $"{{{{{status}}}}}", status is null ? null : "resolved,ok,closed,recovered");
    }

    public static bool Resolves(IncomingMapping m, JsonNode body)
    {
        if (string.IsNullOrWhiteSpace(m.ResolveWhen) || string.IsNullOrWhiteSpace(m.ResolveValues)) return false;
        var v = Render(m.ResolveWhen, body);
        return v.Length > 0 && m.ResolveValues.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Any(x => string.Equals(x, v, StringComparison.OrdinalIgnoreCase));
    }

    public static string Cut(string? s, int max) => s is null ? "" : s.Length <= max ? s : s[..(max - 1)] + "…";
}

/// <summary>
/// Incoming webhooks: private addresses other systems post to. A request becomes an Operations ticket, a project task or a reminder by the
/// address's mapping; a repeat of something still open is merged into it with a count; a "resolved" request closes it. Owners and admins set
/// them up, on plans with API access. The work is raised as the member who set the address up.
/// </summary>
public class IncomingWebhookService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, EntitlementService entitlements, ISecretProtector protector,
    IOptions<AppOptions> app)
{
    public const int MaxHooks = 20;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public static readonly string[] Targets = ["ticket", "task", "reminder"];

    private void RequireAdmin()
    {
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only owners and admins can manage incoming webhooks.", "PERMISSION_DENIED");
    }

    public static IncomingMapping MappingOf(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new();
        try { return JsonSerializer.Deserialize<IncomingMapping>(json, Json) ?? new(); } catch (JsonException) { return new(); }
    }

    private string UrlOf(IncomingWebhook h) => $"{PublicUrls.Api(app.Value)}/api/v1/hooks/in/{h.Token}";
    private static string NewToken() => Convert.ToHexString(RandomNumberGenerator.GetBytes(20)).ToLowerInvariant();

    private async Task<IReadOnlyList<IncomingWebhookDto>> DtosAsync(List<IncomingWebhook> hooks, CancellationToken ct)
    {
        var projects = hooks.Where(h => h.ProjectId != null).Select(h => h.ProjectId!.Value).Distinct().ToList();
        var types = hooks.Where(h => h.WorkTypeId != null).Select(h => h.WorkTypeId!.Value).Distinct().ToList();
        var people = hooks.SelectMany(h => new[] { h.AssigneeId, (Guid?)h.ActingUserId }).Where(x => x != null).Select(x => x!.Value).Distinct().ToList();
        var pn = await db.Projects.AsNoTracking().Where(p => projects.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => p.Name, ct);
        var tn = await db.WorkTypes.AsNoTracking().Where(t => types.Contains(t.Id)).ToDictionaryAsync(t => t.Id, t => t.Name, ct);
        var un = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return hooks.Select(h => new IncomingWebhookDto(h.Id, h.Name, UrlOf(h), h.Target, h.ProjectId, h.ProjectId is { } p ? pn.GetValueOrDefault(p) : null,
            h.WorkTypeId, h.WorkTypeId is { } t ? tn.GetValueOrDefault(t) : null, h.AssigneeId, h.AssigneeId is { } a ? un.GetValueOrDefault(a) : null,
            Enum.TryParse<Priority>(h.DefaultPriority, out var pr) ? pr : Priority.Medium, MappingOf(h.Mapping), h.MergeMinutes, h.IsActive, h.SecretProtected is not null,
            h.ActingUserId, un.GetValueOrDefault(h.ActingUserId), h.Received, h.CreatedCount, h.MergedCount, h.LastReceivedAt, h.LastError, h.Sample is not null, h.CreatedAt)).ToList();
    }

    public async Task<IReadOnlyList<IncomingWebhookDto>> ListAsync(CancellationToken ct = default)
    {
        RequireAdmin();
        return await DtosAsync(await db.IncomingWebhooks.AsNoTracking().OrderBy(h => h.CreatedAt).ToListAsync(ct), ct);
    }

    private async Task ApplyAsync(IncomingWebhook h, SaveIncomingWebhookRequest req, CancellationToken ct)
    {
        var name = (req.Name ?? h.Name).Trim();
        if (name.Length is < 1 or > 60) throw new ValidationException("name", "Name the address after what posts to it (up to 60 characters), e.g. Grafana alerts.");
        var target = (req.Target ?? h.Target).Trim().ToLowerInvariant();
        if (!Targets.Contains(target)) throw new ValidationException("target", "Choose a ticket, a task or a reminder.");
        if (target == "task" && (req.ProjectId ?? h.ProjectId) is null) throw new ValidationException("projectId", "Choose the project the tasks go into.");
        var project = req.ProjectId ?? (req.Target is not null ? null : h.ProjectId);
        if (project is { } pid && !await db.Projects.AsNoTracking().AnyAsync(p => p.Id == pid, ct)) throw new ValidationException("projectId", "That project was not found.");
        if (req.WorkTypeId is { } wt && !await db.WorkTypes.AsNoTracking().AnyAsync(t => t.Id == wt && t.IsActive, ct)) throw new ValidationException("workTypeId", "That work type was not found.");
        if (req.AssigneeId is { } who && !await db.TenantMembers.AsNoTracking().AnyAsync(m => m.UserId == who && m.Role != TenantRole.Guest, ct)) throw new ValidationException("assigneeId", "That person is not a member of this workspace.");
        var minutes = req.MergeMinutes ?? h.MergeMinutes;
        if (minutes is < 0 or > 43200) throw new ValidationException("mergeMinutes", "Merge repeats for up to 30 days (0 never merges).");
        if (req.Mapping is { } m)
        {
            var json = JsonSerializer.Serialize(m, Json);
            if (json.Length > 4000) throw new ValidationException("mapping", "The mapping is too long.");
            if (m.PriorityMap is { } map && map.Values.Any(v => !Enum.TryParse<Priority>(v, true, out _))) throw new ValidationException("mapping", "Priorities are Low, Medium, High and Critical.");
            h.Mapping = json;
        }
        h.Name = name; h.Target = target; h.ProjectId = project; h.WorkTypeId = target == "ticket" ? req.WorkTypeId ?? h.WorkTypeId : null;
        h.AssigneeId = req.AssigneeId ?? h.AssigneeId; h.DefaultPriority = (req.DefaultPriority ?? (Enum.TryParse<Priority>(h.DefaultPriority, out var d) ? d : Priority.Medium)).ToString();
        h.MergeMinutes = minutes;
        if (req.IsActive is { } active) h.IsActive = active;
        if (req.RaiseAsMe == true) h.ActingUserId = ctx.RequireUserId();
    }

    public async Task<CreatedIncomingWebhookDto> CreateAsync(SaveIncomingWebhookRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        await entitlements.EnsureFeatureAsync(FeatureKeys.ApiAccess, ct);
        if (await db.IncomingWebhooks.CountAsync(ct) >= MaxHooks) throw new ConflictException($"A workspace can have at most {MaxHooks} incoming webhooks.", "LIMIT_REACHED");
        var h = new IncomingWebhook { TenantId = ctx.RequireTenantId(), Token = NewToken(), ActingUserId = ctx.RequireUserId(), CreatedAt = clock.Now, CreatedBy = ctx.UserId,
            Mapping = JsonSerializer.Serialize(new IncomingMapping("{{title}}", "{{description}}", "{{priority}}", null, null, null, null, null), Json) };
        await ApplyAsync(h, req, ct);
        string? secret = null;
        if (req.RequireSecret == true) { secret = WebhookService.NewSecret(); h.SecretProtected = protector.Protect(secret); }
        db.IncomingWebhooks.Add(h);
        recorder.Audit("incoming_webhook.created", "IncomingWebhook", h.Id, newValue: new { h.Name, h.Target, h.ProjectId });
        await db.SaveChangesAsync(ct);
        return new CreatedIncomingWebhookDto((await DtosAsync([h], ct))[0], secret);
    }

    public async Task<CreatedIncomingWebhookDto> UpdateAsync(Guid id, SaveIncomingWebhookRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        var h = await db.IncomingWebhooks.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Incoming webhook not found.");
        if (req.IsActive == true && !h.IsActive) await entitlements.EnsureFeatureAsync(FeatureKeys.ApiAccess, ct);
        await ApplyAsync(h, req, ct);
        string? secret = null;
        if (req.RequireSecret == true && h.SecretProtected is null) { secret = WebhookService.NewSecret(); h.SecretProtected = protector.Protect(secret); }
        else if (req.RequireSecret == false) h.SecretProtected = null;
        h.UpdatedAt = clock.Now; h.UpdatedBy = ctx.UserId;
        if (h.LastError is not null && req.RaiseAsMe == true) h.LastError = null;
        recorder.Audit("incoming_webhook.updated", "IncomingWebhook", h.Id, newValue: new { h.Name, h.Target, h.ProjectId, h.IsActive, secret = h.SecretProtected is not null });
        await db.SaveChangesAsync(ct);
        return new CreatedIncomingWebhookDto((await DtosAsync([h], ct))[0], secret);
    }

    /// <summary>A new address (the old one stops working at once), and a new secret when it has one.</summary>
    public async Task<CreatedIncomingWebhookDto> RotateAsync(Guid id, CancellationToken ct = default)
    {
        RequireAdmin();
        var h = await db.IncomingWebhooks.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Incoming webhook not found.");
        h.Token = NewToken();
        string? secret = null;
        if (h.SecretProtected is not null) { secret = WebhookService.NewSecret(); h.SecretProtected = protector.Protect(secret); }
        h.UpdatedAt = clock.Now;
        recorder.Audit("incoming_webhook.rotated", "IncomingWebhook", h.Id);
        await db.SaveChangesAsync(ct);
        return new CreatedIncomingWebhookDto((await DtosAsync([h], ct))[0], secret);
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        RequireAdmin();
        var h = await db.IncomingWebhooks.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Incoming webhook not found.");
        db.IncomingWebhookEvents.RemoveRange(await db.IncomingWebhookEvents.Where(e => e.IncomingWebhookId == id).ToListAsync(ct));
        db.IncomingWebhookThreads.RemoveRange(await db.IncomingWebhookThreads.Where(e => e.IncomingWebhookId == id).ToListAsync(ct));
        db.IncomingWebhooks.Remove(h);
        recorder.Audit("incoming_webhook.deleted", "IncomingWebhook", id, oldValue: new { h.Name });
        await db.SaveChangesAsync(ct);
    }

    /// <summary>The last request this address received, for setting the mapping by example.</summary>
    public async Task<string?> SampleAsync(Guid id, CancellationToken ct = default)
    {
        RequireAdmin();
        return await db.IncomingWebhooks.AsNoTracking().Where(x => x.Id == id).Select(x => x.Sample).FirstOrDefaultAsync(ct);
    }

    /// <summary>What a mapping makes of an example request, the problems it would have, and every value in the example to click into the templates.</summary>
    public IncomingPreviewDto Preview(IncomingPreviewRequest req)
    {
        RequireAdmin();
        var body = IncomingTemplates.Parse(req.Sample ?? "{}", null);
        var m = req.Mapping ?? IncomingTemplates.Suggest(body);
        var problems = new List<string>();
        foreach (var path in new[] { m.Title, m.Description, m.Priority, m.DedupeKey, m.Assignee, m.ResolveWhen }.SelectMany(IncomingTemplates.PathsIn).Distinct())
            if (path != "$body" && IncomingTemplates.At(body, path) is null) problems.Add($"{{{{{path}}}}} is not in the example.");
        var title = IncomingTemplates.Render(m.Title, body);
        if (title.Length == 0) problems.Add("The title is empty for this example; the address name is used instead.");
        var priorityText = IncomingTemplates.Render(m.Priority, body);
        var priority = IncomingTemplates.PriorityOf(priorityText, m.PriorityMap);
        if (priorityText.Length > 0 && priority is null) problems.Add($"“{priorityText}” is not a priority; add it to the priority map. The default is used.");
        var key = IncomingTemplates.Render(m.DedupeKey, body);
        return new IncomingPreviewDto(title.Length == 0 ? "(address name)" : IncomingTemplates.Cut(title, 200), IncomingTemplates.Render(m.Description, body) is { Length: > 0 } dsc ? IncomingTemplates.Cut(dsc, 2000) : null,
            priority ?? req.DefaultPriority ?? Priority.Medium, IncomingTemplates.Cut(key.Length == 0 ? title : key, 200), IncomingTemplates.Render(m.Assignee, body) is { Length: > 0 } who ? who : null,
            IncomingTemplates.Resolves(m, body), problems, IncomingTemplates.Fields(body));
    }

    public IncomingMapping Suggest(string? sample)
    {
        RequireAdmin();
        return IncomingTemplates.Suggest(IncomingTemplates.Parse(sample ?? "{}", null));
    }

    public async Task<IncomingEventPageDto> EventsAsync(Guid id, int page, int pageSize, string? status, CancellationToken ct = default)
    {
        RequireAdmin();
        if (!await db.IncomingWebhooks.AnyAsync(x => x.Id == id, ct)) throw new NotFoundException("Incoming webhook not found.");
        page = Math.Max(1, page); pageSize = Math.Clamp(pageSize, 10, 200);
        var q = db.IncomingWebhookEvents.AsNoTracking().Where(e => e.IncomingWebhookId == id);
        if (!string.IsNullOrWhiteSpace(status)) q = q.Where(e => e.Status == status);
        var total = await q.CountAsync(ct);
        var rows = await q.OrderByDescending(e => e.ReceivedAt).ThenByDescending(e => e.Id).Skip((page - 1) * pageSize).Take(pageSize).ToListAsync(ct);
        var keys = rows.Where(r => r.DedupeKey != null).Select(r => r.DedupeKey!).Distinct().ToList();
        var counts = await db.IncomingWebhookThreads.AsNoTracking().Where(t => t.IncomingWebhookId == id && keys.Contains(t.DedupeKey)).ToDictionaryAsync(t => t.DedupeKey, t => t.Count, ct);
        return new IncomingEventPageDto(rows.Select(e => new IncomingEventDto(e.Id, e.ReceivedAt, e.Status, e.Title, e.DedupeKey, e.TargetType, e.TargetId, e.TargetKey, e.Error,
            e.DedupeKey is { } k && counts.TryGetValue(k, out var c) ? c : null)).ToList(), total, page, pageSize);
    }

    // ---------------------------------------------------------------- receiving

    private static bool SecretOk(string secret, byte[] body, IReadOnlyDictionary<string, string> headers)
    {
        string? H(string name) => headers.FirstOrDefault(h => string.Equals(h.Key, name, StringComparison.OrdinalIgnoreCase)).Value;
        if (H("X-Webhook-Secret") is { Length: > 0 } plain && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(plain), Encoding.UTF8.GetBytes(secret))) return true;
        var expected = Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), body)).ToLowerInvariant();
        foreach (var sig in new[] { H("X-Signature"), H("X-Hub-Signature-256"), H("X-Signature-256") })
        {
            if (string.IsNullOrEmpty(sig)) continue;
            var value = sig.StartsWith("sha256=", StringComparison.OrdinalIgnoreCase) ? sig[7..] : sig;
            if (CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(value.Trim().ToLowerInvariant()))) return true;
        }
        return false;
    }

    private static readonly int[] CommentAt = [2, 3, 5, 10, 20, 50, 100];

    /// <summary>
    /// One request to an address. Unknown address: null (404). Wrong secret: throws Unauthorized. Otherwise a receipt: created, merged,
    /// resolved, ignored (switched off, too many, nothing open to resolve) or failed (the work could not be raised; the address shows why).
    /// </summary>
    public static async Task<IncomingReceipt?> ReceiveAsync(IServiceProvider sp, string token, byte[] body, string? contentType, IReadOnlyDictionary<string, string> headers, CancellationToken ct)
    {
        var db = sp.GetRequiredService<IAppDbContext>();
        var clock = sp.GetRequiredService<AppClock>();
        if (token.Length is < 20 or > 48) return null;
        var hook = await db.IncomingWebhooks.IgnoreQueryFilters().FirstOrDefaultAsync(h => h.Token == token, ct);
        if (hook is null) return null;
        if (!await db.Tenants.IgnoreQueryFilters().AnyAsync(t => t.Id == hook.TenantId && t.Status == TenantStatus.Active && !t.IsDeleted, ct)) return null;
        var now = clock.Now;
        var text = Encoding.UTF8.GetString(body);
        var log = new IncomingWebhookEvent { TenantId = hook.TenantId, IncomingWebhookId = hook.Id, ReceivedAt = now, CreatedAt = now, Body = IncomingTemplates.Cut(text, 4000) };
        db.IncomingWebhookEvents.Add(log);
        IncomingReceipt Done(string status, string? error = null, string? key = null, int? count = null)
        {
            log.Status = status; log.Error = error is null ? null : IncomingTemplates.Cut(error, 300);
            if (status is "failed" or "rejected") hook.LastError = IncomingTemplates.Cut($"{now:dd MMM HH:mm} UTC: {error}", 300);
            else if (status is "created" or "merged" or "resolved") hook.LastError = null;
            return new IncomingReceipt(status, key, count, status is "failed" or "ignored" ? log.Error : null);
        }

        if (hook.SecretProtected is not null && !SecretOk(sp.GetRequiredService<ISecretProtector>().Unprotect(hook.SecretProtected), body, headers))
        {
            Done("rejected", "A request without the right secret or signature was refused.");
            await db.SaveChangesAsync(ct);
            throw new UnauthorizedException("The secret or signature does not match.", "BAD_SIGNATURE");
        }
        hook.Received++; hook.LastReceivedAt = now; hook.Sample = IncomingTemplates.Cut(text, 8000);
        if (!hook.IsActive) { var r0 = Done("ignored", "The address is switched off."); await db.SaveChangesAsync(ct); return r0; }
        var minuteAgo = now.AddMinutes(-1);
        if (await db.IncomingWebhookEvents.IgnoreQueryFilters().CountAsync(e => e.IncomingWebhookId == hook.Id && e.ReceivedAt >= minuteAgo, ct) >= 120)
        { var r1 = Done("ignored", "More than 120 requests in a minute: the rest of this minute is ignored."); await db.SaveChangesAsync(ct); return r1; }

        var json = IncomingTemplates.Parse(text, contentType);
        var m = MappingOf(hook.Mapping);
        var title = IncomingTemplates.Render(m.Title, json);
        if (title.Length == 0) title = $"{hook.Name}: new request";
        title = IncomingTemplates.Cut(Regex.Replace(title, @"\s+", " "), 200);
        var key = IncomingTemplates.Render(m.DedupeKey, json);
        key = IncomingTemplates.Cut(Regex.Replace(key.Length == 0 ? title : key, @"\s+", " ").Trim(), 200);
        log.Title = title; log.DedupeKey = key;
        var description = IncomingTemplates.Render(m.Description, json);
        var priority = IncomingTemplates.PriorityOf(IncomingTemplates.Render(m.Priority, json), m.PriorityMap) ?? (Enum.TryParse<Priority>(hook.DefaultPriority, out var dp) ? dp : Priority.Medium);
        var resolves = IncomingTemplates.Resolves(m, json);

        // From here the work is raised as the member who set the address up, in that workspace only.
        var cc = sp.GetRequiredService<CurrentContext>();
        var member = await db.TenantMembers.IgnoreQueryFilters().AsNoTracking().Include(x => x.User)
            .FirstOrDefaultAsync(x => x.TenantId == hook.TenantId && x.UserId == hook.ActingUserId, ct);
        if (member is null || member.User is null || !member.User.IsActive)
        { var r2 = Done("failed", "The person this address raises work as is no longer a member. An admin can open it and choose “Raise as me”."); await db.SaveChangesAsync(ct); return r2; }
        var original = (cc.TenantId, cc.UserId, cc.Role, cc.WorkspaceType);
        cc.TenantId = hook.TenantId; cc.UserId = member.UserId; cc.Role = member.Role;
        cc.WorkspaceType = await db.Tenants.IgnoreQueryFilters().Where(t => t.Id == hook.TenantId).Select(t => (WorkspaceType?)t.Type).FirstOrDefaultAsync(ct);
        try
        {
            Guid? assignee = hook.AssigneeId;
            if (IncomingTemplates.Render(m.Assignee, json) is { Length: > 3 } who && who.Contains('@'))
            {
                var email = Text.NormalizeEmail(who);
                assignee = await db.TenantMembers.AsNoTracking().Where(x => x.User!.NormalizedEmail == email && x.Role != TenantRole.Guest && x.User.IsActive).Select(x => (Guid?)x.UserId).FirstOrDefaultAsync(ct) ?? assignee;
            }
            var thread = await db.IncomingWebhookThreads.FirstOrDefaultAsync(t => t.IncomingWebhookId == hook.Id && t.DedupeKey == key, ct);
            var open = thread is not null && await IsOpenAsync(db, thread, ct);

            if (resolves)
            {
                if (thread is null || !open) return Done("ignored", "Resolved, but nothing is open for it.", thread?.TargetKey);
                await CloseAsync(sp, db, thread, $"The source reports this resolved ({IncomingTemplates.Cut(IncomingTemplates.Render(m.ResolveWhen, json), 40)}) at {now:dd MMM HH:mm} UTC.", ct);
                log.TargetType = thread.TargetType; log.TargetId = thread.TargetId; log.TargetKey = thread.TargetKey;
                return Done("resolved", null, thread.TargetKey, thread.Count);
            }

            if (thread is not null && open && hook.MergeMinutes > 0 && thread.LastAt >= now.AddMinutes(-hook.MergeMinutes))
            {
                thread.Count++; thread.LastAt = now; hook.MergedCount++;
                if (CommentAt.Contains(thread.Count) || thread.Count % 100 == 0)
                    await CommentAsync(sp, thread, $"Seen again: {thread.Count} times in total, the last at {now:dd MMM HH:mm} UTC ({hook.Name}).", ct);
                log.TargetType = thread.TargetType; log.TargetId = thread.TargetId; log.TargetKey = thread.TargetKey;
                return Done("merged", null, thread.TargetKey, thread.Count);
            }

            var details = $"{(description.Length == 0 ? "" : description + "\n\n")}Raised by the incoming webhook “{hook.Name}”.";
            (Guid Id, string Key) made;
            switch (hook.Target)
            {
                case "task":
                    var task = await sp.GetRequiredService<TaskService>().CreateAsync(hook.ProjectId ?? throw new ValidationException("projectId", "The address has no project."),
                        new CreateTaskRequest(title, IncomingTemplates.Cut(details, 4000), null, priority, assignee, null, null, null, null, null), ct);
                    made = (task.Id, task.Key);
                    break;
                case "reminder":
                    var at = now.AddMinutes(1).ToString("yyyy-MM-ddTHH:mm", CultureInfo.InvariantCulture);
                    var reminder = await sp.GetRequiredService<ReminderService>().CreateAsync(new SaveReminderRequest(title, IncomingTemplates.Cut(details, 1000), ReminderTarget.None, null,
                        assignee, new ReminderWhen(at, "UTC", null, null, null), null, true), ct);
                    made = (reminder.Id, "reminder");
                    break;
                default:
                    // No work type chosen on the address: the workspace's first active one (the defaults are created on first use).
                    var typeId = hook.WorkTypeId;
                    if (typeId is null)
                    {
                        await sp.GetRequiredService<WorkTypeService>().EnsureDefaultsAsync(ct);
                        typeId = await db.WorkTypes.AsNoTracking().Where(t => t.IsActive).OrderBy(t => t.Order).Select(t => (Guid?)t.Id).FirstOrDefaultAsync(ct);
                    }
                    var ticket = await sp.GetRequiredService<WorkTaskService>().CreateAsync(new CreateWorkTaskRequest(title, IncomingTemplates.Cut(details, 8000), typeId, hook.ProjectId, assignee,
                        priority, null, null, null), ct);
                    made = (ticket.Id, ticket.Key);
                    break;
            }
            if (thread is null)
            {
                thread = new IncomingWebhookThread { TenantId = hook.TenantId, IncomingWebhookId = hook.Id, DedupeKey = key, CreatedAt = now };
                db.IncomingWebhookThreads.Add(thread);
            }
            thread.TargetType = hook.Target; thread.TargetId = made.Id; thread.TargetKey = made.Key; thread.Count = 1; thread.FirstAt = now; thread.LastAt = now;
            hook.CreatedCount++;
            log.TargetType = hook.Target; log.TargetId = made.Id; log.TargetKey = made.Key;
            return Done("created", null, made.Key, 1);
        }
        catch (AppException e)
        {
            sp.GetRequiredService<ILogger<IncomingWebhookService>>().LogInformation("Incoming webhook {Hook} could not raise work: {Reason}", hook.Id, e.Message);
            return Done("failed", e.Message);
        }
        finally
        {
            cc.UserId = null; cc.Role = null;   // the log and counters are saved in the address's workspace, as nobody in particular
            await db.SaveChangesAsync(CancellationToken.None);
            (cc.TenantId, cc.UserId, cc.Role, cc.WorkspaceType) = original;
        }
    }

    private static async Task<bool> IsOpenAsync(IAppDbContext db, IncomingWebhookThread t, CancellationToken ct) => t.TargetType switch
    {
        "task" => await db.Tasks.IgnoreQueryFilters().AnyAsync(x => x.Id == t.TargetId && x.TenantId == t.TenantId && !x.IsDeleted && x.CompletedAt == null, ct),
        "reminder" => await db.Reminders.IgnoreQueryFilters().AnyAsync(x => x.Id == t.TargetId && x.TenantId == t.TenantId && (x.State == ReminderState.Scheduled || x.State == ReminderState.Fired), ct),
        _ => await db.WorkTasks.IgnoreQueryFilters().AnyAsync(x => x.Id == t.TargetId && x.TenantId == t.TenantId && !x.IsDeleted
            && x.Status != WorkTaskStatus.Completed && x.Status != WorkTaskStatus.Cancelled, ct),
    };

    private static async Task CommentAsync(IServiceProvider sp, IncomingWebhookThread t, string text, CancellationToken ct)
    {
        if (t.TargetType == "task") await sp.GetRequiredService<TaskService>().AddCommentAsync(t.TargetId, new CreateCommentRequest(text, null, null), ct);
        else if (t.TargetType == "ticket") await sp.GetRequiredService<WorkTaskService>().AddCommentAsync(t.TargetId, new WorkCommentRequest(text), ct);
    }

    private static async Task CloseAsync(IServiceProvider sp, IAppDbContext db, IncomingWebhookThread t, string note, CancellationToken ct)
    {
        await CommentAsync(sp, t, note, ct);
        switch (t.TargetType)
        {
            case "ticket": await sp.GetRequiredService<WorkTaskService>().SetStatusAsync(t.TargetId, new SetWorkTaskStatusRequest(WorkTaskStatus.Completed), ct); break;
            case "task":
                var projectId = await db.Tasks.AsNoTracking().Where(x => x.Id == t.TargetId).Select(x => x.ProjectId).FirstAsync(ct);
                var done = await db.WorkflowStatuses.AsNoTracking().Where(s => s.ProjectId == projectId && s.Category == StatusCategory.Done).OrderBy(s => s.Order).Select(s => (Guid?)s.Id).FirstOrDefaultAsync(ct);
                if (done is { } statusId) await sp.GetRequiredService<TaskService>().MoveAsync(t.TargetId, new MoveTaskRequest(statusId, null), ct);
                break;
            case "reminder": await sp.GetRequiredService<ReminderService>().CompleteAsync(t.TargetId, ct); break;
        }
    }
}
