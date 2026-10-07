using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Documents;

public enum SectionChange { Unchanged, Changed, Added, Removed }
public record WordPart(string Op, string Text);
/// <summary>One line of a text section: equal, added or removed. Changed lines carry a word-level view of what changed inside them.</summary>
public record DiffLine(string Op, string Text, string Style, IReadOnlyList<WordPart>? Words = null);
public record DiffRow(string Op, IReadOnlyList<string> Cells, IReadOnlyList<int>? ChangedCells = null);
public record SectionDiff(string Key, string Title, SectionKind Kind, SectionChange Change, IReadOnlyList<DiffLine>? Lines, IReadOnlyList<string>? Columns, IReadOnlyList<DiffRow>? Rows, bool FormattingOnly = false);
public record VersionRef(Guid Id, string Label, bool IsDraft, DateTime? PublishedAt);
public record VersionDiff(VersionRef From, VersionRef To, IReadOnlyList<SectionDiff> Sections, int Changed, int Added, int Removed, int Unchanged);

/// <summary>
/// What changed between two versions of a document, section by section. Text sections are compared line by line (a paragraph, a list item, a table row of
/// a text table) with a word-level view inside changed lines; table sections row by row with the changed cells marked. Formatting alone (bold, a link)
/// is reported as "formatting only" rather than shown as a text change.
/// </summary>
public static class DocumentDiff
{
    private const long MaxCells = 4_000_000;

    public sealed record Snapshot(string Key, string Title, SectionKind Kind, int SortOrder, string Content);

    public static VersionDiff Compare(VersionRef from, IReadOnlyList<Snapshot> a, VersionRef to, IReadOnlyList<Snapshot> b)
    {
        var left = a.ToDictionary(x => x.Key); var right = b.ToDictionary(x => x.Key);
        var order = b.Select(x => x.Key).Concat(a.Select(x => x.Key).Where(k => !right.ContainsKey(k))).ToList();
        var sections = new List<SectionDiff>();
        foreach (var key in order)
        {
            left.TryGetValue(key, out var l); right.TryGetValue(key, out var r);
            var any = (r ?? l)!;
            if (l is null) sections.Add(Describe(r!, SectionChange.Added));
            else if (r is null) sections.Add(Describe(l, SectionChange.Removed));
            else if (l.Content == r.Content) sections.Add(new SectionDiff(key, r.Title, r.Kind, SectionChange.Unchanged, null, null, null));
            else sections.Add(r.Kind == SectionKind.Table ? DiffTable(l, r) : DiffText(l, r));
        }
        int Count(SectionChange c) => sections.Count(s => s.Change == c);
        return new VersionDiff(from, to, sections, Count(SectionChange.Changed), Count(SectionChange.Added), Count(SectionChange.Removed), Count(SectionChange.Unchanged));
    }

    private static SectionDiff Describe(Snapshot s, SectionChange change)
    {
        var op = change == SectionChange.Added ? "add" : "del";
        if (s.Kind == SectionKind.Table)
        {
            var (cols, rows) = ReadTable(s.Content);
            return new SectionDiff(s.Key, s.Title, s.Kind, change, null, cols, rows.Select(r => new DiffRow(op, r)).ToList());
        }
        return new SectionDiff(s.Key, s.Title, s.Kind, change, TextLines(s.Content).Select(l => new DiffLine(op, l.Text, l.Style)).ToList(), null, null);
    }

    // ------------------------------------------------------------------ text

    public sealed record Line(string Text, string Style, string? Lang = null);

    public static List<Line> TextLines(string json)
    {
        var lines = new List<Line>();
        try { Walk(JsonNode.Parse(json), lines, "p", ""); } catch (JsonException) { }
        return lines.Where(l => l.Text.Length > 0).ToList();
    }

    private static string Inline(JsonNode? n)
    {
        var sb = new StringBuilder();
        void Go(JsonNode? x)
        {
            if (x is not JsonObject o) return;
            switch (o["type"]?.GetValue<string>())
            {
                case "text": sb.Append(o["text"]?.GetValue<string>()); break;
                case "hardBreak": sb.Append(' '); break;
                case "docImage": sb.Append("[image] ").Append(o["attrs"]?["alt"]?.GetValue<string>()); break;
                default: foreach (var c in o["content"] as JsonArray ?? []) Go(c); break;
            }
        }
        Go(n);
        return sb.ToString().Trim();
    }

    private static void Walk(JsonNode? node, List<Line> lines, string style, string prefix)
    {
        if (node is not JsonObject o) return;
        var type = o["type"]?.GetValue<string>();
        var kids = o["content"] as JsonArray ?? [];
        switch (type)
        {
            case "doc": foreach (var k in kids) Walk(k, lines, "p", ""); break;
            case "heading": lines.Add(new Line(Inline(o), "h")); break;
            case "paragraph": lines.Add(new Line(prefix + Inline(o), style)); break;
            case "codeBlock": lines.Add(new Line(Inline(o), "code", o["attrs"]?["language"]?.GetValue<string>())); break;
            case "blockquote": foreach (var k in kids) Walk(k, lines, "quote", ""); break;
            case "bulletList": foreach (var k in kids) Walk(k, lines, "li", "• "); break;
            case "orderedList": { var i = 1; foreach (var k in kids) Walk(k, lines, "li", $"{i++}. "); break; }
            case "taskList": foreach (var k in kids) Walk(k, lines, "li", "☐ "); break;
            case "listItem": case "taskItem":
                {
                    var checkedItem = type == "taskItem" && o["attrs"]?["checked"]?.GetValue<bool>() == true;
                    var p = checkedItem ? "☑ " : prefix;
                    foreach (var k in kids) { if (k is JsonObject ko && ko["type"]?.GetValue<string>() is "paragraph") { lines.Add(new Line(p + Inline(ko), "li")); p = "    "; } else Walk(k, lines, "li", "    "); }
                    break;
                }
            case "table": foreach (var row in kids.OfType<JsonObject>()) lines.Add(new Line(string.Join(" | ", (row["content"] as JsonArray ?? []).Select(Inline)), "row")); break;
            case "docImage": lines.Add(new Line(Inline(o), "img")); break;
            default: foreach (var k in kids) Walk(k, lines, style, prefix); break;
        }
    }

    private static SectionDiff DiffText(Snapshot l, Snapshot r)
    {
        var a = TextLines(l.Content); var b = TextLines(r.Content);
        var ops = Lcs(a.Select(x => x.Text).ToList(), b.Select(x => x.Text).ToList());
        var lines = new List<DiffLine>();
        int ia = 0, ib = 0;
        var pendingDel = new List<Line>(); var pendingAdd = new List<Line>();
        void Flush()
        {
            var pairs = Math.Min(pendingDel.Count, pendingAdd.Count);
            for (var i = 0; i < pairs; i++)
            {
                var words = Words(pendingDel[i].Text, pendingAdd[i].Text);
                lines.Add(new DiffLine("del", pendingDel[i].Text, pendingDel[i].Style, words.Where(w => w.Op != "add").ToList()));
                lines.Add(new DiffLine("add", pendingAdd[i].Text, pendingAdd[i].Style, words.Where(w => w.Op != "del").ToList()));
            }
            for (var i = pairs; i < pendingDel.Count; i++) lines.Add(new DiffLine("del", pendingDel[i].Text, pendingDel[i].Style));
            for (var i = pairs; i < pendingAdd.Count; i++) lines.Add(new DiffLine("add", pendingAdd[i].Text, pendingAdd[i].Style));
            pendingDel.Clear(); pendingAdd.Clear();
        }
        foreach (var op in ops)
        {
            if (op == '=') { Flush(); lines.Add(new DiffLine("eq", b[ib].Text, b[ib].Style)); ia++; ib++; }
            else if (op == '-') pendingDel.Add(a[ia++]);
            else pendingAdd.Add(b[ib++]);
        }
        Flush();
        var formattingOnly = lines.All(x => x.Op == "eq");
        return new SectionDiff(r.Key, r.Title, r.Kind, SectionChange.Changed, lines, null, null, formattingOnly);
    }

    private static List<WordPart> Words(string from, string to)
    {
        var a = from.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList(); var b = to.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList();
        var parts = new List<WordPart>();
        int ia = 0, ib = 0;
        foreach (var op in Lcs(a, b))
        {
            if (op == '=') { parts.Add(new WordPart("eq", b[ib])); ia++; ib++; }
            else if (op == '-') parts.Add(new WordPart("del", a[ia++]));
            else parts.Add(new WordPart("add", b[ib++]));
        }
        return parts;
    }

    // ------------------------------------------------------------------ tables

    public static (List<string> Columns, List<List<string>> Rows) ReadTable(string json)
    {
        var cols = new List<string>(); var keys = new List<string>(); var rows = new List<List<string>>();
        try
        {
            var o = JsonNode.Parse(json) as JsonObject;
            foreach (var c in (o?["columns"] as JsonArray ?? []).OfType<JsonObject>()) { keys.Add(c["key"]?.GetValue<string>() ?? ""); cols.Add(c["label"]?.GetValue<string>() ?? ""); }
            foreach (var r in (o?["rows"] as JsonArray ?? []).OfType<JsonObject>()) rows.Add(keys.Select(k => r[k]?.GetValue<string>() ?? "").ToList());
        }
        catch (JsonException) { }
        return (cols, rows);
    }

    private static SectionDiff DiffTable(Snapshot l, Snapshot r)
    {
        var (_, ra) = ReadTable(l.Content); var (cols, rb) = ReadTable(r.Content);
        var ops = Lcs(ra.Select(x => string.Join("\u001f", x)).ToList(), rb.Select(x => string.Join("\u001f", x)).ToList());
        var rows = new List<DiffRow>();
        int ia = 0, ib = 0;
        var del = new List<List<string>>(); var add = new List<List<string>>();
        void Flush()
        {
            var pairs = Math.Min(del.Count, add.Count);
            for (var i = 0; i < pairs; i++)
                rows.Add(new DiffRow("chg", add[i], Enumerable.Range(0, add[i].Count).Where(c => c >= del[i].Count || del[i][c] != add[i][c]).ToList()));
            for (var i = pairs; i < del.Count; i++) rows.Add(new DiffRow("del", del[i]));
            for (var i = pairs; i < add.Count; i++) rows.Add(new DiffRow("add", add[i]));
            del.Clear(); add.Clear();
        }
        foreach (var op in ops)
        {
            if (op == '=') { Flush(); rows.Add(new DiffRow("eq", rb[ib])); ia++; ib++; }
            else if (op == '-') del.Add(ra[ia++]);
            else add.Add(rb[ib++]);
        }
        Flush();
        return new SectionDiff(r.Key, r.Title, r.Kind, SectionChange.Changed, null, cols, rows);
    }

    // ------------------------------------------------------------------ longest common subsequence

    /// <summary>The edit script from <paramref name="a"/> to <paramref name="b"/>: '=' keep, '-' drop an item of a, '+' take an item of b. Huge inputs fall back to "replace everything".</summary>
    public static List<char> Lcs(IReadOnlyList<string> a, IReadOnlyList<string> b)
    {
        var script = new List<char>();
        int start = 0;
        while (start < a.Count && start < b.Count && a[start] == b[start]) { script.Add('='); start++; }
        int endA = a.Count, endB = b.Count, tail = 0;
        while (endA > start && endB > start && a[endA - 1] == b[endB - 1]) { endA--; endB--; tail++; }
        int n = endA - start, m = endB - start;
        if (n == 0) script.AddRange(Enumerable.Repeat('+', m));
        else if (m == 0) script.AddRange(Enumerable.Repeat('-', n));
        else if ((long)n * m > MaxCells) { script.AddRange(Enumerable.Repeat('-', n)); script.AddRange(Enumerable.Repeat('+', m)); }
        else
        {
            var t = new int[n + 1, m + 1];
            for (var i = n - 1; i >= 0; i--)
                for (var j = m - 1; j >= 0; j--)
                    t[i, j] = a[start + i] == b[start + j] ? t[i + 1, j + 1] + 1 : Math.Max(t[i + 1, j], t[i, j + 1]);
            int x = 0, y = 0;
            while (x < n && y < m)
            {
                if (a[start + x] == b[start + y]) { script.Add('='); x++; y++; }
                else if (t[x + 1, y] >= t[x, y + 1]) { script.Add('-'); x++; }
                else { script.Add('+'); y++; }
            }
            script.AddRange(Enumerable.Repeat('-', n - x)); script.AddRange(Enumerable.Repeat('+', m - y));
        }
        script.AddRange(Enumerable.Repeat('=', tail));
        return script;
    }
}
