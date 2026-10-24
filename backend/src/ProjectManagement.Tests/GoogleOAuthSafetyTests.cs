using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Tests.Infrastructure;
using ProjectManagement.Domain.Enums;
namespace ProjectManagement.Tests;
[Collection("api")]
public class GoogleOAuthSafetyTests(ApiFactory factory)
{
    private static string State(ApiResult start)=>Uri.UnescapeDataString(new Uri(start.Data!["url"]!.GetValue<string>()).Query.TrimStart('?').Split('&').Select(p=>p.Split('=',2)).Single(p=>p[0]=="state")[1]);
    private HttpClient Browser(string? cookie=null){
        var client=factory.CreateClient(new WebApplicationFactoryClientOptions{AllowAutoRedirect=false});
        if(cookie!=null)client.DefaultRequestHeaders.Add("Cookie",cookie);return client;
    }
    private static string Cookie(ApiResult start)=>start.Headers["Set-Cookie"].Split(';')[0];
    [Fact]
    public async Task Callback_requires_browser_proof_is_single_use_and_reconnect_updates_the_same_connection()
    {
        var owner=await TestClient.RegisterAsync(factory,"OAuth safety");await owner.CreateOrgAsync();
        var start=await owner.Get("/api/v1/integrations/google/connect");Assert.True(start.Ok,start.ToString());
        Assert.Contains("httponly",start.Headers["Set-Cookie"].ToLowerInvariant());Assert.Contains("secure",start.Headers["Set-Cookie"].ToLowerInvariant());
        Assert.Contains("samesite=lax",start.Headers["Set-Cookie"].ToLowerInvariant());
        var state=State(start);var code=factory.GoogleCalendar.IssueCode("first@example.com");
        using var missing=Browser();using var wrong=Browser("__Secure-pt-google-connect=wrong");
        var url=$"/api/v1/integrations/google/callback?state={state}&code={code}";
        using var missingResult=await missing.GetAsync(url);
        Assert.Equal(HttpStatusCode.Unauthorized,missingResult.StatusCode);
        Assert.Equal("text/html",missingResult.Content.Headers.ContentType!.MediaType);
        Assert.Contains("Return to connected accounts",await missingResult.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.Unauthorized,(await wrong.GetAsync(url)).StatusCode);
        using var browser=Browser(Cookie(start));
        using var connected=await browser.GetAsync(url);Assert.Equal(HttpStatusCode.Redirect,connected.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized,(await browser.GetAsync(url)).StatusCode);
        var oldId=factory.WithDb(db=>db.GoogleConnections.IgnoreQueryFilters().Single(g=>g.TenantId==owner.WorkspaceId&&g.UserId==owner.UserId).Id);
        var next=await owner.Get("/api/v1/integrations/google/connect?returnUrl=%2Fsettings%2Fgoogle-workspace%3Ftab%3Dconnections");
        using var reconnect=Browser(Cookie(next));var nextCode=factory.GoogleCalendar.IssueCode("second@example.com");
        using var result=await reconnect.GetAsync($"/api/v1/integrations/google/callback?state={State(next)}&code={nextCode}");
        Assert.Equal(HttpStatusCode.Redirect,result.StatusCode);
        Assert.Equal("/settings/google-workspace?tab=connections&google=connected",result.Headers.Location!.ToString());
        var saved=factory.WithDb(db=>db.GoogleConnections.IgnoreQueryFilters().Where(g=>g.TenantId==owner.WorkspaceId&&g.UserId==owner.UserId).ToArray());
        Assert.Single(saved);Assert.Equal(oldId,saved[0].Id);Assert.Equal("second@example.com",saved[0].GoogleEmail);
        Assert.False(saved[0].RefreshTokenProtected.StartsWith("rt_"));
    }
    [Fact]
    public async Task Browser_check_requires_authentication_and_cookie_without_consuming_the_attempt()
    {
        var owner=await TestClient.RegisterAsync(factory,"OAuth cookie preflight");await owner.CreateOrgAsync();
        Assert.Equal(HttpStatusCode.Unauthorized,(await Browser().GetAsync("/api/v1/integrations/google/callback/browser-check")).StatusCode);
        Assert.Equal("OAUTH_BROWSER_COOKIE_BLOCKED",(await owner.Get("/api/v1/integrations/google/callback/browser-check")).ErrorCode);
        var start=await owner.Get("/api/v1/integrations/google/connect");
        owner.Extra["Cookie"]=Cookie(start);
        Assert.Equal(HttpStatusCode.NoContent,(await owner.Get("/api/v1/integrations/google/callback/browser-check")).Status);
        Assert.Null(factory.WithDb(db=>db.ProviderOAuthAttempts.Single(a=>a.UserId==owner.UserId).ConsumedAt));
        using var browser=Browser(Cookie(start));
        using var result=await browser.GetAsync($"/api/v1/integrations/google/callback?state={State(start)}&code={factory.GoogleCalendar.IssueCode()}");
        Assert.Equal(HttpStatusCode.Redirect,result.StatusCode);
    }
    [Fact]
    public async Task Callback_rechecks_current_membership_and_rejects_expired_attempts()
    {
        var owner=await TestClient.RegisterAsync(factory,"Removed OAuth");await owner.CreateOrgAsync();await owner.UpgradeAsync("BUSINESS");
        var member=await owner.AddMemberAsync(factory,TenantRole.Member,"Removed member");
        var start=await member.Get("/api/v1/integrations/google/connect");
        factory.WithDb(db=>{db.TenantMembers.Remove(db.TenantMembers.Single(m=>m.TenantId==owner.WorkspaceId&&m.UserId==member.UserId));db.SaveChanges();return 0;});
        using var removed=Browser(Cookie(start));
        Assert.Equal(HttpStatusCode.Forbidden,(await removed.GetAsync($"/api/v1/integrations/google/callback?state={State(start)}&code={factory.GoogleCalendar.IssueCode()}")).StatusCode);
        Assert.False(factory.WithDb(db=>db.GoogleConnections.IgnoreQueryFilters().Any(g=>g.UserId==member.UserId)));
        var expiring=await owner.Get("/api/v1/integrations/google/connect");
        factory.WithDb(db=>{var attempt=db.ProviderOAuthAttempts.Single(a=>a.UserId==owner.UserId&&a.ConsumedAt==null);attempt.ExpiresAt=DateTime.UtcNow.AddDays(-1);db.SaveChanges();return 0;});
        using var expired=Browser(Cookie(expiring));
        Assert.Equal(HttpStatusCode.Unauthorized,(await expired.GetAsync($"/api/v1/integrations/google/callback?state={State(expiring)}&error=access_denied")).StatusCode);
    }
    [Fact]
    public async Task State_is_hashed_bounded_and_concurrent_callbacks_exchange_only_once()
    {
        var owner=await TestClient.RegisterAsync(factory,"Bounded OAuth");await owner.CreateOrgAsync();
        var first=await owner.Get("/api/v1/integrations/google/connect?returnUrl=%2F%5Cevil.example");
        var state=State(first);var cookie=Cookie(first);var proof=cookie.Split('=',2)[1];
        var attempt=factory.WithDb(db=>db.ProviderOAuthAttempts.Single(a=>a.UserId==owner.UserId));
        Assert.NotEqual(state,attempt.StateHash);Assert.NotEqual(proof,attempt.BrowserHash);
        Assert.Equal(64,attempt.StateHash.Length);Assert.Equal(64,attempt.BrowserHash.Length);
        Assert.Equal("/settings/google-workspace",attempt.ReturnPath);
        for(var i=0;i<4;i++)Assert.True((await owner.Get("/api/v1/integrations/google/connect")).Ok);
        Assert.Equal(HttpStatusCode.Conflict,(await owner.Get("/api/v1/integrations/google/connect")).Status);
        using var browser=Browser(cookie);var code=factory.GoogleCalendar.IssueCode("once@example.com");
        var url=$"/api/v1/integrations/google/callback?state={state}&code={code}";
        var results=await Task.WhenAll(browser.GetAsync(url),browser.GetAsync(url));
        Assert.Single(results.Where(r=>r.StatusCode==HttpStatusCode.Redirect));
        Assert.Single(results.Where(r=>r.StatusCode==HttpStatusCode.Unauthorized));
        foreach(var result in results)result.Dispose();
        Assert.Equal(1,factory.WithDb(db=>db.GoogleConnections.IgnoreQueryFilters().Count(g=>g.UserId==owner.UserId)));
    }
    [Fact]
    public async Task A_partial_grant_is_reported_and_cannot_be_used_for_calendar_writes()
    {
        var owner=await TestClient.RegisterAsync(factory,"Partial Google grant");await owner.CreateOrgAsync();
        var start=await owner.Get("/api/v1/integrations/google/connect");
        using var browser=Browser(Cookie(start));var code=factory.GoogleCalendar.IssueCode("partial@example.com","https://www.googleapis.com/auth/userinfo.email");
        using var connected=await browser.GetAsync($"/api/v1/integrations/google/callback?state={State(start)}&code={code}");
        Assert.Equal(HttpStatusCode.Redirect,connected.StatusCode);
        var status=await owner.Get("/api/v1/integrations/google/status");Assert.True(status.Ok,status.ToString());
        Assert.True(status.Data!["connected"]!.GetValue<bool>());Assert.False(status.Data["calendarAccess"]!.GetValue<bool>());
        var project=await owner.CreateProjectAsync("Partial grant project");
        // Asked for Google Meet: refused with what to reconnect. Left automatic: it becomes a Project Tracker call instead of failing.
        var meeting=await owner.Post($"/api/v1/projects/{project}/meetings/start",new{service="google"});
        Assert.Equal(HttpStatusCode.Conflict,meeting.Status);Assert.Equal("GOOGLE_SCOPE_REQUIRED",meeting.ErrorCode);
        var fallback=await owner.Post($"/api/v1/projects/{project}/meetings/start",new{});
        Assert.Equal(HttpStatusCode.Created,fallback.Status);Assert.Equal("ours",fallback.Data!["provider"]!.GetValue<string>());
    }}