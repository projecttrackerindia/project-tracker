using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Regression tests for the security audit: nobody can use the organization chart, teams, invitations or the permission matrix to give
/// themselves more access; ids from another workspace are refused; removing a person takes away everything they were given; and a
/// refused request tells the app to reload its access context.
/// </summary>
[Collection("api")]
public class SecurityAuditTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<TestClient> NewOrg(string name = "Olive Owner")
    {
        var owner = await TestClient.RegisterAsync(factory, name);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        return owner;
    }

    private static async Task<Guid> Role(TestClient c, string name, Guid? parent = null)
    {
        var res = await c.Post("/api/v1/org/roles", new { name, parentRoleId = parent });
        Assert.Equal(HttpStatusCode.Created, res.Status);
        return Guid.Parse(S(res.Data!["id"]));
    }

    private static async Task Access(TestClient owner, Guid role, Dictionary<string, int> modules, Dictionary<string, bool>? actions = null)
    {
        var res = await owner.Put($"/api/v1/org/roles/{role}/access", new { modules, actions = actions ?? new Dictionary<string, bool>() });
        Assert.True(res.Ok, res.ToString());
    }

    private static Task<ApiResult> Assign(TestClient c, Guid user, Guid? role) => c.Put($"/api/v1/org/members/{user}/role", new { roleId = role });
    private static Task<ApiResult> ReportsTo(TestClient c, Guid user, Guid? boss) => c.Put($"/api/v1/org/members/{user}/reports-to", new { reportsToUserId = boss });
    private static Task<ApiResult> Move(TestClient c, Guid role, Guid? parent) => c.Send(HttpMethod.Patch, $"/api/v1/org/roles/{role}/parent", new { parentRoleId = parent });

    /// <summary>
    /// An org with a delegate: Mia is a Manager in the "Lead" job role, which may edit the chart and invite people but sees projects only.
    /// Below Lead: Dev (no own access), DevOk (view-only), DevPower (may manage members), DevBig (full projects). Boss is a separate root.
    /// </summary>
    private async Task<(TestClient Owner, TestClient Mia, TestClient Ben, TestClient Cal, Dictionary<string, Guid> Roles)> Delegate()
    {
        var owner = await NewOrg();
        var mia = await owner.AddMemberAsync(factory, TenantRole.Manager, "Mia Lead");
        var ben = await owner.AddMemberAsync(factory, TenantRole.Member, "Ben Dev");
        var cal = await owner.AddMemberAsync(factory, TenantRole.Member, "Cal Dev");
        var lead = await Role(owner, "Lead");
        var roles = new Dictionary<string, Guid>
        {
            ["Lead"] = lead, ["Boss"] = await Role(owner, "Boss"), ["Dev"] = await Role(owner, "Dev", lead),
            ["DevOk"] = await Role(owner, "DevOk", lead), ["DevPower"] = await Role(owner, "DevPower", lead), ["DevBig"] = await Role(owner, "DevBig", lead),
        };
        await Access(owner, lead, new() { ["projects"] = 1, ["tasks"] = 1, ["organization"] = 1, ["members"] = 2 }, new() { ["org.structure"] = true });
        await Access(owner, roles["DevOk"], new() { ["projects"] = 1, ["tasks"] = 1, ["organization"] = 1 });
        await Access(owner, roles["DevPower"], new() { ["projects"] = 1, ["tasks"] = 1, ["organization"] = 1, ["members"] = 3 });
        await Access(owner, roles["DevBig"], new() { ["projects"] = 3, ["tasks"] = 1, ["organization"] = 1 });
        Assert.Equal(HttpStatusCode.NoContent, (await Assign(owner, mia.UserId, lead)).Status);
        return (owner, mia, ben, cal, roles);
    }

    // ---------------------------------------------------------------- P1-1 org.structure self-escalation

    [Fact]
    public async Task A_delegate_cannot_give_herself_or_others_a_role_above_or_beyond_her_own()
    {
        var (_, mia, ben, _, roles) = await Delegate();

        // Not herself, not a role outside her branch, not a role that hands out access, not a role with more than she has.
        var self = await Assign(mia, mia.UserId, roles["Dev"]);
        Assert.Equal(HttpStatusCode.Forbidden, self.Status);
        Assert.Equal("PERMISSION_DENIED", self.ErrorCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await Assign(mia, mia.UserId, null)).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await Assign(mia, ben.UserId, roles["Boss"])).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await Assign(mia, ben.UserId, roles["Lead"])).Status);   // her own role is not "below" her
        Assert.Equal(HttpStatusCode.Forbidden, (await Assign(mia, ben.UserId, roles["DevPower"])).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await Assign(mia, ben.UserId, roles["DevBig"])).Status);

        // Roles below hers that give nothing extra are fine.
        Assert.Equal(HttpStatusCode.NoContent, (await Assign(mia, ben.UserId, roles["Dev"])).Status);
        Assert.Equal(HttpStatusCode.NoContent, (await Assign(mia, ben.UserId, roles["DevOk"])).Status);
    }

    [Fact]
    public async Task A_delegate_can_only_move_roles_inside_her_own_branch()
    {
        var (_, mia, _, _, roles) = await Delegate();
        Assert.Equal(HttpStatusCode.Forbidden, (await Move(mia, roles["Lead"], roles["Boss"])).Status);   // her own role
        Assert.Equal(HttpStatusCode.Forbidden, (await Move(mia, roles["Boss"], roles["Dev"])).Status);    // a role outside her branch
        Assert.Equal(HttpStatusCode.Forbidden, (await Move(mia, roles["Dev"], null)).Status);             // out of her branch to the top
        Assert.Equal(HttpStatusCode.Forbidden, (await Move(mia, roles["Dev"], roles["Boss"])).Status);    // under someone else's branch
        Assert.Equal(HttpStatusCode.NoContent, (await Move(mia, roles["Dev"], roles["DevOk"])).Status);   // within her branch
    }

    [Fact]
    public async Task A_delegate_cannot_change_her_own_manager_or_pull_people_into_her_line()
    {
        var (owner, mia, ben, cal, _) = await Delegate();
        Assert.Equal(HttpStatusCode.Forbidden, (await ReportsTo(mia, mia.UserId, owner.UserId)).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await ReportsTo(mia, ben.UserId, mia.UserId)).Status);    // gaining sight of Ben's work

        // Once an admin puts Ben in her line, she may arrange people inside it, but still not pull Cal in under Ben.
        Assert.Equal(HttpStatusCode.NoContent, (await ReportsTo(owner, ben.UserId, mia.UserId)).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await ReportsTo(mia, cal.UserId, ben.UserId)).Status);
        Assert.Equal(HttpStatusCode.NoContent, (await ReportsTo(owner, cal.UserId, mia.UserId)).Status);
        Assert.Equal(HttpStatusCode.NoContent, (await ReportsTo(mia, cal.UserId, ben.UserId)).Status);
    }

    [Fact]
    public async Task A_delegate_cannot_invite_or_create_people_into_a_role_above_her_own()
    {
        var (owner, mia, _, _, roles) = await Delegate();
        // Inviting needs members.invite: Lead's members level 2 gives it.
        var high = await mia.Post("/api/v1/workspace/invitations", new { email = $"x-{Guid.NewGuid():N}@example.com", role = "Member", orgRoleId = roles["Boss"] });
        Assert.Equal(HttpStatusCode.Forbidden, high.Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await mia.Post("/api/v1/workspace/invitations", new { email = $"y-{Guid.NewGuid():N}@example.com", role = "Member", orgRoleId = roles["DevPower"] })).Status);
        var ok = await mia.Post("/api/v1/workspace/invitations", new { email = $"z-{Guid.NewGuid():N}@example.com", role = "Member", orgRoleId = roles["Dev"] });
        Assert.True(ok.Ok, ok.ToString());

        // The owner is not limited.
        Assert.True((await owner.Post("/api/v1/workspace/invitations", new { email = $"w-{Guid.NewGuid():N}@example.com", role = "Member", orgRoleId = roles["Boss"] })).Ok);
    }

    [Fact]
    public async Task Owners_and_admins_still_place_anyone_including_themselves()
    {
        var (owner, mia, _, _, roles) = await Delegate();
        var ada = await owner.AddMemberAsync(factory, TenantRole.Admin, "Ada Admin");
        Assert.Equal(HttpStatusCode.NoContent, (await Assign(ada, ada.UserId, roles["Boss"])).Status);
        Assert.Equal(HttpStatusCode.NoContent, (await ReportsTo(ada, ada.UserId, owner.UserId)).Status);
        Assert.Equal(HttpStatusCode.NoContent, (await Assign(owner, owner.UserId, roles["Boss"])).Status);
        Assert.Equal(HttpStatusCode.NoContent, (await Assign(ada, mia.UserId, roles["DevPower"])).Status);
        Assert.Equal(HttpStatusCode.NoContent, (await Move(ada, roles["Dev"], null)).Status);
    }

    // ---------------------------------------------------------------- P2-3 cross-tenant user ids

    [Fact]
    public async Task An_incoming_webhook_cannot_raise_work_for_someone_outside_the_workspace()
    {
        var owner = await NewOrg();
        var stranger = await TestClient.RegisterAsync(factory, "Zed Outside");   // a member only of their own personal workspace
        var res = await owner.Post("/api/v1/incoming-webhooks", new { name = "Alerts", target = "ticket", assigneeId = stranger.UserId });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.Status);
        var ok = await owner.Post("/api/v1/incoming-webhooks", new { name = "Alerts", target = "ticket", assigneeId = owner.UserId });
        Assert.Equal(HttpStatusCode.Created, ok.Status);
    }

    // ---------------------------------------------------------------- P2-4 teams

    [Fact]
    public async Task A_manager_changes_members_only_of_teams_they_lead_and_cannot_add_themselves()
    {
        var owner = await NewOrg();
        var max = await owner.AddMemberAsync(factory, TenantRole.Manager, "Max Manager");   // managers have teams.manage by default
        var ben = await owner.AddMemberAsync(factory, TenantRole.Member, "Ben Dev");
        var team = Guid.Parse(S((await owner.Post("/api/v1/teams", new { name = "Platform" })).Data!["team"]!["id"]));

        Assert.Equal(HttpStatusCode.Forbidden, (await max.Post($"/api/v1/teams/{team}/members", new { userId = ben.UserId, isLead = false })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await max.Post($"/api/v1/teams/{team}/members", new { userId = max.UserId, isLead = true })).Status);

        Assert.True((await owner.Post($"/api/v1/teams/{team}/members", new { userId = max.UserId, isLead = true })).Ok);
        var added = await max.Post($"/api/v1/teams/{team}/members", new { userId = ben.UserId, isLead = false });
        Assert.True(added.Ok, added.ToString());
        Assert.True((await max.Delete($"/api/v1/teams/{team}/members/{ben.UserId}")).Ok);
    }

    // ---------------------------------------------------------------- P2-5 removing a member

    [Fact]
    public async Task Removing_a_member_takes_away_projects_teams_shares_chats_and_their_open_invitations()
    {
        var owner = await NewOrg();
        var ada = await owner.AddMemberAsync(factory, TenantRole.Admin, "Ada Admin");
        var tid = owner.WorkspaceId;
        var project = await owner.CreateProjectAsync("Atlas");
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = ada.UserId })).Ok);
        var team = Guid.Parse(S((await owner.Post("/api/v1/teams", new { name = "Core" })).Data!["team"]!["id"]));
        Assert.True((await owner.Post($"/api/v1/teams/{team}/members", new { userId = ada.UserId, isLead = false })).Ok);
        var group = await owner.Post("/api/v1/chat/conversations/group", new { name = "Ops", memberIds = new[] { ada.UserId } });
        Assert.Equal(HttpStatusCode.Created, group.Status);
        var groupId = Guid.Parse(S(group.Data!["id"]));
        Assert.True((await ada.Post($"/api/v1/chat/conversations/{groupId}/messages", new { body = "hello from Ada" })).Ok);
        var invitee = $"inv-{Guid.NewGuid():N}@example.com";
        Assert.True((await ada.Post("/api/v1/workspace/invitations", new { email = invitee, role = "Member" })).Ok);
        var brd = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "BRD")!["id"]));
        var doc = await owner.Post("/api/v1/documents", new { title = "Plan", typeId = brd });
        Assert.True(doc.Ok, doc.ToString());
        var docId = Guid.Parse(S(doc.Data!["item"]!["id"]));
        var share = await owner.Post($"/api/v1/documents/{docId}/grants", new { principalType = "User", principalId = ada.UserId, level = "Viewer", deny = false });
        Assert.True(share.Ok, share.ToString());
        factory.WithDb(db => { Assert.True(db.DocumentGrants.IgnoreQueryFilters().Any(g => g.DocumentId == docId && g.PrincipalId == ada.UserId)); return 0; });

        Assert.Equal(HttpStatusCode.NoContent, (await owner.Delete($"/api/v1/workspace/members/{ada.UserId}")).Status);

        factory.WithDb(db =>
        {
            Assert.False(db.ProjectMembers.IgnoreQueryFilters().Any(p => p.TenantId == tid && p.UserId == ada.UserId));
            Assert.False(db.TeamMembers.IgnoreQueryFilters().Any(p => p.TenantId == tid && p.UserId == ada.UserId));
            Assert.False(db.DocumentGrants.IgnoreQueryFilters().Any(g => g.TenantId == tid && g.PrincipalId == ada.UserId));
            Assert.False(db.ConversationMembers.IgnoreQueryFilters().Any(m => m.ConversationId == groupId && m.UserId == ada.UserId));
            Assert.True(db.ChatMessages.IgnoreQueryFilters().Any(m => m.ConversationId == groupId));   // what she said stays
            Assert.Equal(InvitationStatus.Revoked, db.TenantInvitations.IgnoreQueryFilters().Single(i => i.TenantId == tid && i.Email == invitee).Status);
            return 0;
        });
    }

    // ---------------------------------------------------------------- P2-8 / P3-9 permission matrix

    [Fact]
    public async Task The_permission_matrix_cannot_be_used_upwards_and_admin_essentials_are_locked()
    {
        var owner = await NewOrg();
        var ada = await owner.AddMemberAsync(factory, TenantRole.Admin, "Ada Admin");
        Assert.Equal(HttpStatusCode.Forbidden, (await ada.Put("/api/v1/workspace/permissions", new { role = "Admin", permission = "billing.manage", allowed = true })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await ada.Put("/api/v1/workspace/permissions", new { role = "Manager", permission = "members.manage", allowed = true })).Status);

        foreach (var p in new[] { "access.manage", "org.structure" })
            Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put("/api/v1/workspace/permissions", new { role = "Admin", permission = p, allowed = false })).Status);
        Assert.True((await owner.Put("/api/v1/workspace/permissions", new { role = "Admin", permission = "audit.view", allowed = false })).Ok);
        Assert.True((await owner.Put("/api/v1/workspace/permissions", new { role = "Manager", permission = "members.invite", allowed = true })).Ok);

        var matrix = (await owner.Get("/api/v1/workspace/permissions")).Data!;
        Assert.Contains("access.manage", matrix["adminLocked"]!.AsArray().Select(S));
    }

    // ---------------------------------------------------------------- P3-10 platform admin disabling an owner

    [Fact]
    public async Task A_platform_admin_cannot_disable_an_organization_owner_until_ownership_moves()
    {
        var admin = await TestClient.RegisterAsync(factory, "Platform Admin");
        factory.WithDb(db => { db.Users.First(u => u.Id == admin.UserId).IsPlatformAdmin = true; db.SaveChanges(); return 0; });
        var owner = await NewOrg();
        var loner = await TestClient.RegisterAsync(factory, "Lone User");   // owns only a personal workspace

        var refused = await admin.Put($"/api/v1/admin/users/{owner.UserId}/status", new { isActive = false });
        Assert.Equal(HttpStatusCode.Conflict, refused.Status);
        Assert.Equal("OWNER_MUST_TRANSFER", refused.ErrorCode);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.Put($"/api/v1/admin/users/{loner.UserId}/status", new { isActive = false })).Status);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.Put($"/api/v1/admin/users/{owner.UserId}/status", new { isActive = true })).Status);
    }

    // ---------------------------------------------------------------- P3-11 accepting an invitation

    [Fact]
    public async Task An_invitation_from_someone_who_was_demoted_is_refused_on_acceptance()
    {
        var owner = await NewOrg();
        var ada = await owner.AddMemberAsync(factory, TenantRole.Admin, "Ada Admin");
        var person = new TestClient(factory) { Email = $"user-{Guid.NewGuid():N}@example.com" };
        Assert.True((await ada.Post("/api/v1/workspace/invitations", new { email = person.Email, role = "Manager" })).Ok);
        Assert.True((await owner.Put($"/api/v1/workspace/members/{ada.UserId}", new { role = "Member" })).Ok);

        var reg = await person.Send(HttpMethod.Post, "/api/v1/auth/register", new { email = person.Email, password = "Passw0rd!x", displayName = "Nina New", acceptedTerms = true }, true);
        Assert.Equal(HttpStatusCode.Created, reg.Status);
        await person.VerifyEmailAsync();
        await person.LoginAsync();
        var accept = await person.Post("/api/v1/invitations/accept", new { token = await person.MailboxToken("invite") });
        Assert.Equal(HttpStatusCode.Conflict, accept.Status);
        Assert.Equal("INVITATION_INVALID", accept.ErrorCode);

        // An invitation from someone still allowed to send it works as before.
        Assert.True((await owner.AddMemberAsync(factory, TenantRole.Member, "Omar Ok")).UserId != Guid.Empty);
    }

    // ---------------------------------------------------------------- regression: members and guests on admin endpoints, cross-tenant ids

    [Fact]
    public async Task Members_and_guests_get_403_on_admin_endpoints_and_the_app_is_told_to_reload_its_access()
    {
        var owner = await NewOrg();
        var ben = await owner.AddMemberAsync(factory, TenantRole.Member, "Ben Member");
        var gus = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gus Guest");
        var role = await Role(owner, "Anything");

        foreach (var who in new[] { ben, gus })
        {
            var perm = await who.Put("/api/v1/workspace/permissions", new { role = "Member", permission = "projects.create", allowed = true });
            Assert.Equal(HttpStatusCode.Forbidden, perm.Status);
            Assert.Equal("1", perm.Header("X-Context-Stale"));
            Assert.Equal(HttpStatusCode.Forbidden, (await who.Post("/api/v1/workspace/members", new { email = $"n-{Guid.NewGuid():N}@example.com", displayName = "Nope", role = "Member", password = "Passw0rd!xyz1" })).Status);
            Assert.Equal(HttpStatusCode.Forbidden, (await who.Post("/api/v1/workspace/invitations", new { email = $"i-{Guid.NewGuid():N}@example.com", role = "Member" })).Status);
            Assert.Equal(HttpStatusCode.Forbidden, (await who.Get("/api/v1/org/access")).Status);
            Assert.Equal(HttpStatusCode.Forbidden, (await Assign(who, who.UserId, role)).Status);
            Assert.Equal(HttpStatusCode.Forbidden, (await who.Delete($"/api/v1/workspace/members/{owner.UserId}")).Status);
            Assert.Equal(HttpStatusCode.Forbidden, (await who.Get("/api/v1/admin/users")).Status);
        }

        // Ids from another organization are simply not there.
        var other = await NewOrg("Oscar Other");
        var foreignProject = await other.CreateProjectAsync("Secret");
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Get($"/api/v1/projects/{foreignProject}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await Assign(owner, other.UserId, role)).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await ReportsTo(owner, other.UserId, owner.UserId)).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Delete($"/api/v1/workspace/members/{other.UserId}")).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post("/api/v1/workspace/invitations", new { email = $"r-{Guid.NewGuid():N}@example.com", role = "Member", reportsToUserId = other.UserId })).Status);
    }
}
