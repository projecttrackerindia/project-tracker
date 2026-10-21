using System.Text.Json;
using System.Text.Json.Nodes;
using ProjectManagement.Application.Features.Documents;

namespace ProjectManagement.Application.Features.ApiDocs;

/// <summary>
/// Masks personal and secret values in an endpoint's documentation: parameter and header examples (by their name, then by shape), JSON
/// request and response examples (by key and shape), error texts and code samples. Works on a copy; the stored endpoint is never changed.
/// </summary>
public static class EndpointMasking
{
    private static readonly JsonSerializerOptions Indented = new() { WriteIndented = true };

    public static EndpointDetails Mask(EndpointDetails source, PiiMasker m)
    {
        var d = ApiJson.Read(ApiJson.Write(source));   // a deep copy
        d.Description = Text(d.Description, m);
        d.Parameters = d.Parameters.Select(p => p with
        {
            Example = p.Example is { Length: > 0 } ex ? (m.RuleFor(p.Name) is { } r ? Hide(ex, r.Strategy, m) : Example(ex, m)) : p.Example,
            Description = Text(p.Description, m),
        }).ToList();
        if (d.RequestBody is { } b) d.RequestBody = b with { Example = Example(b.Example, m), Description = Text(b.Description, m) };
        d.Responses = d.Responses.Select(r => r with { Example = Example(r.Example, m), Description = Text(r.Description, m) }).ToList();
        d.Errors = d.Errors.Select(e => e with { Message = Text(e.Message, m), Description = Text(e.Description, m) }).ToList();
        d.Samples = d.Samples.Select(s => s with { Code = Example(s.Code, m) ?? s.Code }).ToList();
        return d;
    }

    private static string? Text(string? s, PiiMasker m) => string.IsNullOrEmpty(s) ? s : m.MaskText(s);
    private static string Hide(string value, string strategy, PiiMasker m) => m.HideValue(value, strategy);

    /// <summary>A JSON example is masked by key and shape and kept pretty; anything else as text.</summary>
    private static string? Example(string? s, PiiMasker m)
    {
        if (string.IsNullOrWhiteSpace(s)) return s;
        var t = s.Trim();
        if (t.StartsWith('{') || t.StartsWith('['))
            try { return m.MaskJson(JsonNode.Parse(t))?.ToJsonString(Indented) ?? s; } catch (JsonException) { }
        return m.MaskText(s);
    }

    /// <summary>True when any example or text still carries mask dots (a masked copy must not be saved over the real one).</summary>
    public static bool LooksMasked(EndpointDetails d) => PiiMasker.LooksMasked(ApiJson.Write(d));
}
