using System.Net;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Common;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The IP allowlist's parsing and matching: no database, no HTTP.</summary>
public class IpAllowlistTests
{
    [Theory]
    [InlineData("203.0.113.9", "203.0.113.9", true)]
    [InlineData("203.0.113.9", "203.0.113.10", false)]
    [InlineData("10.0.0.0/8", "10.4.5.6", true)]
    [InlineData("10.0.0.0/8", "11.0.0.1", false)]
    [InlineData("::1", "::1", true)]
    [InlineData("2001:db8::/32", "2001:db8::5", true)]
    [InlineData("2001:db8::/32", "2001:db9::5", false)]
    public void A_bare_address_or_a_cidr_range_matches_correctly(string entry, string callerIp, bool expected) =>
        Assert.Equal(expected, IpAllowlist.Matches([entry], callerIp));

    [Fact]
    public void An_ipv4_mapped_ipv6_address_matches_its_plain_ipv4_form() =>
        Assert.True(IpAllowlist.Matches(["203.0.113.9"], "::ffff:203.0.113.9"));

    [Fact]
    public void An_unreadable_or_missing_caller_address_never_matches()
    {
        Assert.False(IpAllowlist.Matches(["0.0.0.0/0"], null));
        Assert.False(IpAllowlist.Matches(["0.0.0.0/0"], ""));
        Assert.False(IpAllowlist.Matches(["0.0.0.0/0"], "not-an-ip"));
    }

    [Fact]
    public void Entries_are_split_on_newlines_and_commas_and_deduplicated()
    {
        var parsed = IpAllowlist.ParseEntries(" 203.0.113.9 ,10.0.0.0/8\n203.0.113.9\n\n  10.0.0.0/8 ");
        Assert.Equal(["203.0.113.9", "10.0.0.0/8"], parsed);
    }

    [Theory]
    [InlineData("203.0.113.9", true)]
    [InlineData("10.0.0.0/8", true)]
    [InlineData("::1", true)]
    [InlineData("2001:db8::/32", true)]
    [InlineData("not-an-ip", false)]
    [InlineData("203.0.113.9/40", false)]
    [InlineData("", false)]
    public void Validation_accepts_addresses_and_ranges_and_rejects_everything_else(string entry, bool valid) =>
        Assert.Equal(valid, IpAllowlist.TryValidateEntry(entry, out _));
}

/// <summary>An organization's own access rules on top of the platform's: required two-step verification and an IP allowlist.</summary>
[Collection("api")]
public class OrgSecurityTests(ApiFactory factory)
{
    private static object Settings(bool requireMfa, bool ipEnabled, params string[] ranges) =>
        new { requireMfa, ipAllowlistEnabled = ipEnabled, ipRanges = ranges };

    private static void SetMfa(ApiFactory f, Guid userId, bool enabled) =>
        f.WithDb(db => { db.Users.Where(u => u.Id == userId).ExecuteUpdate(s => s.SetProperty(u => u.MfaEnabled, enabled)); return 0; });

    [Fact]
    public async Task By_default_security_is_off_and_the_feature_needs_a_paid_plan()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();   // Free plan
        var got = (await owner.Get("/api/v1/workspace/security")).Data!;
        Assert.False(got["requireMfa"]!.GetValue<bool>());
        Assert.False(got["ipAllowlistEnabled"]!.GetValue<bool>());
        Assert.False(got["entitled"]!.GetValue<bool>());

        var res = await owner.Put("/api/v1/workspace/security", Settings(true, false));
        Assert.Equal(HttpStatusCode.Forbidden, res.Status);
        Assert.Equal("FEATURE_NOT_AVAILABLE", res.ErrorCode);
    }

    [Fact]
    public async Task Only_owners_and_admins_may_change_it()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Member");
        var res = await member.Put("/api/v1/workspace/security", Settings(false, true, member.Ip ?? "203.0.113.1"));
        Assert.Equal(HttpStatusCode.Forbidden, res.Status);
        Assert.Equal("PERMISSION_DENIED", res.ErrorCode);
    }

    [Fact]
    public async Task Turning_on_required_two_step_verification_needs_your_own_account_to_have_it_first()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");

        var refused = await owner.Put("/api/v1/workspace/security", Settings(true, false));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, refused.Status);
        Assert.Equal("requireMfa", refused.Json!["errors"]![0]!["field"]!.GetValue<string>());

        SetMfa(factory, owner.UserId, true);
        Assert.True((await owner.Put("/api/v1/workspace/security", Settings(true, false))).Ok);
    }

    [Fact]
    public async Task Turning_on_the_ip_allowlist_needs_your_own_address_in_the_list()
    {
        var owner = await TestClient.RegisterAsync(factory);
        owner.Ip = "203.0.113.5";
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");

        var empty = await owner.Put("/api/v1/workspace/security", Settings(false, true));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, empty.Status);
        Assert.Equal("ipRanges", empty.Json!["errors"]![0]!["field"]!.GetValue<string>());

        var wrongAddress = await owner.Put("/api/v1/workspace/security", Settings(false, true, "198.51.100.0/24"));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, wrongAddress.Status);
        Assert.Equal("ipRanges", wrongAddress.Json!["errors"]![0]!["field"]!.GetValue<string>());

        var invalid = await owner.Put("/api/v1/workspace/security", Settings(false, true, "not-an-ip"));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, invalid.Status);

        var ok = await owner.Put("/api/v1/workspace/security", Settings(false, true, "203.0.113.0/24"));
        Assert.True(ok.Ok, ok.ToString());
        var audited = factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Count(a => a.Action == "org.security_changed" && a.TenantId == owner.WorkspaceId));
        Assert.Equal(1, audited);
    }

    [Fact]
    public async Task A_member_without_two_step_verification_is_blocked_once_it_is_required_and_let_back_in_once_they_turn_it_on()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        SetMfa(factory, owner.UserId, true);
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Member");
        Assert.True((await owner.Put("/api/v1/workspace/security", Settings(true, false))).Ok);

        var me = await member.Get("/api/v1/me");
        Assert.True(me.Ok);
        Assert.Null(me.Data!["current"]);
        Assert.Equal("ORG_MFA_REQUIRED", me.Data["blocked"]!["code"]!.GetValue<string>());

        var reSwitch = await member.Post($"/api/v1/workspaces/{member.WorkspaceId}/switch");
        Assert.Equal(HttpStatusCode.Forbidden, reSwitch.Status);
        Assert.Equal("ORG_MFA_REQUIRED", reSwitch.ErrorCode);

        SetMfa(factory, member.UserId, true);
        Assert.NotNull((await member.Get("/api/v1/me")).Data!["current"]);
        Assert.True((await member.Post($"/api/v1/workspaces/{member.WorkspaceId}/switch")).Ok);
    }

    [Fact]
    public async Task A_member_outside_the_allowed_networks_is_blocked_and_let_back_in_from_an_allowed_one()
    {
        var owner = await TestClient.RegisterAsync(factory);
        owner.Ip = "203.0.113.5";
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Member");
        Assert.True((await owner.Put("/api/v1/workspace/security", Settings(false, true, "203.0.113.0/24"))).Ok);

        member.Ip = "198.51.100.1";   // outside the range
        var me = await member.Get("/api/v1/me");
        Assert.Null(me.Data!["current"]);
        Assert.Equal("ORG_IP_BLOCKED", me.Data["blocked"]!["code"]!.GetValue<string>());
        var reSwitch = await member.Post($"/api/v1/workspaces/{member.WorkspaceId}/switch");
        Assert.Equal(HttpStatusCode.Forbidden, reSwitch.Status);
        Assert.Equal("ORG_IP_BLOCKED", reSwitch.ErrorCode);

        member.Ip = "203.0.113.77";   // inside the range
        Assert.NotNull((await member.Get("/api/v1/me")).Data!["current"]);
        Assert.True((await member.Post($"/api/v1/workspaces/{member.WorkspaceId}/switch")).Ok);
    }

    [Fact]
    public async Task Losing_the_plan_that_includes_this_feature_stops_enforcing_it_without_losing_the_settings()
    {
        var owner = await TestClient.RegisterAsync(factory);
        owner.Ip = "203.0.113.5";
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Member") ;
        member.Ip = "198.51.100.1";
        Assert.True((await owner.Put("/api/v1/workspace/security", Settings(false, true, "203.0.113.0/24"))).Ok);
        Assert.Null((await member.Get("/api/v1/me")).Data!["current"]);   // blocked while entitled

        await owner.UpgradeAsync("FREE");   // downgrade away from the feature
        var afterDowngrade = await member.Get("/api/v1/me");
        Assert.NotNull(afterDowngrade.Data!["current"]);   // fails open: never a full lockout from a lapsed plan
        var stillOn = (await owner.Get("/api/v1/workspace/security")).Data!;
        Assert.True(stillOn["ipAllowlistEnabled"]!.GetValue<bool>());   // the setting itself was not silently cleared
        Assert.False(stillOn["entitled"]!.GetValue<bool>());
    }

    [Fact]
    public async Task An_api_key_is_never_asked_for_two_step_verification_but_still_obeys_the_ip_allowlist()
    {
        var owner = await TestClient.RegisterAsync(factory);
        owner.Ip = "203.0.113.5";
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");   // API_ACCESS and ADVANCED_SECURITY both come with Business
        SetMfa(factory, owner.UserId, true);   // needed to turn requireMfa on at all (the self-lockout check), not for the key itself
        var set = await owner.Put("/api/v1/workspace/security", Settings(true, true, "203.0.113.0/24"));
        Assert.True(set.Ok, set.ToString());

        var key = await owner.Post("/api/v1/api-keys", new { name = "ci", scope = "ReadWrite" });
        Assert.True(key.Ok, key.ToString());
        var secret = key.Data!["secret"]!.GetValue<string>();

        var fromAllowed = new TestClient(factory) { Token = secret, Ip = "203.0.113.9" };
        var allowedRes = await fromAllowed.Get("/api/v1/projects");
        Assert.True(allowedRes.Ok, allowedRes.ToString());   // no MFA on a key, and it is in range

        var fromOutside = new TestClient(factory) { Token = secret, Ip = "198.51.100.1" };
        Assert.Equal(HttpStatusCode.Forbidden, (await fromOutside.Get("/api/v1/projects")).Status);
    }
}
