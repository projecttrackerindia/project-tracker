using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Organization;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Load;

public record LoadDayDto(DateOnly Date, int WorkingMinutes, int MeetingMinutes, int CapacityMinutes, int CommittedMinutes, int? Percent, string State);
/// <summary>One row of the Load page: a person, a team or a project, its 2-week strip, its state and a one-line reason.</summary>
public record LoadRowDto(string Kind, Guid Id, string Name, string State, int? Percent, string Reason, IReadOnlyList<LoadDayDto> Days,
    int FreeMinutes, int Wip, string? Signal, int People = 0, int FreePeople = 0, bool IsMe = false);
public record LoadDto(DateOnly From, int Days, string Scope, IReadOnlyList<LoadRowDto> Rows, bool SeesOthers, string? MySignal);
public record LoadItemDto(string Kind, Guid Id, string Title, Guid? ProjectId, string? ProjectName, DateOnly? Due, int Minutes, int DayMinutes, string Basis, bool Overdue);
public record LoadMeetingDto(string Title, DateTime Start, int Minutes);
/// <summary>What fills one person's day: the items and meetings, and "13h of 8h" (used of working hours).</summary>
public record LoadDayDetailDto(Guid UserId, string Name, DateOnly Date, int WorkingMinutes, int UsedMinutes, int CommittedMinutes, int MeetingMinutes,
    int? Percent, string State, IReadOnlyList<LoadItemDto> Items, IReadOnlyList<LoadMeetingDto> Meetings);
/// <summary>A rebalance: move one item from someone overloaded to someone it fits.</summary>
public record LoadSuggestionDto(string Kind, Guid ItemId, string Title, int Minutes, DateOnly? Due, Guid FromUserId, string FromName, string FromWhen,
    Guid ToUserId, string ToName, string ToWhen, int ToPercentAfter);
public record LoadFitPersonDto(Guid UserId, string Name, string State, string Reason, bool BestFit, bool Fits, int FreeMinutes, bool IsCurrent);
public record LoadFitTeamDto(Guid TeamId, string Name, int People, int Free, Guid? BestUserId);
public record LoadFitDto(int Minutes, IReadOnlyList<LoadFitPersonDto> People, IReadOnlyList<LoadFitTeamDto> Teams);
public record LoadMoveItem(string Kind, Guid Id);
public record LoadReassignRequest(Guid ToUserId, IReadOnlyList<LoadMoveItem>? Items = null, Guid? FromUserId = null, Guid? StageId = null, bool DryRun = false);
public record LoadMovedDto(string Kind, Guid Id, string Title, Guid? FromUserId);
public record LoadReassignResultDto(Guid ToUserId, IReadOnlyList<LoadMovedDto> Items, bool DryRun);
public record LoadSignalRequest(string? Signal, DateOnly? WeekStart = null);
public record LoadSizeRequest(string? Size);

/// <summary>
/// The Load engine. Per person, per day for the next two weeks: capacity is their working hours (weekly capacity spread over weekdays) less
/// meetings, and nothing on leave or public holidays. Committed is their open work (project tasks, action items, operational work and stages
/// with no tasks of their own), each item's remaining effort (estimate, else its size, else the person's learned median for that kind of work,
/// else M = 4h) multiplied by their calibration factor, spread evenly over the working days until it is due; overdue work lands on today.
/// The state follows the share of capacity committed: Free under 50%, Balanced to 85%, Stretched to 110%, Overloaded above.
/// <para>Who can be seen: yourself, the people who report to you, the people in your teams, and everyone when you have broad reports access.
/// Items are read through the normal project visibility, so a manager never sees titles of work in projects they cannot open.</para>
/// </summary>
public class LoadService(IAppDbContext db, ICurrentContext ctx, AppClock clock, PermissionService permissions, ReportingLineService reporting,
    TaskService tasks, ActionItemService actions, Recorder recorder)
{
    public const int MaxDays = 28;

    // ------------------------------------------------------------------ model

    internal sealed class Item
    {
        public string Kind = ""; public Guid Id; public string Title = ""; public Guid? ProjectId; public DateOnly? Start; public DateOnly? Due;
        public double Minutes; public string Basis = ""; public bool Overdue; public Dictionary<DateOnly, double> PerDay = new();
    }

    internal sealed class Day
    {
        public DateOnly Date; public int Working; public int Meetings; public int Capacity; public double Committed; public bool Leave; public bool Holiday; public bool Weekend;
        public List<LoadMeetingDto> MeetingList = new();
        public int? Percent => Leave || ((Weekend || Holiday) && Committed < 1) ? null : LoadMath.Percent(Committed, Capacity);
        public string State => Leave ? LoadMath.Leave : (Weekend || Holiday) && Committed < 1 ? LoadMath.Off : LoadMath.State(Percent);
        public bool Works => !Leave && !Weekend && !Holiday;
    }

    internal sealed class Person
    {
        public Guid UserId; public string Name = ""; public int DailyMinutes; public double Calibration = 1; public int Wip; public string? Signal;
        public List<Day> Days = new(); public List<Item> Items = new(); public List<Guid> Teams = new(); public HashSet<DateOnly> LeaveAhead = new();
        public string State = LoadMath.Free; public int? Percent; public string Reason = ""; public int Free;
    }

    internal sealed class Model
    {
        public DateOnly From; public DateOnly Today; public int Days; public Guid Me;
        public Dictionary<Guid, Person> People = new();
        public Dictionary<Guid, (string Name, List<Guid> Members)> Teams = new();
        public Dictionary<Guid, string> Projects = new();
    }

    // ------------------------------------------------------------------ public API

    public async Task<LoadDto> GetAsync(string? scope, DateOnly? from, int? days, CancellationToken ct = default)
    {
        var m = await ModelAsync(from, days, ct);
        var s = (scope ?? "people").ToLowerInvariant();
        IEnumerable<LoadRowDto> rows = s switch
        {
            "people" => m.People.Values.Select(p => PersonRow(m, p)),
            "teams" => m.Teams.Select(t => GroupRow(m, "team", t.Key, t.Value.Name, t.Value.Members, 0)),
            "projects" => ProjectRows(m),
            _ => throw new ValidationException("scope", "Choose people, teams or projects."),
        };
        var ordered = rows.OrderBy(r => r.State == LoadMath.Leave ? 1 : 0).ThenByDescending(r => Rank(r.State)).ThenByDescending(r => r.Percent ?? 0).ThenBy(r => r.Name).ToList();
        return new LoadDto(m.From, m.Days, s, ordered, m.People.Count > 1, m.People.GetValueOrDefault(m.Me)?.Signal);
    }

    public async Task<LoadDayDetailDto> DayAsync(Guid userId, DateOnly date, CancellationToken ct = default)
    {
        var m = await ModelAsync(null, null, ct);
        if (!m.People.TryGetValue(userId, out var p)) throw new NotFoundException("That person is not in a load you can see.");
        var d = p.Days.FirstOrDefault(x => x.Date == date) ?? throw new NotFoundException("That day is outside the next weeks.");
        var items = p.Items.Where(i => i.PerDay.ContainsKey(date)).OrderByDescending(i => i.PerDay[date])
            .Select(i => new LoadItemDto(i.Kind, i.Id, i.Title, i.ProjectId, i.ProjectId is { } pid ? m.Projects.GetValueOrDefault(pid) : null, i.Due,
                (int)Math.Round(i.Minutes), (int)Math.Round(i.PerDay[date]), i.Basis, i.Overdue)).ToList();
        var committed = (int)Math.Round(d.Committed);
        return new LoadDayDetailDto(p.UserId, p.Name, date, d.Working, committed + d.Meetings, committed, d.Meetings, d.Percent, d.State, items, d.MeetingList);
    }

    public async Task<IReadOnlyList<LoadSuggestionDto>> SuggestionsAsync(CancellationToken ct = default) => Suggest(await ModelAsync(null, null, ct));

    /// <summary>The picker: every visible person with their state and a reason for an item of this size and these dates, the best fit marked; teams with "N people · M free".</summary>
    public async Task<LoadFitDto> FitAsync(DateOnly? start, DateOnly? due, int? minutes, string? size, Guid? current, CancellationToken ct = default)
    {
        var m = await ModelAsync(null, null, ct);
        var need = minutes is > 0 ? minutes.Value : (int)((LoadMath.SizeHours(size) ?? LoadMath.DefaultHours) * 60);
        var people = new List<(Person P, LoadFitPersonDto Dto, double Score)>();
        foreach (var p in m.People.Values)
        {
            var window = LoadMath.SpreadDays(m.Today, start, due, d => p.Days.FirstOrDefault(x => x.Date == d)?.Works ?? IsWeekday(d))
                .Select(d => p.Days.FirstOrDefault(x => x.Date == d)).Where(x => x is not null && x.Works).Select(x => x!).ToList();
            var free = window.Sum(x => Math.Max(0, x.Capacity - x.Committed));
            var fits = window.Count > 0 && free >= need * p.Calibration && p.Signal != "swamped";
            var perDay = window.Count > 0 ? need * p.Calibration / window.Count : 0;
            var after = window.Count == 0 ? 999 : window.Max(x => LoadMath.Percent(x.Committed + perDay, x.Capacity) ?? 0);
            string reason;
            if (p.State == LoadMath.Leave || (window.Count == 0 && p.LeaveAhead.Contains(m.Today)))
            {
                var back = p.Days.FirstOrDefault(x => x.Date > m.Today && x.Works);
                reason = back is null ? "On leave" : $"On leave until {LoadMath.Dow(back.Date)}";
            }
            else if (p.State == LoadMath.Overloaded) reason = $"Overloaded {LoadMath.Range(Hot(m, p))}".TrimEnd();
            else if (p.State == LoadMath.Stretched) reason = "Stretched this week";
            else if (fits)
            {
                var firstFree = window.FirstOrDefault(x => x.Capacity - x.Committed >= Math.Min(need, x.Capacity / 2));
                var cum = 0.0; DateOnly? by = null;
                foreach (var x in window) { cum += Math.Max(0, x.Capacity - x.Committed); if (cum >= need) { by = x.Date; break; } }
                reason = p.State == LoadMath.Free ? (firstFree is null || firstFree.Date == m.Today ? "Free now" : $"Free {LoadMath.Dow(firstFree.Date)}")
                    : $"Balanced · fits by {(by is { } b ? LoadMath.Dow(b) : "the due date")}";
            }
            else reason = p.Signal == "swamped" ? "Says they are swamped" : p.State == LoadMath.Free ? "Free, but not before the due date" : "Balanced · tight before the due date";
            var score = fits ? 1000 - after : -after;
            people.Add((p, new LoadFitPersonDto(p.UserId, p.Name, p.State, reason, false, fits, (int)Math.Round(free), p.UserId == current), score));
        }
        var best = people.Where(x => x.Dto.Fits && x.P.UserId != current).OrderByDescending(x => x.Score).Select(x => (Guid?)x.P.UserId).FirstOrDefault();
        var list = people.Select(x => x.P.UserId == best ? x with { Dto = x.Dto with { BestFit = true, Reason = x.Dto.Reason + " · best fit" } } : x)
            .OrderByDescending(x => x.P.UserId == best).ThenBy(x => x.P.UserId == current).ThenByDescending(x => x.Score).ThenBy(x => x.P.Name).Select(x => x.Dto).ToList();
        var teams = m.Teams.Select(t =>
        {
            var members = t.Value.Members.Where(m.People.ContainsKey).ToList();
            var bestInTeam = list.Where(x => members.Contains(x.UserId) && x.Fits && x.UserId != current).Select(x => (Guid?)x.UserId).FirstOrDefault();
            return new LoadFitTeamDto(t.Key, t.Value.Name, members.Count, members.Count(u => m.People[u].State == LoadMath.Free), bestInTeam);
        }).Where(t => t.People > 0).OrderByDescending(t => t.Free).ThenBy(t => t.Name).ToList();
        return new LoadFitDto(need, list, teams);
    }

    /// <summary>Move items to someone else (one-tap Move, "also move open tasks", undo): through the normal task and action item edits, so permissions, notifications and activity all apply.</summary>
    public async Task<LoadReassignResultDto> ReassignAsync(LoadReassignRequest req, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        if (!await db.TenantMembers.AnyAsync(x => x.TenantId == tid && x.UserId == req.ToUserId && x.Role != TenantRole.Guest, ct))
            throw new ValidationException("toUserId", "Choose someone in this workspace.");
        var items = new List<LoadMoveItem>(req.Items ?? []);
        if (req.StageId is { } stage)
        {
            if (req.FromUserId is not { } from) throw new ValidationException("fromUserId", "Say whose open tasks to move.");
            var open = await db.Tasks.AsNoTracking().Where(t => t.StageId == stage && t.AssigneeId == from && t.CompletedAt == null
                    && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled)
                .OrderBy(t => t.Position).Select(t => t.Id).Take(200).ToListAsync(ct);
            items.AddRange(open.Select(id => new LoadMoveItem("task", id)));
        }
        if (items.Count == 0 && !req.DryRun) throw new ValidationException("items", "Choose what to move.");
        if (items.Count > 200) throw new ValidationException("items", "Move at most 200 items at a time.");
        var moved = new List<LoadMovedDto>();
        foreach (var it in items.DistinctBy(x => x.Id))
        {
            switch (it.Kind)
            {
                case "task":
                {
                    var t = (await tasks.GetAsync(it.Id, ct)).Task;
                    if (!req.DryRun && t.Assignee?.Id != req.ToUserId)
                        await tasks.UpdateAsync(it.Id, new UpdateTaskRequest(t.Title, t.Description, t.StatusId, t.Priority, req.ToUserId, t.StartDate, t.DueDate,
                            t.EstimatedHours, t.ActualHours, t.Labels.Select(l => l.Id).ToList(), t.Version, t.MilestoneId, t.StageId, DueTime: t.DueTime), ct);
                    moved.Add(new LoadMovedDto("task", it.Id, t.Title, t.Assignee?.Id));
                    break;
                }
                case "action":
                {
                    var w = await db.WorkTasks.AsNoTracking().Where(x => x.Id == it.Id && x.Kind == WorkTaskKind.ActionItem)
                        .Select(x => new { x.Title, x.RelatedProjectId, x.AssigneeId }).FirstOrDefaultAsync(ct) ?? throw new NotFoundException("That action item was not found.");
                    if (w.RelatedProjectId is not { } pid) throw new NotFoundException("That action item was not found.");
                    if (!req.DryRun && w.AssigneeId != req.ToUserId)
                        await actions.ReplanAsync(pid, it.Id, req.ToUserId, true, null, false, null, "replanned", ct);
                    moved.Add(new LoadMovedDto("action", it.Id, w.Title, w.AssigneeId));
                    break;
                }
                default: throw new ValidationException("kind", "Only tasks and action items can be moved here.");
            }
        }
        if (!req.DryRun) LoadCache.Bump(tid);
        return new LoadReassignResultDto(req.ToUserId, moved, req.DryRun);
    }

    /// <summary>"I'm swamped" / "I have room" for a week (this week by default); empty clears it.</summary>
    public async Task<string?> SetSignalAsync(LoadSignalRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        var signal = string.IsNullOrWhiteSpace(req.Signal) ? null : req.Signal.Trim().ToLowerInvariant();
        if (signal is not (null or "swamped" or "room")) throw new ValidationException("signal", "Say swamped or room.");
        var week = TimesheetApprovalService.WeekOf(req.WeekStart ?? clock.Today);
        var row = await db.LoadSignals.FirstOrDefaultAsync(x => x.UserId == me && x.WeekStart == week, ct);
        if (signal is null) { if (row is not null) db.LoadSignals.Remove(row); }
        else if (row is null) db.LoadSignals.Add(new LoadSignal { TenantId = tid, UserId = me, WeekStart = week, Signal = signal });
        else row.Signal = signal;
        await db.SaveChangesAsync(ct);
        LoadCache.Bump(tid);
        return signal;
    }

    /// <summary>A task's rough size (S/M/L/XL, empty clears it), for people who may edit the task.</summary>
    public async Task<TaskDto> SetSizeAsync(Guid taskId, string? size, CancellationToken ct = default)
    {
        var value = LoadMath.NormaliseSize(size, out var valid);
        if (!valid) throw new ValidationException("size", "Choose S, M, L or XL.");
        var dto = (await tasks.GetAsync(taskId, ct)).Task;
        if (!dto.CanEdit) throw new ForbiddenException("You cannot edit this task.", "PERMISSION_DENIED");
        var t = await db.Tasks.FirstOrDefaultAsync(x => x.Id == taskId, ct) ?? throw new NotFoundException("That task was not found.");
        if (t.Size != value)
        {
            var was = t.Size;
            t.Size = value; t.Version++; t.UpdatedAt = clock.Now; t.UpdatedBy = ctx.UserId;
            recorder.Activity("task.updated", "Task", t.Id, $"Size {(was ?? "none")} → {(value ?? "none")} on “{t.Title}”", t.ProjectId, was, value);
            await db.SaveChangesAsync(ct);
            LoadCache.Bump(t.TenantId);
        }
        return (await tasks.GetAsync(taskId, ct)).Task;
    }

    // ------------------------------------------------------------------ rows

    private static int Rank(string state) => state switch { LoadMath.Overloaded => 4, LoadMath.Stretched => 3, LoadMath.Balanced => 2, LoadMath.Free => 1, _ => 0 };

    private static IReadOnlyList<LoadDayDto> DayDtos(IEnumerable<Day> days) =>
        days.Select(d => new LoadDayDto(d.Date, d.Working, d.Meetings, d.Capacity, (int)Math.Round(d.Committed), d.Percent, d.State)).ToList();

    private static LoadRowDto PersonRow(Model m, Person p) =>
        new("person", p.UserId, p.Name, p.State, p.Percent, p.Reason, DayDtos(p.Days), p.Free, p.Wip, p.Signal, IsMe: p.UserId == m.Me);

    private static LoadRowDto GroupRow(Model m, string kind, Guid id, string name, IEnumerable<Guid> memberIds, int openItems)
    {
        var members = memberIds.Where(m.People.ContainsKey).Distinct().Select(u => m.People[u]).ToList();
        var days = Enumerable.Range(0, m.Days).Select(i =>
        {
            var ds = members.Select(p => p.Days[i]).ToList();
            var d0 = ds.FirstOrDefault();
            var g = new Day
            {
                Date = m.From.AddDays(i), Working = ds.Sum(x => x.Working), Meetings = ds.Sum(x => x.Meetings), Capacity = ds.Sum(x => x.Capacity),
                Committed = ds.Sum(x => x.Committed), Weekend = d0?.Weekend ?? !IsWeekday(m.From.AddDays(i)), Holiday = d0?.Holiday ?? false,
                Leave = ds.Count > 0 && ds.All(x => x.Leave),
            };
            return g;
        }).ToList();
        var work = days.Where(d => d.Works).Take(5).ToList();
        var pct = LoadMath.Percent(work.Sum(d => d.Committed), work.Sum(d => d.Capacity));
        var state = members.Count > 0 && members.All(p => p.State == LoadMath.Leave) ? LoadMath.Leave : LoadMath.State(pct);
        var free = members.Count(p => p.State == LoadMath.Free);
        var over = members.Count(p => p.State == LoadMath.Overloaded);
        var away = members.Count(p => p.State == LoadMath.Leave);
        var parts = new List<string> { members.Count == 1 ? "1 person" : $"{members.Count} people", $"{free} free" };
        if (over > 0) parts.Add($"{over} overloaded");
        if (away > 0) parts.Add($"{away} on leave");
        if (kind == "project" && openItems > 0) parts.Add(openItems == 1 ? "1 open item" : $"{openItems} open items");
        return new LoadRowDto(kind, id, name, state, pct, string.Join(" · ", parts), DayDtos(days), (int)Math.Round(days.Sum(d => Math.Max(0, d.Capacity - d.Committed))),
            members.Sum(p => p.Wip), null, members.Count, free);
    }

    private static IEnumerable<LoadRowDto> ProjectRows(Model m)
    {
        var byProject = m.People.Values.SelectMany(p => p.Items.Where(i => i.ProjectId is not null).Select(i => (Project: i.ProjectId!.Value, p.UserId)))
            .GroupBy(x => x.Project);
        foreach (var g in byProject)
        {
            if (!m.Projects.TryGetValue(g.Key, out var name)) continue;
            yield return GroupRow(m, "project", g.Key, name, g.Select(x => x.UserId), g.Count());
        }
    }

    private static List<DateOnly> Hot(Model m, Person p) =>
        p.Days.Where(d => d.Date >= m.Today && d.Date < m.Today.AddDays(7) && d.State == LoadMath.Overloaded).Select(d => d.Date).ToList();

    private static bool IsWeekday(DateOnly d) => d.DayOfWeek is not DayOfWeek.Saturday and not DayOfWeek.Sunday;

    // ------------------------------------------------------------------ suggestions

    private static List<LoadSuggestionDto> Suggest(Model m)
    {
        var result = new List<LoadSuggestionDto>();
        var taken = new HashSet<Guid>();
        foreach (var from in m.People.Values.Where(p => p.State == LoadMath.Overloaded || Hot(m, p).Count > 0).OrderByDescending(p => p.Percent ?? 0))
        {
            var hot = from.Days.Where(d => d.Date >= m.Today && d.Date < m.Today.AddDays(10) && d.State == LoadMath.Overloaded).Select(d => d.Date).ToHashSet();
            if (hot.Count == 0) continue;
            var candidates = from.Items.Where(i => i.Kind is "task" or "action" && i.PerDay.Keys.Any(hot.Contains) && i.Minutes >= 30)
                .OrderByDescending(i => i.PerDay.Where(kv => hot.Contains(kv.Key)).Sum(kv => kv.Value)).Take(8).ToList();
            LoadSuggestionDto? pick = null;
            foreach (var item in candidates)
            {
                foreach (var to in m.People.Values.Where(p => p.UserId != from.UserId && !taken.Contains(p.UserId) && p.Signal != "swamped" && p.State is LoadMath.Free or LoadMath.Balanced)
                             .OrderBy(p => p.Percent ?? 0))
                {
                    var window = item.PerDay.Keys.Select(d => to.Days.FirstOrDefault(x => x.Date == d)).Where(x => x is not null && x.Works).Select(x => x!).ToList();
                    if (window.Count == 0) window = to.Days.Where(d => d.Works && d.Date >= m.Today && (item.Due is null || d.Date <= item.Due.Value)).ToList();
                    if (window.Count == 0) continue;
                    var per = item.Minutes / from.Calibration * to.Calibration / window.Count;
                    var after = window.Max(x => LoadMath.Percent(x.Committed + per, x.Capacity) ?? 999);
                    if (after > 85) continue;
                    var freeDay = window.OrderByDescending(x => x.Capacity - x.Committed).First().Date;
                    pick = new LoadSuggestionDto(item.Kind, item.Id, item.Title, (int)Math.Round(item.Minutes), item.Due, from.UserId, from.Name,
                        LoadMath.Range(hot.Order().ToList()), to.UserId, to.Name, LoadMath.Dow(freeDay), after);
                    break;
                }
                if (pick is not null) break;
            }
            if (pick is null) continue;
            result.Add(pick); taken.Add(pick.ToUserId);
            if (result.Count >= 3) break;
        }
        return result;
    }

    // ------------------------------------------------------------------ building the model (cached per caller until something changes)

    internal async Task<Model> ModelAsync(DateOnly? fromIn, int? daysIn, CancellationToken ct)
    {
        var me = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        var n = daysIn ?? 14;
        if (n is < 1 or > MaxDays) throw new ValidationException("days", $"Choose between 1 and {MaxDays} days.");
        var today = clock.Today;
        var from = fromIn ?? today;
        if (from < today.AddDays(-7) || from > today.AddDays(90)) throw new ValidationException("from", "Choose a start within the next three months.");
        var key = $"{tid:N}:{me:N}:{from:yyyyMMdd}:{n}:{today:yyyyMMdd}";
        if (LoadCache.TryGet(tid, key, clock.Now, out var cached)) return (Model)cached;
        var version = LoadCache.Version(tid);
        var model = await BuildAsync(me, tid, today, from, n, ct);
        LoadCache.Set(tid, key, version, clock.Now, model);
        return model;
    }

    private async Task<HashSet<Guid>> VisibleAsync(Guid me, Guid tid, CancellationToken ct)
    {
        var set = new HashSet<Guid> { me };
        set.UnionWith((await reporting.ReportsOfAsync(me, tid, ct)).Keys);
        if (await permissions.HasBroadReportsAccessAsync(ct))
            set.UnionWith(await db.TenantMembers.AsNoTracking().Where(x => x.TenantId == tid && x.Role != TenantRole.Guest).Select(x => x.UserId).Take(2000).ToListAsync(ct));
        var myTeams = db.TeamMembers.Where(x => x.UserId == me).Select(x => x.TeamId);
        set.UnionWith(await db.TeamMembers.AsNoTracking().Where(x => myTeams.Contains(x.TeamId)).Select(x => x.UserId).Take(2000).ToListAsync(ct));
        return set;
    }

    private async Task<Model> BuildAsync(Guid me, Guid tid, DateOnly today, DateOnly from, int n, CancellationToken ct)
    {
        var end = from.AddDays(n - 1);
        var visible = (await VisibleAsync(me, tid, ct)).ToList();
        var members = await db.TenantMembers.AsNoTracking().Where(x => x.TenantId == tid && x.Role != TenantRole.Guest && visible.Contains(x.UserId))
            .Select(x => new { x.UserId, x.User!.DisplayName, x.WeeklyCapacityMinutes }).ToListAsync(ct);
        var ids = members.Select(x => x.UserId).ToList();
        var model = new Model { From = from, Today = today, Days = n, Me = me };

        var reach = end.AddDays(30);
        var leave = (await db.PlannedLeaves.AsNoTracking().Where(l => ids.Contains(l.UserId) && l.WorkDate >= today.AddDays(-1) && l.WorkDate <= reach)
            .Select(l => new { l.UserId, l.WorkDate }).ToListAsync(ct)).Select(l => (l.UserId, l.WorkDate)).ToHashSet();
        var holidays = await ProjectManagement.Application.Features.Platform.HolidayService.DatesAsync(db, today.AddDays(-7), reach.AddDays(60), ct);
        bool Works(Guid u, DateOnly d) => IsWeekday(d) && !holidays.Contains(d) && !leave.Contains((u, d));

        // Open work.
        var openTasks = await db.Tasks.AsNoTracking()
            .Where(t => t.AssigneeId != null && ids.Contains(t.AssigneeId.Value) && t.CompletedAt == null && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled)
            .Select(t => new { t.Id, t.Title, User = t.AssigneeId!.Value, t.ProjectId, t.StartDate, t.DueDate, t.EstimatedHours, t.ActualHours, t.Size, t.StageId, Active = t.Status!.Category == StatusCategory.Active })
            .Take(10_000).ToListAsync(ct);
        var openWork = await db.WorkTasks.AsNoTracking()
            .Where(w => w.AssigneeId != null && ids.Contains(w.AssigneeId.Value) && w.Status != WorkTaskStatus.Completed && w.Status != WorkTaskStatus.Cancelled)
            .Select(w => new { w.Id, w.Title, User = w.AssigneeId!.Value, w.RelatedProjectId, w.Kind, w.StartDate, w.DueDate, Active = w.Status == WorkTaskStatus.InProgress })
            .Take(10_000).ToListAsync(ct);
        var stageIdsWithTasks = openTasks.Where(t => t.StageId != null).Select(t => (t.StageId!.Value, t.User)).ToHashSet();
        var stages = await db.ProjectStages.AsNoTracking()
            .Where(s => s.AssigneeId != null && ids.Contains(s.AssigneeId.Value) && s.Status != StageStatus.Completed && s.PlannedEnd != null && s.PlannedEnd >= today.AddDays(-30)
                        && (s.PlannedStart == null || s.PlannedStart <= end))
            .Select(s => new { s.Id, s.Name, User = s.AssigneeId!.Value, s.ProjectId, s.PlannedStart, s.PlannedEnd }).Take(2000).ToListAsync(ct);

        // History: calibration (estimated vs logged) and learned medians per person and kind.
        var since = clock.Now.AddDays(-180);
        var doneTasks = await db.Tasks.AsNoTracking().Where(t => t.AssigneeId != null && ids.Contains(t.AssigneeId.Value) && t.CompletedAt != null && t.CompletedAt >= since && t.ActualHours > 0)
            .Select(t => new { User = t.AssigneeId!.Value, t.EstimatedHours, t.ActualHours }).Take(10_000).ToListAsync(ct);
        var doneWorkIds = db.WorkTasks.Where(w => w.AssigneeId != null && ids.Contains(w.AssigneeId.Value) && w.CompletedAt != null && w.CompletedAt >= since).Select(w => w.Id);
        var doneWork = await db.TimeEntries.AsNoTracking().Where(e => e.WorkTaskId != null && doneWorkIds.Contains(e.WorkTaskId.Value))
            .GroupBy(e => new { e.UserId, e.WorkTaskId }).Select(g => new { g.Key.UserId, Minutes = g.Sum(e => e.Minutes) }).Take(10_000).ToListAsync(ct);

        // Meetings (sessions of a series expanded), for the people invited.
        var fromUtc = clock.StartOfDayUtc(from); var toUtc = clock.StartOfDayUtc(end.AddDays(1));
        var floor = fromUtc - ProjectManagement.Application.Features.ProjectMeetings.MeetingRecurrence.LongestSeries;
        var pm = await db.ProjectMeetings.AsNoTracking().Where(x => x.StartTimeUtc < toUtc && (x.StartTimeUtc >= fromUtc || (x.RecurrenceRule != null && x.StartTimeUtc >= floor))
                && x.Status != MeetingStatus.Cancelled && (ids.Contains(x.OrganizerUserId) || x.Participants.Any(p => p.UserId != null && ids.Contains(p.UserId.Value))))
            .Select(x => new { x.Id, x.Title, x.StartTimeUtc, x.EndTimeUtc, x.TimeZone, x.RecurrenceRule, x.OrganizerUserId,
                People = x.Participants.Where(p => p.UserId != null && p.RsvpStatus != AttendeeRsvpStatus.Declined).Select(p => p.UserId!.Value).ToList() })
            .Take(500).ToListAsync(ct);
        var wm = await db.WorkspaceMeetings.AsNoTracking().Where(x => x.StartTimeUtc < toUtc && (x.StartTimeUtc >= fromUtc || (x.RecurrenceRule != null && x.StartTimeUtc >= floor))
                && x.Status != MeetingStatus.Cancelled && x.Attendees.Any(a => ids.Contains(a.UserId)))
            .Select(x => new { x.Id, x.Title, x.StartTimeUtc, x.EndTimeUtc, x.TimeZone, x.RecurrenceRule, x.OrganizerUserId,
                People = x.Attendees.Where(a => a.RsvpStatus != AttendeeRsvpStatus.Declined).Select(a => a.UserId).ToList() })
            .Take(500).ToListAsync(ct);
        var changes = await ProjectManagement.Application.Features.ProjectMeetings.MeetingSessions.ChangesAsync(db,
            pm.Where(x => x.RecurrenceRule != null).Select(x => x.Id).Concat(wm.Where(x => x.RecurrenceRule != null).Select(x => x.Id)), ct);
        var meetingMinutes = new Dictionary<(Guid, DateOnly), List<LoadMeetingDto>>();
        foreach (var x in pm.Select(x => (x.Id, x.Title, x.StartTimeUtc, x.EndTimeUtc, x.TimeZone, x.RecurrenceRule, x.OrganizerUserId, x.People))
                     .Concat(wm.Select(x => (x.Id, x.Title, x.StartTimeUtc, x.EndTimeUtc, x.TimeZone, x.RecurrenceRule, x.OrganizerUserId, x.People))))
        {
            var who = x.People.Append(x.OrganizerUserId).Where(ids.Contains).Distinct().ToList();
            foreach (var se in ProjectManagement.Application.Features.ProjectMeetings.MeetingSessions.Expand(x.RecurrenceRule, x.StartTimeUtc, x.EndTimeUtc, x.TimeZone, changes.GetValueOrDefault(x.Id), fromUtc, toUtc))
            {
                var day = clock.LocalDate(se.Start);
                var minutes = (int)Math.Clamp((se.End - se.Start).TotalMinutes, 0, 600);
                foreach (var u in who)
                {
                    if (!meetingMinutes.TryGetValue((u, day), out var list)) meetingMinutes[(u, day)] = list = new List<LoadMeetingDto>();
                    list.Add(new LoadMeetingDto(se.Title ?? x.Title, se.Start, minutes));
                }
            }
        }

        var thisWeek = TimesheetApprovalService.WeekOf(today);
        var signals = await db.LoadSignals.AsNoTracking().Where(s => ids.Contains(s.UserId) && s.WeekStart == thisWeek)
            .Select(s => new { s.UserId, s.Signal }).ToListAsync(ct);
        var teamRows = await db.TeamMembers.AsNoTracking().Where(t => ids.Contains(t.UserId)).Select(t => new { t.TeamId, t.UserId }).ToListAsync(ct);
        var teamIds = teamRows.Select(t => t.TeamId).Distinct().ToList();
        foreach (var t in await db.Teams.AsNoTracking().Where(t => teamIds.Contains(t.Id)).Select(t => new { t.Id, t.Name }).ToListAsync(ct))
            model.Teams[t.Id] = (t.Name, teamRows.Where(r => r.TeamId == t.Id).Select(r => r.UserId).Distinct().ToList());
        var projectIds = openTasks.Select(t => t.ProjectId).Concat(openWork.Where(w => w.RelatedProjectId != null).Select(w => w.RelatedProjectId!.Value)).Concat(stages.Select(s => s.ProjectId)).Distinct().ToList();
        foreach (var p in await db.Projects.AsNoTracking().Where(p => projectIds.Contains(p.Id)).Select(p => new { p.Id, p.Name }).ToListAsync(ct))
            model.Projects[p.Id] = p.Name;

        foreach (var mem in members)
        {
            var u = mem.UserId;
            var person = new Person
            {
                UserId = u, Name = mem.DisplayName, DailyMinutes = (mem.WeeklyCapacityMinutes ?? CapacityService.StandardWeekMinutes) / 5,
                Signal = signals.FirstOrDefault(s => s.UserId == u)?.Signal,
                Teams = teamRows.Where(r => r.UserId == u).Select(r => r.TeamId).ToList(),
                LeaveAhead = leave.Where(l => l.UserId == u).Select(l => l.WorkDate).ToHashSet(),
            };
            person.Calibration = LoadMath.Calibration(doneTasks.Where(t => t.User == u && t.EstimatedHours > 0).Select(t => ((double)t.EstimatedHours!.Value, (double)t.ActualHours!.Value)));
            var learnedTask = LoadMath.Median(doneTasks.Where(t => t.User == u).Select(t => (double)t.ActualHours!.Value));
            var learnedWork = LoadMath.Median(doneWork.Where(w => w.UserId == u).Select(w => w.Minutes / 60.0));
            for (var i = 0; i < n; i++)
            {
                var d = from.AddDays(i);
                var day = new Day { Date = d, Weekend = !IsWeekday(d), Holiday = holidays.Contains(d), Leave = IsWeekday(d) && !holidays.Contains(d) && leave.Contains((u, d)) };
                day.Working = day.Works ? person.DailyMinutes : 0;
                day.MeetingList = day.Works ? (meetingMinutes.GetValueOrDefault((u, d)) ?? new List<LoadMeetingDto>()).OrderBy(x => x.Start).ToList() : new List<LoadMeetingDto>();
                day.Meetings = Math.Min(day.Working, day.MeetingList.Sum(x => x.Minutes));
                day.Capacity = Math.Max(0, day.Working - day.Meetings);
                person.Days.Add(day);
            }

            void Add(string kind, Guid id, string title, Guid? project, DateOnly? start, DateOnly? due, double hours, string basis, bool calibrate)
            {
                var minutes = Math.Max(0, hours) * 60 * (calibrate ? person.Calibration : 1);
                if (minutes <= 0) return;
                var spread = LoadMath.SpreadDays(today, start, due, d => Works(u, d));
                var item = new Item { Kind = kind, Id = id, Title = title, ProjectId = project, Start = start, Due = due, Minutes = minutes, Basis = basis, Overdue = due is { } dd && dd < today };
                var per = minutes / spread.Count;
                foreach (var d in spread)
                {
                    var idx = d.DayNumber - from.DayNumber;
                    if (idx < 0 || idx >= n) continue;
                    person.Days[idx].Committed += per;
                    item.PerDay[d] = per;
                }
                person.Items.Add(item);
            }

            foreach (var t in openTasks.Where(t => t.User == u))
            {
                double hours; string basis; bool cal = true;
                if (t.EstimatedHours is > 0) { hours = (double)(t.EstimatedHours.Value - (t.ActualHours ?? 0m)); basis = "estimate"; }
                else if (LoadMath.SizeHours(t.Size) is { } sz) { hours = sz - (double)(t.ActualHours ?? 0m); basis = "size"; }
                else if (learnedTask is { } lt) { hours = lt - (double)(t.ActualHours ?? 0m); basis = "learned"; cal = false; }
                else { hours = LoadMath.DefaultHours - (double)(t.ActualHours ?? 0m); basis = "default"; }
                if (hours <= 0 && t.DueDate is { } due0 && due0 >= today) hours = 0.5;   // still open past its estimate: a little time remains
                Add("task", t.Id, t.Title, t.ProjectId, t.StartDate, t.DueDate, hours, basis, cal);
                if (t.Active) person.Wip++;
            }
            foreach (var w in openWork.Where(w => w.User == u))
            {
                var learned = learnedWork;
                Add(w.Kind == WorkTaskKind.ActionItem ? "action" : "work", w.Id, w.Title, w.RelatedProjectId, w.StartDate, w.DueDate,
                    learned ?? LoadMath.DefaultHours, learned is null ? "default" : "learned", learned is null);
                if (w.Active) person.Wip++;
            }
            foreach (var s in stages.Where(s => s.User == u && !stageIdsWithTasks.Contains((s.Id, u))))
                Add("stage", s.Id, s.Name, s.ProjectId, s.PlannedStart, s.PlannedEnd, LoadMath.DefaultHours, "default", true);

            Summarise(model, person);
            model.People[u] = person;
        }
        return model;
    }

    /// <summary>The overall state (this working week), the free hours and the reason line.</summary>
    private static void Summarise(Model m, Person p)
    {
        var week = p.Days.Where(d => d.Date >= m.Today && !d.Weekend && !d.Holiday).Take(5).ToList();
        var working = week.Where(d => !d.Leave).ToList();
        p.Free = (int)Math.Round(p.Days.Sum(d => Math.Max(0, d.Capacity - d.Committed)));
        if (week.Count > 0 && working.Count == 0)
        {
            p.State = LoadMath.Leave; p.Percent = null;
            var off = week.Where(d => d.Leave).Select(d => d.Date).ToList();
            var back = p.Days.FirstOrDefault(d => d.Date > off[^1] && d.Works);
            p.Reason = off.Count >= 5 || back is null ? $"Leave {LoadMath.Range(off)}" : $"On leave until {LoadMath.Dow(back.Date)}";
            return;
        }
        p.Percent = LoadMath.Percent(working.Sum(d => d.Committed), working.Sum(d => d.Capacity));
        var state = LoadMath.State(p.Percent);
        var overDays = working.Count(d => d.State == LoadMath.Overloaded);
        if (overDays >= 2) state = LoadMath.Overloaded;
        else if (overDays == 1 && state is LoadMath.Free or LoadMath.Balanced) state = LoadMath.Stretched;
        p.State = state;

        var parts = new List<string>();
        var clustered = p.Items.Where(i => i.Due is { } d && d >= m.Today && d < m.Today.AddDays(7)).GroupBy(i => i.Due!.Value)
            .Select(g => (Day: g.Key, Count: g.Count())).Where(x => x.Count >= 2).OrderByDescending(x => x.Count).ThenBy(x => x.Day).FirstOrDefault();
        if (clustered.Count >= 2) parts.Add($"{clustered.Count} tasks due {(clustered.Day == m.Today ? "today" : LoadMath.Dow(clustered.Day))}");
        var overdue = p.Items.Count(i => i.Overdue);
        if (overdue >= 2) parts.Add($"{overdue} overdue");
        var meetingHours = (int)Math.Round(week.Sum(d => d.Meetings) / 60.0);
        if (meetingHours >= 1) parts.Add($"{meetingHours}h meetings");
        if (p.Wip >= 3) parts.Add($"{p.Wip} in progress");
        if (parts.Count == 0)
        {
            var leaveAhead = p.Days.Where(d => d.Leave && d.Date >= m.Today).Select(d => d.Date).ToList();
            var nextWeek = p.Days.Where(d => d.Date >= m.Today.AddDays(7) && d.Works).ToList();
            var nextPct = LoadMath.Percent(nextWeek.Sum(d => d.Committed), nextWeek.Sum(d => d.Capacity));
            if (leaveAhead.Count > 0) parts.Add($"Leave {LoadMath.Range(leaveAhead)}");
            else if (state is LoadMath.Stretched or LoadMath.Overloaded && nextPct is { } np && LoadMath.State(np) is LoadMath.Free or LoadMath.Balanced) parts.Add("Eases next week");
            else if (state == LoadMath.Free) parts.Add($"~{(int)Math.Round(working.Sum(d => Math.Max(0, d.Capacity - d.Committed)) / 60.0)} free hours");
            else parts.Add("Steady");
        }
        if (p.Signal == "swamped") parts.Add("says swamped");
        else if (p.Signal == "room") parts.Add("says has room");
        p.Reason = string.Join(" · ", parts.Take(3));
    }
}

/// <summary>
/// Load results per caller, kept until something in the workspace changes (every committed change bumps the workspace's version, the same
/// moment the realtime feed hears of it) or for a minute at most.
/// </summary>
public static class LoadCache
{
    private static readonly ConcurrentDictionary<Guid, long> Versions = new();
    private static readonly ConcurrentDictionary<string, (long Version, DateTime At, object Value)> Entries = new();
    private static readonly TimeSpan Life = TimeSpan.FromSeconds(60);

    public static long Version(Guid tenantId) => Versions.GetValueOrDefault(tenantId);

    public static void Bump(Guid tenantId) => Versions.AddOrUpdate(tenantId, 1, (_, v) => v + 1);

    /// <summary>Called with the change events of a commit.</summary>
    public static void Bump(IEnumerable<ChangeEvent> changes)
    {
        foreach (var t in changes.Select(c => c.TenantId).Distinct()) Bump(t);
    }

    public static bool TryGet(Guid tenantId, string key, DateTime now, out object value)
    {
        value = null!;
        if (!Entries.TryGetValue(key, out var e) || e.Version != Version(tenantId) || now - e.At > Life) return false;
        value = e.Value;
        return true;
    }

    public static void Set(Guid tenantId, string key, long version, DateTime now, object value)
    {
        if (Entries.Count > 5000) Entries.Clear();
        Entries[key] = (version, now, value);
    }
}
