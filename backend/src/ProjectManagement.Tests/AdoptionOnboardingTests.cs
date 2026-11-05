using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The welcome tour's sample project: added once, with fictional tasks, and removed in one click.</summary>
[Collection("api")]
public class AdoptionOnboardingTests(ApiFactory factory)
{
    [Fact]
    public async Task The_sample_project_is_added_once_and_removed_in_one_click()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        Assert.False((await c.Get("/api/v1/onboarding/sample-project")).Data!["exists"]!.GetValue<bool>());

        var added = await c.Post("/api/v1/onboarding/sample-project");
        Assert.True(added.Ok, added.ToString());
        var pid = added.Data!["projectId"]!.GetValue<string>();
        Assert.Equal(6, added.Data["tasks"]!.GetValue<int>());
        var tasks = (await c.Get($"/api/v1/projects/{pid}/tasks?pageSize=50")).Data!["items"]!.AsArray();
        Assert.Equal(6, tasks.Count);
        Assert.Equal("SAMPLE_EXISTS", (await c.Post("/api/v1/onboarding/sample-project")).ErrorCode);

        var removed = await c.Delete("/api/v1/onboarding/sample-project");
        Assert.True(removed.Ok, removed.ToString());
        Assert.False((await c.Get("/api/v1/onboarding/sample-project")).Data!["exists"]!.GetValue<bool>());
        Assert.False((await c.Get($"/api/v1/projects/{pid}")).Ok);

        // The tour remembers where the person is, with their account.
        Assert.True((await c.Put("/api/v1/me/ui/onboarding", new { value = new { step = 3, done = true } })).Ok);
        Assert.True((await c.Get("/api/v1/me/ui/onboarding")).Data!["value"]!["done"]!.GetValue<bool>());
    }
}
