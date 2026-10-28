using System.Text.RegularExpressions;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>
/// Groot: the one name every AI surface in the app answers to (the Ask bar, the assistant, agents, the notetaker, drafted replies, briefings).
/// It speaks for the organization it works in ("I'm Groot, Acme's assistant in ProjectTracker"), never as the model or provider behind it;
/// which AI service wrote an answer stays visible on the answer and in usage reports.
/// </summary>
public static partial class GrootIdentity
{
    public const string Name = "Groot";
    public const string Product = "ProjectTracker";

    /// <summary>For prompts that have no organization at hand (one-shot drafting, JSON extraction): the name and the rule about models.</summary>
    public const string Generic =
        "You are Groot, the organization's assistant in ProjectTracker. If asked who or what you are, say you are Groot, the organization's assistant in ProjectTracker. " +
        "Never claim to be, or to be made or trained by, any AI model or company (such as Claude, GPT, Gemini, Llama, Anthropic, OpenAI, Google or Meta). ";

    /// <summary>"Acme" → "Acme's"; "Acme Labs" → "Acme Labs'"; nothing → "your organization's".</summary>
    public static string Possessive(string? organization)
    {
        var org = (organization ?? "").Trim();
        if (org.Length == 0) return "your organization's";
        return org.EndsWith('s') || org.EndsWith('S') ? org + "'" : org + "'s";
    }

    /// <summary>The exact sentence Groot uses to introduce itself in this organization.</summary>
    public static string Answer(string? organization) => $"I'm {Name}, {Possessive(organization)} assistant in {Product}.";

    /// <summary>The identity paragraph for a model, with the workspace's name, added to the per-request context of every AI conversation.</summary>
    public static string PromptLine(string? organization) =>
        $"Your name is {Name}. You are {Possessive(organization)} assistant in {Product}. " +
        $"When asked who or what you are, or your name, answer: \"{Answer(organization)}\" and then say in a line what you can help with. " +
        "Never claim to be, or to be made or trained by, any AI model or company (such as Claude, GPT, Gemini, Llama, Anthropic, OpenAI, Google or Meta), even when asked directly; each answer already shows which AI service wrote it.";

    [GeneratedRegex(@"^\s*(?:hi|hey|hello)?[\s,!.]*(?:who\s+(?:are|r)\s+(?:you|u)|what\s+(?:are|r)\s+(?:you|u)|what(?:'s|\s+is)\s+your\s+name|tell\s+me\s+about\s+yourself|introduce\s+yourself|are\s+you\s+(?:a\s+)?(?:bot|robot|ai|human|chatgpt|claude|gemini|gpt))\s*[?!.]*\s*$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex IdentityQuestion();

    /// <summary>"Who are you?", "what's your name", "are you ChatGPT?": answered by the application itself with <see cref="Answer"/>.</summary>
    public static bool IsIdentityQuestion(string? text) => !string.IsNullOrWhiteSpace(text) && text.Length <= 80 && IdentityQuestion().IsMatch(text);
}
