using System.Globalization;
using System.Text.RegularExpressions;

namespace ProjectManagement.Application.Features.Reminders;

/// <summary>A promise someone made in their own words, and when to remind them of it (local time in their zone).</summary>
public record Promise(string Title, DateTime LocalAt, string Quote);

/// <summary>
/// Finds the promises a person makes in what they write ("I'll send the estimate by Friday", "will share the deck tomorrow", "kal tak bhej
/// dunga", "repu pampistanu") and when they fall due. Rules only, no AI call: it runs on every message the person sends. A promise needs both
/// a first-person commitment and a time; questions and refusals ("I won't", "can't") are ignored. The reminder is set for the morning of the
/// day it is due (at their usual reminder time), or a little before a deadline later today, so there is still time to keep it.
/// </summary>
public static class PromiseDetector
{
    private const RegexOptions Opt = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;
    private static readonly TimeSpan Limit = TimeSpan.FromMilliseconds(100);

    // A first-person commitment: English, plus the everyday Hindi and Telugu (romanised) future forms people type in chat.
    private static readonly Regex Commit = new(
        @"(?<![\w'])(?:i'?ll|i\s+will|i\s+shall|i'?m\s+going\s+to|i\s+am\s+going\s+to|let\s+me|i\s+can|will\s+(?=(?:send|share|do|update|fix|call|check|get|finish|submit|review|deploy|raise|prepare|complete|close|reply|revert|mail|email|upload|book|pay|look)\b))"
        + @"|(?:\w+\s+)?(?:dunga|dungi|doonga|doongi|karunga|karungi|karoonga|bhejunga|bhejungi|bhej\s+dunga|kar\s+dunga|kar\s+dungi|de\s+dunga|chestanu|chesthanu|pamputanu|pampistanu|pampisthanu|cheptanu|cheppesthanu|istanu|isthanu)\b",
        Opt, Limit);
    private static readonly Regex Refusal = new(@"\b(?:i\s+won'?t|i\s+will\s+not|i\s+can'?t|i\s+cannot|i\s+can\s+not|won'?t\s+be\s+able|not\s+able\s+to)\b", Opt, Limit);
    private static readonly Regex Sentence = new(@"[^.!?\n]+[.!?]?", Opt, Limit);

    private static readonly string[] Days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    private const string DayRe = @"(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|sday|nesday|rsday|urday)?";
    private const string MonthRe = @"(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?";

    private sealed record When(Regex Pattern, Func<Match, DateTime, TimeOnly, DateTime?> At);

    private static DateTime Day(DateTime local, int addDays, TimeOnly time) => local.Date.AddDays(addDays) + time.ToTimeSpan();

    /// <summary>Monday = 1 ... Sunday = 7.</summary>
    private static int IsoDay(DateTime d) => ((int)d.DayOfWeek + 6) % 7 + 1;

    private static DateTime? Weekday(Match m, DateTime now, TimeOnly time)
    {
        var dow = Array.FindIndex(Days, d => d.StartsWith(m.Groups["d"].Value[..3].ToLowerInvariant(), StringComparison.Ordinal));
        if (dow < 0) return null;
        int ahead;
        if (m.Groups["next"].Success)
        {
            // "next Friday": the Friday of next week.
            var toNextMonday = 8 - IsoDay(now);
            ahead = toNextMonday + (dow + 6) % 7;
        }
        else ahead = (dow - (int)now.DayOfWeek + 7) % 7;
        var at = Day(now, ahead, time);
        if (at > now) return at;
        // Due today and the usual morning time has passed: remind within the hour, so it still helps.
        return ahead == 0 && now.Hour < 20 ? now.AddHours(1) : Day(now, ahead + 7, time);
    }

    private static DateTime? Dated(int year, int month, int day, DateTime now, TimeOnly time, bool yearGiven)
    {
        if (month is < 1 or > 12 || day < 1 || day > DateTime.DaysInMonth(year, month)) return null;
        var at = new DateTime(year, month, day) + time.ToTimeSpan();
        if (at <= now && !yearGiven && at.Date < now.Date) at = at.AddYears(1);
        return at;
    }

    private static readonly string[] Months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    private static int MonthOf(string w) => Array.IndexOf(Months, w[..3].ToLowerInvariant()) + 1;

    private static readonly When[] Times =
    [
        // Later today: a deadline today is reminded an hour before it is usually missed (4 pm), or within the hour when that has passed.
        new(new(@"\b(?:by\s+|before\s+)?(?:eod|end\s+of\s+(?:the\s+)?day|today|tonight|this\s+evening|aaj(?:\s+hi)?|ee\s+roju|ivala|ee\s+saayantram)\b", Opt, Limit),
            (_, now, _) => now.Hour < 15 ? now.Date.AddHours(16) : now.Hour < 21 ? now.AddMinutes(45) : null),
        new(new(@"\b(?:day\s+after\s+tomorrow|parso|ellundi)\b", Opt, Limit), (_, now, t) => Day(now, 2, t)),
        new(new(@"\b(?:by\s+|before\s+)?(?:tomorrow|tmrw|tmr|kal|repu|reppu)(?:\s+(?:morning|evening|eod|tak|lopu))?\b", Opt, Limit), (_, now, t) => Day(now, 1, t)),
        new(new(@"\b(?:by\s+|before\s+)?(?:end\s+of\s+(?:the\s+)?week|eow|this\s+week)\b", Opt, Limit), (_, now, t) =>
        {
            var friday = Day(now, (5 - (int)now.DayOfWeek + 7) % 7, t);
            return friday > now ? friday : now.AddHours(1);
        }),
        new(new(@"\bnext\s+week\b", Opt, Limit), (_, now, t) => Day(now, 8 - IsoDay(now), t)),
        new(new(@"\bin\s+(?<n>\d{1,2}|an?|one|two|three)\s*(?<u>hours?|hrs?|days?)\b", Opt, Limit), (m, now, t) =>
        {
            var n = m.Groups["n"].Value.ToLowerInvariant() switch { "a" or "an" or "one" => 1, "two" => 2, "three" => 3, var v => int.Parse(v, CultureInfo.InvariantCulture) };
            if (n is < 1 or > 30) return null;
            if (!m.Groups["u"].Value.StartsWith("h", StringComparison.OrdinalIgnoreCase)) return Day(now, n, t);
            var before = now.AddHours(n).AddMinutes(-30);   // half an hour before the promised time
            return before > now.AddMinutes(10) ? before : now.AddMinutes(20);
        }),
        new(new($@"\b(?:by\s+|before\s+|on\s+|this\s+|(?<next>next)\s+)?(?<d>{DayRe})\b", Opt, Limit), Weekday),
        new(new($@"\b(?:by\s+|before\s+|on\s+)?(?:the\s+)?(?<day>\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?(?<m>{MonthRe})(?:\s+(?<y>\d{{4}}))?\b", Opt, Limit),
            (m, now, t) => Dated(m.Groups["y"].Success ? int.Parse(m.Groups["y"].Value, CultureInfo.InvariantCulture) : now.Year, MonthOf(m.Groups["m"].Value), int.Parse(m.Groups["day"].Value, CultureInfo.InvariantCulture), now, t, m.Groups["y"].Success)),
        new(new($@"\b(?:by\s+|before\s+|on\s+)?(?<m>{MonthRe})\s+(?<day>\d{{1,2}})(?:st|nd|rd|th)?\b", Opt, Limit),
            (m, now, t) => Dated(now.Year, MonthOf(m.Groups["m"].Value), int.Parse(m.Groups["day"].Value, CultureInfo.InvariantCulture), now, t, false)),
        new(new(@"\b(?:by|before|on)\s+the\s+(?<day>\d{1,2})(?:st|nd|rd|th)\b", Opt, Limit), (m, now, t) =>
        {
            var d = int.Parse(m.Groups["day"].Value, CultureInfo.InvariantCulture);
            return Dated(now.Year, now.Month, d, now, t, true) is { } at && at.Date >= now.Date ? at : now.Month == 12 ? Dated(now.Year + 1, 1, d, now, t, true) : Dated(now.Year, now.Month + 1, d, now, t, true);
        }),
    ];

    private static readonly Regex Trailing = new(@"(?:\s+(?:by|before|on|until|till|tak|lopu))*[\s,;:.!]*$", Opt, Limit);
    /// <summary>Where an English promise starts ("Ravi, I'll share the deck" is about sharing the deck).</summary>
    private static readonly Regex EnglishStart = new(@"(?<![\w'])(?:i'?ll|i\s+will|i\s+shall|i'?m\s+going\s+to|i\s+am\s+going\s+to|let\s+me|i\s+can)\b", Opt, Limit);
    private static readonly Regex Lead = new(@"^\s*(?:(?:ok(?:ay)?|sure|yes|yeah|ya|haan|ha|sare|sari|done|noted|fine|alright|got\s+it|will\s+do)[,!.]?\s+)*(?:i'?ll|i\s+will|i\s+shall|i'?m\s+going\s+to|i\s+am\s+going\s+to|let\s+me|i\s+can|will)?\s*", Opt, Limit);

    /// <summary>
    /// When a due date written in words falls ("2026-11-05", "Friday", "tomorrow", "next week", "5 Nov"), as the morning to remind on.
    /// Meeting minutes carry action items' due dates as they were said; this reads them the same way a chat promise is read.
    /// </summary>
    public static DateTime? DueFrom(string? said, DateTime now, TimeOnly usualTime)
    {
        if (string.IsNullOrWhiteSpace(said) || said.Length > 60) return null;
        if (DateOnly.TryParseExact(said.Trim(), ["yyyy-MM-dd", "dd/MM/yyyy", "d/M/yyyy", "dd-MM-yyyy"], CultureInfo.InvariantCulture, DateTimeStyles.None, out var d))
        {
            var at = d.ToDateTime(usualTime);
            return at > now ? at : d == DateOnly.FromDateTime(now) && now.Hour < 20 ? now.AddHours(1) : null;
        }
        try
        {
            foreach (var w in Times)
                if (w.Pattern.Match(said) is { Success: true } m) return w.At(m, now, usualTime) is { } at && at > now && at <= now.AddDays(120) ? at : null;
        }
        catch (RegexMatchTimeoutException) { }
        return null;
    }

    private static readonly Regex QuoteHeader = new(@"^\s*(?:on\s.{4,200}\swrote:|-{2,}\s*(?:original\s+message|forwarded\s+message)\s*-{2,}|from:\s.+)\s*$", Opt | RegexOptions.Multiline, Limit);

    /// <summary>What the writer wrote themselves: an email reply's quoted thread ("On Mon, Ravi wrote:", lines starting with "&gt;") and signature are left out, so other people's promises are not taken as theirs.</summary>
    public static string OwnWords(string text)
    {
        try
        {
            var cut = QuoteHeader.Match(text);
            if (cut.Success) text = text[..cut.Index];
        }
        catch (RegexMatchTimeoutException) { }
        var sig = text.IndexOf("\n-- \n", StringComparison.Ordinal);
        if (sig >= 0) text = text[..sig];
        return string.Join('\n', text.Split('\n').Where(l => !l.TrimStart().StartsWith('>')));
    }

    /// <summary>The promises in a message, at most three. <paramref name="now"/> is the writer's local time.</summary>
    public static IReadOnlyList<Promise> Find(string? text, DateTime now, TimeOnly usualTime)
    {
        if (string.IsNullOrWhiteSpace(text) || text.Length > 8000) return [];
        var found = new List<Promise>();
        try
        {
            foreach (Match s in Sentence.Matches(text))
            {
                var sentence = s.Value.Trim();
                if (sentence.Length < 8 || sentence.EndsWith('?') || !Commit.IsMatch(sentence) || Refusal.IsMatch(sentence)) continue;
                DateTime? at = null; Match? used = null;
                foreach (var w in Times)
                {
                    var m = w.Pattern.Match(sentence);
                    if (!m.Success) continue;
                    at = w.At(m, now, usualTime); used = m;
                    break;
                }
                if (at is null || used is null || at <= now || at > now.AddDays(120)) continue;
                var title = Regex.Replace(sentence[..used.Index] + " " + sentence[(used.Index + used.Length)..], @"\s+", " ", Opt, Limit).Trim();
                if (EnglishStart.Match(title) is { Success: true, Index: > 0 } start) title = title[start.Index..];
                title = Lead.Replace(title, "", 1);
                title = Trailing.Replace(title, "").Trim();
                if (title.Length < 3) continue;
                title = char.ToUpperInvariant(title[0]) + title[1..];
                if (title.Length > 120) title = title[..117] + "…";
                found.Add(new Promise(title, at.Value, sentence.Length > 280 ? sentence[..277] + "…" : sentence));
                if (found.Count == 3) break;
            }
        }
        catch (RegexMatchTimeoutException) { return found; }
        return found;
    }
}
