using System.Text.RegularExpressions;

namespace ProjectManagement.Application.Features.Ai;

public static class AiMessageCommands
{
    public sealed record ExactMessage(string Recipient, string Body);
    private static readonly Regex Request = new(@"^(?:can you\s+|please\s+)?send\s+(?<body>[^\r\n]{1,4000}?)\s+message\s+to\s+(?<recipient>[^\r\n?]{1,150})\??$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
    private static readonly Regex Approval = new(@"^(yes(?:[,!]?(?:\s+(?:please|send(?:\s+it)?|go ahead|confirm))*)?|confirm(?:\s+(?:it|sending the message|sending|send))?|send it|go ahead(?:\s+and send(?:\s+it)?)?)[.!]*$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
    public static bool IsConfirmation(string text) => Approval.IsMatch(text.Trim());
    public static bool UnsupportedChannel(string text) => Regex.IsMatch(text, @"\b(whatsapp|sms|slack|telegram)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    public static string? MissingBodyRecipient(string text)
    {
        if (UnsupportedChannel(text)) return null;
        var match = Regex.Match(text.Trim(), @"^(?:can you\s+|please\s+)?send\s+(?:a\s+)?message\s+to\s+(?<recipient>[^\r\n?]{1,150})\??$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
        return match.Success ? match.Groups["recipient"].Value.Trim() : null;
    }
    public static ExactMessage? ExactRequest(string text)
    {
        if (UnsupportedChannel(text) || MissingBodyRecipient(text) is not null) return null;
        var match = Request.Match(text.Trim());
        if (!match.Success) return null;
        var body = match.Groups["body"].Value.Trim();
        // The article describes the message, rather than belonging to its content. Quoted content remains literal.
        if (body.StartsWith("a ", StringComparison.OrdinalIgnoreCase)) body = body[2..];
        if (body.Length > 1 && ((body[0] == '"' && body[^1] == '"') || (body[0] == '\'' && body[^1] == '\''))) body = body[1..^1];
        return new(match.Groups["recipient"].Value.Trim(), body);
    }
}
