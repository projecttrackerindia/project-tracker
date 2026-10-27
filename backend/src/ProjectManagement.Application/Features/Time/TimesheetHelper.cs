using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Application.Features.Time;

/// <summary>
/// The timesheet helper beyond "Draft my week" (which it offers at every level but Off): when a working day went by with nothing logged
/// (the same moment the timesheet reminder goes out, see <see cref="TimesheetNudgeMonitor"/>), it drafts that day from the person's own
/// changes and comments (<see cref="TimesheetGridService.DraftAsync"/>). At Ask first the draft waits in their Home inbox ("Log 7 h for Tue
/// 3 Nov"); at Auto it is logged straight away and recorded in the AI action log. Suggest leaves it to the reminder and the button. Runs as
/// the person, so every rule of time tracking applies (the week lock, who may log on what). Once per person and day.
/// </summary>
public class TimesheetHelper(IAppDbContext db, ICurrentContext ctx, TimesheetGridService grid, AiAgentGate gate, AiActionLog actionLog)
{
    public const string Note = "Drafted by the timesheet helper";

    /// <summary>What an "Ask first" row carries: the cells to save for one day.</summary>
    public record Proposal(DateOnly WeekStart, DateOnly Day, IReadOnlyList<GridCellChange> Cells);

    /// <summary>Drafts one empty past day of the signed-in person. Returns what it did: "inbox", "logged", or null (nothing to do).</summary>
    public async Task<string?> DraftDayAsync(DateOnly day, CancellationToken ct = default)
    {
        var level = await gate.LevelAsync(AiAgents.Timesheet, ct);
        if (level < AiAgentLevel.AskFirst) return null;
        var me = ctx.RequireUserId();
        var key = day.ToString("yyyy-MM-dd");
        if (await db.AiAgentActions.AsNoTracking().AnyAsync(a => a.Agent == AiAgents.Timesheet && a.TargetId == me && a.TargetKey == key, ct)) return null;
        var week = TimesheetApprovalService.WeekOf(day);
        WeekDraftDto draft;
        try { draft = await grid.DraftAsync(week, ct); }
        catch (AppException) { return null; }   // a locked week, or time tracking not open to them
        var cells = draft.Cells.Where(c => c.Date == day).ToList();
        if (cells.Count == 0) return null;
        var changes = cells.Select(c => new GridCellChange(c.Kind, c.TargetId, c.Date, c.Minutes, Note)).ToList();
        var title = $"Log {Hm(cells.Sum(c => c.Minutes))} for {day:ddd d MMM}: {string.Join(", ", cells.Select(c => c.Key).Take(4))}{(cells.Count > 4 ? $" and {cells.Count - 4} more" : "")}";
        var target = new AiActionLog.Target("timesheet", me, key, null, $"/timesheet?week={week:yyyy-MM-dd}");
        if (level == AiAgentLevel.Auto)
        {
            var saved = await grid.SaveAsync(new SaveGridRequest(week, changes), ct);
            if (saved.Saved == 0) return null;
            actionLog.Applied(AiAgents.Timesheet, "log_time", target, title, null);
            await db.SaveChangesAsync(ct);
            return "logged";
        }
        actionLog.Propose(AiAgents.Timesheet, "log_time", target, title, me, new Proposal(week, day, changes));
        await db.SaveChangesAsync(ct);
        return "inbox";
    }

    /// <summary>Approving the row: the drafted cells are logged - unless the person logged that day themselves meanwhile.</summary>
    public async Task<int> ApplyAsync(Proposal p, CancellationToken ct = default)
    {
        var sheet = await grid.GridAsync(p.WeekStart, null, ct);
        if (sheet.Days.FirstOrDefault(d => d.Date == p.Day) is { Minutes: > 0 })
            throw new ConflictException("You have logged that day yourself since, so the draft was not added.", "DAY_ALREADY_LOGGED");
        var saved = await grid.SaveAsync(new SaveGridRequest(p.WeekStart, p.Cells), ct);
        if (saved.Saved == 0) throw new ConflictException(saved.Errors.FirstOrDefault()?.Message ?? "Nothing could be logged.", "NOTHING_LOGGED");
        return saved.Saved;
    }

    private static string Hm(int minutes) => minutes < 60 ? $"{minutes} min" : minutes % 60 == 0 ? $"{minutes / 60} h" : $"{minutes / 60} h {minutes % 60} min";
}
