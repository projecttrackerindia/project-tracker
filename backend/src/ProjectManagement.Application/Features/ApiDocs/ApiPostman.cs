using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.ApiDocs;

/// <summary>A Postman collection (v2.1) in and out: folders become groups, requests become endpoints, saved responses become responses.</summary>
public static partial class ApiPostman
{
    private static readonly HashSet<string> Verbs = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"];

    [GeneratedRegex(@"\{\{\s*([^{}\s]+)\s*\}\}")] private static partial Regex Var();
    [GeneratedRegex(@"^(https?://[^/?#]+)", RegexOptions.IgnoreCase)] private static partial Regex Origin();

    public static bool Looks(JsonNode? root) => root is JsonObject o && o["item"] is JsonArray && (o["info"]?["schema"]?.ToString().Contains("postman", StringComparison.OrdinalIgnoreCase) == true || o["info"] is not null);

    public static ParseResult Import(JsonNode root, string text, string fallbackName)
    {
        var issues = new List<ImportIssue>();
        var o = (JsonObject)root;
        var servers = new List<string>();
        var variables = (o["variable"] as JsonArray)?.OfType<JsonObject>().Where(v => v["key"] is not null).ToDictionary(v => v["key"]!.ToString(), v => v["value"]?.ToString() ?? "", StringComparer.Ordinal) ?? [];
        foreach (var k in new[] { "baseUrl", "base_url", "host", "url" }) if (variables.TryGetValue(k, out var v) && v.StartsWith("http")) { servers.Add(v.TrimEnd('/')); break; }
        var endpoints = new List<ImportedEndpoint>();
        var seen = new HashSet<string>();
        void Walk(JsonArray items, string? folder, string pointer, int depth)
        {
            if (depth > 12) return;
            for (var i = 0; i < items.Count; i++)
            {
                if (items[i] is not JsonObject it) continue;
                var at = $"{pointer}/{i}";
                var name = it["name"]?.ToString() ?? "";
                if (it["item"] is JsonArray children) { Walk(children, folder is null ? name : $"{folder} / {name}", at + "/item", depth + 1); continue; }
                if (it["request"] is not JsonObject req) continue;
                if (endpoints.Count >= ApiOpenApi.MaxEndpoints) { issues.Add(new ImportIssue("error", null, null, at, $"A file can describe at most {ApiOpenApi.MaxEndpoints:N0} endpoints; the rest were skipped.")); return; }
                try
                {
                    var method = (req["method"]?.ToString() ?? "GET").ToUpperInvariant();
                    if (!Verbs.Contains(method)) { issues.Add(new ImportIssue("warning", ApiOpenApi.LineOf(text, name), null, at, $"{name}: the method {method} is not supported; skipped.")); continue; }
                    var (path, origin, query, pathVars) = ReadUrl(req["url"]);
                    if (origin is not null && !servers.Contains(origin)) servers.Add(origin);
                    var cleanPath = ApiJson.NormalizePath(path);
                    if (!seen.Add($"{method} {cleanPath}")) { issues.Add(new ImportIssue("warning", ApiOpenApi.LineOf(text, name), null, at, $"{method} {cleanPath} appears twice; the first one is kept.")); continue; }
                    var d = new EndpointDetails { Description = DescriptionOf(req["description"]) };
                    foreach (var q in query) d.Parameters.Add(q);
                    foreach (var p in pathVars) d.Parameters.Add(p);
                    foreach (var h in (req["header"] as JsonArray)?.OfType<JsonObject>() ?? [])
                    {
                        var hn = h["key"]?.ToString(); if (string.IsNullOrWhiteSpace(hn) || h["disabled"]?.GetValue<bool>() == true) continue;
                        if (hn.Equals("content-type", StringComparison.OrdinalIgnoreCase) || hn.Equals("accept", StringComparison.OrdinalIgnoreCase)) continue;
                        d.Parameters.Add(new ApiParam(hn, "header", false, "string", DescriptionOf(h["description"]), h["value"]?.ToString(), null));
                    }
                    if (req["body"] is JsonObject body && body["mode"]?.ToString() == "raw" && !string.IsNullOrWhiteSpace(body["raw"]?.ToString()))
                    {
                        var lang = body["options"]?["raw"]?["language"]?.ToString();
                        var ct = (req["header"] as JsonArray)?.OfType<JsonObject>().FirstOrDefault(h => h["key"]?.ToString()?.Equals("content-type", StringComparison.OrdinalIgnoreCase) == true)?["value"]?.ToString()
                            ?? (lang == "json" ? "application/json" : lang == "xml" ? "application/xml" : "text/plain");
                        d.RequestBody = new ApiBody(ct, true, null, null, Cap(body["raw"]!.ToString()));
                    }
                    foreach (var r in (it["response"] as JsonArray)?.OfType<JsonObject>() ?? [])
                    {
                        var status = r["code"]?.ToString() ?? "200";
                        if (d.Responses.Any(x => x.Status == status)) continue;
                        var ct = (r["header"] as JsonArray)?.OfType<JsonObject>().FirstOrDefault(h => h["key"]?.ToString()?.Equals("content-type", StringComparison.OrdinalIgnoreCase) == true)?["value"]?.ToString();
                        d.Responses.Add(new ApiResponse(status, r["name"]?.ToString() ?? r["status"]?.ToString(), ct, null, Cap(r["body"]?.ToString())));
                    }
                    d = ApiJson.Clean(d);
                    endpoints.Add(new ImportedEndpoint(method, cleanPath, name.Length > 300 ? name[..300] : name, folder is { Length: > 80 } f ? f[..80] : folder, false, d));
                }
                catch (Exception e) when (e is not OutOfMemoryException) { issues.Add(new ImportIssue("error", ApiOpenApi.LineOf(text, name), null, at, $"{name}: skipped ({e.Message})")); }
            }
        }
        Walk((JsonArray)o["item"]!, null, "#/item", 0);
        var title = (o["info"]?["name"]?.ToString() ?? "").Trim(); if (title.Length == 0) title = fallbackName; if (title.Length > 80) title = title[..80];
        return new ParseResult(new ImportedApi(title, DescriptionOf(o["info"]?["description"]), null, ApiAuthScheme.None, servers.Take(20).ToList(), endpoints), issues);
    }

    private static string? Cap(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Length > ApiJson.MaxExampleChars ? s[..ApiJson.MaxExampleChars] : s;
    private static string? DescriptionOf(JsonNode? n) => n is JsonObject o ? Cap(o["content"]?.ToString()) : Cap(n?.ToString());

    private static (string Path, string? Origin, List<ApiParam> Query, List<ApiParam> PathVars) ReadUrl(JsonNode? url)
    {
        var query = new List<ApiParam>(); var vars = new List<ApiParam>();
        string path; string? origin = null;
        if (url is JsonObject u)
        {
            var raw = u["raw"]?.ToString() ?? "";
            if (Origin().Match(raw) is { Success: true } m) origin = m.Value;
            if (u["path"] is JsonArray segs) path = "/" + string.Join('/', segs.Select(s => Segment(s is JsonObject so ? so["value"]?.ToString() : s?.ToString())));
            else { var r = Var().Replace(raw, ""); path = Origin().Replace(r, ""); }
            foreach (var q in (u["query"] as JsonArray)?.OfType<JsonObject>() ?? [])
                if (q["key"]?.ToString() is { Length: > 0 } k) query.Add(new ApiParam(k, "query", false, "string", DescriptionOf(q["description"]), q["value"]?.ToString(), null));
            foreach (var v in (u["variable"] as JsonArray)?.OfType<JsonObject>() ?? [])
                if (v["key"]?.ToString() is { Length: > 0 } k) vars.Add(new ApiParam(k, "path", true, "string", DescriptionOf(v["description"]), v["value"]?.ToString(), null));
        }
        else
        {
            var raw = url?.ToString() ?? "";
            if (Origin().Match(Var().Replace(raw, "")) is { Success: true } m) origin = m.Value;
            path = Origin().Replace(Var().Replace(raw, ""), "");
        }
        path = path.Replace("//", "/");
        var qi = path.IndexOf('?'); if (qi >= 0) path = path[..qi];
        // a {id} the path mentions but the file never listed is still a path parameter
        foreach (Match m in PathParam().Matches(path)) if (vars.All(v => v.Name != m.Groups[1].Value)) vars.Add(new ApiParam(m.Groups[1].Value, "path", true, "string", null, null, null));
        return (path, origin, query, vars);
    }

    [GeneratedRegex(@"\{([^{}/]+)\}")] private static partial Regex PathParam();

    private static string Segment(string? s)
    {
        s ??= "";
        if (s.StartsWith(':')) return "{" + s[1..] + "}";
        var t = Var().Replace(s, "{$1}");
        return t;
    }

    // ------------------------------------------------------------------ export

    public static JsonObject Export(string title, string? description, List<string> servers, IEnumerable<(string Method, string Path, string Summary, string? Tag, EndpointDetails Details)> endpoints)
    {
        var root = new JsonObject
        {
            ["info"] = new JsonObject { ["name"] = title, ["description"] = description, ["schema"] = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
        };
        var folders = new Dictionary<string, JsonArray>(StringComparer.Ordinal);
        var items = new JsonArray();
        foreach (var e in endpoints.OrderBy(e => e.Tag ?? "", StringComparer.Ordinal).ThenBy(e => e.Path, StringComparer.Ordinal).ThenBy(e => e.Method))
        {
            var pathSegments = e.Path.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries).Select(s => s.StartsWith('{') && s.EndsWith('}') ? ":" + s[1..^1] : s).ToArray();
            var url = new JsonObject
            {
                ["raw"] = "{{baseUrl}}/" + string.Join('/', pathSegments) + (e.Details.Parameters.Any(p => p.In == "query") ? "?" + string.Join('&', e.Details.Parameters.Where(p => p.In == "query").Select(p => $"{p.Name}={p.Example ?? ""}")) : ""),
                ["host"] = new JsonArray("{{baseUrl}}"),
                ["path"] = new JsonArray(pathSegments.Select(s => (JsonNode)JsonValue.Create(s)!).ToArray()),
            };
            var query = e.Details.Parameters.Where(p => p.In == "query").Select(p => (JsonNode)new JsonObject { ["key"] = p.Name, ["value"] = p.Example ?? "", ["description"] = p.Description }).ToArray();
            if (query.Length > 0) url["query"] = new JsonArray(query);
            var vars = e.Details.Parameters.Where(p => p.In == "path").Select(p => (JsonNode)new JsonObject { ["key"] = p.Name, ["value"] = p.Example ?? "", ["description"] = p.Description }).ToArray();
            if (vars.Length > 0) url["variable"] = new JsonArray(vars);
            var request = new JsonObject
            {
                ["method"] = e.Method, ["url"] = url, ["description"] = e.Details.Description,
                ["header"] = new JsonArray(e.Details.Parameters.Where(p => p.In == "header").Select(p => (JsonNode)new JsonObject { ["key"] = p.Name, ["value"] = p.Example ?? "", ["description"] = p.Description }).ToArray()),
            };
            if (e.Details.RequestBody is { } b)
            {
                ((JsonArray)request["header"]!).Add(new JsonObject { ["key"] = "Content-Type", ["value"] = b.ContentType ?? "application/json" });
                request["body"] = new JsonObject { ["mode"] = "raw", ["raw"] = b.Example ?? "", ["options"] = new JsonObject { ["raw"] = new JsonObject { ["language"] = (b.ContentType ?? "").Contains("json") ? "json" : "text" } } };
            }
            var item = new JsonObject { ["name"] = e.Summary.Length > 0 ? e.Summary : $"{e.Method} {e.Path}", ["request"] = request };
            if (e.Details.Responses.Count > 0)
                item["response"] = new JsonArray(e.Details.Responses.Select(r => (JsonNode)new JsonObject
                {
                    ["name"] = r.Description ?? r.Status, ["originalRequest"] = request.DeepClone(), ["code"] = int.TryParse(r.Status, out var c) ? c : 200, ["status"] = r.Description ?? r.Status,
                    ["header"] = new JsonArray(r.ContentType is null ? [] : [(JsonNode)new JsonObject { ["key"] = "Content-Type", ["value"] = r.ContentType }]), ["body"] = r.Example ?? "",
                }).ToArray());
            if (e.Tag is null) items.Add(item);
            else { if (!folders.TryGetValue(e.Tag, out var arr)) { folders[e.Tag] = arr = new JsonArray(); items.Add(new JsonObject { ["name"] = e.Tag, ["item"] = arr }); } arr.Add(item); }
        }
        root["item"] = items;
        root["variable"] = new JsonArray(new JsonObject { ["key"] = "baseUrl", ["value"] = servers.FirstOrDefault() ?? "https://api.example.com" });
        return root;
    }
}
