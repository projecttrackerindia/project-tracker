using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Project groups: the workspace's master list that every project belongs to, and the rules that keep it usable.</summary>
[Collection("api")]
public class ProjectGroupTests(ApiFactory factory)
{
    private const string Groups = "/api/v1/project-groups";

    private async Task<TestClient> NewOrg()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        return owner;
    }

    private static Guid Id(ApiResult r) => Guid.Parse(r.Data!["id"]!.GetValue<string>());
    private static async Task<JsonArray> List(TestClient c, bool activeOnly = false) => (await c.Get($"{Groups}{(activeOnly ? "?activeOnly=true" : "")}")).Data!.AsArray();
    private static JsonNode Named(JsonArray groups, string name) => groups.First(g => g!["name"]!.GetValue<string>() == name)!;

    private static async Task<ApiResult> NewProject(TestClient c, string name, Guid? group)
    {
        c.AutoProjectGroup = false;   // these tests say exactly which group (or none) the project is created in
        return await c.Post("/api/v1/projects", new { name, priority = "Medium", projectGroupId = group });
    }

    // ------------------------------------------------------------------ the master list and the required field

    [Fact]
    public async Task Every_workspace_starts_with_a_group_and_a_project_cannot_be_created_without_one()
    {
        var owner = await NewOrg();
        var groups = await List(owner);
        Assert.Single(groups);
        Assert.Equal("Other Projects", groups[0]!["name"]!.GetValue<string>());
        Assert.True(groups[0]!["isActive"]!.GetValue<bool>());

        // Nothing chosen: refused, with a message that names the field.
        var none = await NewProject(owner, "Atlas", null);
        Assert.Equal(422, (int)none.Status);
        Assert.Contains("project group", none.Json!["errors"]![0]!["message"]!.GetValue<string>(), StringComparison.OrdinalIgnoreCase);
        Assert.Equal("projectGroupId", none.Json["errors"]![0]!["field"]!.GetValue<string>());
        // A group that does not exist is refused too.
        Assert.Equal(422, (int)(await NewProject(owner, "Atlas", Guid.NewGuid())).Status);

        var ok = await NewProject(owner, "Atlas", Guid.Parse(groups[0]!["id"]!.GetValue<string>()));
        Assert.True(ok.Ok, ok.ToString());
        Assert.Equal("Other Projects", ok.Data!["project"]!["projectGroupName"]!.GetValue<string>());
        Assert.Equal(1, Named(await List(owner), "Other Projects")["projectCount"]!.GetValue<int>());
    }

    [Fact]
    public async Task Groups_can_be_added_edited_and_reordered_and_the_list_shows_how_many_projects_each_holds()
    {
        var owner = await NewOrg();
        var sf = Id(await owner.Post(Groups, new { name = "Salesforce Projects" }));
        var hr = Id(await owner.Post(Groups, new { name = "HRMS", description = "People systems" }));
        Assert.True((await NewProject(owner, "CRM rollout", sf)).Ok);
        Assert.True((await NewProject(owner, "CRM migration", sf)).Ok);
        Assert.True((await NewProject(owner, "Payroll", hr)).Ok);

        var listed = await List(owner);
        Assert.Equal(new[] { "Other Projects", "Salesforce Projects", "HRMS" }, listed.Select(g => g!["name"]!.GetValue<string>()).ToArray());
        Assert.Equal(2, Named(listed, "Salesforce Projects")["projectCount"]!.GetValue<int>());
        Assert.Equal("People systems", Named(listed, "HRMS")["description"]!.GetValue<string>());

        // Rename, then a duplicate name (any case) is refused.
        Assert.True((await owner.Put($"{Groups}/{hr}", new { name = "HR Systems" })).Ok);
        Assert.Equal(422, (int)(await owner.Post(Groups, new { name = "hr systems" })).Status);
        Assert.Equal(422, (int)(await owner.Post(Groups, new { name = "x" })).Status);

        // Reorder: HR first, then Salesforce, then the default.
        var other = Guid.Parse(listed[0]!["id"]!.GetValue<string>());
        var re = await owner.Put($"{Groups}/order", new { groupIds = new[] { hr, sf, other } });
        Assert.True(re.Ok, re.ToString());
        Assert.Equal(new[] { "HR Systems", "Salesforce Projects", "Other Projects" }, (await List(owner)).Select(g => g!["name"]!.GetValue<string>()).ToArray());
        Assert.Equal(422, (int)(await owner.Put($"{Groups}/order", new { groupIds = new[] { hr, sf } })).Status);   // every group exactly once
    }

    // ------------------------------------------------------------------ inactive groups

    [Fact]
    public async Task An_inactive_group_takes_no_new_projects_but_keeps_the_ones_it_has()
    {
        var owner = await NewOrg();
        var other = Guid.Parse((await List(owner))[0]!["id"]!.GetValue<string>());
        var old = Id(await owner.Post(Groups, new { name = "Legacy Systems" }));
        var project = Guid.Parse((await NewProject(owner, "Old CRM", old)).Data!["project"]!["id"]!.GetValue<string>());

        Assert.True((await owner.Put($"{Groups}/{old}", new { isActive = false })).Ok);
        Assert.DoesNotContain(await List(owner, activeOnly: true), g => g!["name"]!.GetValue<string>() == "Legacy Systems");
        Assert.Contains(await List(owner), g => g!["name"]!.GetValue<string>() == "Legacy Systems");

        // New projects cannot go there...
        var refused = await NewProject(owner, "New thing", old);
        Assert.Equal(422, (int)refused.Status);
        Assert.Contains("inactive", refused.Json!["errors"]![0]!["message"]!.GetValue<string>());
        // ...but the existing one still shows it, and can be edited without leaving it.
        var detail = await owner.Get($"/api/v1/projects/{project}");
        Assert.Equal("Legacy Systems", detail.Data!["project"]!["projectGroupName"]!.GetValue<string>());
        var version = detail.Data["project"]!["version"]!.GetValue<int>();
        var edit = await owner.Put($"/api/v1/projects/{project}", new { name = "Old CRM v2", priority = "Medium", status = "Planning", version, projectGroupId = old });
        Assert.True(edit.Ok, edit.ToString());
        // Moving a project into an inactive group is refused; moving it to an active one works.
        var moved = await owner.Put($"/api/v1/projects/{project}", new { name = "Old CRM v2", priority = "Medium", status = "Planning", version = version + 1, projectGroupId = other });
        Assert.True(moved.Ok, moved.ToString());
        Assert.Equal("Other Projects", moved.Data!["project"]!["projectGroupName"]!.GetValue<string>());
        Assert.Equal(422, (int)(await owner.Put($"/api/v1/projects/{project}", new { name = "Old CRM v2", priority = "Medium", status = "Planning", version = version + 2, projectGroupId = old })).Status);
    }

    [Fact]
    public async Task There_is_always_at_least_one_active_group()
    {
        var owner = await NewOrg();
        var only = Guid.Parse((await List(owner))[0]!["id"]!.GetValue<string>());
        var off = await owner.Put($"{Groups}/{only}", new { isActive = false });
        Assert.Equal(409, (int)off.Status);
        Assert.Equal("PROJECT_GROUP_LAST_ACTIVE", off.ErrorCode);
        var del = await owner.Delete($"{Groups}/{only}");
        Assert.Equal(409, (int)del.Status);
    }

    // ------------------------------------------------------------------ deleting

    [Fact]
    public async Task A_group_with_projects_is_deleted_only_after_they_are_moved()
    {
        var owner = await NewOrg();
        var other = Guid.Parse((await List(owner))[0]!["id"]!.GetValue<string>());
        var data = Id(await owner.Post(Groups, new { name = "Data Team" }));
        var inactive = Id(await owner.Post(Groups, new { name = "Dormant", isActive = false }));
        Assert.True((await NewProject(owner, "Warehouse", data)).Ok);
        Assert.True((await NewProject(owner, "Reports", data)).Ok);

        var blocked = await owner.Delete($"{Groups}/{data}");
        Assert.Equal(409, (int)blocked.Status);
        Assert.Equal("PROJECT_GROUP_IN_USE", blocked.ErrorCode);
        Assert.Contains("2 projects", blocked.Json!["errors"]![0]!["message"]!.GetValue<string>());

        Assert.Equal(422, (int)(await owner.Delete($"{Groups}/{data}?moveTo={inactive}")).Status);   // an inactive group is not a place to move to
        Assert.Equal(422, (int)(await owner.Delete($"{Groups}/{data}?moveTo={data}")).Status);
        Assert.Equal(204, (int)(await owner.Delete($"{Groups}/{data}?moveTo={other}")).Status);

        var left = await List(owner);
        Assert.DoesNotContain(left, g => g!["name"]!.GetValue<string>() == "Data Team");
        Assert.Equal(2, Named(left, "Other Projects")["projectCount"]!.GetValue<int>());   // both projects moved, none lost
        // An empty group just goes.
        Assert.Equal(204, (int)(await owner.Delete($"{Groups}/{inactive}")).Status);
    }

    // ------------------------------------------------------------------ who may manage them

    [Fact]
    public async Task Everyone_who_can_see_projects_can_read_the_list_but_only_authorized_roles_can_change_it()
    {
        var owner = await NewOrg();
        await owner.UpgradeAsync("BUSINESS");
        var admin = await owner.AddMemberAsync(factory, TenantRole.Admin);
        var manager = await owner.AddMemberAsync(factory, TenantRole.Manager);
        var member = await owner.AddMemberAsync(factory, TenantRole.Member);

        foreach (var c in new[] { owner, admin, manager, member }) Assert.True((await c.Get(Groups)).Ok);
        Assert.True((await admin.Post(Groups, new { name = "From the admin" })).Ok);
        foreach (var c in new[] { manager, member })
        {
            var denied = await c.Post(Groups, new { name = "Nope" });
            Assert.Equal(403, (int)denied.Status);
            Assert.Equal("PERMISSION_DENIED", denied.ErrorCode);
        }
        var id = Guid.Parse((await List(owner))[0]!["id"]!.GetValue<string>());
        Assert.Equal(403, (int)(await member.Put($"{Groups}/{id}", new { name = "Renamed" })).Status);
        Assert.Equal(403, (int)(await member.Delete($"{Groups}/{id}")).Status);
        Assert.Equal(403, (int)(await manager.Put($"{Groups}/order", new { groupIds = new[] { id } })).Status);
    }

    [Fact]
    public async Task People_can_only_create_projects_in_groups_they_can_see_listed_and_a_member_can_do_it()
    {
        var owner = await NewOrg();
        await owner.UpgradeAsync("BUSINESS");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member);
        var groupId = Guid.Parse((await List(member))[0]!["id"]!.GetValue<string>());
        var created = await NewProject(member, "Member's project", groupId);
        Assert.True(created.Ok, created.ToString());
    }
}
