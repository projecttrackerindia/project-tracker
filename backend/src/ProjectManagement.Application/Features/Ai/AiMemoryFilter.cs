using System.Text.RegularExpressions;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>
/// What Aura will never remember. A deliberately blunt, server-side check on every memory before it is proposed and again before it is saved:
/// secrets (passwords, keys, tokens), card and bank numbers, government ids, and health, immigration, religion, politics and other personal
/// categories. A false alarm costs the person one rephrased sentence; a miss would keep something that must not be kept.
/// </summary>
public static class AiMemoryFilter
{
    public const int MaxLength = 300;
    private const RegexOptions Options = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;
    private static readonly TimeSpan Timeout = TimeSpan.FromMilliseconds(150);

    private static readonly (string Category, Regex Pattern)[] Rules =
    [
        ("a password, key or other secret", new(@"\b(?:passwords?|passcodes?|passphrase|pwd|otp|one[- ]time (?:code|password)|secrets?|api[ _-]?keys?|access[ _-]?keys?|private[ _-]?keys?|ssh[ _-]?keys?|client[ _-]?secret|tokens?|bearer|credentials?|(?:my|the|his|her|their) pin(?: code| number)?|pin (?:is|code|number))\b", Options, Timeout)),
        ("a key or token", new(@"\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{12,}|\bAIza[0-9A-Za-z_-]{20,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*KEY|\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9+/_-]{40,}={0,2}", Options, Timeout)),
        ("a card or bank number", new(@"(?<![\d-])(?:\d[ -]?){13,19}(?![\d-])|\b(?:credit|debit|payment|bank) card\b|\bcard (?:number|no|details)\b|\bcvv\b|\bcvc\b|\bexpiry date\b|\biban\b|\bswift code\b|\brouting number\b|\bbank account\b|\baccount (?:number|no)\b|\bifsc\b|\bupi (?:id|pin)\b", Options, Timeout)),
        ("a government id", new(@"\b\d{4}\s\d{4}\s\d{4}\b|\b\d{3}-\d{2}-\d{4}\b|\b[A-Z]{5}\d{4}[A-Z]\b|\b(?:aadhaar|aadhar|pan card|pan number|passport|ssn|social security|driver'?s licen[cs]e|driving licen[cs]e|national id|voter id|tax id|nric|national insurance number)\b", Options, Timeout)),
        ("health or medical information", new(@"\b(?:health condition|medical|medication|medicine|prescription|diagnos\w*|illness|disease|disorder|disabilit\w*|diabet\w*|cancer|chemo\w*|\bhiv\b|\baids\b|depress\w*|anxiety|therap(?:y|ist)|psychiatr\w*|psycholog\w*|mental health|pregnan\w*|surgery|surgical|hospital|migraine|asthma|epilep\w*|dialysis|adhd|autis\w*|bipolar|allerg\w*|blood pressure|chronic|treatment|injur\w*|sick leave)\b", Options, Timeout)),
        ("immigration status", new(@"\b(?:visa|immigration|green card|h-?1b|work permit|citizenship|asylum|refugee|residence permit|residency permit|deport\w*|undocumented|overstay\w*)\b", Options, Timeout)),
        ("religion", new(@"\b(?:relig\w*|church|mosque|temple|synagogue|gurdwara|pray\w*|namaz|puja|muslim|hindu|christian|sikh|jewish|buddhist|atheis\w*|ramadan|ramzan|fasting|sabbath|bible|quran|koran|spiritual\w*)\b", Options, Timeout)),
        ("politics", new(@"\b(?:politic\w*|election|vot(?:e|ed|ing) for|political party|party member|democrat\w*|republican|bjp|congress party|communis\w*|socialis\w*|left-wing|right-wing|liberal party|conservative party|trade union|union member)\b", Options, Timeout)),
        ("personal details", new(@"\b(?:sexual orientation|gender identity|\bgay\b|lesbian|bisexual|transgender|caste|ethnicity|criminal record|convicted|arrested|home address|date of birth|\bdob\b|net worth|credit score|salary|payslip|divorce)\b", Options, Timeout)),
    ];

    /// <summary>Why this text must not be remembered ("a password, key or other secret"), or null when it is fine.</summary>
    public static string? Category(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        foreach (var (category, pattern) in Rules)
        {
            try { if (pattern.IsMatch(text)) return category; }
            catch (RegexMatchTimeoutException) { return category; }   // too odd to judge: leave it out
        }
        return null;
    }

    /// <summary>The message the person (and Aura) gets when a memory is refused.</summary>
    public static string Refusal(string category) =>
        $"That cannot be remembered: it looks like {category}. Aura never stores passwords, keys, card or ID numbers, or health, immigration, religion, politics or other personal details. " +
        "Say it as a working preference instead, for example “prefers deep work before noon”.";

    /// <summary>One clean line for storage and for the prompt: control characters and line breaks collapsed, angle brackets removed (so a note can never close the block it is quoted in).</summary>
    public static string Clean(string? text)
    {
        if (string.IsNullOrEmpty(text)) return "";
        var s = Regex.Replace(text, @"[\p{Cc}\p{Cf}  ]+", " ", RegexOptions.None, Timeout);
        s = s.Replace("<", "").Replace(">", "");
        return Regex.Replace(s, @"\s+", " ", RegexOptions.None, Timeout).Trim();
    }
}
