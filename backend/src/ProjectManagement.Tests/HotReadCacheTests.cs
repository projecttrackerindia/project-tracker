using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Persistence;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Hot reads (shell summary, portfolio board, project health, dashboard, reports) are cached per person and forgotten the moment anything
/// in the workspace changes: a write request, another person's write, or a save made outside any request.
/// </summary>
[Collection("api")]
public class HotReadCacheTests(ApiFactory factory)
{
    private HotReadCache Cache => factory.Services.GetRequiredService<HotReadCache>();
    private static string? State(ApiResult r) => r.Headers?.GetValueOrDefault("X-Hot-Cache");

    private async Task<T> WithCacheOn<T>(Func<Task<T>> body)
    {
        Cache.Seconds = 300;
        try { return await body(); } finally { Cache.Seconds = 0; }
    }

    private async Task<(TestClient Owner, Guid Project)> SetUpAsync(string name)
    {
        var owner = await TestClient.RegisterAsync(factory, name);
        await owner.CreateOrgAsync(name + " Org");
        await owner.UpgradeAsync("BUSINESS");
        var project = await owner.CreateProjectAsync(name + " project");
        await owner.CreateTaskAsync(project, "First task");
        return (owner, project);
    }

    [Fact]
    public Task A_second_read_is_served_from_the_cache_and_a_write_forgets_it_at_once() => WithCacheOn(async () =>
    {
        var (owner, project) = await SetUpAsync("Hot Owner");
        var url = $"/api/v1/projects/{project}/health";
        var first = await owner.Get(url);
        Assert.Equal(HttpStatusCode.OK, first.Status);
        Assert.Equal("miss", State(first));
        var second = await owner.Get(url);
        Assert.Equal("hit", State(second));
        Assert.Equal(first.Data!.ToJsonString(), second.Data!.ToJsonString());

        Assert.Equal(HttpStatusCode.OK, (await owner.Put(url, new { health = "Delayed", note = "Vendor late" })).Status);
        var after = await owner.Get(url);
        Assert.Equal("miss", State(after));
        Assert.Contains("Vendor late", after.Data!.ToJsonString());
        return true;
    });

    [Fact]
    public Task Every_hot_screen_is_cached_per_person() => WithCacheOn(async () =>
    {
        var (owner, _) = await SetUpAsync("Hot Screens");
        foreach (var url in new[] { "/api/v1/shell/summary", "/api/v1/dashboard", "/api/v1/portfolio/board", "/api/v1/reports/summary?days=7" })
        {
            Assert.Equal("miss", State(await owner.Get(url)));
            var again = await owner.Get(url);
            Assert.Equal(HttpStatusCode.OK, again.Status);
            Assert.Equal("hit", State(again));
        }
        // Another person in the same workspace never gets the owner's answer.
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Hot Member");
        Assert.NotEqual("hit", State(await member.Get("/api/v1/shell/summary")));
        return true;
    });

    [Fact]
    public Task Another_persons_change_and_a_save_outside_a_request_both_invalidate() => WithCacheOn(async () =>
    {
        var (owner, project) = await SetUpAsync("Hot Team");
        var member = await owner.AddMemberAsync(factory, TenantRole.Admin, "Hot Admin");
        await owner.Get("/api/v1/dashboard");
        Assert.Equal("hit", State(await owner.Get("/api/v1/dashboard")));

        await member.CreateTaskAsync(project, "Added by someone else", new { title = "Added by someone else" });
        Assert.Equal("miss", State(await owner.Get("/api/v1/dashboard")));
        Assert.Equal("hit", State(await owner.Get("/api/v1/dashboard")));

        // A save made by a background job (no request): the save hook (where realtime change events are published) forgets it too.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var row = await db.Projects.IgnoreQueryFilters().FirstAsync(p => p.Id == project);
            row.Description = "Changed by a worker";
            await db.SaveChangesAsync();
        }
        Assert.Equal("miss", State(await owner.Get("/api/v1/dashboard")));
        return true;
    });

    [Fact]
    public Task A_refused_request_is_never_answered_from_the_cache() => WithCacheOn(async () =>
    {
        var (owner, project) = await SetUpAsync("Hot Guard");
        await owner.Get($"/api/v1/projects/{project}/health");
        var stranger = await TestClient.RegisterAsync(factory, "Hot Stranger");
        await stranger.CreateOrgAsync("Elsewhere");
        var r = await stranger.Get($"/api/v1/projects/{project}/health");
        Assert.NotEqual(HttpStatusCode.OK, r.Status);
        Assert.NotEqual("hit", State(r));
        return true;
    });
}
