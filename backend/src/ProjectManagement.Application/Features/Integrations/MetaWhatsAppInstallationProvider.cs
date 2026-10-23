using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Services;
using ProjectManagement.Application.Exceptions;

namespace ProjectManagement.Application.Features.Integrations;

/// <summary>Read-only asset verification after an app-bound authorization-code exchange; fixed HTTPS origin, no redirects/retries.</summary>
public class MetaWhatsAppInstallationProvider(IHttpClientFactory http, IOptions<WhatsAppOptions> options, AppClock clock)
    : IWhatsAppInstallationProvider, IWhatsAppHealthProvider, IWhatsAppTemplateProvider, IWhatsAppDeliveryProvider
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
    public async Task<WhatsAppProviderHealth> InspectAsync(string token, string businessAccountId, string phoneNumberId, CancellationToken ct)
    {
        var o = options.Value;
        if (!o.HealthChecksEnabled || !o.InstallationConfigured || token is not { Length: > 0 and <= 10000 } || token.Any(char.IsControl)
            || !WhatsAppGatewayService.ProviderId(businessAccountId) || !WhatsAppGatewayService.ProviderId(phoneNumberId)) throw Invalid();
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct); deadline.CancelAfter(TimeSpan.FromSeconds(20));
        var origin = "https://graph.facebook.com/" + o.ApiVersion;
        var proof = Convert.ToHexString(System.Security.Cryptography.HMACSHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(o.AppSecret!), System.Text.Encoding.UTF8.GetBytes(token))).ToLowerInvariant();
        async Task<JsonDocument> Get(string path)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, origin + path + (path.Contains('?') ? "&" : "?") + "appsecret_proof=" + proof);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            return await ReadAsync(request, deadline.Token);
        }
        static JsonElement Rows(JsonElement root)
        {
            if (!root.TryGetProperty("data", out var rows) || rows.ValueKind != JsonValueKind.Array || rows.GetArrayLength() > 100
                || root.TryGetProperty("paging", out var paging) && paging.ValueKind == JsonValueKind.Object && paging.TryGetProperty("next", out _)) throw Invalid();
            return rows;
        }
        try
        {
            using var debug = await Get("/debug_token?input_token=" + Uri.EscapeDataString(token));
            if (!debug.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object
                || !data.TryGetProperty("is_valid", out var valid) || valid.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw Invalid();
            if (!valid.GetBoolean()) return new(false, null, null, null, null, null);
            if (Field(data, "app_id", 40) != o.AppId) return new(false, null, null, null, null, null);
            DateTime? expires = null;
            foreach (var field in new[] { "expires_at", "data_access_expires_at" })
            {
                if (!data.TryGetProperty(field, out var value)) { if (field == "expires_at") throw Invalid(); else continue; }
                if (!value.TryGetInt64(out var unix) || unix < 0 || unix > 253402300799) throw Invalid();
                if (unix == 0) continue; // Zero denotes no scheduled expiry, not irrevocable permission.
                var expiry = DateTimeOffset.FromUnixTimeSeconds(unix).UtcDateTime.AddSeconds(-60);
                if (expires == null || expiry < expires) expires = expiry;
            }
            if (expires <= clock.Now) return new(false, null, null, null, null, expires);
            if (!data.TryGetProperty("scopes", out var scopes) || scopes.ValueKind != JsonValueKind.Array || scopes.GetArrayLength() > 100) throw Invalid();
            var required = new[] { "whatsapp_business_management", "whatsapp_business_messaging" };
            var granted = scopes.EnumerateArray().Select(x => x.ValueKind == JsonValueKind.String ? x.GetString() : throw Invalid()).ToHashSet();
            // Require explicit WABA-scoped grants. An absent/ambiguous asset grant cannot establish readiness.
            if (!data.TryGetProperty("granular_scopes", out var granular) || granular.ValueKind != JsonValueKind.Array || granular.GetArrayLength() > 100)
                return new(true, false, null, null, null, expires);
            foreach (var scope in required)
            {
                var matching = granular.EnumerateArray().Where(x => Field(x, "scope", 100) == scope).ToArray();
                if (!granted.Contains(scope) || matching.Length != 1 || !matching[0].TryGetProperty("target_ids", out var ids)
                    || ids.ValueKind != JsonValueKind.Array || ids.GetArrayLength() > 100
                    || !ids.EnumerateArray().Any(x => x.ValueKind == JsonValueKind.String && x.GetString() == businessAccountId))
                    return new(true, false, null, null, null, expires);
            }
            using var business = await Get("/" + businessAccountId + "?fields=id");
            if (Field(business.RootElement, "id", 40) != businessAccountId) return new(true, true, false, null, null, expires);
            using var phones = await Get("/" + businessAccountId + "/phone_numbers?fields=id,code_verification_status&limit=100");
            var selected = Rows(phones.RootElement).EnumerateArray().Where(x => Field(x, "id", 40) == phoneNumberId).ToArray();
            if (selected.Length != 1) return new(true, true, false, null, null, expires);
            var phoneVerified = Field(selected[0], "code_verification_status", 30) == "VERIFIED";
            using var subscriptions = await Get("/" + businessAccountId + "/subscribed_apps?limit=100");
            var subscribed = Rows(subscriptions.RootElement).EnumerateArray().Any(x => x.ValueKind == JsonValueKind.Object
                && x.TryGetProperty("whatsapp_business_api_data", out var app) && Field(app, "id", 40) == o.AppId);
            return new(true, true, true, subscribed, phoneVerified, expires);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw Invalid(); }
        catch (InvalidOperationException) { throw Invalid(); }
    }

    public async Task<WhatsAppProviderTemplates> InspectTemplatesAsync(string token, string businessAccountId, CancellationToken ct)
    {
        var o = options.Value;
        if (!o.TemplateChecksEnabled || !o.HealthChecksEnabled || !o.InstallationConfigured
            || token is not { Length: > 0 and <= 10000 } || token.Any(char.IsControl)
            || !WhatsAppGatewayService.ProviderId(businessAccountId)) throw Invalid();
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct); deadline.CancelAfter(TimeSpan.FromSeconds(20));
        var proof = Convert.ToHexString(System.Security.Cryptography.HMACSHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(o.AppSecret!), System.Text.Encoding.UTF8.GetBytes(token))).ToLowerInvariant();
        var states = new List<string>();
        try
        {
            foreach (var expected in WhatsAppTemplateService.Definitions)
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, "https://graph.facebook.com/" + o.ApiVersion + "/"
                    + businessAccountId + "/message_templates?name=" + Uri.EscapeDataString(expected.Name)
                    + "&fields=id,name,language,status,category,components&limit=20&appsecret_proof=" + proof);
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                using var document = await ReadAsync(request, deadline.Token);
                var root = document.RootElement;
                if (!root.TryGetProperty("data", out var rows) || rows.ValueKind != JsonValueKind.Array || rows.GetArrayLength() > 20
                    || root.TryGetProperty("paging", out var paging) && paging.ValueKind == JsonValueKind.Object && paging.TryGetProperty("next", out _)) throw Invalid();
                // Select one exact name and locale; no fallback translation, prefix match or pagination URL.
                var matches = rows.EnumerateArray().Where(x => Field(x, "name", 100) == expected.Name
                    && Field(x, "language", 20) == expected.Language).ToArray();
                if (matches.Length > 1) throw Invalid();
                if (matches.Length == 0) { states.Add("missing"); continue; }
                var row = matches[0];
                if (!WhatsAppGatewayService.ProviderId(Field(row, "id", 40))) throw Invalid();
                var status = Field(row, "status", 40);
                if (status != "APPROVED") { states.Add(status == "PENDING" ? "pending" : "unapproved"); continue; }
                var compatible = Field(row, "category", 40) == expected.Category
                    && row.TryGetProperty("components", out var components) && components.ValueKind == JsonValueKind.Array
                    && components.GetArrayLength() == 1
                    && Field(components[0], "type", 40) == "BODY"
                    && Field(components[0], "text", 1024) == expected.Body
                    && !components[0].TryGetProperty("parameters", out _);
                // Reject headers, buttons, media and variable bodies. Notifications carry no private project contents.
                states.Add(compatible ? "approved" : "incompatible");
            }
            return new(states[0], states[1], states[2], states[3], states[4]);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw Invalid(); }
        catch (InvalidOperationException) { throw Invalid(); }
    }

    public async Task<WhatsAppSendResult> SendTemplateAsync(string token, string phoneNumberId, string recipient,
        string category, string callbackTag, CancellationToken ct)
    {
        var o = options.Value;
        if (!WhatsAppDeliveryService.Enabled(o) || !WhatsAppGatewayService.ProviderId(phoneNumberId)
            || !WhatsAppContactService.PhoneDigits(recipient) || token is not { Length: > 0 and <= 10000 } || token.Any(char.IsControl)
            || callbackTag is not { Length: > 0 and <= 100 } || callbackTag.Any(char.IsControl)) return new("rejected");
        var definition = WhatsAppTemplateService.Definitions.SingleOrDefault(x => x.Key == category);
        if (definition == null) return new("rejected");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct); deadline.CancelAfter(TimeSpan.FromSeconds(20));
        var proof = Convert.ToHexString(System.Security.Cryptography.HMACSHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(o.AppSecret!), System.Text.Encoding.UTF8.GetBytes(token))).ToLowerInvariant();
        using var request = new HttpRequestMessage(HttpMethod.Post, "https://graph.facebook.com/" + o.ApiVersion + "/"
            + phoneNumberId + "/messages?appsecret_proof=" + proof);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Content = System.Net.Http.Json.JsonContent.Create(new { messaging_product = "whatsapp", recipient_type = "individual", to = recipient,
            type = "template", template = new { name = definition.Name, language = new { code = definition.Language } }, biz_opaque_callback_data = callbackTag });
        try
        {
            using var response = await http.CreateClient("whatsapp-installation").SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            await using var stream = await response.Content.ReadAsStreamAsync(deadline.Token);
            var bytes = new byte[65537];var count=0;int read;
            while(count<bytes.Length&&(read=await stream.ReadAsync(bytes.AsMemory(count),deadline.Token))>0)count+=read;
            if(count>65536)return new("unknown");
            using var payload=JsonDocument.Parse(bytes.AsMemory(0,count),new JsonDocumentOptions{MaxDepth=20});var root=payload.RootElement;
            if(root.ValueKind!=JsonValueKind.Object)return new("unknown");
            // Definitive structured 4xx rejection is terminal. Redirects, 5xx and uncertain payloads are never retried.
            if(!response.IsSuccessStatusCode)
                return (int)response.StatusCode is >=400 and <500 && root.TryGetProperty("error",out var error)
                    && error.ValueKind==JsonValueKind.Object && error.TryGetProperty("code",out var code)&&code.TryGetInt32(out _)
                    ? new("rejected") : new("unknown");
            if(root.TryGetProperty("error",out _)||Field(root,"messaging_product",20)!="whatsapp"
                ||!root.TryGetProperty("messages",out var messages)||messages.ValueKind!=JsonValueKind.Array||messages.GetArrayLength()!=1
                ||!root.TryGetProperty("contacts",out var contacts)||contacts.ValueKind!=JsonValueKind.Array||contacts.GetArrayLength()!=1
                ||Field(contacts[0],"input",20)!=recipient||Field(contacts[0],"wa_id",20)!=recipient)return new("unknown");
            var id=Field(messages[0],"id",200);return id.StartsWith("wamid.",StringComparison.Ordinal)?new("accepted",id):new("unknown");
        }
        catch(Exception ex)when(ex is HttpRequestException or JsonException or OperationCanceledException or ConflictException or InvalidOperationException)
        {return new("unknown");}
    }

}
