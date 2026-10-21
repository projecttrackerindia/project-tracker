using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace ProjectManagement.Infrastructure.Services;

/// <summary>
/// An access token for Google Cloud APIs (Vertex AI), issued to the server's own service account by the Compute Engine metadata server.
/// No key file or secret is stored anywhere; the token is cached until a minute before it expires.
/// </summary>
public class GoogleAccessToken(IHttpClientFactory http, TimeProvider? clock = null)
{
    private const string Url = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
    private readonly TimeProvider _clock = clock ?? TimeProvider.System;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private string? _token;
    private DateTimeOffset _expires;

    public virtual async Task<string> GetAsync(CancellationToken ct)
    {
        if (_token is not null && _clock.GetUtcNow() < _expires) return _token;
        await _gate.WaitAsync(ct);
        try
        {
            if (_token is not null && _clock.GetUtcNow() < _expires) return _token;
            using var req = new HttpRequestMessage(HttpMethod.Get, Url);
            req.Headers.Add("Metadata-Flavor", "Google");
            using var res = await http.CreateClient("gcp-metadata").SendAsync(req, ct);
            res.EnsureSuccessStatusCode();
            var body = await res.Content.ReadFromJsonAsync<TokenResponse>(ct)
                ?? throw new InvalidOperationException("The metadata server returned no token.");
            if (string.IsNullOrWhiteSpace(body.AccessToken)) throw new InvalidOperationException("The metadata server returned no token.");
            _token = body.AccessToken;
            _expires = _clock.GetUtcNow().AddSeconds(Math.Max(0, body.ExpiresIn - 60));
            return _token;
        }
        finally { _gate.Release(); }
    }

    private sealed record TokenResponse(
        [property: JsonPropertyName("access_token")] string? AccessToken,
        [property: JsonPropertyName("expires_in")] int ExpiresIn);
}
