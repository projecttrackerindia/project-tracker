using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Exceptions;

namespace ProjectManagement.Application.Features.Integrations;

/// <summary>
/// The ProjectTracker GitHub App, created once under the ProjectTracker GitHub organisation. Its keys are server settings (never pasted by
/// workspaces): the app id and slug, its private key, the webhook secret, and the client id and secret used to check who installs it.
/// </summary>
public class GitHubAppOptions
{
    public const string Section = "GitHubApp";
    public string? AppId { get; set; }
    public string? Slug { get; set; }
    /// <summary>The app's private key (PEM, as GitHub downloads it).</summary>
    public string? PrivateKey { get; set; }
    public string? WebhookSecret { get; set; }
    public string? ClientId { get; set; }
    public string? ClientSecret { get; set; }
    public string ApiBaseUrl { get; set; } = "https://api.github.com";
    public string WebBaseUrl { get; set; } = "https://github.com";

    public bool Configured => !string.IsNullOrWhiteSpace(AppId) && !string.IsNullOrWhiteSpace(Slug) && !string.IsNullOrWhiteSpace(PrivateKey)
        && !string.IsNullOrWhiteSpace(WebhookSecret) && !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(ClientSecret);
}

/// <summary>
/// Talks to GitHub as the app: a short-lived JWT signed with the app's private key proves it is the app, and is exchanged for an installation
/// token (an hour, cached) to act in one installation's repositories. Every call has a timeout and a plain-words error.
/// </summary>
public class GitHubAppClient(IHttpClientFactory http, IOptions<GitHubAppOptions> options)
{
    private static readonly ConcurrentDictionary<long, (string Token, DateTime Expires)> Tokens = new();
    private GitHubAppOptions O => options.Value;

    private static string B64(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>The app's JWT (RS256, nine minutes, issued a minute in the past for clock drift).</summary>
    public string AppJwt()
    {
        if (!O.Configured) throw new ConflictException("The GitHub App is not set up on this server yet.", "GITHUB_APP_NOT_CONFIGURED");
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var header = B64(Encoding.UTF8.GetBytes("""{"alg":"RS256","typ":"JWT"}"""));
        var payload = B64(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { iat = now - 60, exp = now + 540, iss = O.AppId })));
        using var rsa = RSA.Create();
        rsa.ImportFromPem(O.PrivateKey!.Replace("\\n", "\n"));
        var signature = rsa.SignData(Encoding.ASCII.GetBytes($"{header}.{payload}"), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        return $"{header}.{payload}.{B64(signature)}";
    }

    private HttpRequestMessage Request(HttpMethod method, string path, string bearer, object? body = null)
    {
        var req = new HttpRequestMessage(method, path.StartsWith("http", StringComparison.Ordinal) ? path : $"{O.ApiBaseUrl.TrimEnd('/')}/{path.TrimStart('/')}");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        req.Headers.Accept.ParseAdd("application/vnd.github+json");
        req.Headers.UserAgent.ParseAdd("ProjectTracker-GitHub-App");
        req.Headers.TryAddWithoutValidation("X-GitHub-Api-Version", "2022-11-28");
        if (body is not null) req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        return req;
    }

    private async Task<JsonNode?> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        using var res = await http.CreateClient("github-app").SendAsync(req, timeout.Token);
        var text = await res.Content.ReadAsStringAsync(timeout.Token);
        if (!res.IsSuccessStatusCode)
        {
            string? message = null;
            try { message = JsonNode.Parse(text)?["message"]?.ToString(); } catch (JsonException) { }
            throw new ConflictException($"GitHub answered {(int)res.StatusCode}{(message is null ? "" : $": {message}")}.", "GITHUB_ERROR");
        }
        return string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
    }

    /// <summary>As the app itself (installation details).</summary>
    public Task<JsonNode?> AsAppAsync(HttpMethod method, string path, CancellationToken ct) => SendAsync(Request(method, path, AppJwt()), ct);

    /// <summary>As one installation (its repositories), with a cached hour-long token.</summary>
    public async Task<JsonNode?> AsInstallationAsync(long installationId, HttpMethod method, string path, object? body, CancellationToken ct)
    {
        var token = await InstallationTokenAsync(installationId, ct);
        return await SendAsync(Request(method, path, token, body), ct);
    }

    public async Task<string> InstallationTokenAsync(long installationId, CancellationToken ct)
    {
        if (Tokens.TryGetValue(installationId, out var cached) && cached.Expires > DateTime.UtcNow.AddMinutes(5)) return cached.Token;
        var res = await AsAppAsync(HttpMethod.Post, $"app/installations/{installationId}/access_tokens", ct);
        var token = res?["token"]?.ToString() ?? throw new ConflictException("GitHub gave no installation token.", "GITHUB_ERROR");
        var expires = DateTime.TryParse(res?["expires_at"]?.ToString(), null, System.Globalization.DateTimeStyles.AdjustToUniversal, out var e) ? e : DateTime.UtcNow.AddMinutes(50);
        Tokens[installationId] = (token, expires);
        return token;
    }

    public static void Forget(long installationId) => Tokens.TryRemove(installationId, out _);

    /// <summary>Who installed it: exchanges the install's one-time code for the person's token, and lists the installations that person can reach.</summary>
    public async Task<IReadOnlyList<long>> InstallationsOfUserAsync(string code, CancellationToken ct)
    {
        using var tokenReq = new HttpRequestMessage(HttpMethod.Post, $"{O.WebBaseUrl.TrimEnd('/')}/login/oauth/access_token")
        {
            Content = new FormUrlEncodedContent(new Dictionary<string, string> { ["client_id"] = O.ClientId!, ["client_secret"] = O.ClientSecret!, ["code"] = code }),
        };
        tokenReq.Headers.Accept.ParseAdd("application/json");
        tokenReq.Headers.UserAgent.ParseAdd("ProjectTracker-GitHub-App");
        var tokenRes = await SendAsync(tokenReq, ct);
        var userToken = tokenRes?["access_token"]?.ToString();
        if (string.IsNullOrEmpty(userToken)) throw new ValidationException("code", "GitHub did not confirm who installed the app. Try installing again.");
        var list = await SendAsync(Request(HttpMethod.Get, "user/installations?per_page=100", userToken), ct);
        return (list?["installations"] as JsonArray ?? []).Select(i => i?["id"]?.GetValue<long>() ?? 0).Where(i => i > 0).ToList();
    }

    /// <summary>Checks GitHub's signature on a webhook delivery (HMAC-SHA256 of the body with the app's webhook secret).</summary>
    public bool SignatureValid(byte[] body, string? signature)
    {
        if (string.IsNullOrEmpty(O.WebhookSecret) || signature is not { Length: 71 } || !signature.StartsWith("sha256=", StringComparison.Ordinal)) return false;
        var expected = "sha256=" + Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(O.WebhookSecret), body)).ToLowerInvariant();
        return CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(signature.ToLowerInvariant()));
    }
}
