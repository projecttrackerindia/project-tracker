using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Voice;

/// <summary>
/// Calls one of the workspace's connected systems (a connector: method, address with {placeholders}, one secret header). Shared by the phone
/// agent and the WhatsApp desk, so both reach the same systems the same safe way: every value checked, never a private address, eight seconds
/// at most, and only the first 6,000 characters of the answer kept.
/// </summary>
public class ConnectorCaller(IHttpClientFactory http, ISecretProtector secrets)
{
    public static readonly Regex Placeholder = new(@"\{([A-Za-z][A-Za-z0-9_]{0,40})\}", RegexOptions.Compiled);

    /// <summary>Where a host points (tests replace this; the real one asks DNS).</summary>
    protected virtual Task<IPAddress[]> ResolveAsync(string host, CancellationToken ct) => Dns.GetHostAddressesAsync(host, ct);

    public async Task<string> SendAsync(VoiceConnector c, IReadOnlyDictionary<string, string> args, VoiceFlow? flow, CancellationToken ct)
    {
        string Value(string key)
        {
            var v = args.TryGetValue(key, out var x) ? x : throw new ValidationException(key, $"'{key}' is needed.");
            if (v.Length > 64 || !Regex.IsMatch(v, @"^[\p{L}\p{N} _\-./@,]+$")) throw new ValidationException(key, "That value cannot be used.");
            return v.Trim();
        }
        var url = Placeholder.Replace(c.UrlTemplate, m => Uri.EscapeDataString(Value(m.Groups[1].Value)));
        var uri = new Uri(url);
        foreach (var addr in await ResolveAsync(uri.Host, ct))
            if (IPAddress.IsLoopback(addr) || Private(addr)) throw new ConflictException("This connector points at a private address.");
        using var req = new HttpRequestMessage(c.Method == "POST" ? HttpMethod.Post : HttpMethod.Get, uri);
        if (c.HeaderName is { } h && c.SecretProtected is { } sec) req.Headers.TryAddWithoutValidation(h, secrets.Unprotect(sec));
        foreach (var hd in flow?.Headers ?? [])
            if (!string.Equals(hd.Name, c.HeaderName, StringComparison.OrdinalIgnoreCase)) req.Headers.TryAddWithoutValidation(hd.Name, Placeholder.Replace(hd.Value ?? "", m => Value(m.Groups[1].Value)));
        if (c.Method == "POST")
        {
            var requestBody = flow?.BodyTemplate is { Length: > 0 } t
                ? Placeholder.Replace(t, m => JsonEncodedText.Encode(Value(m.Groups[1].Value)).ToString())
                : new JsonObject(args.Select(a => KeyValuePair.Create(a.Key, (JsonNode?)JsonValue.Create(a.Value)))).ToJsonString();
            req.Content = new StringContent(requestBody, Encoding.UTF8, "application/json");
        }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(8));
        using var res = await http.CreateClient("voice-connector").SendAsync(req, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        if (!res.IsSuccessStatusCode) return $"(the API answered {(int)res.StatusCode})";
        try { var body = await BoundedHttpContent.ReadUtf8Async(res.Content, 24_000, timeout.Token); return body.Length > 6000 ? body[..6000] : body; }
        catch (HttpBodyTooLargeException) { throw new ConflictException("The connector response exceeds the allowed size."); }
    }

    /// <summary>Another connector a flow chains to, by name (only enabled ones).</summary>
    public Task<string> SendOtherAsync(IEnumerable<VoiceConnector> connectors, string name, IReadOnlyDictionary<string, string> args, CancellationToken ct) =>
        connectors.FirstOrDefault(c => c.Name == name && c.Enabled) is { } c ? SendAsync(c, args, VoiceFlowRunner.Parse(c.FlowJson), ct)
            : Task.FromResult($"(no connector named {name})");

    public static bool Private(IPAddress a) => WebhookUrlRules.IsBlocked(a);
}
