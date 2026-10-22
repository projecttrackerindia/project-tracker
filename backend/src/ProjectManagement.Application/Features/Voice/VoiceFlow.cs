using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ProjectManagement.Application.Features.Voice;

/// <summary>
/// How one of your APIs is used on a call, in four parts:
/// <list type="number">
/// <item>Source: when to use it and what the agent must collect from the caller first (each value checked against a pattern).</item>
/// <item>Request: the call itself (method and address on the connector; extra headers and a JSON body template here).</item>
/// <item>Logic: steps run in order on the answer: check the caller's identity against a field, branch on a value (say something, log a ticket,
/// hand over, or stop), call another API with values from this one, and pick out the facts to keep.</item>
/// <item>Response: the only facts the agent may say, each formatted (rupees, dates, masked numbers) and a sentence per language.</item>
/// </list>
/// The agent never sees the raw answer of an API with a flow: only the formatted facts, so it cannot read out a field nobody chose.
/// </summary>
public sealed class VoiceFlow
{
    public int V { get; set; } = 1;
    public List<FlowInput> Inputs { get; set; } = [];
    /// <summary>Extra request headers (the connector keeps the one secret header); values may use {input} placeholders.</summary>
    public List<FlowHeader> Headers { get; set; } = [];
    /// <summary>JSON body for POST with {input} placeholders (each value JSON-escaped). Empty sends the collected inputs as JSON.</summary>
    public string? BodyTemplate { get; set; }
    /// <summary>When true, no fact is given until the caller has passed an identity check (on this call, or a verify step here).</summary>
    public bool RequiresVerifiedCaller { get; set; }
    public List<FlowStep> Steps { get; set; } = [];
    public List<FlowField> Fields { get; set; } = [];
    /// <summary>A sentence per language ("en", "hi", ...) using {field} keys, for example "Your next EMI of {emiAmount} is due on {emiDate}."</summary>
    public Dictionary<string, string> Templates { get; set; } = [];
    /// <summary>Example answers by step alias ("main" for this API), used by the test when "use sample" is chosen and as a guide for paths.</summary>
    public Dictionary<string, string> Samples { get; set; } = [];
}

public sealed class FlowInput
{
    public string Name { get; set; } = "";
    public string Label { get; set; } = "";
    /// <summary>text, digits, date, phone, email, last4.</summary>
    public string Type { get; set; } = "text";
    public bool Required { get; set; } = true;
    public string? Example { get; set; }
}

public sealed class FlowHeader { public string Name { get; set; } = ""; public string Value { get; set; } = ""; }

public sealed class FlowStep
{
    /// <summary>verify, branch or chain.</summary>
    public string Type { get; set; } = "";
    public string? Label { get; set; }
    // verify
    /// <summary>Where to look in the answers, for example "main.customer.dob" or "emi.items[0].amount".</summary>
    public string? Path { get; set; }
    public string? Input { get; set; }
    /// <summary>exact, digits, last4, date.</summary>
    public string? Compare { get; set; }
    // branch
    /// <summary>eq, ne, gt, gte, lt, lte, contains, empty, notempty.</summary>
    public string? Op { get; set; }
    public string? Value { get; set; }
    /// <summary>say, ticket, transfer, stop (for a branch that matched, or a verify that failed).</summary>
    public string? Action { get; set; }
    /// <summary>What to say (with {field} keys) or the ticket's title.</summary>
    public string? Text { get; set; }
    public string? Priority { get; set; }
    // chain
    public string? Connector { get; set; }
    /// <summary>The name later steps use for its answer, for example "emi" (then paths like "emi.nextDue").</summary>
    public string? As { get; set; }
    /// <summary>The other API's inputs: a fixed value, an {input} of this call, or a path like "main.loan.id".</summary>
    public Dictionary<string, string> Args { get; set; } = [];
}

public sealed class FlowField
{
    public string Key { get; set; } = "";
    public string Path { get; set; } = "";
    /// <summary>text, inr, number, date, datetime, mask4, yesno, percent.</summary>
    public string Format { get; set; } = "text";
    /// <summary>What it is, for the agent ("outstanding balance").</summary>
    public string? Label { get; set; }
}

public sealed record FlowTrace(string Step, string Status, string Detail);
public sealed record FlowResult(bool Ok, IReadOnlyDictionary<string, string> Facts, string? Say, string Action, string? ActionText, string? Priority,
    bool? VerifiedNow, IReadOnlyList<FlowTrace> Trace, IReadOnlyDictionary<string, string> Raw, string? Error = null)
{
    /// <summary>What the agent is given: the facts and instructions only, never the raw answers.</summary>
    public string ForAgent()
    {
        var o = new JsonObject { ["ok"] = Ok };
        if (Error is { } e) o["error"] = e;
        if (VerifiedNow is { } v) o["identity"] = v ? "confirmed: the caller passed the identity check" : "does NOT match: do not share account details";
        if (Facts.Count > 0) o["facts"] = new JsonObject(Facts.Select(f => KeyValuePair.Create(f.Key, (JsonNode?)JsonValue.Create(f.Value))));
        if (Say is { Length: > 0 } s) o["say_this"] = s;
        if (Action != "none") o["next"] = Action switch
        {
            "ticket" => $"a ticket was logged ({ActionText}); tell the caller its number",
            "transfer" => $"hand the call to a person now ({ActionText})",
            "stop" => ActionText ?? "do not share details from this lookup",
            _ => ActionText,
        };
        return o.ToJsonString();
    }
}

/// <summary>Runs a <see cref="VoiceFlow"/>. Pure apart from <paramref name="call"/>, so the same code runs on live calls and in the builder's test.</summary>
public static partial class VoiceFlowRunner
{
    public delegate Task<string> CallApi(string connector, IReadOnlyDictionary<string, string> args, CancellationToken ct);

    public const int MaxSteps = 12;
    public const int MaxChains = 3;

    public static VoiceFlow? Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try { return JsonSerializer.Deserialize<VoiceFlow>(json, Opts); } catch (JsonException) { return null; }
    }

    public static readonly JsonSerializerOptions Opts = new(JsonSerializerDefaults.Web);

    /// <summary>Problems a person must fix before saving, in plain words. Empty when the flow is usable.</summary>
    public static IReadOnlyList<string> Validate(VoiceFlow f, IReadOnlyCollection<string> urlPlaceholders, IReadOnlyCollection<string> otherConnectors)
    {
        var errors = new List<string>();
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var i in f.Inputs)
        {
            if (!InputName().IsMatch(i.Name)) errors.Add($"Input \"{i.Name}\": use letters and digits, starting with a letter (like loanNumber).");
            else if (!names.Add(i.Name)) errors.Add($"Input \"{i.Name}\" is listed twice.");
            if (i.Type is not ("text" or "digits" or "date" or "phone" or "email" or "last4")) errors.Add($"Input \"{i.Name}\": choose a type.");
        }
        foreach (var p in urlPlaceholders) if (!names.Contains(p)) errors.Add($"The address uses {{{p}}}: add it as an input.");
        if (f.Inputs.Count > 8) errors.Add("Up to 8 inputs.");
        if (f.Steps.Count > MaxSteps) errors.Add($"Up to {MaxSteps} logic steps.");
        if (f.Steps.Count(s => s.Type == "chain") > MaxChains) errors.Add($"Up to {MaxChains} follow-on API calls.");
        var aliases = new HashSet<string>(StringComparer.Ordinal) { "main" };
        for (var n = 0; n < f.Steps.Count; n++)
        {
            var s = f.Steps[n]; var at = $"Step {n + 1}";
            switch (s.Type)
            {
                case "verify":
                    if (string.IsNullOrWhiteSpace(s.Path)) errors.Add($"{at}: choose the field to check against.");
                    if (s.Input is null || !names.Contains(s.Input)) errors.Add($"{at}: choose which input the caller gives.");
                    if (s.Compare is not ("exact" or "digits" or "last4" or "date")) errors.Add($"{at}: choose how to compare.");
                    break;
                case "branch":
                    if (string.IsNullOrWhiteSpace(s.Path)) errors.Add($"{at}: choose the field to test.");
                    if (s.Op is not ("eq" or "ne" or "gt" or "gte" or "lt" or "lte" or "contains" or "empty" or "notempty")) errors.Add($"{at}: choose a condition.");
                    if (s.Action is not ("say" or "ticket" or "transfer" or "stop")) errors.Add($"{at}: choose what happens.");
                    if (s.Action is "say" or "ticket" && string.IsNullOrWhiteSpace(s.Text)) errors.Add($"{at}: write what to say or the ticket title.");
                    break;
                case "chain":
                    if (s.Connector is null || !otherConnectors.Contains(s.Connector)) errors.Add($"{at}: choose another API to call.");
                    if (s.As is null || !InputName().IsMatch(s.As) || !aliases.Add(s.As)) errors.Add($"{at}: give its answer a unique short name (like emi).");
                    break;
                default: errors.Add($"{at}: unknown step."); break;
            }
        }
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var fld in f.Fields)
        {
            if (!InputName().IsMatch(fld.Key) || !keys.Add(fld.Key)) errors.Add($"Fact \"{fld.Key}\": use a unique short name like balance.");
            if (string.IsNullOrWhiteSpace(fld.Path)) errors.Add($"Fact \"{fld.Key}\": choose where it comes from.");
            if (fld.Format is not ("text" or "inr" or "number" or "date" or "datetime" or "mask4" or "yesno" or "percent")) errors.Add($"Fact \"{fld.Key}\": choose a format.");
        }
        if (f.Fields.Count > 20) errors.Add("Up to 20 facts.");
        foreach (var (lang, t) in f.Templates)
            foreach (Match m in Placeholder().Matches(t))
                if (!keys.Contains(m.Groups[1].Value)) errors.Add($"The {lang} sentence uses {{{m.Groups[1].Value}}}, which is not a fact.");
        return errors;
    }

    /// <summary>Checks one value the caller gave against the input's type. Returns the cleaned value, or null when it is not acceptable.</summary>
    public static string? Clean(FlowInput i, string? raw)
    {
        var v = (raw ?? "").Trim();
        if (v.Length is 0 or > 64) return null;
        return i.Type switch
        {
            "digits" => Digits(v) is { Length: > 0 } d && d.Length <= 20 ? d : null,
            "last4" => Digits(v) is { Length: 4 } l4 ? l4 : null,
            "phone" => Digits(v) is { Length: >= 10 and <= 13 } p ? p[^10..] : null,
            "date" => ParseDate(v) is { } dt ? dt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : null,
            "email" => EmailRx().IsMatch(v) ? v : null,
            _ => SafeText().IsMatch(v) ? v : null,
        };
    }

    public static async Task<FlowResult> RunAsync(VoiceFlow flow, IReadOnlyDictionary<string, string> given, string connectorName, bool callerVerified, string language,
        CallApi call, CancellationToken ct, IReadOnlyDictionary<string, string>? samples = null)
    {
        var trace = new List<FlowTrace>();
        var raw = new Dictionary<string, string>(StringComparer.Ordinal);
        var answers = new Dictionary<string, JsonNode?>(StringComparer.Ordinal);
        FlowResult Fail(string why, string action = "stop") => new(false, new Dictionary<string, string>(), null, action, why, null, null, trace, raw, why);

        // Source: every input checked before anything is sent anywhere.
        var inputs = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var i in flow.Inputs)
        {
            given.TryGetValue(i.Name, out var v);
            var clean = Clean(i, v);
            if (clean is null)
            {
                if (!i.Required && string.IsNullOrWhiteSpace(v)) continue;
                trace.Add(new("Source", "missing", $"{Label(i)} {(string.IsNullOrWhiteSpace(v) ? "was not given" : "is not valid")}"));
                return Fail($"Ask the caller for their {Label(i).ToLowerInvariant()}{(string.IsNullOrWhiteSpace(v) ? "" : " again (that one is not valid)")}.", "ask");
            }
            inputs[i.Name] = clean;
        }
        trace.Add(new("Source", "ok", inputs.Count == 0 ? "No inputs needed" : string.Join(", ", inputs.Select(x => $"{x.Key} = {Mask(x.Value)}"))));

        // Request.
        if (!await FetchAsync("main", connectorName, inputs)) return Fail("That system did not answer. Apologise and offer to log a ticket.", "none");

        // Logic.
        bool? verifiedNow = null;
        var say = new List<string>();
        string action = "none"; string? actionText = null; string? priority = null;
        foreach (var (s, n) in flow.Steps.Take(MaxSteps).Select((s, n) => (s, n + 1)))
        {
            var name = s.Label is { Length: > 0 } l ? $"{n}. {l}" : $"{n}. {s.Type}";
            switch (s.Type)
            {
                case "verify":
                {
                    var expected = Find(answers, s.Path)?.ToString();
                    inputs.TryGetValue(s.Input ?? "", out var said);
                    var ok = expected is not null && said is not null && Same(s.Compare ?? "exact", said, expected);
                    verifiedNow = (verifiedNow ?? true) && ok;
                    trace.Add(new(name, ok ? "passed" : "failed", ok ? $"{s.Input} matches {s.Path}" : expected is null ? $"{s.Path} is not in the answer" : $"{s.Input} does not match {s.Path}"));
                    if (!ok)
                    {
                        var what = s.Action is "transfer" or "ticket" ? s.Action : "stop";
                        return new(true, new Dictionary<string, string>(), s.Text is { Length: > 0 } t ? Fill(t, new Dictionary<string, string>()) : null, what,
                            what == "stop" ? "The details did not match: do not share any account information. Ask once more or offer to log a ticket." : s.Text ?? "identity check failed",
                            s.Priority, false, trace, raw);
                    }
                    break;
                }
                case "branch":
                {
                    var value = Find(answers, s.Path);
                    var hit = Test(s.Op ?? "eq", value, s.Value);
                    trace.Add(new(name, hit ? "matched" : "skipped", $"{s.Path} = {Show(value)} {OpText(s.Op)} {s.Value}".TrimEnd()));
                    if (!hit) break;
                    switch (s.Action)
                    {
                        case "say": if (s.Text is { Length: > 0 }) say.Add(s.Text); break;
                        case "ticket": action = "ticket"; actionText = s.Text; priority = s.Priority; break;
                        case "transfer": action = "transfer"; actionText = s.Text ?? "the rule asks for a person"; break;
                        case "stop":
                            trace.Add(new("Response", "withheld", "A stop rule matched: nothing from this lookup is shared"));
                            return new(true, new Dictionary<string, string>(), s.Text, "stop", s.Text ?? "Do not share details from this lookup.", null, verifiedNow, trace, raw);
                    }
                    break;
                }
                case "chain":
                {
                    if (answers.Count > MaxChains) { trace.Add(new(name, "skipped", "Too many follow-on calls")); break; }
                    var args = new Dictionary<string, string>(StringComparer.Ordinal);
                    foreach (var (k, expr) in s.Args)
                    {
                        var v = Placeholder().IsMatch(expr) && Placeholder().Match(expr).Value == expr ? inputs.GetValueOrDefault(expr.Trim('{', '}'))
                            : expr.Contains('.') ? Find(answers, expr)?.ToString() : expr;
                        if (string.IsNullOrWhiteSpace(v)) { trace.Add(new(name, "failed", $"No value for {k} ({expr})")); return Fail("That system did not have what was needed. Offer to log a ticket.", "none"); }
                        args[k] = v;
                    }
                    if (!await FetchAsync(s.As ?? "next", s.Connector ?? "", args)) return Fail("A connected system did not answer. Apologise and offer to log a ticket.", "none");
                    break;
                }
            }
        }

        // Response: only chosen facts, formatted for speech, and only for a verified caller when the flow says so.
        if (flow.RequiresVerifiedCaller && !callerVerified && verifiedNow != true)
        {
            trace.Add(new("Response", "withheld", "The caller has not passed an identity check yet"));
            return new(true, new Dictionary<string, string>(), null, action == "none" ? "stop" : action,
                action == "none" ? "Check the caller's identity first; do not share these details yet." : actionText, priority, verifiedNow, trace, raw);
        }
        var facts = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var f in flow.Fields)
        {
            var v = Find(answers, f.Path);
            if (v is null) { trace.Add(new("Response", "missing", $"{f.Key}: {f.Path} is not in the answer")); continue; }
            facts[f.Key] = Format(v, f.Format, language);
        }
        if (facts.Count > 0) trace.Add(new("Response", "ok", string.Join(", ", facts.Select(x => $"{x.Key} = {x.Value}"))));
        var template = flow.Templates.GetValueOrDefault(language) ?? flow.Templates.GetValueOrDefault("en");
        if (template is { Length: > 0 }) say.Add(template);
        var spoken = say.Count == 0 ? null : string.Join(" ", say.Select(t => Fill(t, facts)));
        return new(true, facts, spoken, action, actionText, priority, verifiedNow, trace, raw);

        async Task<bool> FetchAsync(string alias, string connector, IReadOnlyDictionary<string, string> args)
        {
            var label = alias == "main" ? "Request" : $"Call {connector}";
            try
            {
                var body = samples is not null && samples.TryGetValue(alias, out var sample) ? sample : await call(connector, args, ct);
                raw[alias] = body.Length > 6000 ? body[..6000] : body;
                JsonNode? node;
                try { node = JsonNode.Parse(body); } catch (JsonException) { node = JsonValue.Create(body); }
                answers[alias] = node;
                trace.Add(new(label, body.StartsWith("(the API answered", StringComparison.Ordinal) ? "error" : "ok",
                    samples?.ContainsKey(alias) == true ? "Used the sample answer" : $"{connector} answered ({body.Length} characters)"));
                return !body.StartsWith("(the API answered", StringComparison.Ordinal);
            }
            catch (Exception e) when (e is HttpRequestException or TaskCanceledException or ProjectManagement.Application.Exceptions.AppException)
            {
                trace.Add(new(label, "error", e.Message));
                return false;
            }
        }
    }

    // ------------------------------------------------------------------ helpers

    private static string Label(FlowInput i) => string.IsNullOrWhiteSpace(i.Label) ? i.Name : i.Label;

    /// <summary>"main.customer.dob", "emi.items[0].amount", "main.loans[-1].id" (from the end).</summary>
    public static JsonNode? Find(IReadOnlyDictionary<string, JsonNode?> answers, string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        var parts = PathPart().Matches(path.Trim()).Select(m => m.Value).ToList();
        if (parts.Count == 0 || !answers.TryGetValue(parts[0], out var node)) return null;
        foreach (var p in parts.Skip(1))
        {
            if (node is null) return null;
            if (p.StartsWith('['))
            {
                if (node is not JsonArray arr || !int.TryParse(p.Trim('[', ']'), out var idx)) return null;
                if (idx < 0) idx += arr.Count;
                node = idx >= 0 && idx < arr.Count ? arr[idx] : null;
            }
            else node = node is JsonObject o ? o.FirstOrDefault(kv => string.Equals(kv.Key, p, StringComparison.OrdinalIgnoreCase)).Value : null;
        }
        return node;
    }

    private static bool Same(string how, string said, string expected) => how switch
    {
        "digits" => Digits(said) is { Length: > 0 } a && a == Digits(expected),
        "last4" => Digits(said) is { Length: 4 } l && Digits(expected) is { Length: >= 4 } e && e.EndsWith(l, StringComparison.Ordinal),
        "date" => ParseDate(said) is { } x && ParseDate(expected) is { } y && x.Date == y.Date,
        _ => string.Equals(said.Trim(), expected.Trim(), StringComparison.OrdinalIgnoreCase),
    };

    private static bool Test(string op, JsonNode? node, string? value)
    {
        var text = node is JsonValue jv && jv.TryGetValue<string>(out var str) ? str : node?.ToJsonString();
        var isEmpty = node is null || (node is JsonArray a && a.Count == 0) || (node is JsonValue && string.IsNullOrWhiteSpace(text)) || text == "null";
        if (op == "empty") return isEmpty;
        if (op == "notempty") return !isEmpty;
        if (isEmpty) return op == "ne";
        var v = value ?? "";
        if (op is "gt" or "gte" or "lt" or "lte")
        {
            if (Number(text) is { } x && Number(v) is { } y) return op switch { "gt" => x > y, "gte" => x >= y, "lt" => x < y, _ => x <= y };
            if (ParseDate(text) is { } dx && (v.Equals("today", StringComparison.OrdinalIgnoreCase) ? DateTime.UtcNow.Date : ParseDate(v)) is { } dy)
                return op switch { "gt" => dx > dy, "gte" => dx >= dy, "lt" => dx < dy, _ => dx <= dy };
            return false;
        }
        return op switch
        {
            "eq" => Number(text) is { } a1 && Number(v) is { } b1 ? a1 == b1 : string.Equals(text?.Trim(), v.Trim(), StringComparison.OrdinalIgnoreCase),
            "ne" => !(Number(text) is { } a2 && Number(v) is { } b2 ? a2 == b2 : string.Equals(text?.Trim(), v.Trim(), StringComparison.OrdinalIgnoreCase)),
            "contains" => text?.Contains(v, StringComparison.OrdinalIgnoreCase) == true,
            _ => false,
        };
    }

    private static string OpText(string? op) => op switch
    {
        "eq" => "is", "ne" => "is not", "gt" => ">", "gte" => "≥", "lt" => "<", "lte" => "≤", "contains" => "contains", "empty" => "is empty", "notempty" => "is not empty", _ => op ?? "",
    };

    /// <summary>A value as a person would say it: ₹1,24,999.50, 5 November 2026, ending 4821.</summary>
    public static string Format(JsonNode node, string format, string language = "en")
    {
        var text = node is JsonValue jv && jv.TryGetValue<string>(out var s) ? s : node.ToJsonString().Trim('"');
        switch (format)
        {
            case "inr": return Number(text) is { } n ? "₹" + Indian(n) : text;
            case "number": return Number(text) is { } m ? Indian(m).Replace(".00", "") : text;
            case "percent": return Number(text) is { } p ? p.ToString("0.##", CultureInfo.InvariantCulture) + "%" : text;
            case "date": return ParseDate(text) is { } d ? d.ToString("d MMMM yyyy", CultureInfo.InvariantCulture) : text;
            case "datetime": return ParseDate(text) is { } t ? t.ToString("d MMMM yyyy, h:mm tt", CultureInfo.InvariantCulture) : text;
            case "mask4": return Digits(text) is { Length: >= 4 } dg ? "ending " + dg[^4..] : "hidden";
            case "yesno": return text.ToLowerInvariant() is "true" or "yes" or "y" or "1" ? "yes" : "no";
            default: return text.Length > 200 ? text[..200] : text;
        }
    }

    private static string Indian(decimal amount)
    {
        var rounded = Math.Round(Math.Abs(amount), 2);
        var whole = Math.Truncate(rounded).ToString(CultureInfo.InvariantCulture);
        var grouped = whole.Length <= 3 ? whole : whole[^3..];
        for (var rest = whole.Length <= 3 ? "" : whole[..^3]; rest.Length > 0; rest = rest.Length <= 2 ? "" : rest[..^2])
            grouped = (rest.Length <= 2 ? rest : rest[^2..]) + "," + grouped;
        var paise = rounded - Math.Truncate(rounded);
        return (amount < 0 ? "-" : "") + grouped + (paise == 0 ? "" : paise.ToString(".00", CultureInfo.InvariantCulture));
    }

    private static string Fill(string template, IReadOnlyDictionary<string, string> facts) =>
        Placeholder().Replace(template, m => facts.TryGetValue(m.Groups[1].Value, out var v) ? v : "");

    private static string Show(JsonNode? n)
    {
        if (n is null) return "(none)";
        if (n is JsonValue v && v.TryGetValue<string>(out var s)) return s;
        var j = n.ToJsonString();
        return j.Length > 40 ? j[..40] + "…" : j;
    }
    private static string Mask(string v) => v.Length <= 4 ? new string('•', v.Length) : new string('•', v.Length - 4) + v[^4..];
    private static string Digits(string? s) => new((s ?? "").Where(char.IsAsciiDigit).ToArray());
    private static decimal? Number(string? s) => decimal.TryParse((s ?? "").Replace(",", "").Replace("₹", "").Trim(), NumberStyles.Number, CultureInfo.InvariantCulture, out var d) ? d : null;

    private static readonly string[] DateFormats = ["yyyy-MM-dd", "dd-MM-yyyy", "dd/MM/yyyy", "d/M/yyyy", "d-M-yyyy", "dd.MM.yyyy", "yyyyMMdd", "d MMM yyyy", "d MMMM yyyy", "MMM d, yyyy", "yyyy-MM-ddTHH:mm:ss", "yyyy-MM-ddTHH:mm:ssZ", "yyyy-MM-ddTHH:mm:ss.fffZ"];
    public static DateTime? ParseDate(string? s)
    {
        var v = (s ?? "").Trim();
        if (v.Length is < 6 or > 40) return null;
        if (DateTime.TryParseExact(v, DateFormats, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var d)) return d;
        return DateTimeOffset.TryParse(v, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var o) ? o.UtcDateTime : null;
    }

    [GeneratedRegex(@"^[A-Za-z][A-Za-z0-9_]{0,39}$")] private static partial Regex InputName();
    [GeneratedRegex(@"\{([A-Za-z][A-Za-z0-9_]{0,39})\}")] private static partial Regex Placeholder();
    [GeneratedRegex(@"[A-Za-z0-9_\-]+|\[-?\d+\]")] private static partial Regex PathPart();
    [GeneratedRegex(@"^[^@\s]{1,40}@[^@\s]{1,40}\.[a-z]{2,10}$", RegexOptions.IgnoreCase)] private static partial Regex EmailRx();
    [GeneratedRegex(@"^[\p{L}\p{N} _\-./@,]+$")] private static partial Regex SafeText();
}
