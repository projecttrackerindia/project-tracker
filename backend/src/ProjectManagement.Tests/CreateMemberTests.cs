using System.Net;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>An organization administrator can create a user directly (next to inviting by email); the person must replace the first password.</summary>
[Collection("api")]
public class CreateMemberTests(ApiFactory factory)
{
    private const string Temp = "Temp0rary!Pass9";
    private const string Own = "Chosen#Secret42x";

    private async Task<TestClient> Owner(string plan = "PRO")
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        if (plan != "FREE") await c.UpgradeAsync(plan);
        return c;
    }

    private static object Body(string email, string role = "Member", string password = Temp, string name = "New Person") =>
        new { email, displayName = name, role, password };

    private static string NewEmail() => $"created-{Guid.NewGuid():N}@example.com";

    /// <summary>Signs the created person in with the password they were given and returns their client (still locked to the password change).</summary>
    private async Task<TestClient> SignIn(string email, string password = Temp)
    {
        var person = new TestClient(factory) { Email = email };
        var login = await person.LoginAsync(password);
        Assert.True(login.Ok, login.ToString());
        return person;
    }

    /// <summary>Like the app does: terms published by the platform are accepted first (changing the password is a write the terms gate would refuse).</summary>
    private static async Task AcceptPendingTerms(TestClient person)
    {
        var pending = (await person.Get("/api/v1/consent/status")).Data!;
        if (!pending["upToDate"]!.GetValue<bool>())
            Assert.True((await person.Post("/api/v1/consent/accept", new { types = pending["pending"]!.AsArray().Select(d => d!["type"]!.GetValue<string>()).ToArray() })).Ok);
    }

    private static async Task ChooseOwnPassword(TestClient person, string current = Temp, string next = Own)
    {
        await AcceptPendingTerms(person);
        var res = await person.Post("/api/v1/me/password", new { currentPassword = current, newPassword = next });
        Assert.True(res.Ok, res.ToString());
    }

    [Fact]
    public async Task An_admin_creates_a_user_who_can_do_nothing_until_they_choose_their_own_password()
    {
        var owner = await Owner();
        var email = NewEmail();
        var made = await owner.Post("/api/v1/workspace/members", Body(email, "Manager"));
        Assert.Equal(HttpStatusCode.Created, made.Status);
        Assert.Equal("Manager", made.Data!["role"]!.GetValue<string>());
        Assert.Equal(email, made.Data["email"]!.GetValue<string>());
        Assert.Contains((await owner.Get("/api/v1/workspace/members")).Data!.AsArray(), m => m!["email"]!.GetValue<string>() == email);

        // They can sign in straight away (no email verification step) and land in the organization.
        var person = await SignIn(email);
        var me = (await person.Get("/api/v1/me")).Data!;
        Assert.True(me["user"]!["mustChangePassword"]!.GetValue<bool>());
        Assert.True(me["user"]!["emailVerified"]!.GetValue<bool>());
        Assert.NotNull(me["current"]);
        Assert.Equal(owner.WorkspaceId.ToString(), me["current"]!["id"]!.GetValue<string>());

        // Everything else is refused until they replace the password, and reusing the temporary one is not a replacement.
        await AcceptPendingTerms(person);
        var blocked = await person.Get("/api/v1/projects");
        Assert.Equal(HttpStatusCode.Forbidden, blocked.Status);
        Assert.Equal("PASSWORD_CHANGE_REQUIRED", blocked.ErrorCode);
        Assert.Equal("PASSWORD_CHANGE_REQUIRED", (await person.Post("/api/v1/projects", new { name = "x", priority = "Low" })).ErrorCode);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await person.Post("/api/v1/me/password", new { currentPassword = Temp, newPassword = Temp })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await person.Post("/api/v1/me/password", new { currentPassword = "wrong", newPassword = Own })).Status);

        await ChooseOwnPassword(person);
        Assert.True((await person.Get("/api/v1/projects")).Ok);
        Assert.False((await person.Get("/api/v1/me")).Data!["user"]!["mustChangePassword"]!.GetValue<bool>());

        // The temporary password no longer works; the chosen one does.
        Assert.Equal(HttpStatusCode.Unauthorized, (await new TestClient(factory) { Email = email }.LoginAsync(Temp)).Status);
        Assert.True((await new TestClient(factory) { Email = email }.LoginAsync(Own)).Ok);
    }

    [Fact]
    public async Task The_person_is_told_by_email_but_the_password_is_never_sent_or_recorded()
    {
        var owner = await Owner("BUSINESS");
        var email = NewEmail();
        Assert.True((await owner.Post("/api/v1/workspace/members", Body(email))).Ok);

        var mails = (await owner.Send(HttpMethod.Get, "/api/v1/dev/emails", null, true)).Data!.AsArray()
            .Where(m => string.Equals(m!["to"]!.GetValue<string>(), email, StringComparison.OrdinalIgnoreCase)).ToList();
        Assert.Single(mails);
        var text = mails[0]!.ToJsonString();
        Assert.Contains("created an account for you", text);
        Assert.DoesNotContain(Temp, text);

        var trail = (await owner.Get("/api/v1/audit-logs")).Data!.ToJsonString();
        Assert.Contains("member.created", trail);
        Assert.DoesNotContain(Temp, trail);
        Assert.DoesNotContain(Temp, (await owner.Get($"/api/v1/projects")).Data!.ToJsonString());
    }

    [Fact]
    public async Task An_existing_account_is_never_taken_over_it_has_to_be_invited_instead()
    {
        var owner = await Owner();
        var someone = await TestClient.RegisterAsync(factory);
        var res = await owner.Post("/api/v1/workspace/members", Body(someone.Email));
        Assert.Equal(HttpStatusCode.Conflict, res.Status);
        Assert.Equal("ACCOUNT_EXISTS", res.ErrorCode);

        // The same address twice: the second is an existing account by then.
        var email = NewEmail();
        Assert.True((await owner.Post("/api/v1/workspace/members", Body(email))).Ok);
        Assert.Equal("ACCOUNT_EXISTS", (await owner.Post("/api/v1/workspace/members", Body(email))).ErrorCode);
    }

    [Fact]
    public async Task The_first_password_has_to_satisfy_the_password_policy_and_the_details_have_to_be_valid()
    {
        var owner = await Owner();
        Assert.False((await owner.Post("/api/v1/workspace/members", Body(NewEmail(), password: "short"))).Ok);
        Assert.False((await owner.Post("/api/v1/workspace/members", Body(NewEmail(), password: "password123"))).Ok);   // a common password
        Assert.False((await owner.Post("/api/v1/workspace/members", Body("not-an-email"))).Ok);
        Assert.False((await owner.Post("/api/v1/workspace/members", Body(NewEmail(), name: ""))).Ok);
        Assert.False((await owner.Post("/api/v1/workspace/members", Body(NewEmail(), role: "Owner"))).Ok);                // ownership cannot be handed out
        var name = "Priya Sharma";
        Assert.False((await owner.Post("/api/v1/workspace/members", Body($"priya.sharma-{Guid.NewGuid():N}@example.com", password: "Priya#Sharma2026", name: name))).Ok);   // contains the person's name
        Assert.Equal(1, (await owner.Get("/api/v1/workspace/members")).Data!.AsArray().Count);    // nothing was created by any of that
    }

    [Fact]
    public async Task Only_people_who_manage_members_can_create_users_and_never_a_role_above_their_own()
    {
        var owner = await Owner("BUSINESS");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Post("/api/v1/workspace/members", Body(NewEmail()))).Status);

        // An admin created directly can create people below their rank, but not their own rank.
        var adminEmail = NewEmail();
        Assert.True((await owner.Post("/api/v1/workspace/members", Body(adminEmail, "Admin"))).Ok);
        var admin = await SignIn(adminEmail);
        await ChooseOwnPassword(admin);
        admin = await SignIn(adminEmail, Own);
        Assert.Equal(HttpStatusCode.Forbidden, (await admin.Post("/api/v1/workspace/members", Body(NewEmail(), "Admin"))).Status);
        Assert.True((await admin.Post("/api/v1/workspace/members", Body(NewEmail(), "Member"))).Ok);
    }

    [Fact]
    public async Task Creating_a_user_counts_against_the_plan_and_needs_an_organization()
    {
        var free = await Owner("FREE");          // Free: the owner is the only member
        var res = await free.Post("/api/v1/workspace/members", Body(NewEmail()));
        Assert.Equal("PLAN_LIMIT_REACHED", res.ErrorCode);

        var personal = await TestClient.RegisterAsync(factory);   // a personal workspace cannot have other members
        Assert.Equal("PERSONAL_WORKSPACE", (await personal.Post("/api/v1/workspace/members", Body(NewEmail()))).ErrorCode);
    }

    [Fact]
    public async Task Creating_a_user_replaces_a_pending_invitation_for_the_same_address()
    {
        var owner = await Owner();
        var email = NewEmail();
        Assert.True((await owner.Post("/api/v1/workspace/invitations", new { email, role = "Member" })).Ok);
        Assert.Single((await owner.Get("/api/v1/workspace/invitations")).Data!.AsArray());

        Assert.True((await owner.Post("/api/v1/workspace/members", Body(email))).Ok);
        Assert.Empty((await owner.Get("/api/v1/workspace/invitations")).Data!.AsArray());
    }

    [Fact]
    public async Task The_new_person_can_be_placed_on_the_organization_chart_straight_away()
    {
        var owner = await Owner();
        var email = NewEmail();
        var role = await owner.Post("/api/v1/org/roles", new { name = "Developer", parentRoleId = (Guid?)null });
        Assert.True(role.Ok, role.ToString());
        var roleId = role.Data!["id"]!.GetValue<string>();
        var res = await owner.Post("/api/v1/workspace/members", new { email, displayName = "Dev Person", role = "Member", password = Temp, orgRoleId = roleId, reportsToUserId = owner.UserId });
        Assert.True(res.Ok, res.ToString());
        Assert.Equal("Developer", res.Data!["jobRole"]!.GetValue<string>());
    }
}
