using System.Text;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Documents;

public record DocActivityDto(Guid Id, DateTime At, string Action, string Summary, UserRefDto? By);
public record DocAuditDto(Guid Id, DateTime At, string Action, UserRefDto? By, string? Ip, string? Device, string? OldValue, string? NewValue);
public record DocAuditPageDto(IReadOnlyList<DocAuditDto> Items, string? NextCursor);

/// <summary>
/// What happened to a document. The activity of a document is visible to everyone who can open it (every plan). The audit trail, with who, from where and
/// what changed, is a Business feature for people who hold the audit permission; reading or exporting it is recorded in the trail itself.
/// </summary>
public class DocumentAuditService(IAppDbContext db, ICurrentContext ctx, Recorder recorder, PermissionService permissions, EntitlementService entitlements)
{
    public const int PageSize = 50, ExportMax = 5000;

    public async Task<IReadOnlyList<DocActivityDto>> ActivityAsync(Guid documentId, CancellationToken ct = default)
    {
        if (!await db.Documents.AnyAsync(d => d.Id == documentId, ct)) throw new NotFoundException("Document not found.");
        var rows = await db.Activities.AsNoTracking().Where(a => a.EntityType == "Document" && a.EntityId == documentId).OrderByDescending(a => a.CreatedAt).ThenByDescending(a => a.Id).Take(100).ToListAsync(ct);
        var ids = rows.Where(r => r.ActorId != null).Select(r => r.ActorId!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return rows.Select(r => new DocActivityDto(r.Id, r.CreatedAt, r.Action, r.Summary, r.ActorId is { } a ? new UserRefDto(a, names.GetValueOrDefault(a) ?? "Former member") : null)).ToList();
    }

    private async Task<Guid> RequireAuditAsync(Guid documentId, CancellationToken ct)
    {
        var tid = ctx.RequireTenantId();
        if (!await db.Documents.AnyAsync(d => d.Id == documentId, ct)) throw new NotFoundException("Document not found.");
        await entitlements.EnsureFeatureAsync(FeatureKeys.AuditLog, ct);
        await permissions.RequireAsync(Permissions.AuditView, ct);
        return tid;
    }

    private IQueryable<AuditLog> Trail(Guid tenant, Guid documentId, string? action) =>
        db.AuditLogs.AsNoTracking().Where(a => a.TenantId == tenant && a.EntityType == "Document" && a.EntityId == documentId && (action == null || a.Action == action));

    public async Task<DocAuditPageDto> AuditAsync(Guid documentId, string? action, string? cursor, CancellationToken ct = default)
    {
        var tid = await RequireAuditAsync(documentId, ct);
        var q = Trail(tid, documentId, string.IsNullOrWhiteSpace(action) ? null : action.Trim());
        if (DocumentService.Cursor.TryParse(cursor, out var at, out var after)) q = q.Where(a => a.CreatedAt < at || (a.CreatedAt == at && a.Id.CompareTo(after) < 0));
        var rows = await q.OrderByDescending(a => a.CreatedAt).ThenByDescending(a => a.Id).Take(PageSize + 1).ToListAsync(ct);
        var more = rows.Count > PageSize;
        if (more) rows.RemoveAt(PageSize);
        var ids = rows.Where(r => r.UserId != null).Select(r => r.UserId!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        if (cursor is null)
        {
            recorder.Audit("document.audit_viewed", "Document", documentId);
            await db.SaveChangesAsync(ct);
        }
        return new DocAuditPageDto(rows.Select(r => new DocAuditDto(r.Id, r.CreatedAt, r.Action, r.UserId is { } u ? new UserRefDto(u, names.GetValueOrDefault(u) ?? "Former member") : null, r.IpAddress, r.UserAgent, r.OldValue, r.NewValue)).ToList(),
            more ? DocumentService.Cursor.Make(rows[^1].CreatedAt, rows[^1].Id) : null);
    }

    public async Task<string> ExportCsvAsync(Guid documentId, CancellationToken ct = default)
    {
        var tid = await RequireAuditAsync(documentId, ct);
        var rows = await Trail(tid, documentId, null).OrderBy(a => a.CreatedAt).ThenBy(a => a.Id).Take(ExportMax).ToListAsync(ct);
        var ids = rows.Where(r => r.UserId != null).Select(r => r.UserId!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var sb = new StringBuilder("When (UTC),Action,Person,IP address,Device,Before,After\r\n");
        foreach (var r in rows)
            sb.Append(string.Join(',', Cell($"{r.CreatedAt:yyyy-MM-dd HH:mm:ss}"), Cell(r.Action), Cell(r.UserId is { } u ? names.GetValueOrDefault(u) ?? "Former member" : ""), Cell(r.IpAddress), Cell(r.UserAgent), Cell(r.OldValue), Cell(r.NewValue))).Append("\r\n");
        recorder.Audit("document.audit_exported", "Document", documentId, null, new { rows = rows.Count });
        await db.SaveChangesAsync(ct);
        return sb.ToString();
    }

    /// <summary>A CSV cell that a spreadsheet will not run as a formula.</summary>
    private static string Cell(string? v)
    {
        v ??= "";
        if (v.Length > 0 && "=+-@\t\r".Contains(v[0])) v = "'" + v;
        return "\"" + v.Replace("\"", "\"\"") + "\"";
    }
}
