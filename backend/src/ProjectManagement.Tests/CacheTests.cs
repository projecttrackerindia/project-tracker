using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Distributed;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The shared cache of plans and entitlements: what it remembers, when it forgets, and that a broken cache never breaks requests.</summary>
[Collection("api")]
public class CacheTests(ApiFactory factory)
{
    private sealed class FakeClock(DateTimeOffset start) : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = start;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed class BrokenCache : IDistributedCache
    {
        public byte[]? Get(string key) => throw new InvalidOperationException("down");
        public Task<byte[]?> GetAsync(string key, CancellationToken token = default) => throw new InvalidOperationException("down");
        public void Set(string key, byte[] value, DistributedCacheEntryOptions options) => throw new InvalidOperationException("down");
        public Task SetAsync(string key, byte[] value, DistributedCacheEntryOptions options, CancellationToken token = default) => throw new InvalidOperationException("down");
        public void Refresh(string key) { }
        public Task RefreshAsync(string key, CancellationToken token = default) => Task.CompletedTask;
        public void Remove(string key) => throw new InvalidOperationException("down");
        public Task RemoveAsync(string key, CancellationToken token = default) => throw new InvalidOperationException("down");
    }

    private static EffectivePlan SamplePlan() => new(
        new Plan { Code = "PRO", Name = "Pro", PriceMonthly = 12m, Features = { new PlanFeature { FeatureKey = "TASK_LIMIT", Value = -1 } } },
        SubscriptionStatus.Active, null, DateTime.UtcNow.AddDays(20), false, false);

    private static EntitlementCache Make(IDistributedCache cache, TimeProvider time, int seconds = 30) =>
        new(cache, Options.Create(new CacheOptions { EntitlementSeconds = seconds }), time);

    private static IDistributedCache Memory(TimeProvider time) => new MemoryDistributedCache(Options.Create(new MemoryDistributedCacheOptions { Clock = new Clock(time) }));

    private sealed class Clock(TimeProvider time) : Microsoft.Extensions.Internal.ISystemClock
    {
        public DateTimeOffset UtcNow => time.GetUtcNow();
    }

    // ------------------------------------------------------------------ the cache itself

    [Fact]
    public async Task A_stored_plan_comes_back_intact_and_is_forgotten_when_told_to()
    {
        var clock = new FakeClock(DateTimeOffset.UtcNow);
        var cache = Make(Memory(clock), clock);
        var tenant = Guid.NewGuid();
        Assert.Null(await cache.GetPlanAsync(tenant, default));

        await cache.SetPlanAsync(tenant, SamplePlan(), default);
        var back = await cache.GetPlanAsync(tenant, default);
        Assert.Equal("PRO", back!.Plan.Code);
        Assert.Equal(12m, back.Plan.PriceMonthly);
        Assert.Equal(-1, back.Plan.Features.Single().Value);
        Assert.Equal(SubscriptionStatus.Active, back.Status);
        Assert.Null(await cache.GetPlanAsync(Guid.NewGuid(), default));    // another workspace has its own entry

        await cache.InvalidateTenantAsync(tenant);
        Assert.Null(await cache.GetPlanAsync(tenant, default));
    }

    [Fact]
    public async Task Entries_expire_and_never_outlive_a_trial_or_exception_that_ends_sooner()
    {
        var clock = new FakeClock(DateTimeOffset.UtcNow);
        var cache = Make(Memory(clock), clock, seconds: 30);
        var tenant = Guid.NewGuid();

        await cache.SetEntitlementsAsync(tenant, new() { ["API_ACCESS"] = 1 }, null, default);
        clock.Now = clock.Now.AddSeconds(29);
        Assert.NotNull(await cache.GetEntitlementsAsync(tenant, default));
        clock.Now = clock.Now.AddSeconds(2);
        Assert.Null(await cache.GetEntitlementsAsync(tenant, default));      // the normal lifetime is 30 s

        // An exception that ends in 5 s is remembered for 5 s, not 30.
        await cache.SetEntitlementsAsync(tenant, new() { ["API_ACCESS"] = 1 }, clock.Now.UtcDateTime.AddSeconds(5), default);
        clock.Now = clock.Now.AddSeconds(6);
        Assert.Null(await cache.GetEntitlementsAsync(tenant, default));
    }

    [Fact]
    public async Task Changing_a_plan_definition_makes_every_cached_plan_stale_at_once_and_zero_seconds_switches_it_off()
    {
        var clock = new FakeClock(DateTimeOffset.UtcNow);
        var cache = Make(Memory(clock), clock);
        var tenant = Guid.NewGuid();
        await cache.SetPlanAsync(tenant, SamplePlan(), default);
        cache.InvalidateAllPlans();
        Assert.Null(await cache.GetPlanAsync(tenant, default));

        var off = Make(Memory(clock), clock, seconds: 0);
        Assert.False(off.Enabled);
        await off.SetPlanAsync(tenant, SamplePlan(), default);
        Assert.Null(await off.GetPlanAsync(tenant, default));
    }

    [Fact]
    public async Task A_cache_that_is_down_costs_speed_never_correctness()
    {
        var cache = Make(new BrokenCache(), TimeProvider.System);
        var tenant = Guid.NewGuid();
        await cache.SetPlanAsync(tenant, SamplePlan(), default);          // does not throw
        Assert.Null(await cache.GetPlanAsync(tenant, default));           // reads as a miss
        await cache.InvalidateTenantAsync(tenant);                         // does not throw
    }

    // ------------------------------------------------------------------ inside the running app

    [Fact]
    public async Task Plan_changes_and_platform_exceptions_show_up_at_once_while_the_cache_is_on()
    {
        var options = factory.Services.GetRequiredService<IOptions<CacheOptions>>().Value;
        options.EntitlementSeconds = 60;
        try
        {
            var c = await TestClient.RegisterAsync(factory);
            var org = await c.CreateOrgAsync();
            Assert.Equal(0, (await c.Get("/api/v1/me")).Data!["current"]!["entitlements"]!["API_ACCESS"]!.GetValue<int>());   // now remembered

            // Through the app, a plan change invalidates the entry immediately.
            await c.UpgradeAsync("BUSINESS");
            Assert.Equal(1, (await c.Get("/api/v1/me")).Data!["current"]!["entitlements"]!["API_ACCESS"]!.GetValue<int>());
            Assert.Equal(HttpStatusCode.Created, (await c.Post("/api/v1/api-keys", new { name = "k", scope = "ReadOnly" })).Status);

            // A platform administrator's exception is also picked up at once.
            var (admin, tenant) = await AdminAndOrg();
            Assert.Equal(0, (await tenant.Get("/api/v1/me")).Data!["current"]!["entitlements"]!["API_ACCESS"]!.GetValue<int>());
            Assert.True((await admin.Put($"/api/v1/admin/tenants/{tenant.WorkspaceId}/overrides/API_ACCESS", new { value = 1, reason = "trial period" })).Ok);
            Assert.Equal(1, (await tenant.Get("/api/v1/me")).Data!["current"]!["entitlements"]!["API_ACCESS"]!.GetValue<int>());
            _ = org;
        }
        finally { options.EntitlementSeconds = 0; }
    }

    [Fact]
    public async Task Health_reports_the_cache_and_probes_it()
    {
        var admin = await TestClient.RegisterAsync(factory);
        factory.WithDb(db => { db.Users.Where(u => u.Id == admin.UserId).ExecuteUpdate(s => s.SetProperty(u => u.IsPlatformAdmin, true)); return 0; });
        await admin.LoginAsync();
        var cache = (await admin.Get("/api/v1/admin/health")).Data!["cache"]!;
        Assert.True(cache["reachable"]!.GetValue<bool>());
        Assert.Contains("Memory", cache["provider"]!.GetValue<string>());
    }

    private async Task<(TestClient Admin, TestClient Tenant)> AdminAndOrg()
    {
        var admin = await TestClient.RegisterAsync(factory, "Admin");
        factory.WithDb(db => { db.Users.Where(u => u.Id == admin.UserId).ExecuteUpdate(s => s.SetProperty(u => u.IsPlatformAdmin, true)); return 0; });
        await admin.LoginAsync();
        var tenant = await TestClient.RegisterAsync(factory);
        await tenant.CreateOrgAsync();
        return (admin, tenant);
    }
}
