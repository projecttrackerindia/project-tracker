using System.Net;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Mandatory pre-release checks from the spec: tenant isolation, roles and project visibility.</summary>
[Collection("api")]
public class TenancyAndAccessTests(ApiFactory factory)
{
    [Fact]
    public async Task User_A_cannot_read_or_touch_tenant_B_data()
    {
        var a = await TestClient.RegisterAsync(factory, "Alice");
        var b = await TestClient.RegisterAsync(factory, "Bob");
        await a.CreateOrgAsync("Tenant A");
        await b.CreateOrgAsync("Tenant B");
        var projectB = await b.CreateProjectAsync("Secret B");
        var taskB = await b.CreateTaskAsync(projectB, "Bob's task");
        var taskBId = taskB["id"]!.GetValue<string>();

        Assert.Equal(HttpStatusCode.NotFound, (await a.Get($"/api/v1/projects/{projectB}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await a.Get($"/api/v1/tasks/{taskBId}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await a.Get($"/api/v1/projects/{projectB}/tasks")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await a.Delete($"/api/v1/projects/{projectB}")).Status);

        var write = await a.Post($"/api/v1/projects/{projectB}/tasks", new { title = "injected", priority = "High" });
        Assert.Equal(HttpStatusCode.NotFound, write.Status);

        // Lists only ever contain the caller's own tenant.
        var listA = (await a.Get("/api/v1/projects")).Data!["items"]!.AsArray();
        Assert.DoesNotContain(listA, p => p!["id"]!.GetValue<string>() == projectB.ToString());
        var search = (await a.Get("/api/v1/search?q=secret")).Data!["hits"]!.AsArray();
        Assert.Empty(search);
    }

    [Fact]
    public async Task A_user_cannot_switch_into_a_workspace_they_do_not_belong_to()
    {
        var a = await TestClient.RegisterAsync(factory);
        var b = await TestClient.RegisterAsync(factory);
        var orgB = await b.CreateOrgAsync();

        var res = await a.Post($"/api/v1/workspaces/{orgB}/switch");
        Assert.Equal(HttpStatusCode.NotFound, res.Status);
    }

    [Fact]
    public async Task Tenant_ids_supplied_by_the_client_are_ignored()
    {
        var a = await TestClient.RegisterAsync(factory);
        var b = await TestClient.RegisterAsync(factory);
        await a.CreateOrgAsync();
        var orgB = await b.CreateOrgAsync();

        // A body-supplied tenantId / header must not redirect the write into tenant B.
        var res = await a.Send(HttpMethod.Post, "/api/v1/projects", new { name = "Sneaky", priority = "Low", tenantId = orgB });
        Assert.True(res.Ok, res.ToString());
        var id = res.Data!["project"]!["id"]!.GetValue<string>();
        Assert.Equal(HttpStatusCode.NotFound, (await b.Get($"/api/v1/projects/{id}")).Status);
        Assert.Empty((await b.Get("/api/v1/projects")).Data!["items"]!.AsArray());
    }

    [Fact]
    public async Task A_removed_member_loses_access_immediately_even_with_a_valid_token()
    {
        var owner = await TestClient.RegisterAsync(factory);
        var orgId = await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mem");
        Assert.True((await member.Get("/api/v1/projects")).Ok);

        Assert.Equal(HttpStatusCode.NoContent, (await owner.Delete($"/api/v1/workspace/members/{member.UserId}")).Status);

        var after = await member.Get("/api/v1/projects");
        Assert.Equal(HttpStatusCode.Forbidden, after.Status);
        Assert.Equal("WORKSPACE_REQUIRED", after.ErrorCode);
    }

    [Fact]
    public async Task Roles_are_enforced_server_side()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        var project = await owner.CreateProjectAsync("Team project");

        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mem");
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gus");

        // Members can work on tasks but cannot delete projects, invite people or see audit / billing.
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Delete($"/api/v1/projects/{project}")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Post("/api/v1/workspace/invitations", new { email = "x@example.com", role = "Member" })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Post("/api/v1/billing/checkout", new { planCode = "BUSINESS" })).Status);
        var task = await member.CreateTaskAsync(project, "Member task");
        Assert.NotNull(task["id"]);

        // Guests only see projects they were explicitly added to, and cannot create tasks.
        Assert.Equal(HttpStatusCode.NotFound, (await guest.Get($"/api/v1/projects/{project}")).Status);
        Assert.Empty((await guest.Get("/api/v1/projects")).Data!["items"]!.AsArray());
        Assert.Equal(HttpStatusCode.NotFound, (await guest.Get($"/api/v1/tasks/{task["id"]!.GetValue<string>()}")).Status);

        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = guest.UserId })).Ok);
        Assert.True((await guest.Get($"/api/v1/projects/{project}")).Ok);
        Assert.Equal(HttpStatusCode.Forbidden, (await guest.Post($"/api/v1/projects/{project}/tasks", new { title = "nope", priority = "Low" })).Status);
        Assert.True((await guest.Post($"/api/v1/tasks/{task["id"]!.GetValue<string>()}/comments", new { body = "Guests may comment" })).Ok);
    }

    [Fact]
    public async Task Role_hierarchy_stops_privilege_escalation()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        var admin = await owner.AddMemberAsync(factory, TenantRole.Admin, "Adm");
        var manager = await owner.AddMemberAsync(factory, TenantRole.Manager, "Man");

        // An admin cannot mint another admin / owner, nor demote the owner.
        Assert.Equal(HttpStatusCode.Forbidden, (await admin.Put($"/api/v1/workspace/members/{manager.UserId}", new { role = "Admin" })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await admin.Put($"/api/v1/workspace/members/{manager.UserId}", new { role = "Owner" })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await admin.Put($"/api/v1/workspace/members/{owner.UserId}", new { role = "Guest" })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await admin.Delete($"/api/v1/workspace/members/{owner.UserId}")).Status);
        // ...but can promote a manager's peers below their own level, and the owner can do more.
        Assert.True((await admin.Put($"/api/v1/workspace/members/{manager.UserId}", new { role = "Member" })).Ok);
        Assert.True((await owner.Put($"/api/v1/workspace/members/{manager.UserId}", new { role = "Admin" })).Ok);
    }

    [Fact]
    public async Task Invitations_are_bound_to_the_invited_email()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");

        var invitee = await TestClient.RegisterAsync(factory);
        var invite = await owner.Post("/api/v1/workspace/invitations", new { email = invitee.Email, role = "Member" });
        Assert.Equal(HttpStatusCode.Created, invite.Status);

        // A different signed-in user cannot redeem the link.
        var stranger = await TestClient.RegisterAsync(factory);
        var token = await invitee.MailboxToken("invite");
        var stolen = await stranger.Post("/api/v1/invitations/accept", new { token });
        Assert.Equal(HttpStatusCode.Forbidden, stolen.Status);
        Assert.Equal("INVITATION_EMAIL_MISMATCH", stolen.ErrorCode);

        var ok = await invitee.Post("/api/v1/invitations/accept", new { token });
        Assert.True(ok.Ok, ok.ToString());
        var replay = await invitee.Post("/api/v1/invitations/accept", new { token });
        Assert.Equal(HttpStatusCode.Conflict, replay.Status);
    }

    [Fact]
    public async Task Personal_workspaces_cannot_invite_members()
    {
        var c = await TestClient.RegisterAsync(factory);
        var res = await c.Post("/api/v1/workspace/invitations", new { email = "friend@example.com", role = "Member" });
        Assert.Equal(HttpStatusCode.Forbidden, res.Status);
        Assert.Equal("PERSONAL_WORKSPACE", res.ErrorCode);
    }

    [Fact]
    public async Task Admin_endpoints_require_a_platform_administrator()
    {
        var user = await TestClient.RegisterAsync(factory);
        foreach (var url in new[] { "/api/v1/admin/stats", "/api/v1/admin/tenants", "/api/v1/admin/users", "/api/v1/admin/plans", "/api/v1/admin/audit-logs" })
        {
            var res = await user.Get(url);
            Assert.Equal(HttpStatusCode.Forbidden, res.Status);
            Assert.Equal("ADMIN_REQUIRED", res.ErrorCode);
        }

        factory.WithDb(db => { db.Users.First(u => u.Id == user.UserId).IsPlatformAdmin = true; db.SaveChanges(); return 0; });
        var admin = user; // the flag is read from the database on each request, not from the token
        Assert.True((await admin.Get("/api/v1/admin/stats")).Ok);
    }

    [Fact]
    public async Task A_disabled_user_is_signed_out_immediately()
    {
        var user = await TestClient.RegisterAsync(factory);
        Assert.True((await user.Get("/api/v1/me")).Ok);
        factory.WithDb(db => { db.Users.First(u => u.Id == user.UserId).IsActive = false; db.SaveChanges(); return 0; });
        Assert.Equal(HttpStatusCode.Unauthorized, (await user.Get("/api/v1/me")).Status);
        Assert.Equal(HttpStatusCode.Unauthorized, (await user.LoginAsync()).Status);
    }
}
