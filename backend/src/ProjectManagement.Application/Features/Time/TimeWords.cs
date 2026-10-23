using System.Globalization;
using System.Text.RegularExpressions;

namespace ProjectManagement.Application.Features.Time;

/// <summary>
/// One piece of what someone wrote about their time, before it is matched to work: "2h on PAY-12 yesterday" gives 120 minutes, yesterday,
/// the key PAY-12 and no note; "30m standup" gives 30 minutes, the day carried over from the piece before, and "standup" as the words to
/// match. <see cref="Problem"/> says what is missing (how long, or a day that has not happened yet).
/// </summary>
public sealed record TimePiece(string Text, int Minutes, DateOnly Date, bool DateSaid, string? Key, string Rest, string? Problem);

/// <summary>
/// Reads time written in plain words, without AI, so it works on every server: durations ("2h", "1.5 hours", "1h 30m", "90 min", "1:30",
/// "half an hour", "an hour and a half", "full day", "10am to 12", "2 ghante", "3 gantalu"), days ("today", "yesterday", "day before
/// yesterday", "monday", "last fri", "3 days ago", "12 oct", "12/10", "2026-10-12", "kal", "ninna"), and work keys ("PAY-12", "WT-3",
/// "AI-7"). Pieces are separated by commas, semicolons, new lines, "then", "plus" or - when both sides say how long - "and". A piece that
/// names no day takes the day of the piece before it (or the only day said anywhere, or today).
/// </summary>
public static class TimeWords
{
    public const int MaxText = 2000;
    public const int MaxPieces = 30;

    private const RegexOptions Opts = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;
    // Word edges that work for Latin, Devanagari and Telugu alike (\b does not treat vowel signs as part of a word).
    private const string L = @"(?<![\p{L}\p{M}\p{N}])";
    private const string R = @"(?![\p{L}\p{M}\p{N}])";

    private const string HourWord = "h|hr|hrs|hour|hours|ghanta|ghante|ghanton|ganta|gantalu|gantha|ganthalu|घंटा|घंटे|घण्टे|गंटे|గంట|గంటలు|గంటల";
    private const string MinWord = "m|min|mins|minute|minutes|minat|minut|nimishalu|nimishaalu|मिनट|నిమిషాలు|నిమిషాల|నిమిషం";
    private static readonly Regex Hours = new($@"{L}(\d+(?:[.,]\d+)?)\s*(?:{HourWord})(?![\p{{L}}\p{{M}}])(?:\s*(?:and\s+)?(\d{{1,2}})\s*(?:{MinWord})?{R})?", Opts);
    private static readonly Regex Minutes = new($@"{L}(\d+)\s*(?:{MinWord}){R}", Opts);
    private static readonly Regex Clock = new($@"(?<!(?:at|by|from|till|until)\s+){L}(\d{{1,2}}):([0-5]\d){R}(?!\s*(?:am|pm|a\.m\.|p\.m\.|-|–|to\s+\d))", Opts);
    private static readonly Regex Range = new(
        $@"{L}(?:from\s+)?(\d{{1,2}})(?:[:.]([0-5]\d))?\s*(am|pm)?\s*(?:-|–|to|till|until)\s*(\d{{1,2}})(?:[:.]([0-5]\d))?\s*(am|pm)?{R}", Opts);

    private static readonly (Regex Re, string To)[] Normal =
    [
        (new($@"{L}(?:an?|one)\s+hour\s+and\s+a\s+half{R}", Opts), "1.5 hours"),
        (new($@"{L}(?:half\s+an?\s+hour|half[\s-]hour|aadha\s+ghanta|ara\s+ganta|अाधा\s+घंटा|आधा\s+घंटा|అర\s+గంట){R}", Opts), "30 min"),
        (new($@"{L}(?:(?:a\s+)?quarter\s+(?:of\s+)?an?\s+hour|quarter[\s-]hour){R}", Opts), "15 min"),
        (new($@"{L}(?:an?|one|ek|oka)\s+(hour|ghanta|ganta){R}", Opts), "1 $1"),
        (new($@"{L}(?:a\s+)?couple\s+(?:of\s+)?hours{R}", Opts), "2 hours"),
    ];
    private static readonly Regex AndAHalf = new($@"{L}(\d+|one|two|three|four|five|six|seven|eight)\s+and\s+a\s+half\s+(?:hours?|hrs?){R}", Opts);
    private static readonly Dictionary<string, int> NumberWords = new(StringComparer.OrdinalIgnoreCase)
    {
        ["one"] = 1, ["two"] = 2, ["three"] = 3, ["four"] = 4, ["five"] = 5, ["six"] = 6, ["seven"] = 7, ["eight"] = 8, ["nine"] = 9, ["ten"] = 10,
        ["eleven"] = 11, ["twelve"] = 12, ["fifteen"] = 15, ["twenty"] = 20, ["thirty"] = 30, ["forty"] = 40, ["forty-five"] = 45, ["fortyfive"] = 45,
        ["do"] = 2, ["teen"] = 3, ["char"] = 4, ["paanch"] = 5, ["rendu"] = 2, ["moodu"] = 3, ["naalugu"] = 4, ["aidu"] = 5,
    };
    private static readonly Regex NumberWord = new($@"{L}(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty-five|fortyfive|forty|do|teen|char|paanch|rendu|moodu|naalugu|aidu)\s+((?:{HourWord}|{MinWord})){R}", Opts);
    private static readonly Regex FullDay = new($@"{L}(?:the\s+)?(?:full|whole|entire|all)[\s-]+(?:the\s+)?day{R}|{L}all\s+day{R}|{L}poora\s+din{R}|{L}roju\s+antha{R}", Opts);
    private static readonly Regex HalfDay = new($@"{L}half\s+(?:a\s+)?day{R}|{L}half-day{R}|{L}aadha\s+din{R}", Opts);

    private static readonly Regex Key = new(@"(?<![\p{L}\p{N}-])([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,7})(?![\p{L}\p{N}-])", RegexOptions.CultureInvariant);

    private static readonly Regex Splitter = new(@"[,;\n]+|\s+(?:and\s+then|then|also|plus|&|\+)\s+|\s*\|\s*|\s+\.\s+|(?<=[\p{L}\p{N}])\.\s+(?=\S)", Opts);
    private static readonly Regex And = new(@"\s+and\s+|\s+aur\s+|\s+mariyu\s+", Opts);

    private static readonly string[] Months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    private static readonly string[] Weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    private static readonly Regex DayBefore = new($@"{L}(?:day\s+before\s+yesterday|parso|monna|परसों|మొన్న){R}", Opts);
    private static readonly Regex Yesterday = new($@"{L}(?:yesterday|yday|last\s+night|kal|kall|ninna|kal\s+ka\s+din|कल|నిన్న){R}", Opts);
    private static readonly Regex Today = new($@"{L}(?:today|this\s+(?:morning|afternoon|evening)|tonight|earlier\s+today|so\s+far\s+today|aaj|ivala|ivvala|ee\s+roju|eeroju|आज|ఈరోజు|ఈ\s+రోజు|ఇవాళ){R}", Opts);
    private static readonly Regex Ago = new($@"{L}(\d{{1,2}}|one|two|three|four|five|six|seven)\s+days?\s+ago{R}", Opts);
    private static readonly Regex Weekday = new($@"{L}(?:(last|this|past|on)\s+)?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat){R}", Opts);
    private static readonly Regex Iso = new($@"{L}(\d{{4}})-(\d{{2}})-(\d{{2}}){R}", Opts);
    private static readonly Regex DayMonth = new($@"{L}(\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?{R}", Opts);
    private static readonly Regex MonthDay = new($@"{L}(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?{R}", Opts);
    private static readonly Regex Slash = new($@"{L}(\d{{1,2}})/(\d{{1,2}})(?:/(\d{{2,4}}))?{R}", Opts);

    private static readonly Regex Filler = new(
        $@"^(?:\s|[-:–—.]|{L}(?:i|we|have|had|spent|spend|worked|work|working|logged|log|did|doing|done|on|for|in|at|with|was|were|about|around|roughly|approx|approximately|nearly|almost|the|of|to|ki|ka|ke|par|pe|lo|meeda|pani){R})+|(?:\s|[-:–—.]|{L}(?:on|for|in|at|with|the|of|to|was|ki|ka|ke|par|pe|lo|meeda|ni|chesanu|kiya|kiye){R})+$", Opts);

    /// <summary>Splits and reads <paramref name="text"/>. <paramref name="dayMinutes"/> is the person's normal day, for "full day".</summary>
    public static List<TimePiece> Parse(string? text, DateOnly today, int dayMinutes)
    {
        var all = Normalise((text ?? "").Trim(), dayMinutes);
        if (all.Length > MaxText) all = all[..MaxText];
        var parts = new List<string>();
        foreach (var raw in Splitter.Split(all).Select(s => s.Trim()).Where(s => s.Length > 0))
        {
            // "2h on PAY-12 and 30m standup": an "and" between two pieces that each say how long splits them; "PAY-12 and PAY-13" does not.
            var halves = And.Split(raw).Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
            if (halves.Count > 1 && halves.Count(h => FindDuration(h) is not null) >= 2)
            {
                var current = "";
                foreach (var h in halves)
                {
                    if (current.Length > 0 && FindDuration(h) is not null && FindDuration(current) is not null) { parts.Add(current); current = h; }
                    else current = current.Length == 0 ? h : current + " and " + h;
                }
                if (current.Length > 0) parts.Add(current);
            }
            else parts.Add(raw);
        }

        var read = parts.Take(MaxPieces).Select(p => ReadPiece(p, today)).ToList();
        // A piece that is only a day ("Yesterday:") sets the day for the ones after it.
        var said = read.Where(r => r.Date is not null).Select(r => r.Date!.Value).Distinct().ToList();
        DateOnly? carry = null;
        var result = new List<TimePiece>();
        foreach (var r in read)
        {
            if (r.Date is { } d) carry = d;
            if (r.Minutes is null && r.Key is null && r.Rest.Length == 0) continue;   // nothing but a day (or nothing at all)
            var date = r.Date ?? carry ?? (said.Count == 1 ? said[0] : today);
            string? problem = r.Minutes is null ? "How long? Add a time like 2h, 45m or 1:30." : r.Minutes > 24 * 60 ? "That is more than 24 hours." : null;
            if (problem is null && date > today) problem = "That day has not happened yet.";
            result.Add(new TimePiece(r.Text, Math.Clamp(r.Minutes ?? 0, 0, 24 * 60), date, r.Date is not null, r.Key, r.Rest, problem));
        }
        return result;
    }

    private sealed record Read(string Text, int? Minutes, DateOnly? Date, string? Key, string Rest);

    private static Read ReadPiece(string piece, DateOnly today)
    {
        var rest = " " + piece + " ";
        // The key first, so its number is never read as a time or a day ("PAY-1 oct 12" is not 1 October).
        string? key = null;
        var k = Key.Match(rest);
        if (k.Success) { key = $"{k.Groups[1].Value.ToUpperInvariant()}-{int.Parse(k.Groups[2].Value, CultureInfo.InvariantCulture)}"; rest = rest.Remove(k.Index, k.Length).Insert(k.Index, " "); }
        int? minutes = null;
        if (FindDuration(rest) is { } d) { minutes = d.Minutes; rest = rest.Remove(d.Index, d.Length).Insert(d.Index, " "); }
        DateOnly? date = null;
        if (FindDate(rest, today) is { } dt) { date = dt.Date; rest = rest.Remove(dt.Index, dt.Length).Insert(dt.Index, " "); }
        return new Read(piece.Trim(), minutes, date, key, Tidy(rest));
    }

    /// <summary>The words left once the time, day and key are taken out, without the "spent", "on", "for" around them.</summary>
    public static string Tidy(string rest)
    {
        var s = Regex.Replace(rest, @"\s+", " ").Trim();
        for (var i = 0; i < 4; i++)
        {
            var next = Filler.Replace(s, "").Trim();
            if (next == s) break;
            s = next;
        }
        s = s.Trim(' ', '-', ':', '–', '—', '.', '(', ')', '"', '\'');
        return s.Length > 300 ? s[..300] : s;
    }

    private static string Normalise(string text, int dayMinutes)
    {
        var s = text.Replace(' ', ' ');
        foreach (var (re, to) in Normal) s = re.Replace(s, to);
        s = AndAHalf.Replace(s, m => (int.TryParse(m.Groups[1].Value, CultureInfo.InvariantCulture, out var n) ? n : NumberWords[m.Groups[1].Value]).ToString(CultureInfo.InvariantCulture) + ".5 hours");
        s = NumberWord.Replace(s, m => $"{NumberWords[m.Groups[1].Value]} {m.Groups[2].Value}");
        var day = Math.Clamp(dayMinutes, 60, 16 * 60);
        s = FullDay.Replace(s, $"{day} min");
        s = HalfDay.Replace(s, $"{day / 2} min");
        return s;
    }

    private sealed record Found(int Index, int Length, int Minutes);
    private sealed record FoundDate(int Index, int Length, DateOnly Date);

    /// <summary>The first duration in the text: hours (with minutes), minutes, h:mm, or a clock range ("10am to 12", "from 2 to 4:30").</summary>
    private static Found? FindDuration(string text)
    {
        var best = new List<Found>();
        var h = Hours.Match(text);
        if (h.Success && double.TryParse(h.Groups[1].Value.Replace(',', '.'), NumberStyles.Float, CultureInfo.InvariantCulture, out var hours) && hours > 0)
        {
            var extra = h.Groups[2].Success ? int.Parse(h.Groups[2].Value, CultureInfo.InvariantCulture) : 0;
            best.Add(new Found(h.Index, h.Length, (int)Math.Round(hours * 60) + extra));
        }
        var m = Minutes.Match(text);
        if (m.Success && int.TryParse(m.Groups[1].Value, CultureInfo.InvariantCulture, out var mins) && mins > 0) best.Add(new Found(m.Index, m.Length, mins));
        var c = Clock.Match(text);
        if (c.Success)
        {
            var total = int.Parse(c.Groups[1].Value, CultureInfo.InvariantCulture) * 60 + int.Parse(c.Groups[2].Value, CultureInfo.InvariantCulture);
            if (total > 0) best.Add(new Found(c.Index, c.Length, total));
        }
        var r = Range.Match(text);
        if (r.Success && (r.Groups[3].Success || r.Groups[6].Success || r.Groups[2].Success || r.Groups[5].Success || r.Value.TrimStart().StartsWith("from", StringComparison.OrdinalIgnoreCase)))
        {
            var start = ClockMinutes(r.Groups[1].Value, r.Groups[2].Value, r.Groups[3].Success ? r.Groups[3].Value : null);
            var end = ClockMinutes(r.Groups[4].Value, r.Groups[5].Value, r.Groups[6].Success ? r.Groups[6].Value : null);
            if (start is { } s0 && end is { } e0)
            {
                // "10am to 1" is 1 pm; "11 to 2" is 11 am to 2 pm; "2 to 4pm" is 2 pm to 4 pm: the shortest reading that moves forward.
                var span = Enumerable.Range(0, 3).SelectMany(a => Enumerable.Range(0, 3).Select(b => (e0 + b * 12 * 60) - (s0 + a * 12 * 60)))
                    .Where(x => x > 0 && x <= 16 * 60)
                    .Where(x => !r.Groups[3].Success || !r.Groups[6].Success || x == e0 - s0)
                    .DefaultIfEmpty(0).Min();
                if (span > 0) best.Add(new Found(r.Index, r.Length, span));
            }
        }
        // Prefer a clock range over the "12" inside it, then whatever comes first.
        return best.OrderBy(f => f.Index).ThenByDescending(f => f.Length).FirstOrDefault();
    }

    private static int? ClockMinutes(string hour, string minute, string? ampm)
    {
        if (!int.TryParse(hour, CultureInfo.InvariantCulture, out var h) || h > 24) return null;
        var m = string.IsNullOrEmpty(minute) ? 0 : int.Parse(minute, CultureInfo.InvariantCulture);
        if (ampm is not null)
        {
            if (h is < 1 or > 12) return null;
            var pm = ampm.StartsWith("p", StringComparison.OrdinalIgnoreCase);
            h = h % 12 + (pm ? 12 : 0);
        }
        return h * 60 + m;
    }

    /// <summary>The first day named in the text (the most recent one in the past for a weekday or a date without a year).</summary>
    private static FoundDate? FindDate(string text, DateOnly today)
    {
        var found = new List<FoundDate>();
        void Add(Match m, DateOnly d) { if (m.Success) found.Add(new FoundDate(m.Index, m.Length, d)); }

        var db = DayBefore.Match(text); if (db.Success) Add(db, today.AddDays(-2));
        var y = Yesterday.Match(text); if (y.Success && !(db.Success && y.Index >= db.Index && y.Index < db.Index + db.Length)) Add(y, today.AddDays(-1));
        var t = Today.Match(text); if (t.Success) Add(t, today);
        var a = Ago.Match(text);
        if (a.Success)
        {
            var n = int.TryParse(a.Groups[1].Value, CultureInfo.InvariantCulture, out var v) ? v : NumberWords.GetValueOrDefault(a.Groups[1].Value);
            if (n is > 0 and <= 60) Add(a, today.AddDays(-n));
        }
        var w = Weekday.Match(text);
        if (w.Success)
        {
            var target = Array.FindIndex(Weekdays, p => w.Groups[2].Value.StartsWith(p, StringComparison.OrdinalIgnoreCase));
            var back = ((int)today.DayOfWeek - target + 7) % 7;
            if (back == 0 && w.Groups[1].Value.Equals("last", StringComparison.OrdinalIgnoreCase)) back = 7;
            Add(w, today.AddDays(-back));
        }
        var iso = Iso.Match(text);
        if (iso.Success && TryDate(int.Parse(iso.Groups[1].Value, CultureInfo.InvariantCulture), int.Parse(iso.Groups[2].Value, CultureInfo.InvariantCulture), int.Parse(iso.Groups[3].Value, CultureInfo.InvariantCulture)) is { } isoDate)
            Add(iso, isoDate);
        var dm = DayMonth.Match(text);
        if (dm.Success && Recent(today, MonthOf(dm.Groups[2].Value), int.Parse(dm.Groups[1].Value, CultureInfo.InvariantCulture)) is { } dmDate) Add(dm, dmDate);
        var md = MonthDay.Match(text);
        if (md.Success && Recent(today, MonthOf(md.Groups[1].Value), int.Parse(md.Groups[2].Value, CultureInfo.InvariantCulture)) is { } mdDate) Add(md, mdDate);
        var sl = Slash.Match(text);
        if (sl.Success)
        {
            // Day first, as written in India: 12/10 is 12 October.
            var day = int.Parse(sl.Groups[1].Value, CultureInfo.InvariantCulture); var month = int.Parse(sl.Groups[2].Value, CultureInfo.InvariantCulture);
            DateOnly? date = sl.Groups[3].Success
                ? TryDate(YearOf(sl.Groups[3].Value), month, day)
                : Recent(today, month, day);
            if (date is { } slDate) Add(sl, slDate);
        }
        return found.OrderBy(f => f.Index).ThenByDescending(f => f.Length).FirstOrDefault();
    }

    private static int MonthOf(string name) => Array.FindIndex(Months, p => name.StartsWith(p, StringComparison.OrdinalIgnoreCase)) + 1;
    private static int YearOf(string y) { var n = int.Parse(y, CultureInfo.InvariantCulture); return n < 100 ? 2000 + n : n; }
    private static DateOnly? TryDate(int year, int month, int day) =>
        month is >= 1 and <= 12 && day >= 1 && day <= DateTime.DaysInMonth(Math.Clamp(year, 1, 9999), month) && year is >= 2000 and <= 2100 ? new DateOnly(year, month, day) : null;
    /// <summary>The day and month in this year, or last year when this year's is still to come.</summary>
    private static DateOnly? Recent(DateOnly today, int month, int day) => TryDate(today.Year, month, day) is { } d && d <= today ? d : TryDate(today.Year - 1, month, day);

    /// <summary>The words of a note worth matching against titles (no short or common words), lower case.</summary>
    public static List<string> Words(string text) =>
        Regex.Split(text.ToLowerInvariant(), @"[^\p{L}\p{M}\p{N}]+").Where(w => w.Length >= 3 && !Stop.Contains(w)).Distinct().Take(8).ToList();

    private static readonly HashSet<string> Stop = new(StringComparer.OrdinalIgnoreCase)
    {
        "the", "and", "for", "with", "on", "of", "to", "in", "at", "was", "were", "did", "done", "doing", "worked", "working", "work", "spent", "logged",
        "some", "more", "about", "from", "into", "that", "this", "time", "task", "tasks", "item", "call", "calls", "also", "then", "had", "have", "has",
        "our", "my", "team", "today", "yesterday", "morning", "evening", "afternoon",
    };
}
