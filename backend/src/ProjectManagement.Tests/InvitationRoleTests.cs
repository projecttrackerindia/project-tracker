using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>An invitation can carry a job role and a manager, so the person lands on the organization chart with the right access.</summary>
[Collection("api")]
public class InvitationRoleTests(ApiFactory factory)
{
    private async Task<(TestClient Owner, Guid RoleId)> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var role = await owner.Post("/api/v1/org/roles", new { name = "Developer" });
        return (owner, Guid.Parse(role.Data!["id"]!.GetValue<string>()));
    }

    /// <summary>Sends an invitation with the given extras and has a freshly registered user accept it.</summary>
    private async Task<(ApiResult Invite, TestClient? Person)> InviteAndAccept(TestClient owner, TenantRole tier, Guid? role, Guid? boss, bool accept = true)
    {
        var person = new TestClient(factory) { Email = $"user-{Guid.NewGuid():N}@example.com" };
        var invite = await owner.Post("/api/v1/workspace/invitations", new { email = person.Email, role = tier.ToString(), orgRoleId = role, reportsToUserId = boss });
        if (!invite.Ok || !accept) return (invite, null);
        var reg = await person.Send(HttpMethod.Post, "/api/v1/auth/register", new { email = person.Email, password = "Passw0rd!x", displayName = "Newcomer", acceptedTerms = true }, true);
        Assert.Equal(HttpStatusCode.Created, reg.Status);
        await person.VerifyEmailAsync();
        await person.LoginAsync();
        var token = await person.MailboxToken("invite");
        var joined = await person.Post("/api/v1/invitations/accept", new { token });
        Assert.True(joined.Ok, joined.ToString());
        await person.SwitchToAsync(owner.WorkspaceId);
        return (invite, person);
    }

    private static JsonNode Person(JsonNode org, Guid userId) => org["people"]!.AsArray().First(p => p!["userId"]!.GetValue<string>() == userId.ToString())!;

    [Fact]
    public async Task A_new_member_lands_on_the_chart_in_the_invited_role_under_the_invited_manager()
    {
        var (owner, dev) = await Setup();
        var (invite, person) = await InviteAndAccept(owner, TenantRole.Member, dev, owner.UserId);

        Assert.Equal("Developer", invite.Data!["jobRole"]!.GetValue<string>());
        Assert.NotNull(invite.Data["reportsTo"]);
        var placed = Person((await owner.Get("/api/v1/org")).Data!, person!.UserId);
        Assert.Equal(dev.ToString(), placed["roleId"]!.GetValue<string>());
        Assert.Equal(owner.UserId.ToString(), placed["reportsToUserId"]!.GetValue<string>());

        // The members list shows the job role.
        var row = (await owner.Get("/api/v1/workspace/members")).Data!.AsArray().First(m => m!["userId"]!.GetValue<string>() == person.UserId.ToString())!;
        Assert.Equal("Developer", row["jobRole"]!.GetValue<string>());
    }

    [Fact]
    public async Task The_invited_roles_access_applies_from_the_first_sign_in()
    {
        var (owner, dev) = await Setup();
        var levels = new[] { "projects", "tasks", "calendar", "teams", "members", "organization", "reports", "activity", "audit", "billing" }.ToDictionary(m => m, _ => 0);
        levels["projects"] = 1; levels["tasks"] = 1;
        Assert.True((await owner.Put($"/api/v1/org/roles/{dev}/access", new { modules = levels, actions = new Dictionary<string, bool>() })).Ok);

        var (_, person) = await InviteAndAccept(owner, TenantRole.Member, dev, null);
        Assert.True((await person!.Get("/api/v1/projects")).Ok);
        Assert.Equal(HttpStatusCode.Forbidden, (await person.Post("/api/v1/projects", new { name = "Nope", priority = "Low" })).Status);   // view-only role
        Assert.Equal(HttpStatusCode.Forbidden, (await person.Get("/api/v1/teams")).Status);                                                    // menu closed
        Assert.Equal(1, (await person.Get("/api/v1/me")).Data!["current"]!["modules"]!["projects"]!.GetValue<int>());
    }

    [Fact]
    public async Task Setting_a_role_needs_the_org_structure_permission_and_a_real_role_and_manager()
    {
        var (owner, dev) = await Setup();
        var manager = await owner.AddMemberAsync(factory, TenantRole.Manager, "Mia");           // may invite, may not edit the chart
        Assert.True((await owner.Put("/api/v1/workspace/permissions", new { role = "Manager", permission = "members.invite", allowed = true })).Ok);

        var plain = await manager.Post("/api/v1/workspace/invitations", new { email = $"a-{Guid.NewGuid():N}@example.com", role = "Member" });
        Assert.True(plain.Ok, plain.ToString());                                                // a plain invitation still works
        var refused = await manager.Post("/api/v1/workspace/invitations", new { email = $"b-{Guid.NewGuid():N}@example.com", role = "Member", orgRoleId = dev });
        Assert.Equal(HttpStatusCode.Forbidden, refused.Status);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post("/api/v1/workspace/invitations", new { email = $"c-{Guid.NewGuid():N}@example.com", role = "Member", orgRoleId = Guid.NewGuid() })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post("/api/v1/workspace/invitations", new { email = $"d-{Guid.NewGuid():N}@example.com", role = "Member", reportsToUserId = Guid.NewGuid() })).Status);

        // A manager from another organization is not a valid boss here.
        var (otherOwner, _) = await Setup();
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post("/api/v1/workspace/invitations", new { email = $"e-{Guid.NewGuid():N}@example.com", role = "Member", reportsToUserId = otherOwner.UserId })).Status);
    }

    [Fact]
    public async Task A_role_or_manager_that_disappeared_before_acceptance_just_means_starting_unplaced()
    {
        var (owner, dev) = await Setup();
        var boss = await owner.AddMemberAsync(factory, TenantRole.Member, "Bea");
        var person = new TestClient(factory) { Email = $"user-{Guid.NewGuid():N}@example.com" };
        Assert.True((await owner.Post("/api/v1/workspace/invitations", new { email = person.Email, role = "Member", orgRoleId = dev, reportsToUserId = boss.UserId })).Ok);

        // The role is deleted and the manager leaves before the invitation is accepted.
        Assert.True((await owner.Delete($"/api/v1/org/roles/{dev}")).Ok);
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Delete($"/api/v1/workspace/members/{boss.UserId}")).Status);

        var reg = await person.Send(HttpMethod.Post, "/api/v1/auth/register", new { email = person.Email, password = "Passw0rd!x", displayName = "Late", acceptedTerms = true }, true);
        Assert.Equal(HttpStatusCode.Created, reg.Status);
        await person.VerifyEmailAsync();
        await person.LoginAsync();
        var lookup = await person.Get($"/api/v1/invitations/lookup?token={Uri.EscapeDataString(await person.MailboxToken("invite"))}");
        Assert.Null(lookup.Data!["jobRole"]);                                                     // a deleted role is not advertised
        Assert.True((await person.Post("/api/v1/invitations/accept", new { token = await person.MailboxToken("invite") })).Ok);

        var placed = Person((await owner.Get("/api/v1/org")).Data!, person.UserId);
        Assert.Null(placed["roleId"]);
        Assert.Null(placed["reportsToUserId"]);
    }

    [Fact]
    public async Task Pending_invitations_and_the_lookup_page_show_the_role_and_manager()
    {
        var (owner, dev) = await Setup();
        var email = $"user-{Guid.NewGuid():N}@example.com";
        Assert.True((await owner.Post("/api/v1/workspace/invitations", new { email, role = "Member", orgRoleId = dev, reportsToUserId = owner.UserId })).Ok);

        var pending = (await owner.Get("/api/v1/workspace/invitations")).Data!.AsArray().First(i => i!["email"]!.GetValue<string>() == email)!;
        Assert.Equal("Developer", pending["jobRole"]!.GetValue<string>());
        Assert.False(string.IsNullOrEmpty(pending["reportsTo"]!.GetValue<string>()));

        var mail = (await owner.Send(HttpMethod.Get, "/api/v1/dev/emails", null, true)).Data!.AsArray()
            .First(m => string.Equals(m!["to"]!.GetValue<string>(), email, StringComparison.OrdinalIgnoreCase))!;
        Assert.Contains("Developer", mail["text"]!.GetValue<string>());
        Assert.Contains("Developer", mail["html"]!.GetValue<string>());
    }
}
