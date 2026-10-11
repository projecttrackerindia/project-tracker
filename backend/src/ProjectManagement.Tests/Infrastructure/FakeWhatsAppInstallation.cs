using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;

namespace ProjectManagement.Tests.Infrastructure;

public sealed class FakeWhatsAppInstallation : HttpMessageHandler
{
    private record Grant(string Business, string Phone);
    private readonly ConcurrentDictionary<string, Grant> codes = new(), tokens = new();
    public ConcurrentBag<string> RequestPaths { get; } = new();
    public string? HealthProblem { get; set; }
    public string? TemplateProblem { get; set; }
    public Func<Task>? BeforeTemplateResponse { get; set; }
    public Func<Task>? BeforeHealthResponse { get; set; }
    public bool WrongBusiness { get; set; }
    public bool WrongPhone { get; set; }
    public bool UnverifiedPhone { get; set; }
    public bool Paginated { get; set; }
    public bool LostResponse { get; set; }
    public bool Oversized { get; set; }
    public bool InvalidLifetime { get; set; }
    public Func<Task>? BeforePhoneResponse { get; set; }
    public string IssueCode(string business, string phone)
    { var code = Guid.NewGuid().ToString("N"); codes[code] = new(business, phone); return code; }
    private static HttpResponseMessage Json(object value, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json") };
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var uri = request.RequestUri!;
        if (uri.Scheme != "https" || uri.Host != "graph.facebook.com" || request.Method != HttpMethod.Get) throw new InvalidOperationException("Unexpected provider target.");
        RequestPaths.Add(uri.AbsolutePath); // Never retain the app-secret query.
        if (uri.AbsolutePath.EndsWith("/oauth/access_token"))
        {
            var fields = uri.Query.TrimStart('?').Split('&').Select(x => x.Split('=', 2)).ToDictionary(x => Uri.UnescapeDataString(x[0]), x => Uri.UnescapeDataString(x[1]));
            if (fields["client_id"] != "123456789" || fields["client_secret"] != "fake-whatsapp-app-secret-only" || fields["redirect_uri"] != ""
                || !codes.TryRemove(fields["code"], out var grant))
                return (Json(new { error = "invalid_code" }, HttpStatusCode.BadRequest));
            if (LostResponse) throw new HttpRequestException("synthetic lost response");
            if (Oversized) return (new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(new string('x', 65537)) });
            var token = "fake_meta_" + Guid.NewGuid().ToString("N"); tokens[token] = grant;
            return (Json(new { access_token = token, expires_in = InvalidLifetime ? -1 : 5184000 }));
        }
        if (!tokens.TryGetValue(request.Headers.Authorization?.Parameter ?? "", out var known))
            return (Json(new { error = "invalid_token" }, HttpStatusCode.Unauthorized));
        if (uri.AbsolutePath.EndsWith("/debug_token"))
        {
            var fields = uri.Query.TrimStart('?').Split('&').Select(x => x.Split('=', 2)).ToDictionary(x => Uri.UnescapeDataString(x[0]), x => Uri.UnescapeDataString(x[1]));
            if (!fields.TryGetValue("input_token",out var input) || input != request.Headers.Authorization?.Parameter
                || !fields.TryGetValue("appsecret_proof",out var signedProof)
                || signedProof != Convert.ToHexString(System.Security.Cryptography.HMACSHA256.HashData(
                    Encoding.UTF8.GetBytes("fake-whatsapp-app-secret-only"),Encoding.UTF8.GetBytes(input!))).ToLowerInvariant()) throw new InvalidOperationException("Token inspection was not authenticated.");
            if (HealthProblem == "unavailable") throw new HttpRequestException("synthetic unavailable query with a fake secret");
            if (HealthProblem == "redirect") return new(HttpStatusCode.Redirect) { Headers = { Location = new Uri("https://attacker.example/token") } };
            if (HealthProblem == "oversized") return new(HttpStatusCode.OK) { Content = new StringContent(new string('x',65537)) };
            if (HealthProblem == "malformed") return Json(new { data = new { is_valid = "yes" } });
            return Json(new { data = new { is_valid = HealthProblem != "revoked", app_id = HealthProblem == "app" ? "99999" : "123456789",
                expires_at = HealthProblem == "expired" ? DateTimeOffset.UtcNow.AddMinutes(-1).ToUnixTimeSeconds() : HealthProblem == "nonexpiring" ? 0 : DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeSeconds(),
                data_access_expires_at = HealthProblem == "data_expired" ? DateTimeOffset.UtcNow.AddMinutes(-1).ToUnixTimeSeconds() : 0,
                scopes = HealthProblem == "scope" ? new[] { "whatsapp_business_management" } : new[] { "whatsapp_business_management", "whatsapp_business_messaging" },
                granular_scopes = new[] {
                    new { scope = "whatsapp_business_management", target_ids = new[] { known.Business } },
                    new { scope = "whatsapp_business_messaging", target_ids = new[] { HealthProblem == "asset_scope" ? "999999" : known.Business } }
                }
            }});
        }
        if (uri.AbsolutePath.EndsWith("/message_templates"))
        {
            var fields = uri.Query.TrimStart('?').Split('&').Select(x => x.Split('=', 2)).ToDictionary(x => Uri.UnescapeDataString(x[0]), x => Uri.UnescapeDataString(x[1]));
            var token = request.Headers.Authorization!.Parameter!;
            if (uri.AbsolutePath != "/v24.0/" + known.Business + "/message_templates"
                || fields["fields"] != "id,name,language,status,category,components" || fields["limit"] != "20"
                || fields["appsecret_proof"] != Convert.ToHexString(System.Security.Cryptography.HMACSHA256.HashData(
                    Encoding.UTF8.GetBytes("fake-whatsapp-app-secret-only"), Encoding.UTF8.GetBytes(token))).ToLowerInvariant()) throw new InvalidOperationException("Unauthenticated template inspection.");
            var expected = ProjectManagement.Application.Features.Integrations.WhatsAppTemplateService.Definitions.Single(x => x.Name == fields["name"]);
            if (BeforeTemplateResponse != null) await BeforeTemplateResponse();
            if (TemplateProblem == "unavailable") throw new HttpRequestException("synthetic provider error with fake token");
            if (TemplateProblem == "redirect") return new(HttpStatusCode.Redirect) { Headers = { Location = new Uri("https://attacker.example/token") } };
            if (TemplateProblem == "oversized") return new(HttpStatusCode.OK) { Content = new StringContent(new string('x',65537)) };
            if (TemplateProblem == "malformed") return Json(new { data = "invalid" });
            if (TemplateProblem == "missing") return Json(new { data = Array.Empty<object>() });
            object Row() => new { id = "1234567890123", name = TemplateProblem == "name" ? "unrelated_template" : expected.Name,
                language = TemplateProblem == "language" ? "en_GB" : expected.Language,
                status = TemplateProblem is "pending" ? "PENDING" : TemplateProblem is "paused" ? "PAUSED" : TemplateProblem is "rejected" ? "REJECTED" : "APPROVED",
                category = TemplateProblem == "marketing" ? "MARKETING" : "UTILITY",
                components = TemplateProblem == "buttons" ? new object[] { new { type = "BODY", text = expected.Body }, new { type = "BUTTONS", buttons = new object[0] } }
                    : new object[] { new { type = "BODY", text = TemplateProblem == "text" ? "Changed message" : TemplateProblem == "variable" ? "Task {{1}}" : expected.Body } } };
            if (TemplateProblem == "paging") return Json(new { data = new[] { Row() }, paging = new { next = "https://attacker.example/token" } });
            return Json(new { data = TemplateProblem == "duplicate" ? new[] { Row(), Row() } : TemplateProblem == "many" ? Enumerable.Range(0,21).Select(_=>Row()).ToArray() : new[] { Row() } });
        }
        if (uri.AbsolutePath.EndsWith("/subscribed_apps"))
        {
            if (BeforeHealthResponse != null) await BeforeHealthResponse();
            if (HealthProblem == "paging") return Json(new { data = new object[0], paging = new { next = "https://attacker.example/token" } });
            return Json(new { data = HealthProblem == "unsubscribed" ? Array.Empty<object>() : new object[] { new { whatsapp_business_api_data = new { id = "123456789" } } } });
        }
        if (uri.AbsolutePath.EndsWith("/phone_numbers"))
        {
            if (BeforePhoneResponse is not null) await BeforePhoneResponse();
            return (Json(new { data = new[] { new { id = WrongPhone ? "999999" : known.Phone, verified_name = "Verified business",
                code_verification_status = UnverifiedPhone ? "NOT_VERIFIED" : "VERIFIED" } },
                paging = Paginated ? new { next = "https://attacker.example/secret" } : null }));
        }
        return (Json(new { id = WrongBusiness ? "999999" : known.Business, name = "Verified business" }));
    }
    public void Reset()
    { WrongBusiness = false; WrongPhone = false; UnverifiedPhone = false; Paginated = false; LostResponse = false; Oversized = false; InvalidLifetime = false; BeforePhoneResponse = null; BeforeHealthResponse = null; HealthProblem = null; TemplateProblem = null; BeforeTemplateResponse = null; RequestPaths.Clear(); }
}