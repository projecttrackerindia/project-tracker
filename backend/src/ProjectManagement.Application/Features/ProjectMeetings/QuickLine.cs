using System.Globalization;
using System.Text.RegularExpressions;

namespace ProjectManagement.Application.Features.ProjectMeetings;

/// <summary>What one typed line says: the title, who it is for ("@ravi") and when it is due ("fri", "tomorrow", "7 nov", "+3d").</summary>
public sealed record QuickLineResult(string Title, string? OwnerToken, DateOnly? Due, string? DateToken);

/// <summary>
/// The one-line capture "Confirm bank sandbox date @Ravi fri", shared by the meeting page's capture line and Aura's capture_action_item,
/// so both read a line the same way (the screens mirror it in quickLine.ts to show the chips while typing). Only words it is sure of are
/// taken out of the title; everything else stays.
/// </summary>
public static partial class QuickLine
{
    private static readonly string[] Days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    private static readonly string[] Months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

    [GeneratedRegex(@"^@([\p{L}\p{N}._'-]{1,60})$")]
    private static partial Regex OwnerRx();
    [GeneratedRegex(@"^\+?(\d{1,3})d$")]
    private static partial Regex PlusDaysRx();
    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}$")]
    private static partial Regex IsoRx();

    public static QuickLineResult Parse(string? text, DateOnly today)
    {
        var words = (text ?? "").Trim().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).ToList();
        string? owner = null; DateOnly? due = null; string? dateToken = null;
        var keep = new bool[words.Count];
        for (var i = 0; i < words.Count; i++) keep[i] = true;

        for (var i = 0; i < words.Count; i++)
        {
            if (!keep[i]) continue;
            var w = words[i];
            var m = OwnerRx().Match(w.TrimEnd(',', '.', ';'));
            if (owner is null && m.Success) { owner = m.Groups[1].Value; keep[i] = false; continue; }
            if (due is not null) continue;
            var lower = w.Trim(',', '.', ';').ToLowerInvariant();
            var next = i + 1 < words.Count ? words[i + 1].Trim(',', '.', ';').ToLowerInvariant() : null;
            var next2 = i + 2 < words.Count ? words[i + 2].Trim(',', '.', ';').ToLowerInvariant() : null;
            int used;
            var d = DateAt(lower, next, next2, today, out used);
            if (d is null) continue;
            due = d; dateToken = string.Join(" ", words.Skip(i).Take(used));
            for (var k = i; k < i + used; k++) keep[k] = false;
            // "due fri", "by tomorrow": the little word before the date goes too.
            if (i > 0 && keep[i - 1] && words[i - 1].ToLowerInvariant() is "due" or "by" or "on") keep[i - 1] = false;
        }
        var title = string.Join(" ", words.Where((_, i) => keep[i])).Trim().TrimEnd(',', ';', '-', '·').Trim();
        return new QuickLineResult(title, owner, due, dateToken);
    }

    private static DateOnly? DateAt(string w, string? next, string? next2, DateOnly today, out int used)
    {
        used = 1;
        switch (w)
        {
            case "today": case "tod": case "eod": return today;
            case "tomorrow": case "tmr": case "tmrw": case "tom": return today.AddDays(1);
            case "eow": return NextDay(today, DayOfWeek.Friday, allowToday: true);
            case "next" when next is "week": used = 2; return NextDay(today, DayOfWeek.Monday, allowToday: false);
            case "in" when next is not null && int.TryParse(next, out var n) && n is > 0 and < 366 && next2 is "day" or "days": used = 3; return today.AddDays(n);
            case "in" when next is not null && int.TryParse(next, out var wk) && wk is > 0 and < 53 && next2 is "week" or "weeks": used = 3; return today.AddDays(7 * wk);
        }
        if (PlusDaysRx().Match(w) is { Success: true } plus && w.StartsWith('+')) return today.AddDays(int.Parse(plus.Groups[1].Value, CultureInfo.InvariantCulture));
        if (IsoRx().IsMatch(w) && DateOnly.TryParseExact(w, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var iso)) return iso;
        var day = DayIndex(w);
        if (day >= 0) return NextDay(today, (DayOfWeek)day, allowToday: false);
        // "7 nov" / "nov 7" / "7th nov"
        if (int.TryParse(w.TrimEnd('s', 't', 'n', 'd', 'r', 'h'), out var dom) && dom is >= 1 and <= 31 && next is not null && MonthIndex(next) is var mi && mi > 0) { used = 2; return InYear(today, mi, dom); }
        if (MonthIndex(w) is var mj && mj > 0 && next is not null && int.TryParse(next.TrimEnd('s', 't', 'n', 'd', 'r', 'h'), out var dom2) && dom2 is >= 1 and <= 31) { used = 2; return InYear(today, mj, dom2); }
        return null;
    }

    private static int DayIndex(string w)
    {
        if (w.Length < 3) return -1;
        var i = Array.IndexOf(Days, w[..3]);
        if (i < 0) return -1;
        var full = CultureInfo.InvariantCulture.DateTimeFormat.DayNames[i].ToLowerInvariant();
        return full.StartsWith(w, StringComparison.Ordinal) || w is "tues" or "thur" or "thurs" ? i : -1;
    }

    private static int MonthIndex(string w)
    {
        if (w.Length < 3) return 0;
        var i = Array.IndexOf(Months, w[..3]);
        if (i < 0) return 0;
        var full = CultureInfo.InvariantCulture.DateTimeFormat.MonthNames[i].ToLowerInvariant();
        return full.StartsWith(w, StringComparison.Ordinal) || w == "sept" ? i + 1 : 0;
    }

    private static DateOnly? InYear(DateOnly today, int month, int day)
    {
        if (day > DateTime.DaysInMonth(today.Year, month) && day > DateTime.DaysInMonth(today.Year + 1, month)) return null;
        var d = new DateOnly(today.Year, month, Math.Min(day, DateTime.DaysInMonth(today.Year, month)));
        // A date already well past this year means next year ("3 jan" said in December).
        return d < today.AddDays(-30) ? new DateOnly(today.Year + 1, month, Math.Min(day, DateTime.DaysInMonth(today.Year + 1, month))) : d;
    }

    /// <summary>The next such weekday after today (today itself only when <paramref name="allowToday"/>): "fri" said on a Friday means next Friday.</summary>
    public static DateOnly NextDay(DateOnly today, DayOfWeek day, bool allowToday)
    {
        var diff = ((int)day - (int)today.DayOfWeek + 7) % 7;
        if (diff == 0 && !allowToday) diff = 7;
        return today.AddDays(diff);
    }

    /// <summary>
    /// The person "@ravi" means among <paramref name="people"/>: the full name without spaces, a first name, first name and last initial
    /// ("ravim"), or the only name starting with it. Null when nobody matches; more than one match is <paramref name="ambiguous"/>.
    /// </summary>
    public static Guid? ResolveOwner(string token, IEnumerable<(Guid Id, string Name)> people, out bool ambiguous)
    {
        ambiguous = false;
        var t = token.Trim().TrimStart('@').ToLowerInvariant().Replace(".", "").Replace("_", "").Replace("-", "");
        if (t.Length == 0) return null;
        var list = people.Where(p => !string.IsNullOrWhiteSpace(p.Name)).DistinctBy(p => p.Id).ToList();
        static string Squash(string s) => new(s.ToLowerInvariant().Where(char.IsLetterOrDigit).ToArray());
        foreach (var rule in new Func<(Guid Id, string Name), bool>[]
        {
            p => Squash(p.Name) == t,
            p => Squash(p.Name.Split(' ', StringSplitOptions.RemoveEmptyEntries)[0]) == t,
            p => p.Name.Split(' ', StringSplitOptions.RemoveEmptyEntries) is { Length: > 1 } n && Squash(n[^1]) is { Length: > 0 } last && Squash(n[0]) + last[..1] == t,
            p => Squash(p.Name).StartsWith(t, StringComparison.Ordinal),
        })
        {
            var hits = list.Where(rule).ToList();
            if (hits.Count == 1) return hits[0].Id;
            if (hits.Count > 1) { ambiguous = true; return null; }
        }
        return null;
    }
}
