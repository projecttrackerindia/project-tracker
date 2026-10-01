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
public class SsoAuthController(SsoLoginService sso, ProjectManagement.Application.Abstractions.ICurrentContext ctx, IOptions<AppOptions> options, ILogger<SsoAuthController> log) : ApiControllerBase
{
    private string Web => PublicUrls.Web(options.Value);

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
            Secure = Request.IsHttps, SameSite = Request.IsHttps ? SameSiteMode.None : SameSiteMode.Lax,
        });
        return value;
    }

    private string? Binding()
    {
        var v = Request.Cookies[AuthCookies.Binding];
        Response.Cookies.Delete(AuthCookies.Binding, new CookieOptions { Path = "/api/v1/auth", Secure = Request.IsHttps, SameSite = Request.IsHttps ? SameSiteMode.None : SameSiteMode.Lax });
        return v;
    }

    private string Fail(string code, string message, string page = "/login") =>
        $"{Web}{page}?{(page == "/login" ? "sso_error" : "link_error")}={Uri.EscapeDataString(code)}&message={Uri.EscapeDataString(message)}";

    private IActionResult Finish(SignInCompletion done)
    {
        if (done.Session is { } session)
        {
            AuthCookies.WriteRefresh(Response, Request.IsHttps, session);
            return Redirect($"{Web}/auth/complete?to={Uri.EscapeDataString(done.RedirectTo)}");
        }
        return Redirect($"{Web}{done.RedirectTo}");
    }

    private async Task<IActionResult> Run(Func<Task<SignInCompletion>> work, string page = "/login")
    {
        try { return Finish(await work()); }
        catch (MfaRequiredRedirect mfa) { return Redirect($"{Web}/login?mfa_challenge={Uri.EscapeDataString(mfa.Challenge)}&via={mfa.Provider}&to={Uri.EscapeDataString(mfa.ReturnUrl)}"); }
        catch (AppException ex) { return Redirect(Fail(ex.Code, ex.Message, page)); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogError(ex, "Redirect sign-in failed");
            return Redirect(Fail("SSO_FAILED", "Sign-in could not be completed. Please try again.", page));
        }
    }

    // ---------------------------------------------------------------- organization single sign-on

    /// <summary>Starts single sign-on for an email address (or an organization id) and sends the browser to the identity provider.</summary>
    [HttpGet("sso/start"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> StartSso([FromQuery] string? email, [FromQuery] Guid? org, [FromQuery] string? returnUrl, CancellationToken ct)
    {
        try { return Redirect(await sso.StartSsoAsync(email, org, returnUrl, Bind(), Request.IsHttps, ct)); }
        catch (AppException ex) { return Redirect(Fail(ex.Code, ex.Message)); }
    }

    [HttpGet("sso/oidc/callback"), AllowAnonymous]
    public Task<IActionResult> OidcCallback([FromQuery] string? code, [FromQuery] string? state, [FromQuery] string? error, [FromQuery(Name = "error_description")] string? description, CancellationToken ct) =>
        error is not null
            ? Task.FromResult<IActionResult>(Redirect(Fail("SSO_REJECTED", description ?? "The identity provider did not sign you in.")))
            : Run(() => sso.CompleteOidcSsoAsync(code, state, Binding(), ct));

    /// <summary>The SAML Assertion Consumer Service (HTTP-POST binding).</summary>
    [HttpPost("sso/saml/acs"), AllowAnonymous, IgnoreAntiforgeryToken, Consumes("application/x-www-form-urlencoded")]
    public Task<IActionResult> SamlAcs(CancellationToken ct)
    {
        var form = Request.Form.ToDictionary(k => k.Key, v => v.Value.ToString());
        return Run(() => sso.CompleteSamlAsync(form, Binding(), ct));
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
    public async Task<IActionResult> StartExternal(string provider, [FromQuery] string? returnUrl, CancellationToken ct)
    {
        try { return Redirect(await sso.StartExternalAsync(provider, returnUrl, Bind(), Request.IsHttps, null, ct)); }
        catch (AppException ex) { return Redirect(Fail(ex.Code, ex.Message)); }
    }

    /// <summary>Connects an outside account to the signed-in one: returns the address to send the browser to.</summary>
    [HttpPost("external/{provider}/link")]
    public async Task<IActionResult> StartLink(string provider, CancellationToken ct) =>
        Ok(new ExternalLinkStartDto(await sso.StartExternalAsync(provider, "/account/security", Bind(), Request.IsHttps, ctx.RequireUserId(), ct)));

    [HttpGet("external/{provider}/callback"), AllowAnonymous]
    public Task<IActionResult> ExternalCallback(string provider, [FromQuery] string? code, [FromQuery] string? state, [FromQuery] string? error, CancellationToken ct) =>
        error is not null
            ? Task.FromResult<IActionResult>(Redirect(Fail("SSO_REJECTED", "The sign-in was cancelled.")))
            : Run(() => sso.CompleteExternalAsync(provider, code, state, null, Binding(), ct));

    /// <summary>Apple answers with a form post (response_mode=form_post).</summary>
    [HttpPost("external/{provider}/callback"), AllowAnonymous, IgnoreAntiforgeryToken, Consumes("application/x-www-form-urlencoded")]
    public Task<IActionResult> ExternalCallbackPost(string provider, CancellationToken ct)
    {
        var form = Request.Form.ToDictionary(k => k.Key, v => v.Value.ToString());
        if (form.ContainsKey("error")) return Task.FromResult<IActionResult>(Redirect(Fail("SSO_REJECTED", "The sign-in was cancelled.")));
        return Run(() => sso.CompleteExternalAsync(provider, form.GetValueOrDefault("code"), form.GetValueOrDefault("state"), form, Binding(), ct));
    }
}
