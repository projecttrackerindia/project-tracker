using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Insights;

// ============================================================================================================ Ask anything, with evidence

public record AuraAskRequest(string? Question, Guid? TaskId);
/// <summary>The answer, the item it is about, and every record it was built from (each with a link), newest reasons first.</summary>
public record AuraAnswerDto(string Question, string Answer, bool Ai, string? Subject, string? SubjectHref, IReadOnlyList<AuraEvidenceDto> Evidence,
    IReadOnlyList<string> Suggestions);

/// <summary>
/// "Why is X late?": finds the item (a key such as ABC-12, else the open task whose title matches best, within the caller's reach), then walks
/// what the plan knows - how late it is, every move of its date with the reason given, what it waits on (and whether that slipped), what its
/// owner has overdue, its latest activity and comments - and answers in a few sentences that cite those records. The model may shorten the
/// answer; the facts and the evidence list are always the rules' own, so the answer works without AI keys.
/// </summary>
public partial class AuraWhyService(IAppDbContext db, AppClock clock, DocumentAiService ai, ProjectService projects)
{
    [GeneratedRegex(@"\b([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})\b")] private static partial Regex KeyPattern();
    private static readonly HashSet<string> Stop = new(StringComparer.OrdinalIgnoreCase)
        { "why", "is", "the", "late", "what", "when", "will", "behind", "slipping", "delayed", "this", "that", "task", "with", "about", "going", "does", "status", "how", "and", "for" };

    private static string D(DateOnly? d) => AuraBriefingRules.D(d);

    /// <param name="polish">False when the caller is itself a model (the Aura chat's why_late tool): the rules' facts come back unshortened.</param>
    public async Task<AuraAnswerDto> AskAsync(AuraAskRequest req, CancellationToken ct = default, bool polish = true)
    {
        var question = (req.Question ?? "").Trim();
        if (question.Length == 0 && req.TaskId is null) throw new ValidationException("question", "Ask about a task, for example “Why is ABC-12 late?”.");
        if (question.Length > 500) throw new ValidationException("question", "Keep the question under 500 characters.");
        var taskId = req.TaskId ?? await ResolveAsync(question, ct);
        if (taskId is null)
        {
            var late = await (from t in db.Tasks.AsNoTracking()
                              join s in db.WorkflowStatuses.AsNoTracking() on t.StatusId equals s.Id
                              join p in db.Projects.AsNoTracking() on t.ProjectId equals p.Id
                              where t.DueDate != null && t.DueDate < clock.Today && s.Category != StatusCategory.Done && s.Category != StatusCategory.Cancelled
                              orderby t.DueDate
                              select new { p.Key, t.Number }).Take(3).ToListAsync(ct);
            return new AuraAnswerDto(question, "I could not tell which item you mean. Name it by its key, like ABC-12, or by its title.", false, null, null, [],
                late.Select(l => $"Why is {l.Key}-{l.Number} late?").ToList());
        }
        return await ExplainAsync(question, taskId.Value, ct, polish);
    }

    /// <summary>The task the question is about: by key, else the open task whose title shares the most words with it. Only tasks the caller can open.</summary>
    private async Task<Guid?> ResolveAsync(string question, CancellationToken ct)
    {
        if (KeyPattern().Match(question) is { Success: true } m)
        {
            var key = m.Groups[1].Value.ToUpperInvariant();
            var number = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
            var hit = await (from t in db.Tasks.AsNoTracking()
                             join p in db.Projects.AsNoTracking() on t.ProjectId equals p.Id
                             where p.Key.ToUpper() == key && t.Number == number
                             select (Guid?)t.Id).FirstOrDefaultAsync(ct);
            if (hit is not null) return hit;
        }
        var words = Regex.Split(question.ToLowerInvariant(), @"[^\p{L}\p{N}]+").Where(w => w.Length >= 3 && !Stop.Contains(w)).Distinct().Take(6).ToList();
        if (words.Count == 0) return null;
        var lead = words.OrderByDescending(w => w.Length).First();
        var rows = await (from t in db.Tasks.AsNoTracking()
                          join s in db.WorkflowStatuses.AsNoTracking() on t.StatusId equals s.Id
                          where t.Title.ToLower().Contains(lead) && s.Category != StatusCategory.Cancelled
                          orderby t.CreatedAt descending
                          select new { t.Id, t.Title, Done = s.Category == StatusCategory.Done }).Take(50).ToListAsync(ct);
        return rows.Select(r => new { r.Id, Score = words.Count(w => r.Title.Contains(w, StringComparison.OrdinalIgnoreCase)) * 2 + (r.Done ? 0 : 1) })
            .OrderByDescending(r => r.Score).Select(r => (Guid?)r.Id).FirstOrDefault();
    }

    private async Task<AuraAnswerDto> ExplainAsync(string question, Guid taskId, CancellationToken ct, bool polish)
    {
        var today = clock.Today;
        var t = await (from x in db.Tasks.AsNoTracking()
                       join s in db.WorkflowStatuses.AsNoTracking() on x.StatusId equals s.Id
                       join p in db.Projects.AsNoTracking() on x.ProjectId equals p.Id
                       where x.Id == taskId
                       select new { x.Id, x.Number, x.Title, x.DueDate, x.AssigneeId, x.CompletedAt, x.ProjectId, p.Key, ProjectName = p.Name, Status = s.Name, s.Category,
                           Owner = db.Users.Where(u => u.Id == x.AssigneeId).Select(u => u.DisplayName).FirstOrDefault() })
            .FirstOrDefaultAsync(ct) ?? throw new NotFoundException("That task was not found.");
        var key = $"{t.Key}-{t.Number}";
        var href = AuraBriefingService.TaskHref(t.Id);
        var evidence = new List<AuraEvidenceDto>();
        var facts = new List<string>();

        var done = t.Category is StatusCategory.Done or StatusCategory.Cancelled;
        var late = !done && t.DueDate is { } due && due < today ? today.DayNumber - due.DayNumber : 0;
        facts.Add(done ? $"{key} is {t.Status.ToLowerInvariant()}{(t.CompletedAt is { } fin ? $" (finished {D(DateOnly.FromDateTime(fin))})" : "")}."
            : late > 0 ? $"{key} is {late} day{(late == 1 ? "" : "s")} late: it was due {D(t.DueDate)} and is still {t.Status.ToLowerInvariant()}."
            : t.DueDate is null ? $"{key} has no due date and is {t.Status.ToLowerInvariant()}."
            : $"{key} is not late yet: it is due {D(t.DueDate)} and is {t.Status.ToLowerInvariant()}.");
        evidence.Add(new AuraEvidenceDto("task", $"{key} {t.Title}", $"{t.Status} · due {D(t.DueDate)}", href));

        // Every move of its date, with the reason and who moved it.
        var moves = await (from c in db.DueDateChanges.AsNoTracking()
                           where c.TaskId == t.Id
                           orderby c.CreatedAt
                           select new { c.Previous, c.Revised, c.Reason, c.Dependency, c.CreatedAt, By = db.Users.Where(u => u.Id == c.CreatedBy).Select(u => u.DisplayName).FirstOrDefault() })
            .Take(20).ToListAsync(ct);
        if (moves.Count > 0)
        {
            var reasons = moves.Where(m => m.Reason is { Length: > 0 }).Select(m => $"“{m.Reason}”").Distinct().ToList();
            facts.Add($"Its date moved {(moves.Count == 1 ? "once" : $"{moves.Count} times")}, from {D(moves[0].Previous)} to {D(moves[^1].Revised)}"
                      + (reasons.Count > 0 ? $"; the reasons given: {string.Join(", ", reasons.Take(3))}." : ", with no reason given."));
            foreach (var m in moves.AsEnumerable().Reverse().Take(5))
                evidence.Add(new AuraEvidenceDto("date", $"{D(m.Previous)} → {D(m.Revised)}", string.Join(" · ", new[] { m.Reason, m.Dependency is { Length: > 0 } dep ? $"waits on {dep}" : null, m.By }.Where(x => x is { Length: > 0 })), href, m.CreatedAt));
        }

        // What it waits on.
        var blockers = await (from d in db.TaskDependencies.AsNoTracking()
                              join b in db.Tasks.AsNoTracking() on d.DependsOnTaskId equals b.Id
                              join s in db.WorkflowStatuses.AsNoTracking() on b.StatusId equals s.Id
                              join p in db.Projects.AsNoTracking() on b.ProjectId equals p.Id
                              where d.TaskId == t.Id
                              select new { b.Id, p.Key, b.Number, b.Title, b.DueDate, Status = s.Name, s.Category,
                                  Owner = db.Users.Where(u => u.Id == b.AssigneeId).Select(u => u.DisplayName).FirstOrDefault() }).Take(10).ToListAsync(ct);
        foreach (var b in blockers)
        {
            var bdone = b.Category is StatusCategory.Done or StatusCategory.Cancelled;
            var bkey = $"{b.Key}-{b.Number}";
            if (!bdone)
            {
                var slip = b.DueDate is { } bd && t.DueDate is { } td && bd > td ? $", which is due {D(bd)} — after {key} itself"
                    : b.DueDate is { } od && od < today ? $", which is {today.DayNumber - od.DayNumber} days overdue" : "";
                facts.Add($"It waits on {bkey} “{b.Title}”{(b.Owner is { } o ? $" ({o})" : "")}, still {b.Status.ToLowerInvariant()}{slip}.");
            }
            evidence.Add(new AuraEvidenceDto("dependency", $"{bkey} {b.Title}", $"{b.Status} · due {D(b.DueDate)}{(b.Owner is { } on ? $" · {on}" : "")}", AuraBriefingService.TaskHref(b.Id)));
        }

        // The owner's load.
        if (!done && t.AssigneeId is { } a)
        {
            var overdue = await (from x in db.Tasks.AsNoTracking()
                                 join s in db.WorkflowStatuses.AsNoTracking() on x.StatusId equals s.Id
                                 where x.AssigneeId == a && x.DueDate != null && x.DueDate < today && s.Category != StatusCategory.Done && s.Category != StatusCategory.Cancelled
                                 select x.Id).CountAsync(ct);
            if (overdue > 1) facts.Add($"{t.Owner} has {overdue} overdue items in all.");
        }
        else if (!done) facts.Add("Nobody owns it.");

        // What it means for the project's finish, and how sure Aura is (a percentage only when forecasts could be checked against completed projects).
        if (!done)
        {
            try
            {
                var fc = await projects.GetForecastAsync(t.ProjectId, ct);
                if (fc.Confidence is { Band: not "none" } conf && fc.Forecast is not null)
                    facts.Add($"For the project {t.ProjectName}: {ForecastConfidence.ToText(conf)}{(fc.Promised is { } promisedOn && fc.SlipDays > 0 ? $" It was promised for {D(promisedOn)}." : "")}");
            }
            catch (AppException) { /* no forecast for this project */ }
        }

        // Latest activity and comments.
        var acts = await db.Activities.AsNoTracking().Where(x => x.EntityId == t.Id).OrderByDescending(x => x.CreatedAt)
            .Select(x => new { x.Summary, x.CreatedAt, By = db.Users.Where(u => u.Id == x.ActorId).Select(u => u.DisplayName).FirstOrDefault() }).Take(4).ToListAsync(ct);
        foreach (var x in acts) evidence.Add(new AuraEvidenceDto("activity", x.Summary, x.By, href, x.CreatedAt));
        var comments = await db.TaskComments.AsNoTracking().Where(c => c.TaskId == t.Id).OrderByDescending(c => c.CreatedAt)
            .Select(c => new { c.Body, c.CreatedAt, By = db.Users.Where(u => u.Id == c.AuthorId).Select(u => u.DisplayName).FirstOrDefault() }).Take(3).ToListAsync(ct);
        if (comments.Count > 0)
            facts.Add($"Latest comment{(comments[0].By is { } cb ? $" from {cb}" : "")}: “{Text.Truncate(comments[0].Body.Replace('\n', ' '), 140)}”.");
        foreach (var c in comments) evidence.Add(new AuraEvidenceDto("comment", Text.Truncate(c.Body.Replace('\n', ' '), 120)!, c.By, href, c.CreatedAt));
        if (acts.Count == 0 && comments.Count == 0 && !done) facts.Add("Nothing has been said or changed on it lately.");

        var answer = string.Join(" ", facts);
        var byAi = false;
        if (polish) try
        {
            await ai.EnsureAiAsync(ct);
            var system = GrootIdentity.Generic + "Answer the question in at most three short sentences using ONLY the facts given. Lead with the main reason. Keep task keys as written. " +
                         "No greeting, no lists, no speculation beyond the facts.";
            var reply = await ai.AskModelAsync("aura_why", system, $"QUESTION: {question}\nFACTS:\n{string.Join("\n", facts)}", 160, 1, ct);
            var text = (reply.Text ?? "").Trim();
            if (text.Length is > 0 and <= 700) { answer = text; byAi = true; }
        }
        catch (Exception ex) when (ex is not OperationCanceledException) { /* the facts are the answer */ }

        var suggestions = new List<string>();
        if (!done && late > 0) suggestions.Add(t.AssigneeId is null ? $"Who should own {key}?" : $"Ask {AuraBriefingRules.First(t.Owner ?? "the owner")} for a new date");
        if (blockers.Any(b => b.Category is not (StatusCategory.Done or StatusCategory.Cancelled))) suggestions.Add($"Why is {blockers[0].Key}-{blockers[0].Number} late?");
        return new AuraAnswerDto(question.Length > 0 ? question : $"Why is {key} late?", answer, byAi, $"{key} {t.Title}", href, evidence, suggestions);
    }
}

// ============================================================================================================ after meetings: review & approve

public record AuraReviewItemDto(Guid Id, string Kind, string Title, string? Detail, AgentPersonRef? Owner, DateOnly? DueDate, string Status, string? AppliedKey,
    string? Evidence, bool Approvable);
public record AuraMeetingReviewDto(Guid RunId, Guid ProjectId, string ProjectName, string Title, DateTime Held, string? Summary, IReadOnlyList<string> Decisions,
    IReadOnlyList<AuraReviewItemDto> Items, IReadOnlyList<string> Questions, int Pending, bool CanDecide, IReadOnlyList<AgentPersonRef> People);
/// <summary>One drafted item: approve it (with the person's edits) or leave it out.</summary>
public record AuraReviewDecision(Guid Id, bool Approve, string? Title = null, Guid? AssigneeId = null, DateOnly? DueDate = null);
/// <param name="Items">Explicit decisions. Anything still waiting that is not listed is approved too (Approve all) unless <c>ApproveRest</c> is false.</param>
public record AuraReviewRequest(IReadOnlyList<AuraReviewDecision>? Items, bool? ApproveRest);
public record AuraReviewResultDto(int Approved, int Dismissed, int Failed, IReadOnlyList<string> Created);

/// <summary>
/// After a meeting the agent read: its minutes (summary, decisions, points left open) and the tasks and action items it drafted, on one
/// "Review &amp; approve" sheet. Approving creates the work with its owners and dates through the agent's own review queue (the same rights
/// checks, audit and minutes e-mail as approving one by one); left-out items are dismissed as not needed.
/// </summary>
public class AuraMeetingReviewService(IAppDbContext db, AgentReviewService review, AgentSettingsService settings, ProjectAccess access)
{
    private static readonly AgentFindingKind[] Work = [AgentFindingKind.CreateTask, AgentFindingKind.CreateActionItem, AgentFindingKind.CreateIssue];

    /// <summary>The newest meeting still waiting for this person's review, or null.</summary>
    public async Task<AuraMeetingReviewDto?> LatestAsync(CancellationToken ct = default)
    {
        var runs = await db.AgentRuns.AsNoTracking().Where(r => r.MeetingId != null && r.Status == "done"
                && db.AgentFindings.Any(f => f.RunId == r.Id && f.Status == AgentFindingStatus.Proposed))
            .OrderByDescending(r => r.FinishedAt).Select(r => new { r.Id, r.ProjectId }).Take(10).ToListAsync(ct);
        foreach (var r in runs)
        {
            var p = await db.Projects.FirstOrDefaultAsync(x => x.Id == r.ProjectId, ct);
            if (p is not null && await settings.CanManageAsync(p, ct)) return await GetAsync(r.Id, ct);
        }
        return null;
    }

    public async Task<AuraMeetingReviewDto> GetAsync(Guid runId, CancellationToken ct = default)
    {
        var run = await db.AgentRuns.AsNoTracking().FirstOrDefaultAsync(r => r.Id == runId, ct) ?? throw new NotFoundException("That meeting was not found.");
        var project = await access.GetProjectAsync(run.ProjectId, ct);
        var canDecide = await settings.CanManageAsync(project, ct);
        if (!canDecide) throw new ForbiddenException("Only people who may edit this project can review what the agent drafted.", "PERMISSION_DENIED");
        var meeting = run.MeetingId is { } mid ? await db.ProjectMeetings.AsNoTracking().FirstOrDefaultAsync(m => m.Id == mid, ct) : null;
        var title = meeting?.Title
            ?? (run.MeetingId is { } bm ? await db.AgentMeetingBots.AsNoTracking().Where(b => b.MeetingId == bm && b.Title != null).Select(b => b.Title).FirstOrDefaultAsync(ct) : null)
            ?? "Meeting";
        var findings = await db.AgentFindings.AsNoTracking().Where(f => f.RunId == run.Id && f.Status != AgentFindingStatus.Dismissed).OrderBy(f => f.CreatedAt).ToListAsync(ct);
        var ids = findings.Where(f => f.AssigneeId != null).Select(f => f.AssigneeId!.Value).Distinct().ToList();
        var people = await (from m in db.ProjectMembers.AsNoTracking()
                            join u in db.Users.AsNoTracking() on m.UserId equals u.Id
                            where m.ProjectId == project.Id && u.IsActive
                            orderby u.DisplayName
                            select new AgentPersonRef(u.Id, u.DisplayName)).Take(200).ToListAsync(ct);
        var names = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var items = findings.Where(f => Work.Contains(f.Kind)).Select(f => new AuraReviewItemDto(f.Id, KindOf(f.Kind), f.Title, f.Detail,
            f.AssigneeId is { } a && names.TryGetValue(a, out var n) ? new AgentPersonRef(a, n) : null, f.DueDate, f.Status.ToString().ToLowerInvariant(), f.AppliedKey,
            f.Evidence, f.Status is AgentFindingStatus.Proposed or AgentFindingStatus.Failed)).ToList();
        return new AuraMeetingReviewDto(run.Id, project.Id, project.Name, title, run.StartedAt, run.Summary,
            findings.Where(f => f.Kind == AgentFindingKind.Decision).Select(f => f.Title).ToList(), items,
            findings.Where(f => f.Kind == AgentFindingKind.Missed).Select(f => f.Title).ToList(),
            findings.Count(f => f.Status == AgentFindingStatus.Proposed), canDecide, people);
    }

    private static string KindOf(AgentFindingKind k) => k switch { AgentFindingKind.CreateActionItem => "actionItem", AgentFindingKind.CreateIssue => "issue", _ => "task" };

    public async Task<AuraReviewResultDto> DecideAsync(Guid runId, AuraReviewRequest req, CancellationToken ct = default)
    {
        var run = await db.AgentRuns.AsNoTracking().FirstOrDefaultAsync(r => r.Id == runId, ct) ?? throw new NotFoundException("That meeting was not found.");
        var project = await access.GetProjectAsync(run.ProjectId, ct);
        if (!await settings.CanManageAsync(project, ct)) throw new ForbiddenException("Only people who may edit this project can approve what the agent drafted.", "PERMISSION_DENIED");
        var waiting = await db.AgentFindings.AsNoTracking().Where(f => f.RunId == run.Id && (f.Status == AgentFindingStatus.Proposed || f.Status == AgentFindingStatus.Failed))
            .OrderBy(f => f.CreatedAt).Select(f => new { f.Id, f.Kind, f.DueDate }).ToListAsync(ct);
        var listed = (req.Items ?? []).DistinctBy(i => i.Id).ToList();
        if (listed.Count > 100) throw new ValidationException("items", "Review at most 100 items at once.");
        if (listed.Any(i => waiting.All(w => w.Id != i.Id))) throw new ValidationException("items", "Some of these items were already decided. Reload and try again.");
        // Approve all: new work and notes; changes to existing work (status, owner, dates) stay for one-by-one review, as in the agent's own queue.
        var rest = req.ApproveRest == false ? new List<AuraReviewDecision>() : waiting.Where(w => listed.All(i => i.Id != w.Id) && w.Kind != AgentFindingKind.UpdateTask && w.Kind != AgentFindingKind.UpdateIssue
            && !(w.Kind == AgentFindingKind.Delay && w.DueDate != null)).Select(w => new AuraReviewDecision(w.Id, true)).ToList();
        int approved = 0, dismissed = 0, failed = 0;
        var created = new List<string>();
        foreach (var d in listed.Concat(rest))
        {
            if (!d.Approve) { await review.DismissAsync(d.Id, ct, "not_needed"); dismissed++; continue; }
            var edits = d.Title is null && d.AssigneeId is null && d.DueDate is null ? null
                : new ApproveFindingRequest(d.Title, null, d.AssigneeId, null, d.DueDate, null, null, null, null);
            var r = await review.ApproveAsync(d.Id, edits, ct);
            if (r.Status == AgentFindingStatus.Applied) { approved++; if (r.AppliedKey is { } k) created.Add(k); }
            else failed++;
        }
        return new AuraReviewResultDto(approved, dismissed, failed, created);
    }
}

// ============================================================================================================ Friday status report

public record AuraFridayProjectDto(Guid ProjectId, string Key, string Name, string Health, int Progress, string Text, int Done, int Slipped, int Risks, int Next,
    bool Chat, string Href);
public record AuraFridayDto(DateOnly From, DateOnly To, string Headline, IReadOnlyList<AuraFridayProjectDto> Projects, DateTime NextScheduledAt, string TimeZone);
public record AuraFridaySendItem(Guid ProjectId, string? Text);
public record AuraFridaySendRequest(IReadOnlyList<AuraFridaySendItem>? Projects);
public record AuraFridaySentDto(int Sent, IReadOnlyList<string> Failed);

/// <summary>
/// The Friday status report: each active project the person owns, drafted from its data by <see cref="WeeklyReportService"/> (progress, what
/// was done, what slipped and why, risks, next week), under one portfolio headline. Ready on Friday at 16:00 in the person's zone
/// (<see cref="AuraFridayJob"/> tells them); they preview, edit and Send - to the project's chat, or by e-mail to its people when it has none.
/// </summary>
public class AuraFridayService(IAppDbContext db, ICurrentContext ctx, AppClock clock, WeeklyReportService weekly)
{
    public const int MaxProjects = 12;
    public static readonly TimeOnly ReadyAt = new(16, 0);

    private IQueryable<Project> Mine(Guid me) => db.Projects.AsNoTracking().Where(p => p.OwnerId == me && p.ArchivedAt == null
        && p.Status != ProjectStatus.Archived && p.Status != ProjectStatus.Completed && p.Status != ProjectStatus.Cancelled);

    /// <summary>The next Friday 16:00 in this zone (today's, until it has passed), as UTC.</summary>
    public static DateTime NextReady(DateTime nowUtc, NodaTime.DateTimeZone zone)
    {
        var local = ZoneTime.ToLocal(nowUtc, zone);
        var day = DateOnly.FromDateTime(local);
        var add = ((int)DayOfWeek.Friday - (int)day.DayOfWeek + 7) % 7;
        if (add == 0 && TimeOnly.FromDateTime(local) >= ReadyAt) add = 7;
        return ZoneTime.ToUtc(ZoneTime.At(day.AddDays(add), ReadyAt), zone);
    }

    public async Task<AuraFridayDto> DraftAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var ids = await Mine(me).OrderBy(p => p.Name).Select(p => p.Id).Take(MaxProjects).ToListAsync(ct);
        var list = new List<AuraFridayProjectDto>();
        foreach (var id in ids)
        {
            var r = await weekly.DraftAsync(id, ct);
            list.Add(new AuraFridayProjectDto(r.ProjectId, r.ProjectKey ?? "", r.ProjectName, r.Health, r.Progress, r.Text, r.Moved, r.Slipped, r.Risks, r.Next, r.CanSend,
                WeeklyReportService.PageLink(r.ProjectId)));
        }
        var done = list.Sum(p => p.Done); var slipped = list.Sum(p => p.Slipped); var risks = list.Sum(p => p.Risks);
        var headline = list.Count == 0 ? "No projects of yours to report on this week"
            : $"{list.Count} project{(list.Count == 1 ? "" : "s")} · {done} done · {slipped} slipped · {risks} at risk";
        return new AuraFridayDto(clock.Today.AddDays(-6), clock.Today, headline, list, NextReady(clock.Now, clock.Zone), clock.ZoneId);
    }

    public async Task<AuraFridaySentDto> SendAsync(AuraFridaySendRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var items = (req.Projects ?? []).DistinctBy(p => p.ProjectId).ToList();
        if (items.Count == 0) throw new ValidationException("projects", "Choose the reports to send.");
        if (items.Count > MaxProjects) throw new ValidationException("projects", $"Send at most {MaxProjects} reports at once.");
        var wanted = items.Select(i => i.ProjectId).ToList();
        var mine = await Mine(me).Where(p => wanted.Contains(p.Id)).Select(p => new { p.Id, p.Name }).ToListAsync(ct);
        if (mine.Count != items.Count) throw new ForbiddenException("You can send the Friday report of your own projects only.", "PERMISSION_DENIED");
        var sent = 0; var failed = new List<string>();
        foreach (var i in items)
        {
            var name = mine.First(p => p.Id == i.ProjectId).Name;
            var text = i.Text;
            if (string.IsNullOrWhiteSpace(text)) text = (await weekly.DraftAsync(i.ProjectId, ct)).Text;
            var chat = await db.Conversations.AsNoTracking().AnyAsync(c => c.ProjectId == i.ProjectId && c.Type == ConversationType.Project, ct);
            try
            {
                if (chat) await weekly.SendAsync(i.ProjectId, new SendWeeklyReportRequest(text, Chat: true), ct);
                else
                {
                    var people = await db.ProjectMembers.AsNoTracking().Where(m => m.ProjectId == i.ProjectId && m.UserId != me).Select(m => m.UserId).Take(100).ToListAsync(ct);
                    if (people.Count == 0) { failed.Add($"{name}: no chat and nobody else on the project"); continue; }
                    await weekly.SendAsync(i.ProjectId, new SendWeeklyReportRequest(text, Chat: false, Mail: true, Recipients: people), ct);
                }
                sent++;
            }
            catch (AppException ex) { failed.Add($"{name}: {ex.Message}"); }
        }
        return new AuraFridaySentDto(sent, failed);
    }
}

/// <summary>
/// Friday 16:00 in each project owner's own zone: "Your Friday report is ready" (in the bell, with Review), once per person, workspace and
/// Friday, never late (after 19:00 it waits for next week). Runs in the background worker without a signed-in tenant, so it names the
/// workspace in every query.
/// </summary>
public class AuraFridayJob(IAppDbContext db, AppClock clock, ProjectManagement.Application.Features.Notifications.NotificationRouter router)
{
    public async Task<int> RunAsync(DateTime nowUtc, CancellationToken ct = default)
    {
        var closed = new[] { ProjectStatus.Completed, ProjectStatus.Cancelled, ProjectStatus.Archived };
        var owners = await (from p in db.Projects.IgnoreQueryFilters().AsNoTracking()
                            join t in db.Tenants.IgnoreQueryFilters().AsNoTracking() on p.TenantId equals t.Id
                            join u in db.Users.IgnoreQueryFilters().AsNoTracking() on p.OwnerId equals u.Id
                            where !p.IsDeleted && p.ArchivedAt == null && !closed.Contains(p.Status) && !t.IsDeleted && t.Status == TenantStatus.Active && u.IsActive
                            group p by new { p.TenantId, p.OwnerId, UserZone = u.TimeZone, OrgZone = t.TimeZone } into g
                            select new { g.Key.TenantId, g.Key.OwnerId, g.Key.UserZone, g.Key.OrgZone, Count = g.Count() }).ToListAsync(ct);
        if (owners.Count == 0) return 0;
        var userIds = owners.Select(o => o.OwnerId).Distinct().ToList();
        var settings = await db.ReminderSettings.AsNoTracking().Where(s => userIds.Contains(s.UserId)).ToDictionaryAsync(s => s.UserId, ct);
        var members = (await db.TenantMembers.IgnoreQueryFilters().AsNoTracking().Where(m => userIds.Contains(m.UserId)).Select(m => new { m.TenantId, m.UserId }).ToListAsync(ct))
            .Select(m => (m.TenantId, m.UserId)).ToHashSet();
        var told = 0;
        foreach (var o in owners)
        {
            if (!members.Contains((o.TenantId, o.OwnerId))) continue;
            var zone = clock.ZoneFor(o.UserZone, AppClock.Chose(settings.GetValueOrDefault(o.OwnerId)), o.OrgZone);
            var local = ZoneTime.ToLocal(nowUtc, zone);
            if (local.DayOfWeek != DayOfWeek.Friday) continue;
            var at = TimeOnly.FromDateTime(local);
            if (at < AuraFridayService.ReadyAt || at >= AuraFridayService.ReadyAt.AddHours(3)) continue;
            var key = $"aurafriday:{o.TenantId:N}:{o.OwnerId:N}:{DateOnly.FromDateTime(local):yyyyMMdd}";
            if (await db.Notifications.IgnoreQueryFilters().AnyAsync(n => n.DedupeKey == key, ct)) continue;
            var channels = await router.ChannelsAsync(o.OwnerId, NotificationType.ReportReady, ct, o.TenantId);
            if (!channels.InApp) continue;
            db.Notifications.Add(new Notification
            {
                TenantId = o.TenantId, UserId = o.OwnerId, Type = NotificationType.ReportReady, CreatedAt = nowUtc, Link = "/?aura=friday", DedupeKey = key,
                Title = "Your Friday report is ready",
                Body = $"{o.Count} project{(o.Count == 1 ? "" : "s")} drafted by Aura: progress, done, slipped and why, risks, next week. Review and send.",
                InApp = true, EmailPending = false,
            });
            await db.SaveChangesAsync(ct);
            told++;
        }
        return told;
    }
}
