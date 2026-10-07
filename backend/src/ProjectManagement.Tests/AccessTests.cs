using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Job-role access: a level per module (None / View / Edit / Full) plus a few extra switches, enforced on the server.</summary>
[Collection("api")]
public class AccessTests(ApiFactory factory)
{
    private static readonly string[] AllModules = ["projects", "tasks", "work", "documents", "calendar", "teams", "members", "organization", "reports", "activity", "audit", "billing"];

    /// <summary>A modules payload with everything off except the given levels.</summary>
    private static Dictionary<string, int> Levels(params (string Module, int Level)[] on)
    {
        var d = AllModules.ToDictionary(m => m, _ => 0);
        foreach (var (m, l) in on) d[m] = l;
        return d;
    }

    private static Task<ApiResult> SetAccess(TestClient c, Guid role, Dictionary<string, int> modules, Dictionary<string, bool>? actions = null) =>
        c.Put($"/api/v1/org/roles/{role}/access", new { modules, actions = actions ?? new Dictionary<string, bool>() });

    private static async Task<Guid> NewRole(TestClient c, string name, Guid? parent = null)
    {
        var res = await c.Post("/api/v1/org/roles", new { name, parentRoleId = parent });
        Assert.Equal(HttpStatusCode.Created, res.Status);
        return Guid.Parse(res.Data!["id"]!.GetValue<string>());
    }

    private static async Task Place(TestClient owner, TestClient person, Guid role)
    {
        var res = await owner.Put($"/api/v1/org/members/{person.UserId}/role", new { roleId = role });
        Assert.Equal(HttpStatusCode.NoContent, res.Status);
    }

    private static async Task<JsonNode> Modules(TestClient c) => (await c.Get("/api/v1/me")).Data!["current"]!["modules"]!;

    private async Task<(TestClient Owner, Guid Org)> NewOrg(string plan = "BUSINESS")
    {
        var owner = await TestClient.RegisterAsync(factory);
        var org = await owner.CreateOrgAsync();
        if (plan != "FREE") await owner.UpgradeAsync(plan);
        return (owner, org);
    }

    [Fact]
    public async Task The_matrix_lists_every_module_role_and_suggested_access_for_admins_only()
    {
        var (owner, _) = await NewOrg();
        Assert.True((await owner.Post("/api/v1/org/template", new { template = "software" })).Ok);
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mia");

        var res = await owner.Get("/api/v1/org/access");
        Assert.True(res.Ok, res.ToString());
        Assert.Equal(AllModules.Length, res.Data!["modules"]!.AsArray().Count);
        Assert.Equal(11, res.Data["roles"]!.AsArray().Count);
        Assert.True(res.Data["canEdit"]!.GetValue<bool>());
        Assert.True(res.Data["isOrgAdmin"]!.GetValue<bool>());
        var cto = res.Data["roles"]!.AsArray().First(r => r!["name"]!.GetValue<string>() == "CTO")!;
        Assert.False(cto["hasProfile"]!.GetValue<bool>());            // nothing is restricted until an admin says so
        Assert.Equal(3, cto["suggested"]!["modules"]!["projects"]!.GetValue<int>());

        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get("/api/v1/org/access")).Status);
    }

    [Fact]
    public async Task A_job_role_decides_what_a_member_can_open_and_do_and_reset_restores_the_defaults()
    {
        var (owner, _) = await NewOrg();
        var mia = await owner.AddMemberAsync(factory, TenantRole.Member, "Mia");
        var viewer = await NewRole(owner, "Viewer");
        await Place(owner, mia, viewer);
        var projectId = await owner.CreateProjectAsync("Atlas");
        var task = await owner.CreateTaskAsync(projectId, "Write the spec");
        var taskId = task["id"]!.GetValue<string>();

        // Before any profile a Member keeps today's behaviour.
        Assert.True((await mia.Post("/api/v1/projects", new { name = "Before", priority = "Low" })).Ok);

        // Viewer: can read projects and tasks, nothing else.
        var set = await SetAccess(owner, viewer, Levels(("projects", 1), ("tasks", 1)));
        Assert.True(set.Ok, set.ToString());

        Assert.True((await mia.Get("/api/v1/projects")).Ok);
        Assert.True((await mia.Get($"/api/v1/projects/{projectId}/tasks")).Ok);
        Assert.Equal(HttpStatusCode.Forbidden, (await mia.Post("/api/v1/projects", new { name = "After", priority = "Low" })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await mia.Post($"/api/v1/projects/{projectId}/tasks", new { title = "Nope", priority = "Low" })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await mia.Post($"/api/v1/tasks/{taskId}/comments", new { body = "Hello" })).Status);   // comment is an extra switch
        foreach (var closed in new[] { "/api/v1/calendar?from=2026-01-01&to=2026-01-31", "/api/v1/reports/summary", "/api/v1/activity", "/api/v1/teams", "/api/v1/billing" })
        {
            var r = await mia.Get(closed);
            Assert.Equal(HttpStatusCode.Forbidden, r.Status);
            Assert.Equal("MODULE_ACCESS_DENIED", r.ErrorCode);
        }

        // The client learns the levels so it can hide menus.
        var modules = await Modules(mia);
        Assert.Equal(1, modules["projects"]!.GetValue<int>());
        Assert.Equal(0, modules["calendar"]!.GetValue<int>());

        // An extra switch: this role may comment even though it is view-only.
        Assert.True((await SetAccess(owner, viewer, Levels(("projects", 1), ("tasks", 1)), new() { ["tasks.comment"] = true })).Ok);
        Assert.True((await mia.Post($"/api/v1/tasks/{taskId}/comments", new { body = "Looks good" })).Ok);
        Assert.Equal(HttpStatusCode.Forbidden, (await mia.Put($"/api/v1/tasks/{taskId}", new { title = "x", version = 1 })).Status);

        // Owners are never narrowed by a job role, even when they sit in a restricted one.
        await Place(owner, owner, viewer);
        Assert.True((await owner.Post("/api/v1/projects", new { name = "Owner still can", priority = "Low" })).Ok);

        // Reset: back to what a Member gets.
        var reset = await owner.Delete($"/api/v1/org/roles/{viewer}/access");
        Assert.True(reset.Ok, reset.ToString());
        Assert.True((await mia.Post("/api/v1/projects", new { name = "Again", priority = "Low" })).Ok);
        Assert.True((await mia.Get("/api/v1/teams")).Ok);
    }

    [Fact]
    public async Task View_only_means_view_only_even_for_the_owner_of_a_project()
    {
        var (owner, _) = await NewOrg();
        var mia = await owner.AddMemberAsync(factory, TenantRole.Member, "Mia");
        var mine = await mia.CreateProjectAsync("Mia's project");
        var res = await mia.Put($"/api/v1/projects/{mine}", new { name = "Renamed", priority = "Low", status = "Planning", version = 1 });
        Assert.True(res.Ok, res.ToString());          // members may edit projects they own

        var viewer = await NewRole(owner, "Viewer");
        await Place(owner, mia, viewer);
        await SetAccess(owner, viewer, Levels(("projects", 1), ("tasks", 1)));
        var denied = await mia.Put($"/api/v1/projects/{mine}", new { name = "Again", priority = "Low", status = "Planning", version = 2 });
        Assert.Equal(HttpStatusCode.Forbidden, denied.Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await mia.Send(HttpMethod.Patch, $"/api/v1/projects/{mine}/move", new { status = "Active" })).Status);
    }

    [Fact]
    public async Task Dashboard_and_search_only_show_areas_the_job_role_can_open()
    {
        var (owner, _) = await NewOrg();
        var mia = await owner.AddMemberAsync(factory, TenantRole.Member, "Mia");
        var projectId = await owner.CreateProjectAsync("Zebra Project");
        await owner.CreateTaskAsync(projectId, "Zebra task", new { title = "Zebra task", priority = "Low", assigneeId = mia.UserId });

        var before = await mia.Get("/api/v1/search?q=zebra");
        Assert.Contains(before.Data!["hits"]!.AsArray(), h => h!["type"]!.GetValue<string>() == "task");
        Assert.NotEmpty((await mia.Get("/api/v1/dashboard")).Data!["myTasks"]!.AsArray());

        var role = await NewRole(owner, "Projects only");
        await Place(owner, mia, role);
        await SetAccess(owner, role, Levels(("projects", 1)));

        var hits = (await mia.Get("/api/v1/search?q=zebra")).Data!["hits"]!.AsArray().Select(h => h!["type"]!.GetValue<string>()).ToList();
        Assert.Contains("project", hits);
        Assert.DoesNotContain("task", hits);
        var dash = (await mia.Get("/api/v1/dashboard")).Data!;
        Assert.Empty(dash["myTasks"]!.AsArray());
        Assert.Equal(0, dash["counts"]!["openTasks"]!.GetValue<int>());
        Assert.NotEmpty(dash["projects"]!.AsArray());
    }

    [Fact]
    public async Task Delegates_can_only_change_roles_below_theirs_and_never_grant_more_than_they_have()
    {
        var (owner, _) = await NewOrg();
        var dee = await owner.AddMemberAsync(factory, TenantRole.Member, "Dee");
        var lead = await NewRole(owner, "Lead");
        var dev = await NewRole(owner, "Dev", lead);
        var other = await NewRole(owner, "Other");
        await Place(owner, dee, lead);
        // Dee is trusted with access management, but only up to Edit on projects and tasks.
        Assert.True((await SetAccess(owner, lead, Levels(("projects", 2), ("tasks", 2), ("organization", 1)), new() { ["access.manage"] = true })).Ok);

        Assert.True((await dee.Get("/api/v1/org/access")).Ok);
        Assert.False((await dee.Get("/api/v1/org/access")).Data!["isOrgAdmin"]!.GetValue<bool>());

        // Inside their scope and limits: fine.
        Assert.True((await SetAccess(dee, dev, Levels(("projects", 1), ("tasks", 2), ("organization", 1)))).Ok);
        // Above their own level: refused.
        Assert.Equal(HttpStatusCode.Forbidden, (await SetAccess(dee, dev, Levels(("projects", 3)))).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await SetAccess(dee, dev, Levels(("reports", 1)))).Status);           // Dee cannot open reports herself
        // Handing out access-granting permissions is for organization admins only.
        Assert.Equal(HttpStatusCode.Forbidden, (await SetAccess(dee, dev, Levels(("projects", 1)), new() { ["access.manage"] = true })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await SetAccess(dee, dev, Levels(("projects", 1)), new() { ["members.invite"] = true })).Status);
        // Not below Dee in the chart: her own role and an unrelated one.
        Assert.Equal(HttpStatusCode.Forbidden, (await SetAccess(dee, lead, Levels(("projects", 1)))).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await SetAccess(dee, other, Levels(("projects", 1)))).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await dee.Delete($"/api/v1/org/roles/{other}/access")).Status);

        // The organization admin can do all of it.
        Assert.True((await SetAccess(owner, other, Levels(("projects", 3)), new() { ["access.manage"] = true })).Ok);
    }

    [Fact]
    public async Task Editing_job_role_access_is_a_paid_feature_but_reading_works_and_profiles_keep_applying()
    {
        var (owner, _) = await NewOrg("FREE");
        var role = await NewRole(owner, "Viewer");
        var res = await owner.Get("/api/v1/org/access");
        Assert.True(res.Ok, res.ToString());
        Assert.False(res.Data!["canEdit"]!.GetValue<bool>());
        var denied = await SetAccess(owner, role, Levels(("projects", 1)));
        Assert.Equal(HttpStatusCode.Forbidden, denied.Status);
        Assert.Equal("FEATURE_NOT_AVAILABLE", denied.ErrorCode);
    }

    [Fact]
    public async Task Validation_deleted_roles_and_the_audit_trail()
    {
        var (owner, org) = await NewOrg();
        var mia = await owner.AddMemberAsync(factory, TenantRole.Member, "Mia");
        var role = await NewRole(owner, "Viewer");
        await Place(owner, mia, role);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await SetAccess(owner, role, new() { ["nope"] = 1 })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await SetAccess(owner, role, Levels(("calendar", 3)))).Status);            // calendar has no Full
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await SetAccess(owner, role, Levels(("projects", 1)), new() { ["bogus.key"] = true })).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await SetAccess(owner, Guid.NewGuid(), Levels(("projects", 1)))).Status);

        await SetAccess(owner, role, Levels(("projects", 1)));
        Assert.Equal(HttpStatusCode.Forbidden, (await mia.Get("/api/v1/teams")).Status);

        // Deleting the role moves Mia to its parent (none here) — her restrictions go with it, so she is back on Member defaults.
        Assert.True((await owner.Delete($"/api/v1/org/roles/{role}")).Ok);
        Assert.True((await mia.Get("/api/v1/teams")).Ok);
        // Restoring brings the profile back with the role (people that were moved stay where they are).
        Assert.True((await owner.Post($"/api/v1/org/roles/{role}/restore")).Ok);
        await Place(owner, mia, role);
        Assert.Equal(HttpStatusCode.Forbidden, (await mia.Get("/api/v1/teams")).Status);
        Assert.True((await owner.Get("/api/v1/org")).Data!["roles"]!.AsArray().First(r => r!["id"]!.GetValue<string>() == role.ToString())!["hasAccess"]!.GetValue<bool>());

        await owner.Delete($"/api/v1/org/roles/{role}/access");
        var actions = factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Where(x => x.TenantId == org && x.Action.StartsWith("org.access")).Select(x => x.Action).ToList());
        Assert.Contains("org.access_changed", actions);
        Assert.Contains("org.access_reset", actions);
    }

    [Fact]
    public async Task Members_and_billing_default_to_admin_only_but_the_member_picker_stays_open_to_everyone()
    {
        var (owner, _) = await NewOrg();
        var admin = await owner.AddMemberAsync(factory, TenantRole.Admin, "Ada");
        var manager = await owner.AddMemberAsync(factory, TenantRole.Manager, "Max");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mia");

        var adminModules = await Modules(admin);
        Assert.True(adminModules["members"]!.GetValue<int>() > 0);
        Assert.True(adminModules["billing"]!.GetValue<int>() > 0);

        foreach (var c in new[] { manager, member })
        {
            var modules = await Modules(c);
            Assert.Equal(0, modules["members"]!.GetValue<int>());
            Assert.Equal(0, modules["billing"]!.GetValue<int>());
            Assert.Equal(HttpStatusCode.Forbidden, (await c.Get("/api/v1/billing")).Status);
            // The Members *page*'s module level is 0, but the plain roster stays reachable - it's the shared
            // "who's in the workspace" picker used everywhere someone is assigned to a task, project or team.
            Assert.True((await c.Get("/api/v1/workspace/members")).Ok);
        }
    }

    [Fact]
    public async Task Guests_and_personal_workspaces_cannot_reach_the_access_page()
    {
        var (owner, _) = await NewOrg();
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gus");
        Assert.Equal(HttpStatusCode.Forbidden, (await guest.Get("/api/v1/org/access")).Status);
        var solo = await TestClient.RegisterAsync(factory);
        var res = await solo.Get("/api/v1/org/access");
        Assert.Equal(HttpStatusCode.Forbidden, res.Status);
        Assert.Equal("PERSONAL_WORKSPACE", res.ErrorCode);
        // ...and a personal workspace's owner still has every module.
        var modules = await Modules(solo);
        Assert.All(AllModules, m => Assert.True(modules[m]!.GetValue<int>() > 0));
    }
}
