using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>Read-only jobs may recover after crashes. Atomic leases fence stale workers and cancellation.</summary>
public class AiOperationsProcessor(IServiceScopeFactory scopes, TimeProvider time)
{
    private DateTime Now => time.GetUtcNow().UtcDateTime;
    private long lastRetentionAt;

    public async Task<int> ProcessAsync(CancellationToken ct = default)
    {
        await RetainOperationalEvidenceAsync(ct);
        await RecoverCreditsAsync(ct);
        await QueueSchedulesAsync(ct);
        List<Guid> candidates;
        using (var scope = scopes.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IAppDbContext>();
            var now = Now;
            await db.AiJobs.IgnoreQueryFilters().Where(j => j.Status == "running" && j.LeaseExpiresAt <= now)
                .ExecuteUpdateAsync(s => s.SetProperty(j => j.Status, j => j.Attempts < 3 ? "queued" : "failed")
                    .SetProperty(j => j.CompletedAt, j => j.Attempts < 3 ? (DateTime?)null : now)
                    .SetProperty(j => j.AvailableAt, now).SetProperty(j => j.ErrorCode, "AI_WORKER_INTERRUPTED")
                    .SetProperty(j => j.LeaseOwner, (Guid?)null).SetProperty(j => j.LeaseExpiresAt, (DateTime?)null), ct);
            // At most one job per workspace in a pass; a large tenant cannot occupy every slot.
            var tenants = await db.AiJobs.IgnoreQueryFilters().AsNoTracking().Where(j => j.Status == "queued" && j.AvailableAt <= now)
                .GroupBy(j => j.TenantId).Select(g => new { TenantId = g.Key, Oldest = g.Min(j => j.AvailableAt) })
                .OrderBy(g => g.Oldest).ThenBy(g => g.TenantId).Take(5).ToListAsync(ct);
            candidates = [];
            foreach (var tenant in tenants)
            {
                var next = await db.AiJobs.IgnoreQueryFilters().AsNoTracking()
                    .Where(j => j.TenantId == tenant.TenantId && j.Status == "queued" && j.AvailableAt <= now)
                    .OrderByDescending(j => j.Priority).ThenBy(j => j.AvailableAt).Select(j => j.Id).FirstOrDefaultAsync(ct);
                if (next != Guid.Empty) candidates.Add(next);
            }
        }
        var processed = 0;
        foreach (var id in candidates)
        {
            ct.ThrowIfCancellationRequested();
            if (await RunAsync(id, ct)) processed++;
        }
        return processed;
    }

    private async Task RetainOperationalEvidenceAsync(CancellationToken ct)
    {
        var now = Now; var previous = Interlocked.Read(ref lastRetentionAt);
        if (now.Ticks - previous < TimeSpan.FromHours(1).Ticks || Interlocked.CompareExchange(ref lastRetentionAt, now.Ticks, previous) != previous) return;
        using var scope = scopes.CreateScope(); var db = scope.ServiceProvider.GetRequiredService<IAppDbContext>();
        // System cleanup only: expire saved read-only payloads, never financial entries or business records.
        var payloads = await db.AiJobs.IgnoreQueryFilters().Where(j => j.ResultJson != null && j.CompletedAt < now.AddDays(-30))
            .OrderBy(j => j.CompletedAt).Select(j => j.Id).Take(1000).ToListAsync(ct);
        await db.AiJobs.IgnoreQueryFilters().Where(j => payloads.Contains(j.Id)).ExecuteUpdateAsync(s => s
            .SetProperty(j => j.ResultJson, (string?)null).SetProperty(j => j.ErrorCode, "AI_EVIDENCE_EXPIRED"), ct);
        var forecasts = await db.AiForecastSnapshots.IgnoreQueryFilters().Where(f => f.EvidenceAt < now.AddDays(-90))
            .OrderBy(f => f.EvidenceAt).Select(f => f.Id).Take(1000).ToListAsync(ct);
        await db.AiForecastSnapshots.IgnoreQueryFilters().Where(f => forecasts.Contains(f.Id)).ExecuteDeleteAsync(ct);
    }

    private async Task RecoverCreditsAsync(CancellationToken ct)
    {
        using var scan = scopes.CreateScope(); var db = scan.ServiceProvider.GetRequiredService<IAppDbContext>();
        var now = Now;
        var tenants = await db.AiCreditReservations.IgnoreQueryFilters().AsNoTracking()
            .Where(r => r.Status == "reserved" && r.ExpiresAt <= now && db.Tenants.Any(t => t.Id == r.TenantId && !t.IsDeleted))
            .Select(r => r.TenantId).Distinct().OrderBy(id => id).Take(50).ToListAsync(ct);
        foreach (var tenant in tenants)
        {
            using var scope = scopes.CreateScope();
            scope.ServiceProvider.GetRequiredService<CurrentContext>().TenantId = tenant;
            await scope.ServiceProvider.GetRequiredService<AiCreditService>().RecoverExpiredAsync(ct);
        }
    }

    private async Task QueueSchedulesAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope(); var db = scope.ServiceProvider.GetRequiredService<IAppDbContext>();
        var now = Now;
        // System scan contains only scheduling metadata. Actual data retrieval happens in a fresh requester scope.
        var due = await db.AiSchedules.IgnoreQueryFilters().AsNoTracking().Where(s => s.Enabled && s.NextRunAt <= now)
            .OrderBy(s => s.NextRunAt).Take(50).ToListAsync(ct);
        foreach (var schedule in due)
        {
            scope.ServiceProvider.GetRequiredService<CurrentContext>().TenantId = schedule.TenantId;
            await using var tx = await db.Database.BeginOwnedTransactionAsync(ct);
            await db.LockTenantLedgerAsync(schedule.TenantId, ct);
            var full = await db.AiJobs.IgnoreQueryFilters().CountAsync(j => j.TenantId == schedule.TenantId && (j.Status == "queued" || j.Status == "running"), ct) >= 100;
            if (full)
            {
                await db.AiSchedules.IgnoreQueryFilters().Where(s => s.Id == schedule.Id && s.Enabled && s.NextRunAt == schedule.NextRunAt)
                    .ExecuteUpdateAsync(s => s.SetProperty(x => x.NextRunAt, now.AddMinutes(1)), ct);
                await tx.CommitIfOwnedAsync(ct);
                continue;
            }
            var next = now.AddMinutes(schedule.IntervalMinutes);
            var won = await db.AiSchedules.IgnoreQueryFilters().Where(s => s.Id == schedule.Id && s.Enabled && s.NextRunAt == schedule.NextRunAt)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.NextRunAt, next).SetProperty(x => x.LastQueuedAt, now), ct);
            if (won == 0) continue;
            var pending = await db.AiJobs.IgnoreQueryFilters().AnyAsync(j => j.TenantId == schedule.TenantId && j.UserId == schedule.UserId
                && j.Kind == schedule.Kind && j.TeamId == schedule.TeamId && (j.Status == "queued" || j.Status == "running"), ct);
            if (!pending) db.AiJobs.Add(new AiJob { TenantId = schedule.TenantId, UserId = schedule.UserId, TeamId = schedule.TeamId, ScheduleId = schedule.Id,
                Kind = schedule.Kind, Title = schedule.Title, IdempotencyKey = $"schedule:{schedule.Id:N}:{schedule.NextRunAt.Ticks}", AvailableAt = now });
            await db.SaveChangesAsync(ct); await tx.CommitIfOwnedAsync(ct);
        }
    }

    private async Task<bool> RunAsync(Guid id, CancellationToken ct)
    {
        using var scope = scopes.CreateScope(); var sp = scope.ServiceProvider;
        var db = sp.GetRequiredService<IAppDbContext>(); var owner = Guid.NewGuid(); var now = Now;
        var won = await db.AiJobs.IgnoreQueryFilters().Where(j => j.Id == id && j.Status == "queued" && j.AvailableAt <= now)
            .ExecuteUpdateAsync(s => s.SetProperty(j => j.Status, "running").SetProperty(j => j.Attempts, j => j.Attempts + 1)
                .SetProperty(j => j.StartedAt, now).SetProperty(j => j.Progress, 10).SetProperty(j => j.LeaseOwner, owner)
                .SetProperty(j => j.LeaseExpiresAt, now.AddMinutes(2)), ct);
        if (won == 0) return false;
        var job = await db.AiJobs.IgnoreQueryFilters().AsNoTracking().FirstOrDefaultAsync(j => j.Id == id && j.LeaseOwner == owner, ct);
        if (job is null) return true; // a cancellation won after the claim
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct); deadline.CancelAfter(TimeSpan.FromSeconds(60));
        try
        {
            await SetRequesterAsync(sp, job, deadline.Token);
            await using var snapshot = await db.BeginEvidenceSnapshotAsync(deadline.Token);
            var evidenceAt = Now;
            var service = sp.GetRequiredService<AiOperationsService>();
            await service.AuthorizeAsync(job.Kind, deadline.Token);
            var fingerprint = await service.FingerprintAsync(deadline.Token, job.TeamId);
            AiJobResult result;
            var analysis = sp.GetRequiredService<AiAnalysis>();
            if (job.Kind == "portfolio")
            {
                var brief = await sp.GetRequiredService<AiPortfolio>().BriefAsync(job.TeamId, deadline.Token);
                await sp.GetRequiredService<AiForecastService>().CaptureAsync(job, brief, evidenceAt, deadline.Token);
                result = new(AiPortfolio.ToText(brief), evidenceAt, "portfolio-rules-v1; 28-day completion pace; confidence is heuristic, not a calibrated probability",
                    brief.Ranked.Select(p => new AiEvidenceSource("project", p.ProjectId.ToString(), p.Key, $"/projects/{p.ProjectId}")).ToList(), brief);
            }
            else if (job.Kind == "workload")
            {
                var balance = await analysis.WorkloadBalanceAsync(null, deadline.Token);
                result = new(balance.Text, Now, "workload-rules-v1; recorded capacity and estimates; no inferred availability or reassignment", [new("workload", "current", "Current workload", "/workload")]);
            }
            else
            {
                var history = await analysis.HistoryInsightsAsync(null, null, 90, deadline.Token);
                result = new(history.Text, Now, "delivery-history-v1; last 90 days; observed outcomes, not causal predictions", [new("history", "current", "Current portfolio", "/projects")]);
            }
            var json = JsonSerializer.Serialize(result, AiOperationsService.Json);
            var finalized = await db.AiJobs.Where(j => j.Id == id && j.Status == "running" && j.LeaseOwner == owner)
                .ExecuteUpdateAsync(s => s.SetProperty(j => j.Status, "succeeded").SetProperty(j => j.Progress, 100).SetProperty(j => j.CompletedAt, Now)
                    .SetProperty(j => j.ResultJson, json).SetProperty(j => j.AccessFingerprint, fingerprint).SetProperty(j => j.ErrorCode, (string?)null)
                    .SetProperty(j => j.LeaseOwner, (Guid?)null).SetProperty(j => j.LeaseExpiresAt, (DateTime?)null), deadline.Token);
            if (finalized != 0)
            {
                if (job.ScheduleId != null && (await sp.GetRequiredService<NotificationRouter>().ChannelsAsync(job.UserId, NotificationType.ReportReady, deadline.Token)).InApp)
                    db.Notifications.Add(new Notification { TenantId = job.TenantId, UserId = job.UserId, Type = NotificationType.ReportReady,
                        Title = "Your scheduled agent review is ready", Body = "Open the review to see its evidence and recommendations.",
                        Link = $"/ai/operations?job={job.Id}", DedupeKey = $"ai-review:{job.Id:N}", InApp = true });
                await db.SaveChangesAsync(deadline.Token);
                await snapshot.CommitAsync(deadline.Token);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; } // lease recovery after shutdown
        catch (Exception ex)
        {
            var code = ex is AppException app ? app.Code : ex is OperationCanceledException ? "AI_JOB_TIMEOUT" : "AI_JOB_FAILED";
            var retry = ex is not AppException && job.Attempts < 3;
            await db.AiJobs.IgnoreQueryFilters().Where(j => j.Id == id && j.Status == "running" && j.LeaseOwner == owner)
                .ExecuteUpdateAsync(s => s.SetProperty(j => j.Status, retry ? "queued" : "failed").SetProperty(j => j.ErrorCode, code)
                    .SetProperty(j => j.AvailableAt, Now.AddSeconds(30 * job.Attempts)).SetProperty(j => j.CompletedAt, retry ? (DateTime?)null : Now)
                    .SetProperty(j => j.LeaseOwner, (Guid?)null).SetProperty(j => j.LeaseExpiresAt, (DateTime?)null), ct);
        }
        return true;
    }

    private static async Task SetRequesterAsync(IServiceProvider sp, AiJob job, CancellationToken ct)
    {
        var db = sp.GetRequiredService<IAppDbContext>(); var cc = sp.GetRequiredService<CurrentContext>();
        if (!await db.Users.AsNoTracking().AnyAsync(u => u.Id == job.UserId && u.IsActive, ct))
            throw new ForbiddenException("The requester account is inactive.", "ACCOUNT_INACTIVE");
        var member = await db.TenantMembers.AsNoTracking().FirstOrDefaultAsync(m => m.TenantId == job.TenantId && m.UserId == job.UserId, ct)
            ?? throw new ForbiddenException("The requester is no longer a workspace member.", "NOT_A_MEMBER");
        var tenant = await db.Tenants.IgnoreQueryFilters().AsNoTracking().FirstOrDefaultAsync(t => t.Id == job.TenantId && !t.IsDeleted && t.Status == TenantStatus.Active, ct)
            ?? throw new ForbiddenException("This workspace is unavailable.", "WORKSPACE_UNAVAILABLE");
        cc.UserId = job.UserId; cc.TenantId = job.TenantId; cc.Role = member.Role; cc.WorkspaceType = tenant.Type; cc.IsPlatformAdmin = false;
        var permissions = sp.GetRequiredService<PermissionService>();
        cc.ProjectScope = member.Role == TenantRole.Guest ? ProjectScope.Members
            : tenant.ProjectVisibility == ProjectVisibility.Teams && !await permissions.HasAsync(Permissions.ProjectsViewAll, ct) ? ProjectScope.Teams : ProjectScope.None;
        cc.TeamLens = job.TeamId;
        cc.RestrictsProjects = cc.ProjectScope != ProjectScope.None || cc.TeamLens is not null;
        cc.ProjectIds = [];
        if (cc.RestrictsProjects)
        {
            var projects = db.Projects.IgnoreQueryFilters().AsNoTracking().Where(p => p.TenantId == job.TenantId && !p.IsDeleted);
            if (job.TeamId is { } team) projects = projects.Where(p => p.TeamId == team);
            if (cc.ProjectScope == ProjectScope.Members) projects = projects.Where(p => db.ProjectMembers.Any(m => m.ProjectId == p.Id && m.UserId == job.UserId));
            else if (cc.ProjectScope == ProjectScope.Teams) projects = projects.Where(p => p.OwnerId == job.UserId
                || db.ProjectMembers.Any(m => m.ProjectId == p.Id && m.UserId == job.UserId)
                || p.TeamId != null && db.TeamMembers.Any(m => m.TeamId == p.TeamId && m.UserId == job.UserId));
            cc.ProjectIds = await projects.Select(p => p.Id).ToArrayAsync(ct);
        }
        await sp.GetRequiredService<ProjectAccess>().RequireLensAsync(job.TeamId, ct);
    }
}
