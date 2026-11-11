using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Application.Features.Load;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>What choosing the one fix looks like, apart from the database so it can be tested on its own.</summary>
public static class SlipFixPlanner
{
    /// <summary>A forecast must be at least this many days past the promise before Aura speaks up; a day either way is noise.</summary>
    public const int MinSlipDays = 2;

    /// <summary>
    /// Who could take the stage: someone the person may give it to (<paramref name="eligible"/>: active project members), not its current owner,
    /// who fits the work before its date without going over capacity, and who is free or balanced - never stretched, overloaded, on leave or
    /// asked-not-to-be-given-more. The one with the most room wins; ties go to the name that sorts first so the same input always gives the same answer.
    /// </summary>
    public static LoadFitPersonDto? PickAssignee(IEnumerable<LoadFitPersonDto> people, ISet<Guid> eligible, Guid? currentOwner) =>
        people.Where(p => eligible.Contains(p.UserId) && p.UserId != currentOwner && p.Fits && (p.State == LoadMath.Free || p.State == LoadMath.Balanced))
            .OrderByDescending(p => p.FreeMinutes).ThenBy(p => p.Name, StringComparer.Ordinal).FirstOrDefault();

    /// <summary>The reason written on a proposed date move: what the forecast says and why, in plain words. Never empty.</summary>
    public static string DateMoveReason(DateOnly promised, DateOnly forecast, string? why, string confidenceLabel) =>
        $"Aura's forecast is {forecast:d MMM yyyy}, {forecast.DayNumber - promised.DayNumber} days after the promised {promised:d MMM yyyy}"
        + (string.IsNullOrWhiteSpace(why) ? "" : $" ({why})") + $". {confidenceLabel}.";
}

public sealed record ReassignStagePayload(Guid ProjectId, string ProjectKey, Guid StageId, string StageName, Guid? PreviousOwnerId, string? PreviousOwnerName,
    Guid NewOwnerId, string NewOwnerName, Guid? TeamId, bool MoveOpenTasks, int OpenTasks);
public sealed record MoveDatePayload(Guid ProjectId, string ProjectKey, int ExpectedVersion, DateOnly? PreviousDueDate, DateOnly DueDate, string Reason);

/// <summary>
/// Carries out, and undoes, the two fixes the slip-and-fix job proposes. They run only from a card the project owner confirmed (or, for a
/// hand-over, at the workspace's Auto level), as that person and through the same services as the screens, so their rights, the version check, the
/// required reason for a later date and the audit trail all apply. A date move without a reason is refused here whatever the level.
/// </summary>
public class SlipFixActions(ICurrentContext ctx, IAppDbContext db, ProjectService projects, LoadService load)
{
    public const string Reassign = "reassign_stage", MoveDate = "move_promised_date";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static bool Supports(string kind) => kind is Reassign or MoveDate;
    public static string Describe(string kind) => kind == Reassign ? "Gives the stage back to its earlier owner, with the tasks that moved" : "Puts the earlier promised date back";

    private static string? Str(JsonElement a, string n) => a.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    private static Guid? Id(JsonElement a, string n) => Guid.TryParse(Str(a, n), out var g) ? g : null;
    private static Guid Need(JsonElement a, string n) => Id(a, n) ?? throw new ValidationException(n, "The approved suggestion is incomplete. Ask again.");

    /// <summary>Runs one of these cards, or returns null when <paramref name="kind"/> is not one of them.</summary>
    public async Task<AiActionResult?> RunAsync(string kind, JsonElement a, CancellationToken ct)
    {
        switch (kind)
        {
            case Reassign: return await ReassignAsync(a, ct);
            case MoveDate: return await MoveDateAsync(a, ct);
            default: return null;
        }
    }

    private async Task<AiActionResult> ReassignAsync(JsonElement a, CancellationToken ct)
    {
        var tenant = ctx.RequireTenantId();
        var projectId = Need(a, "projectId"); var stageId = Need(a, "stageId"); var newOwner = Need(a, "newOwnerId");
        var previous = Id(a, "previousOwnerId"); var team = Id(a, "teamId");
        if (!await db.TenantMembers.AsNoTracking().AnyAsync(m => m.TenantId == tenant && m.UserId == newOwner && m.Role != TenantRole.Guest && m.Status == MemberStatus.Active && m.User!.IsActive, ct))
            throw new ValidationException("newOwnerId", "That person is suspended or no longer a member, so the stage cannot be given to them.");
        var stage = await db.ProjectStages.AsNoTracking().FirstOrDefaultAsync(s => s.Id == stageId && s.ProjectId == projectId, ct) ?? throw new NotFoundException("Stage not found.");
        if (stage.Status == StageStatus.Completed || stage.OwnerId != previous)
            throw new ConflictException("The stage changed after this suggestion. Review the project and ask Aura again.", "VERSION_CONFLICT");
        var moved = previous is null ? [] : await db.Tasks.AsNoTracking().Where(t => t.ProjectId == projectId && t.StageId == stageId && t.AssigneeId == previous
                && t.Status!.Category != StatusCategory.Done && t.Status!.Category != StatusCategory.Cancelled).Select(t => t.Id).ToListAsync(ct);
        await projects.ReassignStageAsync(projectId, stageId, new ReassignStageRequest(newOwner, team, true), ct);
        if (!await db.ProjectStages.AsNoTracking().AnyAsync(s => s.Id == stageId && s.OwnerId == newOwner, ct))
            throw new ConflictException("The new owner could not be verified. Check the project before retrying.", "AI_ACTION_UNVERIFIED");
        return new AiActionResult($"/projects/{projectId}", stageId, JsonSerializer.Serialize(new { projectId, stageId, previousOwnerId = previous, teamId = team, newOwnerId = newOwner, movedTaskIds = moved }, Json));
    }

    private async Task<AiActionResult> MoveDateAsync(JsonElement a, CancellationToken ct)
    {
        var projectId = Need(a, "projectId");
        var reason = Str(a, "reason")?.Trim();
        // The date moves because someone read why. No reason, no move, at every level.
        if (string.IsNullOrWhiteSpace(reason) || reason.Length < 8) throw new ValidationException("reason", "A date move needs a reason.");
        if (!DateOnly.TryParse(Str(a, "dueDate"), out var due)) throw new ValidationException("dueDate", "The new date is missing.");
        var cur = (await projects.GetAsync(projectId, ct)).Project;
        if (a.TryGetProperty("expectedVersion", out var version) && version.ValueKind == JsonValueKind.Number && version.GetInt32() != cur.Version)
            throw new ConflictException("The project changed after this suggestion. Review its dates and ask Aura again.", "VERSION_CONFLICT");
        if (cur.StageScheduleMode != StageScheduleMode.Manual)
            throw new ConflictException("This project's dates follow its schedule. Change them in Schedule studio.", "SCHEDULE_AUTOMATIC");
        var before = cur.DueDate;
        await projects.UpdateAsync(projectId, new UpdateProjectRequest(cur.Name, cur.Description, cur.Priority, cur.Status, cur.Owner?.Id, cur.TeamId, cur.StartDate, due, cur.Version,
            cur.EnforceDependencies, cur.ProjectGroupId, reason), ct);
        if (!await db.Projects.AsNoTracking().AnyAsync(p => p.Id == projectId && p.DueDate == due, ct))
            throw new ConflictException("The new date could not be verified. Check the project before retrying.", "AI_ACTION_UNVERIFIED");
        return new AiActionResult($"/projects/{projectId}", projectId, JsonSerializer.Serialize(new { projectId, previousDueDate = before, dueDate = due }, Json));
    }

    public async Task UndoAsync(AiProposal p, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(p.UndoJson)) throw new ConflictException("What this change did was not recorded, so it cannot be undone here. Change it back by hand.", "AI_UNDO_UNAVAILABLE");
        using var doc = JsonDocument.Parse(p.UndoJson);
        var u = doc.RootElement;
        var projectId = Need(u, "projectId");
        if (p.Kind == Reassign)
        {
            var stageId = Need(u, "stageId"); var previous = Need(u, "previousOwnerId"); var newOwner = Need(u, "newOwnerId");
            await projects.ReassignStageAsync(projectId, stageId, new ReassignStageRequest(previous, Id(u, "teamId"), false), ct);
            var ids = u.TryGetProperty("movedTaskIds", out var arr) && arr.ValueKind == JsonValueKind.Array ? arr.EnumerateArray().Select(x => x.GetGuid()).ToList() : [];
            // Only what is still the new owner's, open and in that stage goes back: anything they finished or someone moved on stays as it is.
            var back = ids.Count == 0 ? [] : await db.Tasks.AsNoTracking().Where(t => ids.Contains(t.Id) && t.AssigneeId == newOwner
                && t.Status!.Category != StatusCategory.Done && t.Status!.Category != StatusCategory.Cancelled).Select(t => t.Id).ToListAsync(ct);
            if (back.Count > 0) await load.ReassignAsync(new LoadReassignRequest(previous, back.Select(id => new LoadMoveItem("task", id)).ToList()), ct);
            return;
        }
        var cur = (await projects.GetAsync(projectId, ct)).Project;
        if (DateOnly.TryParse(Str(u, "dueDate"), out var moved) && cur.DueDate != moved)
            throw new ConflictException("The date was changed again after this move, so it is not put back automatically.", "VERSION_CONFLICT");
        DateOnly? original = DateOnly.TryParse(Str(u, "previousDueDate"), out var was) ? was : null;
        await projects.UpdateAsync(projectId, new UpdateProjectRequest(cur.Name, cur.Description, cur.Priority, cur.Status, cur.Owner?.Id, cur.TeamId, cur.StartDate, original, cur.Version,
            cur.EnforceDependencies, cur.ProjectGroupId, "Undo of a change made with the assistant"), ct);
    }
}

/// <summary>
/// The slip-and-fix job: for every workspace whose project agent is not Off, finds projects whose forecast finish is later than the promised date
/// and prepares ONE concrete fix as an Aura card for the project owner (see <see cref="SlipFixOwnerRun"/>). It reads in bulk, one owner at a time,
/// as that owner (so tenant and permission scoping are the application's own), is safe to run again at any moment (one card per project per day,
/// fixed ids), and changes nothing by itself apart from a hand-over at the Auto level.
/// </summary>
public class SlipFixService(IAppDbContext db, IServiceScopeFactory scopes, AiAgentGate gate, ILogger<SlipFixService> log)
{
    public const int MaxWorkspaces = 2000, MaxOwners = 300;

    public async Task<int> RunAsync(CancellationToken ct = default)
    {
        var tenants = await db.Tenants.IgnoreQueryFilters().AsNoTracking().Where(t => t.Status == TenantStatus.Active && !t.IsDeleted && !t.AiDisabled)
            .OrderBy(t => t.Id).Select(t => t.Id).Take(MaxWorkspaces).ToListAsync(ct);
        var made = 0;
        foreach (var tenant in tenants)
        {
            try { made += await RunWorkspaceAsync(tenant, ct); }
            catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "Slip-and-fix failed for workspace {Tenant}", tenant); }
        }
        if (made > 0) log.LogInformation("Slip-and-fix: {Count} proposal(s) prepared", made);
        return made;
    }

    public async Task<int> RunWorkspaceAsync(Guid tenant, CancellationToken ct = default)
    {
        var level = await gate.LevelAsync(tenant, AiAgents.Project, ct);
        if (level == AiAgentLevel.Off) return 0;
        var owners = await db.Projects.IgnoreQueryFilters().AsNoTracking()
            .Where(p => p.TenantId == tenant && !p.IsDeleted && p.ArchivedAt == null && (p.Status == ProjectStatus.Active || p.Status == ProjectStatus.Planning))
            .Select(p => p.OwnerId).Distinct().Take(MaxOwners).ToListAsync(ct);
        var made = 0;
        foreach (var owner in owners)
        {
            try
            {
                using var scope = scopes.CreateScope();
                var sp = scope.ServiceProvider;
                await WorkspaceExecutionPrincipal.ConfigureAsync(sp, owner, tenant, null, ct);
                made += await sp.GetRequiredService<SlipFixOwnerRun>().RunAsync(level, ct);
            }
            catch (AppException) { /* the owner is no longer an active member, or the workspace is unavailable: nothing to prepare for them */ }
            catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "Slip-and-fix failed for {User} in {Tenant}", owner, tenant); }
        }
        return made;
    }
}

/// <summary>One project owner's pass, run as that owner in their own scope.</summary>
public class SlipFixOwnerRun(IAppDbContext db, ICurrentContext ctx, AppClock clock, ProjectAccess access, EntitlementService entitlements, LoadService load,
    ForecastCalibrationService calibration, NotificationService notifications, AiAgent agent, AiActionLog actionLog, ILogger<SlipFixOwnerRun> log)
{
    public const int MaxProposals = 5;
    public const string Model = "builtin-slip-fix";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    internal static Guid Key(params object[] parts) => new(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join(":", parts))).AsSpan(0, 16));
    private static string First(string? name) => (name ?? "").Split(' ')[0];

    private sealed record Late(Project Project, ProjectStage Stage, StageForecastResult Forecast, ForecastConfidenceDto Confidence, IReadOnlyList<ForecastOpenTask> Open, DateOnly Promised);

    public async Task<int> RunAsync(AiAgentLevel level, CancellationToken ct)
    {
        var tenant = ctx.RequireTenantId(); var me = ctx.RequireUserId();
        if (await entitlements.GetValueAsync(FeatureKeys.AiAssistant, ct) <= 0) return 0;
        var today = clock.Today; var now = clock.Now;

        // ---- one set of bulk reads for everything this owner leads
        var projects = await db.Projects.AsNoTracking().Where(p => p.OwnerId == me && p.ArchivedAt == null && (p.Status == ProjectStatus.Active || p.Status == ProjectStatus.Planning))
            .OrderBy(p => p.Id).Take(100).ToListAsync(ct);
        if (projects.Count == 0) return 0;
        var ids = projects.Select(p => p.Id).ToList();
        var stagesBy = (await db.ProjectStages.AsNoTracking().Where(s => ids.Contains(s.ProjectId)).OrderBy(s => s.Order).ToListAsync(ct)).GroupBy(s => s.ProjectId).ToDictionary(g => g.Key, g => g.ToList());
        var currentIds = stagesBy.Values.Select(l => l.FirstOrDefault(s => s.Status != StageStatus.Completed)?.Id).Where(i => i != null).Select(i => i!.Value).ToList();
        var openTasks = currentIds.Count == 0 ? [] : await db.Tasks.AsNoTracking().Where(t => t.StageId != null && currentIds.Contains(t.StageId.Value) && t.ParentTaskId == null
                && t.Status!.Category != StatusCategory.Done && t.Status!.Category != StatusCategory.Cancelled)
            .Select(t => new { StageId = t.StageId!.Value, t.AssigneeId, t.EstimatedHours }).ToListAsync(ct);
        var ownerIds = stagesBy.Values.Select(l => l.FirstOrDefault(s => s.Status != StageStatus.Completed)?.OwnerId).Where(i => i != null).Select(i => i!.Value).Distinct().ToList();
        var hoursBy = ownerIds.Count == 0 ? [] : (await db.Tasks.AsNoTracking().Where(t => t.AssigneeId != null && ownerIds.Contains(t.AssigneeId.Value)
                && t.Status!.Category != StatusCategory.Done && t.Status!.Category != StatusCategory.Cancelled).Select(t => new { Id = t.AssigneeId!.Value, t.EstimatedHours }).ToListAsync(ct))
            .GroupBy(x => x.Id).ToDictionary(g => g.Key, g => g.Sum(x => (double)(x.EstimatedHours ?? 4m)));
        var names = ownerIds.Count == 0 ? [] : await db.Users.AsNoTracking().Where(u => ownerIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var since = now.AddDays(-14);
        var scope = (await db.Tasks.AsNoTracking().Where(t => ids.Contains(t.ProjectId) && t.ParentTaskId == null && t.Status!.Category != StatusCategory.Cancelled)
            .GroupBy(t => t.ProjectId).Select(g => new { Id = g.Key, Added = g.Count(t => t.CreatedAt >= since), Open = g.Count(t => t.Status!.Category != StatusCategory.Done) }).ToListAsync(ct))
            .ToDictionary(x => x.Id);
        var cal = await calibration.ForCurrentWorkspaceAsync(ct);

        // ---- the forecast of each project: the same arithmetic as the project page
        var late = new List<Late>(); var snapshots = new List<(Project Project, DateOnly? Promised, StageForecastResult F, ForecastConfidenceDto C, int Open)>();
        foreach (var p in projects)
        {
            if (!stagesBy.TryGetValue(p.Id, out var stages) || stages.Count == 0) continue;
            var promised = p.DueDate ?? stages.LastOrDefault(s => s.PlannedEnd != null)?.PlannedEnd;
            var rows = stages.Select(s => new ForecastStage(s.Id, s.Name, s.Status, s.PlannedStart, s.PlannedEnd, s.ActualEnd, s.OwnerId)).ToList();
            var index = rows.FindIndex(s => s.Status != StageStatus.Completed);
            if (index < 0) continue;
            var current = stages[index];
            var open = openTasks.Where(t => t.StageId == current.Id).Select(t => new ForecastOpenTask(t.AssigneeId, (double)(t.EstimatedHours ?? 4m))).ToList();
            var hours = current.OwnerId is { } o ? hoursBy.GetValueOrDefault(o) : 0;
            var f = StageForecastMath.Compute(today, promised, p.Status, rows, open, hours, current.OwnerId is { } o2 ? First(names.GetValueOrDefault(o2)) : null);
            var sc = scope.GetValueOrDefault(p.Id);
            int? load0 = f.OwnerCapacityHours > 0 && current.OwnerId != null ? (int)Math.Round(hours / f.OwnerCapacityHours * 100) : null;
            var conf = ForecastConfidence.Compute(f.Forecast, new ForecastEvidence(f.FinishedStages, f.AverageStageSlipDays, f.Overload > 0, load0, sc?.Added ?? 0, sc?.Open ?? 0), cal);
            snapshots.Add((p, promised, f, conf, sc?.Open ?? 0));
            if (promised is { } pd && f.Slip >= SlipFixPlanner.MinSlipDays && f.Forecast is not null) late.Add(new Late(p, current, f, conf, open, pd));
        }
        RecordSnapshots(tenant, me, today, now, snapshots, await ExistingSnapshotsAsync(tenant, today, ids, ct));

        // ---- one card per project that is late, most late first; skipped when one was made lately or the owner waved it away
        var made = 0;
        if (late.Count > 0)
        {
            var recent = await db.AiMessages.AsNoTracking().Where(m => m.UserId == me && m.Model == Model && m.Role == "assistant" && m.CreatedAt >= now.AddDays(-7))
                .Select(m => new { m.CreatedAt, m.ActionsJson }).ToListAsync(ct);
            foreach (var l in late.OrderByDescending(x => x.Forecast.Slip).ThenBy(x => x.Project.Id).Take(MaxProposals))
            {
                var pid = l.Project.Id.ToString();
                if (recent.Any(r => r.ActionsJson != null && r.ActionsJson.Contains(pid) && (r.CreatedAt >= now.AddHours(-24) || r.ActionsJson.Contains("\"status\":\"dismissed\"")))) continue;
                try { await access.RequireProjectEditAsync(l.Project, ct); }
                catch (ForbiddenException) { continue; }   // a view-only owner is not asked to change anything
                if (await PrepareAsync(l, level, today, now, ct)) made++;
            }
        }
        await db.SaveChangesAsync(ct);
        return made;
    }

    // ------------------------------------------------------------------ what is recorded so the scoreboard can be honest later

    private async Task<HashSet<Guid>> ExistingSnapshotsAsync(Guid tenant, DateOnly today, List<Guid> ids, CancellationToken ct)
    {
        var job = Key("stage-forecast", tenant.ToString("N"), today.DayNumber / 7);
        return (await db.AiForecastSnapshots.AsNoTracking().Where(f => f.JobId == job && ids.Contains(f.ProjectId)).Select(f => f.ProjectId).ToListAsync(ct)).ToHashSet();
    }

    /// <summary>One forecast per active project per week (the project page's own forecast), so later completions can be checked against what was said.</summary>
    private void RecordSnapshots(Guid tenant, Guid me, DateOnly today, DateTime now, List<(Project Project, DateOnly? Promised, StageForecastResult F, ForecastConfidenceDto C, int Open)> rows, HashSet<Guid> have)
    {
        var job = Key("stage-forecast", tenant.ToString("N"), today.DayNumber / 7);
        foreach (var r in rows.Where(r => r.F.Forecast != null && !have.Contains(r.Project.Id)))
            db.AiForecastSnapshots.Add(new AiForecastSnapshot
            {
                TenantId = tenant, UserId = me, JobId = job, ProjectId = r.Project.Id, EvidenceAt = now, AsOf = today, DueDate = r.Promised, ProjectedFinish = r.F.Forecast,
                ProjectVersion = r.Project.Version, OpenTasks = r.Open, InputComplete = true, Confidence = r.C.Band, MethodologyVersion = ForecastScoring.Method,
            });
    }

    // ------------------------------------------------------------------ the one fix

    private async Task<bool> PrepareAsync(Late l, AiAgentLevel level, DateOnly today, DateTime now, CancellationToken ct)
    {
        var tenant = ctx.RequireTenantId(); var me = ctx.RequireUserId();
        var p = l.Project; var forecast = l.Forecast.Forecast!.Value;
        var messageId = Key("slip-fix", tenant.ToString("N"), me.ToString("N"), p.Id.ToString("N"), today.DayNumber);
        if (await db.AiMessages.IgnoreQueryFilters().AnyAsync(m => m.Id == messageId, ct)) return false;   // already made today: running again changes nothing

        AiProposal? card = null; string? story = null; var autoRun = false;
        // 1. The stage owner is the bottleneck and a teammate has room: hand the stage over.
        if (l.Stage.OwnerId is { } currentOwner && l.Forecast.Overload > 0)
        {
            var members = await db.ProjectMembers.AsNoTracking().Where(m => m.ProjectId == p.Id).Select(m => m.UserId).ToListAsync(ct);
            var active = members.Count == 0 ? [] : await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tenant && members.Contains(m.UserId) && m.Role != TenantRole.Guest
                && m.Status == MemberStatus.Active && m.User!.IsActive).Select(m => m.UserId).ToListAsync(ct);
            if (active.Count > 0)
            {
                var mine = l.Open.Where(t => t.AssigneeId == currentOwner).Sum(t => t.Hours);
                var minutes = (int)Math.Clamp((mine > 0 ? mine : l.Open.Sum(t => t.Hours)) * 60, 60, 2400);
                LoadFitDto? fit = null;
                try { fit = await load.FitAsync(today, l.Stage.PlannedEnd ?? l.Promised, minutes, null, currentOwner, ct); }
                catch (AppException) { /* the owner has no view of anyone's load: fall through to the date */ }
                if (fit is not null && SlipFixPlanner.PickAssignee(fit.People, active.ToHashSet(), currentOwner) is { } pick)
                {
                    var previousName = await db.Users.AsNoTracking().Where(u => u.Id == currentOwner).Select(u => u.DisplayName).FirstOrDefaultAsync(ct);
                    var payload = new ReassignStagePayload(p.Id, p.Key, l.Stage.Id, l.Stage.Name, currentOwner, previousName, pick.UserId, pick.Name, l.Stage.OwnerTeamId, true,
                        l.Open.Count(t => t.AssigneeId == currentOwner));
                    var expected = l.Promised.AddDays(Math.Max(0, l.Forecast.Slip - l.Forecast.Overload));
                    card = new AiProposal(messageId.ToString("N")[..8], SlipFixActions.Reassign, $"Give {l.Stage.Name} on {p.Key} to {First(pick.Name)}",
                        $"{payload.OpenTasks} open task{(payload.OpenTasks == 1 ? "" : "s")} move with it · {First(pick.Name)} has the most room ({pick.Reason}) · finish back to about {expected:d MMM}",
                        JsonSerializer.Serialize(payload, Json), Link: $"/projects/{p.Id}", Preview: string.Join("\n", l.Confidence.Evidence));
                    story = $"{p.Key} {p.Name} is likely to finish {forecast:d MMM}, {l.Forecast.Slip} days after the {l.Promised:d MMM} you promised. {First(previousName)} has more open work than fits before {l.Stage.Name} is due. "
                        + $"{pick.Name} has the most room ({pick.Reason}). Giving {l.Stage.Name} to {First(pick.Name)} removes that overload and should bring the finish back to about {expected:d MMM}. {l.Confidence.Label}. Nothing changes until you confirm.";
                    autoRun = level == AiAgentLevel.Auto;
                }
            }
        }
        // 2. Otherwise tell the truth about the date: a proposed move, with the reason written out. A date move never runs without a person confirming it.
        if (card is null && p.DueDate is { } due && p.StageScheduleMode == StageScheduleMode.Manual && forecast > due)
        {
            var reason = SlipFixPlanner.DateMoveReason(due, forecast, l.Forecast.Reason, l.Confidence.Label);
            var payload = new MoveDatePayload(p.Id, p.Key, p.Version, due, forecast, reason);
            card = new AiProposal(messageId.ToString("N")[..8], SlipFixActions.MoveDate, $"Move {p.Key} to {forecast:d MMM}",
                $"Promised {due:d MMM} → {forecast:d MMM} · reason on record: {reason}", JsonSerializer.Serialize(payload, Json), Link: $"/projects/{p.Id}", Preview: string.Join("\n", l.Confidence.Evidence));
            story = $"{p.Key} {p.Name} is likely to finish {forecast:d MMM}, {l.Forecast.Slip} days after the {due:d MMM} you promised, and no teammate has the room to take the work. "
                + $"If the date cannot hold, tell the client now: I can move it to {forecast:d MMM} with this reason on record: {reason} Nothing changes until you confirm.";
        }
        if (card is null || story is null) return false;

        var bound = AiActionPlan.Bind(card, messageId, tenant, me, now, []);
        var conversation = Key("slip-fix-chat", tenant.ToString("N"), me.ToString("N"));
        var chat = await db.AiConversations.IgnoreQueryFilters().FirstOrDefaultAsync(c => c.Id == conversation, ct);
        if (chat is null) { chat = new AiConversation { Id = conversation, TenantId = tenant, UserId = me, Title = "Aura heads-up" }; db.AiConversations.Add(chat); }
        else if (chat.IsDeleted) { chat.IsDeleted = false; chat.DeletedAt = null; chat.DeletedBy = null; chat.Title = "Aura heads-up"; }
        chat.LastMessageAt = now;
        db.AiMessages.Add(new AiMessage
        {
            Id = messageId, TenantId = tenant, ConversationId = conversation, UserId = me, Role = "assistant", Content = story, Model = Model, Status = "complete",
            ActionsJson = JsonSerializer.Serialize(new List<AiProposal> { bound }, Json), CreatedAt = now,
        });

        // The notice: one a week per project, with a one-tap confirm (Ask first), or plain when the hand-over is done on its own (Auto).
        var key = $"slipfix:{tenant:N}:{p.Id:N}:{today.DayNumber / 7}";
        if (level >= AiAgentLevel.AskFirst && !await db.Notifications.AnyAsync(n => n.DedupeKey == key && n.UserId == me, ct))
            await notifications.AddAsync(me, NotificationType.Overdue, $"{p.Key} is likely to miss {l.Promised:d MMM}", $"{card.Title}. {l.Confidence.Label}.",
                autoRun ? $"/projects/{p.Id}" : $"/projects/{p.Id}?fix={messageId:D}.{card.Id}", key, toSelf: true, ct: ct);
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException ex)
        {
            AgentDb.ClearTracking(db);
            log.LogDebug(ex, "Slip-and-fix card for {Project} was made by another run", p.Id);   // the fixed id: the other run's card stands
            return false;
        }

        if (autoRun)
        {
            // Auto: the hand-over runs exactly as a confirmed card would (rights, binding, undo window) and is logged as the agent's own.
            try
            {
                var done = await agent.ConfirmAsync(messageId, card.Id, ct);
                if (done.Status == "done")
                {
                    actionLog.Applied(AiAgents.Project, SlipFixActions.Reassign, new AiActionLog.Target("project", p.Id, p.Key, p.Id, $"/projects/{p.Id}"), card.Title, approvedBy: null);
                    await db.SaveChangesAsync(ct);
                }
            }
            catch (AppException) { /* it stays a card for the owner to confirm */ }
        }
        return true;
    }
}
