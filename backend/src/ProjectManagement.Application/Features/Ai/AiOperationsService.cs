using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Ai;

public record SubmitAiJobRequest(string Kind, string Title, string IdempotencyKey, Guid? TeamId = null, int Priority = 0);
public record AiScheduleRequest(string Kind, string Title, int IntervalMinutes, Guid? TeamId = null, bool Enabled = true);
public record AiJobResult(string Summary, DateTime EvidenceAt, string Methodology, IReadOnlyList<AiEvidenceSource> Sources, PortfolioBriefDto? Portfolio = null);
public record AiEvidenceSource(string Kind, string Id, string Label, string Link, string? Version = null);
public record AiJobDto(Guid Id, string Kind, string Title, string Status, int Progress, int Attempts, DateTime CreatedAt,
    DateTime? StartedAt, DateTime? CompletedAt, string? ErrorCode, AiJobResult? Result, Guid? ScheduleId);
public record AiScheduleDto(Guid Id, string Kind, string Title, int IntervalMinutes, bool Enabled, DateTime NextRunAt, Guid? TeamId);

public class AiOperationsService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ProjectAccess access, PermissionService permissions)
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public static readonly string[] Kinds = ["portfolio", "workload", "history"];
    private string? fingerprint;

    internal async Task AuthorizeAsync(string kind, CancellationToken ct)
    {
        ctx.RequireUserId(); ctx.RequireTenantId();
        if (!Kinds.Contains(kind)) throw new ValidationException("kind", "Choose portfolio, workload or history.");
        await permissions.RequireModuleAsync(Modules.Projects, AccessLevel.View, ct);
    }

    internal async Task<string> FingerprintAsync(CancellationToken ct)
    {
        if (fingerprint is not null) return fingerprint;
        var projects = await access.VisibleProjects().AsNoTracking().OrderBy(p => p.Id).Select(p => p.Id).ToListAsync(ct);
        var profile = await permissions.ProfileAsync(ct);
        var overrides = await db.RolePermissionOverrides.AsNoTracking().OrderBy(p => p.Id).Select(p => new { p.Permission, p.Allowed, p.Role }).ToListAsync(ct);
        var value = JsonSerializer.Serialize(new { ctx.UserId, ctx.TenantId, ctx.Role, ctx.ProjectScope, ctx.TeamLens, projects, profile, overrides }, Json);
        return fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    }

    private static string Title(string title) => !string.IsNullOrWhiteSpace(title) && title.Trim().Length <= 120
        ? title.Trim() : throw new ValidationException("title", "Use a title from 1 to 120 characters.");

    public async Task<AiJobDto> SubmitAsync(SubmitAiJobRequest req, CancellationToken ct)
    {
        await AuthorizeAsync(req.Kind, ct);
        var title = Title(req.Title); var uid = ctx.RequireUserId();
        if (string.IsNullOrWhiteSpace(req.IdempotencyKey) || req.IdempotencyKey.Length > 120)
            throw new ValidationException("idempotencyKey", "Use a stable request key from 1 to 120 characters.");
        if (req.Priority is < 0 or > 10) throw new ValidationException("priority", "Priority must be from 0 to 10.");
        var team = await access.RequireLensAsync(req.TeamId, ct);
        var old = await db.AiJobs.FirstOrDefaultAsync(j => j.UserId == uid && j.IdempotencyKey == req.IdempotencyKey, ct);
        if (old is not null)
        {
            if (old.Kind != req.Kind || old.Title != title || old.TeamId != team || old.Priority != req.Priority)
                throw new ConflictException("This request key belongs to different work.", "AI_JOB_KEY_MISMATCH");
            return await ToDtoAsync(old, ct);
        }
        if (await db.AiJobs.CountAsync(j => j.UserId == uid && (j.Status == "queued" || j.Status == "running"), ct) >= 20)
            throw new ConflictException("Finish or cancel some pending reviews before adding more.", "AI_JOB_LIMIT");
        var row = new AiJob { TenantId = ctx.RequireTenantId(), UserId = uid, TeamId = team, Kind = req.Kind, Title = title,
            IdempotencyKey = req.IdempotencyKey, Priority = req.Priority, AvailableAt = clock.Now };
        db.AiJobs.Add(row);
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException)
        {
            db.AiJobs.Entry(row).State = EntityState.Detached;
            var winner = await db.AiJobs.AsNoTracking().FirstOrDefaultAsync(j => j.UserId == uid && j.IdempotencyKey == req.IdempotencyKey, ct);
            if (winner is null) throw;
            if (winner.Kind != req.Kind || winner.Title != title || winner.TeamId != team || winner.Priority != req.Priority)
                throw new ConflictException("This request key belongs to different work.", "AI_JOB_KEY_MISMATCH");
            row = winner;
        }
        return await ToDtoAsync(row, ct);
    }

    public async Task<IReadOnlyList<AiJobDto>> ListAsync(CancellationToken ct)
    {
        var uid = ctx.RequireUserId(); ctx.RequireTenantId();
        var rows = await db.AiJobs.AsNoTracking().Where(j => j.UserId == uid).OrderByDescending(j => j.CreatedAt).Take(50).ToListAsync(ct);
        var result = new List<AiJobDto>();
        foreach (var row in rows) result.Add(await ToDtoAsync(row, ct));
        return result;
    }

    public async Task<AiJobDto> GetAsync(Guid id, CancellationToken ct) => await ToDtoAsync(await OwnAsync(id, ct), ct);
    private async Task<AiJob> OwnAsync(Guid id, CancellationToken ct) => await db.AiJobs.FirstOrDefaultAsync(j => j.Id == id && j.UserId == ctx.RequireUserId(), ct)
        ?? throw new NotFoundException("Agent review not found.");

    private async Task<AiJobDto> ToDtoAsync(AiJob row, CancellationToken ct)
    {
        AiJobResult? result = null; var error = row.ErrorCode;
        if (row.ResultJson is not null)
        {
            await AuthorizeAsync(row.Kind, ct);
            if (row.AccessFingerprint == await FingerprintAsync(ct)) result = JsonSerializer.Deserialize<AiJobResult>(row.ResultJson, Json);
            else error = "AI_EVIDENCE_ACCESS_CHANGED";
        }
        return new(row.Id, row.Kind, row.Title, row.Status, row.Progress, row.Attempts, row.CreatedAt, row.StartedAt, row.CompletedAt, error, result, row.ScheduleId);
    }

    public async Task<AiJobDto> CancelAsync(Guid id, CancellationToken ct)
    {
        await OwnAsync(id, ct);
        await db.AiJobs.Where(j => j.Id == id && j.UserId == ctx.RequireUserId() && (j.Status == "queued" || j.Status == "running"))
            .ExecuteUpdateAsync(s => s.SetProperty(j => j.Status, "cancelled").SetProperty(j => j.CompletedAt, clock.Now)
                .SetProperty(j => j.LeaseOwner, (Guid?)null).SetProperty(j => j.LeaseExpiresAt, (DateTime?)null), ct);
        return await ToDtoAsync(await db.AiJobs.AsNoTracking().FirstAsync(j => j.Id == id, ct), ct);
    }

    public async Task<AiScheduleDto> ScheduleAsync(AiScheduleRequest req, CancellationToken ct)
    {
        await AuthorizeAsync(req.Kind, ct);
        if (req.IntervalMinutes is < 60 or > 10080) throw new ValidationException("intervalMinutes", "Review intervals range from one hour to one week.");
        var uid = ctx.RequireUserId();
        if (await db.AiSchedules.CountAsync(s => s.UserId == uid, ct) >= 20) throw new ConflictException("Remove a schedule before adding another.", "AI_SCHEDULE_LIMIT");
        var row = new AiSchedule { TenantId = ctx.RequireTenantId(), UserId = uid, Kind = req.Kind, Title = Title(req.Title),
            TeamId = await access.RequireLensAsync(req.TeamId, ct), IntervalMinutes = req.IntervalMinutes, Enabled = req.Enabled, NextRunAt = clock.Now };
        db.AiSchedules.Add(row); await db.SaveChangesAsync(ct); return ScheduleDto(row);
    }

    public async Task<IReadOnlyList<AiScheduleDto>> SchedulesAsync(CancellationToken ct) => (await db.AiSchedules.AsNoTracking()
        .Where(s => s.UserId == ctx.RequireUserId()).OrderBy(s => s.NextRunAt).Take(20).ToListAsync(ct)).Select(ScheduleDto).ToList();

    public async Task RemoveScheduleAsync(Guid id, CancellationToken ct)
    {
        var row = await db.AiSchedules.FirstOrDefaultAsync(s => s.Id == id && s.UserId == ctx.RequireUserId(), ct) ?? throw new NotFoundException("Schedule not found.");
        db.AiSchedules.Remove(row); await db.SaveChangesAsync(ct);
    }

    private static AiScheduleDto ScheduleDto(AiSchedule s) => new(s.Id, s.Kind, s.Title, s.IntervalMinutes, s.Enabled, s.NextRunAt, s.TeamId);
}
