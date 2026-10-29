using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.ProjectMeetings;

/// <summary>One session of a meeting: where the rule put it (<see cref="Original"/>) and where it really is, after a "this occurrence" change.</summary>
public readonly record struct MeetingSession(DateTime Start, DateTime End, DateTime Original, string? Title, bool Changed);

/// <summary>
/// A meeting's sessions with its one-off changes applied: a cancelled session is left out, a moved one is where it was moved to (also when it
/// was moved into the window from outside it). Every place that lists sessions (Meet, Calendar, reminders, free/busy, time proposals,
/// reviews) goes through here, so a session changed on its own is the same everywhere.
/// </summary>
public static class MeetingSessions
{
    /// <summary>How far a single session may be moved from where the rule put it.</summary>
    public static readonly TimeSpan MaxMove = TimeSpan.FromDays(31);

    /// <summary>The one-off changes of these meetings, by meeting (one query; none for one-off meetings, which have nothing to change).</summary>
    public static async Task<Dictionary<Guid, List<MeetingOccurrenceChange>>> ChangesAsync(IAppDbContext db, IEnumerable<Guid> meetingIds, CancellationToken ct, bool ignoreFilters = false)
    {
        var ids = meetingIds.Distinct().ToList();
        if (ids.Count == 0) return new Dictionary<Guid, List<MeetingOccurrenceChange>>();
        var q = ignoreFilters ? db.MeetingOccurrenceChanges.IgnoreQueryFilters() : db.MeetingOccurrenceChanges;
        var rows = new List<MeetingOccurrenceChange>();
        foreach (var chunk in ids.Chunk(400))
        {
            var list = chunk.ToList();
            rows.AddRange(await q.AsNoTracking().Where(c => list.Contains(c.MeetingId)).ToListAsync(ct));
        }
        return rows.GroupBy(r => r.MeetingId).ToDictionary(g => g.Key, g => g.ToList());
    }

    /// <summary>The sessions starting in [fromUtc, toUtcExclusive), changes applied, in order.</summary>
    public static IEnumerable<MeetingSession> Expand(string? rule, DateTime firstStartUtc, DateTime firstEndUtc, string timeZone, IReadOnlyList<MeetingOccurrenceChange>? changes,
        DateTime fromUtc, DateTime toUtcExclusive)
    {
        var length = firstEndUtc - firstStartUtc;
        if (length <= TimeSpan.Zero) length = TimeSpan.FromMinutes(30);
        if (changes is not { Count: > 0 })
        {
            foreach (var at in MeetingRecurrence.Occurrences(rule, firstStartUtc, timeZone, fromUtc, toUtcExclusive))
                yield return new MeetingSession(at, at + length, at, null, false);
            yield break;
        }
        var byStart = changes.GroupBy(c => c.OccurrenceStartUtc).ToDictionary(g => g.Key, g => g.First());
        var min = DateTime.SpecifyKind(DateTime.MinValue, DateTimeKind.Utc);
        var padFrom = fromUtc - min > MaxMove ? fromUtc - MaxMove : min;
        var padTo = DateTime.MaxValue - toUtcExclusive > MaxMove ? toUtcExclusive + MaxMove : toUtcExclusive;
        var list = new List<MeetingSession>();
        foreach (var at in MeetingRecurrence.Occurrences(rule, firstStartUtc, timeZone, padFrom, padTo))
        {
            if (byStart.TryGetValue(at, out var c))
            {
                if (c.IsCancelled) continue;
                var s = c.NewStartUtc ?? at;
                var e = c.NewEndUtc ?? s + length;
                if (s >= fromUtc && s < toUtcExclusive) list.Add(new MeetingSession(s, e, at, c.Title, true));
            }
            else if (at >= fromUtc && at < toUtcExclusive) list.Add(new MeetingSession(at, at + length, at, null, false));
        }
        foreach (var s in list.OrderBy(x => x.Start)) yield return s;
    }

    /// <summary>The first session starting after <paramref name="afterUtc"/> (null when the series has ended or it was a one-off meeting).</summary>
    public static MeetingSession? Next(string? rule, DateTime firstStartUtc, DateTime firstEndUtc, string timeZone, IReadOnlyList<MeetingOccurrenceChange>? changes, DateTime afterUtc) =>
        Expand(rule, firstStartUtc, firstEndUtc, timeZone, changes, afterUtc.AddSeconds(1), afterUtc + MeetingRecurrence.LongestSeries).Select(s => (MeetingSession?)s).FirstOrDefault();

    /// <summary>The last session that started at or before <paramref name="atOrBeforeUtc"/>.</summary>
    public static MeetingSession? Previous(string? rule, DateTime firstStartUtc, DateTime firstEndUtc, string timeZone, IReadOnlyList<MeetingOccurrenceChange>? changes, DateTime atOrBeforeUtc) =>
        Expand(rule, firstStartUtc, firstEndUtc, timeZone, changes, firstStartUtc.AddDays(-31), atOrBeforeUtc.AddSeconds(1)).Select(s => (MeetingSession?)s).LastOrDefault();

    /// <summary>"p:{id}" or "w:{id}".</summary>
    public static string Ref(bool workspace, Guid id) => $"{(workspace ? "w" : "p")}:{id}";

    /// <summary>Reads "p:{id}" / "w:{id}".</summary>
    public static bool TryParseRef(string? text, out bool workspace, out Guid id)
    {
        workspace = false; id = Guid.Empty;
        if (string.IsNullOrWhiteSpace(text) || text.Length < 3 || text[1] != ':') return false;
        var k = char.ToLowerInvariant(text[0]);
        if (k is not ('p' or 'w') || !Guid.TryParse(text[2..], out id)) return false;
        workspace = k == 'w';
        return true;
    }
}
