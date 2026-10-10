using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Ai;

public record AiTierCountDto(string Tier, int Answers, long Credits);
public record AiFeatureUsageDto(string Feature, int Answers, long Credits);
public record AiPersonUsageDto(Guid UserId, string Name, int Answers, long Credits, IReadOnlyList<AiTierCountDto> ByTier);
/// <summary>One workspace's month of AI use, for its owners and admins: counts per person and per level, never what was asked or answered.</summary>
public record AiWorkspaceReportDto(string Month, long CreditsUsed, long CreditsLimit, bool Unlimited, int Answers, int Failed, IReadOnlyList<AiTierCountDto> ByTier,
    IReadOnlyList<AiPersonUsageDto> People, IReadOnlyList<AiFeatureUsageDto>? Features = null);

public record AdminAiUsageRowDto(Guid TenantId, string Name, string PlanCode, int Answers, int Failed, long CreditsUsed, long CreditsLimit, int Quick, int Standard, int Deep,
    long TokensIn, long TokensOut, decimal EstimatedCost, DateTime? LastUsedAt, long CacheReadTokens = 0, int CacheHitPercent = 0, int UnpricedAnswers = 0);
/// <summary>The platform's month of AI use across organizations, with an estimate of what it cost at the providers' prices (counts only, never content).</summary>
public record AdminAiUsageDto(string Month, int Organizations, int Answers, long CreditsUsed, long TokensIn, long TokensOut, decimal EstimatedCost, string Currency,
    IReadOnlyList<AdminAiUsageRowDto> Rows, decimal EstimatedSavedByCache = 0, int CacheHitPercent = 0, int UnpricedAnswers = 0);

/// <summary>Usage reports of the AI workspace. Everything here is counted from what each answer recorded about itself (level, credits, tokens, outcome).</summary>
public class AiUsageService(IAppDbContext db, ICurrentContext ctx, AppClock clock, EntitlementService entitlements, IOptions<AiOptions> options)
{
    private static readonly string[] Tiers = ["quick", "standard", "deep"];

    private (string Label, DateTime From, DateTime To) Month(string? month)
    {
        var now = clock.Now;
        var start = new DateTime(now.Year, now.Month, 1, 0, 0, 0, DateTimeKind.Utc);
        if (!string.IsNullOrWhiteSpace(month))
        {
            if (!DateTime.TryParseExact(month.Trim() + "-01", "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var parsed))
                throw new ValidationException("month", "Use a month like 2026-10.");
            start = new DateTime(parsed.Year, parsed.Month, 1, 0, 0, 0, DateTimeKind.Utc);
        }
        return (start.ToString("yyyy-MM", CultureInfo.InvariantCulture), start, start.AddMonths(1));
    }

    private AiTierOptions? TierOf(string? tier) => tier switch { "quick" => options.Value.Chat.Quick, "standard" => options.Value.Chat.Standard, "deep" => options.Value.Chat.Deep, _ => null };

    /// <summary>What the answers cost at the provider's prices: uncached input at full price, cached input at a fraction, cache writes at a premium.</summary>
    private decimal CostOf(string? model, string? tier, long tokensIn, long tokensOut, long cacheRead, long cacheWrite)
    {
        var price = AiProviderCost.Price(model, tier, options.Value);
        return price is null ? 0 : AiProviderCost.Cost(price, tokensIn, tokensOut, cacheRead, cacheWrite);
    }

    /// <summary>What the cached reads would have cost at full input price, minus what they cost.</summary>
    private decimal SavedBy(string? model, string? tier, long cacheRead) => model?.StartsWith("claude-", StringComparison.OrdinalIgnoreCase) == true && TierOf(tier) is { } t ? cacheRead * t.InputPerMTok * (1 - t.CacheReadFactor) / 1_000_000m : 0;

    // ------------------------------------------------------------------ one workspace

    public async Task<AiWorkspaceReportDto> WorkspaceAsync(string? month, CancellationToken ct = default)
    {
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only owners and admins can see how the assistant is used.", "PERMISSION_DENIED");
        ctx.RequireTenantId();
        var (label, from, to) = Month(month);
        var rows = await db.AiMessages.AsNoTracking().Where(m => m.Role == "assistant" && m.CreatedAt >= from && m.CreatedAt < to)
            .Select(m => new { m.UserId, m.Tier, m.Credits, m.Status }).Take(200_000).ToListAsync(ct);
        var account = await db.AiCreditAccounts.AsNoTracking().FirstOrDefaultAsync(a => a.PeriodStart == from, ct);
        var extra = account is null ? [] : await db.AiCreditReservations.AsNoTracking().Where(r => r.AccountId == account.Id && r.Feature != "workspace" && r.Status == "settled")
            .Select(r => new { r.UserId, r.Feature, r.Charged }).ToListAsync(ct);
        var ids = rows.Select(r => r.UserId).Concat(extra.Select(r => r.UserId)).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);

        List<AiTierCountDto> ByTier(IEnumerable<(string? Tier, int Credits)> items)
        {
            var list = items.ToList();
            return Tiers.Select(t => new AiTierCountDto(t, list.Count(x => x.Tier == t), list.Where(x => x.Tier == t).Sum(x => (long)x.Credits))).ToList();
        }
        var people = ids.Select(id => { var mine = rows.Where(r => r.UserId == id).ToList(); var additional = extra.Where(r => r.UserId == id).ToList();
            return new AiPersonUsageDto(id, names.GetValueOrDefault(id, "A former member"), mine.Count + additional.Count, mine.Sum(x => (long)x.Credits) + additional.Sum(x => (long)x.Charged),
                ByTier(mine.Select(x => (x.Tier, x.Credits)))); }).OrderByDescending(p => p.Credits).ThenBy(p => p.Name).ToList();
        var limit = await entitlements.GetValueAsync(FeatureKeys.AiMonthlyCredits, ct);
        return new AiWorkspaceReportDto(label, account?.Spent ?? rows.Sum(r => (long)r.Credits), limit, limit < 0, rows.Count + extra.Count, rows.Count(r => r.Status == "failed"), ByTier(rows.Select(r => (r.Tier, r.Credits))), people,
            extra.GroupBy(r => r.Feature).Select(g => new AiFeatureUsageDto(g.Key, g.Count(), g.Sum(r => (long)r.Charged))).ToList());
    }

    // ------------------------------------------------------------------ the platform

    public async Task<AdminAiUsageDto> PlatformAsync(string? month, CancellationToken ct = default)
    {
        if (!ctx.IsPlatformAdmin) throw new ForbiddenException("Platform administrators only.", "PERMISSION_DENIED");
        var (label, from, to) = Month(month);
        var groups = await db.AiMessages.IgnoreQueryFilters().AsNoTracking().Where(m => m.Role == "assistant" && m.CreatedAt >= from && m.CreatedAt < to)
            .GroupBy(m => new { m.TenantId, m.Tier, m.Model })
            .Select(g => new { g.Key.TenantId, g.Key.Tier, g.Key.Model, Answers = g.Count(), Failed = g.Count(x => x.Status == "failed"), Credits = g.Sum(x => (long)x.Credits),
                In = g.Sum(x => (long)x.InputTokens), Out = g.Sum(x => (long)x.OutputTokens), CacheRead = g.Sum(x => (long)x.CacheReadTokens), CacheWrite = g.Sum(x => (long)x.CacheWriteTokens), Last = g.Max(x => x.CreatedAt),
                RecordedCost = g.Sum(x => (double?)x.EstimatedProviderCostUsd) ?? 0,
                Unknown = g.Count(x => x.ProviderCostJson != null && x.EstimatedProviderCostUsd == null), Legacy = g.Count(x => x.ProviderCostJson == null),
                LegacyIn = g.Sum(x => x.ProviderCostJson == null ? (long)x.InputTokens : 0), LegacyOut = g.Sum(x => x.ProviderCostJson == null ? (long)x.OutputTokens : 0),
                LegacyRead = g.Sum(x => x.ProviderCostJson == null ? (long)x.CacheReadTokens : 0), LegacyWrite = g.Sum(x => x.ProviderCostJson == null ? (long)x.CacheWriteTokens : 0) }).ToListAsync(ct);
        var accounts = await db.AiCreditAccounts.IgnoreQueryFilters().AsNoTracking().Where(a => a.PeriodStart == from && a.Spent > 0).ToDictionaryAsync(a => a.TenantId, ct);
        var additionalUsage = await db.AiCreditReservations.IgnoreQueryFilters().AsNoTracking()
            .Where(r => r.CreatedAt >= from && r.CreatedAt < to && r.Feature != "workspace" && r.Status == "settled")
            .GroupBy(r => r.TenantId).Select(g => new { TenantId = g.Key, Answers = g.Count() }).ToDictionaryAsync(r => r.TenantId, ct);
        var ids = groups.Select(g => g.TenantId).Concat(accounts.Keys).Distinct().ToList();
        var tenants = await db.Tenants.IgnoreQueryFilters().AsNoTracking().Where(t => ids.Contains(t.Id)).ToDictionaryAsync(t => t.Id, t => t.Name, ct);
        var now = clock.Now;
        var subs = await db.Subscriptions.AsNoTracking().Include(s => s.Plan).ThenInclude(p => p!.Features).Where(s => ids.Contains(s.TenantId)).ToDictionaryAsync(s => s.TenantId, ct);
        var free = await db.Plans.AsNoTracking().Include(p => p.Features).FirstAsync(p => p.Code == EntitlementService.FreePlan, ct);
        var overrides = await db.TenantFeatureOverrides.AsNoTracking()
            .Where(o => ids.Contains(o.TenantId) && o.FeatureKey == FeatureKeys.AiMonthlyCredits && (o.ExpiresAt == null || o.ExpiresAt > now)).ToListAsync(ct);

        var rows = ids.Select(id =>
        {
            var mine = groups.Where(g => g.TenantId == id).ToList();
            subs.TryGetValue(id, out var sub);
            var plan = sub?.Plan is not null && !EntitlementService.IsLapsed(sub, now) ? sub.Plan : free;
            var limit = overrides.FirstOrDefault(o => o.TenantId == id)?.Value
                ?? EntitlementService.ScaledValue(plan, sub?.Status ?? SubscriptionStatus.Active, sub?.Seats ?? 1, FeatureKeys.AiMonthlyCredits, plan.Features.FirstOrDefault(f => f.FeatureKey == FeatureKeys.AiMonthlyCredits)?.Value ?? 0);
            int N(string t) => mine.Where(g => g.Tier == t).Sum(g => g.Answers);
            long read = mine.Sum(g => g.CacheRead), uncached = mine.Sum(g => g.In), written = mine.Sum(g => g.CacheWrite);
            var seen = read + uncached + written;
            var additional = additionalUsage.GetValueOrDefault(id)?.Answers ?? 0;
            return new AdminAiUsageRowDto(id, tenants.GetValueOrDefault(id, "—"), plan.Code, mine.Sum(g => g.Answers) + additional, mine.Sum(g => g.Failed), accounts.GetValueOrDefault(id)?.Spent ?? mine.Sum(g => g.Credits), limit,
                N("quick"), N("standard"), N("deep"), mine.Sum(g => g.In + g.CacheRead + g.CacheWrite), mine.Sum(g => g.Out),
                Math.Round(mine.Sum(g => (decimal)g.RecordedCost + CostOf(g.Model, g.Tier, g.LegacyIn, g.LegacyOut, g.LegacyRead, g.LegacyWrite)), 8), mine.Count == 0 ? null : mine.Max(g => g.Last), read, seen == 0 ? 0 : (int)Math.Round(read * 100d / seen),
                additional + mine.Sum(g => g.Unknown + (AiProviderCost.Price(g.Model, g.Tier, options.Value) is null && g.Model?.StartsWith("builtin-", StringComparison.Ordinal) != true ? g.Legacy : 0)));
        }).OrderByDescending(r => r.CreditsUsed).ThenBy(r => r.Name).Take(500).ToList();

        long totalRead = rows.Sum(r => r.CacheReadTokens), totalIn = rows.Sum(r => r.TokensIn);
        return new AdminAiUsageDto(label, rows.Count, rows.Sum(r => r.Answers), rows.Sum(r => r.CreditsUsed), totalIn, rows.Sum(r => r.TokensOut),
            Math.Round(rows.Sum(r => r.EstimatedCost), 8), "USD", rows, Math.Round(groups.Sum(g => SavedBy(g.Model, g.Tier, g.CacheRead)), 2), totalIn == 0 ? 0 : (int)Math.Round(totalRead * 100d / totalIn), rows.Sum(r => r.UnpricedAnswers));
    }
}
