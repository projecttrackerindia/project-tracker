using Microsoft.AspNetCore.Mvc;

namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>Keep OAuth browser binding secure in production and usable on loopback HTTP in development.</summary>
internal static class ProviderConnectionBrowser
{
    private static bool LocalDevelopment(HttpRequest request, IWebHostEnvironment environment) =>
        environment.IsDevelopment() && !request.IsHttps &&
        (request.Host.Host is "localhost" or "127.0.0.1" or "[::1]");

    internal static string CookieName(string provider, HttpRequest request, IWebHostEnvironment environment) =>
        LocalDevelopment(request, environment) ? $"pt-{provider}-connect-dev" : $"__Secure-pt-{provider}-connect";

    internal static CookieOptions CookieOptions(string callbackPath, HttpRequest request, IWebHostEnvironment environment) => new()
    {
        HttpOnly = true,
        Secure = !LocalDevelopment(request, environment),
        SameSite = SameSiteMode.Lax,
        Path = callbackPath,
        MaxAge = TimeSpan.FromMinutes(10)
    };

    internal static void Verify(string provider, HttpRequest request, IWebHostEnvironment environment)
    {
        if (request.Cookies[CookieName(provider,request,environment)]?.Length != 64)
            throw new ProjectManagement.Application.Exceptions.ConflictException(
                "Your browser did not retain the connection cookie. Allow cookies for Project Tracker and start again in this browser.",
                "OAUTH_BROWSER_COOKIE_BLOCKED");
    }

    // A callback is a full-page navigation. Return useful HTML while preserving the 401 and rejecting the grant.
    internal static ContentResult Recovery(HttpResponse response)
    {
        response.Headers.CacheControl = "no-store";
        response.Headers.ContentSecurityPolicy = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
        response.Headers["Referrer-Policy"] = "no-referrer";
        return new ContentResult { StatusCode = 401, ContentType = "text/html; charset=utf-8", Content = """
            <!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Restart your account connection · Project Tracker</title>
            <style>body{margin:0;background:#f4f7fc;color:#17243c;font:16px/1.7 system-ui,sans-serif}main{max-width:540px;margin:10vh auto;padding:32px;background:white;border:1px solid #dce3ee;border-radius:20px;box-shadow:0 16px 50px #17243c0c}small{color:#4f46e5;letter-spacing:.12em}h1{font-size:30px;line-height:1.2;letter-spacing:-.04em}p,li{color:#4e5e77}a{display:inline-block;background:#4f46e5;color:white;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600}@media(max-width:600px){main{margin:24px 16px;padding:24px}}</style></head><body><main><small>PROJECT TRACKER · CONNECTED ACCOUNTS</small><h1>Start again in this browser</h1><p>We could not verify the browser that started this connection. Your account has not been connected by this attempt.</p><ol><li>Open Project Tracker using the button below and sign in.</li><li>Choose Connect for Google or Microsoft and complete the consent screen in this same browser.</li><li>Allow cookies for Project Tracker. If you use the desktop app, finish connecting here, then refresh the account status in the app.</li></ol><p>Connection attempts expire after 10 minutes. Use the same Project Tracker address throughout.</p><a href="/account/integrations">Return to connected accounts</a></main></body></html>
            """ };
    }
}
