using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Documents;

/// <summary>What the signed-in person may do with one document.</summary>
public sealed record DocumentRights(bool Edit, bool Delete, bool Share, bool Link, DocAccessLevel? Granted, bool Denied);

public record GrantDto(Guid Id, GrantPrincipal PrincipalType, Guid PrincipalId, string Name, int? Members, DocAccessLevel Level, bool Deny, DateTime? ExpiresAt, string? Note, UserRefDto? By, DateTime CreatedAt);
public record AccessPersonDto(Guid UserId, string Name, string Role, DocAccessLevel Level, IReadOnlyList<string> Reasons);
public record DocumentAccessDto(UserRefDto Owner, DocumentVisibility Visibility, string VisibilityText, IReadOnlyList<GrantDto> Grants, IReadOnlyList<AccessPersonDto> People,
    int PeopleTotal, bool Truncated, bool CanManage, bool AdvancedPermissions);
public record AddGrantRequest(GrantPrincipal PrincipalType, Guid PrincipalId, DocAccessLevel Level = DocAccessLevel.Viewer, bool Deny = false, DateTime? ExpiresAt = null, string? Note = null);

/// <summary>
/// Who may do what with a document beyond its visibility: grants to a person, a team or a job role (and, on plans with advanced permissions, expiring
/// grants and explicit denials), and an explanation of everyone who can open it and why. The same rules the data layer applies to every query are
/// worked out here for the whole workspace, and a test keeps the two in step.
/// </summary>
public class DocumentAccessService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, EntitlementService entitlements)
{
    public const int MaxGrants = 200, MaxPeople = 1000;

    private bool IsOrgAdmin => ctx.Role is TenantRole.Owner or TenantRole.Admin;

    // ------------------------------------------------------------------ what I may do

    private IQueryable<DocumentGrant> MyGrants(Guid documentId, bool deny)
    {
        var now = clock.Now; var me = ctx.UserId; var tid = ctx.TenantId;
        return db.DocumentGrants.Where(g => g.DocumentId == documentId && g.Deny == deny && (g.ExpiresAt == null || g.ExpiresAt > now)
            && ((g.PrincipalType == GrantPrincipal.User && g.PrincipalId == me)
                || (g.PrincipalType == GrantPrincipal.Team && db.TeamMembers.Any(m => m.TeamId == g.PrincipalId && m.UserId == me))
                || (g.PrincipalType == GrantPrincipal.JobRole && db.TenantMembers.Any(tm => tm.TenantId == tid && tm.UserId == me && tm.OrgRoleId == g.PrincipalId))));
    }

    public async Task<DocumentRights> RightsAsync(Document doc, CancellationToken ct = default)
    {
        var level = await permissions.LevelAsync(Modules.Documents, ct);
        var admin = IsOrgAdmin;
        var denied = !admin && await MyGrants(doc.Id, true).AnyAsync(ct);
        DocAccessLevel? granted = await MyGrants(doc.Id, false).Select(g => (DocAccessLevel?)g.Level).MaxAsync(ct);
        var owner = doc.OwnerId == ctx.UserId;
        var writer = level >= AccessLevel.Edit && !denied;
        var edit = writer && doc.Status != DocumentStatus.Archived && (owner || granted >= DocAccessLevel.Editor || await permissions.HasAsync(Permissions.DocsEdit, ct));
        var delete = writer && (owner || await permissions.HasAsync(Permissions.DocsDelete, ct));
        var share = writer && (owner || admin || granted >= DocAccessLevel.Manager);
        return new DocumentRights(edit, delete, share, writer, granted, denied);
    }

    // ------------------------------------------------------------------ grants

    public async Task<DocumentAccessDto> GetAsync(Guid documentId, CancellationToken ct = default)
    {
        var doc = await db.Documents.AsNoTracking().FirstOrDefaultAsync(d => d.Id == documentId, ct) ?? throw new NotFoundException("Document not found.");
        var rights = await RightsAsync(doc, ct);
        var tid = ctx.RequireTenantId();
        var now = clock.Now;
        var grants = await db.DocumentGrants.AsNoTracking().Where(g => g.DocumentId == documentId).OrderBy(g => g.CreatedAt).Take(MaxGrants).ToListAsync(ct);
        var active = grants.Where(g => g.ExpiresAt == null || g.ExpiresAt > now).ToList();

        // names for the grants
        var teamIds = grants.Where(g => g.PrincipalType == GrantPrincipal.Team).Select(g => g.PrincipalId).ToList();
        var roleIds = grants.Where(g => g.PrincipalType == GrantPrincipal.JobRole).Select(g => g.PrincipalId).ToList();
        var userIds = grants.Where(g => g.PrincipalType == GrantPrincipal.User).Select(g => g.PrincipalId).Concat(grants.Where(g => g.CreatedBy != null).Select(g => g.CreatedBy!.Value)).Append(doc.OwnerId).Distinct().ToList();
        var teams = await db.Teams.AsNoTracking().Where(t => teamIds.Contains(t.Id)).ToDictionaryAsync(t => t.Id, t => t.Name, ct);
        var roles = await db.OrgRoles.AsNoTracking().Where(r => roleIds.Contains(r.Id)).ToDictionaryAsync(r => r.Id, r => r.Name, ct);
        var users = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var teamMembers = (await db.TeamMembers.AsNoTracking().Where(m => teamIds.Contains(m.TeamId)).Select(m => new { m.TeamId, m.UserId }).ToListAsync(ct)).GroupBy(m => m.TeamId).ToDictionary(g => g.Key, g => g.Select(x => x.UserId).ToHashSet());

        // everyone in the workspace, with what decides what they may open
        var members = await (from m in db.TenantMembers.AsNoTracking()
                             where m.TenantId == tid
                             join u in db.Users.AsNoTracking() on m.UserId equals u.Id
                             join r in db.OrgRoles.AsNoTracking() on m.OrgRoleId equals (Guid?)r.Id into jr
                             from r in jr.DefaultIfEmpty()
                             orderby u.DisplayName
                             select new { m.UserId, u.DisplayName, m.Role, m.OrgRoleId, Access = r != null ? r.AccessJson : null }).Take(MaxPeople + 1).ToListAsync(ct);
        var truncated = members.Count > MaxPeople;
        if (truncated) members.RemoveAt(members.Count - 1);

        var project = doc.ProjectId is { } pid ? await db.Projects.AsNoTracking().Where(p => p.Id == pid).Select(p => new { p.Id, p.Key, p.OwnerId, p.TeamId }).FirstOrDefaultAsync(ct) : null;
        var projectMembers = project is null ? [] : (await db.ProjectMembers.AsNoTracking().Where(m => m.ProjectId == project.Id).Select(m => m.UserId).ToListAsync(ct)).ToHashSet();
        var projectTeam = project?.TeamId is { } ptid ? (await db.TeamMembers.AsNoTracking().Where(m => m.TeamId == ptid).Select(m => m.UserId).ToListAsync(ct)).ToHashSet() : [];
        var docTeam = doc.TeamId is { } dtid ? (await db.TeamMembers.AsNoTracking().Where(m => m.TeamId == dtid).Select(m => m.UserId).ToListAsync(ct)).ToHashSet() : [];
        var teamsOnly = await db.Tenants.AsNoTracking().Where(t => t.Id == tid).Select(t => t.ProjectVisibility == ProjectVisibility.Teams).FirstAsync(ct);
        var personal = ctx.WorkspaceType == WorkspaceType.Personal;

        var people = new List<AccessPersonDto>();
        foreach (var m in members)
        {
            var admin = m.Role is TenantRole.Owner or TenantRole.Admin;
            var module = await permissions.ModuleLevelForAsync(Modules.Documents, m.Role, m.Access, ct);
            if (module < AccessLevel.View) continue;
            var reasons = new List<string>();
            var level = DocAccessLevel.Viewer;

            var mine = active.Where(g => (g.PrincipalType == GrantPrincipal.User && g.PrincipalId == m.UserId)
                || (g.PrincipalType == GrantPrincipal.Team && teamMembers.GetValueOrDefault(g.PrincipalId)?.Contains(m.UserId) == true)
                || (g.PrincipalType == GrantPrincipal.JobRole && g.PrincipalId == m.OrgRoleId)).ToList();
            var denied = !admin && mine.Any(g => g.Deny);
            var allowed = mine.Where(g => !g.Deny).ToList();

            var viaBase = false;
            if (m.UserId == doc.OwnerId) { reasons.Add("Owner"); viaBase = true; }
            if (admin) { reasons.Add(m.Role == TenantRole.Owner ? "Organization owner" : "Organization admin"); viaBase = true; }
            if (!denied)
            {
                switch (doc.Visibility)
                {
                    case DocumentVisibility.Project when project is not null:
                        {
                            var reaches = m.Role == TenantRole.Guest ? projectMembers.Contains(m.UserId)
                                : !teamsOnly || personal || await permissions.HasForAsync(m.Role, m.Access, Permissions.ProjectsViewAll, ct)
                                  || project.OwnerId == m.UserId || projectMembers.Contains(m.UserId) || projectTeam.Contains(m.UserId);
                            if (reaches && !viaBase) { reasons.Add($"Project {project.Key}"); viaBase = true; }
                            break;
                        }
                    case DocumentVisibility.Team when docTeam.Contains(m.UserId): reasons.Add("Team member"); viaBase = true; break;
                    case DocumentVisibility.Organization when m.Role != TenantRole.Guest: reasons.Add("Whole organization"); viaBase = true; break;
                }
                foreach (var g in allowed)
                    reasons.Add(g.PrincipalType switch
                    {
                        GrantPrincipal.User => "Shared directly",
                        GrantPrincipal.Team => $"Shared with team {teams.GetValueOrDefault(g.PrincipalId) ?? "(deleted)"}",
                        _ => $"Shared with role {roles.GetValueOrDefault(g.PrincipalId) ?? "(deleted)"}",
                    });
            }
            if (reasons.Count == 0) continue;
            if (denied && !viaBase) continue;

            // What they may do: write access needs the module at Edit; then the owner, anyone with the edit right, and Editor/Manager grants.
            var grantLevel = allowed.Count == 0 ? (DocAccessLevel?)null : allowed.Max(g => g.Level);
            if (module >= AccessLevel.Edit && !denied)
            {
                if (m.UserId == doc.OwnerId || admin || grantLevel >= DocAccessLevel.Editor || await permissions.HasForAsync(m.Role, m.Access, Permissions.DocsEdit, ct)) level = DocAccessLevel.Editor;
                if (m.UserId == doc.OwnerId || admin || grantLevel >= DocAccessLevel.Manager) level = DocAccessLevel.Manager;
            }
            people.Add(new AccessPersonDto(m.UserId, m.DisplayName, m.Role.ToString(), level, reasons));
        }

        var vis = doc.Visibility switch
        {
            DocumentVisibility.Project => project is null ? "The document's project" : $"Everyone who can open project {project.Key}",
            DocumentVisibility.Team => "Members of the document's team",
            DocumentVisibility.Organization => "Every member of the workspace (not guests)",
            _ => "Only the owner (and the organization's owners and admins)",
        };
        var owner = new UserRefDto(doc.OwnerId, users.GetValueOrDefault(doc.OwnerId) ?? "Former member");
        var dtos = grants.Select(g => new GrantDto(g.Id, g.PrincipalType, g.PrincipalId,
            g.PrincipalType switch { GrantPrincipal.User => users.GetValueOrDefault(g.PrincipalId) ?? "Former member", GrantPrincipal.Team => teams.GetValueOrDefault(g.PrincipalId) ?? "(deleted team)", _ => roles.GetValueOrDefault(g.PrincipalId) ?? "(deleted role)" },
            g.PrincipalType == GrantPrincipal.Team ? teamMembers.GetValueOrDefault(g.PrincipalId)?.Count ?? 0 : null,
            g.Level, g.Deny, g.ExpiresAt, g.Note, g.CreatedBy is { } by ? new UserRefDto(by, users.GetValueOrDefault(by) ?? "Former member") : null, g.CreatedAt)).ToList();
        return new DocumentAccessDto(owner, doc.Visibility, vis, dtos, people, people.Count, truncated, rights.Share, await entitlements.GetValueAsync(FeatureKeys.AdvancedPermissions, ct) != 0);
    }

    public async Task<DocumentAccessDto> AddGrantAsync(Guid documentId, AddGrantRequest req, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var doc = await db.Documents.FirstOrDefaultAsync(d => d.Id == documentId, ct) ?? throw new NotFoundException("Document not found.");
        var rights = await RightsAsync(doc, ct);
        if (!rights.Share) throw new ForbiddenException("Only the owner, a manager of this document and the organization's admins can share it.", "PERMISSION_DENIED");

        if (!Enum.IsDefined(req.Level)) throw new ValidationException("level", "Choose what they may do.");
        if (req.Deny || req.ExpiresAt is not null)
            if (await entitlements.GetValueAsync(FeatureKeys.AdvancedPermissions, ct) == 0)
                throw new FeatureNotAvailableException(FeatureKeys.AdvancedPermissions);
        if (req.ExpiresAt is { } at && at <= clock.Now) throw new ValidationException("expiresAt", "Choose a day in the future.");
        if (req.ExpiresAt is { } far && far > clock.Now.AddYears(5)) throw new ValidationException("expiresAt", "Access can be given for at most five years.");

        string name;
        switch (req.PrincipalType)
        {
            case GrantPrincipal.User:
                if (!await db.TenantMembers.AnyAsync(m => m.TenantId == tid && m.UserId == req.PrincipalId, ct)) throw new ValidationException("principalId", "That person is not in this workspace.");
                if (req.PrincipalId == doc.OwnerId) throw new ValidationException("principalId", "The owner already has full access.");
                name = await db.Users.Where(u => u.Id == req.PrincipalId).Select(u => u.DisplayName).FirstAsync(ct);
                break;
            case GrantPrincipal.Team:
                name = await db.Teams.Where(t => t.Id == req.PrincipalId).Select(t => t.Name).FirstOrDefaultAsync(ct) ?? throw new ValidationException("principalId", "Team not found.");
                break;
            case GrantPrincipal.JobRole:
                name = await db.OrgRoles.Where(r => r.Id == req.PrincipalId).Select(r => r.Name).FirstOrDefaultAsync(ct) ?? throw new ValidationException("principalId", "Job role not found.");
                break;
            default: throw new ValidationException("principalType", "Choose who to share with.");
        }
        if (await db.DocumentGrants.CountAsync(g => g.DocumentId == documentId, ct) >= MaxGrants) throw new ValidationException("principalId", $"A document can be shared in at most {MaxGrants} ways.");

        var grant = await db.DocumentGrants.FirstOrDefaultAsync(g => g.DocumentId == documentId && g.PrincipalType == req.PrincipalType && g.PrincipalId == req.PrincipalId && g.Deny == req.Deny, ct);
        var before = grant is null ? null : new { grant.Level, grant.ExpiresAt };
        if (grant is null)
        {
            grant = new DocumentGrant { TenantId = tid, DocumentId = documentId, PrincipalType = req.PrincipalType, PrincipalId = req.PrincipalId, Deny = req.Deny, CreatedAt = clock.Now, CreatedBy = ctx.UserId };
            db.DocumentGrants.Add(grant);
        }
        grant.Level = req.Level; grant.ExpiresAt = req.ExpiresAt; grant.Note = string.IsNullOrWhiteSpace(req.Note) ? null : req.Note.Trim()[..Math.Min(300, req.Note.Trim().Length)]; grant.UpdatedAt = clock.Now;
        recorder.Activity(req.Deny ? "document.access_denied" : "document.shared", "Document", doc.Id, $"{(req.Deny ? "Blocked" : "Shared")} {DocumentService.KeyOf(doc.Number)} {(req.Deny ? "for" : "with")} {name}", doc.ProjectId);
        recorder.Audit(req.Deny ? "document.access_denied" : "document.shared", "Document", doc.Id, before, new { req.PrincipalType, req.PrincipalId, name, req.Level, req.ExpiresAt });
        await db.SaveChangesAsync(ct);
        return await GetAsync(documentId, ct);
    }

    public async Task<DocumentAccessDto> RemoveGrantAsync(Guid documentId, Guid grantId, CancellationToken ct = default)
    {
        var doc = await db.Documents.FirstOrDefaultAsync(d => d.Id == documentId, ct) ?? throw new NotFoundException("Document not found.");
        if (!(await RightsAsync(doc, ct)).Share) throw new ForbiddenException("Only the owner, a manager of this document and the organization's admins can change who it is shared with.", "PERMISSION_DENIED");
        var grant = await db.DocumentGrants.FirstOrDefaultAsync(g => g.Id == grantId && g.DocumentId == documentId, ct) ?? throw new NotFoundException("That sharing was not found.");
        db.DocumentGrants.Remove(grant);
        recorder.Activity("document.unshared", "Document", doc.Id, $"Removed sharing from {DocumentService.KeyOf(doc.Number)}", doc.ProjectId);
        recorder.Audit("document.unshared", "Document", doc.Id, new { grant.PrincipalType, grant.PrincipalId, grant.Level, grant.Deny });
        await db.SaveChangesAsync(ct);
        return await GetAsync(documentId, ct);
    }
}
