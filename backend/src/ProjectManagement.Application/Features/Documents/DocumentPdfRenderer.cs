using System.Globalization;
using System.Text;
using ProjectManagement.Application.Features.Reports;

namespace ProjectManagement.Application.Features.Documents;

/// <summary>One block of a document as it is printed.</summary>
public abstract record PdfBlock;
public sealed record PdfHeading(int Level, string Text) : PdfBlock;
public sealed record PdfPara(string Text, bool Muted = false) : PdfBlock;
public sealed record PdfItem(string Text) : PdfBlock;
public sealed record PdfQuote(string Text) : PdfBlock;
public sealed record PdfCode(IReadOnlyList<string> Lines) : PdfBlock;
/// <param name="MethodColumn">A column whose cells read "POST /path" and are printed as a coloured method badge and the path; -1 for none.</param>
public sealed record PdfTable(IReadOnlyList<string> Headers, IReadOnlyList<IReadOnlyList<string>> Rows, int MethodColumn = -1, bool BoldFirst = false) : PdfBlock;
public sealed record PdfFacts(IReadOnlyList<(string Label, string Value)> Items) : PdfBlock;
public sealed record PdfDiagram(DiagramModel Model) : PdfBlock;
public sealed record PdfBreak : PdfBlock;
/// <summary>A small grey capital label that introduces a part of the page ("HEADERS", "RESPONSES").</summary>
public sealed record PdfLabel(string Text, string? Hint = null) : PdfBlock;
public sealed record PdfBanner(string Index, string Method, string Path, string? Version) : PdfBlock;
public sealed record PdfChips(IReadOnlyList<string> Items) : PdfBlock;
/// <summary>Code or data in a panel with a title bar: a request, an example body, an example response.</summary>
public sealed record PdfPanel(string Label, string? Hint, IReadOnlyList<string> Lines) : PdfBlock;
public sealed record PdfLead(string Text) : PdfBlock;
public sealed record PdfStatus(string Code, string Text) : PdfBlock;
public sealed record PdfTitle(string Text, string? Kicker = null) : PdfBlock;
public sealed record PdfStats(IReadOnlyList<(string Value, string Label)> Items) : PdfBlock;
public sealed record PdfCard(string Title, string Text) : PdfBlock;
public sealed record PdfMethodRow(string Method, string Path) : PdfBlock;
public sealed record PdfLifecycle(IReadOnlyList<string> Stages, int Current, string Owner, string? Team) : PdfBlock;

/// <param name="By">Who asked for the file.</param>
public sealed record PdfBrand(string Organization, PdfImage? Logo, string Product, string By, string GeneratedAt, string? CreatedBy, string? LastModified, string Confidential);

/// <summary>Everything the file shows: a cover, a table of contents made from the headings, then the blocks, under a header and footer.</summary>
public sealed record PdfDocModel(PdfBrand Brand, string Title, string Key, string Version, IReadOnlyList<PdfBlock> Blocks);

public interface IDocumentPdfRenderer
{
    /// <summary>Lays the document out and returns the file and its page count. Throws <see cref="PdfTooLongException"/> past <see cref="DocumentPdfRenderer.MaxPages"/> pages.</summary>
    (byte[] File, int Pages) Render(PdfDocModel doc);
}

public class PdfTooLongException(int pages) : Exception($"This document would print on more than {DocumentPdfRenderer.MaxPages} pages ({pages}). Export part of it, or split it into several documents.");

/// <summary>
/// Prints a document as a PDF with its own layout (portrait A4: a cover with the organization's logo, contents with page numbers, a header and footer on
/// every page, headings, wrapped text, lists, coloured method badges, banner cards, tables, code panels, a lifecycle ring) and the standard PDF fonts, so no
/// native library or licence is needed. Text stays real text. The standard fonts cover Western European characters; anything else prints as "?".
/// </summary>
public class DocumentPdfRenderer : IDocumentPdfRenderer
{
    public const int MaxPages = 600;
    private const double W = 595, H = 842, M = 46, Top = 78, Bottom = 62, Body = 9.5, Lead = 13.8;

    private static string N(double v) => v.ToString("0.##", CultureInfo.InvariantCulture);
    private static string Rgb(string c) => c;

    // colours as "r g b"
    private const string Ink = "0.07 0.09 0.15", Muted = "0.42 0.45 0.52", Faint = "0.90 0.91 0.93", Indigo = "0.31 0.27 0.90", Lavender = "0.93 0.93 0.99", Panel = "0.965 0.97 0.98", PanelBar = "0.925 0.935 0.95";

    private static (string Fg, string Bg) MethodColors(string method) => method.ToUpperInvariant() switch
    {
        "GET" => ("0.10 0.36 0.80", "0.86 0.92 1"),
        "POST" => ("0.06 0.47 0.25", "0.86 0.97 0.90"),
        "PUT" => ("0.70 0.33 0.04", "1 0.94 0.80"),
        "PATCH" => ("0.45 0.22 0.85", "0.93 0.90 1"),
        "DELETE" => ("0.80 0.12 0.12", "1 0.90 0.90"),
        _ => ("0.30 0.33 0.40", "0.92 0.93 0.95"),
    };

    private sealed class Pg { public readonly StringBuilder C = new(); }

    private sealed class Layout
    {
        public readonly List<Pg> Pages = [];
        public Pg P = null!; public double Y;
        public Action<Layout>? Header;
        public readonly List<(int Level, string Text, int Page)> Outline = [];
        public void New() { P = new Pg(); Pages.Add(P); Y = H - M; Header?.Invoke(this); }
        public void Text(string font, double size, double x, double y, string t, string color = "0 0 0", double spacing = 0)
        {
            if (t.Length == 0) return;
            P.C.Append($"BT {color} rg /{font} {N(size)} Tf {N(spacing)} Tc {N(x)} {N(y)} Td ({PdfWriter.Pdf(t)}) Tj ET\n");
        }
        public void Rect(double x, double y, double w, double h, string fill) => P.C.Append($"{fill} rg {N(x)} {N(y)} {N(w)} {N(h)} re f\n");
        public void Line(double x1, double y1, double x2, double y2, string color = Faint, double width = 0.6) => P.C.Append($"{color} RG {N(width)} w {N(x1)} {N(y1)} m {N(x2)} {N(y2)} l S\n");
        public void RRect(double x, double y, double w, double h, double r, string? fill, string? stroke, double sw = 0.7)
        {
            P.C.Append(RoundedPath(x, y, w, h, r));
            P.C.Append(fill is not null && stroke is not null ? $"{fill} rg {stroke} RG {N(sw)} w B\n" : fill is not null ? $"{fill} rg f\n" : $"{stroke} RG {N(sw)} w S\n");
        }
        public void Need(double h) { if (Y - h < Bottom) New(); }
    }

    private static string RoundedPath(double x, double y, double w, double h, double r)
    {
        r = Math.Min(r, Math.Min(w, h) / 2); const double k = 0.5523;
        var o = r * (1 - k);
        return $"{N(x + r)} {N(y)} m {N(x + w - r)} {N(y)} l {N(x + w - o)} {N(y)} {N(x + w)} {N(y + o)} {N(x + w)} {N(y + r)} c {N(x + w)} {N(y + h - r)} l " +
               $"{N(x + w)} {N(y + h - o)} {N(x + w - o)} {N(y + h)} {N(x + w - r)} {N(y + h)} c {N(x + r)} {N(y + h)} l {N(x + o)} {N(y + h)} {N(x)} {N(y + h - o)} {N(x)} {N(y + h - r)} c " +
               $"{N(x)} {N(y + r)} l {N(x)} {N(y + o)} {N(x + o)} {N(y)} {N(x + r)} {N(y)} c h\n";
    }

    private static double MonoWidth(string s, double size) => s.Length * 0.6 * size;

    /// <summary>Greedy word wrap by approximate width; a word longer than the line is cut.</summary>
    private static List<string> Wrap(string text, double width, double size, bool mono = false)
    {
        double Wd(string s) => mono ? MonoWidth(s, size) : PdfWriter.Width(s, size);
        var lines = new List<string>();
        foreach (var para in text.Replace("\r", "").Split('\n'))
        {
            var cur = new StringBuilder();
            foreach (var raw in para.Split(' ', StringSplitOptions.RemoveEmptyEntries))
            {
                var word = raw;
                while (Wd(word) > width && word.Length > 1)
                {
                    var cut = word.Length;
                    while (cut > 1 && Wd(word[..cut]) > width) cut--;
                    if (cur.Length > 0) { lines.Add(cur.ToString()); cur.Clear(); }
                    lines.Add(word[..cut]); word = word[cut..];
                }
                var next = cur.Length == 0 ? word : cur + " " + word;
                if (Wd(next) <= width) { cur.Clear(); cur.Append(next); }
                else { lines.Add(cur.ToString()); cur.Clear(); cur.Append(word); }
            }
            lines.Add(cur.ToString());
        }
        return lines;
    }

    /// <summary>Code keeps its indentation; a long line is cut at the panel's width.</summary>
    private static List<string> WrapCode(string text, double width, double size)
    {
        var max = Math.Max(8, (int)(width / (0.6 * size)));
        var lines = new List<string>();
        foreach (var raw in text.Replace("\r", "").Replace("\t", "  ").Split('\n'))
        {
            var line = raw;
            if (line.Length == 0) { lines.Add(" "); continue; }
            while (line.Length > max) { lines.Add(line[..max]); line = "    " + line[max..]; }
            lines.Add(line);
        }
        return lines;
    }

    private static string Fit(string s, double max, double size, bool mono = false)
    {
        double Wd(string t) => mono ? MonoWidth(t, size) : PdfWriter.Width(t, size);
        if (Wd(s) <= max) return s;
        while (s.Length > 1 && Wd(s + "...") > max) s = s[..^1];
        return s.TrimEnd() + "...";
    }

    private static double Spaced(string s, double size, double spacing) => PdfWriter.Width(s, size) + s.Length * spacing;

    public (byte[] File, int Pages) Render(PdfDocModel doc)
    {
        var chars = doc.Blocks.Sum(b => b switch
        {
            PdfPara p => p.Text.Length, PdfItem i => i.Text.Length, PdfQuote q => q.Text.Length, PdfCode c => c.Lines.Sum(l => l.Length + 20), PdfPanel pn => pn.Lines.Sum(l => l.Length + 20),
            PdfTable t => t.Rows.Sum(r => r.Sum(c => c.Length + 10)), PdfDiagram => 4000, _ => 80,
        });
        if (chars > MaxPages * 6000L) throw new PdfTooLongException(chars / 3000);

        var images = new List<PdfImage>();
        int? logo = null;
        if (doc.Brand.Logo is { } li) { images.Add(li); logo = 0; }

        var usable = W - 2 * M;
        var lay = new Layout();
        lay.Header = l => DrawHeader(l, doc, logo);
        lay.New();
        foreach (var block in doc.Blocks) Draw(lay, block, usable);
        var contentPages = lay.Pages.Count;

        var perPage = (int)((H - Top - Bottom - 40) / 19);
        var tocPages = lay.Outline.Count == 0 ? 0 : Math.Max(1, (int)Math.Ceiling(lay.Outline.Count / (double)perPage));
        var before = 1 + tocPages;
        var total = before + contentPages;
        if (total > MaxPages) throw new PdfTooLongException(total);

        var all = new List<Pg>();
        all.Add(DrawCover(doc, logo));
        for (var tp = 0; tp < tocPages; tp++)
        {
            var t = new Layout { Header = l => DrawHeader(l, doc, logo) }; t.New();
            t.Y = H - Top;
            t.Text("F2", 8, M, t.Y - 8, "CONTENTS", Muted, 1.2); t.Y -= 26;
            foreach (var e in lay.Outline.Skip(tp * perPage).Take(perPage))
            {
                var indent = (e.Level - 1) * 16;
                var label = Fit(e.Text, usable - indent - 44, e.Level == 1 ? 10.5 : 9.5);
                var pageLabel = (before + e.Page + 1).ToString(CultureInfo.InvariantCulture);
                t.Text(e.Level == 1 ? "F2" : "F1", e.Level == 1 ? 10.5 : 9.5, M + indent, t.Y - 10, label, e.Level == 1 ? Ink : "0.25 0.28 0.35");
                t.Text("F1", 9.5, W - M - PdfWriter.Width(pageLabel, 9.5), t.Y - 10, pageLabel, Muted);
                var dots = (int)((usable - indent - PdfWriter.Width(label, 10) - PdfWriter.Width(pageLabel, 9.5) - 14) / 3.1);
                if (dots > 2) t.Text("F1", 9, M + indent + PdfWriter.Width(label, e.Level == 1 ? 10.5 : 9.5) + 5, t.Y - 10, new string('.', dots), "0.78 0.8 0.84");
                t.Y -= 19;
            }
            all.Add(t.P);
        }
        all.AddRange(lay.Pages);

        for (var i = 1; i < all.Count; i++) DrawFooter(all[i], doc, i + 1, all.Count, usable);
        return (Assemble(all, images), all.Count);
    }

    // ------------------------------------------------------------------ cover, header, footer

    private static Pg DrawCover(PdfDocModel doc, int? logo)
    {
        var l = new Layout(); l.New();
        var cx = W / 2; var y = H * 0.60;
        if (logo is not null && doc.Brand.Logo is { } img)
        {
            var maxW = 190.0; var maxH = 74.0; var scale = Math.Min(maxW / img.Width, maxH / img.Height);
            double w = img.Width * scale, h = img.Height * scale;
            l.P.C.Append($"q {N(w)} 0 0 {N(h)} {N(cx - w / 2)} {N(y - h)} cm /Im0 Do Q\n");
            y -= h + 26;
        }
        var org = doc.Brand.Organization.ToUpperInvariant();
        foreach (var line in Wrap(org, W - 2 * M - 40, 14)) { l.Text("F2", 14, cx - PdfWriter.Width(line, 14) / 2, y, line, Ink); y -= 18; }
        y -= 4;
        foreach (var line in Wrap(doc.Title, W - 2 * M - 60, 10.5, true)) { l.Text("F3", 10.5, cx - MonoWidth(line, 10.5) / 2, y, line, "0.40 0.43 0.50"); y -= 14; }
        y -= 8; l.Line(cx - 24, y, cx + 24, y, "0.82 0.84 0.88", 0.8); y -= 30;
        var rows = new List<(string, string)>();
        if (doc.Brand.CreatedBy is not null) rows.Add(("CREATED BY", doc.Brand.CreatedBy));
        if (doc.Brand.LastModified is not null) rows.Add(("LAST MODIFIED", doc.Brand.LastModified));
        rows.Add(("GENERATED ON", doc.Brand.GeneratedAt));
        if (doc.Version.Length > 0) rows.Add(("VERSION", doc.Version));
        foreach (var (label, value) in rows)
        {
            l.Text("F2", 7.5, cx - 12 - Spaced(label, 7.5, 0.8), y, label, "0.55 0.58 0.64", 0.8);
            l.Text("F1", 9.5, cx + 2, y, value, "0.2 0.23 0.3");
            y -= 17;
        }
        y -= 16;
        var conf = doc.Brand.Confidential.ToUpperInvariant();
        l.Text("F2", 7.5, cx - Spaced(conf, 7.5, 0.9) / 2, y, conf, "0.58 0.6 0.66", 0.9);
        return l.P;
    }

    private static void DrawHeader(Layout l, PdfDocModel doc, int? logo)
    {
        var x = M; var baseY = H - 40;
        if (logo is not null && doc.Brand.Logo is { } img)
        {
            var h = 18.0; var w = img.Width * h / img.Height; if (w > 70) { w = 70; h = img.Height * w / img.Width; }
            l.P.C.Append($"q {N(w)} 0 0 {N(h)} {N(x)} {N(baseY - 4)} cm /Im0 Do Q\n"); x += w + 8;
        }
        l.Text("F2", 9, x, baseY + 1, doc.Brand.Organization.ToUpperInvariant(), Ink);
        var t = Fit(doc.Title, 220, 8.5);
        l.Text("F1", 8.5, W - M - PdfWriter.Width(t, 8.5), baseY + 1, t, Muted);
        l.Line(M, H - 50, W - M, H - 50);
        l.Y = H - Top;
    }

    private static void DrawFooter(Pg p, PdfDocModel doc, int pageNo, int pages, double usable)
    {
        var l = new Layout { P = p };
        l.Line(M, 48, W - M, 48);
        var left = Fit($"{doc.Title} · Generated by {doc.Brand.Product} · {doc.Brand.GeneratedAt} · by {doc.Brand.By}", usable - 70, 7.5);
        l.Text("F1", 7.5, M, 34, left, "0.55 0.58 0.64");
        var label = $"Page {pageNo} of {pages}";
        l.Text("F1", 7.5, W - M - PdfWriter.Width(label, 7.5), 34, label, "0.55 0.58 0.64");
    }

    // ------------------------------------------------------------------ blocks

    private static void Draw(Layout l, PdfBlock block, double usable)
    {
        switch (block)
        {
            case PdfBreak: l.New(); break;
            case PdfTitle t:
                {
                    if (t.Kicker is not null) { l.Need(60); var kw = Spaced(t.Kicker, 7.5, 0.8); l.RRect(W / 2 - kw / 2 - 12, l.Y - 18, kw + 24, 17, 8.5, "0.93 0.94 1", null); l.Text("F2", 7.5, W / 2 - kw / 2, l.Y - 12.5, t.Kicker, Indigo, 0.8); l.Y -= 30; }
                    foreach (var line in Wrap(t.Text, usable, 24)) { l.Need(34); l.Text("F2", 24, W / 2 - PdfWriter.Width(line, 24) / 2 * 1.04, l.Y - 22, line, Ink); l.Y -= 30; }
                    l.Y -= 6; break;
                }
            case PdfHeading h:
                {
                    var size = h.Level switch { 1 => 14.5, 2 => 11.5, _ => 10.2 };
                    var lines = Wrap(h.Text, usable / 1.1, size);
                    l.Need(size * 2.6 + lines.Count * (size + 4));
                    l.Y -= h.Level == 1 ? 12 : 8;
                    l.Outline.Add((Math.Min(h.Level, 3), h.Text, l.Pages.Count - 1));
                    if (h.Level == 1) { l.Text("F2", 7.5, M, l.Y - 7, "SECTION", Muted, 1); l.Y -= 14; }
                    foreach (var line in lines) { l.Text("F2", size, M, l.Y - size, line, h.Level == 3 ? "0.2 0.23 0.3" : Ink); l.Y -= size + 4; }
                    if (h.Level == 1) { l.Line(M, l.Y + 1, W - M, l.Y + 1); l.Y -= 8; }
                    l.Y -= 3; break;
                }
            case PdfLabel lb:
                {
                    l.Need(30); l.Y -= 6;
                    l.Text("F2", 7.5, M, l.Y - 8, lb.Text.ToUpperInvariant(), Muted, 1.1);
                    if (lb.Hint is not null) l.Text("F1", 8, M + Spaced(lb.Text.ToUpperInvariant(), 7.5, 1.1) + 12, l.Y - 8, lb.Hint, "0.6 0.62 0.68");
                    l.Y -= 18; break;
                }
            case PdfPara p:
                foreach (var line in Wrap(p.Text, usable, Body)) { l.Need(Lead); l.Text("F1", Body, M, l.Y - Body, line, p.Muted ? Muted : "0.22 0.25 0.32"); l.Y -= Lead; }
                l.Y -= 4; break;
            case PdfItem i:
                {
                    var lines = Wrap(i.Text, usable - 18, Body);
                    for (var k = 0; k < lines.Count; k++) { l.Need(Lead); if (k == 0) l.Text("F2", Body, M + 4, l.Y - Body, "·", Indigo); l.Text("F1", Body, M + 16, l.Y - Body, lines[k], "0.22 0.25 0.32"); l.Y -= Lead; }
                    l.Y -= 1; break;
                }
            case PdfQuote q:
                foreach (var line in Wrap(q.Text, usable - 20, Body)) { l.Need(Lead); l.Rect(M, l.Y - Lead + 3, 2.2, Lead, "0.78 0.8 0.88"); l.Text("F4", Body, M + 12, l.Y - Body, line, "0.3 0.33 0.4"); l.Y -= Lead; }
                l.Y -= 4; break;
            case PdfCode c: DrawPanel(l, null, null, c.Lines, usable); break;
            case PdfPanel pn: DrawPanel(l, pn.Label, pn.Hint, pn.Lines, usable); break;
            case PdfFacts f:
                foreach (var (label, value) in f.Items)
                {
                    var vl = Wrap(value, usable - 130, Body);
                    l.Need(Lead * vl.Count);
                    l.Text("F2", 7.5, M, l.Y - Body, label.ToUpperInvariant(), Muted, 0.8);
                    foreach (var line in vl) { l.Text("F1", Body, M + 120, l.Y - Body, line, "0.22 0.25 0.32"); l.Y -= Lead; }
                }
                l.Y -= 4; break;
            case PdfTable t: DrawTable(l, t, usable); break;
            case PdfDiagram d:
                {
                    var scale = Math.Max(0.3, Math.Min(1.0, Math.Min(usable / d.Model.Width, (H - Top - Bottom - 20) / d.Model.Height)));
                    var h = d.Model.Height * scale;
                    l.Need(h + 8);
                    l.P.C.Append(DiagramEngine.ToPdf(d.Model, M + (usable - d.Model.Width * scale) / 2, l.Y, scale));
                    l.Y -= h + 10; break;
                }
            case PdfLead ld:
                foreach (var line in Wrap(ld.Text, usable / 1.1, 11.5)) { l.Need(16); l.Text("F2", 11.5, M, l.Y - 11, line, Ink); l.Y -= 16; }
                l.Y -= 3; break;
            case PdfBanner b:
                {
                    l.Need(120);
                    l.Outline.Add((2, $"{b.Method} {b.Path}", l.Pages.Count - 1));
                    var (fg, bg) = MethodColors(b.Method);
                    var h = 36.0; var y = l.Y - h;
                    l.RRect(M, y, usable, h, 9, bg, "0.88 0.9 0.92", 0.6);
                    l.RRect(M, y, 5, h, 2.5, fg, null);
                    l.Text("F1", 8.5, M + 18, y + 14, b.Index, Muted);
                    var bx = M + 40; var bw = Math.Max(40, PdfWriter.Width(b.Method, 9) * 1.15 + 16);
                    l.RRect(bx, y + 8, bw, 20, 6, "1 1 1", fg, 0.8);
                    l.Text("F2", 9, bx + bw / 2 - PdfWriter.Width(b.Method, 9) * 1.1 / 2, y + 14.5, b.Method, fg);
                    var path = Fit(b.Path, usable - (bx - M) - bw - 100, 12, true);
                    l.Text("F5", 12, bx + bw + 12, y + 13.5, path, Ink);
                    if (b.Version is not null) { var v = "v" + b.Version.TrimStart('v'); l.Text("F1", 8.5, W - M - 12 - PdfWriter.Width(v, 8.5), y + 14, v, Muted); }
                    l.Y = y - 14; break;
                }
            case PdfChips ch:
                {
                    var x = M; var lineTop = l.Y;
                    l.Need(26);
                    foreach (var item in ch.Items)
                    {
                        var w = PdfWriter.Width(item, 8) + 18;
                        if (x + w > W - M) { x = M; l.Y -= 24; l.Need(24); }
                        l.RRect(x, l.Y - 18, w, 17, 8.5, "0.955 0.96 0.975", "0.88 0.89 0.93", 0.5);
                        l.Text("F1", 8, x + 9, l.Y - 12.5, item, "0.28 0.31 0.4");
                        x += w + 6;
                    }
                    l.Y -= 28; _ = lineTop; break;
                }
            case PdfStatus s:
                {
                    l.Need(28);
                    var ok = s.Code.StartsWith('2'); var warn = s.Code.StartsWith('3');
                    var (fg, bg) = ok ? ("0.06 0.47 0.25", "0.86 0.97 0.90") : warn ? ("0.70 0.33 0.04", "1 0.94 0.80") : ("0.80 0.12 0.12", "1 0.90 0.90");
                    var w = Math.Max(36, PdfWriter.Width(s.Code, 9.5) + 22);
                    l.RRect(M, l.Y - 20, w, 20, 10, bg, null);
                    l.Text("F2", 9.5, M + w / 2 - PdfWriter.Width(s.Code, 9.5) / 2, l.Y - 14, s.Code, fg);
                    l.Text("F1", 9.5, M + w + 14, l.Y - 14, Fit(s.Text, usable - w - 20, 9.5), "0.22 0.25 0.32");
                    l.Y -= 32; break;
                }
            case PdfStats st:
                {
                    l.Need(52);
                    var gap = 70.0; var total = st.Items.Count * gap + (st.Items.Count - 1) * 20; var x = W / 2 - total / 2;
                    foreach (var (value, label) in st.Items)
                    {
                        l.Text("F2", 17, x + gap / 2 - PdfWriter.Width(value, 17) / 2, l.Y - 18, value, Indigo);
                        var lab = label.ToUpperInvariant();
                        l.Text("F2", 6.5, x + gap / 2 - Spaced(lab, 6.5, 0.6) / 2, l.Y - 32, lab, "0.55 0.58 0.64", 0.6);
                        x += gap + 20;
                    }
                    l.Y -= 50; break;
                }
            case PdfCard c:
                {
                    var lines = Wrap(c.Text, usable - 32, 8.8);
                    var tl = Wrap(c.Title, usable - 32, 10);
                    var h = 16 + tl.Count * 13 + lines.Count * 11.6 + 12;
                    l.Need(h + 6);
                    var y = l.Y - h;
                    l.RRect(M, y, usable, h, 10, "0.975 0.98 0.99", "0.88 0.9 0.93", 0.6);
                    var ty = l.Y - 22;
                    foreach (var line in tl) { l.Text("F2", 10, M + 16, ty, line, Ink); ty -= 13; }
                    foreach (var line in lines) { l.Text("F1", 8.8, M + 16, ty, line, "0.35 0.38 0.45"); ty -= 11.6; }
                    l.Y = y - 12; break;
                }
            case PdfMethodRow r:
                {
                    l.Need(24);
                    var (fg, bg) = MethodColors(r.Method);
                    var bw = Math.Max(38, PdfWriter.Width(r.Method, 7.5) * 1.15 + 14);
                    l.RRect(M + 8, l.Y - 17, bw, 16, 5, bg, null);
                    l.Text("F2", 7.5, M + 8 + bw / 2 - PdfWriter.Width(r.Method, 7.5) * 1.1 / 2, l.Y - 12, r.Method, fg);
                    l.Text("F3", 9.5, M + 8 + bw + 10, l.Y - 12.5, Fit(r.Path, usable - bw - 30, 9.5, true), "0.2 0.23 0.3");
                    l.Y -= 24; break;
                }
            case PdfLifecycle lc:
                {
                    var h = 150.0;
                    l.Need(h + 10);
                    var top = l.Y;
                    l.RRect(M, top - h, usable, h, 12, "0.968 0.972 0.99", "0.88 0.9 0.95", 0.6);
                    var stage = lc.Stages[lc.Current];
                    var pillW = PdfWriter.Width(stage.ToUpperInvariant(), 8) + 28;
                    l.RRect(M + 18, top - 30, pillW, 18, 9, "0.86 0.97 0.90", null);
                    l.Text("F2", 8, M + 32, top - 24, stage.ToUpperInvariant(), "0.06 0.47 0.25");
                    var lx = M + 18 + pillW + 14;
                    l.Text("F2", 7, lx, top - 23.5, "OWNER", Muted, 0.8); var ow = PdfWriter.Width("OWNER", 7) + 5 + 5;
                    l.Text("F1", 9, lx + ow, top - 24, lc.Owner.ToUpperInvariant(), Ink);
                    if (lc.Team is not null) { var tx = lx + ow + PdfWriter.Width(lc.Owner.ToUpperInvariant(), 9) + 16; l.Text("F2", 7, tx, top - 23.5, "TEAM", Muted, 0.8); l.Text("F1", 9, tx + 28, top - 24, lc.Team.ToUpperInvariant(), Ink); }
                    // ring
                    var cx = M + 78; var cy = top - 92; double ro = 44, ri = 28; var n = lc.Stages.Count; var gap = 2.4 * Math.PI / 180;
                    for (var i = 0; i < n; i++)
                    {
                        var a0 = -Math.PI / 2 + i * 2 * Math.PI / n + gap / 2; var a1 = -Math.PI / 2 + (i + 1) * 2 * Math.PI / n - gap / 2;
                        var color = i < lc.Current ? "0.11 0.62 0.42" : i == lc.Current ? "0.38 0.45 0.96" : "0.90 0.92 0.95";
                        var sb = new StringBuilder();
                        const int steps = 8;
                        for (var k = 0; k <= steps; k++) { var a = a0 + (a1 - a0) * k / steps; sb.Append($"{N(cx + ro * Math.Cos(a))} {N(cy - ro * Math.Sin(a))} {(k == 0 ? "m" : "l")} "); }
                        for (var k = steps; k >= 0; k--) { var a = a0 + (a1 - a0) * k / steps; sb.Append($"{N(cx + ri * Math.Cos(a))} {N(cy - ri * Math.Sin(a))} l "); }
                        l.P.C.Append($"{color} rg {sb}h f\n");
                    }
                    var sl = $"STAGE {lc.Current + 1} / {n}";
                    l.Text("F2", 5.5, cx - Spaced(sl, 5.5, 0.4) / 2, cy + 7, sl, Muted, 0.4);
                    l.Text("F2", 8.5, cx - PdfWriter.Width(stage, 8.5) / 2, cy - 4, stage, Ink);
                    // chips
                    var x = M + 150; var yy = top - 66;
                    for (var i = 0; i < n; i++)
                    {
                        var w = PdfWriter.Width(lc.Stages[i], 8) + 26;
                        if (x + w > W - M - 12) { x = M + 150; yy -= 22; }
                        var (bg, fg, dot) = i < lc.Current ? ("0.86 0.97 0.90", "0.06 0.47 0.25", "0.11 0.62 0.42") : i == lc.Current ? ("0.88 0.9 1", "0.31 0.27 0.90", "0.38 0.45 0.96") : ("0.94 0.95 0.97", "0.5 0.53 0.6", "0.7 0.72 0.78");
                        l.RRect(x, yy - 16, w, 16, 8, bg, null);
                        l.P.C.Append($"{dot} rg {N(x + 9)} {N(yy - 8)} 2.2 2.2 re f\n");
                        l.Text("F1", 8, x + 16, yy - 11.5, lc.Stages[i], fg);
                        x += w + 6;
                    }
                    l.Y = top - h - 14; break;
                }
        }
    }

    private static void DrawPanel(Layout l, string? label, string? hint, IReadOnlyList<string> source, double usable)
    {
        const double cs = 7.8, cl = 10.6, pad = 10;
        var lines = source.SelectMany(x => WrapCode(x, usable - 2 * pad, cs)).ToList();
        if (label is not null)
        {
            l.Need(60);
            l.Rect(M, l.Y - 22, usable, 22, PanelBar);
            l.Text("F2", 8.5, M + pad, l.Y - 14.5, label, "0.28 0.31 0.4");
            if (hint is not null) l.Text("F1", 7.8, M + pad + PdfWriter.Width(label, 8.5) + 12, l.Y - 14.5, hint, "0.6 0.62 0.68");
            l.Y -= 22;
        }
        l.Need(cl + 12);
        l.Rect(M, l.Y - 6, usable, 6, Panel); l.Y -= 6;
        foreach (var line in lines)
        {
            if (l.Y - cl < Bottom + 6) { l.New(); l.Rect(M, l.Y - 6, usable, 6, Panel); l.Y -= 6; }
            l.Rect(M, l.Y - cl, usable, cl, Panel);
            l.Text("F3", cs, M + pad, l.Y - cs - 1, line, "0.13 0.15 0.22");
            l.Y -= cl;
        }
        l.Rect(M, l.Y - 6, usable, 6, Panel); l.Y -= 6;
        l.Y -= 10;
    }

    private static void DrawTable(Layout l, PdfTable t, double usable)
    {
        const double fs = 8.3, line = 10.8, pad = 6;
        var cols = Math.Max(t.Headers.Count, t.Rows.Count == 0 ? 0 : t.Rows.Max(r => r.Count));
        if (cols == 0) return;
        var natural = new double[cols];
        for (var c = 0; c < cols; c++)
        {
            natural[c] = (c < t.Headers.Count ? PdfWriter.Width(t.Headers[c].ToUpperInvariant(), 7.2) * 1.15 : 0) + 2 * pad;
            foreach (var r in t.Rows.Take(200)) if (c < r.Count) natural[c] = Math.Max(natural[c], Math.Min(PdfWriter.Width(r[c], fs) * (c == 0 && t.BoldFirst ? 1.14 : 1.04), 230) + 2 * pad + (c == t.MethodColumn ? 46 : 0));
        }
        var widths = new double[cols]; var open = Enumerable.Range(0, cols).ToList(); var room = usable;
        while (open.Count > 0)
        {
            var share = room / open.Count; var fits = open.Where(i => natural[i] <= share).ToList();
            if (fits.Count == 0) { foreach (var i in open) widths[i] = share; break; }
            foreach (var i in fits) { widths[i] = natural[i]; room -= natural[i]; open.Remove(i); }
        }
        // leftover width goes to the widest column so the table spans the page like the rest
        var extra = usable - widths.Sum(); if (extra > 0) widths[Array.IndexOf(widths, widths.Max())] += extra;

        void Header()
        {
            if (t.Headers.Count == 0) return;
            l.Need(line + 14);
            l.Rect(M, l.Y - line - 6, usable, line + 6, Lavender); double x = M;
            for (var c = 0; c < cols; c++) { l.Text("F2", 7.2, x + pad, l.Y - 11, Fit((c < t.Headers.Count ? t.Headers[c] : "").ToUpperInvariant(), widths[c] - 2 * pad, 7.2), Indigo, 0.6); x += widths[c]; }
            l.Y -= line + 6;
        }
        Header();
        foreach (var row in t.Rows)
        {
            var cells = Enumerable.Range(0, cols).Select(c =>
            {
                var text = c < row.Count ? row[c] : "";
                if (c == t.MethodColumn) { var sp = text.IndexOf(' '); text = sp > 0 ? text[(sp + 1)..] : text; }
                return Wrap(text, widths[c] - 2 * pad - (c == t.MethodColumn ? 46 : 0), fs, c == t.MethodColumn);
            }).ToList();
            var rows = Math.Min(cells.Max(x => x.Count), 40);
            var done = 0;
            while (done < rows)
            {
                if (l.Y - line - 8 < Bottom) { l.New(); Header(); }
                var fit = Math.Max(1, Math.Min(rows - done, (int)((l.Y - Bottom - 8) / line)));
                var h = fit * line + 8;
                double x = M;
                for (var c = 0; c < cols; c++)
                {
                    var tx = x + pad;
                    if (c == t.MethodColumn && done == 0 && c < row.Count)
                    {
                        var m = row[c].Split(' ')[0]; var (fg, bg) = MethodColors(m); var bw = Math.Max(30, PdfWriter.Width(m, 7) * 1.15 + 12);
                        l.RRect(tx, l.Y - 14, bw, 13, 4, bg, null); l.Text("F2", 7, tx + bw / 2 - PdfWriter.Width(m, 7) * 1.1 / 2, l.Y - 10.5, m, fg);
                        tx += bw + 8;
                    }
                    else if (c == t.MethodColumn) tx += 46;
                    for (var k = 0; k < fit && done + k < cells[c].Count; k++)
                        l.Text(c == t.MethodColumn ? "F3" : (c == 0 && t.BoldFirst ? "F2" : "F1"), fs, tx, l.Y - fs - 2 - k * line, cells[c][done + k], c == 0 && t.BoldFirst ? Ink : "0.25 0.28 0.35");
                    x += widths[c];
                }
                l.Y -= h; done += fit;
                l.Line(M, l.Y + 1, W - M, l.Y + 1, "0.93 0.94 0.96", 0.5);
            }
        }
        if (t.Rows.Count == 0) { l.Need(line + 6); l.Text("F1", fs, M + pad, l.Y - fs - 2, "Nothing to show.", Muted); l.Y -= line + 6; }
        l.Y -= 8;
    }

    // ------------------------------------------------------------------ file

    private static byte[] Assemble(List<Pg> pages, List<PdfImage> images)
    {
        // object numbers: 1 catalog, 2 pages, 3..7 fonts, then images (up to 2 objects each), then page/content pairs
        var objects = new List<string>
        {
            "<< /Type /Catalog /Pages 2 0 R >>", "",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>",
        };
        var xobjects = new StringBuilder();
        for (var i = 0; i < images.Count; i++)
        {
            var img = images[i]; var id = objects.Count + 1;
            var smask = "";
            if (img.Alpha is not null)
            {
                objects.Add($"<< /Type /XObject /Subtype /Image /Width {img.Width} /Height {img.Height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length {img.Alpha.Length} >>\nstream\n{Encoding.Latin1.GetString(img.Alpha)}\nendstream");
                smask = $" /SMask {objects.Count} 0 R";
                id = objects.Count + 1;
            }
            var decode = img.Cmyk ? " /Decode [1 0 1 0 1 0 1 0]" : "";
            objects.Add($"<< /Type /XObject /Subtype /Image /Width {img.Width} /Height {img.Height} /ColorSpace {img.ColorSpace} /BitsPerComponent 8 /Filter {img.Filter}{decode}{smask} /Length {img.Data.Length} >>\nstream\n{Encoding.Latin1.GetString(img.Data)}\nendstream");
            xobjects.Append($"/Im{i} {objects.Count} 0 R ");
        }
        var firstPage = objects.Count + 1;
        objects[1] = $"<< /Type /Pages /Kids [{string.Join(' ', Enumerable.Range(0, pages.Count).Select(i => $"{firstPage + 2 * i} 0 R"))}] /Count {pages.Count} >>";
        for (var i = 0; i < pages.Count; i++)
        {
            objects.Add($"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {N(W)} {N(H)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R /F5 7 0 R >> /XObject << {xobjects}>> >> /Contents {firstPage + 2 * i + 1} 0 R >>");
            var content = pages[i].C.ToString();
            objects.Add($"<< /Length {Encoding.Latin1.GetByteCount(content)} >>\nstream\n{content}endstream");
        }
        using var ms = new MemoryStream();
        void Put(string s) { var b = Encoding.Latin1.GetBytes(s); ms.Write(b, 0, b.Length); }
        Put("%PDF-1.4\n%âãÏÓ\n");
        var offsets = new List<long>();
        for (var i = 0; i < objects.Count; i++) { offsets.Add(ms.Position); Put($"{i + 1} 0 obj\n{objects[i]}\nendobj\n"); }
        var xref = ms.Position;
        Put($"xref\n0 {objects.Count + 1}\n0000000000 65535 f \n");
        foreach (var o in offsets) Put($"{o:D10} 00000 n \n");
        Put($"trailer\n<< /Size {objects.Count + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n");
        return ms.ToArray();
    }
}
