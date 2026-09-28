using System.Text;

namespace ProjectManagement.Application.Common;

public record CsvTable(char Delimiter, IReadOnlyList<string> Headers, IReadOnlyList<IReadOnlyList<string>> Rows);

/// <summary>
/// A forgiving CSV reader (RFC 4180): quoted cells with commas, line breaks and doubled quotes, LF / CRLF / CR line ends, a leading
/// byte-order mark, and comma / semicolon / tab as separator (guessed from the header line, as spreadsheet exports differ by region).
/// </summary>
public static class CsvParser
{
    public const int MaxColumns = 100;

    public static CsvTable Parse(string text, int maxRows)
    {
        if (text.Length > 0 && text[0] == '﻿') text = text[1..];
        var delimiter = Sniff(text);
        var records = new List<List<string>>();
        var row = new List<string>();
        var cell = new StringBuilder();
        var quoted = false; var cellStarted = false;

        void EndCell() { row.Add(cell.ToString()); cell.Clear(); cellStarted = false; }
        void EndRow()
        {
            EndCell();
            // Fully blank lines (spreadsheets add them) are not data.
            if (row.Count > 1 || row[0].Trim().Length > 0) records.Add(row);
            row = [];
            if (records.Count > maxRows + 1) throw new CsvException($"The file has more than {maxRows} rows. Split it into smaller files.");
        }

        for (var i = 0; i < text.Length; i++)
        {
            var ch = text[i];
            if (quoted)
            {
                if (ch == '"')
                {
                    if (i + 1 < text.Length && text[i + 1] == '"') { cell.Append('"'); i++; }
                    else quoted = false;
                }
                else cell.Append(ch);
                continue;
            }
            if (ch == '"' && !cellStarted) { quoted = true; cellStarted = true; continue; }
            if (ch == delimiter) { EndCell(); if (row.Count > MaxColumns) throw new CsvException($"The file has more than {MaxColumns} columns."); continue; }
            if (ch == '\r') { if (i + 1 < text.Length && text[i + 1] == '\n') i++; EndRow(); continue; }
            if (ch == '\n') { EndRow(); continue; }
            cell.Append(ch); cellStarted = true;
        }
        if (quoted) throw new CsvException("A quoted cell is never closed. Check for a stray quotation mark.");
        if (cellStarted || cell.Length > 0 || row.Count > 0) EndRow();

        if (records.Count == 0) throw new CsvException("The file is empty.");
        var headers = records[0].Select(h => h.Trim()).ToList();
        if (headers.All(h => h.Length == 0)) throw new CsvException("The first row must contain column names.");
        var rows = records.Skip(1).Select(r => (IReadOnlyList<string>)r).ToList();
        return new CsvTable(delimiter, headers, rows);
    }

    private static char Sniff(string text)
    {
        var firstLine = text.Split('\n', 2)[0];
        var counts = new[] { ',', ';', '\t' }.Select(d => (D: d, N: OutsideQuotes(firstLine, d))).OrderByDescending(x => x.N).First();
        return counts.N == 0 ? ',' : counts.D;
    }

    private static int OutsideQuotes(string line, char d)
    {
        var n = 0; var q = false;
        foreach (var c in line) { if (c == '"') q = !q; else if (c == d && !q) n++; }
        return n;
    }
}

public class CsvException(string message) : Exception(message);
