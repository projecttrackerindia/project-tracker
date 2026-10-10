using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public class SlackIntegrationTests(ApiFactory factory)
{
    private async Task<TestClient> Org(bool eligible = true)
    {
        var c = await TestClient.RegisterAsync(factory); await c.CreateOrgAsync(); await c.UpgradeAsync("BUSINESS");
        if (eligible) factory.WithDb(db => { db.TenantFeatureOverrides.Add(new TenantFeatureOverride { TenantId = c.WorkspaceId, FeatureKey = FeatureKeys.SlackIntegration, Value = 1 }); db.SaveChanges(); return 0; });
        return c;
    }
    private async Task<(string State, string Proof)> Start(TestClient c)
    {
        var r = await c.Post("/api/v1/integrations/slack/connect"); Assert.True(r.Ok, r.ToString());
        var url = new Uri(r.Data!["url"]!.GetValue<string>());
        var state = url.Query.TrimStart('?').Split('&').Select(p => p.Split('=', 2)).Single(p => p[0] == "state")[1];
        var cookie = r.Headers!["Set-Cookie"].Split(';')[0];
        Assert.Contains("httponly", r.Headers["Set-Cookie"], StringComparison.OrdinalIgnoreCase);
        Assert.Contains("secure", r.Headers["Set-Cookie"], StringComparison.OrdinalIgnoreCase);
        return (state, cookie);
    }
    private async Task<HttpResponseMessage> Callback(string state, string? cookie, string code)
    {
        using var client = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/v1/integrations/slack/callback?state=" + state + "&code=" + code);
        if (cookie is not null) request.Headers.TryAddWithoutValidation("Cookie", cookie);
        return await client.SendAsync(request);
    }
    private async Task Connect(TestClient c, string team)
    {
        var start = await Start(c); using var result = await Callback(start.State, start.Proof, factory.Slack.IssueCode(team));
        Assert.Equal(HttpStatusCode.Redirect, result.StatusCode); Assert.EndsWith("/settings/slack?slack=connected", result.Headers.Location!.ToString());
    }

    [Fact]
    public async Task Two_organizations_keep_independent_encrypted_tokens_and_cannot_read_or_disconnect_each_other()
    {
        var a = await Org(); var b = await Org(); var ta = "T" + Guid.NewGuid().ToString("N"); var tb = "T" + Guid.NewGuid().ToString("N");
        await Connect(a, ta); await Connect(b, tb);
        var sa = await a.Get("/api/v1/integrations/slack/status"); var sb = await b.Get("/api/v1/integrations/slack/status");
        Assert.Equal(ta, sa.Data!["teamId"]!.GetValue<string>()); Assert.Equal(tb, sb.Data!["teamId"]!.GetValue<string>());
        Assert.False(sa.Data["interactiveEnabled"]!.GetValue<bool>()); Assert.DoesNotContain("xoxb", sa.Json!.ToJsonString()); Assert.DoesNotContain("Protected", sa.Json.ToJsonString());
        factory.WithDb(db => { var rows = db.SlackConnections.IgnoreQueryFilters().Where(x => x.TenantId == a.WorkspaceId || x.TenantId == b.WorkspaceId).ToList(); Assert.Equal(2, rows.Count); Assert.All(rows, r => Assert.DoesNotContain("xoxb", r.BotTokenProtected)); Assert.NotEqual(rows[0].BotTokenProtected, rows[1].BotTokenProtected); return 0; });
        Assert.Equal(HttpStatusCode.NoContent, (await a.Post("/api/v1/integrations/slack/disconnect")).Status);
        Assert.Contains("xoxb-test-" + ta, factory.Slack.RevokedTokens);
        Assert.True((await b.Get("/api/v1/integrations/slack/status")).Data!["connected"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Missing_entitlement_and_past_due_subscription_block_installation()
    {
        var c = await Org(false); Assert.Equal(HttpStatusCode.Forbidden, (await c.Post("/api/v1/integrations/slack/connect")).Status);
        var d = await Org(); factory.WithDb(db => { db.Subscriptions.Single(x => x.TenantId == d.WorkspaceId).Status = SubscriptionStatus.PastDue; db.SaveChanges(); return 0; });
        Assert.Equal(HttpStatusCode.Forbidden, (await d.Post("/api/v1/integrations/slack/connect")).Status);
    }

    [Fact]
    public async Task Member_cannot_manage_connections_and_demoted_installer_cannot_complete_oauth()
    {
        var c = await Org(); var member = await c.AddMemberAsync(factory, TenantRole.Member);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get("/api/v1/integrations/slack/status")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Post("/api/v1/integrations/slack/connect")).Status);
        var start = await Start(c);
        factory.WithDb(db => { db.TenantMembers.Single(x => x.TenantId == c.WorkspaceId && x.UserId == c.UserId).Role = TenantRole.Member; db.SaveChanges(); return 0; });
        using var callback = await Callback(start.State, start.Proof, factory.Slack.IssueCode("T" + Guid.NewGuid().ToString("N")));
        Assert.Equal(HttpStatusCode.Forbidden, callback.StatusCode);
    }

    [Fact]
    public async Task Oauth_requires_browser_binding_and_is_one_time()
    {
        var c = await Org(); var start = await Start(c); var code = factory.Slack.IssueCode("T" + Guid.NewGuid().ToString("N"));
        using var missing = await Callback(start.State, null, code); Assert.Equal(HttpStatusCode.Unauthorized, missing.StatusCode);
        using var wrong = await Callback(start.State, "__Secure-pt-slack-install=" + new string('F', 64), code); Assert.Equal(HttpStatusCode.Unauthorized, wrong.StatusCode);
        using var correct = await Callback(start.State, start.Proof, code); Assert.Equal(HttpStatusCode.Redirect, correct.StatusCode);
        using var replay = await Callback(start.State, start.Proof, code); Assert.Equal(HttpStatusCode.Unauthorized, replay.StatusCode);
    }

    [Fact]
    public async Task A_workspace_cannot_be_installed_into_two_organizations()
    {
        var a = await Org(); var b = await Org(); var team = "T" + Guid.NewGuid().ToString("N"); await Connect(a, team);
        var start = await Start(b); using var conflict = await Callback(start.State, start.Proof, factory.Slack.IssueCode(team));
        Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        Assert.False((await b.Get("/api/v1/integrations/slack/status")).Data!["connected"]!.GetValue<bool>());
        Assert.True((await a.Get("/api/v1/integrations/slack/status")).Data!["connected"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Wrong_app_and_expired_state_are_rejected_without_saving_tokens()
    {
        var a = await Org(); var start = await Start(a);
        using var wrongApp = await Callback(start.State, start.Proof, factory.Slack.IssueCode("T" + Guid.NewGuid().ToString("N"), "A_OTHER"));
        Assert.Equal(HttpStatusCode.Conflict, wrongApp.StatusCode);
        start = await Start(a);
        factory.WithDb(db => { foreach (var row in db.SlackOAuthAttempts.Where(x => x.TenantId == a.WorkspaceId)) row.ExpiresAt = DateTime.UtcNow.AddMinutes(-1); db.SaveChanges(); return 0; });
        using var expired = await Callback(start.State, start.Proof, factory.Slack.IssueCode("T" + Guid.NewGuid().ToString("N"))); Assert.Equal(HttpStatusCode.Unauthorized, expired.StatusCode);
        Assert.False((await a.Get("/api/v1/integrations/slack/status")).Data!["connected"]!.GetValue<bool>());
    }

    private async Task<HttpResponseMessage> Event(string body, bool valid = true, long? stamp = null)
    {
        var timestamp = (stamp ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds()).ToString();
        var signature = "v0=" + Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes("test-signing-secret"), Encoding.UTF8.GetBytes("v0:" + timestamp + ":" + body))).ToLowerInvariant();
        using var client = factory.CreateClient(); using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/integrations/slack/events");
        request.Content = new StringContent(body, Encoding.UTF8, "application/json"); request.Headers.Add("X-Slack-Request-Timestamp", timestamp);
        request.Headers.Add("X-Slack-Signature", valid ? signature : "v0=" + new string('0', 64)); return await client.SendAsync(request);
    }

    [Fact]
    public async Task Signed_uninstall_only_revokes_its_workspace_and_retries_are_idempotent()
    {
        var a = await Org(); var b = await Org(); var ta = "T" + Guid.NewGuid().ToString("N"); await Connect(a, ta); await Connect(b, "T" + Guid.NewGuid().ToString("N"));
        var body = JsonSerializer.Serialize(new { type = "event_callback", api_app_id = "A_TEST", team_id = ta, event_id = "Ev" + Guid.NewGuid().ToString("N"), event_time = DateTimeOffset.UtcNow.ToUnixTimeSeconds(), @event = new { type = "app_uninstalled" } });
        using var bad = await Event(body, false); Assert.Equal(HttpStatusCode.Unauthorized, bad.StatusCode);
        Assert.True((await a.Get("/api/v1/integrations/slack/status")).Data!["connected"]!.GetValue<bool>());
        using var good = await Event(body); Assert.Equal(HttpStatusCode.OK, good.StatusCode);
        using var retry = await Event(body); Assert.Equal(HttpStatusCode.OK, retry.StatusCode);
        Assert.False((await a.Get("/api/v1/integrations/slack/status")).Data!["connected"]!.GetValue<bool>());
        Assert.True((await b.Get("/api/v1/integrations/slack/status")).Data!["connected"]!.GetValue<bool>());
        factory.WithDb(db => { Assert.Equal("", db.SlackConnections.IgnoreQueryFilters().Single(x => x.TenantId == a.WorkspaceId).BotTokenProtected); Assert.Single(db.AuditLogs.IgnoreQueryFilters().Where(x => x.TenantId == a.WorkspaceId && x.Action == "slack.revoked")); return 0; });
        await a.Post("/api/v1/integrations/slack/disconnect"); await Connect(a, ta);
        using var afterReinstall = await Event(body); Assert.Equal(HttpStatusCode.OK, afterReinstall.StatusCode);
        Assert.True((await a.Get("/api/v1/integrations/slack/status")).Data!["connected"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Bot_revocation_matches_the_installed_bot_user_and_wrong_app_is_ignored()
    {
        var a = await Org(); var team = "T" + Guid.NewGuid().ToString("N"); await Connect(a, team);
        string Body(string app, string bot) => JsonSerializer.Serialize(new { type = "event_callback", api_app_id = app, team_id = team, event_id = "Ev" + Guid.NewGuid().ToString("N"), event_time = DateTimeOffset.UtcNow.ToUnixTimeSeconds(), @event = new { type = "tokens_revoked", tokens = new { bot = new[] { bot } } } });
        using var wrongApp = await Event(Body("A_OTHER", "B_TEST")); Assert.Equal(HttpStatusCode.OK, wrongApp.StatusCode);
        using var wrongBot = await Event(Body("A_TEST", "B_OTHER")); Assert.Equal(HttpStatusCode.OK, wrongBot.StatusCode);
        Assert.True((await a.Get("/api/v1/integrations/slack/status")).Data!["connected"]!.GetValue<bool>());
        using var correct = await Event(Body("A_TEST", "B_TEST")); Assert.Equal(HttpStatusCode.OK, correct.StatusCode);
        Assert.False((await a.Get("/api/v1/integrations/slack/status")).Data!["connected"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Challenge_requires_signature_and_stale_signatures_fail()
    {
        const string body = "{\"type\":\"url_verification\",\"challenge\":\"challenge-test\"}";
        using var stale = await Event(body, stamp: DateTimeOffset.UtcNow.AddMinutes(-6).ToUnixTimeSeconds()); Assert.Equal(HttpStatusCode.Unauthorized, stale.StatusCode);
        using var good = await Event(body); Assert.Equal(HttpStatusCode.OK, good.StatusCode); Assert.Contains("challenge-test", await good.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Concurrent_lifecycle_delivery_records_one_receipt_and_one_audit()
    {
        var a = await Org(); var team = "T" + Guid.NewGuid().ToString("N"); await Connect(a, team);
        var eventId = "Ev" + Guid.NewGuid().ToString("N");
        var body = JsonSerializer.Serialize(new { type = "event_callback", api_app_id = "A_TEST", team_id = team, event_id = eventId, event_time = DateTimeOffset.UtcNow.ToUnixTimeSeconds(), @event = new { type = "app_uninstalled" } });
        var results = await Task.WhenAll(Event(body), Event(body));
        foreach (var result in results) { using (result) Assert.Equal(HttpStatusCode.OK, result.StatusCode); }
        factory.WithDb(db => { Assert.Single(db.SlackEventReceipts.Where(x => x.EventId == eventId)); Assert.Single(db.AuditLogs.IgnoreQueryFilters().Where(x => x.TenantId == a.WorkspaceId && x.Action == "slack.revoked")); return 0; });
    }
}
