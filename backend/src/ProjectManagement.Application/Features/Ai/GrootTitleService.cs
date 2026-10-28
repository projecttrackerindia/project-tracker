using System.Text.RegularExpressions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Documents;

namespace ProjectManagement.Application.Features.Ai;

public record GrootTitleRequest(string? Text, string? Kind);
public record GrootTitleDto(string Title, bool Ai);

/// <summary>
/// A short title for something described in a long paragraph (+ New): Groot writes one when AI is on; otherwise, and whenever the model is not
/// available, the first sentence up to 120 characters. The full text always stays in the description, so nothing typed is lost.
/// </summary>
public partial class GrootTitleService(DocumentAiService ai)
{
    public const int MaxTitle = 120;

    public async Task<GrootTitleDto> SuggestAsync(GrootTitleRequest req, CancellationToken ct = default)
    {
        var text = (req.Text ?? "").Trim();
        if (text.Length == 0) throw new ValidationException("text", "Write what it is about first.");
        if (text.Length > 20_000) throw new ValidationException("text", "Keep it under 20,000 characters.");
        var fallback = FirstSentence(text);
        try { await ai.EnsureAiAsync(ct); }
        catch (AppException) { return new GrootTitleDto(fallback, false); }
        var kind = string.IsNullOrWhiteSpace(req.Kind) ? "work item" : req.Kind.Trim().ToLowerInvariant();
        var system = GrootIdentity.Generic + $"Write a title for a {kind} described by the user's text. Under 10 words and under {MaxTitle} characters, in the text's language, " +
                     "no quotes, no trailing full stop, no greeting (skip \"Hi team\"). Say what has to happen. Reply with the title only.";
        try
        {
            var answer = await ai.AskModelAsync("groot_title", system, text.Length > 4000 ? text[..4000] : text, 60, 1, ct);
            var title = Clean(answer.Text);
            return title.Length == 0 ? new GrootTitleDto(fallback, false) : new GrootTitleDto(title, true);
        }
        catch (Exception ex) when (ex is not OperationCanceledException) { return new GrootTitleDto(fallback, false); }
    }

    [GeneratedRegex(@"^\s*(hi|hello|hey|dear)\b[^,.!\n]{0,40}[,.!\n]\s*", RegexOptions.IgnoreCase)] private static partial Regex Salutation();
    [GeneratedRegex(@"\s+")] private static partial Regex Spaces();

    /// <summary>The first sentence (after a greeting such as "Hi Team,"), at most 120 characters, cut at a word.</summary>
    public static string FirstSentence(string text)
    {
        var t = Spaces().Replace(text, " ").Trim();
        var rest = Salutation().Replace(t, "");
        if (rest.Length > 0) t = rest;
        var end = t.IndexOfAny(['.', '!', '?', '\n']);
        var s = (end > 0 ? t[..end] : t).Trim();
        if (s.Length <= MaxTitle) return s;
        var cut = s[..MaxTitle];
        var space = cut.LastIndexOf(' ');
        return (space > 60 ? cut[..space] : cut).TrimEnd(' ', ',', ';', ':', '-') + "…";
    }

    private static string Clean(string raw)
    {
        var line = (raw ?? "").Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0) ?? "";
        line = line.Trim('"', '\'', '“', '”', ' ').TrimEnd('.');
        if (line.StartsWith("Title:", StringComparison.OrdinalIgnoreCase)) line = line[6..].Trim();
        return line.Length <= MaxTitle ? line : FirstSentence(line);
    }
}
