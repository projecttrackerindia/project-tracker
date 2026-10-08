using System.Net;
using System.Net.Http.Headers;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The Google Calendar/Meet foundation: connecting a person's own Google account (a separate OAuth grant from "Sign in with Google", which
/// never keeps a token), and using that connection to create a Calendar event with a Meet conference. No ProjectMeeting/controller flow
/// yet (that is the next phase) - this is the connection and the low-level Calendar API wrapper it unlocks.
/// </summary>
[Collection("api")]
public class GoogleCalendarIntegrationTests(ApiFactory factory)
{
    private static string QueryValue(Uri u, string name)
    {
        var q = u.Query.TrimStart('?');
        foreach (var pair in q.Split('&'))
        {
            var kv = pair.Split('=', 2);
            if (kv[0] == name) return Uri.UnescapeDataString(kv.ElementAtOrDefault(1) ?? "");
        }
        throw new InvalidOperationException($"No '{name}' in query string '{u.Query}'.");
    }

    /// <summary>Drives the whole redirect round trip (connect -> Google's fake consent -> callback) as a browser would, and returns the
    /// final redirect target so a test can assert on it.</summary>
    private async Task<Uri> ConnectAsync(TestClient c, string googleEmail = "owner@example.com", string? returnUrl = null)
    {
        using var noRedirect = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        using var start = new HttpRequestMessage(HttpMethod.Get, "/api/v1/integrations/google/connect" + (returnUrl is null ? "" : $"?returnUrl={Uri.EscapeDataString(returnUrl)}"));
        start.Headers.Authorization = new AuthenticationHeaderValue("Bearer", c.Token);
        using var startRes = await noRedirect.SendAsync(start);
        Assert.Equal(HttpStatusCode.Redirect, startRes.StatusCode);
        var authorize = startRes.Headers.Location!;
        Assert.StartsWith("https://accounts.google.com/o/oauth2/v2/auth", authorize.ToString());
        Assert.Contains("meetings.space.created", QueryValue(authorize, "scope"));
        var state = QueryValue(authorize, "state");

        var code = factory.GoogleCalendar.IssueCode(googleEmail);
        using var cb = await noRedirect.GetAsync($"/api/v1/integrations/google/callback?code={code}&state={state}");
        Assert.Equal(HttpStatusCode.Redirect, cb.StatusCode);
        return cb.Headers.Location!;
    }

    /// <summary>
    /// GoogleMeetingClient/GoogleCalendarAuthService look up GoogleConnection by an explicit userId, but it is still a tenant-scoped entity,
    /// so the ambient ICurrentContext.TenantId still has to be right for the row to be visible at all - normally supplied by the request
    /// pipeline, which a bare DI scope in a test (or, later, a background worker with no HTTP request behind it) does not have. This mirrors
    /// CalendarFeedService.RenderAsync's own workaround for the exact same situation, and is a real thing the background-sync phase will need.
    /// </summary>
    private IServiceScope AuthenticatedScope(TestClient c)
    {
        var scope = factory.Services.CreateScope();
        var cc = scope.ServiceProvider.GetRequiredService<CurrentContext>();
        cc.UserId = c.UserId; cc.TenantId = c.WorkspaceId; cc.Role = TenantRole.Owner; cc.WorkspaceType = WorkspaceType.Organization; cc.IsPlatformAdmin = false;
        return scope;
    }

    [Fact]
    public async Task No_connection_shows_as_disconnected()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        var status = await c.Get("/api/v1/integrations/google/status");
        Assert.False(status.Data!["connected"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Connecting_lands_back_on_the_requested_page_and_shows_as_connected_with_the_google_email()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();

        var landed = await ConnectAsync(c, "owner@example.com", "/settings/google-workspace");
        Assert.Equal("/settings/google-workspace?google=connected", landed.ToString());

        var status = await c.Get("/api/v1/integrations/google/status");
        Assert.True(status.Data!["connected"]!.GetValue<bool>());
        Assert.Equal("owner@example.com", status.Data["googleEmail"]!.GetValue<string>());
    }

    [Fact]
    public async Task A_declined_consent_does_not_connect_anything()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();

        using var noRedirect = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        using var start = new HttpRequestMessage(HttpMethod.Get, "/api/v1/integrations/google/connect");
        start.Headers.Authorization = new AuthenticationHeaderValue("Bearer", c.Token);
        using var startRes = await noRedirect.SendAsync(start);
        var state = QueryValue(startRes.Headers.Location!, "state");

        using var cb = await noRedirect.GetAsync($"/api/v1/integrations/google/callback?state={state}&error=access_denied");
        Assert.Equal("/settings/google-workspace?google=declined", cb.Headers.Location!.ToString());

        var status = await c.Get("/api/v1/integrations/google/status");
        Assert.False(status.Data!["connected"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Disconnecting_revokes_the_grant_with_google_and_removes_the_local_connection()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        await ConnectAsync(c);

        var disconnect = await c.Post("/api/v1/integrations/google/disconnect");
        Assert.Equal(HttpStatusCode.NoContent, disconnect.Status);
        Assert.Single(factory.GoogleCalendar.RevokedTokens);

        var status = await c.Get("/api/v1/integrations/google/status");
        Assert.False(status.Data!["connected"]!.GetValue<bool>());
    }

    [Fact]
    public async Task A_connected_account_can_create_a_calendar_event_with_a_meet_link()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        await ConnectAsync(c);

        using var scope = AuthenticatedScope(c);
        var client = scope.ServiceProvider.GetRequiredService<GoogleMeetingClient>();
        var start = DateTime.UtcNow.AddDays(1);
        var created = await client.CreateEventAsync(c.UserId, "Sprint planning", "Weekly sync", start, start.AddHours(1), "Asia/Kolkata",
            [new GoogleMeetingAttendee("teammate@example.com")]);

        Assert.StartsWith("evt_", created.EventId);
        Assert.StartsWith("https://meet.google.com/", created.MeetUri);
        Assert.StartsWith("https://calendar.google.com/", created.HtmlLink);
    }

    [Fact]
    public async Task An_expired_access_token_is_refreshed_automatically_before_calling_the_calendar_api()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        await ConnectAsync(c);
        // Back-date the cached access token so GetAccessTokenAsync must refresh instead of reusing it.
        factory.WithDb(db => { var g = db.GoogleConnections.IgnoreQueryFilters().First(x => x.UserId == c.UserId); g.AccessTokenExpiresAt = DateTime.UtcNow.AddMinutes(-5); return db.SaveChanges(); });
        var before = factory.GoogleCalendar.AccessTokensIssued.Count;

        using var scope = AuthenticatedScope(c);
        var client = scope.ServiceProvider.GetRequiredService<GoogleMeetingClient>();
        var start = DateTime.UtcNow.AddDays(1);
        await client.CreateEventAsync(c.UserId, "Retro", null, start, start.AddHours(1), "UTC", []);

        Assert.True(factory.GoogleCalendar.AccessTokensIssued.Count > before, "A new access token should have been issued by the refresh.");
    }

    [Fact]
    public async Task Creating_a_meeting_without_connecting_google_first_fails_with_a_clear_error()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();

        using var scope = factory.Services.CreateScope();
        var client = scope.ServiceProvider.GetRequiredService<GoogleMeetingClient>();
        var start = DateTime.UtcNow.AddDays(1);
        var ex = await Assert.ThrowsAsync<ConflictException>(() => client.CreateEventAsync(c.UserId, "Standup", null, start, start.AddMinutes(30), "UTC", []));
        Assert.Equal("GOOGLE_NOT_CONNECTED", ex.Code);
    }
}
