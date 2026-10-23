using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Documents;

public record DocumentProposalDto(Guid Id, Guid? ProjectId, string? ProjectKey, string Kind, string SourceType, Guid? SourceId, string Title, string Summary, string Body,
    Guid? TargetDocumentId, string? TargetTitle, string Status, DateTime CreatedAt, Guid? ResultDocumentId, string Action);
/// <param name="Kind">decision-log (from a meeting), release-notes (from a sprint) or api-reference (from an API document).</param>
public record GenerateProposalRequest(string Kind, Guid? ProjectId = null, Guid? SourceId = null);
public record AcceptProposalDto(Guid DocumentId, string Message);

/// <summary>
/// Docs that write themselves: a meeting's decisions become an entry in the project's decision log, a finished sprint becomes release notes,
/// and an API that changed becomes an up-to-date API reference. Each is a draft waiting for a person: nothing is written to a page until
/// someone with the right to edit it accepts. Drafts are made when those things happen, or on demand.
/// </summary>
public class DocumentProposalService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, DocumentService documents, DocumentAccessService rights,
    ProjectManagement.Application.Features.Notifications.NotificationService notifications, ILogger<DocumentProposalService> log)
{
    public static readonly string[] Kinds = ["decision-log", "release-notes", "api-reference"];
    private const string DecisionLogTitle = "Decision log";

    private static JsonObject Text(string s, string? mark = null)
    {
        var o = new JsonObject { ["type"] = "text", ["text"] = s };
        if (mark is not null) o["marks"] = new JsonArray(new JsonObject { ["type"] = mark });
        return o;
    }
    private static JsonObject Para(params JsonNode[] parts) => parts.Length == 0 ? new JsonObject { ["type"] = "paragraph" } : new JsonObject { ["type"] = "paragraph", ["content"] = new JsonArray(parts) };
    private static JsonObject Heading(int level, string text) => new() { ["type"] = "heading", ["attrs"] = new JsonObject { ["level"] = level }, ["content"] = new JsonArray(Text(text)) };
    private static JsonObject Bullets(IEnumerable<JsonNode[]> items) => new()
    {
        ["type"] = "bulletList",
        ["content"] = new JsonArray(items.Select(i => (JsonNode)new JsonObject { ["type"] = "listItem", ["content"] = new JsonArray(Para(i)) }).ToArray()),
    };
    private static JsonObject Todos(IEnumerable<(string Text, bool Done)> items) => new()
    {
        ["type"] = "taskList",
        ["content"] = new JsonArray(items.Select(i => (JsonNode)new JsonObject { ["type"] = "taskItem", ["attrs"] = new JsonObject { ["checked"] = i.Done }, ["content"] = new JsonArray(Para(Text(i.Text))) }).ToArray()),
    };
    private static string Doc(JsonArray blocks) => new JsonObject { ["type"] = "doc", ["content"] = blocks }.ToJsonString();

    public async Task<IReadOnlyList<DocumentProposalDto>> ListAsync(Guid? projectId, string? status, CancellationToken ct = default)
    {
        var st = string.IsNullOrWhiteSpace(status) ? "Proposed" : status.Trim();
        var q = db.DocumentProposals.AsNoTracking().Where(p => st == "all" || p.Status == st);
        if (projectId is { } pid) q = q.Where(p => p.ProjectId == pid);
        // Only drafts for projects the person can see (or none).
        var visible = db.Projects.Select(p => p.Id);
        q = q.Where(p => p.ProjectId == null || visible.Contains(p.ProjectId.Value));
        var rows = await q.OrderByDescending(p => p.CreatedAt).Take(100).ToListAsync(ct);
        return await ToDtosAsync(rows, ct);
    }

    private async Task<List<DocumentProposalDto>> ToDtosAsync(List<DocumentProposal> rows, CancellationToken ct)
    {
        var pids = rows.Where(r => r.ProjectId != null).Select(r => r.ProjectId!.Value).Distinct().ToList();
        var keys = await db.Projects.AsNoTracking().Where(p => pids.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => p.Key, ct);
        var tids = rows.Where(r => r.TargetDocumentId != null).Select(r => r.TargetDocumentId!.Value).Distinct().ToList();
        var targets = await db.Documents.AsNoTracking().Where(d => tids.Contains(d.Id)).ToDictionaryAsync(d => d.Id, d => d.Title, ct);
        return rows.Select(r => new DocumentProposalDto(r.Id, r.ProjectId, r.ProjectId is { } p ? keys.GetValueOrDefault(p) : null, r.Kind, r.SourceType, r.SourceId, r.Title, r.Summary, r.Body,
            r.TargetDocumentId is { } t && targets.ContainsKey(t) ? t : null, r.TargetDocumentId is { } t2 ? targets.GetValueOrDefault(t2) : null, r.Status, r.CreatedAt, r.ResultDocumentId,
            r.TargetDocumentId is { } t3 && targets.ContainsKey(t3) ? (r.Kind == "api-reference" ? "replace" : "add") : "create")).ToList();
    }

    /// <summary>Makes (or refreshes) the draft for one meeting, sprint or API document now.</summary>
    public async Task<DocumentProposalDto> GenerateAsync(GenerateProposalRequest req, CancellationToken ct = default)
    {
        var kind = (req.Kind ?? "").Trim().ToLowerInvariant();
        var row = kind switch
        {
            "decision-log" => await DecisionLogAsync(req.SourceId ?? await LatestMeetingAsync(req.ProjectId, ct), ct),
            "release-notes" => await ReleaseNotesAsync(req.SourceId ?? await LatestSprintAsync(req.ProjectId, ct), ct),
            "api-reference" => await ApiReferenceAsync(req.SourceId ?? throw new ValidationException("sourceId", "Choose the API document."), ct),
            _ => throw new ValidationException("kind", "Make a decision log, release notes or an API reference."),
        };
        await db.SaveChangesAsync(ct);
        return (await ToDtosAsync([row], ct))[0];
    }

    private async Task<Guid> LatestMeetingAsync(Guid? projectId, CancellationToken ct)
    {
        if (projectId is not { } pid) throw new ValidationException("projectId", "Choose the project.");
        var runs = db.AgentRuns.AsNoTracking().Where(r => r.ProjectId == pid && r.MeetingId != null && r.Status == "done");
        return await runs.Where(r => db.AgentFindings.Any(f => f.RunId == r.Id && f.Kind == AgentFindingKind.Decision && f.Status != AgentFindingStatus.Dismissed))
            .OrderByDescending(r => r.StartedAt).Select(r => r.MeetingId!.Value).FirstOrDefaultAsync(ct) is { } m && m != Guid.Empty
            ? m : throw new ConflictException("No meeting of this project has decisions yet.", "NOTHING_NEW");
    }

    private async Task<Guid> LatestSprintAsync(Guid? projectId, CancellationToken ct)
    {
        if (projectId is not { } pid) throw new ValidationException("projectId", "Choose the project.");
        return await db.Sprints.AsNoTracking().Where(s => s.ProjectId == pid && s.Status == SprintStatus.Completed).OrderByDescending(s => s.CompletedAt)
            .Select(s => s.Id).FirstOrDefaultAsync(ct) is { } s2 && s2 != Guid.Empty ? s2 : throw new ConflictException("No sprint of this project is finished yet.", "NOTHING_NEW");
    }

    private async Task<DocumentProposal> UpsertAsync(string kind, string sourceType, Guid sourceId, Guid? projectId, string title, string summary, string body, Guid? target, CancellationToken ct)
    {
        var row = await db.DocumentProposals.FirstOrDefaultAsync(p => p.Kind == kind && p.SourceType == sourceType && p.SourceId == sourceId, ct);
        if (row is null)
        {
            row = new DocumentProposal { TenantId = ctx.RequireTenantId(), Kind = kind, SourceType = sourceType, SourceId = sourceId, CreatedAt = clock.Now, CreatedBy = ctx.UserId };
            db.DocumentProposals.Add(row);
        }
        else if (row.Status != "Proposed") { row.Status = "Proposed"; row.DecidedAt = null; row.DecidedBy = null; row.ResultDocumentId = null; row.CreatedAt = clock.Now; }
        row.ProjectId = projectId; row.Title = title.Length > 200 ? title[..200] : title; row.Summary = summary.Length > 500 ? summary[..500] : summary;
        row.Body = body; row.TargetDocumentId = target; row.UpdatedAt = clock.Now;
        return row;
    }

    private async Task<Guid?> PageNamedAsync(Guid? projectId, string title, CancellationToken ct)
    {
        var pageType = await db.DocumentTypes.AsNoTracking().Where(t => t.Code == DocumentTemplates.PageCode).Select(t => t.Id).FirstOrDefaultAsync(ct);
        return await db.Documents.AsNoTracking().Where(d => d.ProjectId == projectId && d.TypeId == pageType && d.Title == title && d.Status != DocumentStatus.Archived)
            .OrderBy(d => d.CreatedAt).Select(d => (Guid?)d.Id).FirstOrDefaultAsync(ct);
    }

    private async Task<DocumentProposal> DecisionLogAsync(Guid meetingId, CancellationToken ct)
    {
        var meeting = await db.ProjectMeetings.AsNoTracking().FirstOrDefaultAsync(m => m.Id == meetingId, ct) ?? throw new NotFoundException("Meeting not found.");
        if (!await db.Projects.AnyAsync(p => p.Id == meeting.ProjectId, ct)) throw new NotFoundException("Meeting not found.");
        var runIds = db.AgentRuns.AsNoTracking().Where(r => r.MeetingId == meetingId).Select(r => r.Id);
        var findings = await db.AgentFindings.AsNoTracking().Where(f => runIds.Contains(f.RunId) && f.Status != AgentFindingStatus.Dismissed)
            .OrderBy(f => f.CreatedAt).Select(f => new { f.Kind, f.Title, f.Detail, f.DueDate, Who = f.AssigneeId }).ToListAsync(ct);
        var decisions = findings.Where(f => f.Kind == AgentFindingKind.Decision).ToList();
        if (decisions.Count == 0) throw new ConflictException("This meeting has no decisions to record.", "NOTHING_NEW");
        var actions = findings.Where(f => f.Kind is AgentFindingKind.CreateTask or AgentFindingKind.CreateActionItem).ToList();
        var whoIds = actions.Where(a => a.Who != null).Select(a => a.Who!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => whoIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var blocks = new JsonArray { Heading(2, $"{meeting.StartTimeUtc:d MMM yyyy} · {meeting.Title}") };
        blocks.Add(Bullets(decisions.Select(d => d.Detail is { Length: > 0 } det && det != d.Title ? new JsonNode[] { Text(d.Title, "bold"), Text(" — " + (det.Length > 300 ? det[..300] + "…" : det)) } : [Text(d.Title)])));
        if (actions.Count > 0)
        {
            blocks.Add(Para(Text("Actions agreed", "bold")));
            blocks.Add(Todos(actions.Select(a => ($"{a.Title}{(a.Who is { } w && names.TryGetValue(w, out var n) ? $" — {n}" : "")}{(a.DueDate is { } dd ? $", by {dd:d MMM}" : "")}", false))));
        }
        var target = await PageNamedAsync(meeting.ProjectId, DecisionLogTitle, ct);
        return await UpsertAsync("decision-log", "meeting", meetingId, meeting.ProjectId, DecisionLogTitle,
            $"{decisions.Count} decision{(decisions.Count == 1 ? "" : "s")} from “{meeting.Title}” on {meeting.StartTimeUtc:d MMM}", Doc(blocks), target, ct);
    }

    private async Task<DocumentProposal> ReleaseNotesAsync(Guid sprintId, CancellationToken ct)
    {
        var sprint = await db.Sprints.AsNoTracking().FirstOrDefaultAsync(s => s.Id == sprintId, ct) ?? throw new NotFoundException("Sprint not found.");
        var project = await db.Projects.AsNoTracking().FirstOrDefaultAsync(p => p.Id == sprint.ProjectId, ct) ?? throw new NotFoundException("Sprint not found.");
        var tasks = await db.Tasks.AsNoTracking().Where(t => t.SprintId == sprintId && t.ParentTaskId == null)
            .Select(t => new { t.Id, t.Number, t.Title, Category = t.Status!.Category, Status = t.Status.Name, Labels = t.Labels.Select(l => l.Label!.Name).ToList() }).ToListAsync(ct);
        var done = tasks.Where(t => t.Category == StatusCategory.Done).ToList();
        if (done.Count == 0) throw new ConflictException("Nothing was finished in this sprint, so there is nothing to write up.", "NOTHING_NEW");
        var taskIds = done.Select(t => t.Id).ToList();
        var prs = await db.DevLinks.AsNoTracking().Where(l => l.TaskId != null && taskIds.Contains(l.TaskId.Value) && l.Kind == "pull_request" && l.State == "merged")
            .Select(l => new { l.TaskId, l.Title, l.Url, l.Repository, l.ExternalId }).ToListAsync(ct);
        static bool IsFix(List<string> labels, string title) => labels.Any(l => l.Contains("bug", StringComparison.OrdinalIgnoreCase) || l.Contains("fix", StringComparison.OrdinalIgnoreCase))
            || title.StartsWith("fix", StringComparison.OrdinalIgnoreCase) || title.Contains(" bug", StringComparison.OrdinalIgnoreCase);
        var fixes = done.Where(t => IsFix(t.Labels, t.Title)).ToList();
        var features = done.Except(fixes).ToList();
        var blocks = new JsonArray
        {
            Para(Text($"{sprint.Name}, {sprint.StartDate:d MMM} – {sprint.EndDate:d MMM yyyy}: {done.Count} of {tasks.Count + 0} task{(tasks.Count == 1 ? "" : "s")} finished." + (string.IsNullOrWhiteSpace(sprint.Goal) ? "" : $" Goal: {sprint.Goal}"))),
        };
        JsonNode[] Line(int number, string title) => [Text($"{project.Key}-{number} ", "bold"), Text(title)];
        if (features.Count > 0) { blocks.Add(Heading(2, "What's new")); blocks.Add(Bullets(features.Select(t => Line(t.Number, t.Title)))); }
        if (fixes.Count > 0) { blocks.Add(Heading(2, "Fixes")); blocks.Add(Bullets(fixes.Select(t => Line(t.Number, t.Title)))); }
        if (prs.Count > 0)
        {
            blocks.Add(Heading(2, "Pull requests"));
            blocks.Add(Bullets(prs.Select(p =>
            {
                var link = new JsonObject { ["type"] = "text", ["text"] = $"{p.Repository}#{p.ExternalId}", ["marks"] = new JsonArray(new JsonObject { ["type"] = "link", ["attrs"] = new JsonObject { ["href"] = p.Url } }) };
                return new JsonNode[] { Text(p.Title + " "), link };
            })));
        }
        blocks.Add(Para(Text("Written from the sprint's finished tasks. Check it, then publish to share it.", "italic")));
        return await UpsertAsync("release-notes", "sprint", sprintId, project.Id, $"Release notes – {sprint.Name}",
            $"{done.Count} finished task{(done.Count == 1 ? "" : "s")}{(prs.Count > 0 ? $" and {prs.Count} pull request{(prs.Count == 1 ? "" : "s")}" : "")} from {sprint.Name}", Doc(blocks), null, ct);
    }

    private async Task<DocumentProposal> ApiReferenceAsync(Guid apiDocumentId, CancellationToken ct)
    {
        var doc = await db.Documents.AsNoTracking().FirstOrDefaultAsync(d => d.Id == apiDocumentId, ct) ?? throw new NotFoundException("Document not found.");
        var endpoints = await db.ApiEndpoints.AsNoTracking().Where(e => e.DocumentId == apiDocumentId).OrderBy(e => e.Tag).ThenBy(e => e.Path).ThenBy(e => e.Method)
            .Select(e => new { e.Method, e.Path, e.Summary, e.Tag, e.Deprecated }).Take(500).ToListAsync(ct);
        if (endpoints.Count == 0) throw new ConflictException("This API document has no endpoints yet.", "NOTHING_NEW");
        var cell = (string s, bool header) => new JsonObject { ["type"] = header ? "tableHeader" : "tableCell", ["content"] = new JsonArray(Para(s.Length == 0 ? [] : [Text(s)])) };
        var blocks = new JsonArray
        {
            Para(Text($"Generated from {DocumentService.KeyOf(doc.Number)} “{doc.Title}” on {clock.Now:d MMM yyyy}: {endpoints.Count} endpoint{(endpoints.Count == 1 ? "" : "s")}{(endpoints.Count(e => e.Deprecated) is > 0 and var dep ? $", {dep} deprecated" : "")}.")),
        };
        foreach (var group in endpoints.GroupBy(e => string.IsNullOrWhiteSpace(e.Tag) ? "Endpoints" : e.Tag!))
        {
            blocks.Add(Heading(2, group.Key));
            var rows = new JsonArray { new JsonObject { ["type"] = "tableRow", ["content"] = new JsonArray(cell("Method", true), cell("Path", true), cell("What it does", true)) } };
            foreach (var e in group)
                rows.Add(new JsonObject { ["type"] = "tableRow", ["content"] = new JsonArray(cell(e.Method.ToString().ToUpperInvariant(), false), cell(e.Path, false), cell((e.Deprecated ? "Deprecated. " : "") + e.Summary, false)) });
            blocks.Add(new JsonObject { ["type"] = "table", ["content"] = rows });
        }
        var title = $"API reference – {doc.Title}";
        var target = await PageNamedAsync(doc.ProjectId, title.Length > 200 ? title[..200] : title, ct);
        return await UpsertAsync("api-reference", "api", apiDocumentId, doc.ProjectId, title, $"{endpoints.Count} endpoints of {DocumentService.KeyOf(doc.Number)}, as they are now", Doc(blocks), target, ct);
    }

    /// <summary>Accepting adds the draft to its page (a decision log entry goes on top), replaces an API reference, or creates the page.</summary>
    public async Task<AcceptProposalDto> AcceptAsync(Guid id, CancellationToken ct = default)
    {
        var row = await db.DocumentProposals.FirstOrDefaultAsync(p => p.Id == id && p.Status == "Proposed", ct) ?? throw new NotFoundException("That draft was already handled or does not exist.");
        if (row.ProjectId is { } pid && !await db.Projects.AnyAsync(p => p.Id == pid, ct)) throw new NotFoundException("That draft was already handled or does not exist.");
        Guid result;
        string message;
        if (row.TargetDocumentId is { } target && await db.Documents.AsNoTracking().AnyAsync(d => d.Id == target, ct))
        {
            var page = await db.Documents.AsNoTracking().FirstAsync(d => d.Id == target, ct);
            if (!(await rights.RightsAsync(page, ct)).Edit) throw new ForbiddenException("You can read that page but not change it. Ask its owner to accept the draft.", "PERMISSION_DENIED");
            // The stored text (never the masked copy a reader sees): what is added must not overwrite real values with masks.
            var sections = page.DraftVersionId is { } dv ? await db.DocumentSections.AsNoTracking().Where(x => x.VersionId == dv).OrderBy(x => x.SortOrder).Select(x => new { x.Key, x.ContentJson }).ToListAsync(ct) : [];
            var bodySection = sections.FirstOrDefault(x => x.Key == DocumentTemplates.PageBody) ?? sections.FirstOrDefault();
            var body = bodySection?.ContentJson;
            var mine = JsonNode.Parse(row.Body)!["content"]!.AsArray();
            JsonArray merged;
            if (row.Kind == "api-reference" || body is null) merged = new JsonArray(mine.Select(n => n!.DeepClone()).ToArray());
            else
            {
                var existing = (JsonNode.Parse(body)?["content"] as JsonArray ?? []).Select(n => n!.DeepClone()).ToList();
                var add = mine.Select(n => n!.DeepClone()).ToList();
                // A log reads newest first: after its opening paragraph (if it has one), before the older entries.
                var at = existing.Count > 0 && existing[0]?["type"]?.GetValue<string>() == "paragraph" ? 1 : 0;
                existing.InsertRange(at, add);
                merged = new JsonArray(existing.ToArray());
            }
            await documents.SaveSectionsAsync(target, new SaveSectionsRequest(page.Revision, [new SectionInput(bodySection?.Key ?? DocumentTemplates.PageBody, Doc(merged))]), ct);
            result = target;
            message = row.Kind == "api-reference" ? $"“{page.Title}” is up to date." : $"Added to “{page.Title}”.";
        }
        else
        {
            await documents.EnsureTypesAsync(ct);
            var type = await db.DocumentTypes.AsNoTracking().Where(t => t.Code == DocumentTemplates.PageCode).Select(t => t.Id).FirstOrDefaultAsync(ct);
            if (type == Guid.Empty) throw new ConflictException("Pages are not set up in this workspace.");
            var icon = row.Kind switch { "release-notes" => "🚀", "api-reference" => "🔌", _ => "🧭" };
            var intro = row.Kind == "decision-log"
                ? new JsonArray(new JsonNode[] { Para(Text("What this project decided, newest first, from its meetings. Each entry was approved before it was added.")) }.Concat(JsonNode.Parse(row.Body)!["content"]!.AsArray().Select(n => n!.DeepClone())).ToArray())
                : JsonNode.Parse(row.Body)!["content"]!.AsArray().DeepClone().AsArray();
            var created = await documents.CreateAsync(new CreateDocumentRequest(row.Title, type, row.ProjectId, Sections: [new SectionInput(DocumentTemplates.PageBody, Doc(intro))], Icon: icon), ct);
            result = created.Item.Id;
            message = $"“{row.Title}” is ready.";
        }
        row.Status = "Accepted"; row.DecidedAt = clock.Now; row.DecidedBy = ctx.UserId; row.ResultDocumentId = result;
        recorder.Audit("document.proposal_accepted", "DocumentProposal", row.Id, null, new { row.Kind, document = result });
        await db.SaveChangesAsync(ct);
        return new AcceptProposalDto(result, message);
    }

    public async Task DismissAsync(Guid id, CancellationToken ct = default)
    {
        var row = await db.DocumentProposals.FirstOrDefaultAsync(p => p.Id == id && p.Status == "Proposed", ct) ?? throw new NotFoundException("That draft was already handled or does not exist.");
        if (row.ProjectId is { } pid && !await db.Projects.AnyAsync(p => p.Id == pid, ct)) throw new NotFoundException("That draft was already handled or does not exist.");
        row.Status = "Dismissed"; row.DecidedAt = clock.Now; row.DecidedBy = ctx.UserId;
        recorder.Audit("document.proposal_dismissed", "DocumentProposal", row.Id, null, new { row.Kind });
        await db.SaveChangesAsync(ct);
    }

    // ------------------------------------------------------------------ when things happen

    /// <summary>After a meeting was read and has decisions; after a sprint finished; after an API document changed. Never stops the caller.</summary>
    public async Task SuggestAsync(string kind, Guid sourceId, CancellationToken ct = default)
    {
        try
        {
            var existing = await db.DocumentProposals.AsNoTracking().Where(p => p.Kind == kind && p.SourceId == sourceId).Select(p => p.Status).FirstOrDefaultAsync(ct);
            if (existing is "Dismissed") return;   // someone already said no to this one
            var row = kind switch
            {
                "decision-log" => await DecisionLogAsync(sourceId, ct),
                "release-notes" => await ReleaseNotesAsync(sourceId, ct),
                _ => await ApiReferenceAsync(sourceId, ct),
            };
            if (existing is null && row.ProjectId is { } pid)
            {
                // The page's owner when it exists, otherwise the project's owner, is asked to look.
                var who = row.TargetDocumentId is { } t ? await db.Documents.AsNoTracking().Where(d => d.Id == t).Select(d => (Guid?)d.OwnerId).FirstOrDefaultAsync(ct) : null;
                who ??= await db.Projects.AsNoTracking().Where(p => p.Id == pid).Select(p => (Guid?)p.OwnerId).FirstOrDefaultAsync(ct);
                if (who is { } o && o != Guid.Empty)
                    await notifications.AddAsync(o, NotificationType.Document, $"A draft is ready to review: {row.Title}", row.Summary, $"/doctracker?p={pid}&drafts=1", $"proposal:{row.Id:N}", ct: ct);
            }
            await db.SaveChangesAsync(ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogInformation("No {Kind} draft for {Source}: {Reason}", kind, sourceId, ex.Message);
            db.Database.GetService<Microsoft.EntityFrameworkCore.Infrastructure.ICurrentDbContext>().Context.ChangeTracker.Clear();
        }
    }
}
