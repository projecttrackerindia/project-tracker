using System.Globalization;
using System.Text;
using ClosedXML.Excel;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Reports;

/// <summary>One table of a report. Cells may be text, whole numbers, decimals, dates or null.</summary>
public record ReportSection(string Heading, IReadOnlyList<string> Headers, IReadOnlyList<IReadOnlyList<object?>> Rows);

/// <summary>A finished report, independent of the file format it will be written as.</summary>
public record ReportDocument(string Title, string Subtitle, IReadOnlyList<ReportSection> Sections);



public record ReportFile(byte[] Content, string ContentType, string Extension);

public static class ReportWriter
{
    public static ReportFile Write(ReportDocument doc, ReportFormat format) => format switch
    {
        ReportFormat.Csv => new ReportFile(WriteCsv(doc), "text/csv", "csv"),
        ReportFormat.Xlsx => new ReportFile(WriteXlsx(doc), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"),
        _ => new ReportFile(PdfWriter.Write(doc), "application/pdf", "pdf"),
    };

    public static string Text(object? cell) => cell switch
    {
        null => "",
        string s => s,
        DateOnly d => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        DateTime d => d.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture) + " UTC",
        decimal m => m.ToString("0.##", CultureInfo.InvariantCulture),
        double n => n.ToString("0.##", CultureInfo.InvariantCulture),
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        _ => cell.ToString() ?? "",
    };

    /// <summary>Text that a spreadsheet would run as a formula is stored as plain text instead (formula injection).</summary>
    public static string Safe(string s) => s.Length > 0 && s[0] is '=' or '+' or '-' or '@' or '\t' or '\r' ? "'" + s : s;

    // ---------------------------------------------------------------- csv

    private static string Csv(string value) =>
        value.IndexOfAny([',', '"', '\n', '\r']) >= 0 ? $"\"{value.Replace("\"", "\"\"")}\"" : value;

    private static byte[] WriteCsv(ReportDocument doc)
    {
        var sb = new StringBuilder();
        sb.Append(Csv(Safe(doc.Title))).Append("\r\n").Append(Csv(doc.Subtitle)).Append("\r\n");
        foreach (var s in doc.Sections)
        {
            sb.Append("\r\n").Append(Csv(Safe(s.Heading))).Append("\r\n");
            sb.AppendJoin(',', s.Headers.Select(h => Csv(Safe(h)))).Append("\r\n");
            foreach (var row in s.Rows)
                sb.AppendJoin(',', row.Select(c => Csv(c is string str ? Safe(str) : Text(c)))).Append("\r\n");
        }
        return new UTF8Encoding(true).GetPreamble().Concat(Encoding.UTF8.GetBytes(sb.ToString())).ToArray();
    }

    /// <summary>
    /// One table as a plain CSV (header row first, no title lines), for an instant "download this list" button. Same cell
    /// formatting and formula-injection protection as the generated reports, because it is the same writer.
    /// </summary>
    public static byte[] WriteTableCsv(ReportSection section)
    {
        var sb = new StringBuilder();
        sb.AppendJoin(',', section.Headers.Select(h => Csv(Safe(h)))).Append("\r\n");
        foreach (var row in section.Rows)
            sb.AppendJoin(',', row.Select(c => Csv(c is string str ? Safe(str) : Text(c)))).Append("\r\n");
        return new UTF8Encoding(true).GetPreamble().Concat(Encoding.UTF8.GetBytes(sb.ToString())).ToArray();
    }

    // ---------------------------------------------------------------- xlsx

    private static byte[] WriteXlsx(ReportDocument doc)
    {
        using var wb = new XLWorkbook();
        wb.Properties.Title = doc.Title;
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var section in doc.Sections)
        {
            var ws = wb.Worksheets.Add(SheetName(section.Heading, used));
            for (var c = 0; c < section.Headers.Count; c++)
            {
                var h = ws.Cell(1, c + 1);
                h.Value = section.Headers[c];
                h.Style.Font.Bold = true;
                h.Style.Fill.BackgroundColor = XLColor.FromHtml("#EDE9FE");
            }
            var widths = section.Headers.Select(h => h.Length).ToArray();
            for (var r = 0; r < section.Rows.Count; r++)
            {
                var row = section.Rows[r];
                for (var c = 0; c < row.Count && c < widths.Length; c++)
                {
                    var cell = ws.Cell(r + 2, c + 1);
                    switch (row[c])
                    {
                        case null: break;
                        case string s: cell.Value = Safe(s); cell.Style.NumberFormat.Format = "@"; widths[c] = Math.Max(widths[c], s.Length); break;
                        case DateOnly d: cell.Value = d.ToDateTime(TimeOnly.MinValue); cell.Style.DateFormat.Format = "yyyy-mm-dd"; widths[c] = Math.Max(widths[c], 10); break;
                        case DateTime d: cell.Value = d; cell.Style.DateFormat.Format = "yyyy-mm-dd hh:mm"; widths[c] = Math.Max(widths[c], 16); break;
                        case decimal m: cell.Value = m; widths[c] = Math.Max(widths[c], Text(m).Length); break;
                        case double n: cell.Value = n; widths[c] = Math.Max(widths[c], Text(n).Length); break;
                        case int i: cell.Value = i; widths[c] = Math.Max(widths[c], Text(i).Length); break;
                        case long l: cell.Value = l; widths[c] = Math.Max(widths[c], Text(l).Length); break;
                        default: var t = Text(row[c]); cell.Value = Safe(t); widths[c] = Math.Max(widths[c], t.Length); break;
                    }
                }
            }
            // Widths are set by hand: automatic fitting needs system fonts, which a slim container does not have.
            for (var c = 0; c < widths.Length; c++) ws.Column(c + 1).Width = Math.Clamp(widths[c] * 1.15 + 2, 8, 60);
            ws.SheetView.FreezeRows(1);
            if (section.Rows.Count > 0 && section.Headers.Count > 0) ws.Range(1, 1, section.Rows.Count + 1, section.Headers.Count).SetAutoFilter();
        }
        if (doc.Sections.Count == 0) wb.Worksheets.Add("Report");
        using var ms = new MemoryStream();
        wb.SaveAs(ms);
        return ms.ToArray();
    }

    private static string SheetName(string heading, HashSet<string> used)
    {
        var clean = new string(heading.Where(c => !"[]:*?/\\".Contains(c)).ToArray()).Trim();
        if (clean.Length == 0) clean = "Sheet";
        if (clean.Length > 31) clean = clean[..31];
        var name = clean; var n = 2;
        while (!used.Add(name)) { var suffix = $" ({n++})"; name = clean[..Math.Min(clean.Length, 31 - suffix.Length)] + suffix; }
        return name;
    }
}

/// <summary>
/// A small, dependency-free PDF writer for tabular reports: A4 landscape, the standard Helvetica fonts (so no font files are needed),
/// repeating table headers and "Page x of y" footers.
/// </summary>
internal static class PdfWriter
{
    private const double PageW = 842, PageH = 595, Margin = 36, RowH = 15, FontSize = 8.5, HeadSize = 9;

    /// <summary>Approximate Helvetica advance width in points; good enough to truncate and right-align.</summary>
    internal static double Width(string s, double size)
    {
        double w = 0;
        foreach (var ch in s)
            w += ch switch
            {
                'i' or 'j' or 'l' or 't' or 'f' or 'I' or '.' or ',' or ';' or ':' or '\'' or '|' or '!' or '(' or ')' or '[' or ']' or ' ' or '-' => 0.29,
                'm' or 'w' or 'M' or 'W' or '@' => 0.83,
                >= 'A' and <= 'Z' => 0.67,
                >= '0' and <= '9' => 0.556,
                _ => 0.52,
            };
        return w * size;
    }

    internal static string Fit(string s, double max, double size)
    {
        if (Width(s, size) <= max) return s;
        while (s.Length > 1 && Width(s + "...", size) > max) s = s[..^1];
        return s.TrimEnd() + "...";
    }

    /// <summary>Latin-1 bytes with the PDF string escapes; characters the standard fonts cannot draw become plain look-alikes or '?'.</summary>
    internal static string Pdf(string s)
    {
        var sb = new StringBuilder(s.Length + 2);
        foreach (var raw in s)
        {
            var ch = raw switch { '’' or '‘' => '\'', '“' or '”' => '"', '–' or '—' or '−' => '-', '…' => '.', ' ' => ' ', '\r' or '\n' or '\t' => ' ', _ => raw };
            if (ch is < ' ' or (> '~' and < '¡') or > 'ÿ') ch = '?';
            if (ch is '(' or ')' or '\\') sb.Append('\\');
            sb.Append(ch);
        }
        return sb.ToString();
    }

    /// <summary>
    /// Column widths that fit the page: short columns (dates, numbers, keys) keep the width they need, and only the long ones
    /// (titles, notes) share what is left and get truncated.
    /// </summary>
    private static double[] Allocate(double[] natural, double usable)
    {
        if (natural.Sum() <= usable) return natural.ToArray();
        var widths = new double[natural.Length];
        var open = Enumerable.Range(0, natural.Length).ToList();
        var room = usable;
        while (open.Count > 0)
        {
            var share = room / open.Count;
            var fits = open.Where(i => natural[i] <= share).ToList();
            if (fits.Count == 0) { foreach (var i in open) widths[i] = share; break; }
            foreach (var i in fits) { widths[i] = natural[i]; room -= natural[i]; open.Remove(i); }
        }
        return widths;
    }

    private sealed class Page { public readonly StringBuilder Content = new(); }

    public static byte[] Write(ReportDocument doc)
    {
        var pages = new List<Page>();
        Page page = null!; double y = 0;
        void NewPage() { page = new Page(); pages.Add(page); y = PageH - Margin; }
        void Text(string font, double size, double x, double yy, string text, string color = "0 g") =>
            page.Content.Append($"BT {color} /{font} {size.ToString("0.##", CultureInfo.InvariantCulture)} Tf {x.ToString("0.##", CultureInfo.InvariantCulture)} {yy.ToString("0.##", CultureInfo.InvariantCulture)} Td ({Pdf(text)}) Tj ET\n");
        void Rect(double x, double yy, double w, double h, string fill) =>
            page.Content.Append($"{fill} {x.ToString("0.##", CultureInfo.InvariantCulture)} {yy.ToString("0.##", CultureInfo.InvariantCulture)} {w.ToString("0.##", CultureInfo.InvariantCulture)} {h.ToString("0.##", CultureInfo.InvariantCulture)} re f\n");

        NewPage();
        Text("F2", 16, Margin, y - 14, doc.Title); y -= 34;
        Text("F1", 9, Margin, y, doc.Subtitle, "0.4 g"); y -= 22;

        var usable = PageW - 2 * Margin;
        foreach (var s in doc.Sections)
        {
            if (y < Margin + 70) NewPage();
            Text("F2", 12, Margin, y - 10, s.Heading); y -= 26;

            var cols = s.Headers.Count;
            if (cols == 0) continue;
            var natural = new double[cols];
            for (var c = 0; c < cols; c++)
            {
                natural[c] = Width(s.Headers[c], HeadSize) + 12;
                foreach (var row in s.Rows.Take(300))
                    if (c < row.Count) natural[c] = Math.Max(natural[c], Math.Min(Width(ReportWriter.Text(row[c]), FontSize), 220) + 12);
            }
            var widths = Allocate(natural, usable);
            var right = Enumerable.Range(0, cols).Select(c => s.Rows.Take(50).Any(r => c < r.Count && r[c] is int or long or decimal or double) && s.Rows.Take(50).All(r => c >= r.Count || r[c] is null or int or long or decimal or double)).ToArray();

            void Header()
            {
                Rect(Margin, y - RowH + 3, widths.Sum(), RowH, "0.93 0.91 0.99 rg");
                double x = Margin;
                for (var c = 0; c < cols; c++)
                {
                    var t = Fit(s.Headers[c], widths[c] - 8, HeadSize);
                    Text("F2", HeadSize, right[c] ? x + widths[c] - 4 - Width(t, HeadSize) : x + 4, y - 8, t);
                    x += widths[c];
                }
                y -= RowH;
            }

            if (y < Margin + 60) NewPage();
            Header();
            var zebra = false;
            foreach (var row in s.Rows)
            {
                if (y < Margin + RowH + 14) { NewPage(); Header(); zebra = false; }
                if (zebra) Rect(Margin, y - RowH + 3, widths.Sum(), RowH, "0.975 g");
                zebra = !zebra;
                double x = Margin;
                for (var c = 0; c < cols; c++)
                {
                    var t = Fit(c < row.Count ? ReportWriter.Text(row[c]) : "", widths[c] - 8, FontSize);
                    Text("F1", FontSize, right[c] ? x + widths[c] - 4 - Width(t, FontSize) : x + 4, y - 8, t);
                    x += widths[c];
                }
                y -= RowH;
            }
            if (s.Rows.Count == 0) { Text("F1", FontSize, Margin + 4, y - 8, "No data.", "0.4 g"); y -= RowH; }
            y -= 14;
        }

        // Footers need the final page count.
        for (var i = 0; i < pages.Count; i++)
        {
            page = pages[i];
            Text("F1", 8, Margin, 20, $"{doc.Title}", "0.5 g");
            var label = $"Page {i + 1} of {pages.Count}";
            Text("F1", 8, PageW - Margin - Width(label, 8), 20, label, "0.5 g");
        }

        // ---- assemble the file
        var objects = new List<string>
        {
            "<< /Type /Catalog /Pages 2 0 R >>",
            $"<< /Type /Pages /Kids [{string.Join(' ', Enumerable.Range(0, pages.Count).Select(i => $"{5 + 2 * i} 0 R"))}] /Count {pages.Count} >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        };
        for (var i = 0; i < pages.Count; i++)
        {
            objects.Add($"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PageW} {PageH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {6 + 2 * i} 0 R >>");
            var content = pages[i].Content.ToString();
            objects.Add($"<< /Length {Encoding.Latin1.GetByteCount(content)} >>\nstream\n{content}endstream");
        }

        using var ms = new MemoryStream();
        void Put(string s) { var b = Encoding.Latin1.GetBytes(s); ms.Write(b, 0, b.Length); }
        Put("%PDF-1.4\n");
        var offsets = new List<long>();
        for (var i = 0; i < objects.Count; i++)
        {
            offsets.Add(ms.Position);
            Put($"{i + 1} 0 obj\n{objects[i]}\nendobj\n");
        }
        var xref = ms.Position;
        Put($"xref\n0 {objects.Count + 1}\n0000000000 65535 f \n");
        foreach (var o in offsets) Put($"{o:D10} 00000 n \n");
        Put($"trailer\n<< /Size {objects.Count + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n");
        return ms.ToArray();
    }
}
