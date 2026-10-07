using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using ProjectManagement.Application.Exceptions;

namespace ProjectManagement.Application.Features.ApiDocs;

public sealed record ApiParam(string Name, string In, bool Required, string? Type, string? Description, string? Example, string? Schema);
public sealed record ApiBody(string? ContentType, bool Required, string? Description, string? Schema, string? Example);
public sealed record ApiResponse(string Status, string? Description, string? ContentType, string? Schema, string? Example);
public sealed record ApiError(string Code, string? Message, string? Description);
public sealed record ApiSample(string Title, string Language, string Code);
public sealed record ApiDependency(string Name, string? Note);

/// <summary>Everything about one endpoint beyond its method, path and summary. Schemas and examples are kept as the text the author wrote (schemas must be valid JSON).</summary>
public sealed class EndpointDetails
{
    public string? Description { get; set; }
    /// <summary>"inherit" (the API's scheme), "none", or one of ApiKey, Bearer, Basic, OAuth2.</summary>
    public string Auth { get; set; } = "inherit";
    public List<ApiParam> Parameters { get; set; } = [];
    public ApiBody? RequestBody { get; set; }
    public List<ApiResponse> Responses { get; set; } = [];
    public List<ApiError> Errors { get; set; } = [];
    public List<ApiSample> Samples { get; set; } = [];
    public List<ApiDependency> Dependencies { get; set; } = [];
    /// <summary>The request flow as a text diagram (flowchart subset of Mermaid): who calls whom for this endpoint. Drawn on screen and in the PDF.</summary>
    public string? Flow { get; set; }
}

/// <summary>Reading, checking and writing endpoint details. The limits keep one endpoint from becoming a way to store a file.</summary>
public static class ApiJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
    public const int MaxParams = 100, MaxResponses = 40, MaxErrors = 60, MaxSamples = 20, MaxDependencies = 40, MaxSchemaChars = 50_000, MaxExampleChars = 20_000, MaxDetailsChars = 250_000;
    private static readonly HashSet<string> ParamLocations = ["query", "path", "header", "cookie"];

    public static EndpointDetails Read(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new EndpointDetails();
        try { return JsonSerializer.Deserialize<EndpointDetails>(json, Options) ?? new EndpointDetails(); }
        catch (JsonException) { return new EndpointDetails(); }
    }

    public static string Write(EndpointDetails d) => JsonSerializer.Serialize(d, Options);

    /// <summary>Cleans and checks details from a person or an import. Throws a validation error naming the field.</summary>
    public static EndpointDetails Clean(EndpointDetails d, string field = "details")
    {
        string? T(string? s, int max, string f) { var t = string.IsNullOrWhiteSpace(s) ? null : s.Trim(); if (t is { } x && x.Length > max) throw new ValidationException(f, $"Keep this under {max:N0} characters."); return t; }
        string? Schema(string? s, string f)
        {
            var t = T(s, MaxSchemaChars, f);
            if (t is null) return null;
            try { JsonNode.Parse(t); } catch (JsonException e) { throw new ValidationException(f, $"A schema must be valid JSON ({e.Message.Split('.')[0]})."); }
            return t;
        }
        if (d.Parameters.Count > MaxParams) throw new ValidationException($"{field}.parameters", $"An endpoint has at most {MaxParams} parameters.");
        if (d.Responses.Count > MaxResponses) throw new ValidationException($"{field}.responses", $"An endpoint has at most {MaxResponses} responses.");
        if (d.Errors.Count > MaxErrors) throw new ValidationException($"{field}.errors", $"An endpoint has at most {MaxErrors} documented errors.");
        if (d.Samples.Count > MaxSamples) throw new ValidationException($"{field}.samples", $"An endpoint has at most {MaxSamples} samples.");
        if (d.Dependencies.Count > MaxDependencies) throw new ValidationException($"{field}.dependencies", $"An endpoint has at most {MaxDependencies} dependencies.");
        var auth = (d.Auth ?? "inherit").Trim();
        if (!new[] { "inherit", "none", "ApiKey", "Bearer", "Basic", "OAuth2" }.Contains(auth)) throw new ValidationException($"{field}.auth", "Choose how this endpoint is authenticated.");
        var clean = new EndpointDetails
        {
            Description = T(d.Description, 10_000, $"{field}.description"), Auth = auth, Flow = FlowText(d.Flow, field),
            Parameters = d.Parameters.Select((p, i) =>
            {
                var name = T(p.Name, 100, $"{field}.parameters[{i}].name") ?? throw new ValidationException($"{field}.parameters[{i}].name", "Name every parameter.");
                var where = (p.In ?? "query").Trim().ToLowerInvariant();
                if (!ParamLocations.Contains(where)) throw new ValidationException($"{field}.parameters[{i}].in", "A parameter is in the query, the path, a header or a cookie.");
                return new ApiParam(name, where, p.Required || where == "path", T(p.Type, 60, $"{field}.parameters[{i}].type"), T(p.Description, 1000, $"{field}.parameters[{i}].description"), T(p.Example, 1000, $"{field}.parameters[{i}].example"), Schema(p.Schema, $"{field}.parameters[{i}].schema"));
            }).ToList(),
            RequestBody = d.RequestBody is null ? null : new ApiBody(T(d.RequestBody.ContentType, 100, $"{field}.requestBody.contentType"), d.RequestBody.Required, T(d.RequestBody.Description, 1000, $"{field}.requestBody.description"),
                Schema(d.RequestBody.Schema, $"{field}.requestBody.schema"), T(d.RequestBody.Example, MaxExampleChars, $"{field}.requestBody.example")),
            Responses = d.Responses.Select((r, i) => new ApiResponse(T(r.Status, 12, $"{field}.responses[{i}].status") ?? throw new ValidationException($"{field}.responses[{i}].status", "Give every response a status (200, 404, default ...)."),
                T(r.Description, 1000, $"{field}.responses[{i}].description"), T(r.ContentType, 100, $"{field}.responses[{i}].contentType"), Schema(r.Schema, $"{field}.responses[{i}].schema"), T(r.Example, MaxExampleChars, $"{field}.responses[{i}].example"))).ToList(),
            Errors = d.Errors.Select((e, i) => new ApiError(T(e.Code, 60, $"{field}.errors[{i}].code") ?? throw new ValidationException($"{field}.errors[{i}].code", "Give every error a code."), T(e.Message, 500, $"{field}.errors[{i}].message"), T(e.Description, 1000, $"{field}.errors[{i}].description"))).ToList(),
            Samples = d.Samples.Select((s, i) => new ApiSample(T(s.Title, 100, $"{field}.samples[{i}].title") ?? "Sample", T(s.Language, 20, $"{field}.samples[{i}].language") ?? "text", T(s.Code, MaxExampleChars, $"{field}.samples[{i}].code") ?? "")).ToList(),
            Dependencies = d.Dependencies.Select((x, i) => new ApiDependency(T(x.Name, 200, $"{field}.dependencies[{i}].name") ?? throw new ValidationException($"{field}.dependencies[{i}].name", "Name what it depends on."), T(x.Note, 500, $"{field}.dependencies[{i}].note"))).ToList(),
        };
        if (Write(clean).Length > MaxDetailsChars) throw new ValidationException(field, "This endpoint's details are too large.");
        return clean;
    }

    /// <summary>A request flow must be a drawable diagram, so a mistake is reported where it is typed and not later in a PDF.</summary>
    private static string? FlowText(string? flow, string field)
    {
        if (string.IsNullOrWhiteSpace(flow)) return null;
        var text = flow.Trim();
        if (text.Length > 4000) throw new ValidationException($"{field}.flow", "Keep the request flow under 4,000 characters.");
        try { ProjectManagement.Application.Features.Documents.DiagramEngine.Draw(text); }
        catch (ProjectManagement.Application.Features.Documents.DiagramException e) { throw new ValidationException($"{field}.flow", e.Line > 0 ? $"Request flow, line {e.Line}: {e.Message}" : $"Request flow: {e.Message}"); }
        return text;
    }

    public static List<string> ReadServers(string? json)
    {
        try { return JsonSerializer.Deserialize<List<string>>(json ?? "[]", Options) ?? []; } catch (JsonException) { return []; }
    }

    public static string WriteServers(IEnumerable<string>? servers) => JsonSerializer.Serialize((servers ?? []).Select(s => s.Trim()).Where(s => s.Length > 0).Distinct().Take(20).ToList(), Options);

    /// <summary>The path as it is kept: one leading slash, no query, no trailing slash (except the root).</summary>
    public static string NormalizePath(string? path, string field = "path")
    {
        var p = (path ?? "").Trim();
        var q = p.IndexOfAny(['?', '#']); if (q >= 0) p = p[..q];
        if (p.Length == 0) throw new ValidationException(field, "Write the path, for example /users/{id}.");
        if (!p.StartsWith('/')) p = "/" + p;
        while (p.Length > 1 && p.EndsWith('/')) p = p[..^1];
        if (p.Length > 400) throw new ValidationException(field, "A path is at most 400 characters.");
        if (p.Any(c => c < ' ' || c == ' ')) throw new ValidationException(field, "A path has no spaces or control characters.");
        return p;
    }
}
