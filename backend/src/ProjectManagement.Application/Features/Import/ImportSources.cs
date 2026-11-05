using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using ClosedXML.Excel;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;

namespace ProjectManagement.Application.Features.Import;

/// <summary>
/// Turns what people bring from other tools into one table with the usual column names, so the same mapping, preview (the dry run) and
/// import run for every source: a spreadsheet (CSV or Excel), a Jira CSV export, a Trello JSON export, or an Asana CSV export. Jira and
/// Asana can also be read over their APIs with a token the person pastes; the token is used for that one read and never kept.
/// </summary>
public static class ImportSources
{
    public static readonly string[] Kinds = ["csv", "excel", "jira", "trello", "asana"];

    public static string Normalize(string? source, string? fileName)
    {
        var s = (source ?? "").Trim().ToLowerInvariant();
        if (s.Length == 0)
        {
            var ext = Path.GetExtension(fileName ?? "").ToLowerInvariant();
            s = ext is ".xlsx" or ".xlsm" ? "excel" : ext == ".json" ? "trello" : "csv";
        }
        if (!Kinds.Contains(s)) throw new ValidationException("source", "Choose CSV, Excel, Jira, Trello or Asana.");
        return s;
    }

    /// <summary>The file as a table: header row plus data rows.</summary>
    public static CsvTable Read(string source, byte[] bytes, int maxRows, out bool legacyEncoding)
    {
        legacyEncoding = false;
        switch (source)
        {
            case "excel": return Excel(bytes, maxRows);
            case "trello": return Trello(bytes, maxRows);
        }
        var text = TaskImportService.Decode(bytes, out legacyEncoding);
        CsvTable table;
        try { table = CsvParser.Parse(text, maxRows); }
        catch (CsvException e) { throw new ValidationException("file", e.Message); }
        return source switch
        {
            "jira" => Jira(table),
            "asana" => Asana(table),
            _ => table,
        };
    }

    // ---------------------------------------------------------------- Excel

    private static CsvTable Excel(byte[] bytes, int maxRows)
    {
        XLWorkbook wb;
        try { wb = new XLWorkbook(new MemoryStream(bytes)); }
        catch (Exception) { throw new ValidationException("file", "The file is not an Excel workbook (.xlsx)."); }
        using (wb)
        {
            var ws = wb.Worksheets.FirstOrDefault() ?? throw new ValidationException("file", "The workbook has no sheets.");
            var used = ws.RangeUsed();
            if (used is null) throw new ValidationException("file", "The first sheet is empty.");
            var firstRow = used.FirstRow().RowNumber(); var lastRow = used.LastRow().RowNumber();
            var firstCol = used.FirstColumn().ColumnNumber(); var lastCol = Math.Min(used.LastColumn().ColumnNumber(), firstCol + CsvParser.MaxColumns - 1);
            if (lastRow - firstRow > maxRows) throw new ValidationException("file", $"The sheet has more than {maxRows} rows. Split it into smaller files.");
            string Cell(int r, int c)
            {
                var cell = ws.Cell(r, c);
                if (cell.IsEmpty()) return "";
                // Dates stay dates (ISO), whatever the sheet's display format.
                if (cell.DataType == XLDataType.DateTime) return cell.GetDateTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                return cell.GetFormattedString().Trim();
            }
            var headers = Enumerable.Range(firstCol, lastCol - firstCol + 1).Select(c => Cell(firstRow, c)).ToList();
            var rows = new List<IReadOnlyList<string>>();
            for (var r = firstRow + 1; r <= lastRow; r++)
            {
                var row = Enumerable.Range(firstCol, lastCol - firstCol + 1).Select(c => Cell(r, c)).ToList();
                if (row.All(v => v.Length == 0)) continue;
                rows.Add(row);
            }
            return new CsvTable(',', headers, rows);
        }
    }

    // ---------------------------------------------------------------- Jira (CSV export)

    private static int Col(CsvTable t, params string[] names)
    {
        for (var n = 0; n < names.Length; n++)
            for (var i = 0; i < t.Headers.Count; i++)
                if (t.Headers[i].Trim().Equals(names[n], StringComparison.OrdinalIgnoreCase)) return i;
        return -1;
    }

    private static string At(IReadOnlyList<string> r, int i) => i >= 0 && i < r.Count ? r[i].Trim() : "";

    /// <summary>Jira's "Export CSV (all fields)": Summary, Description, Status, Priority, Assignee (or its e-mail column), Due date, Labels (one column each).</summary>
    private static CsvTable Jira(CsvTable t)
    {
        var title = Col(t, "Summary"); var desc = Col(t, "Description"); var status = Col(t, "Status"); var prio = Col(t, "Priority");
        var who = Col(t, "Assignee Email", "Assignee email address", "Assignee"); var due = Col(t, "Due date", "Due Date", "Due");
        var start = Col(t, "Start date", "Start Date"); var key = Col(t, "Issue key", "Key");
        var labels = Enumerable.Range(0, t.Headers.Count).Where(i => t.Headers[i].Trim().Equals("Labels", StringComparison.OrdinalIgnoreCase)).ToList();
        if (title < 0) throw new ValidationException("file", "This does not look like a Jira export: there is no Summary column.");
        var rows = t.Rows.Select(r => (IReadOnlyList<string>)new List<string>
        {
            At(r, title), At(r, desc), At(r, status), At(r, prio), At(r, who), JiraDate(At(r, start)), JiraDate(At(r, due)),
            string.Join(", ", labels.Select(i => At(r, i)).Where(v => v.Length > 0)), At(r, key),
        }).ToList();
        return new CsvTable(',', ["Title", "Description", "Status", "Priority", "Assignee", "Start date", "Due date", "Labels", "Source key"], rows);
    }

    /// <summary>Jira writes dates as "12/Nov/26 5:00 PM" or ISO; both become ISO days.</summary>
    private static string JiraDate(string v)
    {
        if (v.Length == 0) return "";
        string[] formats = ["dd/MMM/yy h:mm tt", "d/MMM/yy h:mm tt", "dd/MMM/yy", "d/MMM/yy", "yyyy-MM-dd", "yyyy-MM-dd HH:mm", "yyyy-MM-ddTHH:mm:ss.fffzzz"];
        return DateTime.TryParseExact(v, formats, CultureInfo.InvariantCulture, DateTimeStyles.AllowWhiteSpaces, out var d) ? d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : v;
    }

    // ---------------------------------------------------------------- Asana (CSV export)

    /// <summary>Asana's project CSV: Name, Notes, Assignee Email, Start Date, Due Date, Section/Column, Completed At, Tags.</summary>
    private static CsvTable Asana(CsvTable t)
    {
        var name = Col(t, "Name"); var notes = Col(t, "Notes"); var email = Col(t, "Assignee Email", "Assignee"); var start = Col(t, "Start Date");
        var due = Col(t, "Due Date"); var section = Col(t, "Section/Column", "Section"); var done = Col(t, "Completed At"); var tags = Col(t, "Tags");
        if (name < 0) throw new ValidationException("file", "This does not look like an Asana export: there is no Name column.");
        var rows = t.Rows.Where(r => At(r, name).Length > 0).Select(r => (IReadOnlyList<string>)new List<string>
        {
            At(r, name), At(r, notes), At(r, done).Length > 0 ? "Done" : At(r, section), At(r, email), At(r, start), At(r, due), At(r, tags),
        }).ToList();
        return new CsvTable(',', ["Title", "Description", "Status", "Assignee", "Start date", "Due date", "Labels"], rows);
    }

    // ---------------------------------------------------------------- Trello (JSON export)

    /// <summary>A Trello board's JSON export: open cards, with their list as the status, members, labels and due date.</summary>
    private static CsvTable Trello(byte[] bytes, int maxRows)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(bytes); }
        catch (JsonException) { throw new ValidationException("file", "The file is not a Trello board export (JSON)."); }
        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("cards", out var cards) || cards.ValueKind != JsonValueKind.Array)
                throw new ValidationException("file", "The file is not a Trello board export: it has no cards.");
            string S(JsonElement e, string p) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(p, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
            bool B(JsonElement e, string p) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(p, out var v) && v.ValueKind == JsonValueKind.True;
            var lists = new Dictionary<string, string>();
            if (root.TryGetProperty("lists", out var ls) && ls.ValueKind == JsonValueKind.Array)
                foreach (var l in ls.EnumerateArray()) lists[S(l, "id")] = S(l, "name");
            var members = new Dictionary<string, string>();
            if (root.TryGetProperty("members", out var ms) && ms.ValueKind == JsonValueKind.Array)
                foreach (var m in ms.EnumerateArray()) members[S(m, "id")] = S(m, "email") is { Length: > 0 } em ? em : S(m, "fullName");
            var rows = new List<IReadOnlyList<string>>();
            foreach (var c in cards.EnumerateArray())
            {
                if (B(c, "closed")) continue;
                if (rows.Count >= maxRows) throw new ValidationException("file", $"The board has more than {maxRows} cards. Split it into smaller files.");
                var who = c.TryGetProperty("idMembers", out var im) && im.ValueKind == JsonValueKind.Array
                    ? im.EnumerateArray().Select(x => x.ValueKind == JsonValueKind.String ? members.GetValueOrDefault(x.GetString() ?? "") : null).FirstOrDefault(x => !string.IsNullOrEmpty(x)) ?? "" : "";
                var labels = c.TryGetProperty("labels", out var lb) && lb.ValueKind == JsonValueKind.Array
                    ? string.Join(", ", lb.EnumerateArray().Select(x => S(x, "name")).Where(x => x.Length > 0)) : "";
                var due = S(c, "due");
                if (DateTime.TryParse(due, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal, out var d)) due = d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                var status = B(c, "dueComplete") ? "Done" : lists.GetValueOrDefault(S(c, "idList")) ?? "";
                rows.Add([S(c, "name"), S(c, "desc"), status, who, due, labels]);
            }
            return new CsvTable(',', ["Title", "Description", "Status", "Assignee", "Due date", "Labels"], rows);
        }
    }

    // ---------------------------------------------------------------- reading Jira and Asana over their APIs

    private static readonly Regex JiraSite = new(@"^[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$", RegexOptions.CultureInvariant);
    private static readonly Regex AsanaGid = new(@"^\d{1,30}$", RegexOptions.CultureInvariant);

    /// <summary>The site part of a Jira Cloud address ("acme" or "acme.atlassian.net" or its https URL); anything else is refused (no other hosts are called).</summary>
    public static string JiraHost(string? site)
    {
        var s = (site ?? "").Trim().ToLowerInvariant();
        if (s.StartsWith("https://", StringComparison.Ordinal)) s = s[8..];
        s = s.TrimEnd('/');
        if (!s.Contains('.')) s += ".atlassian.net";
        if (!JiraSite.IsMatch(s)) throw new ValidationException("site", "Enter your Jira Cloud site, like acme.atlassian.net.");
        return s;
    }

    private static string Csv(IEnumerable<IEnumerable<string>> rows) =>
        string.Join("\r\n", rows.Select(r => string.Join(",", r.Select(v => "\"" + (v ?? "").Replace("\"", "\"\"") + "\"")))) + "\r\n";

    private static async Task<JsonDocument> GetJsonAsync(HttpClient http, HttpRequestMessage req, string who, CancellationToken ct)
    {
        using var res = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        if (res.StatusCode is System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.Forbidden)
            throw new ValidationException("token", $"{who} did not accept the token. Check it and try again.");
        if (!res.IsSuccessStatusCode) throw new ConflictException($"{who} answered {(int)res.StatusCode}. Try again in a moment.", "IMPORT_SOURCE_FAILED");
        var body = await res.Content.ReadAsByteArrayAsync(ct);
        if (body.Length > 8 * 1024 * 1024) throw new ConflictException($"{who} sent more than 8 MB. Narrow the search.", "IMPORT_SOURCE_FAILED");
        try { return JsonDocument.Parse(body); }
        catch (JsonException) { throw new ConflictException($"{who} sent something that could not be read.", "IMPORT_SOURCE_FAILED"); }
    }

    /// <summary>Jira Cloud issues matching a JQL search, as a Jira-shaped CSV (up to 1000).</summary>
    public static async Task<string> JiraApiAsync(HttpClient http, string? site, string? email, string? token, string? jql, CancellationToken ct)
    {
        var host = JiraHost(site);
        if (string.IsNullOrWhiteSpace(email) || string.IsNullOrWhiteSpace(token)) throw new ValidationException("token", "Enter your Atlassian e-mail and API token.");
        var query = string.IsNullOrWhiteSpace(jql) ? "order by created DESC" : jql.Trim();
        if (query.Length > 1000) throw new ValidationException("jql", "The search is too long.");
        var auth = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{email.Trim()}:{token.Trim()}"));
        var rows = new List<List<string>> { new() { "Summary", "Description", "Status", "Priority", "Assignee Email", "Start date", "Due date", "Labels", "Issue key" } };
        string? next = null;
        do
        {
            var url = $"https://{host}/rest/api/3/search/jql?maxResults=100&fields=summary,status,priority,assignee,duedate,labels,description&jql={Uri.EscapeDataString(query)}"
                + (next is null ? "" : $"&nextPageToken={Uri.EscapeDataString(next)}");
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Authorization = new AuthenticationHeaderValue("Basic", auth);
            req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            using var doc = await GetJsonAsync(http, req, "Jira", ct);
            if (!doc.RootElement.TryGetProperty("issues", out var issues) || issues.ValueKind != JsonValueKind.Array) break;
            foreach (var i in issues.EnumerateArray())
            {
                var f = i.TryGetProperty("fields", out var ff) ? ff : default;
                string F(params string[] path)
                {
                    var e = f;
                    foreach (var p in path) { if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(p, out e)) return ""; }
                    return e.ValueKind == JsonValueKind.String ? e.GetString() ?? "" : "";
                }
                var labels = f.ValueKind == JsonValueKind.Object && f.TryGetProperty("labels", out var lb) && lb.ValueKind == JsonValueKind.Array
                    ? string.Join(", ", lb.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString())) : "";
                rows.Add([F("summary"), "", F("status", "name"), F("priority", "name"), F("assignee", "emailAddress") is { Length: > 0 } em ? em : F("assignee", "displayName"),
                    "", F("duedate"), labels, i.TryGetProperty("key", out var k) && k.ValueKind == JsonValueKind.String ? k.GetString() ?? "" : ""]);
                if (rows.Count > 1000) break;
            }
            next = doc.RootElement.TryGetProperty("nextPageToken", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null;
        } while (next is not null && rows.Count <= 1000);
        return Csv(rows);
    }

    /// <summary>The tasks of one Asana project (its id from the project's address), as an Asana-shaped CSV.</summary>
    public static async Task<string> AsanaApiAsync(HttpClient http, string? projectGid, string? token, CancellationToken ct)
    {
        var gid = (projectGid ?? "").Trim();
        var m = Regex.Match(gid, @"/(\d{6,30})(?:/|$)");
        if (m.Success) gid = m.Groups[1].Value;
        if (!AsanaGid.IsMatch(gid)) throw new ValidationException("project", "Paste the Asana project's address or its number.");
        if (string.IsNullOrWhiteSpace(token)) throw new ValidationException("token", "Enter an Asana personal access token.");
        var rows = new List<List<string>> { new() { "Name", "Notes", "Assignee Email", "Start Date", "Due Date", "Section/Column", "Completed At", "Tags" } };
        string? offset = null;
        do
        {
            var url = $"https://app.asana.com/api/1.0/projects/{gid}/tasks?limit=100&opt_fields=name,notes,assignee.email,start_on,due_on,completed,completed_at,memberships.section.name,tags.name"
                + (offset is null ? "" : $"&offset={Uri.EscapeDataString(offset)}");
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Trim());
            using var doc = await GetJsonAsync(http, req, "Asana", ct);
            if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array) break;
            foreach (var t in data.EnumerateArray())
            {
                string S(JsonElement e, string p) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(p, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
                var who = t.TryGetProperty("assignee", out var a) ? S(a, "email") : "";
                var section = t.TryGetProperty("memberships", out var ms) && ms.ValueKind == JsonValueKind.Array
                    ? ms.EnumerateArray().Select(x => x.TryGetProperty("section", out var s) ? S(s, "name") : "").FirstOrDefault(x => x.Length > 0) ?? "" : "";
                var tags = t.TryGetProperty("tags", out var tg) && tg.ValueKind == JsonValueKind.Array ? string.Join(", ", tg.EnumerateArray().Select(x => S(x, "name")).Where(x => x.Length > 0)) : "";
                var done = t.TryGetProperty("completed", out var c) && c.ValueKind == JsonValueKind.True ? (S(t, "completed_at") is { Length: > 0 } at ? at : "yes") : "";
                rows.Add([S(t, "name"), S(t, "notes"), who, S(t, "start_on"), S(t, "due_on"), section, done, tags]);
                if (rows.Count > 1000) break;
            }
            offset = doc.RootElement.TryGetProperty("next_page", out var np) && np.ValueKind == JsonValueKind.Object ? Str(np, "offset") : null;
            if (offset == "") offset = null;
        } while (offset is not null && rows.Count <= 1000);
        return Csv(rows);
    }
    private static string Str(JsonElement e, string p) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(p, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
}
