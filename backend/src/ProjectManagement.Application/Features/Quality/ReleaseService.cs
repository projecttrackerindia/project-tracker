using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Quality;

public record ReleaseDto(Guid Id, string Name, Guid? ProjectId, string? ProjectName, DateOnly? TargetDate, string Status, string? Notes, int Items, int Runs,
    UserRefDto? ApprovedBy, DateTime? ApprovedAt, DateTime? ShippedAt, DateTime CreatedAt);
public record ReleaseItemDto(Guid Id, string Kind, string Key, string Title, string Status, StatusCategory Category, UserRefDto? Assignee, DateOnly? DueDate, bool Bug);
public record ReleaseCheckDto(string Key, string Label, bool Ok, string Detail);
public record ReleaseGoNoGoDto(ReleaseDto Release, IReadOnlyList<ReleaseItemDto> Items, IReadOnlyList<TestRunDto> Runs, QualityReadinessDto? Tests,
    int Done, int Open, int OpenBugs, IReadOnlyList<ReleaseCheckDto> Checks, bool Go, bool CanApprove);
public record UpsertReleaseRequest(string? Name, Guid? ProjectId = null, DateOnly? TargetDate = null, string? Notes = null);
public record ReleaseItemsRequest(IReadOnlyList<Guid>? Add = null, IReadOnlyList<Guid>? Remove = null);

/// <summary>
/// Releases: the work going out together, the test runs that check it, and one go/no-go. Go needs every item done, no open bug among the
/// items or filed from the release's test runs, and the latest run ready (Quality's pass rate with no blockers). Approving records who
/// and when; it can be approved against a "no go" only with a reason, which is kept in the notes. Shipped closes it.
/// </summary>
public class ReleaseService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, WorkItemApiService work, QualityService quality)
{
    public const int MaxItems = 150;

    private static string? Clean(string? s, int max, string field)
    {
        var t = s?.Trim();
        if (string.IsNullOrEmpty(t)) return null;
        if (t.Length > max) throw new ValidationException(field, $"It can be at most {max} characters.");
        return t;
    }

    public async Task<IReadOnlyList<ReleaseDto>> ListAsync(Guid? projectId, CancellationToken ct = default)
    {
        var q = db.Releases.AsNoTracking();
        if (projectId is { } p) q = q.Where(r => r.ProjectId == p);
        var rows = await q.OrderBy(r => r.Status == "Shipped").ThenBy(r => r.TargetDate).ThenByDescending(r => r.CreatedAt).Take(100).ToListAsync(ct);
        return await ToDtosAsync(rows, ct);
    }

    private async Task<List<ReleaseDto>> ToDtosAsync(List<Release> rows, CancellationToken ct)
    {
        var ids = rows.Select(r => r.Id).ToList();
        var items = await db.ReleaseItems.AsNoTracking().Where(i => ids.Contains(i.ReleaseId)).GroupBy(i => i.ReleaseId).Select(g => new { g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.N, ct);
        var runs = await db.TestRuns.AsNoTracking().Where(r => r.ReleaseId != null && ids.Contains(r.ReleaseId.Value)).GroupBy(r => r.ReleaseId!.Value).Select(g => new { g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.N, ct);
        var pids = rows.Where(r => r.ProjectId != null).Select(r => r.ProjectId!.Value).Distinct().ToList();
        var projects = await db.Projects.AsNoTracking().Where(p => pids.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => p.Name, ct);
        var uids = rows.Where(r => r.ApprovedById != null).Select(r => r.ApprovedById!.Value).Distinct().ToList();
        var users = await db.Users.AsNoTracking().Where(u => uids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return rows.Select(r => new ReleaseDto(r.Id, r.Name, r.ProjectId, r.ProjectId is { } p ? projects.GetValueOrDefault(p) : null, r.TargetDate, r.Status, r.Notes,
            items.GetValueOrDefault(r.Id), runs.GetValueOrDefault(r.Id), r.ApprovedById is { } a && users.TryGetValue(a, out var n) ? new UserRefDto(a, n) : null,
            r.ApprovedAt, r.ShippedAt, r.CreatedAt)).ToList();
    }

    private async Task<Release> FindAsync(Guid id, CancellationToken ct) =>
        await db.Releases.FirstOrDefaultAsync(r => r.Id == id, ct) ?? throw new NotFoundException("Release not found.", "RELEASE_NOT_FOUND");

    public async Task<ReleaseDto> CreateAsync(UpsertReleaseRequest req, CancellationToken ct = default)
    {
        var name = Clean(req.Name, 80, "name") ?? throw new ValidationException("name", "Name the release, such as “v2.4”.");
        if (req.ProjectId is { } pid && !await db.Projects.AnyAsync(p => p.Id == pid, ct)) throw new NotFoundException("Project not found.", "PROJECT_NOT_FOUND");
        var r = new Release { TenantId = ctx.RequireTenantId(), ProjectId = req.ProjectId, Name = name, TargetDate = req.TargetDate, Notes = Clean(req.Notes, 4000, "notes"), Status = "Planned", CreatedAt = clock.Now, CreatedBy = ctx.UserId };
        db.Releases.Add(r);
        recorder.Audit("release.created", "Release", r.Id, null, new { r.Name, r.TargetDate });
        await db.SaveChangesAsync(ct);
        return (await ToDtosAsync([r], ct))[0];
    }

    public async Task<ReleaseDto> UpdateAsync(Guid id, UpsertReleaseRequest req, CancellationToken ct = default)
    {
        var r = await FindAsync(id, ct);
        if (r.Status == "Shipped") throw new ConflictException("This release has shipped. Start a new one.", "RELEASE_SHIPPED");
        r.Name = Clean(req.Name, 80, "name") ?? r.Name;
        r.TargetDate = req.TargetDate;
        if (req.Notes is not null) r.Notes = Clean(req.Notes, 4000, "notes");
        r.UpdatedAt = clock.Now; r.UpdatedBy = ctx.UserId;
        await db.SaveChangesAsync(ct);
        return (await ToDtosAsync([r], ct))[0];
    }

    /// <summary>Adds and removes work items (each must exist and be visible to the caller).</summary>
    public async Task<ReleaseGoNoGoDto> SetItemsAsync(Guid id, ReleaseItemsRequest req, CancellationToken ct = default)
    {
        var r = await FindAsync(id, ct);
        if (r.Status == "Shipped") throw new ConflictException("This release has shipped. Start a new one.", "RELEASE_SHIPPED");
        var existing = await db.ReleaseItems.Where(i => i.ReleaseId == id).ToListAsync(ct);
        foreach (var rid in (req.Remove ?? []).Distinct()) { var row = existing.FirstOrDefault(i => i.WorkItemId == rid); if (row is not null) db.ReleaseItems.Remove(row); }
        var add = (req.Add ?? []).Distinct().Where(a => existing.All(i => i.WorkItemId != a)).ToList();
        if (existing.Count + add.Count > MaxItems) throw new ValidationException("add", $"A release holds up to {MaxItems} items.");
        foreach (var a in add)
        {
            await work.GetAsync(a, ct);   // exists and the caller may see it (throws otherwise)
            db.ReleaseItems.Add(new ReleaseItem { TenantId = ctx.RequireTenantId(), ReleaseId = id, WorkItemId = a, CreatedAt = clock.Now, CreatedBy = ctx.UserId });
        }
        await db.SaveChangesAsync(ct);
        return await GoNoGoAsync(id, ct);
    }

    /// <summary>Ties a test run to the release (or unties it with null).</summary>
    public async Task<ReleaseGoNoGoDto> SetRunAsync(Guid id, Guid runId, bool attach, CancellationToken ct = default)
    {
        await FindAsync(id, ct);
        var run = await db.TestRuns.FirstOrDefaultAsync(x => x.Id == runId, ct) ?? throw new NotFoundException("Test run not found.", "TEST_RUN_NOT_FOUND");
        run.ReleaseId = attach ? id : (run.ReleaseId == id ? null : run.ReleaseId);
        run.UpdatedAt = clock.Now; run.UpdatedBy = ctx.UserId;
        await db.SaveChangesAsync(ct);
        return await GoNoGoAsync(id, ct);
    }

    /// <summary>Everything that decides the release, and the decision: each check with what it found.</summary>
    public async Task<ReleaseGoNoGoDto> GoNoGoAsync(Guid id, CancellationToken ct = default)
    {
        var r = await db.Releases.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Release not found.", "RELEASE_NOT_FOUND");
        var itemIds = await db.ReleaseItems.AsNoTracking().Where(i => i.ReleaseId == id).OrderBy(i => i.CreatedAt).Select(i => i.WorkItemId).ToListAsync(ct);
        var runs = await db.TestRuns.AsNoTracking().Where(x => x.ReleaseId == id).OrderBy(x => x.CreatedAt).ToListAsync(ct);
        var runIds = runs.Select(x => x.Id).ToList();
        var filedBugs = runIds.Count == 0 ? new List<Guid>() : await db.TestResults.AsNoTracking().Where(x => runIds.Contains(x.RunId) && x.LinkedWorkItemId != null).Select(x => x.LinkedWorkItemId!.Value).Distinct().ToListAsync(ct);
        var items = new List<ReleaseItemDto>();
        foreach (var wid in itemIds.Concat(filedBugs.Where(b => !itemIds.Contains(b))).Take(MaxItems + 50))
        {
            WorkItemDetailDto w;
            try { w = await work.GetAsync(wid, ct); }
            catch (NotFoundException) { continue; }   // removed, or not visible to this person
            catch (ForbiddenException) { continue; }
            var bug = filedBugs.Contains(wid) || w.Kind == "issue";
            items.Add(new ReleaseItemDto(w.Id, w.Kind, w.Key, w.Title, w.Status, w.Category, w.Assignee, w.DueDate, bug));
        }
        bool Closed(ReleaseItemDto i) => i.Category is StatusCategory.Done or StatusCategory.Cancelled;
        var scope = items.Where(i => itemIds.Contains(i.Id)).ToList();
        int done = scope.Count(Closed), open = scope.Count - done, openBugs = items.Count(i => i.Bug && !Closed(i));
        var tests = runs.Count == 0 ? null : await quality.ReadinessAsync(runs[^1].Id, null, ct);
        var checks = new List<ReleaseCheckDto>
        {
            new("work", "Work done", scope.Count > 0 && open == 0, scope.Count == 0 ? "Add the work going out in this release." : open == 0 ? $"All {scope.Count} items are done." : $"{open} of {scope.Count} items are still open."),
            new("bugs", "No open bugs", openBugs == 0, openBugs == 0 ? "No open bug among the items or from its test runs." : $"{openBugs} bug{(openBugs == 1 ? " is" : "s are")} still open."),
            new("tests", "Tests ready", tests?.Ready == true, tests is null ? "Run the tests for this release (tie a test run to it)."
                : tests.Ready ? $"{tests.Run!.Name}: {tests.PassPercent}% passed, no blockers." : $"{tests.Run!.Name}: {tests.PassPercent}% passed{(tests.Blockers.Count > 0 ? $", {tests.Blockers.Count} blocker{(tests.Blockers.Count == 1 ? "" : "s")}" : "")}{(tests.NotRun > 0 ? $", {tests.NotRun} not run" : "")}."),
        };
        var go = checks.All(c => c.Ok);
        return new ReleaseGoNoGoDto((await ToDtosAsync([r], ct))[0], items, runs.Select(QualityService.ToDto).ToList(), tests, done, open, openBugs, checks, go, r.Status == "Planned");
    }

    /// <summary>Approves the release. Against a "no go" it needs a reason, which is added to the notes with who decided.</summary>
    public async Task<ReleaseGoNoGoDto> ApproveAsync(Guid id, string? reason, CancellationToken ct = default)
    {
        var state = await GoNoGoAsync(id, ct);
        var r = await FindAsync(id, ct);
        if (r.Status != "Planned") throw new ConflictException("This release is already approved.", "RELEASE_APPROVED");
        var why = Clean(reason, 500, "reason");
        if (!state.Go && why is null) throw new ValidationException("reason", "The checks say no go. Give the reason for going anyway.");
        r.Status = "Approved"; r.ApprovedById = ctx.UserId; r.ApprovedAt = clock.Now;
        if (why is not null) r.Notes = Clean($"{r.Notes}\n\nApproved against the checks: {why}".Trim(), 4000, "notes");
        r.UpdatedAt = clock.Now; r.UpdatedBy = ctx.UserId;
        recorder.Audit("release.approved", "Release", id, null, new { r.Name, go = state.Go, why });
        await db.SaveChangesAsync(ct);
        return await GoNoGoAsync(id, ct);
    }

    public async Task<ReleaseGoNoGoDto> ShipAsync(Guid id, CancellationToken ct = default)
    {
        var r = await FindAsync(id, ct);
        if (r.Status != "Approved") throw new ConflictException("Approve the release before marking it shipped.", "RELEASE_NOT_APPROVED");
        r.Status = "Shipped"; r.ShippedAt = clock.Now; r.UpdatedAt = clock.Now; r.UpdatedBy = ctx.UserId;
        recorder.Audit("release.shipped", "Release", id, null, new { r.Name });
        await db.SaveChangesAsync(ct);
        return await GoNoGoAsync(id, ct);
    }
}
