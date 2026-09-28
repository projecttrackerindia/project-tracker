using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Features.Insights;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Admin;

public record PlanCountDto(string PlanCode, int Count);
public record AdminStatsDto(int Users, int ActiveUsers, int Tenants, int Organizations, int PersonalWorkspaces, int SuspendedTenants,
    IReadOnlyList<PlanCountDto> Subscriptions, int ActiveSessions, int DeletedTenants);

public record AdminTenantDto(Guid Id, string Name, string Slug, WorkspaceType Type, TenantStatus Status, string? OwnerEmail, string PlanCode,
    SubscriptionStatus SubscriptionStatus, DateTime? PeriodEnd, int MemberCount, DateTime CreatedAt, bool IsDeleted, DateTime? DeletedAt);
public record AdminTenantMemberDto(Guid UserId, string DisplayName, string Email, TenantRole Role, DateTime JoinedAt);
/// <summary>Counts only — never the content of a tenant's projects or tasks.</summary>
public record AdminTenantUsageDto(int Projects, int Tasks, int Teams, int Members, int PendingInvitations);
public record AdminTenantDetailDto(AdminTenantDto Tenant, string? Description, Guid OwnerUserId, IReadOnlyList<AdminTenantMemberDto> Members,
    AdminTenantUsageDto Usage, IReadOnlyDictionary<string, long> Limits);
public record CreateTenantRequest(string Name, string? Description, string OwnerEmail, string PlanCode);
public record UpdateTenantRequest(string Name, string? Description, Guid? OwnerUserId);

public record AdminMembershipDto(Guid TenantId, string TenantName, WorkspaceType Type, TenantRole Role, string PlanCode, DateTime JoinedAt, bool IsDeleted);
public record AdminUserDto(Guid Id, string Email, string DisplayName, bool EmailVerified, bool IsActive, bool IsPlatformAdmin,
    DateTime CreatedAt, DateTime? LastLoginAt, int Workspaces, IReadOnlyList<AdminMembershipDto> Memberships, bool MfaEnabled = false);
public record AdminUserDetailDto(AdminUserDto User, int ActiveSessions);

public record AdminPlanDto(Guid Id, string Code, string Name, string? Description, decimal? PriceMonthly, string Currency, bool IsActive,
    int SortOrder, IReadOnlyDictionary<string, long> Features);
public record UpdatePlanRequest(string Name, string? Description, decimal? PriceMonthly, bool IsActive, IReadOnlyDictionary<string, long> Features);
public record SetTenantStatusRequest(TenantStatus Status);
public record SetTenantSubscriptionRequest(string PlanCode, SubscriptionStatus Status, DateTime? PeriodEnd);
public record SetUserStatusRequest(bool IsActive);
public record SetPlatformAdminRequest(bool IsPlatformAdmin);

/// <summary>
/// Platform administration. Deliberately exposes tenant *metadata* only (owner, members, plan, usage counts) — never projects, tasks
/// or comments — so platform admins do not get implicit access to tenant business data (spec section 3.4).
/// Soft-deleted tenants are hidden from every tenant-facing query by a global filter; this service reads them explicitly.
/// </summary>
public class AdminService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, WorkspaceProvisioner provisioner,
    EntitlementService entitlements)
{
    private void RequireAdmin()
    {
        if (!ctx.IsPlatformAdmin) throw new ForbiddenException("Platform administrator access is required.", "ADMIN_REQUIRED");
    }

    private static string EffectivePlanCode(Subscription? sub, DateTime now) =>
        sub?.Plan is { } plan && !EntitlementService.IsLapsed(sub, now) ? plan.Code : EntitlementService.FreePlan;

    /// <summary>Loads a tenant including soft-deleted ones. Most changes are refused until a deleted tenant is restored.</summary>
    private async Task<Tenant> LoadTenantAsync(Guid id, bool tracking, bool allowDeleted, CancellationToken ct)
    {
        var query = db.Tenants.IgnoreQueryFilters();
        if (!tracking) query = query.AsNoTracking();
        var tenant = await query.FirstOrDefaultAsync(t => t.Id == id, ct) ?? throw new NotFoundException("Organization not found.");
        if (tenant.IsDeleted && !allowDeleted)
            throw new ConflictException("This organization is deleted. Restore it before making changes.", "TENANT_DELETED");
        return tenant;
    }

    // ---------------------------------------------------------------- overview

    public async Task<AdminStatsDto> GetStatsAsync(CancellationToken ct = default)
    {
        RequireAdmin();
        var now = clock.Now;
        // Deleted tenants are filtered out of Tenants, so their subscriptions are excluded from the plan breakdown too.
        var subs = await db.Subscriptions.AsNoTracking().Include(s => s.Plan).Where(s => db.Tenants.Any(t => t.Id == s.TenantId)).ToListAsync(ct);
        var byPlan = subs.GroupBy(s => EffectivePlanCode(s, now))
            .Select(g => new PlanCountDto(g.Key, g.Count())).OrderBy(p => p.PlanCode).ToList();
        return new AdminStatsDto(
            await db.Users.CountAsync(ct), await db.Users.CountAsync(u => u.IsActive, ct),
            await db.Tenants.CountAsync(ct), await db.Tenants.CountAsync(t => t.Type == WorkspaceType.Organization, ct),
            await db.Tenants.CountAsync(t => t.Type == WorkspaceType.Personal, ct), await db.Tenants.CountAsync(t => t.Status == TenantStatus.Suspended, ct),
            byPlan, await db.UserSessions.CountAsync(s => s.RevokedAt == null && s.ExpiresAt > now, ct),
            await db.Tenants.IgnoreQueryFilters().CountAsync(t => t.IsDeleted, ct));
    }

    // ---------------------------------------------------------------- organizations / workspaces

    private async Task<List<AdminTenantDto>> BuildTenantDtosAsync(IReadOnlyList<Tenant> tenants, CancellationToken ct)
    {
        var ids = tenants.Select(x => x.Id).ToList();
        var ownerIds = tenants.Select(x => x.OwnerUserId).Distinct().ToList();
        var owners = await db.Users.Where(u => ownerIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.Email, ct);
        var counts = await db.TenantMembers.Where(m => ids.Contains(m.TenantId)).GroupBy(m => m.TenantId)
            .Select(g => new { Id = g.Key, C = g.Count() }).ToDictionaryAsync(x => x.Id, x => x.C, ct);
        var subs = await db.Subscriptions.AsNoTracking().Include(s => s.Plan).Where(s => ids.Contains(s.TenantId)).ToDictionaryAsync(s => s.TenantId, ct);
        var now = clock.Now;

        return tenants.Select(x =>
        {
            subs.TryGetValue(x.Id, out var sub);
            return new AdminTenantDto(x.Id, x.Name, x.Slug, x.Type, x.Status, owners.GetValueOrDefault(x.OwnerUserId), EffectivePlanCode(sub, now),
                sub?.Status ?? SubscriptionStatus.Active, sub?.CurrentPeriodEnd, counts.GetValueOrDefault(x.Id), x.CreatedAt, x.IsDeleted, x.DeletedAt);
        }).ToList();
    }

    /// <param name="status">Optional filter: Active, Suspended or Deleted. Deleted organizations are listed (last) unless filtered out.</param>
    public async Task<PagedResult<AdminTenantDto>> ListTenantsAsync(string? q, WorkspaceType? type, string? status, int page, int pageSize, CancellationToken ct = default)
    {
        RequireAdmin();
        var query = db.Tenants.IgnoreQueryFilters().AsNoTracking().AsQueryable();
        if (type is { } t) query = query.Where(x => x.Type == t);
        query = status?.ToLowerInvariant() switch
        {
            "deleted" => query.Where(x => x.IsDeleted),
            "active" => query.Where(x => !x.IsDeleted && x.Status == TenantStatus.Active),
            "suspended" => query.Where(x => !x.IsDeleted && x.Status == TenantStatus.Suspended),
            _ => query,
        };
        if (!string.IsNullOrWhiteSpace(q))
        {
            var s = q.Trim().ToLowerInvariant();
            query = query.Where(x => x.Name.ToLower().Contains(s) || x.Slug.Contains(s)
                || db.Users.Any(u => u.Id == x.OwnerUserId && u.Email.ToLower().Contains(s)));
        }

        var p = new PageQuery(page, pageSize);
        var total = await query.CountAsync(ct);
        var tenants = await query.OrderBy(x => x.IsDeleted).ThenBy(x => x.Type).ThenByDescending(x => x.CreatedAt)
            .Skip((p.SafePage - 1) * p.SafeSize()).Take(p.SafeSize()).ToListAsync(ct);
        return new PagedResult<AdminTenantDto>(await BuildTenantDtosAsync(tenants, ct), p.SafePage, p.SafeSize(), total);
    }

    public async Task<AdminTenantDetailDto> GetTenantAsync(Guid id, CancellationToken ct = default)
    {
        RequireAdmin();
        var tenant = await LoadTenantAsync(id, tracking: false, allowDeleted: true, ct);
        var dto = (await BuildTenantDtosAsync([tenant], ct))[0];

        var members = await (from m in db.TenantMembers join u in db.Users on m.UserId equals u.Id
                             where m.TenantId == id orderby m.Role descending, u.DisplayName
                             select new AdminTenantMemberDto(u.Id, u.DisplayName, u.Email, m.Role, m.CreatedAt)).AsNoTracking().ToListAsync(ct);

        // Tenant filters do not apply to this (tenant-less) admin request, so counts are taken explicitly per tenant id.
        var usage = new AdminTenantUsageDto(
            await db.Projects.IgnoreQueryFilters().CountAsync(p => p.TenantId == id && !p.IsDeleted, ct),
            await db.Tasks.IgnoreQueryFilters().CountAsync(t => t.TenantId == id && !t.IsDeleted, ct),
            await db.Teams.IgnoreQueryFilters().CountAsync(t => t.TenantId == id, ct),
            members.Count,
            await db.TenantInvitations.CountAsync(i => i.TenantId == id && i.Status == InvitationStatus.Pending && i.ExpiresAt > clock.Now, ct));

        return new AdminTenantDetailDto(dto, tenant.Description, tenant.OwnerUserId, members, usage, await entitlements.GetEntitlementsAsync(id, ct));
    }

    public async Task<AdminTenantDetailDto> CreateTenantAsync(CreateTenantRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        var email = Text.NormalizeEmail(req.OwnerEmail);
        var owner = await db.Users.FirstOrDefaultAsync(u => u.NormalizedEmail == email, ct)
            ?? throw new ValidationException("ownerEmail", "No user with this email exists. Ask them to register first, then create the organization.");
        if (!owner.IsActive) throw new ValidationException("ownerEmail", "That user account is disabled.");
        var plan = await db.Plans.FirstOrDefaultAsync(p => p.Code == req.PlanCode.ToUpper() && p.IsActive, ct)
            ?? throw new ValidationException("planCode", "Choose an available plan.");

        var tenant = await provisioner.CreateAsync(req.Name, WorkspaceType.Organization, owner.Id, req.Description, null, ct);
        // Assigned by an administrator: active, no renewal date and no charge (an "account-managed" subscription).
        db.Subscriptions.Local.First(s => s.TenantId == tenant.Id).PlanId = plan.Id;
        recorder.Audit("admin.tenant_created", "Tenant", tenant.Id, newValue: new { tenant.Name, Owner = owner.Email, Plan = plan.Code }, tenantId: tenant.Id);
        await db.SaveChangesAsync(ct);
        return await GetTenantAsync(tenant.Id, ct);
    }

    public async Task<AdminTenantDetailDto> UpdateTenantAsync(Guid id, UpdateTenantRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        var tenant = await LoadTenantAsync(id, tracking: true, allowDeleted: false, ct);
        var old = new { tenant.Name, tenant.Description, tenant.OwnerUserId };

        tenant.Name = req.Name.Trim();
        tenant.Description = req.Description?.Trim();

        if (req.OwnerUserId is { } newOwnerId && newOwnerId != tenant.OwnerUserId)
        {
            if (tenant.Type == WorkspaceType.Personal)
                throw new ConflictException("The owner of a personal workspace is its account holder and cannot be changed.", "PERSONAL_WORKSPACE");
            var members = await db.TenantMembers.Where(m => m.TenantId == id).ToListAsync(ct);
            var next = members.FirstOrDefault(m => m.UserId == newOwnerId)
                ?? throw new ValidationException("ownerUserId", "The new owner must already be a member of the organization.");
            // Ownership transfer: exactly one Owner; the previous owner stays on as Admin.
            foreach (var m in members.Where(m => m.Role == TenantRole.Owner)) m.Role = TenantRole.Admin;
            next.Role = TenantRole.Owner;
            tenant.OwnerUserId = newOwnerId;
        }

        recorder.Audit("admin.tenant_updated", "Tenant", id, old, new { tenant.Name, tenant.Description, tenant.OwnerUserId }, tenantId: id);
        await db.SaveChangesAsync(ct);
        return await GetTenantAsync(id, ct);
    }

    /// <summary>
    /// Soft delete: members lose access immediately and the organization disappears from every tenant-facing query, but nothing is
    /// erased. It stays in the admin list (faded) and can be restored with all of its data.
    /// </summary>
    public async Task DeleteTenantAsync(Guid id, CancellationToken ct = default)
    {
        RequireAdmin();
        var tenant = await LoadTenantAsync(id, tracking: true, allowDeleted: true, ct);
        if (tenant.Type == WorkspaceType.Personal)
            throw new ConflictException("Personal workspaces belong to a user account and cannot be deleted here.", "PERSONAL_WORKSPACE");
        if (tenant.IsDeleted) throw new ConflictException("This organization is already deleted.", "TENANT_DELETED");

        tenant.IsDeleted = true;
        tenant.DeletedAt = clock.Now;
        tenant.DeletedBy = ctx.UserId;
        recorder.Audit("admin.tenant_deleted", "Tenant", id, newValue: new { tenant.Name, tenant.Slug, SoftDelete = true }, tenantId: id);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Retains a soft-deleted organization: access, members, data and subscription come back exactly as they were.</summary>
    public async Task<AdminTenantDetailDto> RestoreTenantAsync(Guid id, CancellationToken ct = default)
    {
        RequireAdmin();
        var tenant = await LoadTenantAsync(id, tracking: true, allowDeleted: true, ct);
        if (!tenant.IsDeleted) throw new ConflictException("This organization is not deleted.", "NOT_DELETED");

        tenant.IsDeleted = false;
        tenant.DeletedAt = null;
        tenant.DeletedBy = null;
        recorder.Audit("admin.tenant_restored", "Tenant", id, newValue: new { tenant.Name }, tenantId: id);
        await db.SaveChangesAsync(ct);
        return await GetTenantAsync(id, ct);
    }

    public async Task SetTenantStatusAsync(Guid id, SetTenantStatusRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        var tenant = await LoadTenantAsync(id, tracking: true, allowDeleted: false, ct);
        var old = tenant.Status;
        tenant.Status = req.Status;
        recorder.Audit("admin.tenant_status_changed", "Tenant", id, old.ToString(), req.Status.ToString(), tenantId: id);
        await db.SaveChangesAsync(ct);
    }

    public async Task SetTenantSubscriptionAsync(Guid id, SetTenantSubscriptionRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        await LoadTenantAsync(id, tracking: false, allowDeleted: false, ct);
        var plan = await db.Plans.FirstOrDefaultAsync(p => p.Code == req.PlanCode.ToUpper(), ct) ?? throw new NotFoundException("Plan not found.");
        var sub = await db.Subscriptions.Include(s => s.Plan).FirstOrDefaultAsync(s => s.TenantId == id, ct) ?? throw new NotFoundException("Subscription not found.");
        var old = sub.Plan?.Code;
        var now = clock.Now;
        sub.PlanId = plan.Id; sub.Status = req.Status; sub.CurrentPeriodStart = now;
        sub.CurrentPeriodEnd = req.PeriodEnd; sub.TrialEnd = req.Status == SubscriptionStatus.Trial ? req.PeriodEnd : null;
        sub.CancelAtPeriodEnd = false; sub.CancelledAt = null;
        recorder.Audit("admin.subscription_changed", "Subscription", sub.Id, old, new { plan.Code, req.Status, req.PeriodEnd }, tenantId: id);
        await db.SaveChangesAsync(ct);
    }

    // ---------------------------------------------------------------- users

    private async Task<Dictionary<Guid, List<AdminMembershipDto>>> LoadMembershipsAsync(IReadOnlyCollection<Guid> userIds, CancellationToken ct)
    {
        // Soft-deleted organizations are included (and flagged) so an admin can see where a user used to belong.
        var rows = await (from m in db.TenantMembers
                          join t in db.Tenants.IgnoreQueryFilters() on m.TenantId equals t.Id
                          where userIds.Contains(m.UserId)
                          orderby t.IsDeleted, t.Type, t.Name
                          select new { m.UserId, m.TenantId, t.Name, t.Type, m.Role, m.CreatedAt, t.IsDeleted }).AsNoTracking().ToListAsync(ct);
        var tenantIds = rows.Select(r => r.TenantId).Distinct().ToList();
        var subs = await db.Subscriptions.AsNoTracking().Include(s => s.Plan).Where(s => tenantIds.Contains(s.TenantId)).ToDictionaryAsync(s => s.TenantId, ct);
        var now = clock.Now;

        return rows.GroupBy(r => r.UserId).ToDictionary(g => g.Key, g => g.Select(r =>
            new AdminMembershipDto(r.TenantId, r.Name, r.Type, r.Role, EffectivePlanCode(subs.GetValueOrDefault(r.TenantId), now), r.CreatedAt, r.IsDeleted)).ToList());
    }

    private static AdminUserDto ToDto(User u, List<AdminMembershipDto>? memberships) =>
        new(u.Id, u.Email, u.DisplayName, u.EmailVerified, u.IsActive, u.IsPlatformAdmin, u.CreatedAt, u.LastLoginAt,
            memberships?.Count(m => !m.IsDeleted) ?? 0, memberships ?? [], u.MfaEnabled);

    public async Task<PagedResult<AdminUserDto>> ListUsersAsync(string? q, int page, int pageSize, CancellationToken ct = default)
    {
        RequireAdmin();
        var query = db.Users.AsNoTracking().AsQueryable();
        if (!string.IsNullOrWhiteSpace(q)) { var s = q.Trim().ToLowerInvariant(); query = query.Where(u => u.Email.ToLower().Contains(s) || u.DisplayName.ToLower().Contains(s)); }
        var p = new PageQuery(page, pageSize);
        var total = await query.CountAsync(ct);
        var users = await query.OrderByDescending(u => u.CreatedAt).Skip((p.SafePage - 1) * p.SafeSize()).Take(p.SafeSize()).ToListAsync(ct);
        var memberships = await LoadMembershipsAsync(users.Select(u => u.Id).ToList(), ct);
        return new PagedResult<AdminUserDto>(users.Select(u => ToDto(u, memberships.GetValueOrDefault(u.Id))).ToList(), p.SafePage, p.SafeSize(), total);
    }

    public async Task<AdminUserDetailDto> GetUserAsync(Guid id, CancellationToken ct = default)
    {
        RequireAdmin();
        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == id, ct) ?? throw new NotFoundException("User not found.");
        var memberships = await LoadMembershipsAsync([id], ct);
        var now = clock.Now;
        return new AdminUserDetailDto(ToDto(user, memberships.GetValueOrDefault(id)),
            await db.UserSessions.CountAsync(s => s.UserId == id && s.RevokedAt == null && s.ExpiresAt > now, ct));
    }

    public async Task SetUserStatusAsync(Guid id, SetUserStatusRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        if (id == ctx.UserId) throw new ConflictException("You cannot disable your own account.", "SELF_ACTION");
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct) ?? throw new NotFoundException("User not found.");
        user.IsActive = req.IsActive;
        if (!req.IsActive)
            foreach (var s in await db.UserSessions.Where(s => s.UserId == id && s.RevokedAt == null).ToListAsync(ct)) s.RevokedAt = clock.Now;
        recorder.Audit(req.IsActive ? "admin.user_enabled" : "admin.user_disabled", "User", id);
        await db.SaveChangesAsync(ct);
    }

    public async Task SignOutUserAsync(Guid id, CancellationToken ct = default)
    {
        RequireAdmin();
        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == id, ct) ?? throw new NotFoundException("User not found.");
        var now = clock.Now;
        var sessions = await db.UserSessions.Where(s => s.UserId == id && s.RevokedAt == null).ToListAsync(ct);
        foreach (var s in sessions) s.RevokedAt = now;
        recorder.Audit("admin.user_signed_out", "User", id, newValue: new { user.Email, Sessions = sessions.Count });
        await db.SaveChangesAsync(ct);
    }

    public async Task ResetMfaAsync(Guid id, CancellationToken ct = default)
    {
        RequireAdmin();
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct) ?? throw new NotFoundException("User not found.");
        if (!user.MfaEnabled) throw new ConflictException("This person does not use two-step verification.", "MFA_NOT_ENABLED");
        MfaService.Clear(user);
        db.MfaRecoveryCodes.RemoveRange(await db.MfaRecoveryCodes.Where(c => c.UserId == id).ToListAsync(ct));
        foreach (var s in await db.UserSessions.Where(x => x.UserId == id && x.RevokedAt == null).ToListAsync(ct)) s.RevokedAt = clock.Now;
        recorder.Audit("admin.user_mfa_reset", "User", id, newValue: new { user.Email });
        await db.SaveChangesAsync(ct);
    }

    public async Task SetPlatformAdminAsync(Guid id, SetPlatformAdminRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        if (id == ctx.UserId) throw new ConflictException("You cannot change your own administrator status.", "SELF_ACTION");
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct) ?? throw new NotFoundException("User not found.");
        user.IsPlatformAdmin = req.IsPlatformAdmin;
        recorder.Audit("admin.platform_admin_changed", "User", id, newValue: req.IsPlatformAdmin);
        await db.SaveChangesAsync(ct);
    }

    // ---------------------------------------------------------------- plans

    public async Task<IReadOnlyList<AdminPlanDto>> ListPlansAsync(CancellationToken ct = default)
    {
        RequireAdmin();
        var plans = await db.Plans.AsNoTracking().Include(p => p.Features).OrderBy(p => p.SortOrder).ToListAsync(ct);
        return plans.Select(ToDto).ToList();
    }

    private static AdminPlanDto ToDto(Plan p) => new(p.Id, p.Code, p.Name, p.Description, p.PriceMonthly, p.Currency, p.IsActive, p.SortOrder,
        FeatureKeys.All.ToDictionary(k => k, k => p.Features.FirstOrDefault(f => f.FeatureKey == k)?.Value ?? 0));

    public async Task<AdminPlanDto> UpdatePlanAsync(Guid id, UpdatePlanRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        var plan = await db.Plans.Include(p => p.Features).FirstOrDefaultAsync(p => p.Id == id, ct) ?? throw new NotFoundException("Plan not found.");
        if (plan.Code == EntitlementService.FreePlan && !req.IsActive) throw new ConflictException("The Free plan cannot be deactivated.", "FREE_REQUIRED");
        foreach (var (key, value) in req.Features)
        {
            if (!FeatureKeys.All.Contains(key)) throw new ValidationException("features", $"Unknown feature \"{key}\".");
            if (value < -1) throw new ValidationException("features", $"{key} must be -1 (unlimited) or greater.");
            if (FeatureKeys.Flags.Contains(key) && value is not (0 or 1)) throw new ValidationException("features", $"{key} must be 0 or 1.");
        }

        var old = ToDto(plan);
        plan.Name = req.Name.Trim(); plan.Description = req.Description?.Trim(); plan.PriceMonthly = req.PriceMonthly; plan.IsActive = req.IsActive;
        foreach (var (key, value) in req.Features)
        {
            var feature = plan.Features.FirstOrDefault(f => f.FeatureKey == key);
            if (feature is null) db.PlanFeatures.Add(new PlanFeature { PlanId = plan.Id, FeatureKey = key, Value = value });
            else feature.Value = value;
        }
        recorder.Audit("admin.plan_updated", "Plan", plan.Id, old, new { req.Name, req.PriceMonthly, req.IsActive, req.Features });
        await db.SaveChangesAsync(ct);
        return ToDto((await db.Plans.AsNoTracking().Include(p => p.Features).FirstAsync(p => p.Id == id, ct)));
    }

    // ---------------------------------------------------------------- audit

    public async Task<PagedResult<AuditLogDto>> ListAuditAsync(string? action, Guid? tenantId, int page, int pageSize, CancellationToken ct = default)
    {
        RequireAdmin();
        var q = db.AuditLogs.AsNoTracking().AsQueryable();
        if (tenantId is { } t) q = q.Where(a => a.TenantId == t);
        if (!string.IsNullOrWhiteSpace(action)) { var a0 = action.Trim().ToLowerInvariant(); q = q.Where(a => a.Action.ToLower().StartsWith(a0)); }
        var p = new PageQuery(page, pageSize);
        var total = await q.CountAsync(ct);
        var rows = await q.OrderByDescending(a => a.CreatedAt).Skip((p.SafePage - 1) * p.SafeSize()).Take(p.SafeSize())
            .Select(a => new { Log = a, UserName = a.User!.DisplayName, TenantName = db.Tenants.IgnoreQueryFilters().Where(x => x.Id == a.TenantId).Select(x => x.Name).FirstOrDefault() })
            .ToListAsync(ct);
        return new PagedResult<AuditLogDto>(rows.Select(r => new AuditLogDto(r.Log.Id, r.Log.TenantId, r.TenantName, r.Log.UserId, r.UserName, r.Log.Action,
            r.Log.EntityType, r.Log.EntityId, r.Log.OldValue, r.Log.NewValue, r.Log.IpAddress, r.Log.CreatedAt)).ToList(), p.SafePage, p.SafeSize(), total);
    }
}
