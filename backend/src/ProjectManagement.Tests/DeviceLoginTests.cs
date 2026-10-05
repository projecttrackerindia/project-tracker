using System.Net;
using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Signing in on a computer by approving on a phone: the plan gate, the number match, one-time redemption, and what is never revealed or abused.</summary>
[Collection("api")]
public class DeviceLoginTests(ApiFactory factory)
{
    private static string S(System.Text.Json.Nodes.JsonNode? n) => n!.GetValue<string>();

    /// <summary>A person on the given plan with a phone (a push subscription) that approves sign-ins.</summary>
    private async Task<(TestClient Phone, string Endpoint)> PersonWithPhone(string plan = "PRO", bool enable = true)
    {
        var phone = await TestClient.RegisterAsync(factory, "Pat Phone");
        await phone.CreateOrgAsync();
        if (plan != "FREE") await phone.UpgradeAsync(plan);
        var endpoint = await AddDevice(phone);
        if (enable) Assert.True((await phone.Put("/api/v1/push/sign-in", new { endpoint, enabled = true })).Ok);
        return (phone, endpoint);
    }

    private async Task<string> AddDevice(TestClient c)
    {
        using var device = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        var dp = device.ExportParameters(false);
        byte[] pub = [0x04, .. dp.Q.X!, .. dp.Q.Y!];
        var endpoint = $"https://push.example.test/send/{Guid.NewGuid():N}";
        var sub = await c.Post("/api/v1/push/subscriptions", new { endpoint, keys = new { p256dh = Base64Url.Encode(pub), auth = Base64Url.Encode(RandomNumberGenerator.GetBytes(16)) } });
        Assert.True(sub.Ok, sub.ToString());
        return endpoint;
    }

    private TestClient Computer() => new(factory) { Ip = $"198.51.100.{Random.Shared.Next(2, 250)}" };
    private static Task<ApiResult> Start(TestClient computer, string email) => computer.Send(HttpMethod.Post, "/api/v1/auth/device-login", new { email }, true);
    private static Task<ApiResult> Poll(TestClient computer, string id, string secret) => computer.Send(HttpMethod.Post, $"/api/v1/auth/device-login/{id}/poll", new { secret }, true);

    [Fact]
    public async Task Free_workspaces_cannot_choose_a_phone_to_approve_sign_ins_but_paid_ones_can()
    {
        var free = await TestClient.RegisterAsync(factory, "Free Fran");
        await free.CreateOrgAsync();
        var endpoint = await AddDevice(free);
        var refused = await free.Put("/api/v1/push/sign-in", new { endpoint, enabled = true });
        Assert.False(refused.Ok);
        Assert.Equal("FEATURE_NOT_AVAILABLE", refused.ErrorCode);
        var status = (await free.Get($"/api/v1/push/sign-in?endpoint={Uri.EscapeDataString(endpoint)}")).Data!;
        Assert.False(status["planAllows"]!.GetValue<bool>());

        await free.UpgradeAsync("PRO");
        var ok = await free.Put("/api/v1/push/sign-in", new { endpoint, enabled = true });
        Assert.True(ok.Ok, ok.ToString());
        Assert.True(ok.Data!["enabled"]!.GetValue<bool>());
        Assert.True((await free.Put("/api/v1/push/sign-in", new { endpoint, enabled = false })).Ok);   // switching it off is always allowed
    }

    [Fact]
    public async Task The_phone_is_prompted_picks_the_number_and_the_computer_is_signed_in_exactly_once()
    {
        var (phone, endpoint) = await PersonWithPhone();
        var computer = Computer();
        var start = await Start(computer, phone.Email);
        Assert.True(start.Ok, start.ToString());
        var id = S(start.Data!["requestId"]); var secret = S(start.Data["secret"]); var number = start.Data["number"]!.GetValue<int>();
        Assert.InRange(number, 10, 99);
        Assert.Contains(factory.Push.Sent, s => s.Url.ToString() == endpoint);               // the prompt reached the phone at once

        Assert.Equal("pending", S((await Poll(computer, id, secret)).Data!["status"]));
        var pending = (await phone.Get("/api/v1/me/device-login/pending")).Data!.AsArray();
        var mine = pending.Single(p => S(p!["id"]) == id)!;
        var choices = mine["choices"]!.AsArray().Select(c => c!.GetValue<int>()).ToList();
        Assert.Equal(3, choices.Distinct().Count());
        Assert.Contains(number, choices);
        Assert.False(string.IsNullOrWhiteSpace(S(mine["device"])));

        var decoy = choices.First(c => c != number);
        var wrong = await phone.Post($"/api/v1/me/device-login/{id}/approve", new { number = decoy });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, wrong.Status);
        Assert.Equal("pending", S((await Poll(computer, id, secret)).Data!["status"]));        // one wrong tap does not end it, and approves nothing

        Assert.Equal(HttpStatusCode.NoContent, (await phone.Post($"/api/v1/me/device-login/{id}/approve", new { number })).Status);
        var done = await Poll(computer, id, secret);
        Assert.Equal("approved", S(done.Data!["status"]));
        var signedIn = new TestClient(factory) { Token = S(done.Data["auth"]!["accessToken"]) };
        Assert.Equal(phone.Email, S((await signedIn.Get("/api/v1/me")).Data!["user"]!["email"]));   // a real session, for the right person

        Assert.Equal("expired", S((await Poll(computer, id, secret)).Data!["status"]));        // redeemable once
    }

    [Fact]
    public async Task Only_the_computer_that_asked_can_redeem_and_two_wrong_numbers_stop_the_request()
    {
        var (phone, _) = await PersonWithPhone();
        var computer = Computer();
        var start = (await Start(computer, phone.Email)).Data!;
        var id = S(start["requestId"]); var secret = S(start["secret"]); var number = start["number"]!.GetValue<int>();
        var other = number == 55 ? 56 : 55;

        Assert.Equal("expired", S((await Poll(computer, id, "not-the-secret")).Data!["status"]));   // someone who saw the id but not the secret learns nothing
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await phone.Post($"/api/v1/me/device-login/{id}/approve", new { number = other })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await phone.Post($"/api/v1/me/device-login/{id}/approve", new { number = other })).Status);
        Assert.Equal("denied", S((await Poll(computer, id, secret)).Data!["status"]));
        Assert.Equal(HttpStatusCode.Conflict, (await phone.Post($"/api/v1/me/device-login/{id}/approve", new { number })).Status);   // too late: stopped for good
    }

    [Fact]
    public async Task Denying_stops_it_and_nobody_else_can_answer_for_the_person()
    {
        var (phone, _) = await PersonWithPhone();
        var stranger = await TestClient.RegisterAsync(factory, "Sam Stranger");
        var computer = Computer();
        var start = (await Start(computer, phone.Email)).Data!;
        var id = S(start["requestId"]); var secret = S(start["secret"]); var number = start["number"]!.GetValue<int>();

        Assert.Equal(HttpStatusCode.NotFound, (await stranger.Post($"/api/v1/me/device-login/{id}/approve", new { number })).Status);
        Assert.Empty((await stranger.Get("/api/v1/me/device-login/pending")).Data!.AsArray());

        Assert.Equal(HttpStatusCode.NoContent, (await phone.Post($"/api/v1/me/device-login/{id}/deny")).Status);
        Assert.Equal("denied", S((await Poll(computer, id, secret)).Data!["status"]));
    }

    [Fact]
    public async Task An_address_with_no_phone_set_up_gets_the_same_answer_and_no_one_is_prompted()
    {
        var withPhone = await PersonWithPhone(enable: false);   // has a device but never chose it for sign-in
        var before = factory.Push.Sent.Count;
        var computer = Computer();
        foreach (var email in new[] { withPhone.Phone.Email, $"nobody-{Guid.NewGuid():N}@example.com", "" })
        {
            var start = await Start(computer, email);
            Assert.True(start.Ok, start.ToString());
            Assert.Equal(new[] { "expiresAt", "number", "requestId", "secret" }, start.Data!.AsObject().Select(p => p.Key).Order().ToArray());   // the same shape every time
            Assert.Equal("pending", S((await Poll(computer, S(start.Data["requestId"]), S(start.Data["secret"]))).Data!["status"]));
        }
        Assert.Equal(before, factory.Push.Sent.Count);           // nothing was sent to anyone
    }

    [Fact]
    public async Task A_person_is_prompted_at_most_three_times_in_ten_minutes_and_a_request_lasts_two_minutes()
    {
        var (phone, endpoint) = await PersonWithPhone();
        var computer = Computer();
        var sentBefore = factory.Push.Sent.Count(s => s.Url.ToString() == endpoint);
        string? firstId = null, firstSecret = null;
        for (var i = 0; i < 5; i++)
        {
            var d = (await Start(computer, phone.Email)).Data!;
            if (i == 0) { firstId = S(d["requestId"]); firstSecret = S(d["secret"]); }
        }
        Assert.Equal(3, factory.Push.Sent.Count(s => s.Url.ToString() == endpoint) - sentBefore);                       // the other two were never sent
        Assert.Equal(3, (await phone.Get("/api/v1/me/device-login/pending")).Data!.AsArray().Count);

        factory.WithDb(db => db.DeviceLoginRequests.Where(r => r.UserId == phone.UserId).ExecuteUpdate(s => s.SetProperty(r => r.ExpiresAt, DateTime.UtcNow.AddSeconds(-5))));
        Assert.Equal("expired", S((await Poll(computer, firstId!, firstSecret!)).Data!["status"]));
        Assert.Empty((await phone.Get("/api/v1/me/device-login/pending")).Data!.AsArray());
    }

    [Fact]
    public async Task A_person_whose_plan_no_longer_includes_the_mobile_app_is_no_longer_prompted()
    {
        var (phone, endpoint) = await PersonWithPhone();
        factory.WithDb(db =>
        {
            var free = db.Plans.Single(p => p.Code == "FREE");
            db.Subscriptions.IgnoreQueryFilters().Where(s => s.TenantId == phone.WorkspaceId).ExecuteUpdate(s => s.SetProperty(x => x.PlanId, free.Id));
            return 0;
        });
        var before = factory.Push.Sent.Count(s => s.Url.ToString() == endpoint);
        var start = await Start(Computer(), phone.Email);
        Assert.True(start.Ok);
        Assert.Equal(before, factory.Push.Sent.Count(s => s.Url.ToString() == endpoint));
    }

    [Theory]
    [InlineData("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", "Chrome on Windows")]
    [InlineData("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0", "Edge on Windows")]
    [InlineData("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17 Safari/605.1.15", "Safari on macOS")]
    [InlineData("Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0", "Firefox on Linux")]
    [InlineData("", "an unknown browser")]
    public void A_screen_is_described_the_way_a_person_would_say_it(string ua, string expected) =>
        Assert.Equal(expected, ProjectManagement.Application.Features.Auth.DeviceLoginService.Describe(ua));
}
