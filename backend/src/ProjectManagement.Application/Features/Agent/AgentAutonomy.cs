using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.ProjectMeetings;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Agent;

/// <summary>
/// How much the project agent may do by itself. Each level adds to the one before; changes to existing work (dates, status, owners, tickets)
/// always wait for a person, whatever the level - the agent may propose them, never decide them.
/// </summary>
public static class AgentAutonomy
{
    /// <summary>Takes notes, writes the minutes, proposes; silent in meetings apart from its hello.</summary>
    public const int Observer = 1;
    /// <summary>Also posts short reminders in the meeting chat when something important is being missed.</summary>
    public const int Assistant = 2;
    /// <summary>Also answers questions in the meeting chat from the tracker (status, owner, dates, what is late), by key and first name only.</summary>
    public const int Participant = 3;
    /// <summary>Also carries out safe proposals by itself when they are grounded and it is confident enough.</summary>
    public const int Delegate = 4;

    /// <summary>The kinds that may ever be carried out without a person: they add something new, never change what exists.</summary>
    public static readonly AgentFindingKind[] Safe =
        [AgentFindingKind.CreateActionItem, AgentFindingKind.CreateTask, AgentFindingKind.CreateIssue, AgentFindingKind.Decision, AgentFindingKind.Suggestion, AgentFindingKind.Missed];

    public static readonly AgentFindingKind[] DefaultAuto = [AgentFindingKind.CreateActionItem, AgentFindingKind.Decision, AgentFindingKind.Suggestion, AgentFindingKind.Missed];

    public static int Level(int value) => Math.Clamp(value, Observer, Delegate);

    public static IReadOnlyList<AgentFindingKind> Kinds(string? csv) =>
        csv is null ? DefaultAuto
        : csv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(k => Enum.TryParse<AgentFindingKind>(k, true, out var kind) ? kind : (AgentFindingKind?)null)
            .Where(k => k is { } x && Safe.Contains(x)).Select(k => k!.Value).Distinct().ToList();

    /// <summary>Validates a choice of kinds (only safe ones) and writes it as stored.</summary>
    public static string KindsCsv(IEnumerable<string> kinds)
    {
        var list = new List<AgentFindingKind>();
        foreach (var k in kinds)
        {
            if (!Enum.TryParse<AgentFindingKind>(k, true, out var kind) || !Safe.Contains(kind))
                throw new ValidationException("autoApplyKinds", $"\"{k}\" cannot be carried out without a person: only new items and notes can.");
            if (!list.Contains(kind)) list.Add(kind);
        }
        return string.Join(',', list);
    }

    public static bool Reminds(ProjectAgentSettings s) => Level(s.AutonomyLevel) >= Assistant;
    public static bool Answers(ProjectAgentSettings s) => Level(s.AutonomyLevel) >= Participant;

    /// <summary>Whether this proposal may be carried out without waiting: level 4, a safe kind the lead allowed, grounded, confident enough, and new work has an owner.</summary>
    public static bool MayAutoApply(ProjectAgentSettings s, AgentFinding f) =>
        Level(s.AutonomyLevel) >= Delegate && f.Status == AgentFindingStatus.Proposed && f.CommitmentId is null && f.Grounded
        && f.Confidence >= Math.Clamp(s.AutoApplyConfidence, 50, 100) && Kinds(s.AutoApplyKinds).Contains(f.Kind)
        && (f.Kind is not (AgentFindingKind.CreateTask or AgentFindingKind.CreateActionItem or AgentFindingKind.CreateIssue) || f.AssigneeId is not null);
}

/// <summary>One session of a project meeting (a recurring meeting has many).</summary>
public record MeetingSession(ProjectMeeting Meeting, DateTime Start, DateTime End);

public static class AgentSessions
{
    /// <summary>The sessions of these project meetings (scheduled, with a Meet link) that overlap [from, to).</summary>
    public static async Task<List<MeetingSession>> ListAsync(IQueryable<ProjectMeeting> meetings, DateTime fromUtc, DateTime toUtc, CancellationToken ct, int take = 100)
    {
        var floor = fromUtc - MeetingRecurrence.LongestSeries;
        var rows = await meetings.AsNoTracking().Where(m => m.Status == MeetingStatus.Scheduled && m.GoogleMeetUri != ""
                && m.StartTimeUtc < toUtc && (m.RecurrenceRule != null ? m.StartTimeUtc >= floor : m.StartTimeUtc >= fromUtc.AddDays(-1)))
            .OrderBy(m => m.StartTimeUtc).Take(take).ToListAsync(ct);
        var sessions = new List<MeetingSession>();
        foreach (var m in rows)
        {
            var length = m.EndTimeUtc - m.StartTimeUtc;
            foreach (var at in MeetingRecurrence.Occurrences(m.RecurrenceRule, m.StartTimeUtc, m.TimeZone, fromUtc - length, toUtc))
                if (at + length > fromUtc && at < toUtc) sessions.Add(new MeetingSession(m, at, at + length));
        }
        return sessions.OrderBy(x => x.Start).ToList();
    }

    /// <summary>The session of a meeting that starts at this instant (a minute either way), or null.</summary>
    public static async Task<MeetingSession?> FindAsync(IAppDbContext db, Guid meetingId, DateTime startUtc, CancellationToken ct)
    {
        var sessions = await ListAsync(db.ProjectMeetings.Where(m => m.Id == meetingId), startUtc.AddMinutes(-1), startUtc.AddMinutes(1), ct, 1);
        return sessions.FirstOrDefault(x => Math.Abs((x.Start - startUtc).TotalSeconds) < 61);
    }

    public static string FirstName(string? name) => string.IsNullOrWhiteSpace(name) ? "someone" : name.Split(' ', StringSplitOptions.RemoveEmptyEntries)[0];
}
