using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.ApiDocs;

/// <summary>One difference between the documented sample response and what the API answered: a field only in the docs ("missing"), only live ("extra"), or of another type ("type").</summary>
public record DriftField(string Path, string Kind, string? Documented, string? Live);
/// <summary>
/// The last "Check against live" of an endpoint. Holds field names and JSON types only, never a value from the response, the environment's
/// label (DEV / UAT / PROD), never its address, and an error in plain words, never the exception text (which can name hosts).
/// </summary>
public record LiveCheckDto(DateTime CheckedAt, string Env, string Source, int? Status, string? ComparedWith, bool Differs, IReadOnlyList<DriftField> Fields, string? Error);
/// <param name="Env">Which of the API's servers (0-based, as listed) to call.</param>
/// <param name="Values">Path and query values, keyed "path:id" / "query:page" (the same keys Try it uses).</param>
/// <param name="LiveBody">A real response pasted from elsewhere (Postman, logs) to compare instead of calling the API.</param>
public record LiveCheckRequest(int? Env = null, Dictionary<string, string>? Values = null, string? LiveBody = null);

/// <summary>Where a host points (tests replace this; the real one asks DNS).</summary>
public class ApiLiveResolver
{
    public virtual Task<IPAddress[]> ResolveAsync(string host, CancellationToken ct) => Dns.GetHostAddressesAsync(host, ct);
}

/// <summary>
/// API drift: the endpoint's documented sample response compared with a live one. The live response comes from the API itself (called from
/// the server, with the document's stored credential, never from the browser) or is pasted. Only the shape is compared and kept: which
/// fields are missing, extra or of another type. The result is kept with the endpoint (inside its details, outside its fingerprint, so a check
/// is not a change of the document) until the endpoint is edited.
/// </summary>
public class ApiDriftService(IAppDbContext db, AppClock clock, Recorder recorder, ApiDocService api, SecretService secrets, IHttpClientFactory http, ApiLiveResolver resolver)
{
    public const string Key = "liveCheck";
    public const int MaxFields = 60, MaxBody = 400_000;

    public async Task<LiveCheckDto> CheckAsync(Guid documentId, Guid endpointId, LiveCheckRequest req, CancellationToken ct = default)
    {
        var (doc, _) = await api.OpenAsync(documentId, true, ct);
        var e = await db.ApiEndpoints.FirstOrDefaultAsync(x => x.Id == endpointId && x.DocumentId == documentId, ct) ?? throw new NotFoundException("Endpoint not found.");
        var details = ApiJson.Read(e.DetailsJson);
        var sample = details.Responses.Where(r => r.Status.StartsWith('2') && !string.IsNullOrWhiteSpace(r.Example)).Select(r => (r.Status, Body: r.Example!)).FirstOrDefault();
        if (sample.Body is null) throw new ValidationException("responses", "Add a sample success response (2xx with an example body) first; the check compares against it.");
        var def = await db.ApiDefinitions.AsNoTracking().FirstOrDefaultAsync(d => d.Id == e.DefinitionId, ct) ?? throw new NotFoundException("API not found.");
        var servers = ApiJson.ReadServers(def.ServersJson);

        LiveCheckDto result;
        if (!string.IsNullOrWhiteSpace(req.LiveBody))
        {
            if (req.LiveBody.Length > MaxBody) throw new ValidationException("liveBody", "That response is too long to compare.");
            result = Compare(sample.Status, sample.Body, req.LiveBody, null, "Pasted", "pasted");
        }
        else
        {
            if (servers.Count == 0) throw new ValidationException("servers", "This API has no environment address yet. Add one to the API first.");
            var i = Math.Clamp(req.Env ?? 0, 0, servers.Count - 1);
            var env = EnvLabel(servers, i);
            result = await CallAsync(doc.Id, def, e, details, servers[i], env, req.Values ?? [], sample, ct);
        }

        // Kept with the endpoint, outside its fingerprint (Hash is not recomputed), so it is not a change to review or publish.
        var node = JsonNode.Parse(string.IsNullOrWhiteSpace(e.DetailsJson) ? "{}" : e.DetailsJson) as JsonObject ?? new JsonObject();
        node[Key] = JsonSerializer.SerializeToNode(result, ApiJson.Options);
        e.DetailsJson = node.ToJsonString();
        recorder.Audit("api.live_checked", "ApiEndpoint", e.Id, null, new { document = doc.Id, env = result.Env, source = result.Source, status = result.Status, differences = result.Fields.Count, error = result.Error is not null });
        await db.SaveChangesAsync(ct);
        return result;
    }

    /// <summary>The last check kept in an endpoint's details JSON, if any.</summary>
    public static LiveCheckDto? Read(string? detailsJson)
    {
        if (string.IsNullOrWhiteSpace(detailsJson) || !detailsJson.Contains($"\"{Key}\"", StringComparison.Ordinal)) return null;
        try { return JsonNode.Parse(detailsJson)?[Key] is JsonObject o ? o.Deserialize<LiveCheckDto>(ApiJson.Options) : null; }
        catch (JsonException) { return null; }
    }

    private async Task<LiveCheckDto> CallAsync(Guid documentId, ApiDefinition def, ApiEndpoint e, EndpointDetails d, string server, string env, Dictionary<string, string> values,
        (string Status, string Body) sample, CancellationToken ct)
    {
        LiveCheckDto Fail(string why, int? status = null) => new(clock.Now, env, "live", status, sample.Status, false, [], why);
        var path = e.Path;
        foreach (var p in d.Parameters.Where(x => x.In == "path"))
        {
            var v = values.GetValueOrDefault($"path:{p.Name}") ?? p.Example;
            if (string.IsNullOrWhiteSpace(v)) return Fail($"Give a value for {p.Name} to call the API.");
            path = path.Replace($"{{{p.Name}}}", Uri.EscapeDataString(v.Trim()), StringComparison.Ordinal);
        }
        var query = string.Join('&', d.Parameters.Where(x => x.In == "query" && !string.IsNullOrWhiteSpace(values.GetValueOrDefault($"query:{x.Name}")))
            .Select(x => $"{Uri.EscapeDataString(x.Name)}={Uri.EscapeDataString(values[$"query:{x.Name}"].Trim())}"));
        var url = $"{server.TrimEnd('/')}{(def.BasePath ?? "").TrimEnd('/')}{(path.StartsWith('/') ? "" : "/")}{path}{(query.Length > 0 ? $"?{query}" : "")}";
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)) return Fail("This environment's address is not a web address.");
        try
        {
            foreach (var a in await resolver.ResolveAsync(uri.Host, ct))
                if (IPAddress.IsLoopback(a) || ProjectManagement.Application.Features.Voice.ConnectorCaller.Private(a) || a.Equals(IPAddress.Any) || a.Equals(IPAddress.IPv6Any))
                    return Fail("This environment is on a private network, so it cannot be reached from ProjectTracker. Paste a real response instead.");
        }
        catch (SocketException) { return Fail("The environment's address could not be found."); }

        // Only reads are sent: a check must never create, change or delete anything on the real system.
        var method = new HttpMethod(e.Method.ToString().ToUpperInvariant());
        if (method != HttpMethod.Get) return Fail($"Only GET calls are checked live, so nothing is changed on the real system. Paste a real {method.Method} response instead.");
        using var msg = new HttpRequestMessage(method, uri);
        msg.Headers.TryAddWithoutValidation("Accept", "application/json");
        var scheme = d.Auth == "inherit" ? def.Auth.ToString() : d.Auth;
        if (scheme is "Bearer" or "OAuth2" or "ApiKey" or "Basic")
        {
            var secret = await secrets.ValueForCallAsync(documentId, scheme, ct);
            if (secret is null) return Fail($"Keep the {(scheme == "ApiKey" ? "API key" : scheme == "Basic" ? "user:password" : "token")} in this document's Secrets (a label with “{(scheme == "ApiKey" ? "key" : scheme == "Basic" ? "basic" : "token")}”) to check it live.");
            if (scheme == "ApiKey") msg.Headers.TryAddWithoutValidation(d.Parameters.FirstOrDefault(p => p.In == "header" && p.Name.Contains("key", StringComparison.OrdinalIgnoreCase))?.Name ?? "X-API-Key", secret);
            else if (scheme == "Basic") msg.Headers.TryAddWithoutValidation("Authorization", "Basic " + Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(secret)));
            else msg.Headers.TryAddWithoutValidation("Authorization", "Bearer " + secret);
        }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(8));
        try
        {
            using var res = await http.CreateClient("api-live").SendAsync(msg, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            var status = (int)res.StatusCode;
            if (status >= 300) return Fail(status is 401 or 403 ? $"The API refused the stored credential ({status})." : $"The API answered {status}.", status);
            var text = await res.Content.ReadAsStringAsync(timeout.Token);
            if (text.Length > MaxBody) text = text[..MaxBody];
            return Compare(sample.Status, sample.Body, text, status, env, "live");
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return Fail("The API did not answer within 8 seconds."); }
        catch (HttpRequestException) { return Fail("The API could not be reached."); }
    }

    private LiveCheckDto Compare(string sampleStatus, string documented, string live, int? status, string env, string source)
    {
        JsonNode? doc, got;
        try { doc = JsonNode.Parse(documented); } catch (JsonException) { return new(clock.Now, env, source, status, sampleStatus, false, [], "The documented sample is not JSON, so it cannot be compared."); }
        try { got = JsonNode.Parse(live); } catch (JsonException) { return new(clock.Now, env, source, status, sampleStatus, false, [], "The live response is not JSON."); }
        var fields = Diff(doc, got);
        return new(clock.Now, env, source, status, sampleStatus, fields.Count > 0, fields.Take(MaxFields).ToList(), null);
    }

    /// <summary>The JSON type of a node, as the docs name types.</summary>
    public static string TypeOf(JsonNode? n) => n switch
    {
        null => "null", JsonObject => "object", JsonArray => "array",
        JsonValue v when v.GetValueKind() is JsonValueKind.Number => "number",
        JsonValue v when v.GetValueKind() is JsonValueKind.True or JsonValueKind.False => "boolean",
        JsonValue v when v.GetValueKind() is JsonValueKind.Null => "null",
        _ => "string",
    };

    /// <summary>Missing, extra and changed-type fields between two JSON documents, as a.b and a[].b paths. Arrays compare their first item; null on either side is not a type change.</summary>
    public static List<DriftField> Diff(JsonNode? documented, JsonNode? live)
    {
        var o = new List<DriftField>();
        void Walk(JsonNode? a, JsonNode? b, string path, int depth)
        {
            if (depth > 8 || o.Count >= MaxFields * 2) return;
            var ta = TypeOf(a); var tb = TypeOf(b);
            if (ta == "null" || tb == "null") return;
            if (ta != tb) { o.Add(new DriftField(path.Length == 0 ? "(body)" : path, "type", ta, tb)); return; }
            if (a is JsonObject oa && b is JsonObject ob)
            {
                foreach (var (k, v) in oa) { var p = path.Length == 0 ? k : $"{path}.{k}"; if (!ob.ContainsKey(k)) o.Add(new DriftField(p, "missing", TypeOf(v), null)); else Walk(v, ob[k], p, depth + 1); }
                foreach (var (k, v) in ob) if (!oa.ContainsKey(k)) o.Add(new DriftField(path.Length == 0 ? k : $"{path}.{k}", "extra", null, TypeOf(v)));
            }
            else if (a is JsonArray aa && b is JsonArray ab && aa.Count > 0 && ab.Count > 0) Walk(aa[0], ab[0], $"{path}[]", depth + 1);
        }
        Walk(documented, live, "", 0);
        return o;
    }

    /// <summary>DEV / UAT / PROD from the host's words, otherwise by position: what the screen calls an environment, never its address.</summary>
    public static string EnvLabel(IReadOnlyList<string> servers, int i)
    {
        var host = Uri.TryCreate(servers[i], UriKind.Absolute, out var u) ? u.Host.ToLowerInvariant() : servers[i].ToLowerInvariant();
        var parts = host.Split('.'); if (parts.Length > 1) parts = parts[..^1];
        var words = string.Join('-', parts).Split('-', '_').ToHashSet();
        bool Has(params string[] w) => w.Any(words.Contains);
        if (Has("uat", "stg", "staging", "stage", "preprod")) return "UAT";
        if (Has("sit", "qa", "test")) return "SIT";
        if (Has("dev", "sandbox", "local", "localhost")) return "DEV";
        if (Has("prod", "production", "live", "api", "www")) return "PROD";
        string[] order = ["DEV", "UAT", "PROD"];
        var k = order.Length - servers.Count + i;
        return servers.Count <= 3 && k >= 0 && k < order.Length ? order[k] : $"ENV {i + 1}";
    }
}
