using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// "Single active session" with approve-on-other-device: a sign-in on a new device waits for a device already signed in to allow it (the old one is
/// then signed out and told why), reject it or report it; after two minutes it is denied, and the person can still let themselves in with an emailed
/// link or a code. A device never approves its own sign-in. Fictional people and addresses only.
/// </summary>
[Collection("api")]
public class SessionApprovalTests(ApiFactory factory)
{
    private const string Password = "Passw0rd!xKey";
    private const string Chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
    private static string S(JsonNode? n) => n!.GetValue<string>();

    /// <summary>Someone signed in on their laptop, with "Single active session" turned on for themselves.</summary>
    private async Task<TestClient> SignedInWithPolicy(string name = "Lena Laptop")
    {
        var laptop = await TestClient.RegisterAsync(factory, name);
        var on = await laptop.Put("/api/v1/me/session-policy", new { singleSession = true });
        Assert.True(on.Ok, on.ToString());
        Assert.True(on.Data!["effective"]!.GetValue<bool>());
        return laptop;
    }

    private TestClient NewDevice(TestClient owner)
    {
        var c = new TestClient(factory) { Email = owner.Email, Ip = $"203.0.113.{Random.Shared.Next(2, 250)}" };
        c.Extra["User-Agent"] = Chrome;
        c.Extra["X-Client-Zone"] = "Asia/Kolkata";
        return c;
    }

    /// <summary>The new device signs in: the password is right, but it is told to wait, with a code and the secret only it holds.</summary>
    private static async Task<(string Id, string Secret, int Code)> AskAsync(TestClient device)
    {
        var res = await device.LoginAsync(Password);
        Assert.True(res.Ok, res.ToString());
        Assert.True(res.Data!["approvalRequired"]!.GetValue<bool>(), res.ToString());
        Assert.Null(res.Data["accessToken"]);
        Assert.Null(device.Token);
        return (S(res.Data["approvalId"]), S(res.Data["secret"]), res.Data["code"]!.GetValue<int>());
    }

    private static Task<ApiResult> StatusOf(TestClient device, string id, string secret) =>
        device.Send(HttpMethod.Post, $"/api/v1/auth/session-approval/{id}/status", new { secret }, true);

    private static async Task<JsonNode> PromptOn(TestClient signedIn, string id)
    {
        var pending = (await signedIn.Get("/api/v1/me/session-approvals/pending")).Data!.AsArray();
        return pending.Single(p => S(p!["id"]) == id)!;
    }

    private static Task<ApiResult> Decide(TestClient signedIn, string id, string token, string decision) =>
        signedIn.Post($"/api/v1/auth/session-approval/{id}/decide", new { token, decision });

    private void Expire(string id) => factory.WithDb(db =>
        db.SessionApprovals.Where(a => a.Id == Guid.Parse(id)).ExecuteUpdate(s => s.SetProperty(a => a.ExpiresAt, DateTime.UtcNow.AddSeconds(-5))));

    private bool Audited(Guid userId, string action) =>
        factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Any(a => a.UserId == userId && a.Action == action));

    [Fact]
    public async Task Allow_signs_in_the_new_device_and_signs_out_the_old_one_with_the_reason()
    {
        var laptop = await SignedInWithPolicy();
        var phone = NewDevice(laptop);
        var (id, secret, code) = await AskAsync(phone);
        Assert.InRange(code, 10, 99);
        Assert.Equal("pending", S((await StatusOf(phone, id, secret)).Data!["status"]));

        var prompt = await PromptOn(laptop, id);
        Assert.Equal(code, prompt["code"]!.GetValue<int>());
        Assert.Equal("Chrome on Windows", S(prompt["device"]));
        Assert.Equal("web", S(prompt["app"]));
        Assert.Equal("Kolkata region", S(prompt["location"]));
        Assert.Equal(phone.Ip, S(prompt["ipAddress"]));

        var allowed = await Decide(laptop, id, S(prompt["token"]), "allow");
        Assert.True(allowed.Ok, allowed.ToString());
        Assert.Equal("allowed", S(allowed.Data!["outcome"]));

        var done = await StatusOf(phone, id, secret);
        Assert.Equal("approved", S(done.Data!["status"]));
        phone.Token = S(done.Data["auth"]!["accessToken"]);
        Assert.Equal(laptop.Email, S((await phone.Get("/api/v1/me")).Data!["user"]!["email"]));
        Assert.Equal("closed", S((await StatusOf(phone, id, secret)).Data!["status"]));          // redeemed once

        Assert.Equal(HttpStatusCode.Unauthorized, (await laptop.Get("/api/v1/me")).Status);        // the old device is signed out at once
        var refresh = await laptop.Send(HttpMethod.Post, "/api/v1/auth/refresh", new { refreshToken = laptop.RefreshToken }, true);
        Assert.Equal("SESSION_REPLACED", refresh.ErrorCode);
        Assert.Contains("Signed out because you signed in on Chrome on Windows", refresh.Json!["errors"]![0]!["message"]!.GetValue<string>());

        var history = (await phone.Get("/api/v1/me/session-approvals")).Data!.AsArray();
        Assert.Equal("allowed", S(history.Single(h => S(h!["id"]) == id)!["outcome"]));
        Assert.True(Audited(laptop.UserId, "session.approval_requested"));
        Assert.True(Audited(laptop.UserId, "session.approval_allowed"));
        Assert.True(Audited(laptop.UserId, "session.replaced"));
    }

    [Fact]
    public async Task Reject_denies_the_new_device_and_keeps_the_old_one_signed_in()
    {
        var laptop = await SignedInWithPolicy("Rhea Reject");
        var phone = NewDevice(laptop);
        var (id, secret, _) = await AskAsync(phone);
        var prompt = await PromptOn(laptop, id);

        Assert.Equal("rejected", S((await Decide(laptop, id, S(prompt["token"]), "reject")).Data!["outcome"]));
        Assert.Equal("rejected", S((await StatusOf(phone, id, secret)).Data!["status"]));
        Assert.Equal(HttpStatusCode.Conflict, (await Decide(laptop, id, S(prompt["token"]), "allow")).Status);   // answered once
        Assert.False((await phone.Send(HttpMethod.Post, $"/api/v1/auth/session-approval/{id}/email", new { secret }, true)).Ok);   // no fallback after a rejection
        Assert.True((await laptop.Get("/api/v1/me")).Ok);
        Assert.True(Audited(laptop.UserId, "session.approval_rejected"));
    }

    [Fact]
    public async Task After_two_minutes_it_is_denied_and_the_emailed_link_lets_the_person_in_once()
    {
        var laptop = await SignedInWithPolicy("Tara Timeout");
        var phone = NewDevice(laptop);
        var (id, secret, _) = await AskAsync(phone);
        var prompt = await PromptOn(laptop, id);
        Expire(id);

        var timedOut = (await StatusOf(phone, id, secret)).Data!;
        Assert.Equal("timed_out", S(timedOut["status"]));
        Assert.True(timedOut["canEmail"]!.GetValue<bool>());
        Assert.False(timedOut["canCode"]!.GetValue<bool>());                                       // no authenticator on this account
        Assert.Equal(HttpStatusCode.Conflict, (await Decide(laptop, id, S(prompt["token"]), "allow")).Status);   // too late to answer
        Assert.Empty((await laptop.Get("/api/v1/me/session-approvals/pending")).Data!.AsArray());
        Assert.True(Audited(laptop.UserId, "session.approval_timed_out"));

        Assert.False((await phone.Send(HttpMethod.Post, $"/api/v1/auth/session-approval/{id}/email", new { secret = "not-the-secret" }, true)).Ok);
        Assert.True((await phone.Send(HttpMethod.Post, $"/api/v1/auth/session-approval/{id}/email", new { secret }, true)).Ok);
        var token = await phone.MailboxToken("approve-sign-in");
        var preview = await phone.Send(HttpMethod.Post, "/api/v1/auth/session-approval/email/preview", new { token }, true);
        Assert.Equal("Chrome on Windows", S(preview.Data!["device"]));
        Assert.Equal("timed_out", S((await StatusOf(phone, id, secret)).Data!["status"]));       // opening the link changes nothing
        Assert.False((await phone.Send(HttpMethod.Post, "/api/v1/auth/session-approval/email/confirm", new { token = token + "x" }, true)).Ok);   // signed
        Assert.True((await phone.Send(HttpMethod.Post, "/api/v1/auth/session-approval/email/confirm", new { token }, true)).Ok);
        Assert.False((await phone.Send(HttpMethod.Post, "/api/v1/auth/session-approval/email/confirm", new { token }, true)).Ok);   // single use

        var done = (await StatusOf(phone, id, secret)).Data!;
        Assert.Equal("approved", S(done["status"]));
        Assert.NotNull(done["auth"]!["accessToken"]);
        Assert.Equal(HttpStatusCode.Unauthorized, (await laptop.Get("/api/v1/me")).Status);
    }

    [Fact]
    public async Task After_the_timeout_a_recovery_code_approves_it_and_wrong_codes_do_not()
    {
        var laptop = await TestClient.RegisterAsync(factory, "Cora Code");
        var setup = await laptop.Post("/api/v1/me/mfa/setup", new { password = Password });
        var totp = setup.Data!["secret"]!.GetValue<string>().Replace(" ", "");
        var enable = await laptop.Post("/api/v1/me/mfa/enable", new { code = ProjectManagement.Application.Common.Totp.Compute(totp, ProjectManagement.Application.Common.Totp.StepOf(DateTime.UtcNow)) });
        var recovery = enable.Data!["codes"]!.AsArray().Select(x => x!.GetValue<string>()).ToList();
        Assert.True((await laptop.Put("/api/v1/me/session-policy", new { singleSession = true })).Ok);

        var phone = NewDevice(laptop);
        var first = await phone.LoginAsync(Password);
        Assert.True(first.Data!["mfaRequired"]!.GetValue<bool>());
        var mfa = await phone.Send(HttpMethod.Post, "/api/v1/auth/login/mfa", new { challenge = S(first.Data["challenge"]), code = recovery[0] }, true);
        Assert.True(mfa.Data!["approvalRequired"]!.GetValue<bool>(), mfa.ToString());               // password and code passed, approval still needed
        var id = S(mfa.Data["approvalId"]); var secret = S(mfa.Data["secret"]);

        Assert.Equal(HttpStatusCode.Conflict, (await phone.Send(HttpMethod.Post, $"/api/v1/auth/session-approval/{id}/code", new { secret, code = recovery[1] }, true)).Status);   // not before the timeout
        Expire(id);
        Assert.True((await StatusOf(phone, id, secret)).Data!["canCode"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await phone.Send(HttpMethod.Post, $"/api/v1/auth/session-approval/{id}/code", new { secret, code = "0000000000" }, true)).Status);
        Assert.True((await phone.Send(HttpMethod.Post, $"/api/v1/auth/session-approval/{id}/code", new { secret, code = recovery[1] }, true)).Ok);
        Assert.Equal("approved", S((await StatusOf(phone, id, secret)).Data!["status"]));
    }

    [Fact]
    public async Task A_new_device_cannot_approve_its_own_sign_in()
    {
        var laptop = await SignedInWithPolicy("Sam Self");
        var phone = NewDevice(laptop);
        var (id, secret, _) = await AskAsync(phone);
        var prompt = await PromptOn(laptop, id);
        var token = S(prompt["token"]);

        // Anonymous: the waiting device has no session to answer with.
        Assert.Equal(HttpStatusCode.Unauthorized, (await phone.Send(HttpMethod.Post, $"/api/v1/auth/session-approval/{id}/decide", new { token, decision = "allow" }, true)).Status);

        // A browser that holds the request's own secret is refused, even with a signed-in session and a valid token.
        laptop.Extra["Cookie"] = $"{"pm_approval"}={secret}";
        var self = await Decide(laptop, id, token, "allow");
        Assert.Equal(HttpStatusCode.Forbidden, self.Status);
        Assert.Equal("SELF_APPROVAL", self.ErrorCode);
        laptop.Extra.Remove("Cookie");

        // A session that began after the request (it is not "the device already signed in") cannot see or answer it.
        factory.WithDb(db => db.UserSessions.Where(s => s.UserId == laptop.UserId).ExecuteUpdate(s => s.SetProperty(x => x.CreatedAt, DateTime.UtcNow.AddMinutes(1))));
        Assert.Empty((await laptop.Get("/api/v1/me/session-approvals/pending")).Data!.AsArray());
        Assert.Equal("SELF_APPROVAL", (await Decide(laptop, id, token, "allow")).ErrorCode);
        Assert.Equal("pending", S((await StatusOf(phone, id, secret)).Data!["status"]));
        Assert.True(Audited(laptop.UserId, "session.approval_self_blocked"));
    }

    [Fact]
    public async Task Answers_need_the_signed_token_and_only_the_account_itself_can_answer()
    {
        var laptop = await SignedInWithPolicy("Tom Token");
        var stranger = await TestClient.RegisterAsync(factory, "Sara Stranger");
        var (id, secret, _) = await AskAsync(NewDevice(laptop));
        var token = S((await PromptOn(laptop, id))["token"]);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Decide(laptop, id, token[..^2] + "zz", "allow")).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Decide(stranger, id, token, "allow")).Status);   // the token names the account
        Assert.Empty((await stranger.Get("/api/v1/me/session-approvals/pending")).Data!.AsArray());
        Assert.Equal("closed", S((await StatusOf(new TestClient(factory), id, "guess")).Data!["status"]));    // the id alone reveals nothing
        Assert.Equal("pending", S((await StatusOf(new TestClient(factory), id, secret)).Data!["status"]));
    }

    [Fact]
    public async Task This_was_not_me_ends_every_session_and_requires_a_new_password()
    {
        var laptop = await SignedInWithPolicy("Nina Notme");
        var phone = NewDevice(laptop);
        var (id, secret, _) = await AskAsync(phone);
        var prompt = await PromptOn(laptop, id);

        Assert.Equal("reported", S((await Decide(laptop, id, S(prompt["token"]), "not-me")).Data!["outcome"]));
        Assert.Equal("rejected", S((await StatusOf(phone, id, secret)).Data!["status"]));
        Assert.Equal(HttpStatusCode.Unauthorized, (await laptop.Get("/api/v1/me")).Status);       // even the device that reported it
        Assert.Equal("INVALID_CREDENTIALS", (await NewDevice(laptop).LoginAsync(Password)).ErrorCode);   // the old password no longer works
        Assert.False(string.IsNullOrEmpty(await laptop.MailboxToken("reset-password")));
        Assert.True(Audited(laptop.UserId, "user.account_secured"));
    }

    [Fact]
    public async Task Without_the_setting_or_another_session_nothing_waits_and_requests_are_rate_limited()
    {
        var plain = await TestClient.RegisterAsync(factory, "Pia Plain");
        var second = NewDevice(plain);
        Assert.NotNull((await second.LoginAsync(Password)).Data!["accessToken"]);                // the setting is off by default

        var laptop = await SignedInWithPolicy("Rita Rate");
        for (var i = 0; i < SessionApprovalGate.MaxRequestsPer10Minutes; i++) await AskAsync(NewDevice(laptop));
        var limited = await NewDevice(laptop).LoginAsync(Password);
        Assert.Equal(HttpStatusCode.TooManyRequests, limited.Status);
        Assert.Equal("APPROVAL_RATE_LIMITED", limited.ErrorCode);

        // Signed out everywhere: the next sign-in has nobody to ask, so it simply goes through.
        Assert.True((await laptop.Post("/api/v1/auth/logout-all")).Ok);
        Assert.NotNull((await NewDevice(laptop).LoginAsync(Password)).Data!["accessToken"]);
    }

    [Fact]
    public async Task An_organization_can_require_it_and_only_its_owners_and_admins_change_it()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olga Owner");
        await owner.CreateOrgAsync("Fictional Freight Co");
        await owner.UpgradeAsync("PRO");
        var member = await owner.AddMemberAsync(factory, ProjectManagement.Domain.Enums.TenantRole.Member, "Milo Member");
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Put("/api/v1/workspace/session-policy", new { singleActiveSession = true })).Status);
        var set = await owner.Put("/api/v1/workspace/session-policy", new { singleActiveSession = true });
        Assert.True(set.Ok, set.ToString());
        Assert.True(Audited(owner.UserId, "org.single_session_changed") || factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Any(a => a.Action == "org.single_session_changed" && a.TenantId == owner.WorkspaceId)));

        var policy = (await member.Get("/api/v1/me/session-policy")).Data!;
        Assert.False(policy["singleSession"]!.GetValue<bool>());
        Assert.True(policy["effective"]!.GetValue<bool>());
        Assert.Contains("Fictional Freight Co", policy["requiredBy"]!.AsArray().Select(x => x!.GetValue<string>()));
        await AskAsync(NewDevice(member));
    }

    [Theory]
    [InlineData("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36", null, "web", "Chrome on Windows")]
    [InlineData("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 ProjectTrackerDesktop/1.4.0", null, "desktop", "Desktop app on Windows")]
    [InlineData("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36 ProjectTrackerApp", null, "phone", "Android app")]
    [InlineData("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17 Mobile/15E148 Safari/604.1", null, "phone", "Safari on iOS")]
    [InlineData("Mozilla/5.0 AppleWebKit/537.36 Chrome/126.0 Safari/537.36", "\"Chrome OS\"", "web", "Chrome on Chrome OS")]
    public void A_device_is_described_the_way_a_person_would_say_it(string ua, string? platform, string app, string expected)
    {
        Assert.Equal(app, SessionDevice.App(ua, false));
        Assert.Equal(expected, SessionDevice.Describe(ua, platform, app));
    }

    [Fact]
    public void The_place_is_approximate_and_never_looked_up_elsewhere()
    {
        var hints = new SignInClient { TimeZone = "America/New_York", Country = "IN", City = "Hyderabad" };
        Assert.Equal("Local network", SessionDevice.Location("10.1.2.3", hints, trustProxy: true));
        Assert.Equal("Hyderabad, India", SessionDevice.Location("198.51.100.7", hints, trustProxy: true));
        Assert.Equal("New York region", SessionDevice.Location("198.51.100.7", hints, trustProxy: false));   // proxy headers are ignored unless trusted
        Assert.Null(SessionDevice.Location("198.51.100.7", new SignInClient(), trustProxy: false));
    }

    [Fact]
    public void Approval_tokens_are_signed_and_expire()
    {
        var key = new byte[32]; Random.Shared.NextBytes(key);
        Guid id = Guid.NewGuid(), user = Guid.NewGuid(); var now = DateTime.UtcNow;
        var t = ApprovalTokens.Decision(key, id, user, now.AddMinutes(2));
        Assert.True(ApprovalTokens.CheckDecision(key, t, id, user, now));
        Assert.False(ApprovalTokens.CheckDecision(key, t, id, user, now.AddMinutes(3)));
        Assert.False(ApprovalTokens.CheckDecision(key, t, Guid.NewGuid(), user, now));
        Assert.False(ApprovalTokens.CheckDecision(new byte[32], t, id, user, now));
        var e = ApprovalTokens.Email(key, id, "nonce123");
        Assert.Equal(id, ApprovalTokens.ReadEmail(key, e)?.Id);
        Assert.Equal("nonce123", ApprovalTokens.ReadEmail(key, e)?.Nonce);
        Assert.Null(ApprovalTokens.ReadEmail(key, e.Replace("nonce123", "nonce124")));
    }
}
