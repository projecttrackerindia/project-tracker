using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Quality;

public record TestCaseDto(Guid Id, string Key, string Title, string? Steps, string? Expected, string Priority, string? Tags, Guid? ProjectId, string? ProjectName,
    DateTime CreatedAt, DateTime? UpdatedAt);
public record TestRunDto(Guid Id, string Name, string? Environment, string? Build, string Status, Guid? ProjectId, DateTime CreatedAt, DateTime? StartedAt, DateTime? CompletedAt);
public record TestResultDto(Guid Id, Guid RunId, Guid CaseId, string Status, string? Actual, string? Evidence, UserRefDto? RunBy, DateTime? At, Guid? LinkedWorkItemId);
public record TestMatrixDto(IReadOnlyList<TestRunDto> Runs, IReadOnlyList<TestCaseDto> Cases, IReadOnlyList<TestResultDto> Results);
public record QualityBlockerDto(Guid CaseId, string Key, string Title, string Priority);
public record QualityReadinessDto(TestRunDto? Run, int Cases, int Ran, int Passed, int Failed, int Blocked, int NotRun, int PassPercent, IReadOnlyList<QualityBlockerDto> Blockers, bool Ready);
public record FiledBugDto(TestResultDto Result, WorkItemDetailDto WorkItem);

public record UpsertTestCaseRequest(string? Title, string? Steps = null, string? Expected = null, string? Priority = null, string? Tags = null, Guid? ProjectId = null);
public record CreateTestRunRequest(string? Name, string? Environment = null, string? Build = null, Guid? ProjectId = null);
public record SetTestResultRequest(string? Status, string? Actual = null, string? Evidence = null);
public record FileBugRequest(string? Title = null, Guid? AssigneeId = null);

/// <summary>
/// Quality (testers): test cases, runs of them on a build and environment, and one result per case in a run. The matrix shows cases by
/// recent runs; readiness is the pass rate of a run and its blockers (failed Critical or High cases); "File bug" creates a ticket through
/// the Work API, linked to the result. Who may read or change it is the Work module's access (see the controller).
/// </summary>
public class QualityService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, WorkItemApiService work, WorkTypeService workTypes)
{
    public static readonly string[] Priorities = ["Low", "Medium", "High", "Critical"];
    public static readonly string[] ResultStatuses = ["NotRun", "Pass", "Fail", "Blocked"];
    public static readonly string[] RunStatuses = ["Open", "Running", "Done"];
    /// <summary>A release is ready at this pass rate with no blockers.</summary>
    public const int ReadyPercent = 95;

    private static string? Clean(string? s, int max, string field)
    {
        var t = s?.Trim();
        if (string.IsNullOrEmpty(t)) return null;
        if (t.Length > max) throw new ValidationException(field, $"It can be at most {max} characters.");
        return t;
    }

    private static string Pick(string? value, string[] allowed, string fallback, string field)
    {
        if (string.IsNullOrWhiteSpace(value)) return fallback;
        return allowed.FirstOrDefault(a => string.Equals(a, value.Trim(), StringComparison.OrdinalIgnoreCase))
            ?? throw new ValidationException(field, $"Use one of: {string.Join(", ", allowed)}.");
    }

    private async Task RequireProjectAsync(Guid? projectId, CancellationToken ct)
    {
        if (projectId is { } id && !await db.Projects.AnyAsync(p => p.Id == id, ct))
            throw new NotFoundException("Project not found.", "PROJECT_NOT_FOUND");
    }

    private async Task<Dictionary<Guid, string>> ProjectNamesAsync(IEnumerable<Guid?> ids, CancellationToken ct)
    {
        var list = ids.Where(x => x.HasValue).Select(x => x!.Value).Distinct().ToList();
        if (list.Count == 0) return new Dictionary<Guid, string>();
        return await db.Projects.AsNoTracking().Where(p => list.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => p.Name, ct);
    }

    private static TestCaseDto ToDto(TestCase c, IReadOnlyDictionary<Guid, string> projects) =>
        new(c.Id, c.Key, c.Title, c.Steps, c.Expected, c.Priority, c.Tags, c.ProjectId, c.ProjectId is { } p ? projects.GetValueOrDefault(p) : null, c.CreatedAt, c.UpdatedAt);

    private static TestRunDto ToDto(TestRun r) => new(r.Id, r.Name, r.Environment, r.Build, r.Status, r.ProjectId, r.CreatedAt, r.StartedAt, r.CompletedAt);

    private async Task<List<TestResultDto>> ToDtosAsync(IReadOnlyList<TestResult> results, CancellationToken ct)
    {
        var ids = results.Where(r => r.RunById.HasValue).Select(r => r.RunById!.Value).Distinct().ToList();
        var names = ids.Count == 0 ? new Dictionary<Guid, string>() : await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return results.Select(r => new TestResultDto(r.Id, r.RunId, r.CaseId, r.Status, r.Actual, r.Evidence,
            r.RunById is { } u ? new UserRefDto(u, names.GetValueOrDefault(u) ?? "Former member") : null, r.At, r.LinkedWorkItemId)).ToList();
    }

    // ------------------------------------------------------------------ cases

    public async Task<IReadOnlyList<TestCaseDto>> ListCasesAsync(Guid? projectId, CancellationToken ct = default)
    {
        var q = db.TestCases.AsNoTracking();
        if (projectId is { } p) q = q.Where(c => c.ProjectId == p);
        var cases = await q.OrderBy(c => c.Number).ToListAsync(ct);
        var projects = await ProjectNamesAsync(cases.Select(c => c.ProjectId), ct);
        return cases.Select(c => ToDto(c, projects)).ToList();
    }

    public async Task<TestCaseDto> CreateCaseAsync(UpsertTestCaseRequest req, CancellationToken ct = default)
    {
        var title = Clean(req.Title, 300, "title") ?? throw new ValidationException("title", "Give the test case a title.");
        await RequireProjectAsync(req.ProjectId, ct);
        var tenantId = ctx.RequireTenantId();
        var next = (await db.TestCases.IgnoreQueryFilters().Where(x => x.TenantId == tenantId).MaxAsync(x => (int?)x.Number, ct) ?? 100) + 1;
        var c = new TestCase
        {
            TenantId = tenantId, ProjectId = req.ProjectId, Number = next, Key = $"TC-{next}", Title = title,
            Steps = Clean(req.Steps, 8000, "steps"), Expected = Clean(req.Expected, 2000, "expected"), Priority = Pick(req.Priority, Priorities, "Medium", "priority"),
            Tags = Clean(req.Tags, 300, "tags"), CreatedAt = clock.Now, CreatedBy = ctx.UserId,
        };
        db.TestCases.Add(c);
        recorder.Audit("quality.case.created", "TestCase", c.Id, null, new { c.Key, c.Title });
        await db.SaveChangesAsync(ct);
        return ToDto(c, await ProjectNamesAsync([c.ProjectId], ct));
    }

    public async Task<TestCaseDto> UpdateCaseAsync(Guid id, UpsertTestCaseRequest req, CancellationToken ct = default)
    {
        var c = await db.TestCases.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Test case not found.", "TEST_CASE_NOT_FOUND");
        if (req.Title is not null) c.Title = Clean(req.Title, 300, "title") ?? throw new ValidationException("title", "Give the test case a title.");
        if (req.Steps is not null) c.Steps = Clean(req.Steps, 8000, "steps");
        if (req.Expected is not null) c.Expected = Clean(req.Expected, 2000, "expected");
        if (req.Priority is not null) c.Priority = Pick(req.Priority, Priorities, c.Priority, "priority");
        if (req.Tags is not null) c.Tags = Clean(req.Tags, 300, "tags");
        if (req.ProjectId is { } p && p != c.ProjectId) { await RequireProjectAsync(p, ct); c.ProjectId = p; }
        c.UpdatedAt = clock.Now; c.UpdatedBy = ctx.UserId;
        recorder.Audit("quality.case.updated", "TestCase", c.Id, null, new { c.Key, c.Title });
        await db.SaveChangesAsync(ct);
        return ToDto(c, await ProjectNamesAsync([c.ProjectId], ct));
    }

    // ------------------------------------------------------------------ runs

    public async Task<IReadOnlyList<TestRunDto>> ListRunsAsync(Guid? projectId, CancellationToken ct = default)
    {
        var q = db.TestRuns.AsNoTracking();
        if (projectId is { } p) q = q.Where(r => r.ProjectId == p);
        return (await q.OrderByDescending(r => r.CreatedAt).ToListAsync(ct)).Select(ToDto).ToList();
    }

    public async Task<TestRunDto> CreateRunAsync(CreateTestRunRequest req, CancellationToken ct = default)
    {
        var name = Clean(req.Name, 120, "name") ?? throw new ValidationException("name", "Give the run a name, such as “UAT 1.4”.");
        await RequireProjectAsync(req.ProjectId, ct);
        var r = new TestRun
        {
            TenantId = ctx.RequireTenantId(), ProjectId = req.ProjectId, Name = name, Environment = Clean(req.Environment, 40, "environment"),
            Build = Clean(req.Build, 40, "build"), Status = "Open", CreatedAt = clock.Now, CreatedBy = ctx.UserId,
        };
        db.TestRuns.Add(r);
        recorder.Audit("quality.run.created", "TestRun", r.Id, null, new { r.Name });
        await db.SaveChangesAsync(ct);
        return ToDto(r);
    }

    /// <summary>Open, Running or Done; Done stamps the completion time.</summary>
    public async Task<TestRunDto> SetRunStatusAsync(Guid id, string? status, CancellationToken ct = default)
    {
        var r = await db.TestRuns.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Test run not found.", "TEST_RUN_NOT_FOUND");
        r.Status = Pick(status, RunStatuses, r.Status, "status");
        if (r.Status == "Running") r.StartedAt ??= clock.Now;
        r.CompletedAt = r.Status == "Done" ? clock.Now : null;
        r.UpdatedAt = clock.Now; r.UpdatedBy = ctx.UserId;
        await db.SaveChangesAsync(ct);
        return ToDto(r);
    }

    // ------------------------------------------------------------------ matrix and results

    /// <summary>Cases by the most recent runs (oldest of them first, as columns), and every result among them.</summary>
    public async Task<TestMatrixDto> MatrixAsync(Guid? projectId, int runs = 4, CancellationToken ct = default)
    {
        runs = Math.Clamp(runs, 1, 12);
        var rq = db.TestRuns.AsNoTracking();
        if (projectId is { } p) rq = rq.Where(r => r.ProjectId == p);
        var recent = (await rq.OrderByDescending(r => r.CreatedAt).Take(runs).ToListAsync(ct)).OrderBy(r => r.CreatedAt).ToList();
        var cases = await ListCasesAsync(projectId, ct);
        var runIds = recent.Select(r => r.Id).ToList();
        var results = runIds.Count == 0 ? new List<TestResult>() : await db.TestResults.AsNoTracking().Where(x => runIds.Contains(x.RunId)).ToListAsync(ct);
        return new TestMatrixDto(recent.Select(ToDto).ToList(), cases, await ToDtosAsync(results, ct));
    }

    /// <summary>Records what a case did in a run (one result per case and run; setting it again replaces it). The run starts running.</summary>
    public async Task<TestResultDto> SetResultAsync(Guid runId, Guid caseId, SetTestResultRequest req, CancellationToken ct = default)
    {
        var run = await db.TestRuns.FirstOrDefaultAsync(x => x.Id == runId, ct) ?? throw new NotFoundException("Test run not found.", "TEST_RUN_NOT_FOUND");
        if (!await db.TestCases.AnyAsync(c => c.Id == caseId, ct)) throw new NotFoundException("Test case not found.", "TEST_CASE_NOT_FOUND");
        var status = Pick(req.Status, ResultStatuses, "", "status");
        if (status.Length == 0) throw new ValidationException("status", "Say how it went: Pass, Fail, Blocked or NotRun.");
        var result = await db.TestResults.FirstOrDefaultAsync(x => x.RunId == runId && x.CaseId == caseId, ct);
        if (result is null)
        {
            result = new TestResult { TenantId = ctx.RequireTenantId(), RunId = runId, CaseId = caseId, CreatedAt = clock.Now, CreatedBy = ctx.UserId };
            db.TestResults.Add(result);
        }
        else { result.UpdatedAt = clock.Now; result.UpdatedBy = ctx.UserId; }
        result.Status = status;
        if (req.Actual is not null) result.Actual = Clean(req.Actual, 2000, "actual");
        if (req.Evidence is not null) result.Evidence = Clean(req.Evidence, 16000, "evidence");
        result.RunById = status == "NotRun" ? null : ctx.UserId;
        result.At = status == "NotRun" ? null : clock.Now;
        if (run.Status == "Open" && status != "NotRun") { run.Status = "Running"; run.StartedAt ??= clock.Now; }
        await db.SaveChangesAsync(ct);
        return (await ToDtosAsync([result], ct))[0];
    }

    /// <summary>
    /// Readiness of a run (the given one, else the latest): pass rate of the cases that were run, and the blockers - failed Critical or High
    /// cases. Ready at <see cref="ReadyPercent"/>% with no blockers.
    /// </summary>
    public async Task<QualityReadinessDto> ReadinessAsync(Guid? runId, Guid? projectId, CancellationToken ct = default)
    {
        TestRun? run;
        if (runId is { } id) run = await db.TestRuns.AsNoTracking().FirstOrDefaultAsync(r => r.Id == id, ct) ?? throw new NotFoundException("Test run not found.", "TEST_RUN_NOT_FOUND");
        else
        {
            var rq = db.TestRuns.AsNoTracking();
            if (projectId is { } p) rq = rq.Where(r => r.ProjectId == p);
            run = await rq.OrderByDescending(r => r.CreatedAt).FirstOrDefaultAsync(ct);
        }
        var cq = db.TestCases.AsNoTracking();
        var scope = run?.ProjectId ?? projectId;
        if (scope is { } sp) cq = cq.Where(c => c.ProjectId == sp);
        var cases = await cq.ToListAsync(ct);
        if (run is null) return new QualityReadinessDto(null, cases.Count, 0, 0, 0, 0, cases.Count, 0, [], false);
        var results = await db.TestResults.AsNoTracking().Where(x => x.RunId == run.Id).ToListAsync(ct);
        int passed = results.Count(r => r.Status == "Pass"), failed = results.Count(r => r.Status == "Fail"), blocked = results.Count(r => r.Status == "Blocked");
        var ran = passed + failed + blocked;
        var pct = ran == 0 ? 0 : (int)Math.Round(passed * 100.0 / ran, MidpointRounding.AwayFromZero);
        var byId = cases.ToDictionary(c => c.Id);
        var blockers = results.Where(r => r.Status == "Fail" && byId.TryGetValue(r.CaseId, out var c) && (c.Priority == "Critical" || c.Priority == "High"))
            .Select(r => byId[r.CaseId]).OrderBy(c => c.Number).Select(c => new QualityBlockerDto(c.Id, c.Key, c.Title, c.Priority)).ToList();
        var notRun = Math.Max(0, cases.Count - ran);
        return new QualityReadinessDto(ToDto(run), cases.Count, ran, passed, failed, blocked, notRun, pct, blockers, ran > 0 && pct >= ReadyPercent && blockers.Count == 0);
    }

    /// <summary>
    /// Files a bug from a result: a ticket ("Bug Fix" work type) on the case's project, carrying the steps, expected, actual and evidence, and
    /// linked to the result. A result that already has its bug returns that one.
    /// </summary>
    public async Task<FiledBugDto> FileBugAsync(Guid resultId, FileBugRequest req, CancellationToken ct = default)
    {
        var result = await db.TestResults.FirstOrDefaultAsync(x => x.Id == resultId, ct) ?? throw new NotFoundException("Test result not found.", "TEST_RESULT_NOT_FOUND");
        if (result.LinkedWorkItemId is { } existing)
            return new FiledBugDto((await ToDtosAsync([result], ct))[0], await work.GetAsync(existing, ct));
        var c = await db.TestCases.AsNoTracking().FirstOrDefaultAsync(x => x.Id == result.CaseId, ct) ?? throw new NotFoundException("Test case not found.", "TEST_CASE_NOT_FOUND");
        var run = await db.TestRuns.AsNoTracking().FirstOrDefaultAsync(x => x.Id == result.RunId, ct) ?? throw new NotFoundException("Test run not found.", "TEST_RUN_NOT_FOUND");
        var types = await workTypes.ListAsync(false, ct);
        var type = types.FirstOrDefault(t => t.Name == "Bug Fix") ?? types.FirstOrDefault() ?? throw new ConflictException("Add a work type first.", "NO_WORK_TYPE");
        var title = Clean(req.Title, 200, "title") ?? $"{c.Key} fails in {run.Name}: {c.Title}";
        if (title.Length > 200) title = title[..200];
        var parts = new List<string> { $"Found by test case {c.Key} in run {run.Name}{(run.Environment is null ? "" : $" ({run.Environment}{(run.Build is null ? "" : $", build {run.Build}")})")}." };
        if (c.Steps is not null) parts.Add($"Steps:\n{c.Steps}");
        if (c.Expected is not null) parts.Add($"Expected: {c.Expected}");
        if (result.Actual is not null) parts.Add($"Actual: {result.Actual}");
        if (result.Evidence is not null) parts.Add($"Evidence:\n{result.Evidence}");
        var description = string.Join("\n\n", parts);
        if (description.Length > 8000) description = description[..8000];
        var priority = Enum.TryParse<Priority>(c.Priority, out var pr) ? pr : Priority.Medium;
        var item = await work.CreateAsync(new CreateWorkItemRequest("ticket", title, description, c.ProjectId ?? run.ProjectId, req.AssigneeId, priority, WorkTypeId: type.Id), ct);
        result.LinkedWorkItemId = item.Id;
        result.UpdatedAt = clock.Now; result.UpdatedBy = ctx.UserId;
        recorder.Audit("quality.bug.filed", "TestResult", result.Id, null, new { CaseKey = c.Key, WorkItemKey = item.Key });
        await db.SaveChangesAsync(ct);
        return new FiledBugDto((await ToDtosAsync([result], ct))[0], item);
    }
}
