using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Platform;

/// <summary>Where a provider processes data, as configured by the platform (DataLocation:Providers:{key}).</summary>
public class ProviderLocation
{
    public string Name { get; set; } = "";
    /// <summary>Shown to people, e.g. "United States" or "Mumbai, India".</summary>
    public string Location { get; set; } = "";
    public bool InIndia { get; set; }
}

/// <summary>
/// Where the platform keeps data (configuration section "DataLocation"). Only regions are shown to people - never servers, hosts or accounts.
/// </summary>
public class DataLocationOptions
{
    public const string Section = "DataLocation";
    public string Region { get; set; } = "asia-south1";
    public string RegionName { get; set; } = "Mumbai, India";
    public string BackupRegionName { get; set; } = "Mumbai, India";
    public string Country { get; set; } = "India";
    /// <summary>Integrations and AI providers by key (anthropic, openai, slack, ...): their name, where they process data, and whether that is in India.</summary>
    public Dictionary<string, ProviderLocation> Providers { get; set; } = new(StringComparer.OrdinalIgnoreCase)
    {
        ["anthropic"] = new() { Name = "Claude (Anthropic)", Location = "United States", InIndia = false },
        ["openai"] = new() { Name = "ChatGPT (OpenAI)", Location = "United States", InIndia = false },
        ["slack"] = new() { Name = "Slack", Location = "United States", InIndia = false },
    };
}

public record DataProviderDto(string Key, string Name, string Location, bool InIndia, bool InUse);
public record DataLocationDto(string Region, string RegionName, string BackupRegionName, string Country, bool KeepDataInIndia, bool CanManage,
    IReadOnlyList<DataProviderDto> Providers);
public record SetDataLocationRequest(bool KeepDataInIndia);

/// <summary>
/// Settings › Security › Data location: where the workspace's data and backups are kept (the region only), which integrations and AI providers
/// would process data elsewhere, and the organization's "Keep data in India" choice. With it on, those providers cannot be turned on;
/// ones already in use keep working until an admin turns them off, and the page says which they are.
/// </summary>
public class DataLocationService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, IOptions<DataLocationOptions> options)
{
    private readonly DataLocationOptions _o = options.Value;

    private bool CanManage => !ctx.ViaApiKey && ctx.Role is TenantRole.Owner or TenantRole.Admin;

    public async Task<DataLocationDto> GetAsync(CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var keep = await db.TenantSecuritySettings.AsNoTracking().Where(s => s.TenantId == tid).Select(s => s.KeepDataInIndia).FirstOrDefaultAsync(ct);
        var inUse = await InUseAsync(tid, ct);
        var providers = _o.Providers.Select(p => new DataProviderDto(p.Key.ToLowerInvariant(), p.Value.Name, p.Value.Location, p.Value.InIndia, inUse.Contains(p.Key.ToLowerInvariant())))
            .OrderBy(p => p.InIndia).ThenBy(p => p.Name).ToList();
        return new DataLocationDto(_o.Region, _o.RegionName, _o.BackupRegionName, _o.Country, keep, CanManage, providers);
    }

    public async Task<DataLocationDto> SetAsync(SetDataLocationRequest req, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        if (!CanManage) throw new ForbiddenException("Only owners and admins can change where data may go.", "PERMISSION_DENIED");
        var row = await db.TenantSecuritySettings.FirstOrDefaultAsync(s => s.TenantId == tid, ct);
        if (row is null)
        {
            row = new TenantSecuritySettings { TenantId = tid, CreatedAt = clock.Now, CreatedBy = ctx.UserId };
            db.TenantSecuritySettings.Add(row);
        }
        var before = row.KeepDataInIndia;
        row.KeepDataInIndia = req.KeepDataInIndia;
        row.UpdatedAt = clock.Now; row.UpdatedBy = ctx.UserId;
        if (before != req.KeepDataInIndia)
            recorder.Audit("org.data_location_changed", nameof(TenantSecuritySettings), row.Id, new { keepDataInIndia = before }, new { keepDataInIndia = req.KeepDataInIndia });
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    /// <summary>
    /// Before an integration or AI provider is turned on: when the organization keeps its data in India and the provider processes data
    /// elsewhere, it is refused with a plain explanation. Providers the platform has not described are treated as outside India.
    /// </summary>
    public async Task EnsureAllowedAsync(string providerKey, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var keep = await db.TenantSecuritySettings.AsNoTracking().Where(s => s.TenantId == tid).Select(s => s.KeepDataInIndia).FirstOrDefaultAsync(ct);
        if (!keep) return;
        var known = _o.Providers.TryGetValue(providerKey, out var p);
        if (known && p!.InIndia) return;
        var name = known ? p!.Name : providerKey;
        var where = known && !string.IsNullOrWhiteSpace(p!.Location) ? $" processes data in {p.Location}, so it" : "";
        throw new ForbiddenException(
            $"Your organization keeps its data in India. {name}{where} can’t be turned on while that is set. An owner or admin can review this in Settings › Security › Data location.",
            "DATA_LOCATION_INDIA");
    }

    private async Task<HashSet<string>> InUseAsync(Guid tid, CancellationToken ct)
    {
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var ai = await db.AiWorkspaceProviders.AsNoTracking().Where(x => x.Enabled).Select(x => x.Provider).ToListAsync(ct);
        foreach (var a in ai) used.Add(a.ToLowerInvariant());
        if (await db.SlackConnections.AsNoTracking().AnyAsync(x => x.TenantId == tid && x.Active, ct)) used.Add("slack");
        return used;
    }
}
