using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Infrastructure.Services;

/// <summary>Sends to whichever kind of device a subscription is: the Android app through Firebase, anything else as Web Push.</summary>
public class DevicePushSender(WebPushSender web, FcmSender fcm) : IWebPushSender
{
    public Task<int?> SendAsync(PushSubscription subscription, string payload, VapidKeys keys, CancellationToken ct) =>
        PushService.IsNative(subscription.Endpoint) ? fcm.SendAsync(subscription, payload, ct) : web.SendAsync(subscription, payload, keys, ct);
}

/// <summary>
/// Push to the Android app through Firebase Cloud Messaging (HTTP v1) without a library: a service-account JWT (RS256) is exchanged for a
/// short-lived access token, which is kept until shortly before it expires. The same payload as Web Push goes in; the phone shows the
/// notification itself even when the app is closed, and tapping it opens "link".
/// </summary>
public class FcmSender(IHttpClientFactory http, IOptions<PushOptions> options, ILogger<FcmSender> log)
{
    private sealed record Account(string ProjectId, string ClientEmail, string PrivateKey, string TokenUri);

    private readonly SemaphoreSlim gate = new(1, 1);
    private string? accessToken;
    private DateTime accessExpires;
    private Account? account;
    private bool loaded;

    public async Task<int?> SendAsync(PushSubscription subscription, string payload, CancellationToken ct)
    {
        var acct = Load();
        if (acct is null) return null;   // not set up: counts as a failed attempt, nothing else
        var bearer = await TokenAsync(acct, ct);
        if (bearer is null) return null;
        var body = BuildMessage(subscription.Endpoint[PushService.NativePrefix.Length..], payload);
        using var req = new HttpRequestMessage(HttpMethod.Post, $"https://fcm.googleapis.com/v1/projects/{acct.ProjectId}/messages:send")
        { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        using var res = await http.CreateClient("push").SendAsync(req, ct);
        var code = (int)res.StatusCode;
        if (code is >= 200 and < 300) return 201;
        var text = await res.Content.ReadAsStringAsync(ct);
        if (code == 401) { accessToken = null; }
        // The token is no longer valid: the app was removed or its data cleared.
        if (code == 404 || (code == 400 && text.Contains("INVALID_ARGUMENT", StringComparison.Ordinal) && text.Contains("registration token", StringComparison.OrdinalIgnoreCase))) return 404;
        log.LogDebug("FCM answered {Code}: {Text}", code, text.Length > 300 ? text[..300] : text);
        return code;
    }

    /// <summary>The FCM message for the Web Push payload: a notification (shown by the system) plus the data the app uses to open the right page.</summary>
    public static string BuildMessage(string deviceToken, string payload)
    {
        using var doc = JsonDocument.Parse(payload);
        var root = doc.RootElement;
        string? Get(string name) => root.TryGetProperty(name, out var v) && v.ValueKind is not JsonValueKind.Null ? (v.ValueKind == JsonValueKind.String ? v.GetString() : v.ToString()) : null;
        var data = new Dictionary<string, string>();
        foreach (var name in new[] { "link", "tag", "type", "token", "urgent", "number" })
            if (Get(name) is { Length: > 0 } v) data[name] = v;
        var title = Get("title") ?? "Project Tracker";
        var message = new Dictionary<string, object?>
        {
            ["token"] = deviceToken,
            ["notification"] = new { title, body = Get("body") ?? "" },
            ["data"] = data,
            ["android"] = new
            {
                priority = "HIGH",
                ttl = "86400s",
                notification = new { channel_id = "alerts", tag = Get("tag"), click_action = "FCM_PLUGIN_ACTIVITY" },
            },
        };
        return JsonSerializer.Serialize(new { message });
    }

    private Account? Load()
    {
        if (loaded) return account;
        loaded = true;
        try
        {
            var o = options.Value;
            var json = !string.IsNullOrWhiteSpace(o.FcmServiceAccountJson) ? o.FcmServiceAccountJson
                : !string.IsNullOrWhiteSpace(o.FcmServiceAccountFile) && File.Exists(o.FcmServiceAccountFile) ? File.ReadAllText(o.FcmServiceAccountFile) : null;
            if (json is null) return null;
            using var doc = JsonDocument.Parse(json);
            var r = doc.RootElement;
            account = new Account(r.GetProperty("project_id").GetString()!, r.GetProperty("client_email").GetString()!, r.GetProperty("private_key").GetString()!,
                r.TryGetProperty("token_uri", out var t) ? t.GetString()! : "https://oauth2.googleapis.com/token");
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or IOException) { log.LogWarning(ex, "The Firebase service-account key could not be read"); account = null; }
        return account;
    }

    private async Task<string?> TokenAsync(Account a, CancellationToken ct)
    {
        if (accessToken is not null && DateTime.UtcNow < accessExpires) return accessToken;
        await gate.WaitAsync(ct);
        try
        {
            if (accessToken is not null && DateTime.UtcNow < accessExpires) return accessToken;
            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            var header = Base64Url.Encode("""{"alg":"RS256","typ":"JWT"}"""u8);
            var claims = Base64Url.Encode(JsonSerializer.SerializeToUtf8Bytes(new
            {
                iss = a.ClientEmail, scope = "https://www.googleapis.com/auth/firebase.messaging", aud = a.TokenUri, iat = now, exp = now + 3600,
            }));
            using var rsa = RSA.Create();
            rsa.ImportFromPem(a.PrivateKey);
            var sig = rsa.SignData(Encoding.ASCII.GetBytes($"{header}.{claims}"), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            using var req = new HttpRequestMessage(HttpMethod.Post, a.TokenUri)
            {
                Content = new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["grant_type"] = "urn:ietf:params:oauth:grant-type:jwt-bearer", ["assertion"] = $"{header}.{claims}.{Base64Url.Encode(sig)}",
                }),
            };
            using var res = await http.CreateClient("push").SendAsync(req, ct);
            if (!res.IsSuccessStatusCode) { log.LogWarning("Firebase refused the service account ({Code})", (int)res.StatusCode); return null; }
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
            accessToken = doc.RootElement.GetProperty("access_token").GetString();
            accessExpires = DateTime.UtcNow.AddSeconds(Math.Max(60, doc.RootElement.GetProperty("expires_in").GetInt32() - 300));
            return accessToken;
        }
        finally { gate.Release(); }
    }
}
