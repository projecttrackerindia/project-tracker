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
    { WrongBusiness = false; WrongPhone = false; UnverifiedPhone = false; Paginated = false; LostResponse = false; Oversized = false; InvalidLifetime = false; BeforePhoneResponse = null; RequestPaths.Clear(); }
}