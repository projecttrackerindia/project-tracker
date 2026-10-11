using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Services;
using ProjectManagement.Application.Exceptions;

namespace ProjectManagement.Application.Features.Integrations;

/// <summary>Read-only asset verification after an app-bound authorization-code exchange; fixed HTTPS origin, no redirects/retries.</summary>
public class MetaWhatsAppInstallationProvider(IHttpClientFactory http, IOptions<WhatsAppOptions> options, AppClock clock)
    : IWhatsAppInstallationProvider
{
    private static ConflictException Invalid() => new("Meta did not verify this business installation. Start again or review app setup.", "WHATSAPP_PROVIDER_ERROR");
    private async Task<JsonDocument> ReadAsync(HttpRequestMessage request, CancellationToken ct)
    {
        try
        {
            using var response = await http.CreateClient("whatsapp-installation").SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            if (!response.IsSuccessStatusCode) throw Invalid();
            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            var bytes = new byte[65537]; var count = 0; int read;
            while (count < bytes.Length && (read = await stream.ReadAsync(bytes.AsMemory(count), ct)) > 0) count += read;
            if (count > 65536) throw Invalid();
            var document = JsonDocument.Parse(bytes.AsMemory(0, count), new JsonDocumentOptions { MaxDepth = 20 });
            if (document.RootElement.ValueKind != JsonValueKind.Object || document.RootElement.TryGetProperty("error", out _))
            { document.Dispose(); throw Invalid(); }
            return document;
        }
        catch (JsonException) { throw Invalid(); }
        catch (HttpRequestException) { throw Invalid(); } // Do not attach exception messages containing secret-bearing URLs.
    }
    private static string Field(JsonElement root, string name, int max)
    {
        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var field)
            && field.ValueKind == JsonValueKind.String && field.GetString() is { Length: > 0 } value
            && value.Length <= max && !value.Any(char.IsControl)) return value;
        throw Invalid();
    }
    public async Task<WhatsAppVerifiedInstallation> ExchangeAndVerifyAsync(string code, string businessAccountId, string phoneNumberId, CancellationToken ct)
    {
        var o = options.Value;
        if (!o.InstallationEnabled || !o.InstallationConfigured) throw Invalid();
        if (code is not { Length: > 0 and <= 2000 } || code.Any(char.IsControl)
            || !WhatsAppGatewayService.ProviderId(businessAccountId) || !WhatsAppGatewayService.ProviderId(phoneNumberId)) throw Invalid();
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct); deadline.CancelAfter(TimeSpan.FromSeconds(20));
        var origin = "https://graph.facebook.com/" + o.ApiVersion;
        // Meta's official reference uses GET with these parameters. Named-client logging and HTTP tracing are suppressed.
        var query = new Dictionary<string, string> { ["client_id"] = o.AppId!, ["client_secret"] = o.AppSecret!,
            ["redirect_uri"] = "", ["code"] = code };
        using var tokenRequest = new HttpRequestMessage(HttpMethod.Get, origin + "/oauth/access_token?"
            + string.Join("&", query.Select(p => Uri.EscapeDataString(p.Key) + "=" + Uri.EscapeDataString(p.Value))));
        try
        {
            using var payload = await ReadAsync(tokenRequest, deadline.Token);
            var token = Field(payload.RootElement, "access_token", 10000);
            DateTime? expires = null;
            if (payload.RootElement.TryGetProperty("expires_in", out var lifetime))
            {
                if (lifetime.ValueKind != JsonValueKind.Number || !lifetime.TryGetInt32(out var seconds)
                    || seconds < 120 || seconds > 366 * 86400) throw Invalid();
                expires = clock.Now.AddSeconds(seconds - 60);
            }
            using var businessRequest = new HttpRequestMessage(HttpMethod.Get, origin + "/" + businessAccountId + "?fields=id,name");
            businessRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            using var business = await ReadAsync(businessRequest, deadline.Token);
            if (Field(business.RootElement, "id", 40) != businessAccountId) throw Invalid();
            var name = Field(business.RootElement, "name", 200);
            using var phonesRequest = new HttpRequestMessage(HttpMethod.Get, origin + "/" + businessAccountId + "/phone_numbers?fields=id,verified_name,code_verification_status&limit=100");
            phonesRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            using var phones = await ReadAsync(phonesRequest, deadline.Token);
            if (!phones.RootElement.TryGetProperty("data", out var rows) || rows.ValueKind != JsonValueKind.Array || rows.GetArrayLength() > 100) throw Invalid();
            // Fail closed rather than follow arbitrary provider paging URLs or accept unverified browser hints.
            if (phones.RootElement.TryGetProperty("paging", out var paging) && paging.ValueKind == JsonValueKind.Object && paging.TryGetProperty("next", out _)) throw Invalid();
            var matches = rows.EnumerateArray().Where(p => Field(p, "id", 40) == phoneNumberId).ToArray();
            if (matches.Length != 1 || Field(matches[0], "code_verification_status", 30) != "VERIFIED") throw Invalid();
            return new(token, businessAccountId, phoneNumberId, name, expires);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw Invalid(); }
    }
}