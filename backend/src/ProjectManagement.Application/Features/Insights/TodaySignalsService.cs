using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.Organization;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Insights;

/// <summary>Who a signal is about (a project owner, a teammate, a page owner). Null when nobody owns it.</summary>
public record SignalOwnerDto(Guid Id, string Name);
/// <summary>
/// The one next step of a signal. <c>Verb</c>: open (go to <c>Href</c>), ask (start a chat with <c>UserId</c> and say <c>Message</c>),
/// assign (open the item to give it an owner) or review (open the page to confirm or fix it). Every action is one the caller may take.
/// </summary>
public record SignalActionDto(string Verb, string Label, string? Href, Guid? UserId = null, string? Message = null);
/// <summary>One signal card: what it is about, why it showed up (in words), its owner and its one action.</summary>
public record SignalCardDto(string Id, string Kind, string Title, string Reason, SignalOwnerDto? Owner, SignalActionDto Action, string? Href, string Tone = "orange");
/// <summary>A kind of signal: <c>Kind</c> is risk (projects at risk), team (the team's open and overdue work), docs (pages out of date) or sla (Desk service levels breached).
/// <c>Count</c> is all of them; <c>Items</c> the first few; <c>Href</c> the filtered view of all of them.</summary>
public record SignalGroupDto(string Kind, string Label, int Count, string Href, IReadOnlyList<SignalCardDto> Items);
public record TodaySignalsDto(int Total, IReadOnlyList<SignalGroupDto> Groups, DateTime GeneratedAt);

/// <summary>
/// Today's "Team &amp; portfolio signals": what is not the caller's own action but is theirs to watch - projects at risk (with the reason from the
/// portfolio read), the open and overdue work of the people who report to them, pages out of date that they own or that sit in projects they own,
/// and Desk work past its service level in their reach. Each source keeps its own rules: projects through <see cref="AiPortfolio"/> (only projects
/// the caller can open), team work through <see cref="WorkItemService"/> on the reporting line, documents through the documents query filter
/// (visibility, grants, denials), Desk work only with the Work module. Personal actions ("Needs you") are never repeated here.
/// </summary>
public class TodaySignalsService(IAppDbContext db, ICurrentContext ctx, AppClock clock, AiPortfolio portfolio, WorkItemService workItems,
    ReportingLineService reporting, PermissionService permissions)
{
    public const int PerGroup = 5;

    public async Task<TodaySignalsDto> GetAsync(CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var me = ctx.RequireUserId();
        var groups = new List<SignalGroupDto>();
        var reports = await reporting.ReportsOfAsync(me, tid, ct);
        var myProjects = await db.Projects.AsNoTracking().Where(p => p.OwnerId == me && p.Status != ProjectStatus.Archived).Select(p => p.Id).Take(500).ToListAsync(ct);

        if (await RisksAsync(me, ct) is { } risk) groups.Add(risk);
        if (reports.Count > 0 && await TeamAsync(reports.Keys.ToList(), ct) is { } team) groups.Add(team);
        if (await DocsAsync(me, myProjects, reports.Keys.ToHashSet(), ct) is { } docs) groups.Add(docs);
        if (await SlaAsync(me, reports.Keys.ToHashSet(), ct) is { } sla) groups.Add(sla);
        return new TodaySignalsDto(groups.Sum(g => g.Count), groups, clock.Now);
    }

    private static string FirstName(string name) => name.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? name;

    /// <summary>The verb for something someone else owns: ask them; something the caller owns: open it.</summary>
    private static SignalActionDto AskOrOpen(Guid me, SignalOwnerDto? owner, string askLabel, string message, string openLabel, string href) =>
        owner is { } o && o.Id != me ? new SignalActionDto("ask", askLabel.Replace("{name}", FirstName(o.Name)), href, o.Id, message) : new SignalActionDto("open", openLabel, href);

    // ------------------------------------------------------------------ projects at risk

    private async Task<SignalGroupDto?> RisksAsync(Guid me, CancellationToken ct)
    {
        PortfolioBriefDto brief;
        try { brief = await portfolio.BriefAsync(null, ct); }
        catch (ForbiddenException) { return null; }   // no Projects module: nothing to watch here
        var risky = brief.Ranked.Where(r => r.Health is "AtRisk" or "Delayed").ToList();
        if (risky.Count == 0) return null;
        var ids = risky.Take(PerGroup).Select(r => r.ProjectId).ToList();
        var owners = await (from p in db.Projects.AsNoTracking()
                            join u in db.Users.AsNoTracking() on p.OwnerId equals u.Id
                            where ids.Contains(p.Id)
                            select new { p.Id, p.OwnerId, u.DisplayName }).ToDictionaryAsync(x => x.Id, x => new SignalOwnerDto(x.OwnerId, x.DisplayName), ct);
        var cards = risky.Take(PerGroup).Select(r =>
        {
            var owner = owners.GetValueOrDefault(r.ProjectId);
            var href = $"/work/projects/{r.ProjectId}";
            var reason = r.Reasons.Count > 0 ? r.Reasons[0] : r.Health == "Delayed" ? "Past its due date" : "Behind its plan";
            var action = AskOrOpen(me, owner, "Ask {name} for a date", $"{r.Key} {r.Name} shows as {(r.Health == "Delayed" ? "late" : "at risk")} ({reason}). When do you expect it to land?",
                "Open project", href);
            return new SignalCardDto($"risk:{r.ProjectId}", "risk", $"{r.Key} · {r.Name}", reason, owner, action, href, r.Health == "Delayed" ? "red" : "orange");
        }).ToList();
        return new SignalGroupDto("risk", risky.Count == 1 ? "project at risk" : "projects at risk", risky.Count, "/work/projects?status=AtRisk", cards);
    }

    // ------------------------------------------------------------------ the team's open and overdue work

    private async Task<SignalGroupDto?> TeamAsync(List<Guid> reports, CancellationToken ct)
    {
        var open = await workItems.ListAsync(new WorkItemQuery(null, OpenOnly: true, Limit: WorkItemService.MaxLimit, AssigneeIds: reports), WorkItemScope.ReportingLine, ct);
        var overdue = open.Where(w => w.IsOverdue && w.Assignee is not null).ToList();
        if (overdue.Count == 0) return null;
        var byPerson = overdue.GroupBy(w => w.Assignee!.Id)
            .Select(g => new { g.First().Assignee, Overdue = g.ToList(), Open = open.Count(w => w.Assignee?.Id == g.Key) })
            .OrderByDescending(x => x.Overdue.Count).ThenBy(x => x.Assignee!.Name).ToList();
        var cards = byPerson.Take(PerGroup).Select(x =>
        {
            var owner = new SignalOwnerDto(x.Assignee!.Id, x.Assignee.Name);
            var oldest = x.Overdue.OrderBy(w => w.DueDate).First();
            var reason = $"{x.Overdue.Count} overdue of {x.Open} open · oldest {oldest.Key} due {oldest.DueDate:d MMM}";
            var action = new SignalActionDto("ask", $"Ask {FirstName(owner.Name)} for a date", $"/work?tab=team&person={owner.Id}", owner.Id,
                $"{oldest.Key} \"{oldest.Title}\" was due {oldest.DueDate:d MMM}. What is a realistic date, and is anything blocking it?");
            return new SignalCardDto($"team:{owner.Id}", "team", owner.Name, reason, owner, action, $"/work?tab=team&person={owner.Id}", x.Overdue.Count >= 3 ? "red" : "orange");
        }).ToList();
        return new SignalGroupDto("team", overdue.Count == 1 ? "team item overdue" : "team items overdue", overdue.Count, "/work?tab=team&overdue=1", cards);
    }

    // ------------------------------------------------------------------ documents out of date

    private async Task<SignalGroupDto?> DocsAsync(Guid me, List<Guid> myProjects, HashSet<Guid> reports, CancellationToken ct)
    {
        // The documents query filter applies visibility, grants and denials: only pages the caller can open are counted.
        var q = db.Documents.AsNoTracking().Where(d => d.StaleSince != null && d.Status != DocumentStatus.Archived
            && (d.OwnerId == me || (d.ProjectId != null && myProjects.Contains(d.ProjectId.Value)) || reports.Contains(d.OwnerId)));
        var count = await q.CountAsync(ct);
        if (count == 0) return null;
        var rows = await (from d in q
                          join u in db.Users.AsNoTracking() on d.OwnerId equals u.Id
                          orderby d.StaleSince
                          select new { d.Id, d.Number, d.Title, d.StaleReason, d.StaleSince, d.OwnerId, u.DisplayName }).Take(PerGroup).ToListAsync(ct);
        var cards = rows.Select(d =>
        {
            var owner = new SignalOwnerDto(d.OwnerId, d.DisplayName);
            var href = $"/documents/{d.Id}";
            var key = DocumentService.KeyOf(d.Number);
            var action = d.OwnerId == me ? new SignalActionDto("review", "Review", href)
                : new SignalActionDto("ask", $"Ask {FirstName(owner.Name)} to review", href, owner.Id, $"{key} \"{d.Title}\" may be out of date: {d.StaleReason ?? "work it describes changed"}. Could you review it?");
            return new SignalCardDto($"docs:{d.Id}", "docs", $"{key} · {d.Title}", d.StaleReason ?? "Linked work changed after it was last edited", owner, action, href, "orange");
        }).ToList();
        return new SignalGroupDto("docs", count == 1 ? "doc needs review" : "docs need review", count, "/library", cards);
    }

    // ------------------------------------------------------------------ Desk service levels breached

    private async Task<SignalGroupDto?> SlaAsync(Guid me, HashSet<Guid> reports, CancellationToken ct)
    {
        var level = await permissions.LevelAsync(Modules.Work, ct);
        if (level <= AccessLevel.None) return null;
        var canAssign = level >= AccessLevel.Edit;
        var now = clock.Now;
        var people = reports.Append(me).ToList();
        var open = new[] { WorkTaskStatus.ToDo, WorkTaskStatus.InProgress, WorkTaskStatus.OnHold };
        var q = db.WorkTasks.AsNoTracking().Where(w => w.Kind == WorkTaskKind.Operational && open.Contains(w.Status) && w.SlaPausedAt == null
            && ((w.ResolutionDueAt != null && w.ResolutionDueAt < now) || (w.RespondedAt == null && w.ResponseDueAt != null && w.ResponseDueAt < now))
            && ((w.AssigneeId != null && people.Contains(w.AssigneeId.Value)) || (canAssign && w.AssigneeId == null)));
        var count = await q.CountAsync(ct);
        if (count == 0) return null;
        var rows = await q.OrderBy(w => w.ResolutionDueAt ?? w.ResponseDueAt).Take(PerGroup)
            .Select(w => new { w.Id, w.Kind, w.Number, w.Title, w.AssigneeId, w.ResponseDueAt, w.ResolutionDueAt, w.RespondedAt, w.Priority,
                Name = db.Users.Where(u => u.Id == w.AssigneeId).Select(u => u.DisplayName).FirstOrDefault() })
            .ToListAsync(ct);
        var cards = rows.Select(w =>
        {
            var key = WorkItemService.KeyOf(w.Kind, w.Number);
            var href = $"/work?item={w.Id}";
            var resolution = w.ResolutionDueAt is { } r && r < now;
            var due = resolution ? w.ResolutionDueAt!.Value : w.ResponseDueAt!.Value;
            var late = now - due;
            var lateText = late.TotalHours >= 24 ? $"{(int)late.TotalDays}d" : late.TotalHours >= 1 ? $"{(int)late.TotalHours}h" : $"{Math.Max(1, (int)late.TotalMinutes)}m";
            var reason = $"{w.Priority} · {(resolution ? "resolution" : "first response")} target missed by {lateText}";
            SignalOwnerDto? owner = w.AssigneeId is { } a ? new SignalOwnerDto(a, w.Name ?? "Someone") : null;
            var action = owner is null ? new SignalActionDto("assign", "Assign", href)
                : AskOrOpen(me, owner, "Ask {name} for an update", $"{key} \"{w.Title}\" is past its service level. What is the status?", "Open", href);
            return new SignalCardDto($"sla:{w.Id}", "sla", $"{key} · {w.Title}", reason, owner, action, href, "red");
        }).ToList();
        return new SignalGroupDto("sla", count == 1 ? "Desk SLA breached" : "Desk SLAs breached", count, "/work?tab=tickets&sla=breached", cards);
    }
}
