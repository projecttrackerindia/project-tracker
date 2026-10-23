using System.Net;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Account security: breached passwords refused (only a hash prefix leaves the server), the workspace's own sign-in rules, sign-in history
/// with "this wasn't me", and the admin's view of members' security with one-click reminders.
/// </summary>
[Collection("api")]
public class AccountSecurityTests(ApiFactory factory)
{
    [Fact]
    public void A_range_answer_is_read_by_suffix_and_padding_counts_as_not_found()
    {
        const string body = "0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2\r\n011053FD0102E94D6AE2F8B83D76FAF94F6:0";
        Assert.Equal(2, PasswordBreachCheck.Count(body, "00D4F6E8FA6EECAD2A3AA415EEC418D38EC"));
        Assert.Equal(2, PasswordBreachCheck.Count(body, "00d4f6e8fa6eecad2a3aa415eec418d38ec"));
        Assert.Equal(0, PasswordBreachCheck.Count(body, "011053FD0102E94D6AE2F8B83D76FAF94F6"));   // padding
        Assert.Equal(0, PasswordBreachCheck.Count(body, "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"));
    }

    private sealed class FakeKms : HttpMessageHandler
    {
        public List<string> Calls { get; } = [];
        protected override HttpResponseMessage Send(HttpRequestMessage request, CancellationToken ct) => SendAsync(request, ct).GetAwaiter().GetResult();
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls.Add(request.RequestUri!.ToString());
            if (request.RequestUri.Host == "metadata.google.internal")
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"access_token\":\"ya29.test\",\"expires_in\":3599}") });
            Assert.Equal("Bearer ya29.test", request.Headers.Authorization!.ToString());
            var plain = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes("master-key-material-from-kms"));
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"plaintext\":\"" + plain + "\"}") });
        }
    }

    [Fact]
    public void The_master_key_can_be_held_by_cloud_kms()
    {
        var kms = new FakeKms();
        var key = ProjectManagement.Infrastructure.Services.KmsMasterKey.Unwrap("projects/p/locations/asia-south1/keyRings/projecttracker/cryptoKeys/secrets-master", "Y2lwaGVy", kms);
        Assert.Equal("master-key-material-from-kms", key);
        Assert.Contains(kms.Calls, c => c.EndsWith("/cryptoKeys/secrets-master:decrypt", StringComparison.Ordinal));
        Assert.Throws<InvalidOperationException>(() => ProjectManagement.Infrastructure.Services.KmsMasterKey.Unwrap("not-a-key-name", "x", kms));
    }

    [Fact]
    public async Task A_breached_password_is_refused_and_only_five_characters_of_its_hash_are_sent()
    {
        const string breached = "Monsoon-Kitchen-2026";
        factory.Pwned.Breached[breached] = 4521;
        try
        {
            var c = new TestClient(factory) { Email = $"user-{Guid.NewGuid():N}@example.com" };
            var reg = await c.Send(HttpMethod.Post, "/api/v1/auth/register", new { email = c.Email, password = breached, displayName = "Breach Test", acceptedTerms = true }, true);
            Assert.Equal(HttpStatusCode.UnprocessableEntity, reg.Status);
            Assert.Contains("breaches", reg.ToString());
            Assert.All(factory.Pwned.Asked, url => Assert.Matches("/range/[0-9A-F]{5}$", url));
            Assert.DoesNotContain(factory.Pwned.Asked, url => url.Contains(breached));

            var owner = await TestClient.RegisterAsync(factory, "Not Breached");
            var change = await owner.Post("/api/v1/me/password", new { currentPassword = "Passw0rd!x", newPassword = breached });
            Assert.Equal(HttpStatusCode.UnprocessableEntity, change.Status);
            Assert.True((await owner.Post("/api/v1/me/password", new { currentPassword = "Passw0rd!x", newPassword = "Quiet-Orchard-Lantern-58" })).Ok);
            var u = factory.WithDb(db => db.Users.Single(x => x.Id == owner.UserId));
            Assert.Equal(20, u.PasswordLength);   // capped
            Assert.NotNull(u.PasswordChangedAt);
        }
        finally { factory.Pwned.Breached.Clear(); }
    }

    [Fact]
    public async Task Workspace_rules_ask_for_a_longer_password_a_fresh_sign_in_and_allowed_methods_without_locking_the_admin_out()
    {
        var owner = await TestClient.RegisterAsync(factory, "Rule Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Short Password");
        object Rules(int min = 0, int hours = 0, string[]? methods = null) => new { requireMfa = false, ipAllowlistEnabled = false, ipRanges = Array.Empty<string>(), minPasswordLength = min, sessionHours = hours, allowedSignIn = methods };

        // The owner's own password is 10 characters: a 14-character rule would lock them out, so it is refused until they change it.
        var tooStrict = await owner.Put("/api/v1/workspace/security", Rules(14));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, tooStrict.Status);
        Assert.Contains("Your own password", tooStrict.ToString());
        Assert.True((await owner.Post("/api/v1/me/password", new { currentPassword = "Passw0rd!x", newPassword = "Copper-Harbour-Window-91" })).Ok);
        await owner.LoginAsync("Copper-Harbour-Window-91");
        await owner.SwitchToAsync(owner.WorkspaceId);
        var saved = await owner.Put("/api/v1/workspace/security", Rules(14));
        Assert.True(saved.Ok, saved.ToString());
        Assert.Equal(14, saved.Data!["minPasswordLength"]!.GetValue<int>());

        var me = await member.Get("/api/v1/me");
        Assert.Null(me.Data!["current"]);
        Assert.Equal("ORG_PASSWORD_TOO_SHORT", me.Data["blocked"]!["code"]!.GetValue<string>());
        Assert.True((await member.Post("/api/v1/me/password", new { currentPassword = "Passw0rd!x", newPassword = "Saffron-Meadow-Bridge-24" })).Ok);
        await member.LoginAsync("Saffron-Meadow-Bridge-24");
        Assert.True((await member.Post($"/api/v1/workspaces/{owner.WorkspaceId}/switch")).Ok);

        // Only passkeys and single sign-on: refused while the owner signed in with a password.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put("/api/v1/workspace/security", Rules(14, 0, ["passkey", "sso"]))).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put("/api/v1/workspace/security", Rules(14, 0, ["fax"]))).Status);

        // Sign in again every 8 hours: a sign-in older than that is asked to sign in again.
        Assert.True((await owner.Put("/api/v1/workspace/security", Rules(14, 8))).Ok);
        factory.WithDb(db => db.UserSessions.Where(s => s.UserId == member.UserId).ExecuteUpdate(u => u.SetProperty(s => s.CreatedAt, DateTime.UtcNow.AddHours(-9))));
        var stale = await member.Get("/api/v1/me");
        Assert.Equal("ORG_SESSION_EXPIRED", stale.Data!["blocked"]!["code"]!.GetValue<string>());
        await member.LoginAsync("Saffron-Meadow-Bridge-24");
        Assert.True((await member.Post($"/api/v1/workspaces/{owner.WorkspaceId}/switch")).Ok);
    }

    [Fact]
    public async Task Sign_in_history_marks_a_new_browser_and_this_was_not_me_ends_it()
    {
        var me = await TestClient.RegisterAsync(factory, "History Person");
        await me.CreateOrgAsync();
        me.Ip = "203.0.113.20";
        await me.LoginAsync();
        var stranger = new TestClient(factory) { Email = me.Email, Ip = "198.51.100.7" };
        Assert.True((await stranger.LoginAsync()).Ok);

        var history = (await me.Get("/api/v1/me/sign-ins")).Data!.AsArray();
        var strange = history.First(h => h!["network"]?.GetValue<string>() == "198.51.100.x")!;
        Assert.True(strange["newDevice"]!.GetValue<bool>());
        Assert.True(strange["active"]!.GetValue<bool>());
        // Told by email (signing in is not inside a workspace yet).
        var mails = (await me.Send(HttpMethod.Get, "/api/v1/dev/emails", null, true)).Data!.AsArray();
        Assert.Contains(mails, m => m!["to"]!.GetValue<string>().Equals(me.Email, StringComparison.OrdinalIgnoreCase) && (m["text"]?.GetValue<string>() ?? "").Contains("New sign-in to your account"));

        var current = history.First(h => h!["current"]!.GetValue<bool>())!;
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await me.Post($"/api/v1/me/sign-ins/{current["id"]!.GetValue<string>()}/not-me")).Status);
        var reported = await me.Post($"/api/v1/me/sign-ins/{strange["id"]!.GetValue<string>()}/not-me");
        Assert.Equal(HttpStatusCode.NoContent, reported.Status);
        Assert.Equal(HttpStatusCode.Unauthorized, (await stranger.Get("/api/v1/me")).Status);   // ended at once
        var after = (await me.Get("/api/v1/me/sign-ins")).Data!.AsArray().First(h => h!["id"]!.GetValue<string>() == strange["id"]!.GetValue<string>())!;
        Assert.False(after["active"]!.GetValue<bool>());
        Assert.NotNull(after["reportedAt"]);
        Assert.Equal(HttpStatusCode.NotFound, (await me.Post($"/api/v1/me/sign-ins/{Guid.NewGuid()}/not-me")).Status);
    }

    [Fact]
    public async Task Admins_see_who_lacks_two_step_or_has_a_short_password_and_remind_them_once_a_day()
    {
        var owner = await TestClient.RegisterAsync(factory, "Security Admin");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Needs Two Step");
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get("/api/v1/workspace/security/members")).Status);

        var view = (await owner.Get("/api/v1/workspace/security/members")).Data!;
        Assert.Equal(2, view["members"]!.GetValue<int>());
        var row = view["people"]!.AsArray().First(p => p!["userId"]!.GetValue<string>() == member.UserId.ToString())!;
        Assert.Contains("no-two-step", row["issues"]!.AsArray().Select(i => i!.GetValue<string>()));
        Assert.Contains("weak-password", row["issues"]!.AsArray().Select(i => i!.GetValue<string>()));   // 10 characters
        Assert.Equal(10, row["passwordLength"]!.GetValue<int>());
        Assert.DoesNotContain("Passw0rd", view.ToJsonString());

        var sent = await owner.Post("/api/v1/workspace/security/remind", new { userIds = new[] { member.UserId }, topic = "two-step" });
        Assert.Equal(1, sent.Data!["sent"]!.GetValue<int>());
        Assert.Equal(0, (await owner.Post("/api/v1/workspace/security/remind", new { userIds = new[] { member.UserId }, topic = "two-step" })).Data!["sent"]!.GetValue<int>());
        Assert.Contains((await member.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), n => n!["title"]!.GetValue<string>() == "Please turn on two-step verification");
        Assert.NotNull((await owner.Get("/api/v1/workspace/security/members")).Data!["people"]!.AsArray().First(p => p!["userId"]!.GetValue<string>() == member.UserId.ToString())!["remindedAt"]);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post("/api/v1/workspace/security/remind", new { userIds = new[] { member.UserId }, topic = "nothing" })).Status);
    }
}
