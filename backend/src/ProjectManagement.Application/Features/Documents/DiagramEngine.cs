using System.Globalization;
using System.Text;
using ProjectManagement.Application.Features.Reports;

namespace ProjectManagement.Application.Features.Documents;

public sealed class DiagramException(string message, int line = 0) : Exception(message) { public int Line { get; } = line; }

public sealed record DiagramNode(string Id, string Text, string Shape, double X, double Y, double W, double H);
public sealed record DiagramEdge(string From, string To, string? Label, string Style, bool Arrow, IReadOnlyList<(double X, double Y)> Points, (double X, double Y) LabelAt);
public sealed record DiagramModel(double Width, double Height, IReadOnlyList<DiagramNode> Nodes, IReadOnlyList<DiagramEdge> Edges);

/// <summary>
/// Diagrams written as text, in the flowchart subset of the Mermaid language (<c>flowchart LR</c>, <c>A[Box] --&gt; B{Choice}</c>, <c>-.-&gt;</c>, <c>==&gt;</c>, <c>-->|label|</c>).
/// The server draws them: one layout produces both the SVG shown on screen and the vector drawing printed in a PDF, so the two are the same picture. Other
/// kinds of Mermaid diagram are not supported and say so.
/// </summary>
public static class DiagramEngine
{
    public const int MaxChars = 20_000, MaxNodes = 300, MaxEdges = 600, MaxLabel = 80;

    private sealed record RawNode(string Id, string Text, string Shape);
    private sealed record RawEdge(string From, string To, string? Label, string Style, bool Arrow);

    public static bool IsDiagramLanguage(string? lang) => lang is not null && lang.ToLowerInvariant() is "mermaid" or "flow" or "flowchart";

    // ------------------------------------------------------------------ parsing

    public static DiagramModel Draw(string source)
    {
        var (dir, nodes, edges) = Parse(source);
        return Layout(dir, nodes, edges);
    }

    private static (string Dir, List<RawNode> Nodes, List<RawEdge> Edges) Parse(string source)
    {
        if (source.Length > MaxChars) throw new DiagramException($"A diagram can be up to {MaxChars:N0} characters.");
        var nodes = new Dictionary<string, RawNode>(); var order = new List<string>(); var edges = new List<RawEdge>();
        var dir = "TD"; var sawHeader = false; var lineNo = 0;
        foreach (var rawLine in source.Replace("\r", "").Split('\n'))
        {
            lineNo++;
            var line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith("%%")) continue;
            foreach (var stmt in SplitStatements(line))
            {
                var s = stmt.Trim();
                if (s.Length == 0) continue;
                if (!sawHeader)
                {
                    var parts = s.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (parts[0].ToLowerInvariant() is not ("flowchart" or "graph" or "flowchart-v2"))
                        throw new DiagramException("Only flowcharts are supported. Start the diagram with \"flowchart TD\" (top to bottom) or \"flowchart LR\" (left to right).", lineNo);
                    if (parts.Length > 1) { dir = parts[1].ToUpperInvariant(); if (dir == "TB") dir = "TD"; if (dir is not ("TD" or "BT" or "LR" or "RL")) throw new DiagramException("The direction must be TD, BT, LR or RL.", lineNo); }
                    sawHeader = true; continue;
                }
                var lower = s.ToLowerInvariant();
                if (lower.StartsWith("subgraph") || lower == "end" || lower.StartsWith("classdef ") || lower.StartsWith("class ") || lower.StartsWith("style ") || lower.StartsWith("linkstyle ") || lower.StartsWith("click ") || lower.StartsWith("direction ")) continue;
                ParseChain(s, lineNo, nodes, order, edges);
            }
        }
        if (!sawHeader) throw new DiagramException("The diagram is empty.");
        if (nodes.Count == 0) throw new DiagramException("The diagram has no boxes yet.");
        if (nodes.Count > MaxNodes) throw new DiagramException($"A diagram can have up to {MaxNodes} boxes.");
        if (edges.Count > MaxEdges) throw new DiagramException($"A diagram can have up to {MaxEdges} arrows.");
        return (dir, order.Select(i => nodes[i]).ToList(), edges);
    }

    private static IEnumerable<string> SplitStatements(string line)
    {
        // ";" separates statements, except inside brackets or quotes.
        var depth = 0; var quote = false; var start = 0;
        for (var i = 0; i < line.Length; i++)
        {
            var ch = line[i];
            if (ch == '"') quote = !quote;
            else if (!quote && ch is '[' or '(' or '{') depth++;
            else if (!quote && ch is ']' or ')' or '}') depth = Math.Max(0, depth - 1);
            else if (!quote && depth == 0 && ch == ';') { yield return line[start..i]; start = i + 1; }
        }
        yield return line[start..];
    }

    private static void ParseChain(string s, int lineNo, Dictionary<string, RawNode> nodes, List<string> order, List<RawEdge> edges)
    {
        var i = 0;
        var prev = ReadNode(s, ref i, lineNo, nodes, order);
        while (true)
        {
            SkipSpaces(s, ref i);
            if (i >= s.Length) break;
            var (style, arrow, label) = ReadLink(s, ref i, lineNo);
            SkipSpaces(s, ref i);
            // "A --> B & C" is not supported; an "&" is reported rather than silently misdrawn.
            var next = ReadNode(s, ref i, lineNo, nodes, order);
            edges.Add(new RawEdge(prev, next, label, style, arrow));
            prev = next;
        }
    }

    private static void SkipSpaces(string s, ref int i) { while (i < s.Length && s[i] == ' ') i++; }

    private static string ReadNode(string s, ref int i, int lineNo, Dictionary<string, RawNode> nodes, List<string> order)
    {
        SkipSpaces(s, ref i);
        var start = i;
        while (i < s.Length && (char.IsLetterOrDigit(s[i]) || s[i] is '_' or '-' && i + 1 < s.Length && char.IsLetterOrDigit(s[i + 1]) && i > start)) i++;
        if (i == start) throw new DiagramException($"Expected the name of a box near \"{Snippet(s, i)}\".", lineNo);
        var id = s[start..i];
        string? text = null; var shape = "rect";
        if (i < s.Length && s[i] is '[' or '(' or '{')
        {
            string open, close;
            if (s.AsSpan(i).StartsWith("((")) { open = "(("; close = "))"; shape = "circle"; }
            else if (s[i] == '(') { open = "("; close = ")"; shape = "round"; }
            else if (s[i] == '{') { open = "{"; close = "}"; shape = "diamond"; }
            else if (s.AsSpan(i).StartsWith("[(")) { open = "[("; close = ")]"; shape = "round"; }
            else { open = "["; close = "]"; }
            var from = i + open.Length;
            var end = FindClose(s, from, close);
            if (end < 0) throw new DiagramException($"The box \"{id}\" is not closed: expected {close}.", lineNo);
            text = Unquote(s[from..end].Trim());
            i = end + close.Length;
        }
        if (text is { Length: > MaxLabel }) text = text[..MaxLabel] + "...";
        if (!nodes.TryGetValue(id, out var existing)) { nodes[id] = new RawNode(id, text ?? id, shape); order.Add(id); }
        else if (text is not null) nodes[id] = new RawNode(id, text, shape);
        return id;
    }

    private static int FindClose(string s, int from, string close)
    {
        var quote = false;
        for (var k = from; k < s.Length; k++)
        {
            if (s[k] == '"') quote = !quote;
            else if (!quote && string.CompareOrdinal(s, k, close, 0, close.Length) == 0) return k;
        }
        return -1;
    }

    private static string Unquote(string t) => t.Length >= 2 && t[0] == '"' && t[^1] == '"' ? t[1..^1] : t;
    private static string Snippet(string s, int i) => s[Math.Min(i, s.Length)..].Length > 12 ? s[i..(i + 12)] : s[Math.Min(i, s.Length)..];

    private static (string Style, bool Arrow, string? Label) ReadLink(string s, ref int i, int lineNo)
    {
        // Forms: -->  ---  -.->  -.-  ==>  ===   with an optional |label| after, or "-- label -->" / "-. label .->" / "== label ==>".
        var rest = s.AsSpan(i);
        string style; bool arrow; string? label = null;
        if (rest.StartsWith("-.->")) { style = "dotted"; arrow = true; i += 4; }
        else if (rest.StartsWith("-.-")) { style = "dotted"; arrow = false; i += 3; }
        else if (rest.StartsWith("==>")) { style = "thick"; arrow = true; i += 3; }
        else if (rest.StartsWith("===")) { style = "thick"; arrow = false; i += 3; }
        else if (rest.StartsWith("-->")) { style = "solid"; arrow = true; i += 3; }
        else if (rest.StartsWith("---")) { style = "solid"; arrow = false; i += 3; }
        else if (rest.StartsWith("-- ") || rest.StartsWith("-. ") || rest.StartsWith("== "))
        {
            // text between the dashes
            var open = s.Substring(i, 2); var closeA = open == "--" ? "-->" : open == "-." ? ".->" : "==>"; var closeB = open == "--" ? "---" : open == "-." ? ".-" : "===";
            var from = i + 3;
            var a = s.IndexOf(closeA, from, StringComparison.Ordinal); var b = s.IndexOf(closeB, from, StringComparison.Ordinal);
            if (a < 0 && b < 0) throw new DiagramException("This arrow is not finished: expected --> after its text.", lineNo);
            var useA = a >= 0 && (b < 0 || a <= b);
            var end = useA ? a : b;
            label = Unquote(s[from..end].Trim());
            style = open == "--" ? "solid" : open == "-." ? "dotted" : "thick"; arrow = useA;
            i = end + (useA ? closeA.Length : closeB.Length);
            return (style, arrow, label.Length == 0 ? null : label);
        }
        else throw new DiagramException($"Expected an arrow such as --> near \"{Snippet(s, i)}\".", lineNo);
        if (i < s.Length && s[i] == '|')
        {
            var end = s.IndexOf('|', i + 1);
            if (end < 0) throw new DiagramException("The arrow label is not closed: expected a second |.", lineNo);
            label = Unquote(s[(i + 1)..end].Trim());
            i = end + 1;
        }
        if (label is { Length: > MaxLabel }) label = label[..MaxLabel] + "...";
        return (style, arrow, string.IsNullOrEmpty(label) ? null : label);
    }

    // ------------------------------------------------------------------ layout

    private const double FontSize = 11, LineH = 14, PadX = 14, PadY = 9, MinW = 56, GapNode = 36, GapRank = 56, Margin = 16;

    private sealed class LNode
    {
        public string Id = ""; public string Text = ""; public string Shape = "rect"; public bool Dummy;
        public double W, H, Main, Cross;   // size along the rank axis (Main) and across (Cross), centre positions
        public int Rank; public double Order;
        public List<LNode> Up = [], Down = [];
    }

    private static List<string> Lines(string text) => text.Replace("<br/>", "\n").Replace("<br>", "\n").Replace("\\n", "\n").Split('\n').Select(l => l.Trim()).ToList();

    private static DiagramModel Layout(string dir, List<RawNode> rawNodes, List<RawEdge> rawEdges)
    {
        var horizontal = dir is "LR" or "RL";
        var all = new Dictionary<string, LNode>();
        foreach (var n in rawNodes)
        {
            var lines = Lines(n.Text);
            var tw = lines.Max(l => PdfWriter.Width(l, FontSize));
            var w = Math.Max(MinW, tw + 2 * PadX); var h = lines.Count * LineH + 2 * PadY;
            if (n.Shape == "diamond") { w += 36; h += 22; }
            if (n.Shape == "circle") { w = Math.Max(w, h) + 10; h = Math.Max(w - 10, h) + 10; }
            all[n.Id] = new LNode { Id = n.Id, Text = n.Text, Shape = n.Shape, W = w, H = h };
        }

        // 1. Break cycles: edges that close a cycle are laid out reversed (they are still drawn in their own direction).
        var adj = rawNodes.ToDictionary(n => n.Id, _ => new List<string>());
        foreach (var e in rawEdges) if (e.From != e.To) adj[e.From].Add(e.To);
        var state = new Dictionary<string, int>(); var back = new HashSet<(string, string)>();
        foreach (var n in rawNodes)
        {
            if (state.ContainsKey(n.Id)) continue;
            var stack = new Stack<(string Id, int Next)>(); stack.Push((n.Id, 0)); state[n.Id] = 1;
            while (stack.Count > 0)
            {
                var (id, idx) = stack.Pop();
                if (idx < adj[id].Count)
                {
                    stack.Push((id, idx + 1));
                    var to = adj[id][idx];
                    if (!state.TryGetValue(to, out var st)) { state[to] = 1; stack.Push((to, 0)); }
                    else if (st == 1) back.Add((id, to));
                }
                else state[id] = 2;
            }
        }
        var forward = rawEdges.Where(e => e.From != e.To).Select(e => back.Contains((e.From, e.To)) ? (A: e.To, B: e.From) : (A: e.From, B: e.To)).Distinct().ToList();

        // 2. Ranks by longest path from the sources.
        var incoming = rawNodes.ToDictionary(n => n.Id, _ => 0);
        foreach (var (a, b) in forward) incoming[b]++;
        var rank = rawNodes.ToDictionary(n => n.Id, _ => 0);
        var queue = new Queue<string>(rawNodes.Where(n => incoming[n.Id] == 0).Select(n => n.Id));
        var outs = forward.GroupBy(f => f.A).ToDictionary(g => g.Key, g => g.Select(x => x.B).ToList());
        var left = new Dictionary<string, int>(incoming);
        while (queue.Count > 0)
        {
            var id = queue.Dequeue();
            foreach (var to in outs.GetValueOrDefault(id) ?? [])
            {
                rank[to] = Math.Max(rank[to], rank[id] + 1);
                if (--left[to] == 0) queue.Enqueue(to);
            }
        }
        foreach (var n in all.Values) n.Rank = rank[n.Id];

        // 3. Dummy nodes for edges that cross several ranks, so they have a lane of their own.
        var chains = new Dictionary<(string, string), List<LNode>>();
        var dummies = 0;
        foreach (var (a, b) in forward)
        {
            var from = all[a]; var to = all[b];
            var chain = new List<LNode> { from };
            for (var r = from.Rank + 1; r < to.Rank; r++)
            {
                var d = new LNode { Id = $"~{dummies++}", Dummy = true, Rank = r, W = 8, H = 8 };
                chain.Add(d);
            }
            chain.Add(to);
            for (var k = 0; k + 1 < chain.Count; k++) { chain[k].Down.Add(chain[k + 1]); chain[k + 1].Up.Add(chain[k]); }
            chains[(a, b)] = chain;
        }
        var layers = new Dictionary<int, List<LNode>>();
        foreach (var n in all.Values.Concat(chains.Values.SelectMany(c => c).Where(x => x.Dummy)).Distinct())
        {
            if (!layers.TryGetValue(n.Rank, out var l)) layers[n.Rank] = l = [];
            l.Add(n);
        }
        var maxRank = layers.Keys.Max();
        var appearance = rawNodes.Select((n, i) => (n.Id, i)).ToDictionary(x => x.Id, x => x.i);
        foreach (var l in layers.Values) { l.Sort((p, q) => Pos(p).CompareTo(Pos(q))); for (var k = 0; k < l.Count; k++) l[k].Order = k; }
        double Pos(LNode n) => n.Dummy ? 1e6 + n.Order : appearance[n.Id];

        // 4. Order inside each rank: a few barycentre sweeps reduce crossings.
        for (var sweep = 0; sweep < 6; sweep++)
        {
            var down = sweep % 2 == 0;
            for (var r = down ? 1 : maxRank - 1; down ? r <= maxRank : r >= 0; r += down ? 1 : -1)
            {
                if (!layers.TryGetValue(r, out var l)) continue;
                foreach (var n in l) { var nb = down ? n.Up : n.Down; if (nb.Count > 0) n.Cross = nb.Average(x => x.Order); else n.Cross = n.Order; }
                var sorted = l.OrderBy(n => n.Cross).ThenBy(n => n.Order).ToList();
                l.Clear(); l.AddRange(sorted);
                for (var k = 0; k < l.Count; k++) l[k].Order = k;
            }
        }

        // 5. Coordinates. Along the rank axis nodes are as large as their own extent in that direction; across it they are packed and then pulled toward their neighbours.
        double Across(LNode n) => horizontal ? n.H : n.W;
        double Along(LNode n) => horizontal ? n.W : n.H;
        var rankSize = new double[maxRank + 1];
        for (var r = 0; r <= maxRank; r++) rankSize[r] = layers.TryGetValue(r, out var l) && l.Count > 0 ? l.Max(Along) : 0;
        // Room between ranks grows to fit the labels of the arrows that cross it.
        var gapAfter = Enumerable.Repeat(GapRank, maxRank + 1).ToArray();
        foreach (var e in rawEdges.Where(e => e.Label is not null && e.From != e.To))
        {
            var lo = Math.Min(all[e.From].Rank, all[e.To].Rank); var hi = Math.Max(all[e.From].Rank, all[e.To].Rank);
            var need = horizontal ? PdfWriter.Width(e.Label!, FontSize - 1) + 34 : 30;
            for (var g = lo; g < hi; g++) gapAfter[g] = Math.Max(gapAfter[g], need);
        }
        var rankPos = new double[maxRank + 1]; var acc = Margin;
        for (var r = 0; r <= maxRank; r++) { rankPos[r] = acc + rankSize[r] / 2; acc += rankSize[r] + gapAfter[r]; }
        foreach (var kv in layers) { double x = 0; foreach (var n in kv.Value.OrderBy(n => n.Order)) { n.Cross = x + Across(n) / 2; x += Across(n) + GapNode; } }
        for (var pass = 0; pass < 8; pass++)
        {
            var down = pass % 2 == 0;
            for (var r = down ? 1 : maxRank - 1; down ? r <= maxRank : r >= 0; r += down ? 1 : -1)
            {
                if (!layers.TryGetValue(r, out var l)) continue;
                var ord = l.OrderBy(n => n.Order).ToList();
                var desired = ord.Select(n => { var nb = (down ? n.Up : n.Down).Concat(down ? [] : []).ToList(); if (nb.Count == 0) nb = n.Up.Concat(n.Down).ToList(); return nb.Count == 0 ? n.Cross : nb.Average(x => x.Cross); }).ToList();
                // Keep the order and the minimum gap: a left-to-right then right-to-left squeeze.
                var pos = desired.ToArray();
                for (var k = 1; k < pos.Length; k++) pos[k] = Math.Max(pos[k], pos[k - 1] + (Across(ord[k - 1]) + Across(ord[k])) / 2 + GapNode);
                for (var k = pos.Length - 2; k >= 0; k--) pos[k] = Math.Min(pos[k], pos[k + 1] - (Across(ord[k]) + Across(ord[k + 1])) / 2 - GapNode);
                // The squeeze can push the first node left of the margin: shift it back.
                for (var k = 0; k < ord.Count; k++) ord[k].Cross = pos[k];
            }
        }
        var minCross = layers.Values.SelectMany(x => x).Min(n => n.Cross - Across(n) / 2);
        foreach (var n in layers.Values.SelectMany(x => x)) n.Cross += Margin - minCross;
        foreach (var kv in layers) foreach (var n in kv.Value) n.Main = rankPos[kv.Key];
        var totalMain = acc - gapAfter[maxRank] + Margin;
        var totalCross = layers.Values.SelectMany(x => x).Max(n => n.Cross + Across(n) / 2) + Margin;

        // 6. To drawing coordinates for the chosen direction.
        double X(LNode n) => dir switch { "LR" => n.Main, "RL" => totalMain - n.Main, _ => n.Cross };
        double Y(LNode n) => dir switch { "LR" or "RL" => n.Cross, "BT" => totalMain - n.Main, _ => n.Main };
        var width = horizontal ? totalMain : totalCross; var height = horizontal ? totalCross : totalMain;

        var nodes = rawNodes.Select(r => all[r.Id]).Select(n => new DiagramNode(n.Id, n.Text, n.Shape, X(n) - n.W / 2, Y(n) - n.H / 2, n.W, n.H)).ToList();
        var edges = new List<DiagramEdge>();
        var sideCount = new Dictionary<string, int>();
        foreach (var e in rawEdges)
        {
            var a = all[e.From]; var b = all[e.To];
            List<(double X, double Y)> pts;
            if (e.From == e.To)
            {
                var cx = X(a) + a.W / 2; var cy = Y(a);
                pts = [(cx, cy - 8), (cx + 24, cy - 8), (cx + 24, cy + 8), (cx, cy + 8)];
            }
            else
            {
                var isBack = back.Contains((e.From, e.To));
                var chain = isBack ? chains[(e.To, e.From)].AsEnumerable().Reverse().ToList() : chains[(e.From, e.To)];
                var centres = chain.Select(n => (X: X(n), Y: Y(n))).ToList();
                pts = [Boundary(a, centres[0], centres[1], X(a), Y(a)), .. centres.Skip(1).Take(centres.Count - 2), Boundary(b, centres[^1], centres[^2], X(b), Y(b))];
            }
            var mid = pts.Count == 1 ? pts[0] : MidOf(pts);
            edges.Add(new DiagramEdge(e.From, e.To, e.Label, e.Style, e.Arrow, pts, mid));
        }
        return new DiagramModel(width, height, nodes, edges);
    }

    /// <summary>Where the line from this node's centre toward <paramref name="toward"/> leaves the node's outline (its bounding box, or the diamond/ellipse inside it).</summary>
    private static (double X, double Y) Boundary(LNode n, (double X, double Y) centre, (double X, double Y) toward, double cx, double cy)
    {
        var dx = toward.X - cx; var dy = toward.Y - cy;
        if (Math.Abs(dx) < 1e-6 && Math.Abs(dy) < 1e-6) return (cx, cy);
        double hw = n.W / 2, hh = n.H / 2, t;
        switch (n.Shape)
        {
            case "diamond": t = 1 / (Math.Abs(dx) / hw + Math.Abs(dy) / hh); break;
            case "circle": t = 1 / Math.Sqrt(dx * dx / (hw * hw) + dy * dy / (hh * hh)); break;
            default: t = Math.Min(Math.Abs(dx) < 1e-6 ? double.MaxValue : hw / Math.Abs(dx), Math.Abs(dy) < 1e-6 ? double.MaxValue : hh / Math.Abs(dy)); break;
        }
        return (cx + dx * t, cy + dy * t);
    }

    private static (double X, double Y) MidOf(IReadOnlyList<(double X, double Y)> pts)
    {
        double total = 0;
        for (var i = 0; i + 1 < pts.Count; i++) total += Math.Sqrt(Math.Pow(pts[i + 1].X - pts[i].X, 2) + Math.Pow(pts[i + 1].Y - pts[i].Y, 2));
        double half = total / 2;
        for (var i = 0; i + 1 < pts.Count; i++)
        {
            var seg = Math.Sqrt(Math.Pow(pts[i + 1].X - pts[i].X, 2) + Math.Pow(pts[i + 1].Y - pts[i].Y, 2));
            if (half <= seg && seg > 0) { var f = half / seg; return (pts[i].X + (pts[i + 1].X - pts[i].X) * f, pts[i].Y + (pts[i + 1].Y - pts[i].Y) * f); }
            half -= seg;
        }
        return pts[^1];
    }

    // ------------------------------------------------------------------ SVG

    private static string F(double v) => v.ToString("0.##", CultureInfo.InvariantCulture);
    private static string Esc(string s) => s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");

    /// <summary>The picture as SVG. Every piece of text is escaped here, so the result is safe to put straight into a page.</summary>
    public static string ToSvg(DiagramModel m)
    {
        var sb = new StringBuilder();
        sb.Append($"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {F(m.Width)} {F(m.Height)}\" width=\"{F(m.Width)}\" height=\"{F(m.Height)}\" role=\"img\" font-family=\"Helvetica, Arial, sans-serif\" font-size=\"{F(FontSize)}\">");
        sb.Append("<defs><marker id=\"dg-arrow\" viewBox=\"0 0 10 10\" refX=\"9\" refY=\"5\" markerWidth=\"7\" markerHeight=\"7\" orient=\"auto-start-reverse\"><path d=\"M0 0L10 5L0 10z\" class=\"dg-head\" fill=\"#475569\"/></marker></defs>");
        foreach (var e in m.Edges)
        {
            var dash = e.Style == "dotted" ? " stroke-dasharray=\"5 4\"" : "";
            var width = e.Style == "thick" ? "2.6" : "1.4";
            sb.Append($"<polyline class=\"dg-edge\" fill=\"none\" stroke=\"#475569\" stroke-width=\"{width}\"{dash}{(e.Arrow ? " marker-end=\"url(#dg-arrow)\"" : "")} points=\"{string.Join(' ', e.Points.Select(p => $"{F(p.X)},{F(p.Y)}"))}\"/>");
        }
        foreach (var e in m.Edges.Where(e => e.Label is not null))
        {
            var w = PdfWriter.Width(e.Label!, FontSize - 1) + 10;
            sb.Append($"<rect class=\"dg-label-bg\" x=\"{F(e.LabelAt.X - w / 2)}\" y=\"{F(e.LabelAt.Y - 9)}\" width=\"{F(w)}\" height=\"16\" rx=\"3\" fill=\"#ffffff\" fill-opacity=\"0.92\"/>");
            sb.Append($"<text class=\"dg-text\" x=\"{F(e.LabelAt.X)}\" y=\"{F(e.LabelAt.Y + 3)}\" text-anchor=\"middle\" font-size=\"{F(FontSize - 1)}\" fill=\"#334155\">{Esc(e.Label!)}</text>");
        }
        foreach (var n in m.Nodes)
        {
            var x = n.X; var y = n.Y; var w = n.W; var h = n.H;
            switch (n.Shape)
            {
                case "diamond": sb.Append($"<polygon class=\"dg-node\" fill=\"#fef3c7\" stroke=\"#b45309\" stroke-width=\"1.4\" points=\"{F(x + w / 2)},{F(y)} {F(x + w)},{F(y + h / 2)} {F(x + w / 2)},{F(y + h)} {F(x)},{F(y + h / 2)}\"/>"); break;
                case "circle": sb.Append($"<ellipse class=\"dg-node\" fill=\"#dcfce7\" stroke=\"#15803d\" stroke-width=\"1.4\" cx=\"{F(x + w / 2)}\" cy=\"{F(y + h / 2)}\" rx=\"{F(w / 2)}\" ry=\"{F(h / 2)}\"/>"); break;
                case "round": sb.Append($"<rect class=\"dg-node\" fill=\"#e0e7ff\" stroke=\"#4f46e5\" stroke-width=\"1.4\" x=\"{F(x)}\" y=\"{F(y)}\" width=\"{F(w)}\" height=\"{F(h)}\" rx=\"{F(Math.Min(h / 2, 18))}\"/>"); break;
                default: sb.Append($"<rect class=\"dg-node\" fill=\"#f1f5f9\" stroke=\"#475569\" stroke-width=\"1.4\" x=\"{F(x)}\" y=\"{F(y)}\" width=\"{F(w)}\" height=\"{F(h)}\" rx=\"4\"/>"); break;
            }
            var lines = Lines(n.Text);
            var top = y + h / 2 - (lines.Count - 1) * LineH / 2 + 4;
            for (var i = 0; i < lines.Count; i++) sb.Append($"<text class=\"dg-text\" x=\"{F(x + w / 2)}\" y=\"{F(top + i * LineH)}\" text-anchor=\"middle\" fill=\"#0f172a\">{Esc(lines[i])}</text>");
        }
        return sb.Append("</svg>").ToString();
    }

    // ------------------------------------------------------------------ PDF drawing

    /// <summary>The picture as PDF drawing operators in a box whose top-left is (<paramref name="left"/>, <paramref name="top"/>) in PDF coordinates, scaled by <paramref name="scale"/>.</summary>
    public static string ToPdf(DiagramModel m, double left, double top, double scale)
    {
        var sb = new StringBuilder();
        double PX(double x) => left + x * scale; double PY(double y) => top - y * scale;
        sb.Append("q 1 j 1 J\n");
        foreach (var e in m.Edges)
        {
            var w = e.Style == "thick" ? 2.4 : 1.2;
            sb.Append($"0.28 0.33 0.41 RG {F(w * scale)} w {(e.Style == "dotted" ? $"[{F(4 * scale)} {F(3 * scale)}] 0 d" : "[] 0 d")}\n");
            sb.Append($"{F(PX(e.Points[0].X))} {F(PY(e.Points[0].Y))} m ");
            foreach (var p in e.Points.Skip(1)) sb.Append($"{F(PX(p.X))} {F(PY(p.Y))} l ");
            sb.Append("S\n[] 0 d\n");
            if (e.Arrow && e.Points.Count >= 2)
            {
                var a = e.Points[^2]; var b = e.Points[^1];
                var ang = Math.Atan2(b.Y - a.Y, b.X - a.X); var len = 8; var wing = 3.6;
                var bx = b.X - Math.Cos(ang) * len; var by = b.Y - Math.Sin(ang) * len;
                var lx = bx + Math.Cos(ang + Math.PI / 2) * wing; var ly = by + Math.Sin(ang + Math.PI / 2) * wing;
                var rx = bx - Math.Cos(ang + Math.PI / 2) * wing; var ry = by - Math.Sin(ang + Math.PI / 2) * wing;
                sb.Append($"0.28 0.33 0.41 rg {F(PX(b.X))} {F(PY(b.Y))} m {F(PX(lx))} {F(PY(ly))} l {F(PX(rx))} {F(PY(ry))} l f\n");
            }
        }
        foreach (var n in m.Nodes)
        {
            var (fill, stroke) = n.Shape switch { "diamond" => ("1 0.953 0.78", "0.706 0.325 0.035"), "circle" => ("0.863 0.988 0.906", "0.082 0.502 0.239"), "round" => ("0.878 0.906 1", "0.31 0.275 0.898"), _ => ("0.945 0.961 0.976", "0.28 0.33 0.41") };
            sb.Append($"{fill} rg {stroke} RG {F(1.2 * scale)} w\n");
            double x = PX(n.X), w = n.W * scale, h = n.H * scale, y = PY(n.Y) - h;
            switch (n.Shape)
            {
                case "diamond": sb.Append($"{F(x + w / 2)} {F(y + h)} m {F(x + w)} {F(y + h / 2)} l {F(x + w / 2)} {F(y)} l {F(x)} {F(y + h / 2)} l h B\n"); break;
                case "circle":
                    {
                        const double k = 0.5523; double cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
                        sb.Append($"{F(cx + rx)} {F(cy)} m {F(cx + rx)} {F(cy + k * ry)} {F(cx + k * rx)} {F(cy + ry)} {F(cx)} {F(cy + ry)} c {F(cx - k * rx)} {F(cy + ry)} {F(cx - rx)} {F(cy + k * ry)} {F(cx - rx)} {F(cy)} c {F(cx - rx)} {F(cy - k * ry)} {F(cx - k * rx)} {F(cy - ry)} {F(cx)} {F(cy - ry)} c {F(cx + k * rx)} {F(cy - ry)} {F(cx + rx)} {F(cy - k * ry)} {F(cx + rx)} {F(cy)} c h B\n");
                        break;
                    }
                default: sb.Append($"{F(x)} {F(y)} {F(w)} {F(h)} re B\n"); break;
            }
            var lines = Lines(n.Text);
            var fs = FontSize * scale;
            var topLine = PY(n.Y + n.H / 2) + (lines.Count - 1) * LineH * scale / 2 - 3.6 * scale;
            for (var i = 0; i < lines.Count; i++)
            {
                var tw = PdfWriter.Width(lines[i], FontSize) * scale;
                sb.Append($"BT 0.06 0.09 0.16 rg /F1 {F(fs)} Tf 0 Tc {F(PX(n.X + n.W / 2) - tw / 2)} {F(topLine - i * LineH * scale)} Td ({PdfWriter.Pdf(lines[i])}) Tj ET\n");
            }
        }
        foreach (var e in m.Edges.Where(e => e.Label is not null))
        {
            var fs = (FontSize - 1) * scale; var tw = PdfWriter.Width(e.Label!, FontSize - 1) * scale;
            sb.Append($"1 g {F(PX(e.LabelAt.X) - tw / 2 - 4 * scale)} {F(PY(e.LabelAt.Y) - 7 * scale)} {F(tw + 8 * scale)} {F(14 * scale)} re f\n");
            sb.Append($"BT 0.2 0.25 0.33 rg /F1 {F(fs)} Tf 0 Tc {F(PX(e.LabelAt.X) - tw / 2)} {F(PY(e.LabelAt.Y) - 3 * scale)} Td ({PdfWriter.Pdf(e.Label!)}) Tj ET\n");
        }
        sb.Append("Q\n");
        return sb.ToString();
    }
}
