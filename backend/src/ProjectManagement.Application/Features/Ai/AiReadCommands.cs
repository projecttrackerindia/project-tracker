using System.Text.RegularExpressions;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>Anchored single-intent queries. Compound requests remain with the reasoning agent.</summary>
public static class AiReadCommands
{
    public sealed record PersonTasks(string Person, int Page);
    private static readonly Regex Current = new(@"^which tasks? (?:is|are) (?:currently )?(?<person>[^?\r\n]{1,150}?) (?:currently )?doing\s*\??$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
    private static readonly Regex List = new(@"^(?:show|list)(?: open)? tasks for (?<person>[^?\r\n]{1,150}?)(?: page (?<page>\d{1,3}))?\s*\??$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
    public static PersonTasks? Tasks(string text)
    {
        if (Regex.IsMatch(text, @"\b(and|then|also)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)) return null;
        var match = Current.Match(text.Trim());
        if (!match.Success) match = List.Match(text.Trim());
        if (!match.Success) return null;
        var page = match.Groups["page"].Success ? int.Parse(match.Groups["page"].Value) : 1;
        return page is >= 1 and <= 251 ? new(match.Groups["person"].Value.Trim(), page) : null;
    }
}
