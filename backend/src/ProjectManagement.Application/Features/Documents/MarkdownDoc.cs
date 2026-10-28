using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ProjectManagement.Application.Features.Documents;

/// <summary>
/// Turns the Markdown an AI model writes into the page editor's ProseMirror JSON (and back to plain Markdown for prompts): headings, paragraphs,
/// bulleted, numbered and to-do lists (one level of nesting), quotes, code blocks, tables, dividers, and bold, italic, strike, inline code and
/// links. The result still goes through <see cref="SectionContent.NormalizeRichText"/> when it is saved, like anything typed.
/// </summary>
public static partial class MarkdownDoc
{
    [GeneratedRegex(@"^(#{1,6})\s+(.*)$")] private static partial Regex Heading();
    [GeneratedRegex(@"^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$")] private static partial Regex ListLine();
    [GeneratedRegex(@"^\[( |x|X)\]\s+(.*)$")] private static partial Regex TaskBox();
    [GeneratedRegex(@"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$")] private static partial Regex TableRule();
    [GeneratedRegex(@"^\s*([-*_])\s*(\1\s*){2,}$")] private static partial Regex Rule();
    [GeneratedRegex(@"(\*\*|__)(.+?)\1|~~(.+?)~~|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])")]
    private static partial Regex Inline();

    public static JsonObject ToDoc(string? markdown)
    {
        var lines = (markdown ?? "").Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        var blocks = new JsonArray();
        var i = 0;
        while (i < lines.Length)
        {
            var line = lines[i];
            if (string.IsNullOrWhiteSpace(line)) { i++; continue; }
            var t = line.Trim();

            if (t.StartsWith("```"))
            {
                var lang = new string(t[3..].Trim().TakeWhile(c => char.IsLetterOrDigit(c) || c is '-' or '+' or '#').ToArray());
                var code = new List<string>();
                i++;
                while (i < lines.Length && !lines[i].Trim().StartsWith("```")) code.Add(lines[i++]);
                i++;
                var cb = new JsonObject { ["type"] = "codeBlock" };
                if (lang.Length is > 0 and <= 20) cb["attrs"] = new JsonObject { ["language"] = lang };
                var text = string.Join("\n", code);
                if (text.Length > 0) cb["content"] = new JsonArray(Text(text));
                blocks.Add(cb);
                continue;
            }
            if (Heading().Match(t) is { Success: true } h)
            {
                blocks.Add(new JsonObject { ["type"] = "heading", ["attrs"] = new JsonObject { ["level"] = Math.Min(4, h.Groups[1].Length) }, ["content"] = Runs(h.Groups[2].Value.TrimEnd('#', ' ')) });
                i++; continue;
            }
            if (Rule().IsMatch(t)) { blocks.Add(new JsonObject { ["type"] = "horizontalRule" }); i++; continue; }
            if (t.StartsWith('>'))
            {
                var quote = new List<string>();
                while (i < lines.Length && lines[i].Trim().StartsWith('>')) quote.Add(lines[i++].Trim()[1..].TrimStart());
                var inner = ToDoc(string.Join("\n", quote))["content"]!.AsArray();
                blocks.Add(new JsonObject { ["type"] = "blockquote", ["content"] = new JsonArray(inner.Select(n => n!.DeepClone()).ToArray()) });
                continue;
            }
            if (t.StartsWith('|') && i + 1 < lines.Length && TableRule().IsMatch(lines[i + 1]))
            {
                var header = Cells(t);
                i += 2;
                var rows = new List<List<string>>();
                while (i < lines.Length && lines[i].Trim().StartsWith('|')) rows.Add(Cells(lines[i++].Trim()));
                var table = new JsonArray { Row(header, "tableHeader", header.Count) };
                foreach (var r in rows) table.Add(Row(r, "tableCell", header.Count));
                blocks.Add(new JsonObject { ["type"] = "table", ["content"] = table });
                continue;
            }
            if (ListLine().IsMatch(line))
            {
                blocks.Add(List(lines, ref i, Indent(line)));
                continue;
            }
            // A paragraph: consecutive lines until a blank one or another kind of block.
            var para = new List<string> { t };
            i++;
            while (i < lines.Length && !string.IsNullOrWhiteSpace(lines[i]) && !StartsBlock(lines, i)) para.Add(lines[i++].Trim());
            blocks.Add(new JsonObject { ["type"] = "paragraph", ["content"] = Runs(string.Join(" ", para)) });
        }
        if (blocks.Count == 0) blocks.Add(new JsonObject { ["type"] = "paragraph" });
        foreach (var b in blocks.OfType<JsonObject>()) if (b["content"] is JsonArray { Count: 0 }) b.Remove("content");
        return new JsonObject { ["type"] = "doc", ["content"] = blocks };
    }

    public static string ToJson(string? markdown) => ToDoc(markdown).ToJsonString();

    /// <summary>The blocks of a converted text, to insert into a page where the cursor is.</summary>
    public static JsonArray Blocks(string? markdown) => ToDoc(markdown)["content"]!.AsArray();

    private static bool StartsBlock(string[] lines, int i)
    {
        var t = lines[i].Trim();
        return t.StartsWith("```") || t.StartsWith('>') || Heading().IsMatch(t) || Rule().IsMatch(t) || ListLine().IsMatch(lines[i])
            || (t.StartsWith('|') && i + 1 < lines.Length && TableRule().IsMatch(lines[i + 1]));
    }

    private static int Indent(string line) => line.TakeWhile(c => c is ' ' or '\t').Sum(c => c == '\t' ? 4 : 1);

    private static JsonObject List(string[] lines, ref int i, int indent)
    {
        var first = ListLine().Match(lines[i]);
        var ordered = char.IsDigit(first.Groups[2].Value[0]);
        var task = !ordered && TaskBox().IsMatch(first.Groups[3].Value);
        var items = new JsonArray();
        while (i < lines.Length)
        {
            if (string.IsNullOrWhiteSpace(lines[i])) { if (i + 1 < lines.Length && ListLine().IsMatch(lines[i + 1]) && Indent(lines[i + 1]) >= indent) { i++; continue; } break; }
            var m = ListLine().Match(lines[i]);
            if (!m.Success) break;
            var ind = Indent(lines[i]);
            if (ind < indent) break;
            // A different kind of list at the same depth (numbers after bullets) starts a new list.
            if (ind == indent && char.IsDigit(m.Groups[2].Value[0]) != ordered) break;
            if (ind > indent && items.Count > 0)
            {
                // A nested list belongs to the item above it.
                var nested = List(lines, ref i, ind);
                (items[^1]!["content"] as JsonArray)!.Add(nested);
                continue;
            }
            var text = m.Groups[3].Value;
            var item = new JsonObject();
            if (task && TaskBox().Match(text) is { Success: true } box)
            {
                item["type"] = "taskItem";
                item["attrs"] = new JsonObject { ["checked"] = box.Groups[1].Value is "x" or "X" };
                text = box.Groups[2].Value;
            }
            else item["type"] = "listItem";
            var para = new JsonObject { ["type"] = "paragraph" };
            var runs = Runs(text.Trim());
            if (runs.Count > 0) para["content"] = runs;
            item["content"] = new JsonArray(para);
            items.Add(item);
            i++;
        }
        var list = new JsonObject { ["type"] = task ? "taskList" : ordered ? "orderedList" : "bulletList", ["content"] = items };
        if (ordered && int.TryParse(new string(first.Groups[2].Value.TakeWhile(char.IsDigit).ToArray()), out var start) && start > 1) list["attrs"] = new JsonObject { ["start"] = start };
        return list;
    }

    private static List<string> Cells(string row)
    {
        var r = row.Trim();
        if (r.StartsWith('|')) r = r[1..];
        if (r.EndsWith('|')) r = r[..^1];
        return r.Split('|').Select(c => c.Trim()).ToList();
    }

    private static JsonObject Row(List<string> cells, string kind, int width)
    {
        var row = new JsonArray();
        for (var c = 0; c < Math.Max(1, width); c++)
        {
            var para = new JsonObject { ["type"] = "paragraph" };
            var runs = Runs(c < cells.Count ? cells[c] : "");
            if (runs.Count > 0) para["content"] = runs;
            row.Add(new JsonObject { ["type"] = kind, ["content"] = new JsonArray(para) });
        }
        return new JsonObject { ["type"] = "tableRow", ["content"] = row };
    }

    private static JsonObject Text(string text, JsonArray? marks = null)
    {
        var o = new JsonObject { ["type"] = "text", ["text"] = text };
        if (marks is { Count: > 0 }) o["marks"] = marks;
        return o;
    }

    /// <summary>Inline Markdown as text runs with marks.</summary>
    public static JsonArray Runs(string text, JsonArray? outer = null)
    {
        var runs = new JsonArray();
        var at = 0;
        JsonArray With(string mark, JsonObject? attrs = null)
        {
            var a = outer is null ? new JsonArray() : new JsonArray(outer.Select(x => x!.DeepClone()).ToArray());
            var m = new JsonObject { ["type"] = mark };
            if (attrs is not null) m["attrs"] = attrs;
            a.Add(m);
            return a;
        }
        void Plain(string s) { if (s.Length > 0) runs.Add(Text(s, outer is null ? null : new JsonArray(outer.Select(x => x!.DeepClone()).ToArray()))); }
        foreach (Match m in Inline().Matches(text))
        {
            Plain(text[at..m.Index]);
            if (m.Groups[2].Success) foreach (var r in Runs(m.Groups[2].Value, With("bold"))) runs.Add(r!.DeepClone());
            else if (m.Groups[3].Success) foreach (var r in Runs(m.Groups[3].Value, With("strike"))) runs.Add(r!.DeepClone());
            else if (m.Groups[4].Success) runs.Add(Text(m.Groups[4].Value, With("code")));
            else if (m.Groups[5].Success)
            {
                var href = m.Groups[6].Value;
                if (href.StartsWith("http://") || href.StartsWith("https://") || href.StartsWith("mailto:") || href.StartsWith('/'))
                    foreach (var r in Runs(m.Groups[5].Value, With("link", new JsonObject { ["href"] = href }))) runs.Add(r!.DeepClone());
                else Plain(m.Groups[5].Value);
            }
            else if (m.Groups[7].Success) foreach (var r in Runs(m.Groups[7].Value, With("italic"))) runs.Add(r!.DeepClone());
            else if (m.Groups[8].Success) foreach (var r in Runs(m.Groups[8].Value, With("italic"))) runs.Add(r!.DeepClone());
            at = m.Index + m.Length;
        }
        Plain(text[at..]);
        return runs;
    }

    /// <summary>A page's text as Markdown, block by block (headings, lists and tables keep their shape), for prompts and for "ask the space".</summary>
    public static List<string> ToBlocks(string? json)
    {
        var outList = new List<string>();
        if (string.IsNullOrWhiteSpace(json)) return outList;
        JsonNode? root;
        try { root = JsonNode.Parse(json); } catch { return outList; }
        foreach (var b in (root?["content"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var s = Block(b, "").TrimEnd();
            if (s.Length > 0) outList.Add(s);
        }
        return outList;
    }

    public static string ToMarkdown(string? json) => string.Join("\n\n", ToBlocks(json));

    private static string Block(JsonObject b, string indent)
    {
        var type = b["type"]?.GetValue<string>() ?? "";
        var kids = b["content"] as JsonArray ?? [];
        switch (type)
        {
            case "heading":
                var level = b["attrs"]?["level"] is JsonValue lv && lv.TryGetValue<int>(out var l) ? l : 2;
                return new string('#', Math.Clamp(level, 1, 6)) + " " + InlineText(kids);
            case "paragraph": return indent + InlineText(kids);
            case "bulletList" or "orderedList" or "taskList":
                var sb = new StringBuilder();
                var n = 1;
                foreach (var item in kids.OfType<JsonObject>())
                {
                    var marker = type == "orderedList" ? $"{n++}." : type == "taskList" ? (item["attrs"]?["checked"]?.GetValue<bool>() == true ? "- [x]" : "- [ ]") : "-";
                    var parts = (item["content"] as JsonArray ?? []).OfType<JsonObject>().ToList();
                    sb.Append(indent).Append(marker).Append(' ').Append(parts.Count > 0 && parts[0]["type"]?.GetValue<string>() == "paragraph" ? InlineText(parts[0]["content"] as JsonArray ?? []) : "").Append('\n');
                    foreach (var p in parts.Skip(1)) sb.Append(Block(p, indent + "  ")).Append('\n');
                }
                return sb.ToString().TrimEnd('\n');
            case "blockquote": return string.Join("\n", kids.OfType<JsonObject>().Select(k => "> " + Block(k, "")));
            case "codeBlock": return "```" + (b["attrs"]?["language"]?.GetValue<string>() ?? "") + "\n" + InlineText(kids) + "\n```";
            case "horizontalRule": return "---";
            case "callout": return string.Join("\n", kids.OfType<JsonObject>().Select(k => "> " + Block(k, "")));
            case "details":
                // A toggle: its summary line, then what it hides.
                return string.Join("\n", kids.OfType<JsonObject>().Select(k => k["type"]?.GetValue<string>() == "detailsSummary" ? "**" + InlineText(k["content"] as JsonArray ?? []) + "**"
                    : string.Join("\n", (k["content"] as JsonArray ?? []).OfType<JsonObject>().Select(x => Block(x, indent)))));
            case "table":
                var rows = kids.OfType<JsonObject>().Select(r => (r["content"] as JsonArray ?? []).OfType<JsonObject>()
                    .Select(c => string.Join(" ", (c["content"] as JsonArray ?? []).OfType<JsonObject>().Select(p => InlineText(p["content"] as JsonArray ?? []))).Replace("|", "/")).ToList()).ToList();
                if (rows.Count == 0) return "";
                var t = new StringBuilder();
                t.Append("| ").Append(string.Join(" | ", rows[0])).Append(" |\n|").Append(string.Join("|", rows[0].Select(_ => "---"))).Append("|\n");
                foreach (var r in rows.Skip(1)) t.Append("| ").Append(string.Join(" | ", r)).Append(" |\n");
                return t.ToString().TrimEnd('\n');
            case "liveTasks": return "(live task list)";
            case "motionLottie" or "motionSvg" or "motionVideo" or "sandboxEmbed": return "_" + DocumentDiff.MotionStill(b) + "_";
            default: return InlineText(kids);
        }
    }

    private static string InlineText(JsonArray runs)
    {
        var sb = new StringBuilder();
        foreach (var r in runs.OfType<JsonObject>())
        {
            var type = r["type"]?.GetValue<string>();
            if (type == "text")
            {
                var s = r["text"]?.GetValue<string>() ?? "";
                var marks = (r["marks"] as JsonArray ?? []).OfType<JsonObject>().Select(m => m["type"]?.GetValue<string>()).ToHashSet();
                if (marks.Contains("code")) s = "`" + s + "`";
                if (marks.Contains("bold")) s = "**" + s + "**";
                if (marks.Contains("italic")) s = "*" + s + "*";
                sb.Append(s);
            }
            else if (type == "mention") sb.Append(r["attrs"]?["kind"]?.GetValue<string>() == "task" ? "#" : r["attrs"]?["kind"]?.GetValue<string>() == "page" ? "" : "@").Append(r["attrs"]?["label"]?.GetValue<string>());
            else if (type == "hardBreak") sb.Append('\n');
            else if (r["content"] is JsonArray inner) sb.Append(InlineText(inner));
        }
        return sb.ToString();
    }
}
