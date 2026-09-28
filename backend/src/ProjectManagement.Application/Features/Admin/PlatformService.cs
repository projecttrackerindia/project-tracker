using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Billing;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Admin;

// ---- billing overview
public record PlanRevenueDto(string PlanCode, string PlanName, int Organizations, decimal Mrr);
public record AdminInvoiceDto(string Number, string Organization, string PlanCode, decimal Amount, string Currency, InvoiceStatus Status, DateTime IssuedAt);
public record TrialEndingDto(Guid TenantId, string Organization, string PlanCode, DateTime TrialEnd);
public record BillingOverviewDto(decimal Mrr, decimal Arr, string Currency, int PayingOrganizations, int Trials, int PastDue, int CancellingAtPeriodEnd,
    decimal RevenueLast30Days, int FailedPaymentsLast30Days, IReadOnlyList<PlanRevenueDto> ByPlan, IReadOnlyList<AdminInvoiceDto> RecentInvoices, IReadOnlyList<TrialEndingDto> TrialsEndingSoon);

// ---- usage
public record UsageWarningDto(string Metric, int Percent);
public record AdminUsageDto(Guid TenantId, string Name, WorkspaceType Type, string PlanCode, int Members, int Projects, int Tasks, double StorageMb, int ApiKeys, int Webhooks,
    DateTime? LastActivityAt, IReadOnlyList<UsageWarningDto> Warnings);

// ---- overrides and platform settings
public record FeatureOverrideDto(string FeatureKey, long Value, string Reason, DateTime? ExpiresAt, DateTime CreatedAt, long PlanValue);
public record SetOverrideRequest(long Value, string Reason, int? ExpiresInDays);
public record PlatformSettingsDto(bool SignupsEnabled, bool MaintenanceMode, string? Announcement, string AnnouncementLevel);
public record PlatformStatusDto(bool MaintenanceMode, string? Announcement, string AnnouncementLevel);
public record ConsentDocumentDto(string Type, int Version, string Title, string Body, DateTime? PublishedAt);
public record SetConsentDocumentRequest(string Type, string Title, string Body);

// ---- billing settings
/// <summary>The one currency every plan is priced in, and the currencies it can be switched to.</summary>
public record BillingSettingsDto(string Currency, IReadOnlyList<CurrencyDto> Currencies);
public record SetBillingSettingsRequest(string Currency);

// ---- health
public record DatabaseHealthDto(string Provider, bool Reachable, long LatencyMs, int PendingMigrations, string? Error);
public record WorkerHealthDto(string Name, string Status, DateTime? LastRunAt, int IntervalSeconds, string? LastError);
public record QueueHealthDto(int EmailsWaiting, int EmailsStuck, int ReportsWaiting, int ReportsFailed, int WebhooksWaiting, int WebhooksFailed);
public record CacheHealthDto(string Provider, bool Reachable, long LatencyMs, string? Error);
public record TrafficHealthDto(long Requests, long ServerErrors, long ClientErrors, DateTime? LastServerErrorAt);
public record SystemHealthDto(string Status, string Version, string Runtime, DateTime StartedAt, long UptimeSeconds, DatabaseHealthDto Database,
    IReadOnlyList<WorkerHealthDto> Workers, QueueHealthDto Queues, TrafficHealthDto Traffic, double AttachmentStorageMb, CacheHealthDto Cache);

/// <summary>Platform-wide flags, read by the middleware and registration; cached for a few seconds so it costs nothing per request.</summary>
public class PlatformSettingsCache(IServiceScopeFactory scopes, TimeProvider time)
{
    private PlatformSettingsDto _current = new(true, false, null, "info");
    private Features.Auth.PasswordPolicyDto _passwordPolicy = Features.Auth.PasswordPolicyDto.Default;
    private IReadOnlyList<ConsentDocumentDto> _consentDocuments = PlatformService.DefaultConsentDocuments;
    private DateTime _loadedAt = DateTime.MinValue;
    private static readonly TimeSpan Ttl = TimeSpan.FromSeconds(5);
    private readonly SemaphoreSlim _gate = new(1, 1);

    public async Task<PlatformSettingsDto> GetAsync(CancellationToken ct = default)
    {
        await RefreshAsync(ct);
        return _current;
    }

    public async Task<Features.Auth.PasswordPolicyDto> GetPasswordPolicyAsync(CancellationToken ct = default)
    {
        await RefreshAsync(ct);
        return _passwordPolicy;
    }

    public async Task<IReadOnlyList<ConsentDocumentDto>> GetConsentDocumentsAsync(CancellationToken ct = default)
    {
        await RefreshAsync(ct);
        return _consentDocuments;
    }

    private async Task RefreshAsync(CancellationToken ct)
    {
        var now = time.GetUtcNow().UtcDateTime;
        if (now - _loadedAt < Ttl) return;
        await _gate.WaitAsync(ct);
        try
        {
            if (now - _loadedAt < Ttl) return;
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<IAppDbContext>();
            _current = await PlatformService.ReadSettingsAsync(db, ct);
            _passwordPolicy = await PlatformService.ReadPasswordPolicyAsync(db, ct);
            _consentDocuments = await PlatformService.ReadConsentDocumentsAsync(db, ct);
            _loadedAt = now;
        }
        finally { _gate.Release(); }
    }

    public void Invalidate() => _loadedAt = DateTime.MinValue;
}

/// <summary>Platform administration beyond tenants and plans: money, usage, exceptions to plans, platform switches and system health.</summary>
public class PlatformService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PlatformSettingsCache settingsCache, SystemMetrics metrics,
    WorkerHeartbeats heartbeats, Microsoft.Extensions.Caching.Distributed.IDistributedCache cache, Microsoft.Extensions.Configuration.IConfiguration config)
{
    public const string KeyBillingCurrency = "billing_currency";
    public const string KeySignups = "signups_enabled", KeyMaintenance = "maintenance_mode", KeyAnnouncement = "announcement", KeyAnnouncementLevel = "announcement_level";
    private static readonly string[] Levels = ["info", "warning", "danger"];

    private void RequireAdmin()
    {
        if (!ctx.IsPlatformAdmin) throw new ForbiddenException("Platform administrators only.", "PERMISSION_DENIED");
    }

    private static string EffectiveCode(Subscription? sub, DateTime now) =>
        sub?.Plan is { } p && !EntitlementService.IsLapsed(sub, now) ? p.Code : EntitlementService.FreePlan;

    // ---------------------------------------------------------------- billing

    public async Task<BillingOverviewDto> BillingAsync(CancellationToken ct = default)
    {
        RequireAdmin();
        var now = clock.Now; var since = now.AddDays(-30);
        var alive = db.Tenants.Select(t => t.Id);
        var subs = await db.Subscriptions.AsNoTracking().Include(s => s.Plan).Where(s => alive.Contains(s.TenantId)).ToListAsync(ct);
        var names = await db.Tenants.AsNoTracking().ToDictionaryAsync(t => t.Id, t => t.Name, ct);

        var paying = subs.Where(s => EffectiveCode(s, now) != EntitlementService.FreePlan && s.Status == SubscriptionStatus.Active).ToList();
        var byPlan = paying.GroupBy(s => s.Plan!.Code).Select(g => new PlanRevenueDto(g.Key, g.First().Plan!.Name, g.Count(), g.Count() * (g.First().Plan!.PriceMonthly ?? 0m)))
            .OrderByDescending(p => p.Mrr).ToList();
        var mrr = byPlan.Sum(p => p.Mrr);

        var invoices = await db.Invoices.IgnoreQueryFilters().AsNoTracking().Where(i => alive.Contains(i.TenantId)).OrderByDescending(i => i.IssuedAt).Take(500).ToListAsync(ct);
        var recent = invoices.Take(15).Select(i => new AdminInvoiceDto(i.Number, names.GetValueOrDefault(i.TenantId, "—"), i.PlanCode, i.Amount, i.Currency, i.Status, i.IssuedAt)).ToList();
        var month = invoices.Where(i => i.IssuedAt >= since).ToList();

        var soon = subs.Where(s => s.Status == SubscriptionStatus.Trial && s.TrialEnd is { } te && te > now && te <= now.AddDays(7))
            .OrderBy(s => s.TrialEnd).Select(s => new TrialEndingDto(s.TenantId, names.GetValueOrDefault(s.TenantId, "—"), s.Plan?.Code ?? "?", s.TrialEnd!.Value)).ToList();

        return new BillingOverviewDto(mrr, mrr * 12, await ReadCurrencyAsync(db, ct), paying.Count, subs.Count(s => s.Status == SubscriptionStatus.Trial && !EntitlementService.IsLapsed(s, now)),
            subs.Count(s => s.Status == SubscriptionStatus.PastDue), paying.Count(s => s.CancelAtPeriodEnd),
            month.Where(i => i.Status == InvoiceStatus.Paid).Sum(i => i.Amount), month.Count(i => i.Status == InvoiceStatus.Failed), byPlan, recent, soon);
    }

    // ---------------------------------------------------------------- usage (counts only: never customer content)

    public async Task<PagedResult<AdminUsageDto>> UsageAsync(string? q, WorkspaceType? type, string? sort, bool warningsOnly, int page, int pageSize, CancellationToken ct = default)
    {
        RequireAdmin();
        var now = clock.Now;
        var tenantQuery = db.Tenants.AsNoTracking().AsQueryable();
        if (type is { } t) tenantQuery = tenantQuery.Where(x => x.Type == t);
        if (!string.IsNullOrWhiteSpace(q)) { var s = q.Trim().ToLower(); tenantQuery = tenantQuery.Where(x => x.Name.ToLower().Contains(s) || x.Slug.ToLower().Contains(s)); }
        var tenants = await tenantQuery.Take(5000).ToListAsync(ct);
        var ids = tenants.Select(x => x.Id).ToList();

        var members = await db.TenantMembers.Where(m => ids.Contains(m.TenantId)).GroupBy(m => m.TenantId).Select(g => new { g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.N, ct);
        var projects = await db.Projects.IgnoreQueryFilters().Where(p => !p.IsDeleted && ids.Contains(p.TenantId)).GroupBy(p => p.TenantId).Select(g => new { g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.N, ct);
        var tasks = await db.Tasks.IgnoreQueryFilters().Where(x => !x.IsDeleted && ids.Contains(x.TenantId)).GroupBy(x => x.TenantId).Select(g => new { g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.N, ct);
        var bytes = await db.Attachments.IgnoreQueryFilters().Where(a => ids.Contains(a.TenantId)).GroupBy(a => a.TenantId).Select(g => new { g.Key, B = g.Sum(a => a.SizeBytes) }).ToDictionaryAsync(x => x.Key, x => x.B, ct);
        var keys = await db.ApiKeys.IgnoreQueryFilters().Where(k => ids.Contains(k.TenantId) && k.RevokedAt == null && (k.ExpiresAt == null || k.ExpiresAt > now)).GroupBy(k => k.TenantId).Select(g => new { g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.N, ct);
        var hooks = await db.Webhooks.IgnoreQueryFilters().Where(w => ids.Contains(w.TenantId) && w.IsActive).GroupBy(w => w.TenantId).Select(g => new { g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.N, ct);
        var last = await db.Activities.IgnoreQueryFilters().Where(a => ids.Contains(a.TenantId)).GroupBy(a => a.TenantId).Select(g => new { g.Key, At = g.Max(a => a.CreatedAt) }).ToDictionaryAsync(x => x.Key, x => x.At, ct);
        var subs = await db.Subscriptions.AsNoTracking().Include(s => s.Plan).ThenInclude(p => p!.Features).Where(s => ids.Contains(s.TenantId)).ToDictionaryAsync(s => s.TenantId, ct);
        var free = await db.Plans.AsNoTracking().Include(p => p.Features).FirstAsync(p => p.Code == EntitlementService.FreePlan, ct);
        var overrides = await db.TenantFeatureOverrides.AsNoTracking().Where(o => ids.Contains(o.TenantId) && (o.ExpiresAt == null || o.ExpiresAt > now)).ToListAsync(ct);

        var rows = tenants.Select(x =>
        {
            subs.TryGetValue(x.Id, out var sub);
            var plan = sub?.Plan is not null && !EntitlementService.IsLapsed(sub, now) ? sub.Plan : free;
            long Limit(string key) => overrides.FirstOrDefault(o => o.TenantId == x.Id && o.FeatureKey == key)?.Value ?? plan.Features.FirstOrDefault(f => f.FeatureKey == key)?.Value ?? 0;
            var mb = bytes.GetValueOrDefault(x.Id) / 1024d / 1024d;
            var warn = new List<UsageWarningDto>();
            void Check(string metric, double used, long limit) { if (limit > 0 && used * 100 / limit >= 80) warn.Add(new UsageWarningDto(metric, (int)Math.Round(used * 100 / limit))); }
            Check("projects", projects.GetValueOrDefault(x.Id), Limit(FeatureKeys.ProjectLimit));
            Check("tasks", tasks.GetValueOrDefault(x.Id), Limit(FeatureKeys.TaskLimit));
            Check("members", members.GetValueOrDefault(x.Id), Limit(FeatureKeys.MaxMembers));
            Check("storage", mb, Limit(FeatureKeys.StorageLimitMb));
            return new AdminUsageDto(x.Id, x.Name, x.Type, plan.Code, members.GetValueOrDefault(x.Id), projects.GetValueOrDefault(x.Id), tasks.GetValueOrDefault(x.Id), Math.Round(mb, 1),
                keys.GetValueOrDefault(x.Id), hooks.GetValueOrDefault(x.Id), last.TryGetValue(x.Id, out var at) ? at : null, warn);
        });
        if (warningsOnly) rows = rows.Where(r => r.Warnings.Count > 0);

        rows = (sort ?? "tasks").ToLowerInvariant() switch
        {
            "name" => rows.OrderBy(r => r.Name),
            "members" => rows.OrderByDescending(r => r.Members),
            "projects" => rows.OrderByDescending(r => r.Projects),
            "storage" => rows.OrderByDescending(r => r.StorageMb),
            "activity" => rows.OrderByDescending(r => r.LastActivityAt ?? DateTime.MinValue),
            "quiet" => rows.OrderBy(r => r.LastActivityAt ?? DateTime.MinValue),
            _ => rows.OrderByDescending(r => r.Tasks),
        };
        var list = rows.ToList();
        var p = new PageQuery(page, pageSize);
        return new PagedResult<AdminUsageDto>(list.Skip((p.SafePage - 1) * p.SafeSize()).Take(p.SafeSize()).ToList(), p.SafePage, p.SafeSize(), list.Count);
    }

    // ---------------------------------------------------------------- exceptions to a plan

    public async Task<IReadOnlyList<FeatureOverrideDto>> OverridesAsync(Guid tenantId, CancellationToken ct = default)
    {
        RequireAdmin();
        await EnsureTenantAsync(tenantId, ct);
        var planValues = await PlanValuesAsync(tenantId, ct);
        return (await db.TenantFeatureOverrides.AsNoTracking().Where(o => o.TenantId == tenantId).OrderBy(o => o.FeatureKey).ToListAsync(ct))
            .Select(o => new FeatureOverrideDto(o.FeatureKey, o.Value, o.Reason, o.ExpiresAt, o.CreatedAt, planValues.GetValueOrDefault(o.FeatureKey))).ToList();
    }

    private async Task EnsureTenantAsync(Guid id, CancellationToken ct)
    {
        if (!await db.Tenants.AnyAsync(t => t.Id == id, ct)) throw new NotFoundException("Organization not found.");
    }

    private async Task<Dictionary<string, long>> PlanValuesAsync(Guid tenantId, CancellationToken ct)
    {
        var now = clock.Now;
        var sub = await db.Subscriptions.AsNoTracking().Include(s => s.Plan).ThenInclude(p => p!.Features).FirstOrDefaultAsync(s => s.TenantId == tenantId, ct);
        var plan = sub?.Plan is not null && !EntitlementService.IsLapsed(sub, now) ? sub.Plan
            : await db.Plans.AsNoTracking().Include(p => p.Features).FirstAsync(p => p.Code == EntitlementService.FreePlan, ct);
        return plan.Features.ToDictionary(f => f.FeatureKey, f => f.Value);
    }

    public async Task<IReadOnlyList<FeatureOverrideDto>> SetOverrideAsync(Guid tenantId, string key, SetOverrideRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        await EnsureTenantAsync(tenantId, ct);
        if (!FeatureKeys.All.Contains(key)) throw new ValidationException("featureKey", "Unknown feature.");
        var isFlag = FeatureKeys.Flags.Contains(key);
        if (isFlag ? req.Value is not (0 or 1) : req.Value < -1) throw new ValidationException("value", isFlag ? "A switch is 0 (off) or 1 (on)." : "Use a number, or -1 for unlimited.");
        var reason = (req.Reason ?? "").Trim();
        if (reason.Length is < 3 or > 200) throw new ValidationException("reason", "Say why (3 to 200 characters); it is kept in the audit log.");
        if (req.ExpiresInDays is { } d && d is < 1 or > 730) throw new ValidationException("expiresInDays", "Choose between 1 and 730 days, or no end date.");

        var row = await db.TenantFeatureOverrides.FirstOrDefaultAsync(o => o.TenantId == tenantId && o.FeatureKey == key, ct);
        var old = row?.Value;
        if (row is null) db.TenantFeatureOverrides.Add(row = new TenantFeatureOverride { TenantId = tenantId, FeatureKey = key, CreatedAt = clock.Now, CreatedBy = ctx.UserId });
        row.Value = req.Value; row.Reason = reason; row.ExpiresAt = req.ExpiresInDays is { } days ? clock.Now.AddDays(days) : null; row.UpdatedAt = clock.Now;
        recorder.Audit("admin.feature_override_set", "Tenant", tenantId, oldValue: old is null ? null : new { key, value = old }, newValue: new { key, req.Value, reason, row.ExpiresAt }, tenantId: tenantId);
        await db.SaveChangesAsync(ct);
        return await OverridesAsync(tenantId, ct);
    }

    public async Task<IReadOnlyList<FeatureOverrideDto>> RemoveOverrideAsync(Guid tenantId, string key, CancellationToken ct = default)
    {
        RequireAdmin();
        var row = await db.TenantFeatureOverrides.FirstOrDefaultAsync(o => o.TenantId == tenantId && o.FeatureKey == key, ct) ?? throw new NotFoundException("No exception for that feature.");
        db.TenantFeatureOverrides.Remove(row);
        recorder.Audit("admin.feature_override_removed", "Tenant", tenantId, oldValue: new { key, row.Value, row.Reason }, tenantId: tenantId);
        await db.SaveChangesAsync(ct);
        return await OverridesAsync(tenantId, ct);
    }

    // ---------------------------------------------------------------- platform settings

    public static async Task<PlatformSettingsDto> ReadSettingsAsync(IAppDbContext db, CancellationToken ct)
    {
        var rows = await db.PlatformSettings.AsNoTracking().ToDictionaryAsync(s => s.Key, s => s.Value, ct);
        string? Get(string k) => rows.GetValueOrDefault(k);
        var text = Get(KeyAnnouncement);
        return new PlatformSettingsDto(Get(KeySignups) != "false", Get(KeyMaintenance) == "true", string.IsNullOrWhiteSpace(text) ? null : text, Get(KeyAnnouncementLevel) is { } l && Levels.Contains(l) ? l : "info");
    }

    public async Task<PlatformSettingsDto> GetSettingsAsync(CancellationToken ct = default)
    {
        RequireAdmin();
        return await ReadSettingsAsync(db, ct);
    }

    /// <summary>What every visitor may know: whether the platform is in maintenance and the announcement text.</summary>
    public async Task<PlatformStatusDto> StatusAsync(CancellationToken ct = default)
    {
        var s = await settingsCache.GetAsync(ct);
        return new PlatformStatusDto(s.MaintenanceMode, s.Announcement, s.AnnouncementLevel);
    }

    public async Task<PlatformSettingsDto> SetSettingsAsync(PlatformSettingsDto req, CancellationToken ct = default)
    {
        RequireAdmin();
        var text = string.IsNullOrWhiteSpace(req.Announcement) ? "" : req.Announcement.Trim();
        if (text.Length > 300) throw new ValidationException("announcement", "Keep the announcement under 300 characters.");
        if (!Levels.Contains(req.AnnouncementLevel ?? "")) throw new ValidationException("announcementLevel", "Choose info, warning or danger.");

        var before = await ReadSettingsAsync(db, ct);
        var rows = await db.PlatformSettings.ToDictionaryAsync(s => s.Key, ct);
        void Put(string key, string value)
        {
            if (rows.TryGetValue(key, out var r)) { r.Value = value; r.UpdatedAt = clock.Now; }
            else db.PlatformSettings.Add(new PlatformSetting { Key = key, Value = value, CreatedAt = clock.Now, CreatedBy = ctx.UserId });
        }
        Put(KeySignups, req.SignupsEnabled ? "true" : "false"); Put(KeyMaintenance, req.MaintenanceMode ? "true" : "false");
        Put(KeyAnnouncement, text); Put(KeyAnnouncementLevel, req.AnnouncementLevel!);
        recorder.Audit("admin.platform_settings", "Platform", null, oldValue: before, newValue: new { req.SignupsEnabled, req.MaintenanceMode, Announcement = text, req.AnnouncementLevel });
        await db.SaveChangesAsync(ct);
        settingsCache.Invalidate();
        return await ReadSettingsAsync(db, ct);
    }

    // ---------------------------------------------------------------- billing currency

    /// <summary>The platform's billing currency: what an administrator chose, otherwise the default (INR).</summary>
    public static async Task<string> ReadCurrencyAsync(IAppDbContext db, CancellationToken ct)
    {
        var value = await db.PlatformSettings.AsNoTracking().Where(s => s.Key == KeyBillingCurrency).Select(s => s.Value).FirstOrDefaultAsync(ct);
        return Currencies.Normalize(value);
    }

    public async Task<BillingSettingsDto> GetBillingSettingsAsync(CancellationToken ct = default)
    {
        RequireAdmin();
        return new BillingSettingsDto(await ReadCurrencyAsync(db, ct), Currencies.All);
    }

    /// <summary>
    /// Switches the currency every plan is priced in. Prices are NOT converted (₹999 becomes $999 unless the administrator also changes
    /// it); invoices already issued keep the currency they were issued in.
    /// </summary>
    public async Task<BillingSettingsDto> SetBillingSettingsAsync(SetBillingSettingsRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        if (!Currencies.IsSupported(req.Currency)) throw new ValidationException("currency", "Choose one of the listed currencies.");
        var currency = Currencies.Normalize(req.Currency);
        var before = await ReadCurrencyAsync(db, ct);

        var row = await db.PlatformSettings.FirstOrDefaultAsync(s => s.Key == KeyBillingCurrency, ct);
        if (row is null) db.PlatformSettings.Add(new PlatformSetting { Key = KeyBillingCurrency, Value = currency, CreatedAt = clock.Now, CreatedBy = ctx.UserId });
        else { row.Value = currency; row.UpdatedAt = clock.Now; }
        var plans = await db.Plans.Where(p => p.Currency != currency).ToListAsync(ct);
        foreach (var p in plans) p.Currency = currency;

        if (before != currency)
            recorder.Audit("admin.billing_currency", "Platform", null, oldValue: before, newValue: new { Currency = currency, PlansUpdated = plans.Count });
        await db.SaveChangesAsync(ct);
        return new BillingSettingsDto(currency, Currencies.All);
    }

    // ---------------------------------------------------------------- password policy

    public const string KeyPasswordPolicy = "password_policy";

    public static async Task<Features.Auth.PasswordPolicyDto> ReadPasswordPolicyAsync(IAppDbContext db, CancellationToken ct) =>
        Features.Auth.PasswordRules.Parse(await db.PlatformSettings.AsNoTracking().Where(s => s.Key == KeyPasswordPolicy).Select(s => s.Value).FirstOrDefaultAsync(ct));

    public async Task<Features.Auth.PasswordPolicyDto> GetPasswordPolicyAsync(CancellationToken ct = default)
    {
        RequireAdmin();
        return await ReadPasswordPolicyAsync(db, ct);
    }

    /// <summary>Applies to passwords chosen from now on; existing passwords keep working until their owners change them.</summary>
    public async Task<Features.Auth.PasswordPolicyDto> SetPasswordPolicyAsync(Features.Auth.PasswordPolicyDto req, CancellationToken ct = default)
    {
        RequireAdmin();
        if (req.MinLength is < Features.Auth.PasswordRules.MinAllowed or > Features.Auth.PasswordRules.MaxAllowed)
            throw new ValidationException("minLength", $"Choose a minimum length between {Features.Auth.PasswordRules.MinAllowed} and {Features.Auth.PasswordRules.MaxAllowed}.");
        if (req.HistoryCount is < 0 or > Features.Auth.PasswordRules.MaxHistory)
            throw new ValidationException("historyCount", $"Remember between 0 and {Features.Auth.PasswordRules.MaxHistory} previous passwords.");

        var before = await ReadPasswordPolicyAsync(db, ct);
        var row = await db.PlatformSettings.FirstOrDefaultAsync(s => s.Key == KeyPasswordPolicy, ct);
        var value = Features.Auth.PasswordRules.Serialize(req);
        if (row is null) db.PlatformSettings.Add(new PlatformSetting { Key = KeyPasswordPolicy, Value = value, CreatedAt = clock.Now, CreatedBy = ctx.UserId });
        else { row.Value = value; row.UpdatedAt = clock.Now; }
        recorder.Audit("admin.password_policy", "Platform", null, oldValue: before, newValue: req);
        await db.SaveChangesAsync(ct);
        settingsCache.Invalidate();
        return await ReadPasswordPolicyAsync(db, ct);
    }

    // ---------------------------------------------------------------- consent documents (Terms of Service, Privacy Policy)

    private const string ConsentKeyPrefix = "consent_";
    private static readonly IReadOnlyDictionary<string, string> ConsentTitles = new Dictionary<string, string>
    {
        [Domain.ConsentTypes.TermsOfService] = "Terms of Service",
        [Domain.ConsentTypes.PrivacyPolicy] = "Privacy Policy",
    };
    private static readonly IReadOnlyDictionary<string, string> ConsentDefaults = new Dictionary<string, string>
    {
        [Domain.ConsentTypes.TermsOfService] = "By using this service you agree to use it lawfully and in good faith. The organization that runs your workspace is responsible for the data it puts into it. This placeholder text should be replaced by an administrator with the platform's real terms.",
        [Domain.ConsentTypes.PrivacyPolicy] = "We store the account and workspace data you give us in order to provide the service, and nothing more. This placeholder text should be replaced by an administrator with the platform's real privacy policy.",
    };

    /// <summary>Documents nobody has published yet read as version 0 with placeholder text, so sign-up still works out of the box;
    /// the first real publish moves them to version 1, which is also the first time anyone is asked to re-accept.</summary>
    public static readonly IReadOnlyList<ConsentDocumentDto> DefaultConsentDocuments =
        Domain.ConsentTypes.All.Select(t => new ConsentDocumentDto(t, 0, ConsentTitles[t], ConsentDefaults[t], null)).ToList();

    private record ConsentStored(int Version, string Title, string Body, DateTime PublishedAt);

    public static async Task<IReadOnlyList<ConsentDocumentDto>> ReadConsentDocumentsAsync(IAppDbContext db, CancellationToken ct)
    {
        var rows = await db.PlatformSettings.AsNoTracking().Where(s => s.Key.StartsWith(ConsentKeyPrefix)).ToDictionaryAsync(s => s.Key, s => s.Value, ct);
        return Domain.ConsentTypes.All.Select(type =>
        {
            if (rows.TryGetValue(ConsentKeyPrefix + type, out var json) && JsonSerializer.Deserialize<ConsentStored>(json) is { } stored)
                return new ConsentDocumentDto(type, stored.Version, stored.Title, stored.Body, stored.PublishedAt);
            var d = DefaultConsentDocuments.First(x => x.Type == type);
            return d;
        }).ToList();
    }

    public async Task<IReadOnlyList<ConsentDocumentDto>> GetConsentDocumentsForAdminAsync(CancellationToken ct = default)
    {
        RequireAdmin();
        return await ReadConsentDocumentsAsync(db, ct);
    }

    /// <summary>Publishing a new version asks everyone who already accepted an older one to accept again before they can
    /// keep changing anything (ConsentMiddleware); it never signs anyone out or blocks reading.</summary>
    public async Task<ConsentDocumentDto> PublishConsentDocumentAsync(SetConsentDocumentRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        if (!Domain.ConsentTypes.All.Contains(req.Type)) throw new ValidationException("type", "Unknown document.");
        var title = (req.Title ?? "").Trim();
        if (title.Length is < 2 or > 150) throw new ValidationException("title", "Choose a title between 2 and 150 characters.");
        var body = (req.Body ?? "").Trim();
        if (body.Length is < 20 or > 50_000) throw new ValidationException("body", "The document should be at least 20 characters.");

        var current = (await ReadConsentDocumentsAsync(db, ct)).First(d => d.Type == req.Type);
        var stored = new ConsentStored(current.Version + 1, title, body, clock.Now);
        var row = await db.PlatformSettings.FirstOrDefaultAsync(s => s.Key == ConsentKeyPrefix + req.Type, ct);
        var value = JsonSerializer.Serialize(stored);
        if (row is null) db.PlatformSettings.Add(new PlatformSetting { Key = ConsentKeyPrefix + req.Type, Value = value, CreatedAt = clock.Now, CreatedBy = ctx.UserId });
        else { row.Value = value; row.UpdatedAt = clock.Now; }
        recorder.Audit("admin.consent_document_published", "Platform", null, oldValue: new { current.Version, current.Title }, newValue: new { req.Type, stored.Version, title });
        await db.SaveChangesAsync(ct);
        settingsCache.Invalidate();
        return new ConsentDocumentDto(req.Type, stored.Version, title, body, stored.PublishedAt);
    }

    // ---------------------------------------------------------------- health

    public async Task<SystemHealthDto> HealthAsync(CancellationToken ct = default)
    {
        RequireAdmin();
        var now = DateTime.UtcNow;

        var sw = System.Diagnostics.Stopwatch.StartNew();
        bool reachable; string? error = null; var pending = 0;
        try { reachable = await db.Database.CanConnectAsync(ct); if (reachable) pending = await db.PendingMigrationCountAsync(ct); }
        catch (Exception ex) { reachable = false; error = ex.GetType().Name; }
        sw.Stop();
        var database = new DatabaseHealthDto(db.Database.ProviderName?.Split('.').LastOrDefault() ?? "unknown", reachable, sw.ElapsedMilliseconds, pending, error);

        // A round trip through the shared cache: proves it is reachable and shows how long it takes.
        var provider = string.IsNullOrWhiteSpace(config["Redis:ConnectionString"]) ? "Memory (this server only)" : "Redis";
        CacheHealthDto cacheHealth;
        var probe = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            var key = "health:probe";
            await cache.SetAsync(key, [1], new Microsoft.Extensions.Caching.Distributed.DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(30) }, ct);
            var back = await cache.GetAsync(key, ct);
            cacheHealth = new CacheHealthDto(provider, back is { Length: 1 }, probe.ElapsedMilliseconds, back is { Length: 1 } ? null : "Value did not come back");
        }
        catch (Exception ex) when (ex is not OperationCanceledException) { cacheHealth = new CacheHealthDto(provider, false, probe.ElapsedMilliseconds, ex.GetType().Name); }

        var workers = heartbeats.All.Select(b =>
        {
            var late = now - b.LastRunAt > TimeSpan.FromSeconds(b.IntervalSeconds * 3 + 60);
            return new WorkerHealthDto(b.Name, b.LastError is not null ? "error" : late ? "stalled" : "ok", b.LastRunAt, b.IntervalSeconds, b.LastError);
        }).ToList();

        QueueHealthDto queues;
        double storageMb = 0;
        if (reachable)
        {
            queues = new QueueHealthDto(
                await db.Notifications.IgnoreQueryFilters().CountAsync(n => n.EmailPending && n.EmailAttempts < 5, ct),
                await db.Notifications.IgnoreQueryFilters().CountAsync(n => n.EmailPending && n.EmailAttempts >= 5, ct),
                await db.ReportExports.IgnoreQueryFilters().CountAsync(e => e.Status == ReportExportStatus.Queued || e.Status == ReportExportStatus.Running, ct),
                await db.ReportExports.IgnoreQueryFilters().CountAsync(e => e.Status == ReportExportStatus.Failed, ct),
                await db.WebhookDeliveries.IgnoreQueryFilters().CountAsync(d => d.Status == WebhookDeliveryStatus.Pending, ct),
                await db.WebhookDeliveries.IgnoreQueryFilters().CountAsync(d => d.Status == WebhookDeliveryStatus.Failed, ct));
            storageMb = Math.Round((await db.Attachments.IgnoreQueryFilters().SumAsync(a => (long?)a.SizeBytes, ct) ?? 0) / 1024d / 1024d, 1);
        }
        else queues = new QueueHealthDto(0, 0, 0, 0, 0, 0);

        var status = !reachable ? "down" : pending > 0 || workers.Any(w => w.Status != "ok") || queues.EmailsStuck > 0 || !cacheHealth.Reachable ? "degraded" : "ok";
        var version = Assembly.GetEntryAssembly()?.GetName().Version?.ToString(3) ?? "1.0.0";
        return new SystemHealthDto(status, version, RuntimeInformation.FrameworkDescription, metrics.StartedAt, (long)(now - metrics.StartedAt).TotalSeconds, database, workers, queues,
            new TrafficHealthDto(metrics.Requests, metrics.ServerErrors, metrics.ClientErrors, metrics.LastServerErrorAt), storageMb, cacheHealth);
    }
}
