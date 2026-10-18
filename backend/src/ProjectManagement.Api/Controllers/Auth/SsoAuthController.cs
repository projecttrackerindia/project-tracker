using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Sso;

namespace ProjectManagement.Api.Controllers.Auth;

public record SsoDiscoverRequest(string? Email);
public record ExternalLinkStartDto(string Url);

/// <summary>
/// Redirect sign-in: an organization's single sign-on (OpenID Connect or SAML) and Google / Microsoft / GitHub / Apple. The browser is sent
/// to the identity provider and comes back here; the session is then handed over the same way as a password sign-in (the HttpOnly refresh
/// cookie) and the browser continues to the web app. Problems end on the sign-in page with a readable message instead of an error screen.
/// </summary>
[Route("api/v1/auth")]
public class SsoAuthController(SsoLoginService sso, ProjectManagement.Application.Abstractions.ICurrentContext ctx, IOptions<AppOptions> options, ILogger<SsoAuthController> log,
    Microsoft.Extensions.Caching.Distributed.IDistributedCache cache) : ApiControllerBase
{
    // ---------------------------------------------------------------- the Android app
    // Identity providers (Google above all) refuse to sign in inside an app's embedded web view, so the Android app runs these redirects in a
    // Chrome Custom Tab instead. The tab is a different browser from the app, so the session cannot simply be left in its cookie: the tab is
    // sent back to the app (projecttracker://auth/sso?code=...) with a one-time code, which only the app that started the sign-in can redeem,
    // because redeeming needs the secret ("verifier") whose SHA-256 the app sent at the start (the PKCE idea). Another app that registered the
    // same link scheme could see the code, but never use it.
    private const string AppHandoffCookie = "pm_app_handoff";
    private const string AppReturn = "projecttracker://auth/sso";
    private static readonly TimeSpan AppHandoffLife = TimeSpan.FromMinutes(2);
    private sealed record AppHandoff(string Challenge, string RefreshToken, DateTime RefreshExpiresAt, string To);

    /// <summary>Remembers, in the tab, that this sign-in was started by the app (the value is the SHA-256 of the app's secret, 64 hex characters).</summary>
    private void MarkAppSignIn(string? challenge)
    {
        if (challenge is null || challenge.Length != 64 || !challenge.All(Uri.IsHexDigit)) return;
        Response.Cookies.Append(AppHandoffCookie, challenge.ToUpperInvariant(), new CookieOptions
        {
            HttpOnly = true, IsEssential = true, Path = "/api/v1/auth", MaxAge = TimeSpan.FromMinutes(10),
            Secure = SecureCookies, SameSite = SecureCookies ? SameSiteMode.None : SameSiteMode.Lax,
        });
    }

    private string? TakeAppSignIn()
    {
        var v = Request.Cookies[AppHandoffCookie];
        if (v is null) return null;
        Response.Cookies.Delete(AppHandoffCookie, new CookieOptions { Path = "/api/v1/auth", Secure = SecureCookies, SameSite = SecureCookies ? SameSiteMode.None : SameSiteMode.Lax });
        return v;
    }

    /// <summary>Sends the browser to a page of the web app - or, for a sign-in the Android app started, back to the app, which opens that page.</summary>
    private IActionResult Bounce(string webUrl)
    {
        if (TakeAppSignIn() is null) return Redirect(webUrl);
        var path = webUrl.StartsWith(Web, StringComparison.Ordinal) ? webUrl[Web.Length..] : "/login";
        return AppPage("Return to the app", "Sign-in did not finish. Go back to Project Tracker to continue.",
            $"{AppReturn}?to={Uri.EscapeDataString(string.IsNullOrEmpty(path) ? "/" : path)}", "Back to the app");
    }

    /// <summary>
    /// The last page in the Custom Tab: one button that opens the app. Chrome only hands a link over to an app after a tap, and the tap is also
    /// the person's own "yes, sign this app in as me" - nothing is handed over silently. No script; the page is plain and self-contained.
    /// </summary>
    private ContentResult AppPage(string title, string message, string href, string button)
    {
        static string H(string v) => System.Net.WebUtility.HtmlEncode(v);
        Response.Headers.CacheControl = "no-store";
        Response.Headers["Referrer-Policy"] = "no-referrer";
        // The API's own policy is "default-src 'none'"; this one page only needs its inline styles.
        Response.Headers.ContentSecurityPolicy = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
        var html = $$"""
            <!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
            <title>{{H(title)}}</title>
            <style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f6f9;color:#111827;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
            main{width:min(360px,calc(100% - 32px));padding:28px 24px;border:1px solid #e3e7ed;border-radius:14px;background:#fff;text-align:center;box-shadow:0 2px 8px rgba(16,24,40,.06)}
            h1{font-size:19px;margin:0 0 8px}p{margin:0 0 20px;color:#4b5565}a{display:block;padding:12px 16px;border-radius:9px;background:#4a5fe0;color:#fff;text-decoration:none;font-weight:600}</style>
            </head><body><main><h1>{{H(title)}}</h1><p>{{H(message)}}</p><a href="{{H(href)}}">{{H(button)}}</a></main></body></html>
            """;
        return Content(html, "text/html; charset=utf-8");
    }

    public record AppHandoffRequest(string? Code, string? Verifier);

    /// <summary>The app redeems the one-time code with its secret: the session is handed over exactly like a password sign-in (the refresh cookie).</summary>
    [HttpPost("sso/app-handoff"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> AppHandoffRedeem([FromBody] AppHandoffRequest req, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.Code) || req.Code.Length > 100 || string.IsNullOrWhiteSpace(req.Verifier) || req.Verifier.Length > 200)
            throw new UnauthorizedException("This sign-in has expired. Start again.", "SSO_STATE_EXPIRED");
        var key = $"apphandoff:{req.Code}";
        var json = await cache.GetStringAsync(key, ct);
        if (json is null) throw new UnauthorizedException("This sign-in has expired. Start again.", "SSO_STATE_EXPIRED");
        await cache.RemoveAsync(key, ct);   // one use, whatever happens next
        var handoff = System.Text.Json.JsonSerializer.Deserialize<AppHandoff>(json)!;
        var proof = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(req.Verifier)));
        if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(proof), Encoding.ASCII.GetBytes(handoff.Challenge)))
            throw new UnauthorizedException("This sign-in was started somewhere else. Start again here.", "SSO_STATE_INVALID");
        AuthCookies.WriteRefresh(Response, SecureCookies, handoff.RefreshToken, handoff.RefreshExpiresAt);
        return Ok(new { to = handoff.To });
    }

    private string Web => PublicUrls.Web(options.Value);
    /// <summary>https end to end as far as the browser is concerned (see AuthCookies.IsSecure).</summary>
    private bool SecureCookies => AuthCookies.IsSecure(Request);

    /// <summary>Which outside sign-in options this installation offers (only those with their settings in place).</summary>
    [HttpGet("providers"), AllowAnonymous]
    public IActionResult Providers() => Ok(new { providers = sso.Providers() });

    /// <summary>Whether an email address signs in through its organization's single sign-on.</summary>
    [HttpPost("sso/discover"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> Discover([FromBody] SsoDiscoverRequest req, CancellationToken ct) => Ok(await sso.DiscoverAsync(req.Email, ct));

    /// <summary>A fresh random value in a cookie, so the sign-in can only be finished in the browser that started it.</summary>
    private string Bind()
    {
        var value = Convert.ToHexString(RandomNumberGenerator.GetBytes(24));
        Response.Cookies.Append(AuthCookies.Binding, value, new CookieOptions
        {
            HttpOnly = true, IsEssential = true, Path = "/api/v1/auth", MaxAge = TimeSpan.FromMinutes(10),
            // The SAML and Apple answers arrive as cross-site POSTs, which only carry a SameSite=None cookie; that requires https.
            Secure = SecureCookies, SameSite = SecureCookies ? SameSiteMode.None : SameSiteMode.Lax,
        });
        return value;
    }

    private string? Binding()
    {
        var v = Request.Cookies[AuthCookies.Binding];
        Response.Cookies.Delete(AuthCookies.Binding, new CookieOptions { Path = "/api/v1/auth", Secure = SecureCookies, SameSite = SecureCookies ? SameSiteMode.None : SameSiteMode.Lax });
        return v;
    }

    private string Fail(string code, string message, string page = "/login") =>
        $"{Web}{page}?{(page == "/login" ? "sso_error" : "link_error")}={Uri.EscapeDataString(code)}&message={Uri.EscapeDataString(message)}";

    private async Task<IActionResult> FinishAsync(SignInCompletion done, CancellationToken ct)
    {
        if (done.Session is { } session)
        {
            if (TakeAppSignIn() is { } challenge && session.RefreshToken is { } refresh)
            {
                var code = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
                await cache.SetStringAsync($"apphandoff:{code}", System.Text.Json.JsonSerializer.Serialize(new AppHandoff(challenge, refresh, session.RefreshExpiresAt, done.RedirectTo)),
                    new Microsoft.Extensions.Caching.Distributed.DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = AppHandoffLife }, ct);
                return AppPage("You're signed in", $"Signed in as {session.User.Email}. Continue in the Project Tracker app.", $"{AppReturn}?code={code}", "Open Project Tracker");
            }
            AuthCookies.WriteRefresh(Response, SecureCookies, session);
            return Redirect($"{Web}/auth/complete?to={Uri.EscapeDataString(done.RedirectTo)}");
        }
        return Bounce($"{Web}{done.RedirectTo}");
    }

    private async Task<IActionResult> Run(Func<Task<SignInCompletion>> work, string page = "/login", CancellationToken ct = default)
    {
        try { return await FinishAsync(await work(), ct); }
        catch (MfaRequiredRedirect mfa) { return Bounce($"{Web}/login?mfa_challenge={Uri.EscapeDataString(mfa.Challenge)}&via={mfa.Provider}&to={Uri.EscapeDataString(mfa.ReturnUrl)}"); }
        catch (AppException ex) { return Bounce(Fail(ex.Code, ex.Message, page)); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogError(ex, "Redirect sign-in failed");
            return Bounce(Fail("SSO_FAILED", "Sign-in could not be completed. Please try again.", page));
        }
    }

    // ---------------------------------------------------------------- organization single sign-on

    /// <summary>Starts single sign-on for an email address (or an organization id) and sends the browser to the identity provider.</summary>
    [HttpGet("sso/start"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> StartSso([FromQuery] string? email, [FromQuery] Guid? org, [FromQuery] string? returnUrl, [FromQuery] string? app, CancellationToken ct)
    {
        MarkAppSignIn(app);
        try { return Redirect(await sso.StartSsoAsync(email, org, returnUrl, Bind(), SecureCookies, ct)); }
        catch (AppException ex) { return Bounce(Fail(ex.Code, ex.Message)); }
    }

    [HttpGet("sso/oidc/callback"), AllowAnonymous]
    public Task<IActionResult> OidcCallback([FromQuery] string? code, [FromQuery] string? state, [FromQuery] string? error, [FromQuery(Name = "error_description")] string? description, CancellationToken ct) =>
        error is not null
            ? Task.FromResult(Bounce(Fail("SSO_REJECTED", description ?? "The identity provider did not sign you in.")))
            : Run(() => sso.CompleteOidcSsoAsync(code, state, Binding(), ct), ct: ct);

    /// <summary>The SAML Assertion Consumer Service (HTTP-POST binding).</summary>
    [HttpPost("sso/saml/acs"), AllowAnonymous, IgnoreAntiforgeryToken, Consumes("application/x-www-form-urlencoded")]
    public Task<IActionResult> SamlAcs(CancellationToken ct)
    {
        var form = Request.Form.ToDictionary(k => k.Key, v => v.Value.ToString());
        return Run(() => sso.CompleteSamlAsync(form, Binding(), ct), ct: ct);
    }

    /// <summary>This application's SAML service-provider metadata for one organization (entity ID, ACS address).</summary>
    [HttpGet("sso/saml/{tenantId:guid}/metadata"), AllowAnonymous]
    public IActionResult SamlMetadata(Guid tenantId)
    {
        var o = options.Value;
        var entity = PublicUrls.SamlEntityId(o, tenantId);
        var xml = $"""
            <?xml version="1.0" encoding="UTF-8"?>
            <md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="{System.Security.SecurityElement.Escape(entity)}">
              <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
                <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
                <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="{System.Security.SecurityElement.Escape(PublicUrls.SamlAcs(o))}" index="0" isDefault="true"/>
              </md:SPSSODescriptor>
            </md:EntityDescriptor>
            """;
        return Content(xml, "application/samlmetadata+xml", Encoding.UTF8);
    }

    // ---------------------------------------------------------------- Google / Microsoft / GitHub / Apple

    [HttpGet("external/{provider}/start"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> StartExternal(string provider, [FromQuery] string? returnUrl, [FromQuery] string? app, CancellationToken ct)
    {
        MarkAppSignIn(app);
        try { return Redirect(await sso.StartExternalAsync(provider, returnUrl, Bind(), SecureCookies, null, ct)); }
        catch (AppException ex) { return Bounce(Fail(ex.Code, ex.Message)); }
    }

    /// <summary>Connects an outside account to the signed-in one: returns the address to send the browser to.</summary>
    [HttpPost("external/{provider}/link")]
    public async Task<IActionResult> StartLink(string provider, CancellationToken ct) =>
        Ok(new ExternalLinkStartDto(await sso.StartExternalAsync(provider, "/account/security", Bind(), SecureCookies, ctx.RequireUserId(), ct)));

    [HttpGet("external/{provider}/callback"), AllowAnonymous]
    public Task<IActionResult> ExternalCallback(string provider, [FromQuery] string? code, [FromQuery] string? state, [FromQuery] string? error, CancellationToken ct) =>
        error is not null
            ? Task.FromResult(Bounce(Fail("SSO_REJECTED", "The sign-in was cancelled.")))
            : Run(() => sso.CompleteExternalAsync(provider, code, state, null, Binding(), ct), ct: ct);

    /// <summary>Apple answers with a form post (response_mode=form_post).</summary>
    [HttpPost("external/{provider}/callback"), AllowAnonymous, IgnoreAntiforgeryToken, Consumes("application/x-www-form-urlencoded")]
    public Task<IActionResult> ExternalCallbackPost(string provider, CancellationToken ct)
    {
        var form = Request.Form.ToDictionary(k => k.Key, v => v.Value.ToString());
        if (form.ContainsKey("error")) return Task.FromResult(Bounce(Fail("SSO_REJECTED", "The sign-in was cancelled.")));
        return Run(() => sso.CompleteExternalAsync(provider, form.GetValueOrDefault("code"), form.GetValueOrDefault("state"), form, Binding(), ct), ct: ct);
    }
}
