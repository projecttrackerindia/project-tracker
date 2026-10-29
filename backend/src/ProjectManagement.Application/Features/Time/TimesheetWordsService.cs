using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.Voice;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Time;

public record ParseTimeWordsRequest(string? Text);
/// <summary>Something time can go to: a project task ("task") or operational work / an action item ("work").</summary>
public record TimeTargetDto(string Kind, Guid TargetId, string Key, string Title, string? ProjectName);
/// <summary>
/// One entry read from plain words, for the person to check before it is logged. <see cref="Match"/> says how the work was found: "key"
/// (its key was written), "title" (the words match its title), "ai" (the assistant picked it) or "none" (choose it from
/// <see cref="Options"/> or search). <see cref="Problem"/> is what still needs fixing (how long, a key nobody can see, a future day).
/// </summary>
public record ParsedTimeEntryDto(string Text, int Minutes, DateOnly Date, TimeTargetDto? Target, string? Note, string Match, IReadOnlyList<TimeTargetDto> Options, string? Problem);
/// <summary>The entries read from the words; <see cref="Transcript"/> is what was heard when they came from a voice note.</summary>
public record ParsedTimeDto(string Text, IReadOnlyList<ParsedTimeEntryDto> Entries, int DayMinutes, bool UsedAi, string? Model, string? Transcript = null, string? Language = null);
public record LogTimeWordsEntry(string Kind, Guid TargetId, DateOnly Date, int Minutes, string? Note);
public record LogTimeWordsRequest(IReadOnlyList<LogTimeWordsEntry>? Entries);
/// <summary>What was logged; each entry that could not be (a locked week, a full day, work that is not yours) comes back as an error.</summary>
public record LogTimeWordsResult(int Saved, int Minutes, IReadOnlyList<TimeEntryDto> Entries, IReadOnlyList<GridCellError> Errors);

/// <summary>
/// "2h on PAY-12 yesterday, 30m standup": time written (or said) in plain words becomes entries to check, each matched to the work it
/// was spent on - by its key, by the words of its title against what the person logged lately, is assigned or worked on, or by the
/// assistant when the words need it (other languages, no key, no clear match). Nothing is logged until the person confirms the list, and
/// then every rule of time tracking still applies.
/// </summary>
public class TimesheetWordsService(IAppDbContext db, ICurrentContext ctx, AppClock clock, TimeService time, TimesheetGridService grid, ProjectAccess access,
    PermissionService permissions, DocumentAiService ai, VoiceSpeechService speech, Recorder recorder)
{
    public const int MaxEntries = 40;
    private const int MaxOptions = 6;
    private const int MaxVoiceBytes = 12 * 1024 * 1024;

    private sealed record Cand(string Kind, Guid Id, string Key, string Title, string? ProjectName, int Weight)
    {
        public TimeTargetDto Dto => new(Kind, Id, Key, Title, ProjectName);
    }

    // ------------------------------------------------------------------ read the words

    public async Task<ParsedTimeDto> ParseAsync(ParseTimeWordsRequest req, CancellationToken ct = default)
    {
        var text = (req.Text ?? "").Trim();
        if (text.Length == 0) throw new ValidationException("text", "Write what you worked on, like “2h on PAY-12 yesterday, 30m standup”.");
        if (text.Length > TimeWords.MaxText) throw new ValidationException("text", $"Keep it under {TimeWords.MaxText} characters.");
        return await ReadAsync(text, null, null, ct);
    }

    /// <summary>A voice note (WAV) of the same: what was heard, read the same way.</summary>
    public async Task<ParsedTimeDto> VoiceAsync(Stream content, long length, CancellationToken ct = default)
    {
        ctx.RequireUserId();
        if (length > MaxVoiceBytes) throw new ValidationException("file", "Keep it under about five minutes.");
        if (!speech.Configured) throw new ConflictException("Speech to text is not set up on this server, so type it instead.", "VOICE_NOT_CONFIGURED");
        using var ms = new MemoryStream();
        await content.CopyToAsync(ms, ct);
        var bytes = ms.ToArray();
        if (bytes.Length < 44 || Encoding.ASCII.GetString(bytes, 0, 4) != "RIFF" || Encoding.ASCII.GetString(bytes, 8, 4) != "WAVE")
            throw new ValidationException("file", "Send the recording as a WAV file.");
        var heard = await speech.TranscribeAsync(bytes, "audio/wav", ct);
        if (heard is not { } h || string.IsNullOrWhiteSpace(h.Text))
            throw new ValidationException("file", "No words came through. Try again a little closer to the microphone.");
        var said = h.Text.Trim();
        if (said.Length > TimeWords.MaxText) said = said[..TimeWords.MaxText];
        return await ReadAsync(said, said, h.Language, ct);
    }

    private async Task<ParsedTimeDto> ReadAsync(string text, string? transcript, string? language, CancellationToken ct)
    {
        var me = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        var today = clock.Today;
        var capacity = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.UserId == me).Select(m => m.WeeklyCapacityMinutes).FirstOrDefaultAsync(ct)
                       ?? CapacityService.StandardWeekMinutes;
        var day = (int)Math.Round(capacity / 5m);
        var pieces = TimeWords.Parse(text, today, day).Take(MaxEntries).ToList();

        var pool = await PoolAsync(today, pieces.SelectMany(p => TimeWords.Words(p.Rest)).Distinct().Take(6).ToList(), ct);
        var entries = new List<ParsedTimeEntryDto>();
        foreach (var p in pieces) entries.Add(await MatchAsync(p, pool, ct));

        // The assistant reads it again when the rules could not: nothing understood, a piece without a time or without its work, or
        // writing in another script. Its reading is kept only when it finds more.
        var usedAi = false; string? model = null;
        var needsHelp = entries.Count == 0 || entries.Any(e => e.Target is null || e.Minutes == 0) || Regex.IsMatch(text, @"[ऀ-ॿఀ-౿]");
        if (needsHelp && await AiReadAsync(text, today, day, pool, ct) is { } read)
        {
            static int Score(IReadOnlyList<ParsedTimeEntryDto> list) => list.Count(e => e.Minutes > 0 && e.Target is not null) * 2 + list.Count(e => e.Minutes > 0);
            if (read.Entries.Count > 0 && Score(read.Entries) > Score(entries)) { entries = read.Entries.Take(MaxEntries).ToList(); usedAi = true; model = read.Model; }
        }
        return new ParsedTimeDto(text, entries, day, usedAi, model, transcript, language);
    }

    /// <summary>
    /// The work the words are most likely about: what the person logged in the last two weeks, what the week grid suggests (their timer,
    /// assigned work, what they changed this week), and tasks or work whose titles contain the words written.
    /// </summary>
    private async Task<List<Cand>> PoolAsync(DateOnly today, List<string> words, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var pool = new Dictionary<(string, Guid), Cand>();
        void Add(Cand c) { if (!pool.TryGetValue((c.Kind, c.Id), out var had) || had.Weight < c.Weight) pool[(c.Kind, c.Id)] = had is null ? c : c with { ProjectName = c.ProjectName ?? had.ProjectName }; }

        var recent = await time.TimesheetAsync(today.AddDays(-13), today, null, ct);
        var projectIds = recent.Entries.Where(e => e.ProjectId != null).Select(e => e.ProjectId!.Value).Distinct().ToList();
        var names = projectIds.Count == 0 ? new Dictionary<Guid, string>() : await db.Projects.AsNoTracking().Where(p => projectIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => p.Name, ct);
        foreach (var g in recent.Entries.Where(e => e.Kind != "meeting").GroupBy(e => (e.Kind, Target: TimesheetGridService.TargetOf(e))).OrderByDescending(g => g.Sum(e => e.Minutes)))
        {
            var e = g.First();
            Add(new Cand(g.Key.Kind, g.Key.Target, e.TaskKey, e.TaskTitle, e.ProjectId is { } pid ? names.GetValueOrDefault(pid) : null, 3));
        }
        var week = await grid.GridAsync(null, null, ct);
        foreach (var s in week.Suggestions) Add(new Cand(s.Kind, s.TargetId, s.Key, s.Title, s.ProjectName, 2));

        var since = clock.Now.AddDays(-30);
        var seesWork = await permissions.LevelAsync(Modules.Work, ct) > 0;
        foreach (var word in words.Where(w => w.Length >= 3).Take(4))
        {
            var tasks = await access.VisibleTasks().AsNoTracking()
                .Where(t => (t.CompletedAt == null || t.CompletedAt > since) && t.Project!.Status != ProjectStatus.Archived && t.Title.ToLower().Contains(word))
                .OrderByDescending(t => t.AssigneeId == me).ThenByDescending(t => t.UpdatedAt ?? t.CreatedAt).Take(8)
                .Select(t => new { t.Id, t.Number, t.Title, Key = t.Project!.Key, Name = t.Project.Name }).ToListAsync(ct);
            foreach (var t in tasks) Add(new Cand("task", t.Id, $"{t.Key}-{t.Number}", t.Title, t.Name, 1));
            var work = await db.WorkTasks.AsNoTracking()
                .Where(w => (w.CompletedAt == null || w.CompletedAt > since) && (w.AssigneeId == me || w.ReporterId == me) && (w.Kind == WorkTaskKind.ActionItem || seesWork)
                            && w.Title.ToLower().Contains(word))
                .OrderByDescending(w => w.UpdatedAt ?? w.CreatedAt).Take(6).Select(w => new { w.Id, w.Kind, w.Number, w.Title }).ToListAsync(ct);
            foreach (var w in work) Add(new Cand("work", w.Id, WorkItemService.KeyOf(w.Kind, w.Number), w.Title, null, 1));
        }
        return pool.Values.OrderByDescending(c => c.Weight).Take(60).ToList();
    }

    private async Task<ParsedTimeEntryDto> MatchAsync(TimePiece p, List<Cand> pool, CancellationToken ct)
    {
        var note = string.IsNullOrWhiteSpace(p.Rest) ? null : p.Rest;
        if (p.Key is { } key)
        {
            var found = pool.FirstOrDefault(c => string.Equals(c.Key, key, StringComparison.OrdinalIgnoreCase)) ?? await FindKeyAsync(key, ct);
            if (found is not null)
                return new ParsedTimeEntryDto(p.Text, p.Minutes, p.Date, found.Dto, note, "key", Options(pool, found, []), p.Problem);
            // A key nobody can see: try the rest of the words, and say so if they do not find it either.
            var byWords = Best(pool, TimeWords.Words(p.Rest));
            return new ParsedTimeEntryDto(p.Text, p.Minutes, p.Date, byWords?.Dto, note, byWords is null ? "none" : "title", Options(pool, byWords, TimeWords.Words(p.Rest)),
                p.Problem ?? $"There is no {key} that you can see.");
        }
        var words = TimeWords.Words(p.Rest);
        var best = Best(pool, words);
        return new ParsedTimeEntryDto(p.Text, p.Minutes, p.Date, best?.Dto, note, best is null ? "none" : "title", Options(pool, best, words),
            p.Problem ?? (best is null ? "Which work was it? Choose it below." : null));
    }

    /// <summary>A task by its key ("PAY-12"), or a piece of work ("WT-3", "AI-7"), when the person can see it.</summary>
    private async Task<Cand?> FindKeyAsync(string key, CancellationToken ct)
    {
        var dash = key.LastIndexOf('-');
        if (dash <= 0 || !int.TryParse(key[(dash + 1)..], NumberStyles.None, CultureInfo.InvariantCulture, out var number)) return null;
        var prefix = key[..dash].ToUpperInvariant();
        var task = await access.VisibleTasks().AsNoTracking().Where(t => t.Project!.Key.ToUpper() == prefix && t.Number == number)
            .Select(t => new { t.Id, t.Title, Name = t.Project!.Name }).FirstOrDefaultAsync(ct);
        if (task is not null) return new Cand("task", task.Id, $"{prefix}-{number}", task.Title, task.Name, 0);
        if (prefix is not ("WT" or "AI")) return null;
        var me = ctx.RequireUserId();
        var actionItem = prefix == "AI";
        var seesWork = await permissions.LevelAsync(Modules.Work, ct) > 0;
        if (!actionItem && !seesWork) return null;
        var work = await db.WorkTasks.AsNoTracking()
            .Where(w => w.Number == number && (actionItem ? w.Kind == WorkTaskKind.ActionItem : w.Kind != WorkTaskKind.ActionItem)
                        && (seesWork || w.AssigneeId == me || w.ReporterId == me))
            .Select(w => new { w.Id, w.Kind, w.Title }).FirstOrDefaultAsync(ct);
        return work is null ? null : new Cand("work", work.Id, WorkItemService.KeyOf(work.Kind, number), work.Title, null, 0);
    }

    /// <summary>The candidate whose title shares the most of the words (at least half of them, or two), the most familiar on a tie.</summary>
    private static Cand? Best(List<Cand> pool, List<string> words)
    {
        if (words.Count == 0) return null;
        return pool.Select(c => (Cand: c, Hits: Hits(c, words)))
            .Where(x => x.Hits > 0 && (x.Hits * 2 >= words.Count || x.Hits >= 2))
            .OrderByDescending(x => x.Hits).ThenByDescending(x => x.Cand.Weight).ThenBy(x => x.Cand.Title.Length)
            .Select(x => x.Cand).FirstOrDefault();
    }

    private static int Hits(Cand c, List<string> words)
    {
        var tokens = Regex.Split(c.Title.ToLowerInvariant(), @"[^\p{L}\p{M}\p{N}]+").Where(t => t.Length > 0).ToList();
        var squashed = string.Concat(tokens);
        var key = c.Key.ToLowerInvariant();
        return words.Count(w => tokens.Any(t => t == w || (w.Length >= 4 && t.Length >= 4 && (t.StartsWith(w, StringComparison.Ordinal) || w.StartsWith(t, StringComparison.Ordinal))))
                                || (w.Length >= 5 && squashed.Contains(w, StringComparison.Ordinal)) || w == key);
    }

    /// <summary>What else it could be: the closest titles first, then what the person works on most.</summary>
    private static List<TimeTargetDto> Options(List<Cand> pool, Cand? chosen, List<string> words)
    {
        var list = new List<Cand>();
        if (chosen is not null) list.Add(chosen);
        if (words.Count > 0)
            list.AddRange(pool.Select(c => (c, h: Hits(c, words))).Where(x => x.h > 0).OrderByDescending(x => x.h).ThenByDescending(x => x.c.Weight).Select(x => x.c));
        list.AddRange(pool.OrderByDescending(c => c.Weight));
        return list.DistinctBy(c => (c.Kind, c.Id)).Take(MaxOptions).Select(c => c.Dto).ToList();
    }

    private sealed record AiRead(List<ParsedTimeEntryDto> Entries, string Model);

    /// <summary>The assistant's reading, or null when it is not available here (not set up, not in the plan, out of credits) or failed.</summary>
    private async Task<AiRead?> AiReadAsync(string text, DateOnly today, int day, List<Cand> pool, CancellationToken ct)
    {
        try { await ai.EnsureAiAsync(ct); } catch (AppException) { return null; }
        var list = pool.Take(40).ToList();
        var items = new StringBuilder();
        for (var i = 0; i < list.Count; i++) items.AppendLine($"{i + 1}. {list[i].Key} {list[i].Title}{(list[i].ProjectName is { } pn ? $" ({pn})" : "")}");
        var system = "You turn what someone wrote or said about the time they worked into timesheet entries. Today is " +
                     today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + " (" + today.DayOfWeek + "). Their normal working day is " + day + " minutes. " +
                     "Reply with a JSON array only: [{\"minutes\":120,\"date\":\"yyyy-mm-dd\",\"ref\":3,\"note\":\"short note or empty\",\"text\":\"the words this entry comes from\"}]. " +
                     "ref is the number of the work item in the list the time was spent on, or null when none fits. Only use minutes the words give (a full day or half " +
                     "day counts); leave out anything that says no duration. Dates are never after today; \"kal\" and \"ninna\" mean yesterday. The words may be in " +
                     "English, Hindi or Telugu, in any script; write notes in English, under 12 words.";
        string answerText; string model;
        try
        {
            var answer = await ai.AskModelAsync("time_words", system, $"Work items:\n{items}\nWhat they wrote:\n{text}", 900, 1, ct);
            answerText = answer.Text; model = answer.Model;
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception) { return null; }

        var entries = new List<ParsedTimeEntryDto>();
        try
        {
            var json = answerText.Trim();
            var start = json.IndexOf('['); var end = json.LastIndexOf(']');
            if (start < 0 || end <= start) return null;
            using var doc = JsonDocument.Parse(json[start..(end + 1)]);
            foreach (var e in doc.RootElement.EnumerateArray().Take(MaxEntries))
            {
                if (e.ValueKind != JsonValueKind.Object) continue;
                var minutes = e.TryGetProperty("minutes", out var m) && m.ValueKind == JsonValueKind.Number && m.TryGetInt32(out var mv) ? mv : 0;
                if (minutes is <= 0 or > 24 * 60) continue;
                var date = e.TryGetProperty("date", out var d) && d.ValueKind == JsonValueKind.String
                           && DateOnly.TryParseExact(d.GetString(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var dv) ? dv : today;
                if (date > today || date < today.AddDays(-62)) date = today;
                Cand? target = e.TryGetProperty("ref", out var r) && r.ValueKind == JsonValueKind.Number && r.TryGetInt32(out var rv) && rv >= 1 && rv <= list.Count ? list[rv - 1] : null;
                var note = e.TryGetProperty("note", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString()?.Trim() : null;
                if (note is { Length: > 300 }) note = note[..300];
                var said = e.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString()?.Trim() : null;
                var words = TimeWords.Words(note ?? said ?? "");
                entries.Add(new ParsedTimeEntryDto(string.IsNullOrEmpty(said) ? text : said.Length > 300 ? said[..300] : said, minutes, date, target?.Dto,
                    string.IsNullOrEmpty(note) ? null : note, target is null ? "none" : "ai", Options(list, target, words),
                    target is null ? "Which work was it? Choose it below." : null));
            }
        }
        catch (JsonException) { return null; }
        recorder.Audit("ai.used", "Time", null, null, new { feature = "time_words", entries = entries.Count });
        await db.SaveChangesAsync(ct);
        return new AiRead(entries, model);
    }

    // ------------------------------------------------------------------ log what was confirmed

    /// <summary>Logs the confirmed entries, each as a new entry of its own. One that cannot be logged is reported and the rest still go in.</summary>
    public async Task<LogTimeWordsResult> LogAsync(LogTimeWordsRequest req, CancellationToken ct = default)
    {
        ctx.RequireUserId();
        var list = req.Entries ?? [];
        if (list.Count == 0) throw new ValidationException("entries", "Nothing to log.");
        if (list.Count > MaxEntries) throw new ValidationException("entries", $"Log at most {MaxEntries} entries at once.");
        var saved = new List<TimeEntryDto>();
        var errors = new List<GridCellError>();
        foreach (var e in list)
        {
            if (e.Kind is not ("task" or "work")) { errors.Add(new GridCellError(e.Kind ?? "", e.TargetId, e.Date, "Choose the work it was spent on.")); continue; }
            if (e.Minutes is <= 0 or > 24 * 60) { errors.Add(new GridCellError(e.Kind, e.TargetId, e.Date, "Enter between 1 minute and 24 hours.")); continue; }
            var note = string.IsNullOrWhiteSpace(e.Note) ? null : e.Note.Trim();
            if (note is { Length: > 500 }) note = note[..500];
            try
            {
                var log = new LogTimeRequest(e.Minutes, e.Date, note);
                saved.Add(e.Kind == "work" ? await time.LogOnWorkTaskAsync(e.TargetId, log, ct) : await time.LogAsync(e.TargetId, log, ct));
            }
            catch (AppException ex) { errors.Add(new GridCellError(e.Kind, e.TargetId, e.Date, ex.Message)); }
        }
        return new LogTimeWordsResult(saved.Count, saved.Sum(s => s.Minutes), saved, errors);
    }
}
