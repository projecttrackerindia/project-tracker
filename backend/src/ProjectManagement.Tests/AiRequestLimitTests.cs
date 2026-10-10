using Microsoft.Extensions.Logging.Abstractions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Infrastructure.Services;
using StackExchange.Redis;

namespace ProjectManagement.Tests;

public sealed class AiRequestLimitTests
{
    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now = DateTimeOffset.FromUnixTimeSeconds(1_800_000_000);
        public override DateTimeOffset GetUtcNow() => Now;
    }

    [Fact]
    public async Task Simultaneous_requests_cannot_bypass_the_minute_cap()
    {
        using var limiter = new MemoryAiRequestLimiter(new Clock());
        var tenant = Guid.NewGuid(); var user = Guid.NewGuid();
        var start = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var tasks = Enumerable.Range(0, 100).Select(async _ =>
        {
            await start.Task;
            try { await using var lease = await limiter.EnterAsync(tenant, user, new(5, 100, 100, 100), TimeSpan.FromMinutes(5), default); return true; }
            catch (AiRequestLimitException ex) { Assert.Equal("AI_MINUTE_LIMIT", ex.Code); return false; }
        }).ToArray();
        start.SetResult();
        Assert.Equal(5, (await Task.WhenAll(tasks)).Count(x => x));
    }

    [Fact]
    public async Task Active_requests_are_separate_from_counters_and_rejections_do_not_consume_requests()
    {
        using var limiter = new MemoryAiRequestLimiter(new Clock());
        var tenant = Guid.NewGuid(); var user = Guid.NewGuid(); var caps = new AiRequestLimits(2, 10, 10, 1);
        var first = await limiter.EnterAsync(tenant, user, caps, TimeSpan.FromMinutes(5), default);
        var rejected = await Assert.ThrowsAsync<AiRequestLimitException>(() => limiter.EnterAsync(tenant, user, caps, TimeSpan.FromMinutes(5), default));
        Assert.Equal("AI_USER_CONCURRENCY_LIMIT", rejected.Code);
        await first.DisposeAsync(); await first.DisposeAsync();
        await using var second = await limiter.EnterAsync(tenant, user, caps, TimeSpan.FromMinutes(5), default);
        Assert.Equal("AI_MINUTE_LIMIT", (await Assert.ThrowsAsync<AiRequestLimitException>(() => limiter.EnterAsync(tenant, user, caps, TimeSpan.FromMinutes(5), default))).Code);
    }

    [Theory]
    [InlineData(60, "AI_HOUR_LIMIT")]
    [InlineData(3600, "AI_DAY_LIMIT")]
    public async Task Longer_windows_still_apply_after_shorter_windows_reset(int seconds, string code)
    {
        var clock = new Clock(); using var limiter = new MemoryAiRequestLimiter(clock);
        var caps = seconds == 60 ? new AiRequestLimits(1, 1, 10, 1) : new AiRequestLimits(1, 10, 1, 1);
        var tenant = Guid.NewGuid(); var user = Guid.NewGuid();
        await (await limiter.EnterAsync(tenant, user, caps, TimeSpan.FromMinutes(5), default)).DisposeAsync();
        clock.Now = clock.Now.AddSeconds(seconds);
        Assert.Equal(code, (await Assert.ThrowsAsync<AiRequestLimitException>(() => limiter.EnterAsync(tenant, user, caps, TimeSpan.FromMinutes(5), default))).Code);
        clock.Now = clock.Now.AddDays(1);
        await using var next = await limiter.EnterAsync(tenant, user, caps, TimeSpan.FromMinutes(5), default);
    }

    [Fact]
    public async Task Users_and_workspaces_are_isolated_and_abandoned_leases_expire()
    {
        var clock = new Clock(); using var limiter = new MemoryAiRequestLimiter(clock);
        var caps = new AiRequestLimits(10, 10, 10, 1); var tenant = Guid.NewGuid(); var user = Guid.NewGuid();
        await using var abandoned = await limiter.EnterAsync(tenant, user, caps, TimeSpan.FromSeconds(5), default);
        await using var otherUser = await limiter.EnterAsync(tenant, Guid.NewGuid(), caps, TimeSpan.FromMinutes(5), default);
        await using var otherTenant = await limiter.EnterAsync(Guid.NewGuid(), user, caps, TimeSpan.FromMinutes(5), default);
        clock.Now = clock.Now.AddSeconds(6);
        await using var recovered = await limiter.EnterAsync(tenant, user, caps, TimeSpan.FromMinutes(5), default);
        await abandoned.DisposeAsync();
        Assert.Equal("AI_USER_CONCURRENCY_LIMIT", (await Assert.ThrowsAsync<AiRequestLimitException>(() => limiter.EnterAsync(tenant, user, caps, TimeSpan.FromMinutes(5), default))).Code);
    }

    [Fact]
    public async Task Cancellation_does_not_consume_a_request_and_plan_changes_do_not_reset_counters()
    {
        using var limiter = new MemoryAiRequestLimiter(new Clock()); var tenant = Guid.NewGuid(); var user = Guid.NewGuid();
        var free = new AiRequestLimits(1, 100, 100, 1); var pro = new AiRequestLimits(2, 100, 100, 1);
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => limiter.EnterAsync(tenant, user, free, TimeSpan.FromMinutes(5), cancelled.Token));
        await (await limiter.EnterAsync(tenant, user, free, TimeSpan.FromMinutes(5), default)).DisposeAsync();
        await (await limiter.EnterAsync(tenant, user, pro, TimeSpan.FromMinutes(5), default)).DisposeAsync();
        Assert.Equal("AI_MINUTE_LIMIT", (await Assert.ThrowsAsync<AiRequestLimitException>(() => limiter.EnterAsync(tenant, user, pro, TimeSpan.FromMinutes(5), default))).Code);
    }

    [RedisFact]
    public async Task Redis_admission_is_atomic_across_independent_api_instances()
    {
        using var connection = await ConnectionMultiplexer.ConnectAsync(Environment.GetEnvironmentVariable("PM_TEST_REDIS")!);
        var one = new RedisAiRequestLimiter(connection, NullLogger<RedisAiRequestLimiter>.Instance);
        var two = new RedisAiRequestLimiter(connection, NullLogger<RedisAiRequestLimiter>.Instance);
        var tenant = Guid.NewGuid(); var user = Guid.NewGuid();
        var limits = new AiRequestLimits(5, 100, 100, 100);
        var tasks = Enumerable.Range(0, 100).Select(async i =>
        {
            try { await using var lease = await (i % 2 == 0 ? one : two).EnterAsync(tenant, user, limits, TimeSpan.FromMinutes(5), default); return true; }
            catch (AiRequestLimitException ex) { Assert.Equal("AI_MINUTE_LIMIT", ex.Code); return false; }
        }).ToArray();
        Assert.Equal(5, (await Task.WhenAll(tasks)).Count(x => x));
        var concurrentUser = Guid.NewGuid(); var concurrentCaps = new AiRequestLimits(100, 100, 100, 1);
        var active = await one.EnterAsync(tenant, concurrentUser, concurrentCaps, TimeSpan.FromMinutes(5), default);
        Assert.Equal("AI_USER_CONCURRENCY_LIMIT", (await Assert.ThrowsAsync<AiRequestLimitException>(() => two.EnterAsync(tenant, concurrentUser, concurrentCaps, TimeSpan.FromMinutes(5), default))).Code);
        await active.DisposeAsync();
        await using var recovered = await two.EnterAsync(tenant, concurrentUser, concurrentCaps, TimeSpan.FromMinutes(5), default);
        // Unique test-owned keys only; never flush an existing Redis database.
        await connection.GetDatabase().KeyDeleteAsync($"pm:ai-limits:{{{tenant:N}:{user:N}}}:counts");
        await connection.GetDatabase().KeyDeleteAsync($"pm:ai-limits:{{{tenant:N}:{user:N}}}:active");
        await recovered.DisposeAsync();
        await connection.GetDatabase().KeyDeleteAsync($"pm:ai-limits:{{{tenant:N}:{concurrentUser:N}}}:counts");
        await connection.GetDatabase().KeyDeleteAsync($"pm:ai-limits:{{{tenant:N}:{concurrentUser:N}}}:active");
    }

    [Fact]
    public async Task Redis_outages_refuse_admission_instead_of_bypassing_paid_request_caps()
    {
        using var connection = await ConnectionMultiplexer.ConnectAsync("127.0.0.1:1,abortConnect=false,connectRetry=0,connectTimeout=100,asyncTimeout=100");
        var limiter = new RedisAiRequestLimiter(connection, NullLogger<RedisAiRequestLimiter>.Instance);
        var error = await Assert.ThrowsAsync<AppException>(() => limiter.EnterAsync(Guid.NewGuid(), Guid.NewGuid(), new(5, 30, 100, 1), TimeSpan.FromMinutes(5), default));
        Assert.Equal(503, error.StatusCode); Assert.Equal("AI_LIMIT_STORE_UNAVAILABLE", error.Code);
    }
}

public sealed class RedisFactAttribute : FactAttribute
{
    public RedisFactAttribute() { if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("PM_TEST_REDIS"))) Skip = "Set PM_TEST_REDIS to test against real Redis (enabled in CI)."; }
}
