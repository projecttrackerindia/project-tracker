using System.Net;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Sign-up creates exactly the one workspace the person chose: personal, organisation, or none when they join by invitation.</summary>
[Collection("api")]
public class SignupWorkspaceChoiceTests(ApiFactory factory)
{
    private async Task<(TestClient Client, ApiResult Reg)> Register(object extra)
    {
        var c = new TestClient(factory) { Email = $"choice-{Guid.NewGuid():N}@example.com" };
        var body = new Dictionary<string, object?> { ["email"] = c.Email, ["password"] = "Passw0rd!x", ["displayName"] = "Chooser", ["acceptedTerms"] = true };
        foreach (var p in extra.GetType().GetProperties()) body[p.Name] = p.GetValue(extra);
        var reg = await c.Send(HttpMethod.Post, "/api/v1/auth/register", body, true);
        return (c, reg);
    }

    private static async Task<List<(string Name, string Type)>> Workspaces(TestClient c)
    {
        await c.VerifyEmailAsync();
        Assert.True((await c.LoginAsync()).Ok);
        return (await c.Get("/api/v1/workspaces")).Data!.AsArray()
            .Select(w => (w!["name"]!.GetValue<string>(), w["type"]!.GetValue<string>())).ToList();
    }

    [Fact]
    public async Task Choosing_an_organisation_creates_only_that_organisation()
    {
        var (c, reg) = await Register(new { workspaceType = "organization", organizationName = "Five Star Test Ltd" });
        Assert.Equal(HttpStatusCode.Created, reg.Status);
        var list = await Workspaces(c);
        var only = Assert.Single(list);
        Assert.Equal("Five Star Test Ltd", only.Name);
        Assert.Equal("Organization", only.Type);
    }

    [Fact]
    public async Task Choosing_personal_or_nothing_creates_only_a_personal_workspace()
    {
        foreach (var extra in new object[] { new { workspaceType = "personal" }, new { } })
        {
            var (c, reg) = await Register(extra);
            Assert.Equal(HttpStatusCode.Created, reg.Status);
            var only = Assert.Single(await Workspaces(c));
            Assert.Equal("Personal", only.Type);
        }
    }

    [Fact]
    public async Task An_organisation_needs_a_name()
    {
        var (_, reg) = await Register(new { workspaceType = "organization", organizationName = " " });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, reg.Status);
        Assert.Equal("organizationName", reg.Json!["errors"]![0]!["field"]!.GetValue<string>());
    }

    [Fact]
    public async Task Invited_without_a_pending_invitation_still_gets_a_workspace_of_their_own()
    {
        var (c, reg) = await Register(new { workspaceType = "invited" });
        Assert.Equal(HttpStatusCode.Created, reg.Status);
        Assert.Equal("Personal", Assert.Single(await Workspaces(c)).Type);
    }
}
