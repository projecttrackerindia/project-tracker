using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Which projects the project list returns. Owners, Admins and Managers oversee the organization and get every project (the Projects page
/// asks for that); the page narrows to "my projects" (mineOnly) for them on request, and always for Members. Guests only ever see the
/// projects they were added to.
/// </summary>
[Collection("api")]
public class ProjectVisibilityTests(ApiFactory factory)
{
    private static async Task<string[]> Keys(TestClient c, bool mineOnly)
    {
        var res = await c.Get($"/api/v1/projects?pageSize=50{(mineOnly ? "&mineOnly=true" : "")}");
        Assert.True(res.Ok, res.ToString());
        return res.Data!["items"]!.AsArray().Select(p => p!["name"]!.GetValue<string>()).OrderBy(x => x).ToArray();
    }

    [Fact]
    public async Task Owner_admin_and_manager_can_list_every_project_of_the_organization_and_narrow_to_their_own()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var admin = await owner.AddMemberAsync(factory, TenantRole.Admin);
        var manager = await owner.AddMemberAsync(factory, TenantRole.Manager);
        var member = await owner.AddMemberAsync(factory, TenantRole.Member);
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest);

        // Three projects the owner created; the manager, the member and the guest are each added to a different one.
        async Task<Guid> Project(string name, params TestClient[] members)
        {
            var res = await owner.Post("/api/v1/projects", new { name, priority = "Low", memberIds = members.Select(m => m.UserId).ToArray() });
            Assert.True(res.Ok, res.ToString());
            return Guid.Parse(res.Data!["project"]!["id"]!.GetValue<string>());
        }
        await Project("Alpha", manager);
        await Project("Beta", member);
        await Project("Gamma", guest);
        var all = new[] { "Alpha", "Beta", "Gamma" };

        // Everyone who oversees the organization gets all of it...
        Assert.Equal(all, await Keys(owner, false));
        Assert.Equal(all, await Keys(admin, false));
        Assert.Equal(all, await Keys(manager, false));
        // ...and can still ask for just the ones they belong to (the "My projects" switch): the owner made all three, so all three are theirs;
        // the admin belongs to none of them; the manager to Alpha.
        Assert.Equal(all, await Keys(owner, true));
        Assert.Empty(await Keys(admin, true));
        Assert.Equal(new[] { "Alpha" }, await Keys(manager, true));

        // A member's page asks for their own projects only; a guest only ever sees the ones they were added to, whatever they ask for.
        Assert.Equal(new[] { "Beta" }, await Keys(member, true));
        Assert.Equal(new[] { "Gamma" }, await Keys(guest, false));
        Assert.Equal(new[] { "Gamma" }, await Keys(guest, true));
    }
}
