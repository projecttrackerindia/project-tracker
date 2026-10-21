using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ProjectManagement.Application.Features.Documents;

/// <summary>A workspace's own masking rule: a field (column, JSON key or label) and how its values are hidden.</summary>
public record MaskRule(string Field, string Match, string Strategy, string Label);

/// <summary>
/// Hides personal and secret data in document content before it leaves the server: Indian identifiers (mobile, PAN, Aadhaar, IFSC, UPI),
/// e-mail, card and account numbers, and credentials. Values are found three ways - by the field they sit in (a table column, a JSON key,
/// a "Label: value" line), by their shape (a PAN looks like ABCDE1234F), and by the workspace's own rules. The original is never changed;
/// only what is sent to a reader is masked, and revealing it is a separate, audited request.
/// </summary>
public sealed class PiiMasker
{
    public const char Dot = '•';
    private readonly List<(MaskRule Rule, Regex? Pattern)> _custom;
    private readonly HashSet<string> _off;
    public int Count { get; private set; }

    /// <param name="custom">The workspace's own rules (checked first).</param>
    /// <param name="disabledBuiltIns">Built-in kinds the workspace switched off, by label (e.g. "Address").</param>
    public PiiMasker(IEnumerable<MaskRule>? custom = null, IEnumerable<string>? disabledBuiltIns = null)
    {
        _custom = (custom ?? []).Select(r => (r, r.Match == "regex" ? SafeRegex(r.Field) : null)).ToList();
        _off = new HashSet<string>(disabledBuiltIns ?? [], StringComparer.OrdinalIgnoreCase);
    }

    private bool On(string label) => !_off.Contains(label);

    /// <summary>The built-in kinds, for the settings screen.</summary>
    public static IReadOnlyList<(string Label, string Strategy, string Example)> BuiltIns =>
    [
        ("Mobile number", "last4", "98765 43210"), ("E-mail", "email", "ravi.kumar@example.com"), ("PAN", "last2", "ABCDE1234F"), ("Aadhaar", "last4", "2345 6789 0123"),
        ("Account number", "last4", "50100123456789"), ("Card number", "last4", "4111 1111 1111 1111"), ("IFSC", "first2last2", "HDFC0001234"), ("UPI ID", "first2last2", "ravi@okhdfcbank"),
        ("Date of birth", "full", "1990-04-12"), ("ID document", "last4", "K1234567"), ("Address", "full", "12 MG Road, Hyderabad"), ("Credential", "secret", "sk_live_51Hx9QaZ"),
    ];

    private static Regex? SafeRegex(string pattern)
    {
        try { return new Regex(pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50)); } catch (ArgumentException) { return null; }
    }

    // ------------------------------------------------------------------ strategies

    public static readonly string[] Strategies = ["full", "last4", "last2", "first2last2", "email", "secret"];

    public static string Apply(string value, string strategy)
    {
        var v = value.Trim();
        if (v.Length == 0) return value;
        string Dots(int n) => new(Dot, Math.Clamp(n, 3, 12));
        return strategy switch
        {
            "last4" => v.Length <= 4 ? Dots(v.Length) : Dots(v.Length - 4) + v[^4..],
            "last2" => v.Length <= 2 ? Dots(v.Length) : Dots(v.Length - 2) + v[^2..],
            "first2last2" => v.Length <= 4 ? Dots(v.Length) : v[..2] + Dots(v.Length - 4) + v[^2..],
            "email" => v.IndexOf('@') is var at and > 0 ? v[..1] + Dots(at - 1) + v[at..] : Dots(v.Length),
            "secret" => v.Length <= 8 ? Dots(8) : v[..3] + Dots(8) + v[^2..],
            _ => Dots(v.Length),
        };
    }

    // ------------------------------------------------------------------ what is sensitive

    /// <summary>Built-in field names (normalised: lower case, no spaces, dashes or underscores) and how to mask them.</summary>
    private static readonly (string[] Names, string Strategy, string Label)[] BuiltInFields =
    [
        (["mobile", "mobileno", "mobilenumber", "phone", "phoneno", "phonenumber", "contactnumber", "msisdn", "whatsapp"], "last4", "Mobile number"),
        (["email", "emailid", "emailaddress", "mail"], "email", "E-mail"),
        (["pan", "panno", "pannumber", "pancard"], "last2", "PAN"),
        (["aadhaar", "aadhar", "aadhaarno", "aadhaarnumber", "uid", "uidai"], "last4", "Aadhaar"),
        (["accountno", "accountnumber", "acno", "bankaccount", "bankaccountnumber", "loanaccountnumber"], "last4", "Account number"),
        (["cardno", "cardnumber", "debitcard", "creditcard", "cvv"], "last4", "Card number"),
        (["ifsc", "ifsccode"], "first2last2", "IFSC"),
        (["upi", "upiid", "vpa"], "first2last2", "UPI ID"),
        (["dob", "dateofbirth", "birthdate"], "full", "Date of birth"),
        (["passport", "passportno", "passportnumber", "voterid", "drivinglicence", "drivinglicense"], "last4", "ID document"),
        (["address", "residentialaddress", "permanentaddress"], "full", "Address"),
        (["password", "passwd", "pwd", "secret", "clientsecret", "apikey", "apisecret", "accesstoken", "refreshtoken", "token", "privatekey", "authorization", "clientid"], "secret", "Credential"),
    ];

    private static string Norm(string s) => Regex.Replace(s.ToLowerInvariant(), @"[\s_\-.]", "");

    /// <summary>How a value in this field is masked, or null when the field is not sensitive.</summary>
    public (string Strategy, string Label)? RuleFor(string? field)
    {
        if (string.IsNullOrWhiteSpace(field)) return null;
        foreach (var (rule, pattern) in _custom)
        {
            var hit = rule.Match switch
            {
                "regex" => pattern?.IsMatch(field) == true,
                "contains" => field.Contains(rule.Field, StringComparison.OrdinalIgnoreCase),
                _ => Norm(field) == Norm(rule.Field),
            };
            if (hit) return (rule.Strategy, rule.Label);
        }
        var n = Norm(field);
        foreach (var (names, strategy, label) in BuiltInFields)
            if (names.Contains(n)) return On(label) ? (strategy, label) : null;
        return null;
    }

    // Shapes that are sensitive wherever they appear in prose.
    private static readonly Regex Email = new(@"\b[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9\-]{1,63}(?:\.[A-Za-z0-9\-]{1,63})+\b", RegexOptions.Compiled);
    private static readonly Regex Upi = new(@"\b[A-Za-z0-9._\-]{2,64}@(?:ok)?[A-Za-z]{3,20}\b(?!\.)", RegexOptions.Compiled);
    private static readonly Regex Mobile = new(@"(?<![\d\w])(?:\+?91[\s\-]?)?[6-9]\d{4}[\s\-]?\d{5}(?!\d)", RegexOptions.Compiled);
    private static readonly Regex Pan = new(@"\b[A-Z]{5}[0-9]{4}[A-Z]\b", RegexOptions.Compiled);
    private static readonly Regex Aadhaar = new(@"(?<!\d)[2-9]\d{3}[\s\-]?\d{4}[\s\-]?\d{4}(?!\d)", RegexOptions.Compiled);
    private static readonly Regex Card = new(@"(?<!\d)(?:\d[ \-]?){12,18}\d(?!\d)", RegexOptions.Compiled);
    private static readonly Regex Ifsc = new(@"\b[A-Z]{4}0[A-Z0-9]{6}\b", RegexOptions.Compiled);
    private static readonly Regex Bearer = new(@"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]{8,}=*", RegexOptions.Compiled);
    private static readonly Regex Labelled = new(@"(?im)\b([A-Za-z][A-Za-z _\-]{1,40}?)\s*[:=]\s*(""?)([^\s"",;]{2,200})\2", RegexOptions.Compiled);

    private static bool Luhn(string digits)
    {
        int sum = 0; bool alt = false;
        for (var i = digits.Length - 1; i >= 0; i--)
        {
            var d = digits[i] - '0';
            if (alt) { d *= 2; if (d > 9) d -= 9; }
            sum += d; alt = !alt;
        }
        return sum % 10 == 0;
    }

    private string Hide(string value, string strategy) { Count++; return Apply(value, strategy); }

    /// <summary>Masks sensitive values in a piece of prose or a code sample.</summary>
    public string MaskText(string text)
    {
        if (string.IsNullOrEmpty(text)) return text;
        var s = text;
        // "client_secret: abc123", "PAN = ABCDE1234F": the label decides.
        s = Labelled.Replace(s, m =>
        {
            if (m.Groups[3].Value.Contains(Dot)) return m.Value;
            var rule = RuleFor(m.Groups[1].Value.Trim());
            return rule is { } r ? m.Value[..(m.Groups[3].Index - m.Index)] + Hide(m.Groups[3].Value, r.Strategy) + m.Value[(m.Groups[3].Index - m.Index + m.Groups[3].Length)..] : m.Value;
        });
        if (On("Credential")) s = Bearer.Replace(s, m => m.Groups[1].Value + " " + Hide(m.Value[(m.Groups[1].Length + 1)..].Trim(), "secret"));
        if (On("E-mail")) s = Email.Replace(s, m => Hide(m.Value, "email"));
        if (On("UPI ID")) s = Upi.Replace(s, m => m.Value.Contains(Dot) ? m.Value : Hide(m.Value, "first2last2"));
        if (On("PAN")) s = Pan.Replace(s, m => Hide(m.Value, "last2"));
        if (On("IFSC")) s = Ifsc.Replace(s, m => Hide(m.Value, "first2last2"));
        if (On("Card number")) s = Card.Replace(s, m => { var d = new string(m.Value.Where(char.IsDigit).ToArray()); return d.Length is >= 13 and <= 19 && Luhn(d) ? Hide(m.Value, "last4") : m.Value; });
        if (On("Aadhaar")) s = Aadhaar.Replace(s, m => Hide(m.Value, "last4"));
        if (On("Mobile number")) s = Mobile.Replace(s, m => Hide(m.Value, "last4"));
        // A custom regex rule may describe a value shape rather than a field name.
        foreach (var (rule, pattern) in _custom)
            if (pattern is not null && rule.Match == "regex")
                try { s = pattern.Replace(s, m => m.Value.Contains(Dot) ? m.Value : Hide(m.Value, rule.Strategy)); } catch (RegexMatchTimeoutException) { }
        return s;
    }

    /// <summary>A JSON sample: values under sensitive keys by their rule, every other string by its shape.</summary>
    public JsonNode? MaskJson(JsonNode? node, string? key = null)
    {
        switch (node)
        {
            case JsonObject o:
                foreach (var p in o.ToList()) o[p.Key] = MaskJson(p.Value?.DeepClone(), p.Key);
                return o;
            case JsonArray a:
                for (var i = 0; i < a.Count; i++) a[i] = MaskJson(a[i]?.DeepClone(), key);
                return a;
            case JsonValue v:
                var text = v.ToString();
                if (RuleFor(key) is { } r && text.Length > 0) return JsonValue.Create(Hide(text, r.Strategy));
                return v.TryGetValue<string>(out var str) ? JsonValue.Create(MaskText(str)) : v;
            default: return node;
        }
    }

    /// <summary>A rich-text section (TipTap JSON): text is masked by shape and label; code blocks that hold JSON are masked by key.</summary>
    public string MaskRichText(string json)
    {
        JsonNode? root;
        try { root = JsonNode.Parse(json); } catch (JsonException) { return MaskText(json); }
        Walk(root);
        return root?.ToJsonString() ?? json;

        void Walk(JsonNode? n)
        {
            if (n is not JsonObject o) return;
            if (o["type"]?.ToString() == "codeBlock" && o["content"] is JsonArray code)
            {
                var all = string.Concat(code.Select(c => c?["text"]?.ToString() ?? ""));
                var masked = TryJson(all) ?? MaskText(all);
                if (masked != all) { code.Clear(); code.Add(new JsonObject { ["type"] = "text", ["text"] = masked }); }
                return;
            }
            if (o["type"]?.ToString() == "text" && o["text"] is JsonValue t) o["text"] = MaskText(t.ToString());
            if (o["content"] is JsonArray kids) foreach (var k in kids) Walk(k);
        }
    }

    private string? TryJson(string text)
    {
        var t = text.Trim();
        if (!(t.StartsWith('{') || t.StartsWith('['))) return null;
        try { return MaskJson(JsonNode.Parse(t))?.ToJsonString(new JsonSerializerOptions { WriteIndented = true }); } catch (JsonException) { return null; }
    }

    /// <summary>A table section ({columns:[{key,label}], rows:[{key: value}]}): a sensitive column is masked whole; other cells by shape.</summary>
    public string MaskTable(string json)
    {
        JsonObject? root;
        try { root = JsonNode.Parse(json) as JsonObject; } catch (JsonException) { return json; }
        if (root is null) return json;
        var columns = (root["columns"] as JsonArray ?? []).OfType<JsonObject>()
            .ToDictionary(c => c["key"]?.ToString() ?? "", c => RuleFor(c["label"]?.ToString()) ?? RuleFor(c["key"]?.ToString()));
        foreach (var row in (root["rows"] as JsonArray ?? []).OfType<JsonObject>())
            foreach (var cell in row.ToList())
            {
                if (cell.Value is not JsonValue v || !v.TryGetValue<string>(out var text) || text.Length == 0) continue;
                row[cell.Key] = columns.GetValueOrDefault(cell.Key) is { } r ? Hide(text, r.Strategy) : MaskText(text);
            }
        return root.ToJsonString();
    }

    /// <summary>One section's content, masked according to its kind.</summary>
    public string MaskSection(string kind, string content) => kind == "Table" ? MaskTable(content) : MaskRichText(content);

    /// <summary>True when content still carries a run of mask dots - a masked copy that must never be saved over the original.</summary>
    public static bool LooksMasked(string content) => content.Contains(new string(Dot, 3), StringComparison.Ordinal);
}
