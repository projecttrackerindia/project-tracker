using System.Globalization;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.ApiDocs;
using ProjectManagement.Application.Features.Reports;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Documents;

/// <summary>
/// Collects a document as its reader sees it into what the PDF prints. It runs as the person who asked (their access, not the system's), so a PDF can never
/// hold more than the screen would show. Secret values are never part of it: only their names are listed.
/// </summary>
public record ExportDocumentRequest(Guid? VersionId = null);
public record RenderDiagramRequest(string? Source);


/// <summary>
/// Collects a document as its reader sees it into what the PDF prints. It runs as the person who asked (their access, not the system's), so a PDF can never
/// hold more than the screen would show. Secret values are never part of it: only their names are listed. Host names and credentials in examples are masked.
/// </summary>
public class DocumentPdfBuilder(DocumentService documents, DocumentVersionService versions, DocumentWorkflowService workflows, DocumentTraceService trace, ApiDocService api,
    SecretService secrets, IAppDbContext db, ICurrentContext ctx, AppClock clock, ProjectManagement.Application.Features.Workspaces.WorkspaceLogoService logos)
{
    public const int MaxEndpoints = 1000;
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
    private static readonly string[] StageNames = ["Draft", "Design", "Development", "SIT", "UAT", "Pre-prod", "Production", "Deprecated", "Retired"];
    private static readonly System.Text.RegularExpressions.Regex Sensitive = new("secret|token|password|passwd|authorization|api[-_]?key|client[-_]?id|signature", System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.Compiled);

    private static string Day(DateTime d) => d.ToString("d MMMM yyyy", Inv);
    private static string Stamp(DateTime d) => d.ToString("d MMM yyyy, h:mm tt", Inv).Replace("AM", "am").Replace("PM", "pm");

    /// <summary>Keeps the shape of a credential and hides the rest (78g65*******fa2b).</summary>
    public static string Mask(string name, string? value)
    {
        if (string.IsNullOrEmpty(value)) return value ?? "";
        if (!Sensitive.IsMatch(name)) return value;
        var prefix = value.StartsWith("Basic ", StringComparison.OrdinalIgnoreCase) ? "Basic " : value.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? "Bearer " : "";
        var v = value[prefix.Length..];
        return prefix + (v.Length > 10 ? v[..5] + "*******" + v[^4..] : "*********");
    }

    public async Task<PdfDocModel> BuildAsync(Guid documentId, Guid? versionId, string organization, CancellationToken ct)
    {
        var d = await documents.GetAsync(documentId, ct);
        var item = d.Item;
        var vlist = await versions.ListAsync(documentId, ct);
        IReadOnlyList<SectionDto> sections = d.Sections;
        string label = d.PublishedLabel ?? d.VersionLabel;
        if (versionId is { } vid)
        {
            var v = await versions.GetAsync(documentId, vid, ct);
            sections = v.Sections; label = v.Version.Label;
        }
        var me = await db.Users.AsNoTracking().Where(u => u.Id == ctx.RequireUserId()).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "";
        var logo = await logos.ForPdfAsync(ctx.RequireTenantId(), ct);
        var brand = new PdfBrand(organization, logo, "Project Tracker", me, clock.Now.ToString("d MMMM yyyy 'at' h:mm tt", Inv).Replace("AM", "am").Replace("PM", "pm") + " UTC",
            item.Owner.Name, Stamp(item.UpdatedAt), "Confidential — internal use only");

        var blocks = new List<PdfBlock>();
        var overview = await api.OverviewAsync(documentId, versionId, ct);
        var hasApi = overview.Definitions.Count > 0;

        // ---- document control: the facts and the approval record
        var review = await workflows.ReviewAsync(documentId, ct);
        var approved = review.History.Concat(review.Current is null ? [] : [review.Current]).Where(a => a.State is ApprovalState.Approved or ApprovalState.Published).OrderByDescending(a => a.ClosedAt).FirstOrDefault();
        blocks.Add(new PdfHeading(1, "Document control"));
        var facts = new List<(string, string)> { ("Type", item.TypeName), ("Status", item.Status.ToString()), ("Version", label), ("Owner", item.Owner.Name) };
        if (item.ProjectKey is not null) facts.Add(("Project", $"{item.ProjectKey} · {item.ProjectName}"));
        if (item.TeamName is not null) facts.Add(("Team", item.TeamName));
        facts.Add(("Last updated", item.UpdatedAt.ToString("yyyy-MM-dd HH:mm", Inv) + " UTC"));
        facts.Add(("Approval", approved is null ? "No approval recorded for this document." : $"Approved ({approved.WorkflowName}), submitted by {approved.SubmittedBy.Name} on {approved.SubmittedAt:yyyy-MM-dd}"));
        blocks.Add(new PdfFacts(facts));
        if (approved is not null)
        {
            var rows = approved.Steps.SelectMany(step => step.People.Where(p => p.Decision is not null).Select(p => (IReadOnlyList<string>)[step.Name, p.Name, p.Decision ?? "", p.At?.ToString("yyyy-MM-dd", Inv) ?? "", p.Comment ?? ""])).ToList();
            if (rows.Count > 0) blocks.Add(new PdfTable(["Step", "Person", "Decision", "Date", "Comment"], rows, BoldFirst: true));
        }

        // ---- the text of the document
        foreach (var s in sections.OrderBy(s => s.SortOrder))
        {
            if (s.Kind == SectionKind.Table)
            {
                var (cols, rows) = DocumentDiff.ReadTable(s.Content);
                if (rows.Count == 0) continue;   // a section nobody has written is left out of the printout
                blocks.Add(new PdfHeading(1, s.Title)); blocks.Add(new PdfTable(cols, rows.Select(r => (IReadOnlyList<string>)r).ToList(), BoldFirst: true));
            }
            else
            {
                if (DocumentDiff.TextLines(s.Content).Count == 0) continue;
                blocks.Add(new PdfHeading(1, s.Title)); AddText(blocks, s.Content);
            }
        }

        var reqs = await trace.ListAsync(documentId, ct);
        if (reqs.Count > 0)
        {
            blocks.Add(new PdfHeading(1, "Requirements"));
            blocks.Add(new PdfTable(["ID", "Requirement", "Priority", "Built by", "Verified by"], reqs.Select(r => (IReadOnlyList<string>)[r.Key, r.Title + (string.IsNullOrWhiteSpace(r.Detail) ? "" : " - " + r.Detail), r.Priority.ToString(), r.Implementing.ToString(Inv), r.Verifying.ToString(Inv)]).ToList(), BoldFirst: true));
        }

        if (hasApi) await AddApiAsync(blocks, documentId, versionId, overview, item.Owner.Name, item.TeamName, ct);

        var sec = await secrets.ListAsync(documentId, ct);
        if (sec.Items.Count > 0)
        {
            blocks.Add(new PdfHeading(1, "Secrets"));
            blocks.Add(new PdfPara($"{sec.Items.Count} secret(s) are stored with this document. Their values are never included in an export: {string.Join(", ", sec.Items.Select(i => i.Label))}.", true));
        }

        blocks.Add(new PdfHeading(1, "Revision history"));
        blocks.Add(new PdfTable(["Version", "Date", "By", "Summary"], vlist.Items.Where(v => !v.IsDraft).Select(v => (IReadOnlyList<string>)[v.Label, v.PublishedAt?.ToString("yyyy-MM-dd", Inv) ?? "", v.PublishedBy?.Name ?? "", (v.ChangeSummary ?? "") + (string.IsNullOrWhiteSpace(v.ChangeReason) ? "" : " (" + v.ChangeReason + ")")]).ToList(), BoldFirst: true));

        return new PdfDocModel(brand, item.Title, item.Key, label, blocks);
    }

    private static void AddText(List<PdfBlock> blocks, string json)
    {
        var rows = new List<IReadOnlyList<string>>();
        void FlushRows() { if (rows.Count > 0) { blocks.Add(new PdfTable([], rows.ToList())); rows.Clear(); } }
        foreach (var line in DocumentDiff.TextLines(json))
        {
            if (line.Style != "row") FlushRows();
            switch (line.Style)
            {
                case "h": blocks.Add(new PdfHeading(2, line.Text)); break;
                case "li": blocks.Add(new PdfItem(line.Text)); break;
                case "quote": blocks.Add(new PdfQuote(line.Text)); break;
                case "code" when DiagramEngine.IsDiagramLanguage(line.Lang):
                    try { blocks.Add(new PdfDiagram(DiagramEngine.Draw(line.Text))); }
                    catch (DiagramException e) { blocks.Add(new PdfPara($"This diagram could not be drawn: {e.Message}{(e.Line > 0 ? $" (line {e.Line})" : "")}", true)); blocks.Add(new PdfCode(line.Text.Split('\n'))); }
                    break;
                case "code": blocks.Add(new PdfCode(line.Text.Split('\n'))); break;
                case "row": rows.Add(line.Text.Split(" | ")); break;
                default: blocks.Add(new PdfPara(line.Text)); break;
            }
        }
        FlushRows();
    }

    private async Task AddApiAsync(List<PdfBlock> blocks, Guid documentId, Guid? versionId, ApiOverviewDto overview, string owner, string? team, CancellationToken ct)
    {
        var left = MaxEndpoints;
        foreach (var def in overview.Definitions)
        {
            blocks.Add(new PdfBreak());
            blocks.Add(new PdfTitle(def.Name, "API REFERENCE"));
            if (!string.IsNullOrWhiteSpace(def.Description)) blocks.Add(new PdfPara(def.Description!));
            var all = new List<EndpointItemDto>();
            string? cursor = null;
            do
            {
                var page = await api.ListAsync(documentId, new EndpointFilter(DefinitionId: def.Id, VersionId: versionId), cursor, 200, ct);
                all.AddRange(page.Items); cursor = page.NextCursor;
            } while (cursor is not null && all.Count < left);
            var shown = all.Take(left).ToList(); left -= shown.Count;
            var tags = shown.Select(e => e.Tag).Where(t => !string.IsNullOrWhiteSpace(t)).Distinct().Count();
            blocks.Add(new PdfStats([(def.Endpoints.ToString(Inv), "Endpoints"), (tags.ToString(Inv), tags == 1 ? "Tag" : "Tags")]));

            var facts = new List<(string, string)>();
            if (!string.IsNullOrWhiteSpace(def.Version)) facts.Add(("Version", def.Version!));
            if (!string.IsNullOrWhiteSpace(def.BasePath)) facts.Add(("Base path", def.BasePath!));
            facts.Add(("Authentication", def.Auth.ToString()));
            if (def.Servers.Count > 0) facts.Add(("Servers", string.Join(", ", def.Servers.Select(MaskHost))));
            blocks.Add(new PdfFacts(facts));
            if (!string.IsNullOrWhiteSpace(def.AuthNote)) blocks.Add(new PdfCard($"{def.Auth} authentication", def.AuthNote!));

            blocks.Add(new PdfLabel("Lifecycle"));
            blocks.Add(new PdfLifecycle(StageNames, (int)def.Stage, owner, team));

            // history: when each endpoint was added and last changed, and by whom
            var stamps = await EndpointStampsAsync(documentId, shown.Select(e => e.Id).ToList(), ct);
            if (shown.Count > 0)
            {
                blocks.Add(new PdfLabel("Endpoints", "added and last modified"));
                blocks.Add(new PdfTable(["Endpoint", "Added", "Last modified"], shown.Select(e =>
                {
                    var s = stamps.GetValueOrDefault(e.Id);
                    return (IReadOnlyList<string>)[$"{e.Method} {e.Path}", s is null ? "" : $"{Stamp(s.Added)}{(s.AddedBy is null ? "" : " by " + s.AddedBy)}", s is null ? "" : $"{Stamp(s.Modified)}{(s.ModifiedBy is null ? "" : " by " + s.ModifiedBy)}"];
                }).ToList(), MethodColumn: 0));

                blocks.Add(new PdfLabel("Contents"));
                foreach (var group in shown.GroupBy(e => string.IsNullOrWhiteSpace(e.Tag) ? "Other" : e.Tag!))
                {
                    blocks.Add(new PdfLead(group.Key));
                    foreach (var e in group) blocks.Add(new PdfMethodRow(e.Method, e.Path));
                }
            }

            var n = 0;
            foreach (var ep in shown)
            {
                var full = await api.GetAsync(documentId, ep.Id, versionId, ct);
                blocks.Add(new PdfBreak());
                AddEndpoint(blocks, ++n, def, full);
            }
            if (all.Count > shown.Count || def.Endpoints > shown.Count) blocks.Add(new PdfPara($"Only the first {MaxEndpoints:N0} endpoints are printed. The API reference tab has all of them.", true));
        }
    }

    private sealed record Stamps(DateTime Added, string? AddedBy, DateTime Modified, string? ModifiedBy);

    private async Task<Dictionary<Guid, Stamps>> EndpointStampsAsync(Guid documentId, List<Guid> ids, CancellationToken ct)
    {
        var result = new Dictionary<Guid, Stamps>();
        foreach (var chunk in ids.Chunk(500))
        {
            var rows = await db.ApiEndpoints.AsNoTracking().Where(e => e.DocumentId == documentId && chunk.Contains(e.Id)).Select(e => new { e.Id, e.CreatedAt, e.CreatedBy, e.UpdatedAt, e.UpdatedBy }).ToListAsync(ct);
            var people = rows.SelectMany(r => new[] { r.CreatedBy, r.UpdatedBy }).Where(x => x != null).Select(x => x!.Value).Distinct().ToList();
            var names = people.Count == 0 ? [] : await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
            foreach (var r in rows) result[r.Id] = new Stamps(r.CreatedAt, r.CreatedBy is { } c ? names.GetValueOrDefault(c) : null, r.UpdatedAt ?? r.CreatedAt, r.UpdatedBy is { } u ? names.GetValueOrDefault(u) : null);
        }
        return result;
    }

    public static string MaskHost(string server) => System.Text.RegularExpressions.Regex.Replace(server, @"^(https?://)([^/]+)(/.*)?$", m => m.Groups[1].Value + "••••••••" + (m.Groups[3].Success ? "/••••" : ""));

    private static string Fmt(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return "";
        try { return System.Text.Json.JsonSerializer.Serialize(System.Text.Json.JsonDocument.Parse(json).RootElement, new System.Text.Json.JsonSerializerOptions { WriteIndented = true }); }
        catch (System.Text.Json.JsonException) { return json!; }
    }

    private static void AddEndpoint(List<PdfBlock> blocks, int number, DefinitionDto def, EndpointDto e)
    {
        var i = e.Item; var x = e.Details;
        blocks.Add(new PdfBanner(number.ToString("00", Inv), i.Method, i.Path, def.Version));
        if (!string.IsNullOrWhiteSpace(i.Summary)) blocks.Add(new PdfLead(i.Summary));
        if (!string.IsNullOrWhiteSpace(x.Description)) blocks.Add(new PdfPara(x.Description!));
        var chips = new List<string>();
        if (!string.IsNullOrWhiteSpace(i.Tag)) chips.Add(i.Tag!);
        if (!string.IsNullOrWhiteSpace(x.RequestBody?.ContentType)) chips.Add(x.RequestBody!.ContentType!);
        if (i.Deprecated) chips.Add("Deprecated");
        chips.Add(def.Stage.ToString() switch { "PreProd" => "Pre-prod", var s => s });
        if (chips.Count > 0) blocks.Add(new PdfChips(chips));

        if (!string.IsNullOrWhiteSpace(x.Flow))
        {
            try { var m = DiagramEngine.Draw(x.Flow!); blocks.Add(new PdfLabel("Request flow")); blocks.Add(new PdfDiagram(m)); }
            catch (DiagramException) { /* a flow that no longer draws is left out; the editor refuses to save one */ }
        }

        // the request, as a curl command with the host and credentials masked
        var headers = x.Parameters.Where(p => p.In == "header").ToList();
        var curl = new List<string> { $"curl --location --request {i.Method} \"{MaskHost((def.Servers.FirstOrDefault() ?? "https://host") + (def.BasePath ?? "") + i.Path)}\" \\" };
        if (!string.IsNullOrWhiteSpace(x.RequestBody?.ContentType) && !headers.Any(h => h.Name.Equals("Content-Type", StringComparison.OrdinalIgnoreCase))) curl.Add($"  --header \"Content-Type: {x.RequestBody!.ContentType}\" \\");
        foreach (var h in headers) curl.Add($"  --header \"{h.Name}: {Mask(h.Name, h.Example ?? "<" + h.Name.ToLowerInvariant() + ">")}\" \\");
        if (!string.IsNullOrWhiteSpace(x.RequestBody?.Example))
        {
            var body = Fmt(x.RequestBody!.Example).Split('\n');
            curl.Add("  --data-raw '" + body[0]); curl.AddRange(body.Skip(1)); curl[^1] += "'";
        }
        else curl[^1] = curl[^1].TrimEnd(' ', '\\');
        blocks.Add(new PdfPanel("Request", "host and credentials are masked", curl));

        void ParamTable(string title, List<ApiParam> list)
        {
            if (list.Count == 0) return;
            blocks.Add(new PdfLabel(title));
            blocks.Add(new PdfTable(["Name", "Type", "Example", "Description"], list.Select(p => (IReadOnlyList<string>)[p.Name + (p.Required ? " *" : ""), p.Type ?? "String", Mask(p.Name, p.Example), p.Description ?? ""]).ToList(), BoldFirst: true));
        }
        ParamTable("Headers", headers);
        ParamTable("Path parameters", x.Parameters.Where(p => p.In == "path").ToList());
        ParamTable("Query parameters", x.Parameters.Where(p => p.In == "query").ToList());
        ParamTable("Cookies", x.Parameters.Where(p => p.In == "cookie").ToList());

        if (x.RequestBody is { } b)
        {
            if (!string.IsNullOrWhiteSpace(b.Description)) blocks.Add(new PdfPara(b.Description!));
            var fields = SchemaRows(b.Schema, b.Example);
            if (fields.Count > 0) { blocks.Add(new PdfLabel("Request fields")); blocks.Add(new PdfTable(["Name", "Type", "Example", "Description"], fields, BoldFirst: true)); }
            if (!string.IsNullOrWhiteSpace(b.Example)) blocks.Add(new PdfPanel("Example request body", null, Fmt(b.Example).Split('\n')));
            else if (!string.IsNullOrWhiteSpace(b.Schema) && fields.Count == 0) blocks.Add(new PdfPanel("Request schema", null, Fmt(b.Schema).Split('\n')));
        }

        if (x.Responses.Count > 0)
        {
            blocks.Add(new PdfLabel("Responses"));
            foreach (var r in x.Responses)
            {
                blocks.Add(new PdfStatus(r.Status, r.Description ?? ""));
                var fields = SchemaRows(r.Schema, r.Example);
                if (fields.Count > 0) { blocks.Add(new PdfLabel("Response fields")); blocks.Add(new PdfTable(["Name", "Type", "Example", "Description"], fields, BoldFirst: true)); }
                else if (!string.IsNullOrWhiteSpace(r.Schema)) blocks.Add(new PdfPanel("Response schema", $"status {r.Status}", Fmt(r.Schema).Split('\n')));
                if (!string.IsNullOrWhiteSpace(r.Example)) blocks.Add(new PdfPanel("Example response", $"status {r.Status}", Fmt(r.Example).Split('\n')));
            }
        }
        if (x.Errors.Count > 0)
        {
            blocks.Add(new PdfLabel("Errors"));
            blocks.Add(new PdfTable(["Code", "Message", "What the caller should do"], x.Errors.Select(r => (IReadOnlyList<string>)[r.Code, r.Message ?? "", r.Description ?? ""]).ToList(), BoldFirst: true));
        }
        foreach (var s in x.Samples) blocks.Add(new PdfPanel($"Sample: {s.Title}", s.Language, s.Code.Split('\n')));
        if (x.Dependencies.Count > 0)
        {
            blocks.Add(new PdfLabel("Depends on"));
            blocks.Add(new PdfTable(["Name", "Note"], x.Dependencies.Select(dp => (IReadOnlyList<string>)[dp.Name, dp.Note ?? ""]).ToList(), BoldFirst: true));
        }
    }

    /// <summary>The fields a JSON schema describes, one row each (Name *, Type, Example, Description); nested objects and arrays are flattened as a.b and a[].b.</summary>
    public static List<IReadOnlyList<string>> SchemaRows(string? schema, string? example)
    {
        var rows = new List<IReadOnlyList<string>>();
        if (string.IsNullOrWhiteSpace(schema)) return rows;
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(schema);
            System.Text.Json.JsonElement? ex = null; System.Text.Json.JsonDocument? exDoc = null;
            if (!string.IsNullOrWhiteSpace(example)) { try { exDoc = System.Text.Json.JsonDocument.Parse(example); ex = exDoc.RootElement; } catch (System.Text.Json.JsonException) { } }
            void Walk(System.Text.Json.JsonElement node, System.Text.Json.JsonElement? sample, string prefix, int depth)
            {
                if (depth > 3 || node.ValueKind != System.Text.Json.JsonValueKind.Object) return;
                if (node.TryGetProperty("type", out var t0) && t0.ValueKind == System.Text.Json.JsonValueKind.String && t0.GetString() == "array" && node.TryGetProperty("items", out var items)) { Walk(items, sample is { ValueKind: System.Text.Json.JsonValueKind.Array } sa && sa.GetArrayLength() > 0 ? sa[0] : null, prefix + "[]", depth + 1); return; }
                if (!node.TryGetProperty("properties", out var props) || props.ValueKind != System.Text.Json.JsonValueKind.Object) return;
                var required = node.TryGetProperty("required", out var req) && req.ValueKind == System.Text.Json.JsonValueKind.Array ? req.EnumerateArray().Select(r => r.GetString()).ToHashSet() : [];
                foreach (var p in props.EnumerateObject())
                {
                    var name = prefix.Length == 0 ? p.Name : prefix + "." + p.Name;
                    var type = p.Value.TryGetProperty("type", out var t) && t.ValueKind == System.Text.Json.JsonValueKind.String ? t.GetString()! : "object";
                    var shown = type switch { "integer" or "number" => "Number", "string" => "String", "boolean" => "Boolean", "array" => "Array", _ => "Object" };
                    System.Text.Json.JsonElement? sv = sample is { ValueKind: System.Text.Json.JsonValueKind.Object } so && so.TryGetProperty(p.Name, out var got) ? got : null;
                    string exampleText = "";
                    if (p.Value.TryGetProperty("example", out var pe)) exampleText = pe.ToString();
                    else if (sv is { } s && s.ValueKind is not (System.Text.Json.JsonValueKind.Object or System.Text.Json.JsonValueKind.Array)) exampleText = s.ToString();
                    else if (sv is { ValueKind: System.Text.Json.JsonValueKind.Array } sa2 && sa2.GetArrayLength() == 0) exampleText = "[]";
                    var desc = p.Value.TryGetProperty("description", out var dsc) ? dsc.GetString() ?? "" : "";
                    rows.Add([name + (required.Contains(p.Name) ? " *" : ""), shown, Mask(p.Name, exampleText), desc]);
                    if (type is "object" or "array") Walk(p.Value, sv, name, depth + 1);
                    if (rows.Count > 300) return;
                }
            }
            Walk(doc.RootElement, ex, "", 0);
            exDoc?.Dispose();
        }
        catch (System.Text.Json.JsonException) { }
        return rows;
    }
}

public class DocumentExportService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, EntitlementService entitlements, DocumentService documents, DocumentVersionService versions, ReportExportService reportExports)
{
    private const int MaxPending = 3;

    /// <summary>Status of one of my PDFs of this document. Reachable by anyone who may open the document, whether or not their role has the Reports module.</summary>
    public async Task<ReportExportDto> GetAsync(Guid documentId, Guid exportId, CancellationToken ct = default)
    {
        await documents.GetAsync(documentId, ct);
        var dto = await reportExports.GetAsync(exportId, ct);
        if (dto.Kind != ReportKind.Document || !await db.ReportExports.AnyAsync(e => e.Id == exportId && e.DocumentId == documentId, ct)) throw new NotFoundException("Report not found.");
        return dto;
    }

    public async Task<(Stream Content, string FileName, string ContentType)> OpenAsync(Guid documentId, Guid exportId, CancellationToken ct = default)
    {
        await GetAsync(documentId, exportId, ct);
        return await reportExports.OpenAsync(exportId, ct);
    }

    public async Task<ReportExportDto> RequestAsync(Guid documentId, Guid? versionId, CancellationToken ct = default)
    {
        await entitlements.EnsureFeatureAsync(FeatureKeys.AdvancedReports, ct);
        var tid = ctx.RequireTenantId(); var uid = ctx.RequireUserId();
        var d = await documents.GetAsync(documentId, ct);   // not found for anyone who may not open it
        if (versionId is { } v) await versions.GetAsync(documentId, v, ct);
        var pending = await db.ReportExports.CountAsync(e => e.UserId == uid && (e.Status == ReportExportStatus.Queued || e.Status == ReportExportStatus.Running), ct);
        if (pending >= MaxPending) throw new ConflictException("You already have reports being prepared. Wait for one to finish.", "TOO_MANY_PENDING");
        var export = new ReportExport { TenantId = tid, UserId = uid, Kind = ReportKind.Document, Format = ReportFormat.Pdf, DocumentId = documentId, VersionId = versionId, CreatedAt = clock.Now, CreatedBy = uid };
        db.ReportExports.Add(export);
        recorder.Audit("document.export_requested", "Document", documentId, null, new { format = "pdf", versionId, d.Item.Key });
        await db.SaveChangesAsync(ct);
        return new ReportExportDto(export.Id, export.Kind, export.Format, export.Status, export.ProjectId, export.TargetUserId, export.Days, export.FileName, export.SizeBytes, export.Error, export.CreatedAt, export.CompletedAt, export.ExpiresAt);
    }
}

/// <summary>Builds and stores one document PDF inside the report queue. At most two are laid out at the same time on an instance, so a burst of exports cannot starve the web requests.</summary>
public class DocumentPdfJob(DocumentPdfBuilder builder, IDocumentPdfRenderer renderer, DocumentService documents)
{
    private static readonly SemaphoreSlim Slots = new(2, 2);

    public async Task<string> RunAsync(ReportExport export, string organization, IFileStorage storage, CancellationToken ct)
    {
        var docId = export.DocumentId ?? throw new NotFoundException("Document not found.");
        var d = await documents.GetAsync(docId, ct);
        var model = await builder.BuildAsync(docId, export.VersionId, organization, ct);
        byte[] file; int pages;
        await Slots.WaitAsync(ct);
        try
        {
            try { (file, pages) = await Task.Run(() => renderer.Render(model), ct); }
            catch (PdfTooLongException e) { throw new ConflictException(e.Message, "DOCUMENT_TOO_LONG"); }
        }
        finally { Slots.Release(); }
        var key = $"{export.TenantId:N}/exports/{export.Id:N}.pdf";
        using var ms = new MemoryStream(file);
        await storage.SaveAsync(key, ms, ct);
        var label = model.Version.Replace(' ', '-');
        export.FileName = $"{d.Item.Key}-{label}-{DateTime.UtcNow:yyyyMMdd}.pdf".Replace('/', '-');
        export.SizeBytes = file.Length;
        export.Days = pages;   // for a document PDF the field carries the page count
        return key;
    }
}