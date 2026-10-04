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
public record AiPersonUsageDto(Guid UserId, string Name, int Answers, long Credits, IReadOnlyList<AiTierCountDto> ByTier);
/// <summary>One workspace's month of AI use, for its owners and admins: counts per person and per level, never what was asked or answered.</summary>
public record AiWorkspaceReportDto(string Month, long CreditsUsed, long CreditsLimit, bool Unlimited, int Answers, int Failed, IReadOnlyList<AiTierCountDto> ByTier,
    IReadOnlyList<AiPersonUsageDto> People);

public record AdminAiUsageRowDto(Guid TenantId, string Name, string PlanCode, int Answers, int Failed, long CreditsUsed, long CreditsLimit, int Quick, int Standard, int Deep,
    long TokensIn, long TokensOut, decimal EstimatedCost, DateTime? LastUsedAt);
/// <summary>The platform's month of AI use across organizations, with an estimate of what it cost at the providers' prices (counts only, never content).</summary>
public record AdminAiUsageDto(string Month, int Organizations, int Answers, long CreditsUsed, long TokensIn, long TokensOut, decimal EstimatedCost, string Currency,
    IReadOnlyList<AdminAiUsageRowDto> Rows);

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

    private decimal CostOf(string? tier, long tokensIn, long tokensOut)
    {
        var t = tier switch { "quick" => options.Value.Chat.Quick, "standard" => options.Value.Chat.Standard, "deep" => options.Value.Chat.Deep, _ => null };
        return t is null ? 0 : (tokensIn * t.InputPerMTok + tokensOut * t.OutputPerMTok) / 1_000_000m;
    }

    // ------------------------------------------------------------------ one workspace

    public async Task<AiWorkspaceReportDto> WorkspaceAsync(string? month, CancellationToken ct = default)
    {
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only owners and admins can see how the assistant is used.", "PERMISSION_DENIED");
        ctx.RequireTenantId();
        var (label, from, to) = Month(month);
        var rows = await db.AiMessages.AsNoTracking().Where(m => m.Role == "assistant" && m.CreatedAt >= from && m.CreatedAt < to)
            .Select(m => new { m.UserId, m.Tier, m.Credits, m.Status }).Take(200_000).ToListAsync(ct);
        var ids = rows.Select(r => r.UserId).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);

        List<AiTierCountDto> ByTier(IEnumerable<(string? Tier, int Credits)> items)
        {
            var list = items.ToList();
            return Tiers.Select(t => new AiTierCountDto(t, list.Count(x => x.Tier == t), list.Where(x => x.Tier == t).Sum(x => (long)x.Credits))).ToList();
        }
        var people = rows.GroupBy(r => r.UserId).Select(g => new AiPersonUsageDto(g.Key, names.GetValueOrDefault(g.Key, "A former member"), g.Count(), g.Sum(x => (long)x.Credits),
            ByTier(g.Select(x => (x.Tier, x.Credits))))).OrderByDescending(p => p.Credits).ThenBy(p => p.Name).ToList();
        var limit = await entitlements.GetValueAsync(FeatureKeys.AiMonthlyCredits, ct);
        return new AiWorkspaceReportDto(label, rows.Sum(r => (long)r.Credits), limit, limit < 0, rows.Count, rows.Count(r => r.Status == "failed"), ByTier(rows.Select(r => (r.Tier, r.Credits))), people);
    }

    // ------------------------------------------------------------------ the platform

    public async Task<AdminAiUsageDto> PlatformAsync(string? month, CancellationToken ct = default)
    {
        if (!ctx.IsPlatformAdmin) throw new ForbiddenException("Platform administrators only.", "PERMISSION_DENIED");
        var (label, from, to) = Month(month);
        var groups = await db.AiMessages.IgnoreQueryFilters().AsNoTracking().Where(m => m.Role == "assistant" && m.CreatedAt >= from && m.CreatedAt < to)
            .GroupBy(m => new { m.TenantId, m.Tier })
            .Select(g => new { g.Key.TenantId, g.Key.Tier, Answers = g.Count(), Failed = g.Count(x => x.Status == "failed"), Credits = g.Sum(x => (long)x.Credits),
                In = g.Sum(x => (long)x.InputTokens), Out = g.Sum(x => (long)x.OutputTokens), Last = g.Max(x => x.CreatedAt) }).ToListAsync(ct);
        var ids = groups.Select(g => g.TenantId).Distinct().ToList();
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
            var limit = overrides.FirstOrDefault(o => o.TenantId == id)?.Value ?? plan.Features.FirstOrDefault(f => f.FeatureKey == FeatureKeys.AiMonthlyCredits)?.Value ?? 0;
            int N(string t) => mine.Where(g => g.Tier == t).Sum(g => g.Answers);
            return new AdminAiUsageRowDto(id, tenants.GetValueOrDefault(id, "—"), plan.Code, mine.Sum(g => g.Answers), mine.Sum(g => g.Failed), mine.Sum(g => g.Credits), limit,
                N("quick"), N("standard"), N("deep"), mine.Sum(g => g.In), mine.Sum(g => g.Out), Math.Round(mine.Sum(g => CostOf(g.Tier, g.In, g.Out)), 2), mine.Max(g => g.Last));
        }).OrderByDescending(r => r.CreditsUsed).ThenBy(r => r.Name).Take(500).ToList();

        return new AdminAiUsageDto(label, rows.Count, rows.Sum(r => r.Answers), rows.Sum(r => r.CreditsUsed), rows.Sum(r => r.TokensIn), rows.Sum(r => r.TokensOut),
            Math.Round(rows.Sum(r => r.EstimatedCost), 2), "USD", rows);
    }
}
