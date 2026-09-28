using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The organization chart: roles as a tree, people placed on roles, who reports to whom, soft delete + restore.</summary>
[Collection("api")]
public class OrgChartTests(ApiFactory factory)
{
    private static async Task<JsonNode> Structure(TestClient c)
    {
        var res = await c.Get("/api/v1/org");
        Assert.True(res.Ok, res.ToString());
        return res.Data!;
    }

    private static JsonNode? Role(JsonNode structure, string name) =>
        structure["roles"]!.AsArray().FirstOrDefault(r => r!["name"]!.GetValue<string>() == name);

    private static Guid RoleId(JsonNode structure, string name) => Guid.Parse(Role(structure, name)!["id"]!.GetValue<string>());

    private static JsonNode Person(JsonNode structure, Guid userId) =>
        structure["people"]!.AsArray().First(p => p!["userId"]!.GetValue<string>() == userId.ToString())!;

    private static async Task<Guid> NewRole(TestClient c, string name, Guid? parent = null)
    {
        var res = await c.Post("/api/v1/org/roles", new { name, parentRoleId = parent });
        Assert.Equal(HttpStatusCode.Created, res.Status);
        return Guid.Parse(res.Data!["id"]!.GetValue<string>());
    }

    private static Task<ApiResult> Move(TestClient c, Guid role, Guid? parent) =>
        c.Send(HttpMethod.Patch, $"/api/v1/org/roles/{role}/parent", new { parentRoleId = parent });

    private static Task<ApiResult> Assign(TestClient c, Guid user, Guid? role) =>
        c.Put($"/api/v1/org/members/{user}/role", new { roleId = role });

    private static Task<ApiResult> ReportsTo(TestClient c, Guid user, Guid? boss) =>
        c.Put($"/api/v1/org/members/{user}/reports-to", new { reportsToUserId = boss });

    /// <summary>A fresh organization on a plan with room for several members.</summary>
    private async Task<(TestClient Owner, Guid OrgId)> NewOrg(string? name = null)
    {
        var owner = await TestClient.RegisterAsync(factory);
        var org = await owner.CreateOrgAsync(name);
        await owner.UpgradeAsync("BUSINESS");
        return (owner, org);
    }

    [Fact]
    public async Task The_starter_template_builds_the_tree_and_is_safe_to_apply_twice()
    {
        var (owner, _) = await NewOrg();

        var first = await owner.Post("/api/v1/org/template", new { template = "software" });
        Assert.True(first.Ok, first.ToString());
        Assert.Equal(11, first.Data!["created"]!.GetValue<int>());
        Assert.Equal(0, (await owner.Post("/api/v1/org/template", new { template = "software" })).Data!["created"]!.GetValue<int>());

        var s = await Structure(owner);
        Assert.True(s["canManage"]!.GetValue<bool>());
        Assert.Equal(11, s["roles"]!.AsArray().Count);
        Assert.Null(Role(s, "CTO")!["parentRoleId"]);
        Assert.Equal(RoleId(s, "CTO").ToString(), Role(s, "Principal Manager")!["parentRoleId"]!.GetValue<string>());
        Assert.Equal(RoleId(s, "Project Lead").ToString(), Role(s, "Developer")!["parentRoleId"]!.GetValue<string>());
        Assert.Equal(RoleId(s, "Project Lead").ToString(), Role(s, "Tester (QA)")!["parentRoleId"]!.GetValue<string>());
        Assert.Equal(4, Role(s, "Principal Manager")!["childCount"]!.GetValue<int>());

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post("/api/v1/org/template", new { template = "nope" })).Status);
    }

    [Fact]
    public async Task Roles_can_be_added_edited_and_reconnected_but_never_into_a_loop()
    {
        var (c, _) = await NewOrg();
        var cto = await NewRole(c, "CTO");
        var lead = await NewRole(c, "Lead", cto);
        var dev = await NewRole(c, "Dev", lead);

        // Validation and uniqueness (case-insensitive).
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post("/api/v1/org/roles", new { name = "x" })).Status);
        var dup = await c.Post("/api/v1/org/roles", new { name = "cto" });
        Assert.Equal(HttpStatusCode.Conflict, dup.Status);
        Assert.Equal("ROLE_NAME_EXISTS", dup.ErrorCode);

        // Edit.
        var edit = await c.Put($"/api/v1/org/roles/{lead}", new { name = "Team Lead", description = "Leads a team", color = "#34d399" });
        Assert.True(edit.Ok, edit.ToString());
        var s = await Structure(c);
        Assert.Equal("Leads a team", Role(s, "Team Lead")!["description"]!.GetValue<string>());
        Assert.Equal("#34d399", Role(s, "Team Lead")!["color"]!.GetValue<string>());
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Put($"/api/v1/org/roles/{lead}", new { name = "Bad", color = "purple" })).Status);

        // Reconnect Dev directly under CTO, then back to root.
        Assert.True((await Move(c, dev, cto)).Ok);
        Assert.Equal(cto.ToString(), Role(await Structure(c), "Dev")!["parentRoleId"]!.GetValue<string>());
        Assert.True((await Move(c, dev, null)).Ok);
        Assert.Null(Role(await Structure(c), "Dev")!["parentRoleId"]);

        // Loops are rejected: under itself, under its own child, under its own grandchild.
        Assert.Equal("ORG_CYCLE", (await Move(c, cto, cto)).ErrorCode);
        Assert.Equal("ORG_CYCLE", (await Move(c, cto, lead)).ErrorCode);
        await Move(c, dev, lead);
        var deep = await Move(c, cto, dev);
        Assert.Equal(HttpStatusCode.Conflict, deep.Status);
        Assert.Equal("ORG_CYCLE", deep.ErrorCode);
        Assert.Equal(HttpStatusCode.NotFound, (await Move(c, dev, Guid.NewGuid())).Status);
    }

    [Fact]
    public async Task People_are_placed_on_roles_and_reporting_loops_are_rejected()
    {
        var (owner, _) = await NewOrg();
        var a = await owner.AddMemberAsync(factory, TenantRole.Member, "Ann");
        var b = await owner.AddMemberAsync(factory, TenantRole.Member, "Bob");
        var role = await NewRole(owner, "Developer");

        Assert.Equal(HttpStatusCode.NoContent, (await Assign(owner, a.UserId, role)).Status);
        var s = await Structure(owner);
        Assert.Equal(1, Role(s, "Developer")!["peopleCount"]!.GetValue<int>());
        Assert.Equal(role.ToString(), Person(s, a.UserId)["roleId"]!.GetValue<string>());
        Assert.Equal(HttpStatusCode.NotFound, (await Assign(owner, a.UserId, Guid.NewGuid())).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await Assign(owner, Guid.NewGuid(), role)).Status);

        // reports-to: Ann -> Owner, Bob -> Ann; then Owner -> Bob / Owner -> Ann would close a loop; self is rejected.
        Assert.Equal(HttpStatusCode.NoContent, (await ReportsTo(owner, a.UserId, owner.UserId)).Status);
        Assert.Equal(HttpStatusCode.NoContent, (await ReportsTo(owner, b.UserId, a.UserId)).Status);
        Assert.Equal("ORG_CYCLE", (await ReportsTo(owner, owner.UserId, b.UserId)).ErrorCode);
        Assert.Equal("ORG_CYCLE", (await ReportsTo(owner, a.UserId, a.UserId)).ErrorCode);
        Assert.Equal("ORG_CYCLE", (await ReportsTo(owner, owner.UserId, a.UserId)).ErrorCode);
        Assert.Equal(a.UserId.ToString(), Person(await Structure(owner), b.UserId)["reportsToUserId"]!.GetValue<string>());

        // Clearing works too.
        Assert.Equal(HttpStatusCode.NoContent, (await ReportsTo(owner, b.UserId, null)).Status);
        Assert.Equal(HttpStatusCode.NoContent, (await Assign(owner, a.UserId, null)).Status);
        Assert.Equal(0, Role(await Structure(owner), "Developer")!["peopleCount"]!.GetValue<int>());
    }

    [Fact]
    public async Task Deleting_a_role_is_soft_moves_people_and_sub_roles_and_can_be_restored()
    {
        var (c, _) = await NewOrg();
        var m = await c.AddMemberAsync(factory, TenantRole.Member, "Dee");
        var cto = await NewRole(c, "CTO");
        var lead = await NewRole(c, "Lead", cto);
        var dev = await NewRole(c, "Developer", lead);
        var qa = await NewRole(c, "QA", lead);
        await Assign(c, m.UserId, lead);

        // Default: people and sub-roles move up to the deleted role's parent.
        var del = await c.Delete($"/api/v1/org/roles/{lead}");
        Assert.True(del.Ok, del.ToString());
        Assert.Equal(1, del.Data!["movedPeople"]!.GetValue<int>());
        Assert.Equal(2, del.Data["movedRoles"]!.GetValue<int>());

        var s = await Structure(c);
        var gone = Role(s, "Lead")!;
        Assert.True(gone["isDeleted"]!.GetValue<bool>());
        Assert.NotNull(gone["deletedAt"]);
        Assert.Equal(cto.ToString(), Role(s, "Developer")!["parentRoleId"]!.GetValue<string>());
        Assert.Equal(cto.ToString(), Role(s, "QA")!["parentRoleId"]!.GetValue<string>());
        Assert.Equal(cto.ToString(), Person(s, m.UserId)["roleId"]!.GetValue<string>());

        // The row is retained in the database, flagged as deleted.
        Assert.True(factory.WithDb(db => db.OrgRoles.IgnoreQueryFilters().Any(r => r.Id == lead && r.IsDeleted)));

        // A deleted role cannot be edited or used, and can only be restored.
        Assert.Equal(HttpStatusCode.NotFound, (await c.Put($"/api/v1/org/roles/{lead}", new { name = "Lead 2" })).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await Assign(c, m.UserId, lead)).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await Move(c, dev, lead)).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await c.Delete($"/api/v1/org/roles/{lead}")).Status);

        // Restore puts it back under the previous parent. People and sub-roles that were moved stay where they are.
        var restored = await c.Post($"/api/v1/org/roles/{lead}/restore");
        Assert.True(restored.Ok, restored.ToString());
        s = await Structure(c);
        Assert.False(Role(s, "Lead")!["isDeleted"]!.GetValue<bool>());
        Assert.Equal(cto.ToString(), Role(s, "Lead")!["parentRoleId"]!.GetValue<string>());
        Assert.Equal(cto.ToString(), Role(s, "Developer")!["parentRoleId"]!.GetValue<string>());
        Assert.Equal("NOT_DELETED", (await c.Post($"/api/v1/org/roles/{lead}/restore")).ErrorCode);

        // Deleting with an explicit destination, and never into the role's own subtree.
        await Move(c, dev, lead);
        await Move(c, qa, lead);
        Assert.Equal("ORG_CYCLE", (await c.Delete($"/api/v1/org/roles/{lead}?moveTo={dev}")).ErrorCode);
        var other = await NewRole(c, "Ops");
        await Assign(c, m.UserId, lead);
        var moved = await c.Delete($"/api/v1/org/roles/{lead}?moveTo={other}");
        Assert.Equal(1, moved.Data!["movedPeople"]!.GetValue<int>());
        s = await Structure(c);
        Assert.Equal(other.ToString(), Role(s, "Developer")!["parentRoleId"]!.GetValue<string>());
        Assert.Equal(other.ToString(), Person(s, m.UserId)["roleId"]!.GetValue<string>());

        // Restoring falls back to a root role when the old parent is gone, and refuses a duplicate active name.
        await c.Delete($"/api/v1/org/roles/{cto}");
        await NewRole(c, "CTO"); // the name is free again while the original is deleted
        Assert.Equal("ROLE_NAME_EXISTS", (await c.Post($"/api/v1/org/roles/{cto}/restore")).ErrorCode);
        var back = await c.Post($"/api/v1/org/roles/{lead}/restore");
        Assert.True(back.Ok, back.ToString());
        Assert.Null(back.Data!["parentRoleId"]);
    }

    [Fact]
    public async Task Everyone_but_guests_can_read_the_chart_and_only_org_admins_can_change_it()
    {
        var (owner, _) = await NewOrg();
        var role = await NewRole(owner, "Boss");
        var admin = await owner.AddMemberAsync(factory, TenantRole.Admin, "Adam");
        var manager = await owner.AddMemberAsync(factory, TenantRole.Manager, "Mia");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Max");
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gus");

        Assert.True((await Structure(admin))["canManage"]!.GetValue<bool>());
        Assert.False((await Structure(manager))["canManage"]!.GetValue<bool>());
        Assert.False((await Structure(member))["canManage"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.Forbidden, (await guest.Get("/api/v1/org")).Status);

        foreach (var denied in new[] { manager, member, guest })
        {
            Assert.Equal(HttpStatusCode.Forbidden, (await denied.Post("/api/v1/org/roles", new { name = "Sneaky" })).Status);
            Assert.Equal(HttpStatusCode.Forbidden, (await Move(denied, role, null)).Status);
            Assert.Equal(HttpStatusCode.Forbidden, (await Assign(denied, denied.UserId, role)).Status);
            Assert.Equal(HttpStatusCode.Forbidden, (await ReportsTo(denied, denied.UserId, owner.UserId)).Status);
            Assert.Equal(HttpStatusCode.Forbidden, (await denied.Delete($"/api/v1/org/roles/{role}")).Status);
            Assert.Equal(HttpStatusCode.Forbidden, (await denied.Post("/api/v1/org/template", new { template = "software" })).Status);
        }
        Assert.Single((await Structure(owner))["roles"]!.AsArray());

        var byAdmin = await admin.Post("/api/v1/org/roles", new { name = "Made by admin" });
        Assert.Equal(HttpStatusCode.Created, byAdmin.Status);
    }

    [Fact]
    public async Task Personal_workspaces_have_no_chart()
    {
        var c = await TestClient.RegisterAsync(factory);
        var res = await c.Get("/api/v1/org");
        Assert.Equal(HttpStatusCode.Forbidden, res.Status);
        Assert.Equal("PERSONAL_WORKSPACE", res.ErrorCode);
    }

    [Fact]
    public async Task Charts_are_isolated_between_organizations()
    {
        var a = await TestClient.RegisterAsync(factory);
        await a.CreateOrgAsync("Alpha Org");
        var aRole = await NewRole(a, "Alpha CTO");

        var b = await TestClient.RegisterAsync(factory);
        await b.CreateOrgAsync("Beta Org");
        await NewRole(b, "Beta CTO");

        var s = await Structure(b);
        Assert.Null(Role(s, "Alpha CTO"));
        Assert.Single(s["roles"]!.AsArray());

        // Another tenant's role id behaves as if it does not exist, for every operation.
        Assert.Equal(HttpStatusCode.NotFound, (await b.Put($"/api/v1/org/roles/{aRole}", new { name = "Hijack" })).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await b.Delete($"/api/v1/org/roles/{aRole}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await b.Post($"/api/v1/org/roles/{aRole}/restore")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await Assign(b, b.UserId, aRole)).Status);
        var bRole = RoleId(await Structure(b), "Beta CTO");
        Assert.Equal(HttpStatusCode.NotFound, (await Move(b, bRole, aRole)).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await ReportsTo(b, b.UserId, a.UserId)).Status);
        Assert.Equal("Alpha CTO", Role(await Structure(a), "Alpha CTO")!["name"]!.GetValue<string>());
    }

    [Fact]
    public async Task Positions_are_saved_and_cleared_and_leavers_hand_their_reports_to_their_manager()
    {
        var (owner, _) = await NewOrg();
        var role = await NewRole(owner, "Boss");

        var save = await owner.Put("/api/v1/org/layout", new { items = new[] { new { id = role, x = (double?)120.5, y = (double?)300.0 } } });
        Assert.Equal(HttpStatusCode.NoContent, save.Status);
        var r = Role(await Structure(owner), "Boss")!;
        Assert.Equal(120.5, r["posX"]!.GetValue<double>());
        Assert.Equal(300.0, r["posY"]!.GetValue<double>());
        await owner.Put("/api/v1/org/layout", new { items = new[] { new { id = role, x = (double?)null, y = (double?)null } } });
        Assert.Null(Role(await Structure(owner), "Boss")!["posX"]);

        // owner <- lead <- dev. When the lead leaves, dev reports to the owner.
        var lead = await owner.AddMemberAsync(factory, TenantRole.Member, "Lena");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Dan");
        await ReportsTo(owner, lead.UserId, owner.UserId);
        await ReportsTo(owner, dev.UserId, lead.UserId);
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Delete($"/api/v1/workspace/members/{lead.UserId}")).Status);
        Assert.Equal(owner.UserId.ToString(), Person(await Structure(owner), dev.UserId)["reportsToUserId"]!.GetValue<string>());
    }

    [Fact]
    public async Task Structure_changes_are_written_to_the_audit_log()
    {
        var (c, org) = await NewOrg();
        var a = await NewRole(c, "Alpha");
        var b = await NewRole(c, "Beta");
        await c.Put($"/api/v1/org/roles/{a}", new { name = "Alpha 2" });
        await Move(c, b, a);
        await c.Delete($"/api/v1/org/roles/{b}");
        await c.Post($"/api/v1/org/roles/{b}/restore");
        await Assign(c, c.UserId, a);

        var actions = factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Where(x => x.TenantId == org && x.Action.StartsWith("org.")).Select(x => x.Action).ToList());
        foreach (var expected in new[] { "org.role_created", "org.role_updated", "org.role_moved", "org.role_deleted", "org.role_restored", "org.member_role_assigned" })
            Assert.Contains(expected, actions);
    }
}
