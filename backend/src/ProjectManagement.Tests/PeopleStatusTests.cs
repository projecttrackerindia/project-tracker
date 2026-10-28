using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>People &amp; Roles: suspending and reactivating members, what a suspended member can still reach, pickers, and the impact dry run.</summary>
[Collection("api")]
public class PeopleStatusTests(ApiFactory factory)
{
    private async Task<TestClient> Owner()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        await c.UpgradeAsync("PRO");
        return c;
    }

    private static JsonNode? Row(JsonNode list, Guid userId) =>
        list.AsArray().FirstOrDefault(m => m!["userId"]!.GetValue<string>() == userId.ToString());

    [Fact]
    public async Task A_suspended_member_is_refused_with_a_clear_code_and_comes_back_when_reactivated()
    {
        var owner = await Owner();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Suspend Me");
        Assert.True((await member.Get("/api/v1/projects")).Ok);

        var res = await owner.Post($"/api/v1/workspace/members/{member.UserId}/suspend");
        Assert.True(res.Ok, res.ToString());
        Assert.Equal("Suspended", res.Data!["status"]!.GetValue<string>());

        // The token they still hold no longer opens the workspace (their session here was ended, or the membership is refused).
        var old = await member.Get("/api/v1/projects");
        Assert.True(old.Status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden, old.ToString());

        // Signing in again does not help: any request into this workspace is refused with MEMBER_SUSPENDED.
        Assert.True((await member.LoginAsync()).Ok);
        var sw = await member.Post($"/api/v1/workspaces/{owner.WorkspaceId}/switch");
        if (sw.Ok) member.Token = sw.Data!["accessToken"]!.GetValue<string>();
        var blocked = await member.Get("/api/v1/projects");
        Assert.Equal(HttpStatusCode.Forbidden, blocked.Status);
        if (sw.Ok) Assert.Equal("MEMBER_SUSPENDED", blocked.ErrorCode);
        var me = (await member.Get("/api/v1/me")).Data!;
        if (sw.Ok) Assert.Equal("MEMBER_SUSPENDED", me["blocked"]?["code"]?.GetValue<string>());

        // Still listed (history stays), with their status; pickers leave them out.
        var all = (await owner.Get("/api/v1/workspace/members")).Data!;
        var row = Row(all, member.UserId)!;
        Assert.Equal("Suspended", row["status"]!.GetValue<string>());
        Assert.False(row["isActive"]!.GetValue<bool>());
        Assert.Null(Row((await owner.Get("/api/v1/workspace/members?assignable=true")).Data!, member.UserId));
        Assert.NotNull(Row((await owner.Get("/api/v1/workspace/members?assignable=true")).Data!, owner.UserId));
        var profile = (await owner.Get($"/api/v1/workspace/members/{member.UserId}/profile")).Data!;
        Assert.Equal("Suspended", profile["status"]!.GetValue<string>());
        Assert.False(profile["canMessage"]!.GetValue<bool>());

        Assert.True((await owner.Post($"/api/v1/workspace/members/{member.UserId}/reactivate")).Ok);
        Assert.True((await member.LoginAsync()).Ok);
        await member.SwitchToAsync(owner.WorkspaceId);
        Assert.True((await member.Get("/api/v1/projects")).Ok);
        Assert.Equal("Active", Row((await owner.Get("/api/v1/workspace/members")).Data!, member.UserId)!["status"]!.GetValue<string>());
        Assert.NotNull(Row((await owner.Get("/api/v1/workspace/members?assignable=true")).Data!, member.UserId));
    }

    [Fact]
    public async Task Suspension_follows_the_same_level_rules_as_removal()
    {
        var owner = await Owner();
        var admin = await owner.AddMemberAsync(factory, TenantRole.Admin, "Admin A");
        var admin2 = await owner.AddMemberAsync(factory, TenantRole.Admin, "Admin B");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Plain member");

        // Members cannot suspend anyone.
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Post($"/api/v1/workspace/members/{admin.UserId}/suspend")).Status);
        // Nobody suspends the Owner, and an Admin cannot suspend another Admin (equal level) or themselves.
        var ownerTry = await admin.Post($"/api/v1/workspace/members/{owner.UserId}/suspend");
        Assert.Equal(HttpStatusCode.Forbidden, ownerTry.Status);
        Assert.Equal("OWNER_PROTECTED", ownerTry.ErrorCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await admin.Post($"/api/v1/workspace/members/{admin2.UserId}/suspend")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await admin.Post($"/api/v1/workspace/members/{admin.UserId}/suspend")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.Post($"/api/v1/workspace/members/{owner.UserId}/suspend")).Status);
        // An Admin can suspend and reactivate a Member; the Owner can suspend an Admin.
        Assert.True((await admin.Post($"/api/v1/workspace/members/{member.UserId}/suspend")).Ok);
        Assert.True((await admin.Post($"/api/v1/workspace/members/{member.UserId}/reactivate")).Ok);
        Assert.True((await owner.Post($"/api/v1/workspace/members/{admin2.UserId}/suspend")).Ok);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Post($"/api/v1/workspace/members/{Guid.NewGuid()}/suspend")).Status);
    }

    [Fact]
    public async Task The_last_active_owner_or_admin_capability_cannot_be_suspended_or_demoted_away()
    {
        var owner = await Owner();
        var admin = await owner.AddMemberAsync(factory, TenantRole.Admin, "Only admin");
        // The Owner is always there and can never be suspended, so suspending the Admin is fine...
        Assert.True((await owner.Post($"/api/v1/workspace/members/{admin.UserId}/suspend")).Ok);
        // ...and the dry run says plainly that the Owner can be neither suspended nor demoted.
        var ownerSuspend = (await owner.Post("/api/v1/workspace/people/impact", new { kind = "suspend", userId = owner.UserId })).Data!;
        Assert.True(ownerSuspend["blocked"]!.GetValue<bool>());
        var ownerDemote = (await owner.Post("/api/v1/workspace/people/impact", new { kind = "accessLevel", userId = owner.UserId, role = "Member" })).Data!;
        Assert.True(ownerDemote["blocked"]!.GetValue<bool>());
        // Demoting an Admin while the Owner stays active is allowed.
        Assert.True((await owner.Post($"/api/v1/workspace/members/{admin.UserId}/reactivate")).Ok);
        var demote = (await owner.Post("/api/v1/workspace/people/impact", new { kind = "accessLevel", userId = admin.UserId, role = "Member" })).Data!;
        Assert.False(demote["blocked"]!.GetValue<bool>());
        Assert.NotEmpty(demote["people"]![0]!["lost"]!.AsArray());
    }

    [Fact]
    public async Task The_impact_dry_run_shows_who_gains_and_loses_what_and_saves_nothing()
    {
        var owner = await Owner();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Role holder");
        var role = await owner.Post("/api/v1/org/roles", new { name = "Analyst" });
        Assert.True(role.Ok, role.ToString());
        var roleId = role.Data!["id"]!.GetValue<string>();
        Assert.True((await owner.Put($"/api/v1/org/members/{member.UserId}/role", new { roleId })).Ok);

        // Taking Documents and Projects away from the role: the holder loses them.
        var preview = await owner.Post("/api/v1/workspace/people/impact", new { kind = "roleAccess", roleId, modules = new Dictionary<string, int> { ["projects"] = 0, ["documents"] = 0 } });
        Assert.True(preview.Ok, preview.ToString());
        var person = preview.Data!["people"]!.AsArray().Single()!;
        Assert.Equal(member.UserId.ToString(), person["userId"]!.GetValue<string>());
        Assert.Contains(person["modules"]!.AsArray(), m => m!["module"]!.GetValue<string>() == "projects" && m["to"]!.GetValue<int>() == 0 && m["from"]!.GetValue<int>() > 0);

        // Nothing was saved: the member still opens projects.
        Assert.True((await member.Get("/api/v1/projects")).Ok);

        // Suspending: they lose the workspace.
        var suspend = (await owner.Post("/api/v1/workspace/people/impact", new { kind = "suspend", userId = member.UserId })).Data!;
        Assert.True(suspend["people"]![0]!["losesWorkspace"]!.GetValue<bool>());
        Assert.Equal("Active", Row((await owner.Get("/api/v1/workspace/members")).Data!, member.UserId)!["status"]!.GetValue<string>());

        // Only people who could make the change may preview it.
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Post("/api/v1/workspace/people/impact", new { kind = "suspend", userId = owner.UserId })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post("/api/v1/workspace/people/impact", new { kind = "nonsense", userId = member.UserId })).Status);
    }
}
