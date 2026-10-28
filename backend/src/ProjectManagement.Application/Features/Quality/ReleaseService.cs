using System.Globalization;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Quality;

public record ReleaseDto(Guid Id, string Name, Guid? ProjectId, string? ProjectName, DateOnly? TargetDate, string Status, string? Notes, int Items, int Runs,
    UserRefDto? ApprovedBy, DateTime? ApprovedAt, DateTime? ShippedAt, DateTime CreatedAt, Guid? NotesDocumentId = null, string? NotesDocumentKey = null);
public record ReleaseItemDto(Guid Id, string Kind, string Key, string Title, string Status, StatusCategory Category, UserRefDto? Assignee, DateOnly? DueDate, bool Bug);
public record ReleaseCheckDto(string Key, string Label, bool Ok, string Detail);
public record ReleaseGoNoGoDto(ReleaseDto Release, IReadOnlyList<ReleaseItemDto> Items, IReadOnlyList<TestRunDto> Runs, QualityReadinessDto? Tests,
    int Done, int Open, int OpenBugs, IReadOnlyList<ReleaseCheckDto> Checks, bool Go, bool CanApprove,
    IReadOnlyList<ReleaseSignOffDto>? SignOffs = null, ReleaseTestGridDto? Grid = null, ReleaseDto? Previous = null, ReleaseForecastDto? Forecast = null);
public record ReleaseSignOffDto(Guid Id, UserRefDto User, string Role, string Status, string? Note, DateTime? SignedAt, DateTime? RemindedAt);
public record ReleaseGridCellDto(string Environment, int Passed, int Total, bool Running);
public record ReleaseGridRowDto(string Suite, IReadOnlyList<ReleaseGridCellDto> Cells);
/// <summary>Suites (a case's first tag) × environments (a run's environment): the latest run per environment, passed of results.</summary>
public record ReleaseTestGridDto(IReadOnlyList<string> Environments, IReadOnlyList<ReleaseGridRowDto> Rows);
/// <summary>When the open bugs should close at the recent close rate (bugs closed in the last 14 days); null date when nothing closed lately.</summary>
public record ReleaseForecastDto(int OpenBlockers, double ClosedPerDay, DateOnly? BlockersClearBy);
public record SignOffPerson(Guid UserId, string? Role);
public record SetSignOffsRequest(IReadOnlyList<SignOffPerson>? People);
public record SignRequest(bool Signed = true, string? Note = null);
public record UpsertReleaseRequest(string? Name, Guid? ProjectId = null, DateOnly? TargetDate = null, string? Notes = null);
public record ReleaseItemsRequest(IReadOnlyList<Guid>? Add = null, IReadOnlyList<Guid>? Remove = null);

/// <summary>
/// Releases: the work going out together, the test runs that check it, and one go/no-go. Go needs every item done, no open bug among the
/// items or filed from the release's test runs, and the latest run ready (Quality's pass rate with no blockers). Approving records who
/// and when; it can be approved against a "no go" only with a reason, which is kept in the notes. Shipped closes it.
/// </summary>
public class ReleaseService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, WorkItemApiService work, QualityService quality,
    NotificationService notifications, DocumentService documents)
{
    /// <summary>The tag on the Library document holding a release's notes (written when it ships), so the release can link to it.</summary>
    public static string NotesTag(Guid releaseId) => $"release/{releaseId:N}";
    public const int MaxItems = 150;
    public const int MaxSignOffs = 20;

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
        var tags = rows.Where(r => r.Status == "Shipped").Select(r => NotesTag(r.Id)).ToList();
        var notes = tags.Count == 0 ? [] : await (from t in db.DocumentTags.AsNoTracking()
                                                  join d in db.Documents.AsNoTracking() on t.DocumentId equals d.Id
                                                  where tags.Contains(t.Tag)
                                                  orderby d.CreatedAt
                                                  select new { t.Tag, d.Id, d.Number }).ToListAsync(ct);
        var noteBy = notes.GroupBy(n => n.Tag).ToDictionary(g => g.Key, g => g.First());
        return rows.Select(r => new ReleaseDto(r.Id, r.Name, r.ProjectId, r.ProjectId is { } p ? projects.GetValueOrDefault(p) : null, r.TargetDate, r.Status, r.Notes,
            items.GetValueOrDefault(r.Id), runs.GetValueOrDefault(r.Id), r.ApprovedById is { } a && users.TryGetValue(a, out var n) ? new UserRefDto(a, n) : null,
            r.ApprovedAt, r.ShippedAt, r.CreatedAt,
            noteBy.TryGetValue(NotesTag(r.Id), out var doc) ? doc.Id : null, noteBy.TryGetValue(NotesTag(r.Id), out var doc2) ? DocumentService.KeyOf(doc2.Number) : null)).ToList();
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
        var signOffs = await SignOffsAsync(id, ct);
        if (signOffs.Count > 0)
        {
            var pending = signOffs.Count(x => x.Status != "Signed");
            var declined = signOffs.Count(x => x.Status == "Declined");
            checks.Add(new("signoffs", "Signed off", pending == 0, pending == 0 ? $"All {signOffs.Count} people signed off."
                : declined > 0 ? $"{declined} declined, {pending - declined} pending of {signOffs.Count}." : $"{pending} of {signOffs.Count} sign-off{(signOffs.Count == 1 ? "" : "s")} pending."));
        }
        var go = checks.All(c => c.Ok);
        var grid = await GridAsync(runs, ct);
        var prevRow = await db.Releases.AsNoTracking().Where(x => x.Id != id && x.ProjectId == r.ProjectId && x.Status == "Shipped").OrderByDescending(x => x.ShippedAt).FirstOrDefaultAsync(ct);
        var previous = prevRow is null ? null : (await ToDtosAsync([prevRow], ct))[0];
        var forecast = await ForecastAsync(r.ProjectId, openBugs, ct);
        return new ReleaseGoNoGoDto((await ToDtosAsync([r], ct))[0], items, runs.Select(QualityService.ToDto).ToList(), tests, done, open, openBugs, checks, go, r.Status == "Planned",
            signOffs, grid, previous, forecast);
    }

    private async Task<List<ReleaseSignOffDto>> SignOffsAsync(Guid id, CancellationToken ct)
    {
        var rows = await db.ReleaseSignOffs.AsNoTracking().Where(x => x.ReleaseId == id).OrderBy(x => x.CreatedAt).ToListAsync(ct);
        var uids = rows.Select(x => x.UserId).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => uids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return rows.Select(x => new ReleaseSignOffDto(x.Id, new UserRefDto(x.UserId, names.GetValueOrDefault(x.UserId) ?? "Former member"), x.Role, x.Status, x.Note, x.SignedAt, x.RemindedAt)).ToList();
    }

    private async Task<ReleaseTestGridDto> GridAsync(List<TestRun> runs, CancellationToken ct)
    {
        // The latest run per environment (runs are ordered oldest first).
        var latest = runs.GroupBy(x => string.IsNullOrWhiteSpace(x.Environment) ? "Other" : x.Environment!.Trim()).Select(g => (Env: g.Key, Run: g.Last())).ToList();
        if (latest.Count == 0) return new ReleaseTestGridDto([], []);
        var runIds = latest.Select(x => x.Run.Id).ToList();
        var results = await db.TestResults.AsNoTracking().Where(x => runIds.Contains(x.RunId)).Select(x => new { x.RunId, x.CaseId, x.Status }).ToListAsync(ct);
        var caseIds = results.Select(x => x.CaseId).Distinct().ToList();
        var tags = await db.TestCases.AsNoTracking().Where(c => caseIds.Contains(c.Id)).ToDictionaryAsync(c => c.Id, c => c.Tags, ct);
        string Suite(Guid c) => tags.GetValueOrDefault(c)?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault() ?? "General";
        var suites = results.Select(x => Suite(x.CaseId)).Distinct().OrderBy(x => x).Take(30).ToList();
        var rows = suites.Select(s => new ReleaseGridRowDto(s, latest.Select(l =>
        {
            var mine = results.Where(x => x.RunId == l.Run.Id && Suite(x.CaseId) == s).ToList();
            return new ReleaseGridCellDto(l.Env, mine.Count(x => x.Status == "Pass"), mine.Count, l.Run.Status == "Running");
        }).ToList())).ToList();
        return new ReleaseTestGridDto(latest.Select(x => x.Env).ToList(), rows);
    }

    private async Task<ReleaseForecastDto> ForecastAsync(Guid? projectId, int openBugs, CancellationToken ct)
    {
        var since = clock.Now.AddDays(-14);
        var q = db.WorkItems.AsNoTracking().OfType<StageIssue>().Where(w => w.CompletedAt != null && w.CompletedAt >= since);
        if (projectId is { } p) q = q.Where(w => w.ScopeProjectId == p);
        var closed = await q.CountAsync(ct);
        var perDay = Math.Round(closed / 14.0, 2);
        DateOnly? by = openBugs == 0 ? DateOnly.FromDateTime(clock.Now) : closed == 0 ? null : DateOnly.FromDateTime(clock.Now).AddDays((int)Math.Ceiling(openBugs / (closed / 14.0)));
        return new ReleaseForecastDto(openBugs, perDay, by);
    }

    /// <summary>Sets who signs off and in which role. People kept keep their state (a changed role resets it to Pending); people removed go.</summary>
    public async Task<ReleaseGoNoGoDto> SetSignOffsAsync(Guid id, SetSignOffsRequest req, CancellationToken ct = default)
    {
        var r = await FindAsync(id, ct);
        if (r.Status == "Shipped") throw new ConflictException("This release has shipped. Start a new one.", "RELEASE_SHIPPED");
        var people = (req.People ?? []).GroupBy(p => p.UserId).Select(g => g.Last()).ToList();
        if (people.Count > MaxSignOffs) throw new ValidationException("people", $"Ask at most {MaxSignOffs} people to sign off.");
        var tid = ctx.RequireTenantId();
        var existing = await db.ReleaseSignOffs.Where(x => x.ReleaseId == id).ToListAsync(ct);
        foreach (var gone in existing.Where(e => people.All(p => p.UserId != e.UserId))) db.ReleaseSignOffs.Remove(gone);
        foreach (var p in people)
        {
            var role = Clean(p.Role, 60, "role") ?? throw new ValidationException("role", "Give each person the role they sign off for, such as QA or Product.");
            if (!await db.TenantMembers.AnyAsync(m => m.TenantId == tid && m.UserId == p.UserId, ct)) throw new ValidationException("userId", "That person is not in this workspace.");
            var row = existing.FirstOrDefault(e => e.UserId == p.UserId);
            if (row is null)
                db.ReleaseSignOffs.Add(new ReleaseSignOff { TenantId = tid, ReleaseId = id, UserId = p.UserId, Role = role, Status = "Pending", CreatedAt = clock.Now, CreatedBy = ctx.UserId });
            else if (row.Role != role) { row.Role = role; row.Status = "Pending"; row.SignedAt = null; row.Note = null; row.UpdatedAt = clock.Now; row.UpdatedBy = ctx.UserId; }
        }
        recorder.Audit("release.signoffs_set", "Release", id, null, new { people = people.Select(p => new { p.UserId, p.Role }) });
        await db.SaveChangesAsync(ct);
        return await GoNoGoAsync(id, ct);
    }

    /// <summary>The caller signs (or declines, which needs a note) their own sign-off on the release.</summary>
    public async Task<ReleaseGoNoGoDto> SignAsync(Guid id, SignRequest req, CancellationToken ct = default)
    {
        var r = await FindAsync(id, ct);
        if (r.Status == "Shipped") throw new ConflictException("This release has shipped. Start a new one.", "RELEASE_SHIPPED");
        var me = ctx.RequireUserId();
        var row = await db.ReleaseSignOffs.FirstOrDefaultAsync(x => x.ReleaseId == id && x.UserId == me, ct)
            ?? throw new ForbiddenException("You are not asked to sign off this release.", "SIGNOFF_NOT_ASKED");
        var note = Clean(req.Note, 500, "note");
        if (!req.Signed && note is null) throw new ValidationException("note", "Say why you are declining.");
        row.Status = req.Signed ? "Signed" : "Declined"; row.Note = note; row.SignedAt = clock.Now; row.UpdatedAt = clock.Now; row.UpdatedBy = me;
        recorder.Audit(req.Signed ? "release.signed" : "release.signoff_declined", "Release", id, null, new { r.Name, row.Role, note });
        await db.SaveChangesAsync(ct);
        return await GoNoGoAsync(id, ct);
    }

    /// <summary>Nudges everyone still pending (a notification each); returns how many were reminded with the new state.</summary>
    public async Task<ReleaseGoNoGoDto> RemindAsync(Guid id, CancellationToken ct = default)
    {
        var r = await FindAsync(id, ct);
        var pending = await db.ReleaseSignOffs.Where(x => x.ReleaseId == id && x.Status == "Pending").ToListAsync(ct);
        if (pending.Count == 0) throw new ConflictException("Nobody is waiting to sign off.", "SIGNOFF_NONE_PENDING");
        foreach (var p in pending)
        {
            await notifications.AddAsync(p.UserId, NotificationType.Approval, $"Sign off release {r.Name}", $"You are asked to sign off as {p.Role}{(r.TargetDate is { } d ? $" · target {d:dd MMM}" : "")}.",
                "/quality", $"release-signoff:{id:N}:{clock.Now:yyyyMMddHH}", ct: ct);
            p.RemindedAt = clock.Now;
        }
        recorder.Audit("release.signoffs_reminded", "Release", id, null, new { r.Name, count = pending.Count });
        await db.SaveChangesAsync(ct);
        return await GoNoGoAsync(id, ct);
    }

    /// <summary>Approves the release. Against a "no go" it needs a reason, which is added to the notes with who decided.</summary>
    public async Task<ReleaseGoNoGoDto> ApproveAsync(Guid id, string? reason, CancellationToken ct = default)
    {
        var state = await GoNoGoAsync(id, ct);
        var r = await FindAsync(id, ct);
        if (r.Status != "Planned") throw new ConflictException("This release is already approved.", "RELEASE_APPROVED");
        var why = Clean(reason, 500, "reason");
        if (!state.Go && why is null) throw new ValidationException("reason", (state.SignOffs ?? []).Any(x => x.Status != "Signed") && state.Checks.Where(c => c.Key != "signoffs").All(c => c.Ok)
            ? "Not everyone has signed off. Wait for the sign-offs or give the reason for going anyway." : "The checks say no go. Give the reason for going anyway.");
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
        var state = await GoNoGoAsync(id, ct);
        await WriteNotesAsync(r, state, ct);
        return await GoNoGoAsync(id, ct);
    }

    /// <summary>
    /// Release notes, written when a release ships: a "Release documentation" draft in the Library under the release's project, with what
    /// shipped grouped into new work and fixes (bugs). Tagged with <see cref="NotesTag"/> so the release links to it. Shipping never fails
    /// because of it: someone who may not write documents (or a workspace at its document limit) ships without notes.
    /// </summary>
    private async Task WriteNotesAsync(Release r, ReleaseGoNoGoDto state, CancellationToken ct)
    {
        var tag = NotesTag(r.Id);
        if (await db.DocumentTags.AnyAsync(t => t.Tag == tag, ct)) return;
        bool Shipped(ReleaseItemDto i) => i.Category == StatusCategory.Done;
        var shipped = state.Items.Where(Shipped).ToList();
        var fixes = shipped.Where(i => i.Bug).ToList();
        var features = shipped.Where(i => !i.Bug).ToList();
        var left = state.Items.Where(i => i.Category is not (StatusCategory.Done or StatusCategory.Cancelled)).ToList();
        JsonObject Text(string s, string? mark = null) => mark is null ? new() { ["type"] = "text", ["text"] = s }
            : new() { ["type"] = "text", ["text"] = s, ["marks"] = new JsonArray(new JsonObject { ["type"] = mark }) };
        JsonObject Para(params JsonNode[] parts) => new() { ["type"] = "paragraph", ["content"] = new JsonArray(parts) };
        JsonObject Heading(string s) => new() { ["type"] = "heading", ["attrs"] = new JsonObject { ["level"] = 3 }, ["content"] = new JsonArray(Text(s)) };
        JsonObject Bullets(IEnumerable<ReleaseItemDto> items) => new()
        {
            ["type"] = "bulletList",
            ["content"] = new JsonArray(items.Select(i => (JsonNode)new JsonObject { ["type"] = "listItem", ["content"] = new JsonArray(Para(Text($"{i.Key} ", "bold"), Text(i.Title))) }).ToArray()),
        };
        string Doc(JsonArray content) => new JsonObject { ["type"] = "doc", ["content"] = content }.ToJsonString();
        var when = (r.ShippedAt ?? clock.Now).ToString("d MMM yyyy", CultureInfo.InvariantCulture);
        var summary = new JsonArray(Para(Text($"{r.Name} shipped on {when}: {features.Count} new item{(features.Count == 1 ? "" : "s")} and {fixes.Count} fix{(fixes.Count == 1 ? "" : "es")}.")));
        if (state.Tests is { Run: { } run } tests) summary.Add(Para(Text($"Tested in {run.Name}: {tests.PassPercent}% passed.")));
        summary.Add(Para(Text("Written from the release's shipped work. Check it, then publish to share it.", "italic")));
        var changes = new JsonArray();
        if (features.Count > 0) { changes.Add(Heading("New")); changes.Add(Bullets(features)); }
        if (fixes.Count > 0) { changes.Add(Heading("Fixes")); changes.Add(Bullets(fixes)); }
        if (shipped.Count == 0) changes.Add(Para(Text("No finished work was linked to this release.")));
        var known = new JsonArray();
        if (left.Count > 0) known.Add(Bullets(left));
        try
        {
            await documents.EnsureTypesAsync(ct);
            var type = await db.DocumentTypes.AsNoTracking().Where(t => t.Code == "RELEASE" && t.IsActive).Select(t => t.Id).FirstOrDefaultAsync(ct);
            if (type == Guid.Empty) return;
            var sections = new List<SectionInput> { new("summary", Doc(summary)), new("changes", Doc(changes)) };
            if (known.Count > 0) sections.Add(new SectionInput("knownIssues", Doc(known)));
            var created = await documents.CreateAsync(new CreateDocumentRequest($"Release notes – {r.Name}", type, r.ProjectId, Tags: [tag, "release notes"],
                Sections: sections, Icon: "🚀"), ct);
            recorder.Audit("release.notes_written", "Release", r.Id, null, new { r.Name, document = created.Item.Key });
            await db.SaveChangesAsync(ct);
        }
        catch (AppException) { /* no right to write documents here, or at the plan's limit: the release still ships */ }
    }
}
