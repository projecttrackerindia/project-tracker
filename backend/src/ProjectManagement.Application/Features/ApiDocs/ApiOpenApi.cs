using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ProjectManagement.Domain.Entities;
using YamlDotNet.Core;
using YamlDotNet.RepresentationModel;

namespace ProjectManagement.Application.Features.ApiDocs;

public sealed record ImportedEndpoint(string Method, string Path, string Summary, string? Tag, bool Deprecated, EndpointDetails Details);
public sealed record ImportedApi(string Name, string? Description, string? Version, ApiAuthScheme Auth, List<string> Servers, List<ImportedEndpoint> Endpoints);
public sealed record ImportIssue(string Severity, int? Line, int? Column, string? Pointer, string Message);
public sealed record ParseResult(ImportedApi? Api, List<ImportIssue> Issues)
{
    public bool Failed => Api is null || Issues.Any(i => i.Severity == "error" && i.Pointer is null && Api.Endpoints.Count == 0);
}

/// <summary>An API described as a JSON or YAML OpenAPI 3 file, in and out. What the product keeps (summary, tag, parameters, body, responses, errors, samples) round-trips; references are filled in on the way in.</summary>
public static class ApiOpenApi
{
    public const int MaxEndpoints = 10_000;
    private static readonly string[] Methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

    // ------------------------------------------------------------------ reading text (JSON or YAML)

    public static JsonNode? ParseText(string text, List<ImportIssue> issues)
    {
        var t = text.TrimStart('﻿', ' ', '\t', '\r', '\n');
        if (t.Length == 0) { issues.Add(new ImportIssue("error", 1, 1, null, "The file is empty.")); return null; }
        if (t[0] is '{' or '[')
        {
            try { return JsonNode.Parse(text, null, new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip }); }
            catch (JsonException e) { issues.Add(new ImportIssue("error", (int?)(e.LineNumber + 1), (int?)(e.BytePositionInLine + 1), null, $"The file is not valid JSON: {e.Message.Split(" Path:")[0]}")); return null; }
        }
        try
        {
            var yaml = new YamlStream(); yaml.Load(new StringReader(text));
            return yaml.Documents.Count == 0 ? null : FromYaml(yaml.Documents[0].RootNode, 0);
        }
        catch (YamlException e) { issues.Add(new ImportIssue("error", (int)e.Start.Line, (int)e.Start.Column, null, $"The file is not valid YAML: {e.Message.Split(':').Last().Trim()}")); return null; }
    }

    private static JsonNode? FromYaml(YamlNode n, int depth)
    {
        if (depth > 64) throw new YamlException("The file is nested too deeply.");
        switch (n)
        {
            case YamlMappingNode m:
                var o = new JsonObject();
                foreach (var (k, v) in m.Children) o[(k as YamlScalarNode)?.Value ?? k.ToString()] = FromYaml(v, depth + 1);
                return o;
            case YamlSequenceNode s:
                var a = new JsonArray();
                foreach (var c in s.Children) a.Add(FromYaml(c, depth + 1));
                return a;
            case YamlScalarNode sc:
                var v0 = sc.Value;
                if (v0 is null) return null;
                if (sc.Style != ScalarStyle.Plain) return JsonValue.Create(v0);
                if (v0 is "~" or "null" or "Null" or "NULL" or "") return null;
                if (v0 is "true" or "True" or "TRUE") return JsonValue.Create(true);
                if (v0 is "false" or "False" or "FALSE") return JsonValue.Create(false);
                if (long.TryParse(v0, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var l) && !(v0.Length > 1 && v0[0] == '0' && !v0.StartsWith("0.", StringComparison.Ordinal))) return JsonValue.Create(l);
                if (double.TryParse(v0, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) && !double.IsNaN(d) && !double.IsInfinity(d) && (char.IsDigit(v0[^1]))) return JsonValue.Create(d);
                return JsonValue.Create(v0);
            default: return null;
        }
    }

    /// <summary>The line (1-based) where a key first appears, searched after <paramref name="from"/>; null when it cannot be found.</summary>
    public static int? LineOf(string text, string key, int from = 0)
    {
        if (string.IsNullOrEmpty(key)) return null;
        var i = text.IndexOf($"\"{key}\"", from, StringComparison.Ordinal);
        if (i < 0) i = text.IndexOf($"{key}:", from, StringComparison.Ordinal);
        if (i < 0) return null;
        var line = 1; for (var j = 0; j < i; j++) if (text[j] == '\n') line++;
        return line;
    }

    // ------------------------------------------------------------------ import

    public static ParseResult Import(string text, string fallbackName)
    {
        var issues = new List<ImportIssue>();
        var root = ParseText(text, issues) as JsonObject;
        if (root is null)
        {
            if (!issues.Any(i => i.Severity == "error")) issues.Add(new ImportIssue("error", 1, 1, null, "The file does not describe an API (an OpenAPI document is an object)."));
            return new ParseResult(null, issues);
        }
        if (root["swagger"] is not null) { issues.Add(new ImportIssue("error", LineOf(text, "swagger"), null, "#/swagger", "This is a Swagger 2.0 file. Convert it to OpenAPI 3 first (the Swagger editor does it in one click).")); return new ParseResult(null, issues); }
        var version = root["openapi"]?.ToString();
        if (version is null || !version.StartsWith("3.")) { issues.Add(new ImportIssue("error", 1, 1, "#/openapi", "An OpenAPI 3 file starts with openapi: 3.0.x or 3.1.x.")); return new ParseResult(null, issues); }
        if (root["paths"] is not JsonObject paths) { issues.Add(new ImportIssue("error", LineOf(text, "paths"), null, "#/paths", "The file has no paths.")); return new ParseResult(null, issues); }

        var info = root["info"] as JsonObject;
        var servers = (root["servers"] as JsonArray)?.Select(s => (s as JsonObject)?["url"]?.ToString()).Where(u => !string.IsNullOrWhiteSpace(u)).Select(u => u!).ToList() ?? [];
        var auth = AuthOf(root, root["security"] as JsonArray);
        var endpoints = new List<ImportedEndpoint>();
        var seen = new HashSet<string>();
        foreach (var (path, itemNode) in paths)
        {
            if (itemNode is not JsonObject item) continue;
            if (path.StartsWith("x-")) continue;
            var pointerBase = $"#/paths/{path.Replace("~", "~0").Replace("/", "~1")}";
            string? cleanPath;
            try { cleanPath = ApiJson.NormalizePath(path); }
            catch (Exception) { issues.Add(new ImportIssue("error", LineOf(text, path), null, pointerBase, $"The path \"{path}\" cannot be used (a path starts with / and has no spaces).")); continue; }
            var shared = (item["parameters"] as JsonArray)?.Select(p => Deref(p, root, issues, text, pointerBase + "/parameters")).OfType<JsonObject>().ToList() ?? [];
            foreach (var m in Methods)
            {
                if (item[m] is not JsonObject op) continue;
                var pointer = $"{pointerBase}/{m}";
                if (endpoints.Count >= MaxEndpoints) { issues.Add(new ImportIssue("error", LineOf(text, path), null, pointer, $"A file can describe at most {MaxEndpoints:N0} endpoints; the rest were skipped.")); goto done; }
                if (!seen.Add($"{m} {cleanPath}")) { issues.Add(new ImportIssue("warning", LineOf(text, path), null, pointer, $"{m.ToUpperInvariant()} {cleanPath} appears twice; the first one is kept.")); continue; }
                try { endpoints.Add(ReadOperation(root, op, m, cleanPath, shared, auth, issues, text, pointer)); }
                catch (Exception e) when (e is not OutOfMemoryException) { issues.Add(new ImportIssue("error", LineOf(text, path), null, pointer, $"{m.ToUpperInvariant()} {cleanPath} was skipped: {e.Message}")); }
            }
        }
        done:
        var name = (info?["title"]?.ToString() ?? "").Trim();
        if (name.Length == 0) name = fallbackName;
        if (name.Length > 80) name = name[..80];
        return new ParseResult(new ImportedApi(name, Cut(info?["description"]?.ToString(), 2000), Cut(info?["version"]?.ToString(), 40), auth, servers.Take(20).ToList(), endpoints), issues);
    }

    private static string? Cut(string? s, int max) => string.IsNullOrWhiteSpace(s) ? null : s.Trim().Length > max ? s.Trim()[..max] : s.Trim();

    private static ApiAuthScheme AuthOf(JsonObject root, JsonArray? security)
    {
        if (security is null || security.Count == 0) return ApiAuthScheme.None;
        var schemes = (root["components"] as JsonObject)?["securitySchemes"] as JsonObject;
        var name = (security[0] as JsonObject)?.Select(x => x.Key).FirstOrDefault();
        return name is not null && schemes?[name] is JsonObject s ? SchemeOf(s) : ApiAuthScheme.None;
    }

    private static ApiAuthScheme SchemeOf(JsonObject s) => s["type"]?.ToString() switch
    {
        "apiKey" => ApiAuthScheme.ApiKey, "oauth2" or "openIdConnect" => ApiAuthScheme.OAuth2,
        "http" => string.Equals(s["scheme"]?.ToString(), "basic", StringComparison.OrdinalIgnoreCase) ? ApiAuthScheme.Basic : ApiAuthScheme.Bearer,
        _ => ApiAuthScheme.None,
    };

    private static ImportedEndpoint ReadOperation(JsonObject root, JsonObject op, string method, string path, List<JsonObject> shared, ApiAuthScheme apiAuth, List<ImportIssue> issues, string text, string pointer)
    {
        var d = new EndpointDetails { Description = Cut(op["description"]?.ToString(), 10_000) };
        var summary = op["summary"]?.ToString() ?? op["operationId"]?.ToString() ?? "";
        if (summary.Length > 300) { summary = summary[..300]; issues.Add(new ImportIssue("warning", LineOf(text, path), null, pointer + "/summary", "A summary longer than 300 characters was shortened.")); }
        var own = (op["parameters"] as JsonArray)?.Select(p => Deref(p, root, issues, text, pointer + "/parameters")).OfType<JsonObject>().ToList() ?? [];
        var merged = shared.Where(s => !own.Any(o => o["name"]?.ToString() == s["name"]?.ToString() && o["in"]?.ToString() == s["in"]?.ToString())).Concat(own);
        foreach (var p in merged)
        {
            var name = p["name"]?.ToString(); var where = p["in"]?.ToString()?.ToLowerInvariant();
            if (name is null || where is null) { issues.Add(new ImportIssue("warning", LineOf(text, path), null, pointer + "/parameters", "A parameter without a name or location was skipped.")); continue; }
            var schema = Deref(p["schema"], root, issues, text, pointer + "/parameters");
            var type = (schema as JsonObject)?["type"]?.ToString();
            var fmt = (schema as JsonObject)?["format"]?.ToString();
            d.Parameters.Add(new ApiParam(name, where, p["required"]?.GetValue<bool>() == true || where == "path", fmt is null ? type : $"{type}:{fmt}", Cut(p["description"]?.ToString(), 1000), ExampleText(p["example"] ?? FirstExample(p["examples"])), schema?.ToJsonString()));
        }
        if (Deref(op["requestBody"], root, issues, text, pointer + "/requestBody") is JsonObject rb)
        {
            var (ct, media) = FirstMedia(rb["content"] as JsonObject, issues, text, pointer + "/requestBody");
            d.RequestBody = new ApiBody(ct, rb["required"]?.GetValue<bool>() == true, Cut(rb["description"]?.ToString(), 1000), Deref(media?["schema"], root, issues, text, pointer + "/requestBody")?.ToJsonString(), ExampleText(media?["example"] ?? FirstExample(media?["examples"])));
        }
        if (op["responses"] is JsonObject responses)
            foreach (var (status, rn) in responses)
            {
                if (Deref(rn, root, issues, text, pointer + "/responses") is not JsonObject r) continue;
                var (ct, media) = FirstMedia(r["content"] as JsonObject, issues, text, pointer + "/responses/" + status);
                d.Responses.Add(new ApiResponse(status, Cut(r["description"]?.ToString(), 1000), ct, Deref(media?["schema"], root, issues, text, pointer + "/responses")?.ToJsonString(), ExampleText(media?["example"] ?? FirstExample(media?["examples"]))));
            }
        // the product's own extensions come back as they went out
        if (op["x-errors"] is JsonArray errs) d.Errors = errs.OfType<JsonObject>().Select(e => new ApiError(e["code"]?.ToString() ?? "", Cut(e["message"]?.ToString(), 500), Cut(e["description"]?.ToString(), 1000))).Where(e => e.Code.Length > 0).ToList();
        if (op["x-samples"] is JsonArray samples) d.Samples = samples.OfType<JsonObject>().Select(e => new ApiSample(e["title"]?.ToString() ?? "Sample", e["language"]?.ToString() ?? "text", e["code"]?.ToString() ?? "")).ToList();
        if (op["x-dependencies"] is JsonArray deps) d.Dependencies = deps.OfType<JsonObject>().Select(e => new ApiDependency(e["name"]?.ToString() ?? "", Cut(e["note"]?.ToString(), 500))).Where(e => e.Name.Length > 0).ToList();
        if (op["security"] is JsonArray sec)
        {
            if (sec.Count == 0) d.Auth = "none";
            else { var a = AuthOf(root, sec); d.Auth = a == ApiAuthScheme.None || a == apiAuth ? "inherit" : a.ToString(); }
        }
        d = ApiJson.Clean(d);
        return new ImportedEndpoint(method.ToUpperInvariant(), path, summary.Trim(), (op["tags"] as JsonArray)?.FirstOrDefault()?.ToString() is { Length: > 0 } t ? (t.Length > 80 ? t[..80] : t) : null, op["deprecated"]?.GetValue<bool>() == true, d);
    }

    private static (string? Type, JsonObject? Media) FirstMedia(JsonObject? content, List<ImportIssue> issues, string text, string pointer)
    {
        if (content is null || content.Count == 0) return (null, null);
        var pick = content.FirstOrDefault(c => c.Key.Contains("json", StringComparison.OrdinalIgnoreCase));
        if (pick.Key is null) pick = content.First();
        if (content.Count > 1) issues.Add(new ImportIssue("warning", null, null, pointer + "/content", $"Only one content type is kept ({pick.Key}); the others were skipped."));
        return (pick.Key, pick.Value as JsonObject);
    }

    private static JsonNode? FirstExample(JsonNode? examples) => (examples as JsonObject)?.Select(e => (e.Value as JsonObject)?["value"]).FirstOrDefault(v => v is not null);

    /// <summary>Strings stay as written; everything else is kept as JSON text.</summary>
    private static string? ExampleText(JsonNode? n)
    {
        if (n is null) return null;
        var t = n is JsonValue v && v.TryGetValue<string>(out var s) ? s : n.ToJsonString();
        return t.Length > ApiJson.MaxExampleChars ? t[..ApiJson.MaxExampleChars] : t;
    }

    /// <summary>Follows #/components/... references, copying what they point at in place. Cycles and outside references become an empty object, with a warning.</summary>
    public static JsonNode? Deref(JsonNode? node, JsonObject root, List<ImportIssue> issues, string text, string pointer, int depth = 0, HashSet<string>? chain = null)
    {
        if (node is null) return null;
        if (depth > 24) return new JsonObject();
        switch (node)
        {
            case JsonObject o:
                if (o["$ref"] is JsonValue rv && rv.TryGetValue<string>(out var r))
                {
                    chain ??= [];
                    if (!r.StartsWith("#/")) { issues.Add(new ImportIssue("warning", LineOf(text, r), null, pointer, $"The reference {r} points outside the file and was left empty.")); return new JsonObject(); }
                    if (!chain.Add(r)) return new JsonObject();
                    JsonNode? target = root;
                    foreach (var seg in r[2..].Split('/')) target = (target as JsonObject)?[seg.Replace("~1", "/").Replace("~0", "~")];
                    if (target is null) { issues.Add(new ImportIssue("warning", LineOf(text, r), null, pointer, $"The reference {r} was not found and was left empty.")); chain.Remove(r); return new JsonObject(); }
                    var resolved = Deref(target, root, issues, text, pointer, depth + 1, chain);
                    chain.Remove(r);
                    return resolved;
                }
                var copy = new JsonObject();
                foreach (var (k, v) in o) copy[k] = Deref(v, root, issues, text, pointer, depth + 1, chain);
                return copy;
            case JsonArray a:
                var arr = new JsonArray();
                foreach (var x in a) arr.Add(Deref(x, root, issues, text, pointer, depth + 1, chain));
                return arr;
            default: return node.DeepClone();
        }
    }

    // ------------------------------------------------------------------ export

    public static JsonObject Export(string title, ImportedApiHeader header, IEnumerable<(string Method, string Path, string Summary, string? Tag, bool Deprecated, EndpointDetails Details)> endpoints)
    {
        var doc = new JsonObject { ["openapi"] = "3.0.3" };
        var info = new JsonObject { ["title"] = title, ["version"] = header.Version ?? "1.0.0" };
        if (header.Description is not null) info["description"] = header.Description;
        doc["info"] = info;
        if (header.Servers.Count > 0) doc["servers"] = new JsonArray(header.Servers.Select(s => (JsonNode)new JsonObject { ["url"] = s }).ToArray());
        var schemeName = header.Auth switch { ApiAuthScheme.ApiKey => "apiKey", ApiAuthScheme.Bearer => "bearerAuth", ApiAuthScheme.Basic => "basicAuth", ApiAuthScheme.OAuth2 => "oauth2", _ => null };
        JsonObject? schemes = null;
        if (schemeName is not null)
        {
            schemes = new JsonObject { [schemeName] = SchemeNode(header.Auth) };
            doc["components"] = new JsonObject { ["securitySchemes"] = schemes };
            doc["security"] = new JsonArray(new JsonObject { [schemeName] = new JsonArray() });
        }
        var paths = new JsonObject();
        foreach (var e in endpoints.OrderBy(e => e.Path, StringComparer.Ordinal).ThenBy(e => e.Method))
        {
            var item = paths[e.Path] as JsonObject ?? (JsonObject)(paths[e.Path] = new JsonObject());
            var op = new JsonObject();
            if (e.Summary.Length > 0) op["summary"] = e.Summary;
            if (!string.IsNullOrEmpty(e.Details.Description)) op["description"] = e.Details.Description;
            if (e.Tag is not null) op["tags"] = new JsonArray(e.Tag);
            if (e.Deprecated) op["deprecated"] = true;
            if (e.Details.Parameters.Count > 0)
                op["parameters"] = new JsonArray(e.Details.Parameters.Select(p =>
                {
                    var n = new JsonObject { ["name"] = p.Name, ["in"] = p.In, ["required"] = p.Required };
                    if (p.Description is not null) n["description"] = p.Description;
                    n["schema"] = p.Schema is not null ? JsonNode.Parse(p.Schema) : new JsonObject { ["type"] = (p.Type ?? "string").Split(':')[0] };
                    if (p.Example is not null) n["example"] = ExampleNode(p.Example);
                    return (JsonNode)n;
                }).ToArray());
            if (e.Details.RequestBody is { } b)
            {
                var rb = new JsonObject { ["required"] = b.Required };
                if (b.Description is not null) rb["description"] = b.Description;
                rb["content"] = new JsonObject { [b.ContentType ?? "application/json"] = Media(b.Schema, b.Example) };
                op["requestBody"] = rb;
            }
            var responses = new JsonObject();
            foreach (var r in e.Details.Responses)
            {
                var rn = new JsonObject { ["description"] = r.Description ?? "" };
                if (r.ContentType is not null || r.Schema is not null || r.Example is not null) rn["content"] = new JsonObject { [r.ContentType ?? "application/json"] = Media(r.Schema, r.Example) };
                responses[r.Status] = rn;
            }
            if (responses.Count == 0) responses["default"] = new JsonObject { ["description"] = "" };
            op["responses"] = responses;
            if (e.Details.Auth == "none") op["security"] = new JsonArray();
            else if (e.Details.Auth is "ApiKey" or "Bearer" or "Basic" or "OAuth2" && Enum.Parse<ApiAuthScheme>(e.Details.Auth) is var scheme && scheme != header.Auth)
            {
                var nm = scheme switch { ApiAuthScheme.ApiKey => "apiKey", ApiAuthScheme.Bearer => "bearerAuth", ApiAuthScheme.Basic => "basicAuth", _ => "oauth2" };
                if (doc["components"] is not JsonObject comp) doc["components"] = comp = new JsonObject();
                if (comp["securitySchemes"] is not JsonObject ss) comp["securitySchemes"] = ss = new JsonObject();
                ss[nm] ??= SchemeNode(scheme);
                op["security"] = new JsonArray(new JsonObject { [nm] = new JsonArray() });
            }
            if (e.Details.Errors.Count > 0) op["x-errors"] = new JsonArray(e.Details.Errors.Select(x => (JsonNode)new JsonObject { ["code"] = x.Code, ["message"] = x.Message, ["description"] = x.Description }).ToArray());
            if (e.Details.Samples.Count > 0) op["x-samples"] = new JsonArray(e.Details.Samples.Select(x => (JsonNode)new JsonObject { ["title"] = x.Title, ["language"] = x.Language, ["code"] = x.Code }).ToArray());
            if (e.Details.Dependencies.Count > 0) op["x-dependencies"] = new JsonArray(e.Details.Dependencies.Select(x => (JsonNode)new JsonObject { ["name"] = x.Name, ["note"] = x.Note }).ToArray());
            item[e.Method.ToLowerInvariant()] = op;
        }
        doc["paths"] = paths;
        return doc;
    }

    public sealed record ImportedApiHeader(string? Description, string? Version, ApiAuthScheme Auth, List<string> Servers);

    private static JsonObject SchemeNode(ApiAuthScheme a) => a switch
    {
        ApiAuthScheme.ApiKey => new JsonObject { ["type"] = "apiKey", ["in"] = "header", ["name"] = "X-API-Key" },
        ApiAuthScheme.Basic => new JsonObject { ["type"] = "http", ["scheme"] = "basic" },
        ApiAuthScheme.OAuth2 => new JsonObject { ["type"] = "oauth2", ["flows"] = new JsonObject() },
        _ => new JsonObject { ["type"] = "http", ["scheme"] = "bearer" },
    };

    private static JsonObject Media(string? schema, string? example)
    {
        var m = new JsonObject();
        if (schema is not null) m["schema"] = JsonNode.Parse(schema);
        if (example is not null) m["example"] = ExampleNode(example);
        return m;
    }

    private static JsonNode? ExampleNode(string text)
    {
        var t = text.TrimStart();
        if (t.Length > 0 && (t[0] is '{' or '[' || t == "true" || t == "false" || t == "null" || double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out _)))
            try { return JsonNode.Parse(text); } catch (JsonException) { /* plain text */ }
        return JsonValue.Create(text);
    }

    public static string ToJsonText(JsonNode node) => node.ToJsonString(new JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
}
