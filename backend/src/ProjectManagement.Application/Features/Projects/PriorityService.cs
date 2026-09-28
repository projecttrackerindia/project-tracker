using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Projects;

public record PriorityDto(Priority Level, string Name, string Color, bool IsCustom);
public record PriorityInput(Priority Level, string Name, string Color);
public record SetPrioritiesRequest(IReadOnlyList<PriorityInput> Items);

/// <summary>
/// Custom names and colours for the four priority levels of a workspace. The levels themselves never change, so sorting, reports and
/// automation rules keep the same meaning; only how they are shown does.
/// </summary>
public partial class PriorityService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, EntitlementService entitlements)
{
    public static readonly IReadOnlyDictionary<Priority, (string Name, string Color)> Defaults = new Dictionary<Priority, (string, string)>
    {
        [Priority.Critical] = ("Critical", "#ef4444"), [Priority.High] = ("High", "#f59e0b"), [Priority.Medium] = ("Medium", "#38bdf8"), [Priority.Low] = ("Low", "#94a3b8"),
    };

    [GeneratedRegex("^#[0-9a-fA-F]{6}$")]
    private static partial Regex HexColor();

    /// <summary>Highest first, each with the workspace's own name and colour when it has set one.</summary>
    public async Task<IReadOnlyList<PriorityDto>> GetAsync(CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var custom = await db.PrioritySettings.AsNoTracking().ToDictionaryAsync(p => p.Level, ct);
        return Order.Select(l => custom.TryGetValue(l, out var c) ? new PriorityDto(l, c.Name, c.Color, true) : new PriorityDto(l, Defaults[l].Name, Defaults[l].Color, false)).ToList();
    }

    /// <summary>Level → display name, for exports and other text output.</summary>
    public async Task<IReadOnlyDictionary<Priority, string>> NamesAsync(CancellationToken ct = default) =>
        (await GetAsync(ct)).ToDictionary(p => p.Level, p => p.Name);

    private static readonly Priority[] Order = [Priority.Critical, Priority.High, Priority.Medium, Priority.Low];

    public async Task<IReadOnlyList<PriorityDto>> SetAsync(SetPrioritiesRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.WorkflowManage, ct);
        await entitlements.EnsureFeatureAsync(FeatureKeys.CustomWorkflows, ct);
        var tid = ctx.RequireTenantId();

        var items = req.Items ?? [];
        if (items.Select(i => i.Level).Distinct().Count() != items.Count) throw new ValidationException("items", "Each priority level can appear only once.");
        var cleaned = new List<(Priority Level, string Name, string Color)>();
        foreach (var i in items)
        {
            if (!Enum.IsDefined(i.Level)) throw new ValidationException("level", "Unknown priority level.");
            var name = (i.Name ?? "").Trim();
            if (name.Length is < 1 or > 20) throw new ValidationException("name", $"Give “{Defaults[i.Level].Name}” a name of 1 to 20 characters.");
            if (!HexColor().IsMatch(i.Color ?? "")) throw new ValidationException("color", "Colours look like #ef4444.");
            cleaned.Add((i.Level, name, i.Color!.ToLowerInvariant()));
        }
        // What people see must stay distinguishable: the final set of names (custom or default) has to be unique.
        var current = await db.PrioritySettings.ToListAsync(ct);
        var finalNames = Order.Select(l => cleaned.Any(c => c.Level == l) ? cleaned.First(c => c.Level == l).Name : current.FirstOrDefault(c => c.Level == l)?.Name ?? Defaults[l].Name).ToList();
        if (finalNames.Select(n => n.ToLowerInvariant()).Distinct().Count() != finalNames.Count) throw new ValidationException("name", "Two priorities cannot have the same name.");

        foreach (var (level, name, color) in cleaned)
        {
            var row = current.FirstOrDefault(c => c.Level == level);
            if (row is null) db.PrioritySettings.Add(new PrioritySetting { TenantId = tid, Level = level, Name = name, Color = color, CreatedAt = clock.Now, CreatedBy = ctx.UserId });
            else { row.Name = name; row.Color = color; row.UpdatedAt = clock.Now; }
        }
        recorder.Audit("priorities.updated", "PrioritySetting", null, newValue: cleaned.Select(c => new { c.Level, c.Name, c.Color }));
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    public async Task<IReadOnlyList<PriorityDto>> ResetAsync(CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.WorkflowManage, ct);
        db.PrioritySettings.RemoveRange(await db.PrioritySettings.ToListAsync(ct));
        recorder.Audit("priorities.reset", "PrioritySetting");
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }
}
