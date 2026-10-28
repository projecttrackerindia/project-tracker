using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Platform;

/// <summary>A saved view: <see cref="Sharing"/> is private, workspace or team. <see cref="Mine"/>: the caller saved it (and may change it).</summary>
public record SavedViewDto(Guid Id, string Scope, string Name, string Sharing, Guid? TeamId, string? TeamName, Guid OwnerId, string OwnerName, bool Mine,
    JsonElement Config, DateTime CreatedAt);

/// <summary>Save or change a view. <see cref="Sharing"/>: private (default), workspace, or team (with <see cref="TeamId"/>).</summary>
public record SaveViewRequest(string? Scope, string? Name, string? Sharing, Guid? TeamId, JsonElement? Config);

/// <summary>
/// Saved views of My Work, Work lists, the Desk queue and the Portfolio: the filters, sort and grouping a person chose, under a name, kept
/// for them or shared with the workspace or one of their teams. Anyone may see the shared views of their workspace and teams; only the
/// person who saved a view (or an owner or admin) changes or removes it. Guests keep private views only.
/// </summary>
public class SavedViewService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder)
{
    public static readonly IReadOnlySet<string> Scopes = new HashSet<string>(StringComparer.Ordinal) { "mywork", "work", "desk", "portfolio" };
    public const int MaxPerPerson = 50;
    public const int MaxConfig = 8000;

    private bool IsAdmin => ctx.Role is TenantRole.Owner or TenantRole.Admin;

    public async Task<IReadOnlyList<SavedViewDto>> ListAsync(string? scope, CancellationToken ct = default)
    {
        ctx.RequireTenantId(); var me = ctx.RequireUserId();
        var s = Scope(scope);
        var myTeams = await db.TeamMembers.AsNoTracking().Where(m => m.UserId == me).Select(m => m.TeamId).ToListAsync(ct);
        var rows = await db.SavedViews.AsNoTracking()
            .Where(v => v.Scope == s && (v.OwnerId == me || (v.Shared && (v.TeamId == null || myTeams.Contains(v.TeamId.Value)))))
            .OrderBy(v => v.CreatedAt).Take(200).ToListAsync(ct);
        return await ToDtosAsync(rows, me, ct);
    }

    public async Task<SavedViewDto> CreateAsync(SaveViewRequest req, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId(); var me = ctx.RequireUserId();
        var s = Scope(req.Scope);
        if (await db.SavedViews.CountAsync(v => v.OwnerId == me && v.Scope == s, ct) >= MaxPerPerson)
            throw new ValidationException("name", $"You can keep up to {MaxPerPerson} views here. Remove one you no longer use first.");
        var row = new SavedView { TenantId = tid, OwnerId = me, Scope = s, CreatedAt = clock.Now, CreatedBy = me };
        await ApplyAsync(row, req, ct);
        db.SavedViews.Add(row);
        recorder.Audit("saved_view.created", nameof(SavedView), row.Id, newValue: new { row.Scope, row.Name, row.Shared, row.TeamId });
        await db.SaveChangesAsync(ct);
        return (await ToDtosAsync([row], me, ct))[0];
    }

    public async Task<SavedViewDto> UpdateAsync(Guid id, SaveViewRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var row = await FindEditableAsync(id, ct);
        await ApplyAsync(row, req with { Scope = row.Scope }, ct);
        row.UpdatedAt = clock.Now; row.UpdatedBy = me;
        recorder.Audit("saved_view.updated", nameof(SavedView), row.Id, newValue: new { row.Scope, row.Name, row.Shared, row.TeamId });
        await db.SaveChangesAsync(ct);
        return (await ToDtosAsync([row], me, ct))[0];
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        var row = await FindEditableAsync(id, ct);
        db.SavedViews.Remove(row);
        recorder.Audit("saved_view.deleted", nameof(SavedView), row.Id, oldValue: new { row.Scope, row.Name });
        await db.SaveChangesAsync(ct);
    }

    private async Task<SavedView> FindEditableAsync(Guid id, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var row = await db.SavedViews.FirstOrDefaultAsync(v => v.Id == id, ct) ?? throw new NotFoundException("View not found.", "VIEW_NOT_FOUND");
        if (row.OwnerId == me) return row;
        if (row.Shared && IsAdmin) return row;
        if (!row.Shared) throw new NotFoundException("View not found.", "VIEW_NOT_FOUND");
        throw new ForbiddenException("Only the person who saved this view, or an admin, can change it.", "PERMISSION_DENIED");
    }

    private async Task ApplyAsync(SavedView row, SaveViewRequest req, CancellationToken ct)
    {
        var name = (req.Name ?? "").Trim();
        if (name.Length == 0) throw new ValidationException("name", "Give the view a name.");
        if (name.Length > 80) throw new ValidationException("name", "Keep the name to 80 characters.");
        var config = req.Config is { ValueKind: JsonValueKind.Object } c ? c.GetRawText() : "{}";
        if (config.Length > MaxConfig) throw new ValidationException("config", "This view has too many filters to save.");
        var sharing = (req.Sharing ?? "private").Trim().ToLowerInvariant();
        switch (sharing)
        {
            case "private": row.Shared = false; row.TeamId = null; break;
            case "workspace":
                if (ctx.Role == TenantRole.Guest) throw new ForbiddenException("Guests can keep views for themselves only.", "PERMISSION_DENIED");
                row.Shared = true; row.TeamId = null; break;
            case "team":
                if (ctx.Role == TenantRole.Guest) throw new ForbiddenException("Guests can keep views for themselves only.", "PERMISSION_DENIED");
                var team = req.TeamId ?? throw new ValidationException("teamId", "Choose the team to share it with.");
                var me = ctx.RequireUserId();
                if (!await db.Teams.AnyAsync(t => t.Id == team, ct)) throw new ValidationException("teamId", "Team not found.");
                if (!IsAdmin && !await db.TeamMembers.AnyAsync(m => m.TeamId == team && m.UserId == me, ct))
                    throw new ForbiddenException("Share with a team you are in.", "PERMISSION_DENIED");
                row.Shared = true; row.TeamId = team; break;
            default: throw new ValidationException("sharing", "Use private, workspace or team.");
        }
        row.Name = name; row.ConfigJson = config;
    }

    private static string Scope(string? scope)
    {
        var s = (scope ?? "").Trim().ToLowerInvariant();
        return Scopes.Contains(s) ? s : throw new ValidationException("scope", "Use mywork, work, desk or portfolio.");
    }

    private async Task<IReadOnlyList<SavedViewDto>> ToDtosAsync(IReadOnlyList<SavedView> rows, Guid me, CancellationToken ct)
    {
        var owners = await FieldDiff.NamesAsync(db, rows.Select(r => (Guid?)r.OwnerId), ct);
        var teamIds = rows.Where(r => r.TeamId != null).Select(r => r.TeamId!.Value).Distinct().ToList();
        var teams = teamIds.Count == 0 ? new Dictionary<Guid, string>() : await db.Teams.AsNoTracking().Where(t => teamIds.Contains(t.Id)).ToDictionaryAsync(t => t.Id, t => t.Name, ct);
        return rows.Select(r => new SavedViewDto(r.Id, r.Scope, r.Name, !r.Shared ? "private" : r.TeamId is null ? "workspace" : "team", r.TeamId,
            r.TeamId is { } t ? teams.GetValueOrDefault(t) : null, r.OwnerId, owners.GetValueOrDefault(r.OwnerId, "Someone"), r.OwnerId == me,
            Parse(r.ConfigJson), r.CreatedAt)).ToList();
    }

    private static JsonElement Parse(string json)
    {
        try { using var doc = JsonDocument.Parse(json); return doc.RootElement.Clone(); }
        catch (JsonException) { using var empty = JsonDocument.Parse("{}"); return empty.RootElement.Clone(); }
    }
}
