using System.Text.Json;
using System.Text.Json.Nodes;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Documents;

/// <summary>
/// What the server accepts as the content of a section. Rich text is ProseMirror JSON and is only ever stored as data: nodes and marks outside an allow-list
/// are dropped, links must be web or mail addresses, and nothing is ever stored or served as HTML, so a pasted script has nowhere to run.
/// Tables are a small grid of plain-text cells.
/// </summary>
public static class SectionContent
{
    public const int MaxChars = 200_000, MaxNodes = 20_000, MaxDepth = 14, MaxColumns = 12, MaxRows = 500, MaxCell = 2000;
    private const string Empty = """{"type":"doc","content":[{"type":"paragraph"}]}""";

    private static readonly HashSet<string> Blocks = ["doc", "paragraph", "heading", "bulletList", "orderedList", "listItem", "blockquote", "codeBlock", "horizontalRule", "table", "tableRow", "tableCell", "tableHeader", "taskList", "taskItem", "docImage", "archDiagram", "callout", "details", "detailsSummary", "detailsContent", "liveTasks"];
    private static readonly HashSet<string> Inline = ["text", "hardBreak", "mention"];
    private static readonly HashSet<string> MentionKinds = ["person", "task", "page"];
    private static readonly HashSet<string> CalloutTones = ["info", "warning", "success", "danger"];
    private static readonly HashSet<string> Marks = ["bold", "italic", "underline", "strike", "code", "link", "highlight", "comment"];
    private static readonly HashSet<string> TaskFilters = ["open", "mine", "overdue", "done", "all"];
    private static readonly string[] SafeLinks = ["http://", "https://", "mailto:", "/", "#"];

    /// <param name="images">The files of this document an image may point to; an image that points anywhere else is dropped.</param>
    public static string Normalize(SectionKind kind, string? content, string field = "content", IReadOnlySet<Guid>? images = null) =>
        kind == SectionKind.Table ? NormalizeTable(content, field) : NormalizeRichText(content, field, images);

    public static string NormalizeRichText(string? content, string field = "content", IReadOnlySet<Guid>? images = null)
    {
        if (string.IsNullOrWhiteSpace(content)) return Empty;
        if (content.Length > MaxChars) throw new ValidationException(field, "This section is too long. Split it into two sections or shorten it.");
        JsonNode? root;
        try { root = JsonNode.Parse(content, documentOptions: new JsonDocumentOptions { MaxDepth = 64 }); }
        catch (JsonException) { throw new ValidationException(field, "The text could not be read."); }
        if (root is not JsonObject obj || obj["type"]?.GetValue<string>() != "doc") throw new ValidationException(field, "The text could not be read.");
        var budget = MaxNodes;
        var clean = CleanNode(obj, 0, ref budget, images ?? new HashSet<Guid>()) ?? new JsonObject { ["type"] = "doc", ["content"] = new JsonArray(new JsonObject { ["type"] = "paragraph" }) };
        return clean.ToJsonString();
    }

    private static JsonObject? CleanNode(JsonObject node, int depth, ref int budget, IReadOnlySet<Guid> images)
    {
        if (depth > MaxDepth || --budget < 0) throw new ValidationException("content", "This section is too complex. Simplify it or split it.");
        var type = node["type"] is JsonValue tv && tv.TryGetValue<string>(out var t) ? t : null;
        if (type is null || !(Blocks.Contains(type) || Inline.Contains(type))) return null;
        var o = new JsonObject { ["type"] = type };

        if (type == "text")
        {
            var text = node["text"] is JsonValue v && v.TryGetValue<string>(out var s) ? s : "";
            if (text.Length == 0) return null;
            o["text"] = text.Length > 20_000 ? text[..20_000] : text;
            if (node["marks"] is JsonArray marks)
            {
                var kept = new JsonArray();
                foreach (var m in marks.OfType<JsonObject>())
                {
                    var mt = m["type"] is JsonValue mv && mv.TryGetValue<string>(out var ms) ? ms : null;
                    if (mt is null || !Marks.Contains(mt)) continue;
                    var mark = new JsonObject { ["type"] = mt };
                    if (mt == "link")
                    {
                        var href = m["attrs"]?["href"] is JsonValue hv && hv.TryGetValue<string>(out var hs) ? hs.Trim() : "";
                        if (!SafeLinks.Any(p => href.StartsWith(p, StringComparison.OrdinalIgnoreCase)) || href.StartsWith("//") || href.Length > 2000) continue;
                        mark["attrs"] = new JsonObject { ["href"] = href };
                    }
                    if (mt == "comment")
                    {
                        // The thread a highlighted passage belongs to, by id only.
                        var cid = m["attrs"]?["id"] is JsonValue cv && cv.TryGetValue<string>(out var cs) ? cs.Trim() : "";
                        if (cid.Length is 0 or > 40 || !cid.All(c => char.IsLetterOrDigit(c) || c == '-')) continue;
                        mark["attrs"] = new JsonObject { ["id"] = cid };
                    }
                    kept.Add(mark);
                }
                if (kept.Count > 0) o["marks"] = kept;
            }
            return o;
        }

        if (type == "docImage")
        {
            // An image is only ever a file of this document, named by id: never an address someone typed.
            var id = node["attrs"]?["fileId"] is JsonValue fv && fv.TryGetValue<string>(out var fs) && Guid.TryParse(fs, out var g) ? g : Guid.Empty;
            if (!images.Contains(id)) return null;
            var alt = node["attrs"]?["alt"] is JsonValue av && av.TryGetValue<string>(out var a2) ? a2 : "";
            o["attrs"] = new JsonObject { ["fileId"] = id.ToString(), ["alt"] = alt.Length > 200 ? alt[..200] : alt };
            return o;
        }

        if (type == "mention")
        {
            // @person, #task or [[page]]: who or what it points to by id, and the words shown. Never an address or markup.
            var kind = node["attrs"]?["kind"] is JsonValue kv && kv.TryGetValue<string>(out var ks) ? ks : "";
            var mid = node["attrs"]?["id"] is JsonValue iv && iv.TryGetValue<string>(out var ids) ? ids.Trim() : "";
            var label = node["attrs"]?["label"] is JsonValue lv2 && lv2.TryGetValue<string>(out var ls) ? ls.Trim() : "";
            if (!MentionKinds.Contains(kind) || mid.Length is 0 or > 64 || !mid.All(c => char.IsLetterOrDigit(c) || c == '-') || label.Length == 0) return null;
            o["attrs"] = new JsonObject { ["kind"] = kind, ["id"] = mid, ["label"] = label.Length > 120 ? label[..120] : label };
            return o;
        }

        if (type == "liveTasks")
        {
            // A live list of a project's tasks: which project and which tasks, never the tasks themselves (they are read when shown).
            var pid = node["attrs"]?["projectId"] is JsonValue pv && pv.TryGetValue<string>(out var ps) && Guid.TryParse(ps, out var pg) ? pg.ToString() : "";
            var filter = node["attrs"]?["filter"] is JsonValue fv2 && fv2.TryGetValue<string>(out var fs2) && TaskFilters.Contains(fs2) ? fs2 : "open";
            var limit = node["attrs"]?["limit"] is JsonValue lv3 && lv3.TryGetValue<int>(out var li) ? Math.Clamp(li, 1, 50) : 10;
            o["attrs"] = new JsonObject { ["projectId"] = pid, ["filter"] = filter, ["limit"] = limit };
            return o;
        }

        if (type == "archDiagram")
        {
            // A diagram from Architecture Studio: rebuilt from known fields with limits (ArchDiagram.Clean).
            var title = node["attrs"]?["title"] is JsonValue tv2 && tv2.TryGetValue<string>(out var ts) ? ts.Trim() : "";
            o["attrs"] = new JsonObject { ["title"] = title.Length > 120 ? title[..120] : title, ["data"] = ArchDiagram.Clean(node["attrs"]?["data"]) };
            return o;
        }

        var attrs = new JsonObject();
        if (node["attrs"] is JsonObject a)
        {
            if (type == "callout") attrs["tone"] = a["tone"] is JsonValue tov && tov.TryGetValue<string>(out var tone) && CalloutTones.Contains(tone) ? tone : "info";
            if (type == "heading") attrs["level"] = a["level"] is JsonValue lv && lv.TryGetValue<int>(out var lvl) ? Math.Clamp(lvl, 1, 4) : 2;
            if (type == "orderedList" && a["start"] is JsonValue sv && sv.TryGetValue<int>(out var start)) attrs["start"] = Math.Clamp(start, 1, 100_000);
            if (type == "taskItem") attrs["checked"] = a["checked"] is JsonValue cv && cv.TryGetValue<bool>(out var chk) && chk;
            if (type == "details") attrs["open"] = a["open"] is JsonValue ov && ov.TryGetValue<bool>(out var open) && open;
            if (type == "codeBlock" && a["language"] is JsonValue gv && gv.TryGetValue<string>(out var lang) && lang.Length <= 20 && lang.All(c => char.IsLetterOrDigit(c) || c is '-' or '+' or '#')) attrs["language"] = lang;
            if (type is "tableCell" or "tableHeader")
                foreach (var n in new[] { "colspan", "rowspan" })
                    if (a[n] is JsonValue nv && nv.TryGetValue<int>(out var span)) attrs[n] = Math.Clamp(span, 1, 20);
        }
        if (type == "heading" && attrs["level"] is null) attrs["level"] = 2;
        if (type == "callout" && attrs["tone"] is null) attrs["tone"] = "info";
        if (attrs.Count > 0) o["attrs"] = attrs;

        if (node["content"] is JsonArray children)
        {
            var kept = new JsonArray();
            foreach (var c in children.OfType<JsonObject>())
                if (CleanNode(c, depth + 1, ref budget, images) is { } cc) kept.Add(cc);
            if (kept.Count > 0) o["content"] = kept;
        }
        return o;
    }

    public static string NormalizeTable(string? content, string field = "content")
    {
        if (string.IsNullOrWhiteSpace(content)) return """{"columns":[],"rows":[]}""";
        if (content.Length > MaxChars) throw new ValidationException(field, "This table is too large.");
        JsonNode? root;
        try { root = JsonNode.Parse(content); } catch (JsonException) { throw new ValidationException(field, "The table could not be read."); }
        if (root is not JsonObject obj) throw new ValidationException(field, "The table could not be read.");

        var columns = new JsonArray(); var keys = new List<string>();
        foreach (var c in (obj["columns"] as JsonArray ?? []).OfType<JsonObject>().Take(MaxColumns))
        {
            var key = (c["key"] is JsonValue kv && kv.TryGetValue<string>(out var ks) ? ks : "").Trim();
            if (key.Length is 0 or > 40 || !key.All(ch => char.IsLetterOrDigit(ch) || ch is '_' or '-') || keys.Contains(key)) continue;
            var label = (c["label"] is JsonValue lv && lv.TryGetValue<string>(out var ls) ? ls : key).Trim();
            columns.Add(new JsonObject { ["key"] = key, ["label"] = label.Length > 60 ? label[..60] : label });
            keys.Add(key);
        }
        var rows = new JsonArray();
        foreach (var r in (obj["rows"] as JsonArray ?? []).OfType<JsonObject>().Take(MaxRows))
        {
            var row = new JsonObject();
            foreach (var k in keys)
            {
                var v = r[k] is JsonValue cv && cv.TryGetValue<string>(out var cs) ? cs : "";
                row[k] = v.Length > MaxCell ? v[..MaxCell] : v;
            }
            rows.Add(row);
        }
        return new JsonObject { ["columns"] = columns, ["rows"] = rows }.ToJsonString();
    }

    /// <summary>The plain words of a section, for search and previews. Works on both kinds.</summary>
    public static string PlainText(SectionKind kind, string json)
    {
        try
        {
            var sb = new System.Text.StringBuilder();
            void Walk(JsonNode? n)
            {
                switch (n)
                {
                    case JsonObject o:
                        if (o["text"] is JsonValue t && t.TryGetValue<string>(out var s)) sb.Append(s).Append(' ');
                        if (o["type"] is JsonValue mt && mt.TryGetValue<string>(out var ms) && ms == "mention" && o["attrs"]?["label"] is JsonValue ml && ml.TryGetValue<string>(out var label)) sb.Append(label).Append(' ');
                        foreach (var kv in o) if (kv.Key is "content" or "rows") Walk(kv.Value);
                        if (kind == SectionKind.Table && o["columns"] is null) foreach (var kv in o) if (kv.Value is JsonValue v && v.TryGetValue<string>(out var cell)) sb.Append(cell).Append(' ');
                        break;
                    case JsonArray a: foreach (var x in a) Walk(x); break;
                }
            }
            Walk(JsonNode.Parse(json));
            return sb.ToString().Trim();
        }
        catch (JsonException) { return ""; }
    }
}
