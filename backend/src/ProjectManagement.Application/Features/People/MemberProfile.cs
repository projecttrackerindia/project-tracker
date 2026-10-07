using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.People;

public record TeamRefDto(Guid Id, string Name, bool IsLead);

/// <summary>
/// Someone's profile card: who they are, what team(s) and job role they have in this workspace, who they report to, and how their work
/// is going - built only from what the viewer could already see elsewhere (the work counts use the same rule as My work and Workload).
/// Cost and bill rates are never included here; those stay in Workload, which already limits them to Owners, Admins and the person themselves.
/// </summary>
public record MemberProfileDto(Guid UserId, string DisplayName, string Email, bool HasAvatar, TenantRole Role,
    string? JobRole, string? JobRoleColor, IReadOnlyList<TeamRefDto> Teams, UserRefDto? ReportsTo, DateTime JoinedAt,
    int Open, int Overdue, int DoneLast30Days, int DoneTotal, bool IsMe, bool CanMessage);

/// <summary>Reads a profile the caller may see: the target must be a member of the caller's current workspace.</summary>
public class MemberProfileService(IAppDbContext db, ICurrentContext ctx, WorkItemService workItems)
{
    public async Task<MemberProfileDto> GetAsync(Guid userId, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var row = await (from m in db.TenantMembers.AsNoTracking()
                         join u in db.Users.AsNoTracking() on m.UserId equals u.Id
                         where m.TenantId == tid && m.UserId == userId
                         select new { Member = m, User = u }).FirstOrDefaultAsync(ct)
            ?? throw new NotFoundException("That person is not in this workspace.");

        var jobRole = row.Member.OrgRoleId is { } rid
            ? await db.OrgRoles.AsNoTracking().Where(r => r.Id == rid).Select(r => new { r.Name, r.Color }).FirstOrDefaultAsync(ct) : null;
        var reportsTo = row.Member.ReportsToUserId is { } boss
            ? await db.Users.AsNoTracking().Where(u => u.Id == boss).Select(u => new { u.Id, u.DisplayName }).FirstOrDefaultAsync(ct) : null;
        var teams = await (from tm in db.TeamMembers.AsNoTracking()
                           join t in db.Teams.AsNoTracking() on tm.TeamId equals t.Id
                           where tm.TenantId == tid && tm.UserId == userId
                           orderby t.Name
                           select new TeamRefDto(t.Id, t.Name, tm.IsLead)).ToListAsync(ct);
        var counts = (await workItems.CountsAsync([userId], WorkItemScope.Caller, ct)).GetValueOrDefault(userId);

        var hideEmail = ctx.Role == TenantRole.Guest && userId != ctx.UserId;
        var me = ctx.UserId == userId;
        return new MemberProfileDto(row.User.Id, row.User.DisplayName, hideEmail ? "" : row.User.Email, row.User.AvatarKey is not null,
            row.Member.Role, jobRole?.Name, jobRole?.Color, teams, reportsTo is null ? null : new UserRefDto(reportsTo.Id, reportsTo.DisplayName),
            row.Member.CreatedAt, counts?.Open ?? 0, counts?.Overdue ?? 0, counts?.DoneLast30Days ?? 0, counts?.DoneTotal ?? 0,
            me, !me && ctx.Role != TenantRole.Guest);
    }
}

/// <summary>
/// A person's own profile photo: set and removed only by themselves (My account), read by anyone who shares a workspace with them. The
/// same validated-image, old-file-cleanup pattern as the workspace logo (<see cref="ProjectManagement.Application.Features.Workspaces.WorkspaceLogoService"/>).
/// </summary>
public class UserAvatarService(IAppDbContext db, ICurrentContext ctx, IFileStorage storage, Recorder recorder)
{
    public const long MaxBytes = 3_145_728; // 3 MB: photos run larger than a workspace logo

    public async Task SetAsync(Stream content, long length, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        if (length is <= 0 or > MaxBytes) throw new ValidationException("file", "The photo can be up to 3 MB.");
        using var ms = new MemoryStream(); await content.CopyToAsync(ms, ct);
        var bytes = ms.ToArray();
        var kind = PdfImage.Kind(bytes) ?? throw new ValidationException("file", "Use a PNG or JPEG picture.");
        try { PdfImage.Read(bytes); } catch (FormatException e) { throw new ValidationException("file", e.Message); }
        var user = await db.Users.FirstAsync(u => u.Id == uid, ct);
        var old = user.AvatarKey;
        var key = $"avatars/{uid:N}/photo-{Guid.NewGuid():N}";
        ms.Position = 0;
        await storage.SaveAsync(key, ms, ct);
        user.AvatarKey = key; user.AvatarContentType = kind;
        recorder.Audit("user.avatar_changed", "User", uid, null, new { kind, size = length });
        await db.SaveChangesAsync(ct);
        if (old is not null) await storage.DeleteAsync(old, ct);
    }

    public async Task RemoveAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var user = await db.Users.FirstAsync(u => u.Id == uid, ct);
        if (user.AvatarKey is not { } old) return;
        user.AvatarKey = null; user.AvatarContentType = null;
        recorder.Audit("user.avatar_removed", "User", uid);
        await db.SaveChangesAsync(ct);
        await storage.DeleteAsync(old, ct);
    }

    /// <summary>The photo's bytes, for anyone who shares a workspace with that person - not for the whole platform.</summary>
    public async Task<(byte[] Bytes, string ContentType)?> OpenForMemberAsync(Guid userId, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        if (userId != ctx.UserId && !await db.TenantMembers.AsNoTracking().AnyAsync(m => m.TenantId == tid && m.UserId == userId, ct))
            return null;
        var row = await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => new { u.AvatarKey, u.AvatarContentType }).FirstOrDefaultAsync(ct);
        if (row?.AvatarKey is not { } key) return null;
        var bytes = await storage.OpenReadAsync(key, ct);
        if (bytes is null) return null;
        await using var _ = bytes;
        using var ms = new MemoryStream(); await bytes.CopyToAsync(ms, ct);
        return (ms.ToArray(), row.AvatarContentType ?? "image/png");
    }
}
