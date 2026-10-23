using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ProjectManagement.Application.Features.Ai;

public enum AiRequestIntent { Ask, Analyze, Recommend, Execute, Combined }

/// <summary>
/// The model chooses tools, but it cannot grant itself permission to execute. Only explicit
/// dates or allocations in the person's current message authorize routine timeline writes.
/// Ambiguous references, quoted instructions and consequential changes retain approval cards.
/// </summary>
public static class AiExecutionPolicy
{
    private const RegexOptions Options = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;
    private const string Command = @"(?:(?:please|can you|could you|I want you to)\s+)?(?:update|set|change|move|reschedule|create|add|assign|edit|invite|send|schedule|start|remind|write|rename|mark|record|apply|allocate)\b";

    private static bool Matches(string text, string pattern) => Regex.IsMatch(text, pattern, Options, TimeSpan.FromMilliseconds(100));

    /// <summary>Text that says something was created, saved or sent ("I've created the task", "Done: ...", "has been saved").</summary>
    public static bool ClaimsDone(string text) =>
        Matches(text, @"\b(?:I(?:'ve| have)?|we(?:'ve| have)?|it(?:'s| has| is)|has been|have been|was|were|is now|are now|successfully)\s+(?:now\s+)?(?:created|added|saved|updated|scheduled|sent|completed|logged|assigned|moved|set|recorded|invited|made)\b")
        || Matches(text.TrimStart(), @"^(?:done|created|saved|added|completed)\b");

    /// <summary>
    /// A question back to the person about what to do (which project, what title) rather than a report of something done. Kept as the
    /// answer when an action request saved nothing: asking is the right move when only the person can supply the missing detail.
    /// </summary>
    public static bool IsClarification(string text)
    {
        var t = (text ?? "").Trim();
        if (t.Length is 0 or > 2000 || ClaimsDone(t)) return false;
        var body = Regex.Replace(t, @"<followups>.*$", "", RegexOptions.Singleline | RegexOptions.IgnoreCase, TimeSpan.FromMilliseconds(100));
        return body.Contains('?');
    }

    // Further requests to act, recognised for the intent only (never for auto-running a change), and requests that end in a Hindi or Telugu
    // verb in Latin letters ("Ravi ko message bhejo", "timesheet submit cheyyi").
    private const string MoreCommands = @"(?:(?:please|can you|could you|kindly|pls)\s+)?(?:approve|reject|submit|reply|snooze|dismiss|rotate|reassign|forward|book|log|clear|archive|close|reopen|fix|delete|remove|watch|undo|message|text|ping|email|draft|turn|rebalance|push|raise|call|huddle|tell(?!\s+me\b))\b";
    private const string IndianVerbAtEnd = @"\b(?:karo|kar\s+do|kardo|daalo|daal\s+do|cheyi|chey)\b[\s.!?]*$";
    private const string IndianVerb = @"\b(?:bhejo|bhej\s+do|banao|bana\s+do|lagao|laga\s+do|dilao|dila\s+do|pampu|pampandi|pampinchu|cheyyi|cheyandi|cheyyandi|pettu|pettandi|marchu|marchandi)\b";

    // "Tell me when ATL-12 is done", "warn me if Atlas slips past Friday", "keep an eye on WT-4": a request to set up a watch, which is a
    // change (a card) even though it starts like a question. A condition word is required, so "tell me when my next meeting is" stays a question.
    private const string WatchRequest = @"^(?:(?:please|can you|could you|pls|kindly)\s+)?(?:(?:tell|let|notify|alert|warn|ping|inform|message)\s+me(?:\s+know)?\s+(?:when|if|once|as\s+soon\s+as|whenever)\b.*\b(?:done|finished|completed?|closed|resolved|overdue|late|slips?|slipping|slipped|moves?\s+to|reaches|becomes?|changes|starts|ready|approved|merged|shipped|blocked|delayed|past)\b|(?:keep\s+an\s+eye\s+on|watch)\s+\S)";
    private const string IndianWatch = @"\b(?:jab|jaise\s+hi)\b.*\b(?:batana|bata\s+dena|batao|bata\s+do)\b|\b(?:ayyaka|aite|ayyinappudu|avvagane)\b.*\b(?:cheppu|cheppandi|cheppi)\b";

    /// <summary>A request to be told when something happens ("tell me when ATL-12 is done").</summary>
    public static bool IsWatchRequest(string text) => Matches(text.Trim(), WatchRequest) || Matches(text.Trim(), IndianWatch);

    public static AiRequestIntent Classify(string text)
    {
        var query = text.Trim();
        var action = Matches(query, "^" + Command) || Matches(query, @"(?:[.!?,;:]\s+|\b(?:and|then|also)\s+)" + Command)
            || Matches(query, "^" + MoreCommands) || Matches(query, @"(?:[.!?,;:]\s+|\b(?:and|then|also)\s+)" + MoreCommands) || Matches(query, IndianVerbAtEnd) || Matches(query, IndianVerb) || IsWatchRequest(query);
        var analysis = Matches(query, @"\b(?:analyse|analyze|explain|why|assess|evaluate|tell me|what changed|on track)\b");
        if (action) return analysis ? AiRequestIntent.Combined : AiRequestIntent.Execute;
        if (Matches(query, @"^(?:please\s+)?(?:recommend|suggest|advise)\b")) return AiRequestIntent.Recommend;
        return analysis ? AiRequestIntent.Analyze : AiRequestIntent.Ask;
    }

    // A clearly informational request must not acquire write tools merely because it mentions
    // the word "update". Unknown shorthand still permits a proposal; it never grants auto-run.
    public static bool IsReadOnlyRequest(string text) => Classify(text) is not (AiRequestIntent.Execute or AiRequestIntent.Combined)
        && Matches(text.Trim(), @"^(?:(?:please|can you|could you)\s+)?(?:why|how|what|when|where|who|which|is|are|does|do we|do i|am i|did|any|can we|explain|analyse|analyze|assess|evaluate|recommend|suggest|advise|give me|show|list|summari[sz]e|find|tell me)\b");

    public static bool CanAutoExecute(string text, string tool, string inputJson, AiProposal proposal, bool hasFiles)
    {
        if (hasFiles || proposal.Kind is not ("update_project" or "update_stage_dates")) return false;
        var query = text.Trim();
        var command = Regex.Match(query, "^" + Command + @"\s+", Options, TimeSpan.FromMilliseconds(100));
        if (!command.Success || Matches(query, @"\b(?:preview|propose|suggest|hypothetically|example|unless|don't|not|if|but|before approval|after confirmation)\b")
            || Matches(query, @"\b(?:and|then|also)\s+" + Command)
            || query.Contains('\n') || query.Contains('"') || query.Contains('`')) return false;
        using var input = JsonDocument.Parse(inputJson);
        using var payload = JsonDocument.Parse(proposal.PayloadJson);
        var a = input.RootElement; var saved = payload.RootElement;
        var allowed = tool == AiToolbox.UpdateProject ? new[] { "project", "start_date", "due_date", "reason" }
            : tool == AiToolbox.UpdateStagePlan ? new[] { "project", "stage", "planned_start", "planned_end", "duration_days", "reason" } : [];
        if (allowed.Length == 0 || a.EnumerateObject().Any(p => !allowed.Contains(p.Name))) return false;
        string? Text(JsonElement element, string name) => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        var reference = Text(a, "project");
        if (string.IsNullOrWhiteSpace(reference) || !new[] { Text(saved, "key"), Text(saved, "projectKey"), Text(saved, "projectName"), Text(saved, "id"), Text(saved, "projectId") }
            .Any(value => value is not null && AiPersonMatching.Normalize(value) == AiPersonMatching.Normalize(reference))) return false;
        var target = query[command.Length..];
        if (!Matches(target, @"^(?:(?:the|project)\s+)*" + Regex.Escape(reference.Trim()) + @"(?:\b|\s|:)")) return false;
        if (tool == AiToolbox.UpdateStagePlan)
        {
            var stage = Text(a, "stage");
            if (string.IsNullOrWhiteSpace(stage) || !new[] { Text(saved, "stageName"), Text(saved, "stageId") }
                .Any(value => value is not null && AiPersonMatching.Normalize(value) == AiPersonMatching.Normalize(stage))) return false;
            if (!Matches(target, @"\bstage\s+" + Regex.Escape(stage.Trim()) + @"(?:\b|\s|:)")) return false;
        }
        var changes = 0;
        foreach (var field in new[] { "start_date", "due_date", "planned_start", "planned_end" })
        {
            if (Text(a, field) is not { } dateText) continue;
            if (!DateOnly.TryParseExact(dateText, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)) return false;
            var formats = new[] { "yyyy-MM-dd", "dd-MM-yyyy", "d-M-yyyy", "dd/MM/yyyy", "d/M/yyyy", "d MMM yyyy", "dd MMM yyyy", "d MMMM yyyy", "dd MMMM yyyy" };
            var dates = string.Join("|", formats.Select(f => Regex.Escape(date.ToString(f, CultureInfo.InvariantCulture))).Distinct());
            var label = field is "start_date" or "planned_start" ? @"(?:planned\s+)?(?:start(?:\s+date)?|kickoff)" : @"(?:planned\s+)?(?:due(?:\s+date)?|end(?:\s+date)?|finish)";
            var prefix = @"\b" + label + @"\s*(?:(?:date|to|on|is|=|:)\s*){0,2}";
            const string anyDate = @"(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4}|\d{1,2}\s+[a-z]+\s+\d{4})(?!\d)";
            if (Regex.Matches(target, prefix + anyDate, Options, TimeSpan.FromMilliseconds(100)).Count != 1) return false;
            if (!Matches(target, prefix + @"(?:" + dates + @")(?!\d)")) return false;
            changes++;
        }
        if (a.TryGetProperty("duration_days", out var duration))
        {
            if (!duration.TryGetInt32(out var days) || !Matches(target, @"\bduration\s*(?:(?:to|of|=|:)\s*){0,2}" + days + @"\s+(?:calendar\s+)?days\b")) return false;
            changes++;
        }
        if (Text(a, "reason") is { Length: > 0 } reason && !query.Contains(reason, StringComparison.OrdinalIgnoreCase)) return false;
        return changes > 0;
    }
}
