using System.Net;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The optional trust policies an organization owner turns on: two-step verification for admins or everyone with a grace period, and the
/// IP allowlist's lockout protection (an Owner signed in with a real second factor always has a way back in). Everything is off by default.
/// </summary>
[Collection("api")]
public class TrustPolicyTests(ApiFactory factory)
{
    private static void SetMfa(ApiFactory f, Guid userId, bool enabled) =>
        f.WithDb(db => { db.Users.Where(u => u.Id == userId).ExecuteUpdate(s => s.SetProperty(u => u.MfaEnabled, enabled)); return 0; });

    private static void SetSignInMethod(ApiFactory f, Guid userId, string method) =>
        f.WithDb(db => { db.UserSessions.Where(s => s.UserId == userId).ExecuteUpdate(s => s.SetProperty(x => x.AuthMethod, method)); return 0; });

    private static async Task<TestClient> BusinessOwnerAsync(ApiFactory f, string ip = "203.0.113.5")
    {
        var owner = await TestClient.RegisterAsync(f);
        owner.Ip = ip;
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        SetMfa(f, owner.UserId, true);
        return owner;
    }

    [Fact]
    public async Task Every_trust_policy_is_off_by_default_with_the_owner_way_back_on()
    {
        var owner = await BusinessOwnerAsync(factory);
        var got = (await owner.Get("/api/v1/workspace/security")).Data!;
        Assert.False(got["requireMfa"]!.GetValue<bool>());
        Assert.Equal("all", got["mfaScope"]!.GetValue<string>());
        Assert.Null(got["mfaGraceUntil"]);
        Assert.False(got["ipAllowlistEnabled"]!.GetValue<bool>());
        Assert.True(got["ipOwnerBypass"]!.GetValue<bool>());
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Member");
        Assert.NotNull((await member.Get("/api/v1/me")).Data!["current"]);
    }

    [Fact]
    public async Task Two_step_for_admins_only_leaves_members_in_and_blocks_an_admin_without_it()
    {
        var owner = await BusinessOwnerAsync(factory);
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Member");
        var admin = await owner.AddMemberAsync(factory, TenantRole.Admin, "Admin");
        var preview = (await owner.Get("/api/v1/workspace/security")).Data!;
        Assert.True(preview["membersWithoutTwoStep"]!.GetValue<int>() >= 2);

        var set = await owner.Put("/api/v1/workspace/security", new { requireMfa = true, ipAllowlistEnabled = false, mfaScope = "admins" });
        Assert.True(set.Ok, set.ToString());
        Assert.Equal("admins", set.Data!["mfaScope"]!.GetValue<string>());

        Assert.NotNull((await member.Get("/api/v1/me")).Data!["current"]);
        var blocked = await admin.Get("/api/v1/me");
        Assert.Null(blocked.Data!["current"]);
        Assert.Equal("ORG_MFA_REQUIRED", blocked.Data["blocked"]!["code"]!.GetValue<string>());

        // The admin who has to act is told, once.
        Assert.Equal(1, factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Count(n => n.UserId == admin.UserId && n.DedupeKey != null && n.DedupeKey.StartsWith("org-mfa-required:"))));
        Assert.Equal(0, factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Count(n => n.UserId == member.UserId && n.DedupeKey != null && n.DedupeKey.StartsWith("org-mfa-required:"))));

        var bad = await owner.Put("/api/v1/workspace/security", new { requireMfa = true, ipAllowlistEnabled = false, mfaScope = "everyone-ish" });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, bad.Status);
    }

    [Fact]
    public async Task During_the_grace_period_nobody_is_blocked_and_after_it_the_rule_applies()
    {
        var owner = await BusinessOwnerAsync(factory);
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Member");
        var set = await owner.Put("/api/v1/workspace/security", new { requireMfa = true, ipAllowlistEnabled = false, mfaGraceDays = 7 });
        Assert.True(set.Ok, set.ToString());
        Assert.NotNull(set.Data!["mfaGraceUntil"]);
        Assert.NotNull((await member.Get("/api/v1/me")).Data!["current"]);   // still in, reminded

        var tenant = owner.WorkspaceId;
        factory.WithDb(db => { db.TenantSecuritySettings.IgnoreQueryFilters().Where(s => s.TenantId == tenant).ExecuteUpdate(s => s.SetProperty(x => x.MfaGraceUntil, DateTime.UtcNow.AddMinutes(-1))); return 0; });
        var after = await member.Get("/api/v1/me");
        Assert.Null(after.Data!["current"]);
        Assert.Equal("ORG_MFA_REQUIRED", after.Data["blocked"]!["code"]!.GetValue<string>());

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put("/api/v1/workspace/security", new { requireMfa = true, ipAllowlistEnabled = false, mfaGraceDays = 90 })).Status);
        // Turning the rule off clears the grace period.
        var off = await owner.Put("/api/v1/workspace/security", new { requireMfa = false, ipAllowlistEnabled = false });
        Assert.Null(off.Data!["mfaGraceUntil"]);
        Assert.NotNull((await member.Get("/api/v1/me")).Data!["current"]);
    }

    [Fact]
    public async Task An_owner_signed_in_with_two_step_is_never_locked_out_by_the_ip_allowlist_but_others_are()
    {
        var owner = await BusinessOwnerAsync(factory);
        var admin = await owner.AddMemberAsync(factory, TenantRole.Admin, "Admin");
        SetMfa(factory, admin.UserId, true);
        Assert.True((await owner.Put("/api/v1/workspace/security", new { requireMfa = false, ipAllowlistEnabled = true, ipRanges = new[] { "203.0.113.0/24" } })).Ok);

        owner.Ip = "198.51.100.9"; admin.Ip = "198.51.100.9";
        SetSignInMethod(factory, owner.UserId, "password");   // no second factor in this session: no pass
        Assert.Equal("ORG_IP_BLOCKED", (await owner.Get("/api/v1/me")).Data!["blocked"]!["code"]!.GetValue<string>());

        SetSignInMethod(factory, owner.UserId, "password+mfa");
        Assert.NotNull((await owner.Get("/api/v1/me")).Data!["current"]);   // the owner's way back in

        SetSignInMethod(factory, admin.UserId, "password+mfa");
        Assert.Equal("ORG_IP_BLOCKED", (await admin.Get("/api/v1/me")).Data!["blocked"]!["code"]!.GetValue<string>());   // owners only

        // Turning the way back off is refused while the owner's own address is outside the list (safe mode), allowed from inside it.
        var refused = await owner.Put("/api/v1/workspace/security", new { requireMfa = false, ipAllowlistEnabled = true, ipRanges = new[] { "203.0.113.0/24" }, ipOwnerBypass = false });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, refused.Status);
        owner.Ip = "203.0.113.5";
        Assert.True((await owner.Put("/api/v1/workspace/security", new { requireMfa = false, ipAllowlistEnabled = true, ipRanges = new[] { "203.0.113.0/24" }, ipOwnerBypass = false })).Ok);
        owner.Ip = "198.51.100.9";
        Assert.Equal("ORG_IP_BLOCKED", (await owner.Get("/api/v1/me")).Data!["blocked"]!["code"]!.GetValue<string>());
    }

    [Fact]
    public async Task An_owners_api_key_gets_no_way_back_past_the_ip_allowlist()
    {
        var owner = await BusinessOwnerAsync(factory);
        SetSignInMethod(factory, owner.UserId, "password+mfa");
        Assert.True((await owner.Put("/api/v1/workspace/security", new { requireMfa = false, ipAllowlistEnabled = true, ipRanges = new[] { "203.0.113.0/24" } })).Ok);
        var key = await owner.Post("/api/v1/api-keys", new { name = "ci", scope = "ReadWrite" });
        Assert.True(key.Ok, key.ToString());
        var outside = new TestClient(factory) { Token = key.Data!["secret"]!.GetValue<string>(), Ip = "198.51.100.1" };
        Assert.Equal(HttpStatusCode.Forbidden, (await outside.Get("/api/v1/projects")).Status);
    }
}
