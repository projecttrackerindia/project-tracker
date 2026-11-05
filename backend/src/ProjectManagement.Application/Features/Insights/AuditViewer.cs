using System.Linq.Expressions;
using System.Text;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Insights;

/// <summary>What the admin's audit viewer filters on. Every field is optional; <see cref="Kind"/> is one of viewed, exported, changed, signin, security.</summary>
public record AuditQuery(string? Kind = null, Guid? UserId = null, string? EntityType = null, string? Action = null, DateOnly? From = null, DateOnly? To = null,
    string? Q = null, int Page = 1, int PageSize = 50);
public record AuditActorDto(Guid Id, string Name);
public record AuditFacetsDto(IReadOnlyList<AuditActorDto> People, IReadOnlyList<string> EntityTypes, long Total, DateTime? Oldest);
public record AuditCsv(byte[] Content, string FileName, int Rows);

/// <summary>
/// The workspace audit log as an admin reads it: who viewed, exported or changed what, filtered by person, kind, resource and dates, and
/// exported as CSV. Reads only this workspace's rows (AuditLogs is not tenant-filtered: every query names the workspace). The export is
/// itself audited ("audit.exported"), so pulling the log out leaves a trace in it.
/// </summary>
public class AuditViewerService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, EntitlementService entitlements)
{
    public const int MaxCsvRows = 50_000;

    // An action's verb decides its kind. The lists are the verbs this codebase writes (document.secret_revealed, vault.link_opened ...).
    private static readonly string[] Viewed = ["view", "reveal", "opened", "download", "listed", "copied", "read"];
    private static readonly string[] Exported = ["export"];
    private static readonly string[] SignIn = ["user.login", "user.mfa", "user.device_login", "session.", "sso.", "user.signed", "user.password", "user.passkey"];
    private static readonly string[] Security = ["org.", "vault.", "scim.", "member.role", "api_key", "apikey.", "data_policy."];

    private async Task<Guid> RequireAsync(CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.AuditView, ct);
        await entitlements.EnsureFeatureAsync(FeatureKeys.AuditLog, ct);
        return ctx.RequireTenantId();
    }

    private IQueryable<AuditLog> Filter(Guid tid, AuditQuery f)
    {
        var q = db.AuditLogs.AsNoTracking().Where(a => a.TenantId == tid);
        var viewed = Match(Viewed, false); var exported = Match(Exported, false); var signIn = Match(SignIn, true); var security = Match(Security, false);
        switch (f.Kind?.Trim().ToLowerInvariant())
        {
            case "viewed": q = q.Where(viewed).Where(Not(exported)); break;
            case "exported": q = q.Where(exported); break;
            case "signin": q = q.Where(signIn); break;
            case "security": q = q.Where(security); break;
            case "changed": q = q.Where(Not(viewed)).Where(Not(exported)).Where(Not(signIn)); break;
            case null or "" or "all": break;
            default: throw new ValidationException("kind", "Choose viewed, exported, changed, signin or security.");
        }
        if (f.UserId is { } uid) q = q.Where(a => a.UserId == uid);
        if (!string.IsNullOrWhiteSpace(f.EntityType)) { var et = f.EntityType.Trim(); q = q.Where(a => a.EntityType == et); }
        if (!string.IsNullOrWhiteSpace(f.Action)) { var ac = f.Action.Trim().ToLowerInvariant(); q = q.Where(a => a.Action.StartsWith(ac)); }
        if (f.From is { } from) { var start = from.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc); q = q.Where(a => a.CreatedAt >= start); }
        if (f.To is { } to) { var end = to.AddDays(1).ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc); q = q.Where(a => a.CreatedAt < end); }
        if (!string.IsNullOrWhiteSpace(f.Q))
        {
            var text = f.Q.Trim().ToLower();
            if (text.Length > 100) text = text[..100];
            q = q.Where(a => a.Action.ToLower().Contains(text) || a.EntityType.ToLower().Contains(text) || (a.IpAddress != null && a.IpAddress.Contains(text))
                || (a.User != null && a.User.DisplayName.ToLower().Contains(text)) || (a.NewValue != null && a.NewValue.ToLower().Contains(text)));
        }
        if (f.From is { } a0 && f.To is { } b0 && a0 > b0) throw new ValidationException("from", "The start date is after the end date.");
        return q;
    }

    private static readonly System.Reflection.MethodInfo ContainsMethod = typeof(string).GetMethod(nameof(string.Contains), [typeof(string)])!;
    private static readonly System.Reflection.MethodInfo StartsWithMethod = typeof(string).GetMethod(nameof(string.StartsWith), [typeof(string)])!;

    /// <summary>a =&gt; a.Action.Contains("w1") || a.Action.Contains("w2") ... with constants, which every provider translates.</summary>
    private static Expression<Func<AuditLog, bool>> Match(string[] words, bool prefix)
    {
        var a = Expression.Parameter(typeof(AuditLog), "a");
        var action = Expression.Property(a, nameof(AuditLog.Action));
        Expression body = Expression.Constant(false);
        foreach (var w in words) body = Expression.OrElse(body, Expression.Call(action, prefix ? StartsWithMethod : ContainsMethod, Expression.Constant(w)));
        return Expression.Lambda<Func<AuditLog, bool>>(body, a);
    }

    private static Expression<Func<AuditLog, bool>> Not(Expression<Func<AuditLog, bool>> e) =>
        Expression.Lambda<Func<AuditLog, bool>>(Expression.Not(e.Body), e.Parameters);

    public async Task<PagedResult<AuditLogDto>> ListAsync(AuditQuery f, CancellationToken ct = default)
    {
        var tid = await RequireAsync(ct);
        var q = Filter(tid, f);
        var p = new PageQuery(f.Page, f.PageSize);
        var total = await q.CountAsync(ct);
        var rows = await q.OrderByDescending(a => a.CreatedAt).ThenByDescending(a => a.Id).Skip((p.SafePage - 1) * p.SafeSize(200)).Take(p.SafeSize(200))
            .Select(a => new AuditLogDto(a.Id, a.TenantId, null, a.UserId, a.User != null ? a.User.DisplayName : null, a.Action, a.EntityType, a.EntityId,
                a.OldValue, a.NewValue, a.IpAddress, a.CreatedAt)).ToListAsync(ct);
        return new PagedResult<AuditLogDto>(rows, p.SafePage, p.SafeSize(200), total);
    }

    /// <summary>The choices for the filters: people who appear in this workspace's log and the kinds of resource it names.</summary>
    public async Task<AuditFacetsDto> FacetsAsync(CancellationToken ct = default)
    {
        var tid = await RequireAsync(ct);
        var mine = db.AuditLogs.AsNoTracking().Where(a => a.TenantId == tid);
        var userIds = mine.Where(a => a.UserId != null).Select(a => a.UserId!.Value).Distinct();
        var people = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id)).OrderBy(u => u.DisplayName).Take(500)
            .Select(u => new AuditActorDto(u.Id, u.DisplayName)).ToListAsync(ct);
        var types = await mine.Select(a => a.EntityType).Distinct().OrderBy(t => t).Take(200).ToListAsync(ct);
        var total = await mine.LongCountAsync(ct);
        var oldest = await mine.OrderBy(a => a.CreatedAt).Select(a => (DateTime?)a.CreatedAt).FirstOrDefaultAsync(ct);
        return new AuditFacetsDto(people, types, total, oldest);
    }

    /// <summary>The filtered log as CSV (newest first, at most <see cref="MaxCsvRows"/> rows). Cells that a spreadsheet would run as a formula are quoted safe.</summary>
    public async Task<AuditCsv> ExportCsvAsync(AuditQuery f, CancellationToken ct = default)
    {
        var tid = await RequireAsync(ct);
        var rows = await Filter(tid, f).OrderByDescending(a => a.CreatedAt).ThenByDescending(a => a.Id).Take(MaxCsvRows)
            .Select(a => new { a.CreatedAt, Who = a.User != null ? a.User.DisplayName : null, Email = a.User != null ? a.User.Email : null, a.Action, a.EntityType, a.EntityId, a.OldValue, a.NewValue, a.IpAddress, a.UserAgent })
            .ToListAsync(ct);
        var sb = new StringBuilder();
        sb.Append("When (UTC),Who,Email,Action,Resource,Resource id,Before,After,IP address,Device\r\n");
        foreach (var r in rows)
            sb.AppendJoin(',', new[] { r.CreatedAt.ToString("yyyy-MM-dd HH:mm:ss"), r.Who ?? "System", r.Email, r.Action, r.EntityType, r.EntityId?.ToString(), r.OldValue, r.NewValue, r.IpAddress, r.UserAgent }.Select(Cell)).Append("\r\n");
        recorder.Audit("audit.exported", "AuditLog", null, newValue: new { f.Kind, f.UserId, f.EntityType, f.Action, f.From, f.To, f.Q, rows = rows.Count }, tenantId: tid);
        await db.SaveChangesAsync(ct);
        var bytes = Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes(sb.ToString())).ToArray();
        return new AuditCsv(bytes, $"audit-log-{clock.Now:yyyyMMdd-HHmm}.csv", rows.Count);
    }

    /// <summary>RFC 4180 quoting, plus a leading apostrophe for =, +, -, @, tab and CR so a spreadsheet never evaluates a logged value.</summary>
    public static string Cell(string? value)
    {
        if (string.IsNullOrEmpty(value)) return "";
        var v = value.Length > 4000 ? value[..4000] : value;
        if (v[0] is '=' or '+' or '-' or '@' or '\t' or '\r') v = "'" + v;
        return v.IndexOfAny([',', '"', '\n', '\r']) >= 0 ? "\"" + v.Replace("\"", "\"\"") + "\"" : v;
    }
}
