using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;

namespace ProjectManagement.Application.Features.Calls;

/// <summary>
/// Our own video calls, on a LiveKit media server we run (calls.&lt;domain&gt;). <see cref="Url"/> is the address browsers connect to
/// (wss://), <see cref="ApiUrl"/> the one this server calls (defaults to the same host over https). The key and secret are shared with
/// the media server: the secret signs every join pass, so it never leaves the two servers.
/// </summary>
public class CallsOptions
{
    public const string Section = "Calls";
    public string? Url { get; set; }
    public string? ApiUrl { get; set; }
    public string? ApiKey { get; set; }
    public string? ApiSecret { get; set; }
    /// <summary>People in one call at most (the media server enforces it too).</summary>
    public int MaxParticipants { get; set; } = 50;
    /// <summary>How long a join pass is good for; a call that runs longer reconnects with a fresh one.</summary>
    public int TokenHours { get; set; } = 6;
    public bool Configured => !string.IsNullOrWhiteSpace(Url) && !string.IsNullOrWhiteSpace(ApiKey) && (ApiSecret?.Length ?? 0) >= 32;
    public string ServerApi => (string.IsNullOrWhiteSpace(ApiUrl) ? (Url ?? "").Replace("wss://", "https://").Replace("ws://", "http://") : ApiUrl!).TrimEnd('/');
}

/// <summary>What a join pass lets its holder do in one room.</summary>
public sealed record LiveKitGrant(string? Room = null, bool RoomJoin = false, bool CanPublish = true, bool CanSubscribe = true, bool CanPublishData = true,
    bool RoomCreate = false, bool RoomAdmin = false, bool RoomList = false, bool Hidden = false);

/// <summary>LiveKit access tokens (HS256 JWTs signed with the API secret) and the check on its webhook signatures.</summary>
public static class LiveKitTokens
{
    private static string B64(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static byte[] FromB64(string s)
    {
        s = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(s.PadRight(s.Length + (4 - s.Length % 4) % 4, '='));
    }

    public static string Mint(string apiKey, string apiSecret, string identity, string? name, LiveKitGrant grant, TimeSpan ttl, DateTimeOffset now, string? metadata = null)
    {
        var video = new JsonObject();
        if (grant.Room is not null) video["room"] = grant.Room;
        if (grant.RoomJoin) { video["roomJoin"] = true; video["canPublish"] = grant.CanPublish; video["canSubscribe"] = grant.CanSubscribe; video["canPublishData"] = grant.CanPublishData; }
        if (grant.RoomCreate) video["roomCreate"] = true;
        if (grant.RoomAdmin) video["roomAdmin"] = true;
        if (grant.RoomList) video["roomList"] = true;
        if (grant.Hidden) video["hidden"] = true;
        var payload = new JsonObject
        {
            ["iss"] = apiKey, ["sub"] = identity, ["nbf"] = now.ToUnixTimeSeconds() - 10, ["exp"] = now.Add(ttl).ToUnixTimeSeconds(),
            ["jti"] = Guid.NewGuid().ToString("N"), ["video"] = video,
        };
        if (name is not null) payload["name"] = name;
        if (metadata is not null) payload["metadata"] = metadata;
        var head = B64(Encoding.UTF8.GetBytes("""{"alg":"HS256","typ":"JWT"}"""));
        var body = B64(Encoding.UTF8.GetBytes(payload.ToJsonString()));
        var sig = B64(HMACSHA256.HashData(Encoding.UTF8.GetBytes(apiSecret), Encoding.UTF8.GetBytes($"{head}.{body}")));
        return $"{head}.{body}.{sig}";
    }

    /// <summary>
    /// A webhook from the media server is genuine when its Authorization header is a token signed with our secret, issued by our key, still
    /// valid, and carrying the SHA-256 of exactly this body.
    /// </summary>
    public static bool VerifyWebhook(string apiKey, string apiSecret, string? authorization, string body, DateTimeOffset now)
    {
        if (string.IsNullOrWhiteSpace(authorization)) return false;
        var token = authorization.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? authorization[7..].Trim() : authorization.Trim();
        var parts = token.Split('.');
        if (parts.Length != 3) return false;
        try
        {
            var expected = HMACSHA256.HashData(Encoding.UTF8.GetBytes(apiSecret), Encoding.UTF8.GetBytes($"{parts[0]}.{parts[1]}"));
            if (!CryptographicOperations.FixedTimeEquals(expected, FromB64(parts[2]))) return false;
            using var doc = JsonDocument.Parse(FromB64(parts[1]));
            var p = doc.RootElement;
            if (!p.TryGetProperty("iss", out var iss) || iss.GetString() != apiKey) return false;
            var t = now.ToUnixTimeSeconds();
            if (p.TryGetProperty("exp", out var exp) && exp.GetInt64() < t - 60) return false;
            if (p.TryGetProperty("nbf", out var nbf) && nbf.GetInt64() > t + 60) return false;
            var hash = Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(body)));
            return p.TryGetProperty("sha256", out var sha) && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(sha.GetString() ?? ""), Encoding.UTF8.GetBytes(hash));
        }
        catch (Exception e) when (e is FormatException or JsonException or InvalidOperationException) { return false; }
    }
}

/// <summary>The media server's room API (Twirp over HTTPS, JSON), as this server: create, close, list and remove.</summary>
public interface ILiveKitRooms
{
    Task CreateAsync(string room, int maxParticipants, int emptyTimeoutSeconds, CancellationToken ct);
    Task DeleteAsync(string room, CancellationToken ct);
    Task<IReadOnlyList<string>> ParticipantsAsync(string room, CancellationToken ct);
    Task RemoveAsync(string room, string identity, CancellationToken ct);
}

public sealed class LiveKitRooms(IHttpClientFactory http, IOptions<CallsOptions> options, TimeProvider clock) : ILiveKitRooms
{
    private CallsOptions O => options.Value;

    private async Task<JsonNode?> CallAsync(string method, object body, LiveKitGrant grant, CancellationToken ct)
    {
        var token = LiveKitTokens.Mint(O.ApiKey!, O.ApiSecret!, "server", null, grant, TimeSpan.FromMinutes(5), clock.GetUtcNow());
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{O.ServerApi}/twirp/livekit.RoomService/{method}")
        { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var res = await http.CreateClient("livekit").SendAsync(req, ct);
        var text = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode) throw new HttpRequestException($"The media server answered {(int)res.StatusCode} to {method}.");
        return string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
    }

    public Task CreateAsync(string room, int maxParticipants, int emptyTimeoutSeconds, CancellationToken ct) =>
        CallAsync("CreateRoom", new { name = room, max_participants = maxParticipants, empty_timeout = emptyTimeoutSeconds, departure_timeout = 60 }, new LiveKitGrant(RoomCreate: true), ct);

    public async Task DeleteAsync(string room, CancellationToken ct)
    {
        try { await CallAsync("DeleteRoom", new { room }, new LiveKitGrant(Room: room, RoomCreate: true), ct); }
        catch (HttpRequestException) { /* already gone */ }
    }

    public async Task<IReadOnlyList<string>> ParticipantsAsync(string room, CancellationToken ct)
    {
        var j = await CallAsync("ListParticipants", new { room }, new LiveKitGrant(Room: room, RoomAdmin: true), ct);
        return (j?["participants"] as JsonArray ?? []).Select(p => p?["identity"]?.ToString()).Where(s => !string.IsNullOrEmpty(s)).Select(s => s!).ToList();
    }

    public Task RemoveAsync(string room, string identity, CancellationToken ct) =>
        CallAsync("RemoveParticipant", new { room, identity }, new LiveKitGrant(Room: room, RoomAdmin: true), ct);
}
