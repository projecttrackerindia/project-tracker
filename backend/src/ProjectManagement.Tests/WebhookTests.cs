using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Webhooks: signed notifications of workspace events, with filtering, retries and protection against internal addresses.</summary>
[Collection("api")]
public class WebhookTests(ApiFactory factory)
{
    private string NewUrl() => $"http://receiver.test/{Guid.NewGuid():N}";

    private async Task<(TestClient C, Guid Project)> Setup(string plan = "BUSINESS")
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        if (plan != "FREE") await c.UpgradeAsync(plan);
        return (c, await c.CreateProjectAsync("Atlas"));
    }

    private static async Task<(Guid Id, string Secret, string Url)> Hook(TestClient c, string url, params string[] events)
    {
        var res = await c.Post("/api/v1/webhooks", new { name = "Receiver", url, events = events.Length == 0 ? null : events });
        Assert.Equal(HttpStatusCode.Created, res.Status);
        return (Guid.Parse(res.Data!["webhook"]!["id"]!.GetValue<string>()), res.Data["secret"]!.GetValue<string>(), url);
    }

    private Task RunAsync() => factory.Services.GetRequiredService<WebhookProcessor>().RunAsync();

    private static JsonNode Body(SentWebhook s) => JsonNode.Parse(s.Body)!;

    // ------------------------------------------------------------------ delivery

    [Fact]
    public async Task Events_are_delivered_signed_with_the_documented_headers_and_payload()
    {
        var (c, project) = await Setup();
        var (_, secret, url) = await Hook(c, NewUrl());
        var task = await c.CreateTaskAsync(project, "Ship it");
        await RunAsync();

        var sent = factory.Webhooks.To(url).Single(s => s.Headers["X-PM-Event"] == "task.created");
        var body = Body(sent);
        Assert.Equal("task.created", body["event"]!.GetValue<string>());
        Assert.Equal(c.WorkspaceId.ToString(), body["workspaceId"]!.GetValue<string>());
        Assert.Contains("Ship it", body["data"]!["summary"]!.GetValue<string>());
        Assert.Equal(task["id"]!.GetValue<string>(), body["data"]!["entity"]!["id"]!.GetValue<string>());
        Assert.Equal(c.UserId.ToString(), body["data"]!["actor"]!["id"]!.GetValue<string>());
        Assert.Equal(body["id"]!.GetValue<string>().Length, 36);

        // The signature is HMAC-SHA256 of "<timestamp>.<body>" with the secret shown at creation.
        var parts = sent.Headers["X-PM-Signature"].Split(',').Select(p => p.Split('=', 2)).ToDictionary(p => p[0], p => p[1]);
        Assert.Equal(sent.Headers["X-PM-Timestamp"], parts["t"]);
        var expected = Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes($"{parts["t"]}.{sent.Body}"))).ToLowerInvariant();
        Assert.Equal(expected, parts["v1"]);

        var hook = (await c.Get("/api/v1/webhooks")).Data![0]!;
        Assert.Equal("ok", hook["lastStatus"]!.GetValue<string>());
        Assert.DoesNotContain(secret, (await c.Get("/api/v1/webhooks")).Data!.ToJsonString());
    }

    [Fact]
    public async Task Webhooks_only_get_the_events_they_asked_for_and_nothing_from_before_they_existed()
    {
        var (c, project) = await Setup();
        var before = await c.CreateTaskAsync(project, "Existed before");
        await Task.Delay(20);
        var (_, _, exact) = await Hook(c, NewUrl(), "task.status_changed");
        var (_, _, group) = await Hook(c, NewUrl(), "task.*");
        var (_, _, everything) = await Hook(c, NewUrl());

        var task = await c.CreateTaskAsync(project, "Created after");
        var statuses = (await c.Get($"/api/v1/projects/{project}/statuses")).Data!.AsArray();
        await c.Send(HttpMethod.Patch, $"/api/v1/tasks/{task["id"]}/move", new { statusId = statuses.First(s => s!["name"]!.GetValue<string>() == "Done")!["id"]!.GetValue<string>() });
        await RunAsync();

        Assert.Equal(new[] { "task.status_changed" }, factory.Webhooks.To(exact).Select(s => s.Headers["X-PM-Event"]));
        Assert.Contains(factory.Webhooks.To(group), s => s.Headers["X-PM-Event"] == "task.created");
        Assert.Contains(factory.Webhooks.To(everything), s => s.Headers["X-PM-Event"] == "task.status_changed");
        Assert.DoesNotContain(factory.Webhooks.Sent.Where(s => s.Url == exact || s.Url == group || s.Url == everything), s => s.Body.Contains("Existed before"));
        _ = before;

        // Running again sends nothing twice.
        var count = factory.Webhooks.To(everything).Count;
        await RunAsync();
        Assert.Equal(count, factory.Webhooks.To(everything).Count);
    }

    [Fact]
    public async Task A_webhook_only_hears_about_its_own_workspace()
    {
        var (a, projectA) = await Setup();
        var (b, projectB) = await Setup();
        var (_, _, urlA) = await Hook(a, NewUrl());
        await b.CreateTaskAsync(projectB, "Someone else's task");
        await a.CreateTaskAsync(projectA, "Mine");
        await RunAsync();
        var bodies = factory.Webhooks.To(urlA).Select(s => s.Body).ToList();
        Assert.Contains(bodies, x => x.Contains("Mine"));
        Assert.DoesNotContain(bodies, x => x.Contains("Someone else's task"));
    }

    [Fact]
    public async Task Failed_deliveries_are_retried_later_and_given_up_after_six_attempts()
    {
        var (c, project) = await Setup();
        var (id, _, url) = await Hook(c, NewUrl(), "task.created");
        factory.Webhooks.Status = u => u == url ? 500 : 200;
        await c.CreateTaskAsync(project, "Will fail");
        await RunAsync();

        var d = (await c.Get($"/api/v1/webhooks/{id}/deliveries")).Data![0]!;
        Assert.Equal("Pending", d["status"]!.GetValue<string>());
        Assert.Equal(1, d["attempts"]!.GetValue<int>());
        Assert.NotNull(d["nextAttemptAt"]);
        var sentAfterFirst = factory.Webhooks.To(url).Count;

        await RunAsync();  // not due yet: nothing is sent
        Assert.Equal(sentAfterFirst, factory.Webhooks.To(url).Count);

        for (var i = 0; i < 5; i++)
        {
            factory.WithDb(db => { db.WebhookDeliveries.IgnoreQueryFilters().Where(x => x.WebhookId == id).ExecuteUpdate(s => s.SetProperty(x => x.NextAttemptAt, DateTime.UtcNow.AddSeconds(-1))); return 0; });
            await RunAsync();
        }
        var last = (await c.Get($"/api/v1/webhooks/{id}/deliveries")).Data![0]!;
        Assert.Equal("Failed", last["status"]!.GetValue<string>());
        Assert.Equal(6, last["attempts"]!.GetValue<int>());
        Assert.Equal(500, last["responseStatus"]!.GetValue<int>());

        // A failed delivery can be retried by hand, and success clears the failure count.
        factory.Webhooks.Status = _ => 200;
        Assert.Equal(HttpStatusCode.NoContent, (await c.Post($"/api/v1/webhooks/{id}/deliveries/{last["id"]}/retry")).Status);
        await RunAsync();
        Assert.Equal("Succeeded", (await c.Get($"/api/v1/webhooks/{id}/deliveries")).Data![0]!["status"]!.GetValue<string>());
        Assert.Equal(0, (await c.Get("/api/v1/webhooks")).Data![0]!["consecutiveFailures"]!.GetValue<int>());
    }

    [Fact]
    public async Task A_receiver_that_keeps_failing_is_switched_off_and_can_be_switched_back_on()
    {
        var (c, project) = await Setup();
        var (id, _, url) = await Hook(c, NewUrl(), "task.created");
        factory.Webhooks.Status = u => u == url ? 0 : 200; // cannot connect
        await c.CreateTaskAsync(project, "Doomed");
        await RunAsync();
        // Pretend nine earlier deliveries already failed for good; the next final failure is the tenth.
        factory.WithDb(db =>
        {
            db.Webhooks.IgnoreQueryFilters().Where(w => w.Id == id).ExecuteUpdate(s => s.SetProperty(w => w.ConsecutiveFailures, 9));
            db.WebhookDeliveries.IgnoreQueryFilters().Where(x => x.WebhookId == id).ExecuteUpdate(s => s.SetProperty(x => x.Attempts, 5).SetProperty(x => x.NextAttemptAt, DateTime.UtcNow.AddSeconds(-1)));
            return 0;
        });
        await RunAsync();

        var hook = (await c.Get("/api/v1/webhooks")).Data![0]!;
        Assert.False(hook["isActive"]!.GetValue<bool>());
        Assert.Contains("automatically", hook["disabledReason"]!.GetValue<string>());

        // Events while it is off are not queued, and turning it on again does not replay them.
        await c.CreateTaskAsync(project, "While off");
        factory.Webhooks.Status = _ => 200;
        var on = await c.Put($"/api/v1/webhooks/{id}", new { name = "Receiver", url, events = new[] { "task.created" }, isActive = true });
        Assert.True(on.Ok, on.ToString());
        await RunAsync();
        Assert.DoesNotContain(factory.Webhooks.To(url), s => s.Body.Contains("While off"));
    }

    [Fact]
    public async Task Test_pings_secret_rotation_and_deletion_work()
    {
        var (c, _) = await Setup();
        var (id, secret, url) = await Hook(c, NewUrl(), "sprint.started");
        var ping = await c.Post($"/api/v1/webhooks/{id}/test");
        Assert.Equal(HttpStatusCode.Accepted, ping.Status);
        await RunAsync();
        Assert.Single(factory.Webhooks.To(url), s => s.Headers["X-PM-Event"] == "ping"); // a ping ignores the event filter

        var rotated = await c.Post($"/api/v1/webhooks/{id}/rotate-secret");
        var next = rotated.Data!["secret"]!.GetValue<string>();
        Assert.NotEqual(secret, next);
        await c.Post($"/api/v1/webhooks/{id}/test");
        await RunAsync();
        var sent = factory.Webhooks.To(url).Last();
        var t = sent.Headers["X-PM-Timestamp"];
        var signed = Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(next), Encoding.UTF8.GetBytes($"{t}.{sent.Body}"))).ToLowerInvariant();
        Assert.EndsWith(signed, sent.Headers["X-PM-Signature"]);

        Assert.Equal(HttpStatusCode.NoContent, (await c.Delete($"/api/v1/webhooks/{id}")).Status);
        Assert.Empty((await c.Get("/api/v1/webhooks")).Data!.AsArray());
        Assert.Equal(HttpStatusCode.NotFound, (await c.Get($"/api/v1/webhooks/{id}/deliveries")).Status);
    }

    // ------------------------------------------------------------------ management rules

    [Fact]
    public async Task Webhook_input_is_validated_and_limited()
    {
        var (c, _) = await Setup();
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post("/api/v1/webhooks", new { name = "", url = NewUrl() })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post("/api/v1/webhooks", new { name = "x", url = "not a url" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post("/api/v1/webhooks", new { name = "x", url = "ftp://example.com/x" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post("/api/v1/webhooks", new { name = "x", url = "http://user:pw@example.com/x" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post("/api/v1/webhooks", new { name = "x", url = NewUrl(), events = new[] { "task.exploded" } })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post("/api/v1/webhooks", new { name = "x", url = NewUrl(), events = new[] { "nothing.*" } })).Status);
        Assert.Contains("task.created", (await c.Get("/api/v1/webhooks/events")).Data!.ToJsonString());

        for (var i = 0; i < 10; i++) await Hook(c, NewUrl());
        Assert.Equal(HttpStatusCode.Conflict, (await c.Post("/api/v1/webhooks", new { name = "eleventh", url = NewUrl() })).Status);
    }

    [Fact]
    public async Task Only_admins_on_a_plan_with_api_access_can_manage_webhooks_and_keys_cannot()
    {
        var (free, _) = await Setup("FREE");
        Assert.Equal(HttpStatusCode.Forbidden, (await free.Post("/api/v1/webhooks", new { name = "x", url = NewUrl() })).Status);

        var (c, _) = await Setup();
        var member = await c.AddMemberAsync(factory, TenantRole.Member, "Mem");
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get("/api/v1/webhooks")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Post("/api/v1/webhooks", new { name = "x", url = NewUrl() })).Status);

        var key = (await c.Post("/api/v1/api-keys", new { name = "k", scope = "ReadWrite" })).Data!["secret"]!.GetValue<string>();
        var viaKey = new TestClient(factory) { Token = key };
        Assert.Equal("API_KEY_NOT_ALLOWED", (await viaKey.Get("/api/v1/webhooks")).ErrorCode);
    }

    // ------------------------------------------------------------------ protection against internal addresses

    [Theory]
    [InlineData("127.0.0.1", true)] [InlineData("10.1.2.3", true)] [InlineData("172.16.0.1", true)] [InlineData("172.32.0.1", false)]
    [InlineData("192.168.1.1", true)] [InlineData("169.254.169.254", true)] [InlineData("100.64.0.1", true)] [InlineData("0.0.0.0", true)]
    [InlineData("::1", true)] [InlineData("fe80::1", true)] [InlineData("fd00::1", true)] [InlineData("::ffff:10.0.0.1", true)]
    [InlineData("8.8.8.8", false)] [InlineData("93.184.216.34", false)] [InlineData("2606:4700:4700::1111", false)]
    public void Internal_addresses_are_recognised(string ip, bool blocked) => Assert.Equal(blocked, WebhookUrlRules.IsBlocked(IPAddress.Parse(ip)));

    [Fact]
    public async Task Urls_to_internal_addresses_or_plain_http_are_refused_in_production_mode()
    {
        foreach (var url in new[] { "https://127.0.0.1/hook", "https://169.254.169.254/latest/meta-data", "https://10.0.0.5/x", "https://[::1]/x", "http://8.8.8.8/x" })
            Assert.NotNull(await WebhookUrlRules.CheckAsync(url, allowPrivate: false, CancellationToken.None));
        Assert.Null(await WebhookUrlRules.CheckAsync("https://8.8.8.8/hook", allowPrivate: false, CancellationToken.None));
        Assert.Null(await WebhookUrlRules.CheckAsync("http://localhost:9000/hook", allowPrivate: true, CancellationToken.None)); // development / tests only
    }
}
