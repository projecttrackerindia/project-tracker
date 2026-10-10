using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>Request caps are per authenticated person AND workspace. Monthly credits remain a separate workspace pool.</summary>
public sealed record AiRequestLimits(int PerMinute, int PerHour, int PerDay, int Concurrent);

public sealed class AiRateLimitOptions
{
    public const string Section = "Ai:RateLimits";
    /// <summary>Enable before running multiple API replicas. No Redis means AI requests are refused rather than multiplying allowances.</summary>
    public bool RequireDistributed { get; set; }
    public AiRequestLimits Free { get; set; } = new(5, 30, 100, 1);
    public AiRequestLimits Pro { get; set; } = new(10, 120, 500, 1);
    public AiRequestLimits Business { get; set; } = new(20, 300, 1500, 2);
    public AiRequestLimits Enterprise { get; set; } = new(30, 600, 3000, 3);

    public AiRequestLimits For(string code)
    {
        var limits = code.ToUpperInvariant() switch { "PRO" => Pro, "BUSINESS" => Business, "ENTERPRISE" => Enterprise, _ => Free };
        if (limits.PerMinute < 1 || limits.PerHour < 1 || limits.PerDay < 1 || limits.Concurrent < 1)
            throw new AppException(503, "AI_LIMIT_CONFIGURATION", "The assistant's request limits need an administrator's attention.");
        return limits;
    }
}

public sealed class AiRequestLimitException(string code, int retryAfterSeconds, string message)
    : AppException(429, code, message)
{
    public int RetryAfterSeconds { get; } = Math.Max(1, retryAfterSeconds);
}

public interface IAiRequestLimiter
{
    bool Distributed { get; }
    Task<IAsyncDisposable> EnterAsync(Guid tenantId, Guid userId, AiRequestLimits limits, TimeSpan leaseLifetime, CancellationToken ct);
}

public sealed record AiRequestLimitDto(string PlanCode, int PerMinute, int PerHour, int PerDay, int Concurrent, bool Distributed);

public sealed class AiRequestLimitService(ICurrentContext ctx, EntitlementService entitlements,
    IOptions<AiRateLimitOptions> settings, IOptions<AiOptions> ai, IAiRequestLimiter limiter)
{
    public async Task<AiRequestLimitDto> LimitsAsync(CancellationToken ct)
    {
        // Uses the same effective plan as billing: expired subscriptions fall back to Free; unknown plans use conservative defaults.
        var plan = await entitlements.GetEffectivePlanAsync(ctx.RequireTenantId(), ct);
        var limits = settings.Value.For(plan.Plan.Code);
        return new(plan.Plan.Code, limits.PerMinute, limits.PerHour, limits.PerDay, limits.Concurrent, limiter.Distributed);
    }

    public async Task<IAsyncDisposable> EnterAsync(CancellationToken ct)
    {
        if (settings.Value.RequireDistributed && !limiter.Distributed)
            throw new AppException(503, "AI_LIMIT_STORE_UNAVAILABLE", "The assistant's shared capacity controls are unavailable. Please try again later.");
        var limits = await LimitsAsync(ct);
        // Expiring leases recover capacity if an API process dies. The request deadline remains shorter than this lease.
        var seconds = Math.Max(Math.Clamp(ai.Value.Chat.ExecutionTimeoutSeconds, 1, 900), Math.Clamp(ai.Value.Fallback.TimeoutSeconds, 1, 600)) + 300;
        return await limiter.EnterAsync(ctx.RequireTenantId(), ctx.RequireUserId(),
            new(limits.PerMinute, limits.PerHour, limits.PerDay, limits.Concurrent), TimeSpan.FromSeconds(seconds), ct);
    }
}
