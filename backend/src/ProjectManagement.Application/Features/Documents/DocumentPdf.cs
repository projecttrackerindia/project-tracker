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

public class DocumentPdfBuilder(DocumentService documents, DocumentVersionService versions, DocumentWorkflowService workflows, DocumentTraceService trace, ApiDocService api,
    SecretService secrets, IAppDbContext db, ICurrentContext ctx, AppClock clock)
{
    public const int MaxEndpoints = 1000;
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

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
        var review = await workflows.ReviewAsync(documentId, ct);
        var approved = review.History.Concat(review.Current is null ? [] : [review.Current]).Where(a => a.State is ApprovalState.Approved or ApprovalState.Published).OrderByDescending(a => a.ClosedAt).FirstOrDefault();

        var cover = new List<(string, string)> { ("Type", item.TypeName), ("Status", item.Status.ToString()), ("Version", label), ("Owner", item.Owner.Name) };
        if (item.ProjectKey is not null) cover.Add(("Project", $"{item.ProjectKey} · {item.ProjectName}"));
        if (item.TeamName is not null) cover.Add(("Team", item.TeamName));
        cover.Add(("Last updated", item.UpdatedAt.ToString("yyyy-MM-dd HH:mm", Inv) + " UTC"));
        cover.Add(("Printed", clock.Now.ToString("yyyy-MM-dd HH:mm", Inv) + " UTC"));
        cover.Add(("Approval", approved is null ? "No approval recorded for this document." : $"Approved ({approved.WorkflowName}), submitted by {approved.SubmittedBy.Name} on {approved.SubmittedAt:yyyy-MM-dd}"));
        if (approved is not null)
            foreach (var step in approved.Steps)
                foreach (var p in step.People.Where(p => p.Decision is not null))
                    cover.Add((step.Name, $"{p.Name}: {p.Decision}{(p.At is { } at ? " on " + at.ToString("yyyy-MM-dd", Inv) : "")}{(string.IsNullOrWhiteSpace(p.Comment) ? "" : " - " + p.Comment)}"));

        var blocks = new List<PdfBlock>();
        foreach (var s in sections.OrderBy(s => s.SortOrder))
        {
            blocks.Add(new PdfHeading(1, s.Title));
            if (s.Kind == SectionKind.Table) { var (cols, rows) = DocumentDiff.ReadTable(s.Content); blocks.Add(new PdfTable(cols, rows.Select(r => (IReadOnlyList<string>)r).ToList())); }
            else AddText(blocks, s.Content);
        }

        var reqs = await trace.ListAsync(documentId, ct);
        if (reqs.Count > 0)
        {
            blocks.Add(new PdfHeading(1, "Requirements"));
            blocks.Add(new PdfTable(["ID", "Requirement", "Priority", "Built by", "Verified by"], reqs.Select(r => (IReadOnlyList<string>)[r.Key, r.Title + (string.IsNullOrWhiteSpace(r.Detail) ? "" : " - " + r.Detail), r.Priority.ToString(), r.Implementing.ToString(Inv), r.Verifying.ToString(Inv)]).ToList()));
        }

        await AddApiAsync(blocks, documentId, versionId, ct);

        var sec = await secrets.ListAsync(documentId, ct);
        if (sec.Items.Count > 0)
        {
            blocks.Add(new PdfHeading(1, "Secrets"));
            blocks.Add(new PdfPara($"{sec.Items.Count} secret(s) are stored with this document. Their values are never included in an export: {string.Join(", ", sec.Items.Select(i => i.Label))}.", true));
        }

        blocks.Add(new PdfHeading(1, "Revision history"));
        blocks.Add(new PdfTable(["Version", "Date", "By", "Summary"], vlist.Items.Where(v => !v.IsDraft).Select(v => (IReadOnlyList<string>)[v.Label, v.PublishedAt?.ToString("yyyy-MM-dd", Inv) ?? "", v.PublishedBy?.Name ?? "", (v.ChangeSummary ?? "") + (string.IsNullOrWhiteSpace(v.ChangeReason) ? "" : " (" + v.ChangeReason + ")")]).ToList()));

        return new PdfDocModel(organization, item.Title, item.Key, label, cover, blocks, $"{item.Key} · {item.Title} · {label}");
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

    private async Task AddApiAsync(List<PdfBlock> blocks, Guid documentId, Guid? versionId, CancellationToken ct)
    {
        var overview = await api.OverviewAsync(documentId, versionId, ct);
        if (overview.Definitions.Count == 0) return;
        var left = MaxEndpoints;
        foreach (var def in overview.Definitions)
        {
            blocks.Add(new PdfHeading(1, $"API: {def.Name}"));
            var facts = new List<(string, string)>();
            if (!string.IsNullOrWhiteSpace(def.Version)) facts.Add(("Version", def.Version!));
            if (!string.IsNullOrWhiteSpace(def.BasePath)) facts.Add(("Base path", def.BasePath!));
            facts.Add(("Authentication", def.Auth + (string.IsNullOrWhiteSpace(def.AuthNote) ? "" : " - " + def.AuthNote)));
            if (def.Servers.Count > 0) facts.Add(("Servers", string.Join(", ", def.Servers)));
            facts.Add(("Endpoints", def.Endpoints.ToString(Inv)));
            blocks.Add(new PdfFacts(facts));
            if (!string.IsNullOrWhiteSpace(def.Description)) blocks.Add(new PdfPara(def.Description!));

            string? cursor = null;
            do
            {
                var page = await api.ListAsync(documentId, new EndpointFilter(DefinitionId: def.Id, VersionId: versionId), cursor, 200, ct);
                foreach (var ep in page.Items)
                {
                    if (left-- <= 0) { blocks.Add(new PdfPara($"Only the first {MaxEndpoints:N0} endpoints are printed. The API reference tab has all of them.", true)); return; }
                    var full = await api.GetAsync(documentId, ep.Id, versionId, ct);
                    AddEndpoint(blocks, full);
                }
                cursor = page.NextCursor;
            } while (cursor is not null);
        }
    }

    private static void AddEndpoint(List<PdfBlock> blocks, EndpointDto e)
    {
        var i = e.Item; var x = e.Details;
        blocks.Add(new PdfHeading(3, $"{i.Method} {i.Path}{(i.Deprecated ? " (deprecated)" : "")}"));
        if (!string.IsNullOrWhiteSpace(i.Summary)) blocks.Add(new PdfPara(i.Summary, false));
        if (!string.IsNullOrWhiteSpace(x.Description)) blocks.Add(new PdfPara(x.Description!));
        if (x.Parameters.Count > 0) blocks.Add(new PdfTable(["Parameter", "In", "Required", "Type", "Description"], x.Parameters.Select(p => (IReadOnlyList<string>)[p.Name, p.In, p.Required ? "yes" : "no", p.Type ?? "", p.Description ?? ""]).ToList()));
        if (x.RequestBody is { } b)
        {
            blocks.Add(new PdfPara($"Request body{(string.IsNullOrWhiteSpace(b.ContentType) ? "" : " (" + b.ContentType + ")")}{(b.Required ? ", required" : "")}. {b.Description}".Trim()));
            if (!string.IsNullOrWhiteSpace(b.Schema)) blocks.Add(new PdfCode(b.Schema!.Split('\n')));
            if (!string.IsNullOrWhiteSpace(b.Example)) blocks.Add(new PdfCode(b.Example!.Split('\n')));
        }
        if (x.Responses.Count > 0)
        {
            blocks.Add(new PdfTable(["Status", "Description", "Type"], x.Responses.Select(r => (IReadOnlyList<string>)[r.Status, r.Description ?? "", r.ContentType ?? ""]).ToList()));
            foreach (var r in x.Responses.Where(r => !string.IsNullOrWhiteSpace(r.Schema))) { blocks.Add(new PdfPara($"Response {r.Status} schema", true)); blocks.Add(new PdfCode(r.Schema!.Split('\n'))); }
        }
        if (x.Errors.Count > 0) blocks.Add(new PdfTable(["Error", "Message", "Description"], x.Errors.Select(r => (IReadOnlyList<string>)[r.Code, r.Message ?? "", r.Description ?? ""]).ToList()));
        foreach (var s in x.Samples) { blocks.Add(new PdfPara($"Sample: {s.Title} ({s.Language})", true)); blocks.Add(new PdfCode(s.Code.Split('\n'))); }
        if (x.Dependencies.Count > 0) blocks.Add(new PdfPara("Depends on: " + string.Join("; ", x.Dependencies.Select(dp => dp.Name + (string.IsNullOrWhiteSpace(dp.Note) ? "" : " (" + dp.Note + ")"))), true));
    }
}

/// <summary>Asking for a PDF of a document. The file is built later by the report queue; the person is notified and has the link for seven days.</summary>
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