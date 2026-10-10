using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public sealed class AiRequestLimitApiTests(ApiFactory factory)
{
    private async Task<TestClient> Owner(string plan = "FREE")
    {
        factory.Chat.Reset(); factory.Chat.Configured = true;
        var owner = await TestClient.RegisterAsync(factory); await owner.CreateOrgAsync();
        if (plan == "ENTERPRISE")
            factory.WithDb(db => { var sub = db.Subscriptions.Single(s => s.TenantId == owner.WorkspaceId); sub.PlanId = db.Plans.Single(p => p.Code == plan).Id; db.SaveChanges(); return 0; });
        else if (plan != "FREE") await owner.UpgradeAsync(plan);
        return owner;
    }

    [Theory]
    [InlineData("FREE", 5, 30, 100, 1)]
    [InlineData("PRO", 10, 120, 500, 1)]
    [InlineData("BUSINESS", 20, 300, 1500, 2)]
    [InlineData("ENTERPRISE", 30, 600, 3000, 3)]
    public async Task Usage_discloses_the_effective_plans_per_person_caps(string plan, int minute, int hour, int day, int concurrent)
    {
        var owner = await Owner(plan);
        try
        {
            var usage = (await owner.Get("/api/v1/ai/usage")).Data!["requestLimits"]!;
            Assert.Equal(plan, usage["planCode"]!.GetValue<string>());
            Assert.Equal(minute, usage["perMinute"]!.GetValue<int>());
            Assert.Equal(hour, usage["perHour"]!.GetValue<int>());
            Assert.Equal(day, usage["perDay"]!.GetValue<int>());
            Assert.Equal(concurrent, usage["concurrent"]!.GetValue<int>());
        }
        finally
        {
            // Catalog tests recreate Enterprise; do not leave a subscription holding a foreign-key reference to that plan.
            if (plan == "ENTERPRISE") factory.WithDb(db => { var sub = db.Subscriptions.Single(s => s.TenantId == owner.WorkspaceId); sub.PlanId = db.Plans.Single(p => p.Code == "FREE").Id; db.SaveChanges(); return 0; });
        }
    }

    [Fact]
    public async Task Chat_and_legacy_endpoints_share_caps_and_return_retry_after_before_saving_questions()
    {
        var owner = await Owner();
        owner.Extra["Origin"] = "http://localhost:5173";
        for (var i = 0; i < 5; i++) Assert.Equal(HttpStatusCode.OK, (await owner.Post("/api/v1/ai/ask", new { text = "hello" })).Status);
        var rejected = await owner.Post("/api/v1/ai/search", new { query = "overdue tasks" });
        Assert.Equal(HttpStatusCode.TooManyRequests, rejected.Status); Assert.Equal("AI_MINUTE_LIMIT", rejected.ErrorCode);
        Assert.True(int.Parse(rejected.Header("Retry-After")!) is >= 1 and <= 60);
        Assert.Contains("Retry-After", rejected.Header("Access-Control-Expose-Headers"), StringComparison.OrdinalIgnoreCase);
        Assert.Equal(5, factory.WithDb(db => db.AiMessages.IgnoreQueryFilters().Count(m => m.UserId == owner.UserId && m.Role == "user")));
        Assert.True((await owner.Get("/api/v1/ai/conversations")).Ok);
        var other = await Owner();
        Assert.Equal(HttpStatusCode.OK, (await other.Post("/api/v1/ai/ask", new { text = "hello" })).Status);
    }

    [Fact]
    public async Task Active_user_leases_reject_duplicate_work_and_are_released_after_answers()
    {
        var owner = await Owner("PRO");
        var limiter = factory.Services.GetRequiredService<IAiRequestLimiter>();
        var caps = factory.Services.GetRequiredService<IOptions<AiRateLimitOptions>>().Value.Pro;
        var active = await limiter.EnterAsync(owner.WorkspaceId, owner.UserId, caps, TimeSpan.FromMinutes(5), default);
        var rejected = await owner.Post("/api/v1/ai/ask", new { text = "hello" });
        Assert.Equal(HttpStatusCode.TooManyRequests, rejected.Status); Assert.Equal("AI_USER_CONCURRENCY_LIMIT", rejected.ErrorCode);
        Assert.Equal("2", rejected.Header("Retry-After"));
        Assert.Equal(0, factory.WithDb(db => db.AiMessages.IgnoreQueryFilters().Count(m => m.UserId == owner.UserId)));
        await active.DisposeAsync();
        Assert.Equal(HttpStatusCode.OK, (await owner.Post("/api/v1/ai/ask", new { text = "hello" })).Status);
        // Completing one response must release the user's lease for the next response.
        Assert.Equal(HttpStatusCode.OK, (await owner.Post("/api/v1/ai/ask", new { text = "hello" })).Status);
    }

    [Fact]
    public async Task Expired_subscriptions_use_free_request_caps()
    {
        var owner = await Owner("BUSINESS");
        factory.WithDb(db => { var sub = db.Subscriptions.Single(s => s.TenantId == owner.WorkspaceId); sub.Status = SubscriptionStatus.Expired; db.SaveChanges(); return 0; });
        var limits = (await owner.Get("/api/v1/ai/usage")).Data!["requestLimits"]!;
        Assert.Equal("FREE", limits["planCode"]!.GetValue<string>());
        Assert.Equal(5, limits["perMinute"]!.GetValue<int>());
    }

    [Fact]
    public async Task Multi_replica_mode_refuses_unshared_admission_without_affecting_reads()
    {
        var owner = await Owner(); var options = factory.Services.GetRequiredService<IOptions<AiRateLimitOptions>>().Value;
        var previous = options.RequireDistributed;
        try
        {
            options.RequireDistributed = true;
            var refused = await owner.Post("/api/v1/ai/ask", new { text = "hello" });
            Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.Status); Assert.Equal("AI_LIMIT_STORE_UNAVAILABLE", refused.ErrorCode);
            Assert.True((await owner.Get("/api/v1/ai/usage")).Ok);
        }
        finally { options.RequireDistributed = previous; }
    }
}
