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
public sealed record PdfTable(IReadOnlyList<string> Headers, IReadOnlyList<IReadOnlyList<string>> Rows) : PdfBlock;
public sealed record PdfFacts(IReadOnlyList<(string Label, string Value)> Items) : PdfBlock;
public sealed record PdfBreak : PdfBlock;

/// <summary>Everything the file shows: a cover (title and facts, approval record), a table of contents made from the headings, then the blocks.</summary>
public sealed record PdfDocModel(string Organization, string Title, string Key, string Version, IReadOnlyList<(string Label, string Value)> Cover, IReadOnlyList<PdfBlock> Blocks, string Footer);

public interface IDocumentPdfRenderer
{
    /// <summary>Lays the document out and returns the file and its page count. Throws <see cref="PdfTooLongException"/> past <see cref="Max"/> pages.</summary>
    (byte[] File, int Pages) Render(PdfDocModel doc);
}

public class PdfTooLongException(int pages) : Exception($"This document would print on more than {DocumentPdfRenderer.MaxPages} pages ({pages}). Export part of it, or split it into several documents.");

/// <summary>
/// Prints a document as a PDF with its own layout (portrait A4: cover, contents with page numbers, headings, wrapped text, lists, tables, code, footers) and the
/// standard PDF fonts, so no native library or licence is needed. Text stays real text (selectable, searchable). The standard fonts cover Western European
/// characters; anything else prints as "?". The interface exists so a renderer with embedded fonts can replace this one.
/// </summary>
public class DocumentPdfRenderer : IDocumentPdfRenderer
{
    public const int MaxPages = 600;
    private const double W = 595, H = 842, M = 54, Bottom = 56, Body = 10, Lead = 14;

    private static string N(double v) => v.ToString("0.##", CultureInfo.InvariantCulture);

    private sealed class Pg { public readonly StringBuilder C = new(); }

    private sealed class Layout
    {
        public readonly List<Pg> Pages = [];
        public Pg P = null!; public double Y;
        public readonly List<(int Level, string Text, int Page)> Outline = [];   // Page is 0-based within the content
        public void New() { P = new Pg(); Pages.Add(P); Y = H - M; }
        public void Text(string font, double size, double x, double y, string t, string color = "0 g")
        {
            if (t.Length == 0) return;
            P.C.Append($"BT {color} /{font} {N(size)} Tf {N(x)} {N(y)} Td ({PdfWriter.Pdf(t)}) Tj ET\n");
        }
        public void Rect(double x, double y, double w, double h, string fill) => P.C.Append($"{fill} {N(x)} {N(y)} {N(w)} {N(h)} re f\n");
        public void Line(double x1, double y1, double x2, double y2, string color = "0.8 G") => P.C.Append($"{color} 0.5 w {N(x1)} {N(y1)} m {N(x2)} {N(y2)} l S\n");
        public void Need(double h) { if (Y - h < Bottom) New(); }
    }

    /// <summary>Greedy word wrap by approximate width; a word longer than the line is cut.</summary>
    private static List<string> Wrap(string text, double width, double size)
    {
        var lines = new List<string>();
        foreach (var para in text.Replace("\r", "").Split('\n'))
        {
            var cur = new StringBuilder();
            foreach (var raw in para.Split(' ', StringSplitOptions.RemoveEmptyEntries))
            {
                var word = raw;
                while (PdfWriter.Width(word, size) > width && word.Length > 1)
                {
                    var cut = word.Length;
                    while (cut > 1 && PdfWriter.Width(word[..cut], size) > width) cut--;
                    if (cur.Length > 0) { lines.Add(cur.ToString()); cur.Clear(); }
                    lines.Add(word[..cut]); word = word[cut..];
                }
                var next = cur.Length == 0 ? word : cur + " " + word;
                if (PdfWriter.Width(next, size) <= width) { cur.Clear(); cur.Append(next); }
                else { lines.Add(cur.ToString()); cur.Clear(); cur.Append(word); }
            }
            lines.Add(cur.ToString());
        }
        return lines;
    }

    public (byte[] File, int Pages) Render(PdfDocModel doc)
    {
        // Cheap guard before laying out: far more text than 600 pages can hold is refused at once.
        var chars = doc.Blocks.Sum(b => b switch { PdfPara p => p.Text.Length, PdfItem i => i.Text.Length, PdfQuote q => q.Text.Length, PdfCode c => c.Lines.Sum(l => l.Length + 20), PdfTable t => t.Rows.Sum(r => r.Sum(c => c.Length + 10)), _ => 80 });
        if (chars > MaxPages * 6000L) throw new PdfTooLongException(chars / 3000);

        var lay = new Layout();
        lay.New();
        var usable = W - 2 * M;
        foreach (var block in doc.Blocks) Draw(lay, block, usable);
        var contentPages = lay.Pages.Count;

        // Contents: as many entries per page as fit; the entries need to know how many pages come before the content.
        var perPage = (int)((H - 2 * M - 60) / 18);
        var tocPages = Math.Max(1, (int)Math.Ceiling(lay.Outline.Count / (double)perPage));
        if (lay.Outline.Count == 0) tocPages = 0;
        var before = 1 + tocPages;   // cover + contents
        var total = before + contentPages;
        if (total > MaxPages) throw new PdfTooLongException(total);

        var all = new List<Pg>();
        // cover
        var cover = new Layout(); cover.New();
        cover.Rect(0, H - 150, W, 150, "0.36 0.31 0.84 rg");
        cover.Text("F1", 11, M, H - 60, doc.Organization, "1 g");
        cover.Text("F1", 11, M, H - 80, doc.Key + (doc.Version.Length > 0 ? " · version " + doc.Version : ""), "1 g");
        var y = H - 200;
        foreach (var line in Wrap(doc.Title, usable, 24)) { cover.Text("F2", 24, M, y, line); y -= 30; }
        y -= 16;
        foreach (var (label, value) in doc.Cover)
        {
            var vl = Wrap(value, usable - 130, Body);
            if (y - vl.Count * Lead < Bottom) break;
            cover.Text("F2", 9, M, y, label.ToUpperInvariant(), "0.45 g");
            foreach (var l in vl) { cover.Text("F1", Body, M + 130, y, l); y -= Lead; }
            y -= 4;
        }
        all.Add(cover.P);
        // contents
        for (var tp = 0; tp < tocPages; tp++)
        {
            var t = new Layout(); t.New();
            t.Text("F2", 16, M, t.Y - 14, "Contents"); t.Y -= 50;
            foreach (var e in lay.Outline.Skip(tp * perPage).Take(perPage))
            {
                var indent = (e.Level - 1) * 14;
                var label = PdfWriter.Fit(e.Text, usable - indent - 40, Body);
                var pageLabel = (before + e.Page + 1).ToString(CultureInfo.InvariantCulture);
                t.Text(e.Level == 1 ? "F2" : "F1", Body, M + indent, t.Y, label);
                t.Text("F1", Body, W - M - PdfWriter.Width(pageLabel, Body), t.Y, pageLabel);
                var dots = (int)((usable - indent - PdfWriter.Width(label, Body) - PdfWriter.Width(pageLabel, Body) - 12) / 3.2);
                if (dots > 2) t.Text("F1", Body, M + indent + PdfWriter.Width(label, Body) + 4, t.Y, new string('.', dots), "0.7 g");
                t.Y -= 18;
            }
            all.Add(t.P);
        }
        all.AddRange(lay.Pages);

        for (var i = 1; i < all.Count; i++)   // no footer on the cover
        {
            var p = all[i];
            p.C.Append($"BT 0.5 g /F1 8 Tf {N(M)} 28 Td ({PdfWriter.Pdf(PdfWriter.Fit(doc.Footer, usable - 90, 8))}) Tj ET\n");
            var label = $"Page {i + 1} of {all.Count}";
            p.C.Append($"BT 0.5 g /F1 8 Tf {N(W - M - PdfWriter.Width(label, 8))} 28 Td ({PdfWriter.Pdf(label)}) Tj ET\n");
        }
        return (Assemble(all), all.Count);
    }

    private static void Draw(Layout l, PdfBlock block, double usable)
    {
        switch (block)
        {
            case PdfBreak: l.New(); break;
            case PdfHeading h:
                {
                    var size = h.Level switch { 1 => 17.0, 2 => 13.5, _ => 11.5 };
                    var lines = Wrap(h.Text, usable, size);
                    l.Need(size * 2 + lines.Count * (size + 4));
                    l.Y -= h.Level == 1 ? 14 : 8;
                    l.Outline.Add((Math.Min(h.Level, 3), h.Text, l.Pages.Count - 1));
                    foreach (var line in lines) { l.Text("F2", size, M, l.Y - size, line); l.Y -= size + 4; }
                    if (h.Level == 1) { l.Line(M, l.Y + 1, W - M, l.Y + 1); l.Y -= 6; }
                    l.Y -= 4;
                    break;
                }
            case PdfPara p:
                foreach (var line in Wrap(p.Text, usable, Body)) { l.Need(Lead); l.Text("F1", Body, M, l.Y - Body, line, p.Muted ? "0.4 g" : "0 g"); l.Y -= Lead; }
                l.Y -= 4; break;
            case PdfItem i:
                {
                    var lines = Wrap(i.Text, usable - 16, Body);
                    for (var k = 0; k < lines.Count; k++) { l.Need(Lead); if (k == 0) l.Text("F1", Body, M + 4, l.Y - Body, "-"); l.Text("F1", Body, M + 16, l.Y - Body, lines[k]); l.Y -= Lead; }
                    l.Y -= 1; break;
                }
            case PdfQuote q:
                foreach (var line in Wrap(q.Text, usable - 18, Body)) { l.Need(Lead); l.Rect(M, l.Y - Lead + 3, 2, Lead, "0.7 g"); l.Text("F4", Body, M + 12, l.Y - Body, line, "0.3 g"); l.Y -= Lead; }
                l.Y -= 4; break;
            case PdfCode c:
                {
                    const double cs = 8.5, cl = 11.5;
                    var lines = c.Lines.SelectMany(x => Wrap(x.Length == 0 ? " " : x, usable - 12, cs)).ToList();
                    foreach (var line in lines) { l.Need(cl); l.Rect(M, l.Y - cl + 2, usable, cl, "0.95 g"); l.Text("F3", cs, M + 6, l.Y - cs, line); l.Y -= cl; }
                    l.Y -= 6; break;
                }
            case PdfFacts f:
                foreach (var (label, value) in f.Items)
                {
                    var vl = Wrap(value, usable - 140, Body);
                    l.Need(Lead * vl.Count);
                    l.Text("F2", 9, M, l.Y - Body, label, "0.4 g");
                    foreach (var line in vl) { l.Text("F1", Body, M + 140, l.Y - Body, line); l.Y -= Lead; }
                }
                l.Y -= 4; break;
            case PdfTable t: DrawTable(l, t, usable); break;
        }
    }

    private static void DrawTable(Layout l, PdfTable t, double usable)
    {
        const double fs = 8.5, line = 11, pad = 4;
        var cols = Math.Max(t.Headers.Count, t.Rows.Count == 0 ? 0 : t.Rows.Max(r => r.Count));
        if (cols == 0) return;
        var natural = new double[cols];
        for (var c = 0; c < cols; c++)
        {
            natural[c] = (c < t.Headers.Count ? PdfWriter.Width(t.Headers[c], fs) : 0) + 2 * pad;
            foreach (var r in t.Rows.Take(200)) if (c < r.Count) natural[c] = Math.Max(natural[c], Math.Min(PdfWriter.Width(r[c], fs), 260) + 2 * pad);
        }
        // Short columns keep what they need; long ones share the rest and wrap.
        var widths = new double[cols]; var open = Enumerable.Range(0, cols).ToList(); var room = usable;
        while (open.Count > 0)
        {
            var share = room / open.Count; var fits = open.Where(i => natural[i] <= share).ToList();
            if (fits.Count == 0) { foreach (var i in open) widths[i] = share; break; }
            foreach (var i in fits) { widths[i] = natural[i]; room -= natural[i]; open.Remove(i); }
        }

        void Header()
        {
            if (t.Headers.Count == 0) return;
            l.Need(line + 8);
            l.Rect(M, l.Y - line - 2, usable, line + 4, "0.93 0.91 0.99 rg"); double x = M;
            for (var c = 0; c < cols; c++) { l.Text("F2", fs, x + pad, l.Y - fs - 1, PdfWriter.Fit(c < t.Headers.Count ? t.Headers[c] : "", widths[c] - 2 * pad, fs)); x += widths[c]; }
            l.Y -= line + 5;
        }
        Header();
        var zebra = false;
        foreach (var row in t.Rows)
        {
            var cells = Enumerable.Range(0, cols).Select(c => Wrap(c < row.Count ? row[c] : "", widths[c] - 2 * pad, fs)).ToList();
            var rows = Math.Min(cells.Max(x => x.Count), 40);
            // A row that does not fit starts a new page with the header repeated; a very tall row is split by lines.
            var done = 0;
            while (done < rows)
            {
                if (l.Y - line < Bottom) { l.New(); Header(); }
                var fit = Math.Max(1, Math.Min(rows - done, (int)((l.Y - Bottom) / line)));
                var h = fit * line + 3;
                if (zebra) l.Rect(M, l.Y - h + 2, usable, h, "0.975 g");
                double x = M;
                for (var c = 0; c < cols; c++)
                {
                    for (var k = 0; k < fit && done + k < cells[c].Count; k++) l.Text("F1", fs, x + pad, l.Y - fs - k * line, cells[c][done + k]);
                    x += widths[c];
                }
                l.Y -= h; done += fit;
            }
            zebra = !zebra;
        }
        if (t.Rows.Count == 0) { l.Need(line); l.Text("F1", fs, M + pad, l.Y - fs, "Nothing to show.", "0.4 g"); l.Y -= line; }
        l.Y -= 8;
    }

    private static byte[] Assemble(List<Pg> pages)
    {
        var objects = new List<string>
        {
            "<< /Type /Catalog /Pages 2 0 R >>",
            $"<< /Type /Pages /Kids [{string.Join(' ', Enumerable.Range(0, pages.Count).Select(i => $"{7 + 2 * i} 0 R"))}] /Count {pages.Count} >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>",
        };
        for (var i = 0; i < pages.Count; i++)
        {
            objects.Add($"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {N(W)} {N(H)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> /Contents {8 + 2 * i} 0 R >>");
            var content = pages[i].C.ToString();
            objects.Add($"<< /Length {Encoding.Latin1.GetByteCount(content)} >>\nstream\n{content}endstream");
        }
        using var ms = new MemoryStream();
        void Put(string s) { var b = Encoding.Latin1.GetBytes(s); ms.Write(b, 0, b.Length); }
        Put("%PDF-1.4\n");
        var offsets = new List<long>();
        for (var i = 0; i < objects.Count; i++) { offsets.Add(ms.Position); Put($"{i + 1} 0 obj\n{objects[i]}\nendobj\n"); }
        var xref = ms.Position;
        Put($"xref\n0 {objects.Count + 1}\n0000000000 65535 f \n");
        foreach (var o in offsets) Put($"{o:D10} 00000 n \n");
        Put($"trailer\n<< /Size {objects.Count + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n");
        return ms.ToArray();
    }
}
