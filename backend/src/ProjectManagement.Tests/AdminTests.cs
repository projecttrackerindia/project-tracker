using System.Net;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public class AdminTests(ApiFactory factory)
{
    private async Task<TestClient> NewAdminAsync()
    {
        var admin = await TestClient.RegisterAsync(factory, "Platform Admin");
        // The flag is read from the database on every request, not from the token.
        factory.WithDb(db => { db.Users.First(u => u.Id == admin.UserId).IsPlatformAdmin = true; db.SaveChanges(); return 0; });
        return admin;
    }

    [Fact]
    public async Task Admin_can_create_edit_and_transfer_ownership_of_an_organization()
    {
        var admin = await NewAdminAsync();
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");

        var created = await admin.Post("/api/v1/admin/tenants", new { name = "Acme Corp", description = "Anvils", ownerEmail = owner.Email.ToUpperInvariant(), planCode = "PRO" });
        Assert.Equal(HttpStatusCode.Created, created.Status);
        var tenantId = Guid.Parse(created.Data!["tenant"]!["id"]!.GetValue<string>());
        Assert.Equal("Organization", created.Data["tenant"]!["type"]!.GetValue<string>());
        Assert.Equal("PRO", created.Data["tenant"]!["planCode"]!.GetValue<string>());
        Assert.Equal("Owner", created.Data["members"]![0]!["role"]!.GetValue<string>());

        // The owner immediately sees the organization and is its Owner.
        var mine = (await owner.Get("/api/v1/workspaces")).Data!.AsArray();
        Assert.Contains(mine, w => w!["id"]!.GetValue<string>() == tenantId.ToString() && w["role"]!.GetValue<string>() == "Owner");

        await owner.SwitchToAsync(tenantId);
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mia Member");

        var renamed = await admin.Put($"/api/v1/admin/tenants/{tenantId}", new { name = "Acme Holdings", description = "Everything", ownerUserId = member.UserId });
        Assert.True(renamed.Ok, renamed.ToString());
        Assert.Equal("Acme Holdings", renamed.Data!["tenant"]!["name"]!.GetValue<string>());
        var roles = renamed.Data["members"]!.AsArray().ToDictionary(m => m!["userId"]!.GetValue<string>(), m => m!["role"]!.GetValue<string>());
        Assert.Equal("Owner", roles[member.UserId.ToString()]);
        Assert.Equal("Admin", roles[owner.UserId.ToString()]); // previous owner stays on as Admin
        Assert.Single(roles.Values, r => r == "Owner");

        // A user who is not a member cannot become the owner.
        var stranger = await TestClient.RegisterAsync(factory);
        var bad = await admin.Put($"/api/v1/admin/tenants/{tenantId}", new { name = "Acme Holdings", ownerUserId = stranger.UserId });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, bad.Status);
        Assert.Equal("ownerUserId", bad.Json!["errors"]![0]!["field"]!.GetValue<string>());
    }

    [Fact]
    public async Task Creating_an_organization_validates_the_owner_and_the_plan()
    {
        var admin = await NewAdminAsync();
        var owner = await TestClient.RegisterAsync(factory);

        var noUser = await admin.Post("/api/v1/admin/tenants", new { name = "Ghost Inc", ownerEmail = "nobody@example.com", planCode = "FREE" });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, noUser.Status);
        Assert.Equal("ownerEmail", noUser.Json!["errors"]![0]!["field"]!.GetValue<string>());

        var noPlan = await admin.Post("/api/v1/admin/tenants", new { name = "Planless", ownerEmail = owner.Email, planCode = "PLATINUM" });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, noPlan.Status);
        Assert.Equal("planCode", noPlan.Json!["errors"]![0]!["field"]!.GetValue<string>());

        var shortName = await admin.Post("/api/v1/admin/tenants", new { name = "X", ownerEmail = owner.Email, planCode = "FREE" });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, shortName.Status);
    }

    [Fact]
    public async Task Deleting_an_organization_is_a_soft_delete_that_can_be_restored()
    {
        var admin = await NewAdminAsync();
        var owner = await TestClient.RegisterAsync(factory, "Owen Owner");
        var tenantId = await owner.CreateOrgAsync("Retained Org");
        var project = await owner.CreateProjectAsync("Secret plans");
        var task = await owner.CreateTaskAsync(project, "Parent");
        await owner.CreateTaskAsync(project, "Child", new { title = "Child", priority = "Low", parentTaskId = task["id"]!.GetValue<string>() });
        await owner.Post($"/api/v1/tasks/{task["id"]!.GetValue<string>()}/comments", new { body = "hello" });
        var personalId = Guid.Parse((await owner.Get("/api/v1/workspaces")).Data!.AsArray()
            .First(w => w!["type"]!.GetValue<string>() == "Personal")!["id"]!.GetValue<string>());

        // Personal workspaces and unknown ids are refused.
        var personal = await admin.Delete($"/api/v1/admin/tenants/{personalId}");
        Assert.Equal(HttpStatusCode.Conflict, personal.Status);
        Assert.Equal("PERSONAL_WORKSPACE", personal.ErrorCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.Delete($"/api/v1/admin/tenants/{Guid.NewGuid()}")).Status);
        Assert.Equal(HttpStatusCode.Conflict, (await admin.Post($"/api/v1/admin/tenants/{tenantId}/restore")).Status); // not deleted yet

        Assert.Equal(HttpStatusCode.NoContent, (await admin.Delete($"/api/v1/admin/tenants/{tenantId}")).Status);
        Assert.Equal("TENANT_DELETED", (await admin.Delete($"/api/v1/admin/tenants/{tenantId}")).ErrorCode); // already deleted

        // Nothing was erased: the tenant row and all of its data are still there.
        var kept = factory.WithDb(db => new
        {
            Tenant = db.Tenants.IgnoreQueryFilters().Single(t => t.Id == tenantId),
            Members = db.TenantMembers.Count(m => m.TenantId == tenantId),
            Projects = db.Projects.IgnoreQueryFilters().Count(p => p.TenantId == tenantId),
            Tasks = db.Tasks.IgnoreQueryFilters().Count(t => t.TenantId == tenantId),
            Comments = db.TaskComments.IgnoreQueryFilters().Count(c => c.TenantId == tenantId),
        });
        Assert.True(kept.Tenant.IsDeleted);
        Assert.NotNull(kept.Tenant.DeletedAt);
        Assert.Equal((1, 1, 2, 1), (kept.Members, kept.Projects, kept.Tasks, kept.Comments));

        // Members lose access at once...
        var workspaces = (await owner.Get("/api/v1/workspaces")).Data!.AsArray();
        Assert.DoesNotContain(workspaces, w => w!["id"]!.GetValue<string>() == tenantId.ToString());
        var stale = await owner.Get("/api/v1/projects"); // the token still names the deleted workspace
        Assert.Equal(HttpStatusCode.Forbidden, stale.Status);
        Assert.Equal("WORKSPACE_REQUIRED", stale.ErrorCode);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Post($"/api/v1/workspaces/{tenantId}/switch")).Status);

        // ...while the admin still sees it, flagged as deleted, and cannot change it until it is restored.
        var deletedList = (await admin.Get("/api/v1/admin/tenants?status=Deleted")).Data!["items"]!.AsArray();
        var row = Assert.Single(deletedList, t => t!["id"]!.GetValue<string>() == tenantId.ToString())!;
        Assert.True(row["isDeleted"]!.GetValue<bool>());
        var all = (await admin.Get($"/api/v1/admin/tenants?q={Uri.EscapeDataString("Retained Org")}")).Data!["items"]!.AsArray();
        Assert.Contains(all, t => t!["id"]!.GetValue<string>() == tenantId.ToString());
        Assert.True((await admin.Get($"/api/v1/admin/tenants/{tenantId}")).Data!["tenant"]!["isDeleted"]!.GetValue<bool>());
        Assert.Equal("TENANT_DELETED", (await admin.Put($"/api/v1/admin/tenants/{tenantId}", new { name = "Renamed" })).ErrorCode);
        Assert.Equal("TENANT_DELETED", (await admin.Put($"/api/v1/admin/tenants/{tenantId}/status", new { status = "Suspended" })).ErrorCode);
        var membership = (await admin.Get($"/api/v1/admin/users/{owner.UserId}")).Data!["user"]!["memberships"]!.AsArray()
            .Single(m => m!["tenantId"]!.GetValue<string>() == tenantId.ToString())!;
        Assert.True(membership["isDeleted"]!.GetValue<bool>());

        // Restore brings everything back exactly as it was.
        var restored = await admin.Post($"/api/v1/admin/tenants/{tenantId}/restore");
        Assert.True(restored.Ok, restored.ToString());
        Assert.False(restored.Data!["tenant"]!["isDeleted"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.Conflict, (await admin.Post($"/api/v1/admin/tenants/{tenantId}/restore")).Status);

        Assert.Contains((await owner.Get("/api/v1/workspaces")).Data!.AsArray(), w => w!["id"]!.GetValue<string>() == tenantId.ToString());
        Assert.True((await owner.Get("/api/v1/projects")).Ok); // the old token works again
        var again = (await owner.Get($"/api/v1/projects/{project}/tasks")).Data!;
        Assert.Equal(1, again["totalItems"]!.GetValue<int>()); // top-level tasks; the subtask survived as well
        Assert.True(factory.WithDb(db => db.AuditLogs.Any(a => a.TenantId == tenantId && a.Action == "admin.tenant_deleted")
            && db.AuditLogs.Any(a => a.TenantId == tenantId && a.Action == "admin.tenant_restored")));
    }

    [Fact]
    public async Task A_deleted_organization_cannot_be_joined_through_an_old_invitation()
    {
        var admin = await NewAdminAsync();
        var owner = await TestClient.RegisterAsync(factory);
        var tenantId = await owner.CreateOrgAsync("Closing Down");
        await owner.UpgradeAsync("PRO");
        var invitee = await TestClient.RegisterAsync(factory);
        Assert.True((await owner.Post("/api/v1/workspace/invitations", new { email = invitee.Email, role = "Member" })).Ok);
        var token = await invitee.MailboxToken("invite");

        Assert.Equal(HttpStatusCode.NoContent, (await admin.Delete($"/api/v1/admin/tenants/{tenantId}")).Status);

        Assert.Equal(HttpStatusCode.NotFound, (await invitee.Send(HttpMethod.Get, $"/api/v1/invitations/lookup?token={Uri.EscapeDataString(token)}", null, true)).Status);
        var accept = await invitee.Post("/api/v1/invitations/accept", new { token });
        Assert.Equal(HttpStatusCode.Conflict, accept.Status);
    }

    [Fact]
    public async Task Admin_sees_where_each_user_belongs_and_can_sign_them_out()
    {
        var admin = await NewAdminAsync();
        var user = await TestClient.RegisterAsync(factory, "Una User");
        var orgId = await user.CreateOrgAsync("Una Labs");
        await user.UpgradeAsync("PRO");

        var detail = await admin.Get($"/api/v1/admin/users/{user.UserId}");
        Assert.True(detail.Ok, detail.ToString());
        var memberships = detail.Data!["user"]!["memberships"]!.AsArray();
        Assert.Equal(2, memberships.Count);
        var org = memberships.First(m => m!["type"]!.GetValue<string>() == "Organization")!;
        Assert.Equal("Una Labs", org["tenantName"]!.GetValue<string>());
        Assert.Equal("Owner", org["role"]!.GetValue<string>());
        Assert.Equal("PRO", org["planCode"]!.GetValue<string>());
        Assert.Contains(memberships, m => m!["type"]!.GetValue<string>() == "Personal" && m["planCode"]!.GetValue<string>() == "FREE");
        Assert.True(detail.Data["activeSessions"]!.GetValue<int>() >= 1);

        // The same information is on the list page, so no per-row request is needed.
        var listed = (await admin.Get($"/api/v1/admin/users?q={Uri.EscapeDataString(user.Email)}")).Data!["items"]!.AsArray();
        Assert.Equal(2, listed.Single()!["memberships"]!.AsArray().Count);

        // Organization detail: members and usage counts, no project/task content.
        var tenant = (await admin.Get($"/api/v1/admin/tenants/{orgId}")).Data!;
        Assert.Equal("Una User", tenant["members"]![0]!["displayName"]!.GetValue<string>());
        Assert.Equal(0, tenant["usage"]!["projects"]!.GetValue<int>());
        Assert.Equal(10, tenant["limits"]!["MAX_MEMBERS"]!.GetValue<int>());
        Assert.Null(tenant["projects"]);
        Assert.Null(tenant["tasks"]);

        Assert.True((await user.Get("/api/v1/me")).Ok);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.Post($"/api/v1/admin/users/{user.UserId}/sign-out")).Status);
        Assert.Equal(HttpStatusCode.Unauthorized, (await user.Get("/api/v1/me")).Status);
        Assert.True((await user.LoginAsync()).Ok); // signing out is not a lock-out
    }

    [Fact]
    public async Task The_new_admin_operations_are_restricted_to_platform_administrators()
    {
        var user = await TestClient.RegisterAsync(factory);
        var other = await TestClient.RegisterAsync(factory);
        var id = Guid.NewGuid();

        foreach (var res in new[]
        {
            await user.Get($"/api/v1/admin/tenants/{id}"),
            await user.Post("/api/v1/admin/tenants", new { name = "Sneaky", ownerEmail = user.Email, planCode = "ENTERPRISE" }),
            await user.Put($"/api/v1/admin/tenants/{id}", new { name = "Sneaky" }),
            await user.Delete($"/api/v1/admin/tenants/{id}"),
            await user.Post($"/api/v1/admin/tenants/{id}/restore"),
            await user.Get($"/api/v1/admin/users/{other.UserId}"),
            await user.Post($"/api/v1/admin/users/{other.UserId}/sign-out"),
        })
        {
            Assert.Equal(HttpStatusCode.Forbidden, res.Status);
            Assert.Equal("ADMIN_REQUIRED", res.ErrorCode);
        }
    }
}
