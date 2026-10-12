using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.FileProviders;
using ProjectManagement.Api.Controllers.Workspaces;
using ProjectManagement.Application.Exceptions;

namespace ProjectManagement.Tests;

public class ProviderConnectionBrowserTests
{
    private sealed class Environment(string name) : IWebHostEnvironment
    {
        public string EnvironmentName { get; set; } = name;
        public string ApplicationName { get; set; } = "ProjectManagement.Api";
        public string ContentRootPath { get; set; } = ".";
        public string WebRootPath { get; set; } = ".";
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
    }
    [Theory]
    [InlineData("Development", "localhost", "http", false)]
    [InlineData("Development", "127.0.0.1", "http", false)]
    [InlineData("Development", "tracker.example", "http", true)]
    [InlineData("Development", "localhost", "https", true)]
    [InlineData("Production", "localhost", "http", true)]
    [InlineData("Production", "tracker.example", "https", true)]
    public void Only_loopback_HTTP_development_uses_an_unprefixed_cookie(string env, string host, string scheme, bool secure)
    {
        var request = new DefaultHttpContext().Request; request.Host = new HostString(host); request.Scheme = scheme;
        var environment = new Environment(env);
        var name = ProviderConnectionBrowser.CookieName("google", request, environment);
        var options = ProviderConnectionBrowser.CookieOptions("/api/v1/integrations/google/callback", request, environment);
        Assert.Equal(secure, options.Secure); Assert.True(options.HttpOnly);
        Assert.Equal(SameSiteMode.Lax, options.SameSite);
        Assert.Equal(secure ? "__Secure-pt-google-connect" : "pt-google-connect-dev", name);
        Assert.Equal("/api/v1/integrations/google/callback", options.Path);
    }
    [Fact]
    public void Missing_cookie_fails_preflight_and_recovery_does_not_echo_callback_values()
    {
        var http = new DefaultHttpContext(); http.Request.Scheme="https"; http.Request.Host=new HostString("tracker.example");
        http.Request.QueryString=new QueryString("?code=secret-code&state=secret-state");
        Assert.Throws<ConflictException>(()=>ProviderConnectionBrowser.Verify("google",http.Request,new Environment("Production")));
        var page=ProviderConnectionBrowser.Recovery(http.Response);
        Assert.Equal(401,page.StatusCode); Assert.StartsWith("text/html",page.ContentType);
        Assert.Contains("/account/integrations",page.Content); Assert.DoesNotContain("secret-code",page.Content); Assert.DoesNotContain("secret-state",page.Content);
        Assert.Equal("no-store",http.Response.Headers.CacheControl.ToString());
    }
}
