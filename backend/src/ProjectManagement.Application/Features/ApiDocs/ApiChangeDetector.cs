using System.Text.Json.Nodes;

namespace ProjectManagement.Application.Features.ApiDocs;

public enum ChangeLevel { Breaking = 0, Warning = 1, Info = 2 }

/// <summary>One endpoint as the comparison sees it: which API, method, path, and its details (the API's own authentication is resolved into <see cref="Auth"/>).</summary>
public sealed record EndpointView(string Definition, string Method, string Path, string Summary, bool Deprecated, string Auth, EndpointDetails Details)
{
    public string Key => $"{Definition}\u0001{Method}\u0001{Path}";
}

public sealed record ApiChange(ChangeLevel Level, string Code, string Definition, string Method, string Path, string Message, string? Where);
public sealed record ApiChanges(IReadOnlyList<ApiChange> Items, int Breaking, int Warnings, int Info, int Added, int Removed, int Modified);

/// <summary>
/// What changed between two states of an API and whether callers will notice. Breaking: an endpoint or a success response is gone, a required parameter
/// was removed or added, a parameter or property changed type or became required, a property callers read was removed. Warning: something callers may
/// rely on changed but need not break (an optional input removed, a response property that became optional, an error code gone, a deprecation).
/// Info: additions and wording. Adding an optional parameter, a response property or an endpoint is never breaking.
/// </summary>
public static class ApiChangeDetector
{
    public static ApiChanges Compare(IEnumerable<EndpointView> before, IEnumerable<EndpointView> after)
    {
        var a = before.GroupBy(e => e.Key).ToDictionary(g => g.Key, g => g.First());
        var b = after.GroupBy(e => e.Key).ToDictionary(g => g.Key, g => g.First());
        var items = new List<ApiChange>();
        int added = 0, removed = 0, modified = 0;
        foreach (var (key, old) in a.OrderBy(x => x.Value.Definition).ThenBy(x => x.Value.Path).ThenBy(x => x.Value.Method))
        {
            if (!b.TryGetValue(key, out var now))
            {
                removed++;
                items.Add(new ApiChange(ChangeLevel.Breaking, "endpoint.removed", old.Definition, old.Method, old.Path, "The endpoint was removed.", null));
                continue;
            }
            var before0 = items.Count;
            CompareEndpoint(old, now, items);
            if (items.Count > before0) modified++;
        }
        foreach (var (key, now) in b.OrderBy(x => x.Value.Definition).ThenBy(x => x.Value.Path).ThenBy(x => x.Value.Method))
            if (!a.ContainsKey(key)) { added++; items.Add(new ApiChange(ChangeLevel.Info, "endpoint.added", now.Definition, now.Method, now.Path, "A new endpoint.", null)); }
        items = items.OrderBy(i => i.Level).ThenBy(i => i.Definition).ThenBy(i => i.Path).ThenBy(i => i.Method).ToList();
        return new ApiChanges(items, items.Count(i => i.Level == ChangeLevel.Breaking), items.Count(i => i.Level == ChangeLevel.Warning), items.Count(i => i.Level == ChangeLevel.Info), added, removed, modified);
    }

    private static void CompareEndpoint(EndpointView o, EndpointView n, List<ApiChange> items)
    {
        void Add(ChangeLevel level, string code, string message, string? where = null) => items.Add(new ApiChange(level, code, o.Definition, o.Method, o.Path, message, where));

        if (!o.Deprecated && n.Deprecated) Add(ChangeLevel.Warning, "endpoint.deprecated", "The endpoint is now deprecated.");
        else if (o.Deprecated && !n.Deprecated) Add(ChangeLevel.Info, "endpoint.undeprecated", "The endpoint is no longer deprecated.");
        if (o.Summary != n.Summary) Add(ChangeLevel.Info, "endpoint.summary", "The summary changed.");
        if ((o.Details.Description ?? "") != (n.Details.Description ?? "")) Add(ChangeLevel.Info, "endpoint.description", "The description changed.");

        if (o.Auth != n.Auth)
        {
            if (o.Auth == "None") Add(ChangeLevel.Breaking, "auth.required", $"Authentication ({n.Auth}) is now required.");
            else if (n.Auth == "None") Add(ChangeLevel.Info, "auth.removed", "Authentication is no longer required.");
            else Add(ChangeLevel.Breaking, "auth.changed", $"Authentication changed from {o.Auth} to {n.Auth}.");
        }

        // parameters
        var op = o.Details.Parameters.GroupBy(p => (p.In, p.Name)).ToDictionary(g => g.Key, g => g.First());
        var np = n.Details.Parameters.GroupBy(p => (p.In, p.Name)).ToDictionary(g => g.Key, g => g.First());
        foreach (var (k, p) in op)
        {
            var where = $"{k.In} parameter {k.Name}";
            if (!np.TryGetValue(k, out var q)) { Add(p.Required ? ChangeLevel.Breaking : ChangeLevel.Warning, p.Required ? "param.removed.required" : "param.removed", p.Required ? "A required parameter was removed." : "An optional parameter was removed.", where); continue; }
            if (!p.Required && q.Required) Add(ChangeLevel.Breaking, "param.required", "The parameter became required.", where);
            else if (p.Required && !q.Required) Add(ChangeLevel.Info, "param.optional", "The parameter became optional.", where);
            if (!string.Equals(p.Type, q.Type, StringComparison.OrdinalIgnoreCase) && (p.Type is not null || q.Type is not null)) Add(ChangeLevel.Breaking, "param.type", $"The type changed from {p.Type ?? "unspecified"} to {q.Type ?? "unspecified"}.", where);
            CompareSchema(p.Schema, q.Schema, true, where, (l, c, m, w) => Add(l, c, m, w));
        }
        foreach (var (k, q) in np)
            if (!op.ContainsKey(k)) Add(q.Required ? ChangeLevel.Breaking : ChangeLevel.Info, q.Required ? "param.added.required" : "param.added", q.Required ? "A new required parameter." : "A new optional parameter.", $"{k.In} parameter {k.Name}");

        // request body
        var ob = o.Details.RequestBody; var nb = n.Details.RequestBody;
        if (ob is null && nb is not null) Add(nb.Required ? ChangeLevel.Breaking : ChangeLevel.Info, nb.Required ? "body.added.required" : "body.added", nb.Required ? "A request body is now required." : "An optional request body was added.", "request body");
        else if (ob is not null && nb is null) Add(ob.Required ? ChangeLevel.Breaking : ChangeLevel.Warning, ob.Required ? "body.removed.required" : "body.removed", "The request body was removed.", "request body");
        else if (ob is not null && nb is not null)
        {
            if (!ob.Required && nb.Required) Add(ChangeLevel.Breaking, "body.required", "The request body became required.", "request body");
            if (!string.Equals(ob.ContentType, nb.ContentType, StringComparison.OrdinalIgnoreCase)) Add(ChangeLevel.Breaking, "body.contentType", $"The content type changed from {ob.ContentType ?? "unspecified"} to {nb.ContentType ?? "unspecified"}.", "request body");
            CompareSchema(ob.Schema, nb.Schema, true, "request body", (l, c, m, w) => Add(l, c, m, w));
        }

        // responses
        var or = o.Details.Responses.GroupBy(r => r.Status).ToDictionary(g => g.Key, g => g.First());
        var nr = n.Details.Responses.GroupBy(r => r.Status).ToDictionary(g => g.Key, g => g.First());
        foreach (var (status, r) in or)
        {
            var where = $"response {status}";
            if (!nr.TryGetValue(status, out var s))
            {
                var success = status.StartsWith('2') || status.Equals("default", StringComparison.OrdinalIgnoreCase);
                Add(success ? ChangeLevel.Breaking : ChangeLevel.Warning, success ? "response.removed" : "response.removed.other", "The response was removed.", where);
                continue;
            }
            if (!string.Equals(r.ContentType, s.ContentType, StringComparison.OrdinalIgnoreCase) && (r.ContentType is not null && s.ContentType is not null)) Add(ChangeLevel.Breaking, "response.contentType", $"The content type changed from {r.ContentType} to {s.ContentType}.", where);
            CompareSchema(r.Schema, s.Schema, false, where, (l, c, m, w) => Add(l, c, m, w));
        }
        foreach (var status in nr.Keys.Where(k => !or.ContainsKey(k))) Add(ChangeLevel.Info, "response.added", "A new response.", $"response {status}");

        // documented errors
        var oe = o.Details.Errors.Select(e => e.Code).ToHashSet(); var ne = n.Details.Errors.Select(e => e.Code).ToHashSet();
        foreach (var c in oe.Where(c => !ne.Contains(c))) Add(ChangeLevel.Warning, "error.removed", $"The error {c} is no longer documented.");
        foreach (var c in ne.Where(c => !oe.Contains(c))) Add(ChangeLevel.Info, "error.added", $"A new documented error {c}.");
    }

    // ------------------------------------------------------------------ schemas

    private static JsonNode? Parse(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        try { return JsonNode.Parse(text); } catch (System.Text.Json.JsonException) { return null; }
    }

    /// <summary>Compares two JSON schemas. <paramref name="request"/>: the schema describes what callers send; otherwise what they get back.</summary>
    public static void CompareSchema(string? before, string? after, bool request, string where, Action<ChangeLevel, string, string, string?> report)
    {
        var a = Parse(before); var b = Parse(after);
        if (a is null && b is null) return;
        if (a is null) { report(ChangeLevel.Info, "schema.added", "A schema was added.", where); return; }
        if (b is null) { report(ChangeLevel.Warning, "schema.removed", "The schema was removed.", where); return; }
        Walk(a, b, request, where, report, 0);
    }

    private static void Walk(JsonNode a, JsonNode b, bool request, string path, Action<ChangeLevel, string, string, string?> report, int depth)
    {
        if (depth > 12 || a is not JsonObject oa || b is not JsonObject ob) return;
        var ta = oa["type"]?.ToString(); var tb = ob["type"]?.ToString();
        if (ta is not null && tb is not null && ta != tb) { report(ChangeLevel.Breaking, "schema.type", $"{path}: the type changed from {ta} to {tb}.", path); return; }
        var fa = oa["format"]?.ToString(); var fb = ob["format"]?.ToString();
        if (fa != fb && (fa is not null || fb is not null)) report(ChangeLevel.Warning, "schema.format", $"{path}: the format changed from {fa ?? "none"} to {fb ?? "none"}.", path);

        var pa = oa["properties"] as JsonObject; var pb = ob["properties"] as JsonObject;
        var ra = (oa["required"] as JsonArray)?.Select(x => x?.ToString() ?? "").ToHashSet() ?? [];
        var rb = (ob["required"] as JsonArray)?.Select(x => x?.ToString() ?? "").ToHashSet() ?? [];
        if (pa is not null || pb is not null)
        {
            foreach (var (name, child) in pa ?? [])
            {
                var at = $"{path}.{name}";
                if (pb is null || !pb.ContainsKey(name))
                    report(request ? ChangeLevel.Warning : ChangeLevel.Breaking, request ? "schema.property.removed.request" : "schema.property.removed", request ? $"{at}: no longer accepted." : $"{at}: removed from the response.", at);
                else if (child is not null && pb[name] is { } other) Walk(child, other, request, at, report, depth + 1);
                if (pb is not null && pb.ContainsKey(name))
                {
                    if (request && !ra.Contains(name) && rb.Contains(name)) report(ChangeLevel.Breaking, "schema.required.added", $"{at}: now required.", at);
                    if (!request && ra.Contains(name) && !rb.Contains(name)) report(ChangeLevel.Warning, "schema.required.removed", $"{at}: no longer always present.", at);
                }
            }
            foreach (var name in (pb?.Select(x => x.Key) ?? []).Where(n => pa is null || !pa.ContainsKey(n)))
            {
                var at = $"{path}.{name}";
                if (request && rb.Contains(name)) report(ChangeLevel.Breaking, "schema.property.added.required", $"{at}: a new required property.", at);
                else report(ChangeLevel.Info, "schema.property.added", $"{at}: a new property.", at);
            }
        }
        if (oa["items"] is { } ia && ob["items"] is { } ib) Walk(ia, ib, request, path + "[]", report, depth + 1);
        var ea = (oa["enum"] as JsonArray)?.Select(x => x?.ToJsonString() ?? "").ToHashSet(); var eb = (ob["enum"] as JsonArray)?.Select(x => x?.ToJsonString() ?? "").ToHashSet();
        if (ea is not null && eb is not null)
        {
            foreach (var v in ea.Where(v => !eb.Contains(v))) report(request ? ChangeLevel.Breaking : ChangeLevel.Info, "schema.enum.removed", $"{path}: the value {v} is gone.", path);
            foreach (var v in eb.Where(v => !ea.Contains(v))) report(request ? ChangeLevel.Info : ChangeLevel.Warning, "schema.enum.added", $"{path}: a new value {v}.", path);
        }
        foreach (var key in new[] { "allOf", "oneOf", "anyOf" })
            if ((oa[key]?.ToJsonString() ?? "") != (ob[key]?.ToJsonString() ?? "")) report(ChangeLevel.Warning, "schema.composition", $"{path}: the {key} alternatives changed.", path);
    }
}
