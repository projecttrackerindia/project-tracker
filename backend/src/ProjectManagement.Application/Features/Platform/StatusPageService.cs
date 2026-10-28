using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Platform;

public record StatusComponentConfig(Guid ApiId, string Name);
public record StatusApiOptionDto(Guid ApiId, string Name, string DocumentTitle);
public record StatusPageSettingsDto(bool CanManage, string Slug, string Title, bool Published, DateTime? PublishedAt, IReadOnlyList<StatusComponentConfig> Components,
    IReadOnlyList<StatusApiOptionDto> Available, string? Url);
public record SaveStatusPageRequest(string? Slug, string? Title, bool Published, IReadOnlyList<StatusComponentConfig>? Components);

/// <summary>One day of the 90-day bar: up, degraded or down (the worst incident open that day).</summary>
public record StatusDayDto(DateOnly Date, string State);
/// <summary>A component: operational, degraded or outage now; uptime over 90 days; one bar per day, oldest first.</summary>
public record StatusComponentDto(string Name, string State, decimal Uptime, IReadOnlyList<StatusDayDto> Days);
public record StatusIncidentDto(string Title, string Severity, DateTime StartedAt, DateTime? ResolvedAt, IReadOnlyList<string> Components);
/// <summary>The public page. <see cref="Source"/> says what the bars are worked out from (incidents: there are no automatic health checks).</summary>
public record PublicStatusDto(string Title, string Workspace, string State, IReadOnlyList<StatusComponentDto> Components, IReadOnlyList<StatusIncidentDto> Incidents,
    DateTime UpdatedAt, string Source);

/// <summary>
/// A workspace's public status page for its APIs (Settings › Status page), opt in, at /status/{slug}. The components are documented APIs an
/// admin picks and names; their state and the 90 days of bars come from incidents - critical or high priority tickets about that API's
/// project (or naming the API) - since the platform runs no health checks of its own. The public page shows names, states, dates and
/// incident titles with addresses, hosts, e-mail addresses and numbers that look like keys taken out; never servers, paths or people.
/// </summary>
public class StatusPageService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder)
{
    public const int Days = 90;
    public const int MaxComponents = 30;
    private static readonly Regex SlugRule = new("^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$", RegexOptions.CultureInvariant);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private bool CanManage => !ctx.ViaApiKey && ctx.Role is TenantRole.Owner or TenantRole.Admin;

    private void RequireManage()
    {
        if (!CanManage) throw new ForbiddenException("Only owners and admins can change the status page.", "PERMISSION_DENIED");
    }

    public async Task<StatusPageSettingsDto> GetSettingsAsync(CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        RequireManage();
        var row = await db.StatusPages.AsNoTracking().FirstOrDefaultAsync(ct);
        var tenant = await db.Tenants.AsNoTracking().Where(t => t.Id == tid).Select(t => new { t.Name, t.Slug }).FirstAsync(ct);
        var available = await (from a in db.ApiDefinitions.AsNoTracking()
                               join d in db.Documents.AsNoTracking() on a.DocumentId equals d.Id
                               orderby d.Title, a.SortOrder
                               select new StatusApiOptionDto(a.Id, a.Name, d.Title)).Take(200).ToListAsync(ct);
        return new StatusPageSettingsDto(true, row?.Slug ?? tenant.Slug, row?.Title ?? $"{tenant.Name} API status", row?.Published ?? false, row?.PublishedAt,
            row is null ? [] : Components(row.ComponentsJson), available, row is { Published: true } ? $"/status/{row.Slug}" : null);
    }

    public async Task<StatusPageSettingsDto> SaveAsync(SaveStatusPageRequest req, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        RequireManage();
        var slug = (req.Slug ?? "").Trim().ToLowerInvariant();
        if (!SlugRule.IsMatch(slug)) throw new ValidationException("slug", "Use 3 to 60 lowercase letters, numbers and dashes.");
        var title = (req.Title ?? "").Trim();
        if (title.Length == 0) throw new ValidationException("title", "Give the page a title.");
        if (title.Length > 120) throw new ValidationException("title", "Keep the title to 120 characters.");
        var components = (req.Components ?? []).GroupBy(c => c.ApiId).Select(g => g.First()).ToList();
        if (components.Count > MaxComponents) throw new ValidationException("components", $"Show at most {MaxComponents} components.");
        var ids = components.Select(c => c.ApiId).ToList();
        var known = await db.ApiDefinitions.AsNoTracking().Where(a => ids.Contains(a.Id)).ToDictionaryAsync(a => a.Id, a => a.Name, ct);
        var clean = new List<StatusComponentConfig>();
        foreach (var c in components)
        {
            if (!known.TryGetValue(c.ApiId, out var apiName)) throw new ValidationException("components", "One of the components is not a documented API of this workspace.");
            var name = string.IsNullOrWhiteSpace(c.Name) ? apiName : c.Name.Trim();
            if (name.Length > 80) throw new ValidationException("components", "Keep component names to 80 characters.");
            clean.Add(new StatusComponentConfig(c.ApiId, Scrub(name)));
        }
        if (req.Published && clean.Count == 0) throw new ValidationException("components", "Choose at least one API to show before publishing.");
        // Slugs are unique across every workspace (the page is found by it before any workspace is known).
        if (await db.StatusPages.IgnoreQueryFilters().AnyAsync(p => p.Slug == slug && p.TenantId != tid, ct))
            throw new ConflictException("That address is taken. Try another.", "STATUS_SLUG_TAKEN");

        var row = await db.StatusPages.FirstOrDefaultAsync(ct);
        if (row is null)
        {
            row = new StatusPage { TenantId = tid, CreatedAt = clock.Now, CreatedBy = ctx.UserId };
            db.StatusPages.Add(row);
        }
        var wasPublished = row.Published;
        row.Slug = slug; row.Title = title; row.Published = req.Published;
        row.ComponentsJson = JsonSerializer.Serialize(clean, Json);
        if (req.Published && !wasPublished) row.PublishedAt = clock.Now;
        row.UpdatedAt = clock.Now; row.UpdatedBy = ctx.UserId;
        recorder.Audit(req.Published == wasPublished ? "status_page.updated" : req.Published ? "status_page.published" : "status_page.unpublished", nameof(StatusPage), row.Id,
            newValue: new { slug, title, req.Published, components = clean.Count });
        await db.SaveChangesAsync(ct);
        return await GetSettingsAsync(ct);
    }

    /// <summary>The public page, without signing in. A page that does not exist or is not published is "not found" either way.</summary>
    public async Task<PublicStatusDto> PublicAsync(string slug, CancellationToken ct = default)
    {
        slug = (slug ?? "").Trim().ToLowerInvariant();
        if (!SlugRule.IsMatch(slug)) throw new NotFoundException("Status page not found.", "STATUS_PAGE_NOT_FOUND");
        // No workspace is signed in: every query below names the page's workspace itself.
        var page = await db.StatusPages.IgnoreQueryFilters().AsNoTracking().FirstOrDefaultAsync(p => p.Slug == slug && p.Published, ct)
            ?? throw new NotFoundException("Status page not found.", "STATUS_PAGE_NOT_FOUND");
        var tid = page.TenantId;
        var workspace = await db.Tenants.IgnoreQueryFilters().AsNoTracking().Where(t => t.Id == tid && !t.IsDeleted && t.Status == TenantStatus.Active)
            .Select(t => t.Name).FirstOrDefaultAsync(ct) ?? throw new NotFoundException("Status page not found.", "STATUS_PAGE_NOT_FOUND");

        var config = Components(page.ComponentsJson);
        var apiIds = config.Select(c => c.ApiId).ToList();
        var apis = await (from a in db.ApiDefinitions.IgnoreQueryFilters().AsNoTracking()
                          join d in db.Documents.IgnoreQueryFilters().AsNoTracking() on a.DocumentId equals d.Id
                          where a.TenantId == tid && d.TenantId == tid && !d.IsDeleted && apiIds.Contains(a.Id)
                          select new { a.Id, a.Name, d.ProjectId }).ToListAsync(ct);
        var shown = config.Where(c => apis.Any(a => a.Id == c.ApiId)).Select(c => (Config: c, Api: apis.First(a => a.Id == c.ApiId))).ToList();

        var now = clock.Now;
        var today = DateOnly.FromDateTime(now);
        var since = now.AddDays(-Days);
        var projectIds = shown.Where(s => s.Api.ProjectId != null).Select(s => s.Api.ProjectId!.Value).Distinct().ToList();
        // Incidents: critical or high priority tickets of the workspace, open in the window, about an API's project or naming it.
        var tickets = await db.WorkTasks.IgnoreQueryFilters().AsNoTracking()
            .Where(w => w.TenantId == tid && !w.IsDeleted && w.Kind == WorkTaskKind.Operational && (w.Priority == Priority.Critical || w.Priority == Priority.High)
                        && w.Status != WorkTaskStatus.Cancelled && (w.CompletedAt == null || w.CompletedAt >= since) && w.CreatedAt <= now)
            .OrderByDescending(w => w.CreatedAt).Take(2000)
            .Select(w => new { w.Title, w.Priority, w.CreatedAt, w.CompletedAt, w.RelatedProjectId, Open = w.Status != WorkTaskStatus.Completed })
            .ToListAsync(ct);

        var incidents = new List<(string Title, Priority Priority, DateTime Start, DateTime? End, bool Open, List<string> Components)>();
        foreach (var t in tickets)
        {
            var hit = shown.Where(s => (s.Api.ProjectId is { } p && t.RelatedProjectId == p)
                || t.Title.Contains(s.Api.Name, StringComparison.OrdinalIgnoreCase) || t.Title.Contains(s.Config.Name, StringComparison.OrdinalIgnoreCase))
                .Select(s => s.Config.Name).Distinct().ToList();
            if (hit.Count == 0) continue;
            incidents.Add((t.Title, t.Priority, t.CreatedAt, t.Open ? (DateTime?)null : (t.CompletedAt ?? t.CreatedAt), t.Open, hit));
        }

        var components = shown.Select(s =>
        {
            var mine = incidents.Where(i => i.Components.Contains(s.Config.Name)).ToList();
            var days = Enumerable.Range(0, Days).Select(k => today.AddDays(k - Days + 1)).Select(d =>
            {
                var start = d.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc); var end = start.AddDays(1);
                var open = mine.Where(i => i.Start < end && (i.End ?? now) >= start).ToList();
                return new StatusDayDto(d, open.Any(i => i.Priority == Priority.Critical) ? "down" : open.Count > 0 ? "degraded" : "up");
            }).ToList();
            // Uptime: the time critical incidents were open counts as down, high ones as half down.
            double lost = mine.Sum(i =>
            {
                var a = i.Start < since ? since : i.Start; var b = i.End ?? now;
                var minutes = Math.Max(0, (b - a).TotalMinutes);
                return i.Priority == Priority.Critical ? minutes : minutes / 2;
            });
            var uptime = Math.Round(Math.Clamp(100m - (decimal)(lost / (Days * 1440d) * 100), 0m, 100m), 2);
            var state = mine.Any(i => i.Open && i.Priority == Priority.Critical) ? "outage" : mine.Any(i => i.Open) ? "degraded" : "operational";
            return new StatusComponentDto(s.Config.Name, state, uptime, days);
        }).ToList();

        var overall = components.Any(c => c.State == "outage") ? "outage" : components.Any(c => c.State == "degraded") ? "degraded" : "operational";
        var list = incidents.OrderByDescending(i => i.Start).Take(20)
            .Select(i => new StatusIncidentDto(Scrub(i.Title), i.Priority == Priority.Critical ? "major" : "minor", i.Start, i.End, i.Components)).ToList();
        return new PublicStatusDto(page.Title, workspace, overall, components, list, now, "incidents");
    }

    private static List<StatusComponentConfig> Components(string json)
    {
        try { return JsonSerializer.Deserialize<List<StatusComponentConfig>>(json, Json) ?? []; }
        catch (JsonException) { return []; }
    }

    private static readonly Regex Url = new(@"\b(?:https?|ftp|wss?)://\S+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex Email = new(@"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", RegexOptions.CultureInvariant);
    private static readonly Regex Ip = new(@"\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b|\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){3,7}\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex Host = new(@"\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|in|co|dev|app|cloud|internal|local|lan|corp|svc|cluster)(?::\d+)?\b(?:/\S*)?", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex Secret = new(@"\b(?:[A-Za-z0-9_\-]{24,}|(?:key|token|secret|password|pwd)\s*[:=]\s*\S+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>Takes out what must never be public: links, e-mail addresses, IP addresses, host names and anything that looks like a key.</summary>
    public static string Scrub(string text)
    {
        var s = Url.Replace(text, "[link]");
        s = Email.Replace(s, "[address]");
        s = Secret.Replace(s, "[hidden]");
        s = Ip.Replace(s, "[address]");
        s = Host.Replace(s, "[host]");
        return s.Length > 200 ? s[..199] + "…" : s;
    }
}
