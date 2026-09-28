using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The "has my access changed?" check that lets menus follow permission changes without a page reload.</summary>
[Collection("api")]
public class AccessFingerprintTests(ApiFactory factory)
{
    private static async Task<string> Print(TestClient c)
    {
        var res = await c.Get("/api/v1/me/fingerprint");
        Assert.True(res.Ok, res.ToString());
        return res.Data!["fingerprint"]!.GetValue<string>();
    }

    [Fact]
    public async Task The_fingerprint_is_stable_and_matches_the_context_the_app_loads()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        await c.UpgradeAsync("PRO");
        var first = await Print(c);
        Assert.Equal(first, await Print(c));
        Assert.Equal(first, (await c.Get("/api/v1/me")).Data!["fingerprint"]!.GetValue<string>());
        Assert.Equal(24, first.Length);

        // Things that change all the time do not count: a new member joining or a new project changes nothing about my own access.
        await c.AddMemberAsync(factory, TenantRole.Member, "Newcomer");
        await c.CreateProjectAsync("Another");
        Assert.Equal(first, await Print(c));
    }

    [Fact]
    public async Task It_changes_when_the_persons_role_changes()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mem");
        var before = await Print(member);

        var res = await owner.Put($"/api/v1/workspace/members/{member.UserId}", new { role = "Admin" });
        Assert.True(res.Ok, res.ToString());
        Assert.NotEqual(before, await Print(member));
    }

    [Fact]
    public async Task It_changes_when_a_job_role_changes_what_someone_may_open()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mem");
        var role = Guid.Parse((await owner.Post("/api/v1/org/roles", new { name = "Viewer" })).Data!["id"]!.GetValue<string>());
        Assert.Equal(System.Net.HttpStatusCode.NoContent, (await owner.Put($"/api/v1/org/members/{member.UserId}/role", new { roleId = role })).Status);
        var before = await Print(member);

        var names = ((System.Text.Json.Nodes.JsonObject)(await owner.Get("/api/v1/me")).Data!["current"]!["modules"]!).Select(kv => kv.Key).ToList();
        var modules = names.ToDictionary(m => m, _ => 0);
        modules["tasks"] = 1;
        Assert.True((await owner.Put($"/api/v1/org/roles/{role}/access", new { modules, actions = new Dictionary<string, bool>() })).Ok);
        var after = await Print(member);
        Assert.NotEqual(before, after);
        Assert.Equal(after, await Print(member));
    }

    [Fact]
    public async Task It_changes_when_the_plan_changes()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        var before = await Print(owner);
        await owner.UpgradeAsync("PRO");
        Assert.NotEqual(before, await Print(owner));
    }

    [Fact]
    public async Task It_is_only_about_the_caller_and_needs_a_sign_in()
    {
        var a = await TestClient.RegisterAsync(factory); await a.CreateOrgAsync();
        var b = await TestClient.RegisterAsync(factory); await b.CreateOrgAsync();
        Assert.NotEqual(await Print(a), await Print(b));
        var anonymous = new TestClient(factory);
        Assert.Equal(System.Net.HttpStatusCode.Unauthorized, (await anonymous.Get("/api/v1/me/fingerprint")).Status);
    }
}
