using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ProjectManagement.Application.Features.Documents;

/// <summary>
/// An architecture diagram drawn in Architecture Studio, stored inside a rich-text section as an "archDiagram" block:
/// boxes (icon components, shapes, text and frames that group others) at positions, and arrows between them. Everything that comes from
/// the browser is rebuilt from known fields with limits, so a diagram can never smuggle markup or grow without bound. For the PDF and for
/// comparing versions it is turned into a flowchart (the same engine as typed diagrams).
/// </summary>
public static class ArchDiagram
{
    public const int MaxNodes = 300, MaxEdges = 600;
    private static readonly HashSet<string> Kinds = ["icon", "shape", "text", "frame"];
    private static readonly HashSet<string> Shapes = ["rect", "rounded", "ellipse", "diamond", "cylinder"];
    private static readonly HashSet<string> LineStyles = ["solid", "dashed", "dotted"];
    private static readonly Regex Id = new("^[A-Za-z0-9_\\-]{1,40}$", RegexOptions.Compiled);
    private static readonly Regex Color = new("^#[0-9a-fA-F]{3,8}$", RegexOptions.Compiled);
    private static readonly HashSet<string> Levels = ["context", "containers", "components", "deployment"];
    private static readonly Regex IconKey = new("^[a-z0-9\\-]{1,30}$", RegexOptions.Compiled);

    private static string Str(JsonNode? n, int max) => n is JsonValue v && v.TryGetValue<string>(out var s) ? (s.Length > max ? s[..max] : s) : "";
    private static double Num(JsonNode? n, double min, double max, double fallback) =>
        n is JsonValue v && (v.TryGetValue<double>(out var d) || (v.TryGetValue<string>(out var s) && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out d))) && double.IsFinite(d) ? Math.Round(Math.Clamp(d, min, max), 1) : fallback;
    private static bool Bool(JsonNode? n) => n is JsonValue v && v.TryGetValue<bool>(out var b) && b;

    /// <summary>A clean copy of a diagram, or an empty one.</summary>
    public static JsonObject Clean(JsonNode? data)
    {
        var nodes = new JsonArray(); var ids = new HashSet<string>();
        foreach (var n in (data?["nodes"] as JsonArray ?? []).OfType<JsonObject>().Take(MaxNodes))
        {
            var id = Str(n["id"], 40);
            if (!Id.IsMatch(id) || !ids.Add(id)) continue;
            var kind = Str(n["kind"], 10); if (!Kinds.Contains(kind)) kind = "icon";
            var o = new JsonObject
            {
                ["id"] = id, ["kind"] = kind, ["label"] = Str(n["label"], 200),
                ["x"] = Num(n["x"], -20000, 20000, 0), ["y"] = Num(n["y"], -20000, 20000, 0),
                ["w"] = Num(n["w"], 40, 4000, kind == "frame" ? 320 : 150), ["h"] = Num(n["h"], 30, 4000, kind == "frame" ? 220 : 64),
            };
            var icon = Str(n["icon"], 30); if (IconKey.IsMatch(icon)) o["icon"] = icon;
            var shape = Str(n["shape"], 12); if (Shapes.Contains(shape)) o["shape"] = shape;
            var color = Str(n["color"], 9); if (Color.IsMatch(color)) o["color"] = color;
            var notes = Str(n["notes"], 500); if (notes.Length > 0) o["notes"] = notes;
            var parent = Str(n["parentId"], 40); if (Id.IsMatch(parent)) o["parentId"] = parent;
            // C4 details (Architecture Studio): level tab, element type, tech/owner/repo/runs-on, replicas and capacity for the load simulation.
            var level = Str(n["level"], 12); if (Levels.Contains(level)) o["level"] = level;
            var ctype = Str(n["ctype"], 20); if (IconKey.IsMatch(ctype)) o["ctype"] = ctype;
            foreach (var (k, max) in new[] { ("tech", 120), ("owner", 80), ("repo", 200), ("runsOn", 120) }) { var v = Str(n[k], max).Trim(); if (v.Length > 0) o[k] = v; }
            if (n["replicas"] is not null) o["replicas"] = Num(n["replicas"], 1, 1000, 1);
            if (n["capacity"] is not null && Num(n["capacity"], 0, 10_000_000, 0) > 0) o["capacity"] = Num(n["capacity"], 0, 10_000_000, 0);
            nodes.Add(o);
        }
        foreach (var o in nodes.OfType<JsonObject>()) if (o["parentId"] is JsonValue p && !ids.Contains(p.ToString())) o.Remove("parentId");
        var edges = new JsonArray(); var edgeIds = new HashSet<string>();
        foreach (var e in (data?["edges"] as JsonArray ?? []).OfType<JsonObject>().Take(MaxEdges))
        {
            var id = Str(e["id"], 40); var from = Str(e["source"], 40); var to = Str(e["target"], 40);
            if (!Id.IsMatch(id) || !edgeIds.Add(id) || !ids.Contains(from) || !ids.Contains(to)) continue;
            var line = Str(e["line"], 8); if (!LineStyles.Contains(line)) line = "solid";
            var o = new JsonObject { ["id"] = id, ["source"] = from, ["target"] = to, ["line"] = line, ["label"] = Str(e["label"], 120) };
            if (Bool(e["animated"])) o["animated"] = true;
            if (Bool(e["both"])) o["both"] = true;
            var sh = Str(e["sourceHandle"], 10); if (sh is "t" or "r" or "b" or "l") o["sourceHandle"] = sh;
            var th = Str(e["targetHandle"], 10); if (th is "t" or "r" or "b" or "l") o["targetHandle"] = th;
            var color = Str(e["color"], 9); if (Color.IsMatch(color)) o["color"] = color;
            var protocol = Str(e["protocol"], 40).Trim(); if (protocol.Length > 0) o["protocol"] = protocol;
            if (e["rps"] is not null && Num(e["rps"], 0, 10_000_000, 0) > 0) o["rps"] = Num(e["rps"], 0, 10_000_000, 0);
            edges.Add(o);
        }
        return new JsonObject { ["nodes"] = nodes, ["edges"] = edges };
    }

    /// <summary>The diagram as a left-to-right flowchart (for the PDF and for comparing versions). Frames become labels; text boxes are left out.</summary>
    public static string ToFlowchart(JsonNode? data)
    {
        var sb = new StringBuilder("flowchart LR\n");
        var names = new Dictionary<string, string>();
        static string Safe(string s) => Regex.Replace(s.Length == 0 ? " " : s, "[\\[\\]{}()|\"<>;]", " ").Trim() is { Length: > 0 } t ? t : " ";
        var i = 0;
        foreach (var n in (data?["nodes"] as JsonArray ?? []).OfType<JsonObject>())
        {
            if (n["kind"]?.ToString() is "text") continue;
            var key = "n" + i++;
            names[n["id"]?.ToString() ?? key] = key;
            sb.Append("  ").Append(key).Append('[').Append(Safe(n["label"]?.ToString() ?? "")).Append("]\n");
        }
        foreach (var e in (data?["edges"] as JsonArray ?? []).OfType<JsonObject>())
        {
            if (!names.TryGetValue(e["source"]?.ToString() ?? "", out var a) || !names.TryGetValue(e["target"]?.ToString() ?? "", out var b)) continue;
            var label = Safe(e["label"]?.ToString() ?? "");
            sb.Append("  ").Append(a).Append(label.Trim().Length > 0 ? $" -->|{label}| " : " --> ").Append(b).Append('\n');
        }
        return sb.ToString();
    }

    /// <summary>Masks personal and secret values in labels and notes.</summary>
    public static void Mask(JsonNode? data, PiiMasker masker)
    {
        foreach (var n in (data?["nodes"] as JsonArray ?? []).OfType<JsonObject>())
        {
            if (n["label"] is JsonValue l) n["label"] = masker.MaskText(l.ToString());
            if (n["notes"] is JsonValue t) n["notes"] = masker.MaskText(t.ToString());
        }
        foreach (var e in (data?["edges"] as JsonArray ?? []).OfType<JsonObject>())
            if (e["label"] is JsonValue l) e["label"] = masker.MaskText(l.ToString());
    }
}
