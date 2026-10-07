using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Documents;

public record WorkflowStepInput(string Name, ApproverKind Kind, Guid? PrincipalId, ApprovalRule Rule = ApprovalRule.Any, int? DueDays = null);
public record SaveWorkflowRequest(Guid? TypeId, string Name, bool IsActive, bool Remind, IReadOnlyList<WorkflowStepInput> Steps);
public record WorkflowStepDto(string Name, ApproverKind Kind, Guid? PrincipalId, string Who, ApprovalRule Rule, int? DueDays);
public record WorkflowDto(Guid Id, Guid? TypeId, string? TypeName, string Name, bool IsActive, bool Remind, IReadOnlyList<WorkflowStepDto> Steps);
public record WorkflowListDto(IReadOnlyList<WorkflowDto> Items, bool CanManage, bool Allowed, bool PerType, bool Reminders);

public record SubmitRequest(string ChangeSummary, string? ChangeReason, bool Major, int Revision);
public record DecideRequest(string? Comment);
public record ApprovalPersonDto(Guid UserId, string Name, string? Decision, string? Comment, DateTime? At);
public record ApprovalStepDto(string Name, string Who, ApprovalRule Rule, int? DueDays, string State, IReadOnlyList<ApprovalPersonDto> People);
public record ApprovalDto(Guid Id, ApprovalState State, string WorkflowName, UserRefDto SubmittedBy, DateTime SubmittedAt, string Summary, string? Reason, bool Major, int CurrentStep,
    IReadOnlyList<ApprovalStepDto> Steps, bool CanDecide, bool CanWithdraw, DateTime? DueAt, DateTime? ClosedAt, string? ClosedNote);
public record DocumentReviewDto(bool WorkflowApplies, string? WorkflowName, int StepCount, ApprovalDto? Current, IReadOnlyList<ApprovalDto> History, bool CanSubmit);

/// <summary>
/// The review path of a document: who sets up the workflows, who submits, who approves, and what happens when the document is edited, withdrawn or
/// published. A running approval carries its own copy of the steps and of the people who may decide them, so editing a workflow later never changes a
/// review that is already under way. The submitter can never decide their own submission.
/// </summary>
public class DocumentWorkflowService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, EntitlementService entitlements,
    DocumentAccessService rights, DocumentNotifier notifier, NotificationRouter router)
{
    public const int MaxSteps = 6, MaxWorkflows = 50;
    public const string ReviewerNote = "Added for review";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() } };

    // ------------------------------------------------------------------ workflow definitions

    public async Task<WorkflowListDto> ListAsync(CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var rows = await db.WorkflowDefinitions.AsNoTracking().OrderBy(w => w.TypeId == null ? 0 : 1).ThenBy(w => w.Name).ToListAsync(ct);
        var allowed = await entitlements.GetValueAsync(FeatureKeys.CustomWorkflows, ct) != 0;
        var advanced = await entitlements.GetValueAsync(FeatureKeys.AdvancedPermissions, ct) != 0;
        var items = new List<WorkflowDto>();
        var types = await db.DocumentTypes.AsNoTracking().ToDictionaryAsync(t => t.Id, t => t.Name, ct);
        foreach (var w in rows) items.Add(await ToDtoAsync(w, types, ct));
        return new WorkflowListDto(items, await permissions.HasAsync(Permissions.DocsWorkflow, ct), allowed, advanced, advanced);
    }

    private async Task<WorkflowDto> ToDtoAsync(WorkflowDefinition w, Dictionary<Guid, string> types, CancellationToken ct)
    {
        var steps = new List<WorkflowStepDto>();
        foreach (var s in ReadSteps(w.StepsJson)) steps.Add(new WorkflowStepDto(s.Name, s.Kind, s.PrincipalId, await WhoAsync(s.Kind, s.PrincipalId, ct), s.Rule, s.DueDays));
        return new WorkflowDto(w.Id, w.TypeId, w.TypeId is { } t ? types.GetValueOrDefault(t) : null, w.Name, w.IsActive, w.Remind, steps);
    }

    private async Task<string> WhoAsync(ApproverKind kind, Guid? id, CancellationToken ct) => kind switch
    {
        ApproverKind.User => id is { } u ? await db.Users.Where(x => x.Id == u).Select(x => x.DisplayName).FirstOrDefaultAsync(ct) ?? "Former member" : "",
        ApproverKind.Team => id is { } t ? await db.Teams.Where(x => x.Id == t).Select(x => x.Name).FirstOrDefaultAsync(ct) ?? "(deleted team)" : "",
        ApproverKind.JobRole => id is { } r ? await db.OrgRoles.Where(x => x.Id == r).Select(x => x.Name).FirstOrDefaultAsync(ct) ?? "(deleted role)" : "",
        _ => "The project's owner",
    };

    public async Task<WorkflowDto> SaveAsync(Guid? id, SaveWorkflowRequest req, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        await permissions.RequireAsync(Permissions.DocsWorkflow, ct);
        await entitlements.EnsureFeatureAsync(FeatureKeys.CustomWorkflows, ct);
        if (req.TypeId is not null) await entitlements.EnsureFeatureAsync(FeatureKeys.AdvancedPermissions, ct);
        if (req.Remind) await entitlements.EnsureFeatureAsync(FeatureKeys.AdvancedPermissions, ct);
        var name = (req.Name ?? "").Trim();
        if (name.Length is 0 or > 80) throw new ValidationException("name", "Give the workflow a name of up to 80 characters.");
        if (req.Steps is null || req.Steps.Count == 0) throw new ValidationException("steps", "A workflow needs at least one step.");
        if (req.Steps.Count > MaxSteps) throw new ValidationException("steps", $"A workflow has at most {MaxSteps} steps.");
        if (req.TypeId is { } ty && !await db.DocumentTypes.AnyAsync(t => t.Id == ty, ct)) throw new ValidationException("typeId", "Document type not found.");

        var steps = new List<WorkflowStepSpec>();
        for (var i = 0; i < req.Steps.Count; i++)
        {
            var s = req.Steps[i];
            var sn = (s.Name ?? "").Trim();
            if (sn.Length is 0 or > 60) throw new ValidationException($"steps[{i}].name", "Name each step (up to 60 characters).");
            if (!Enum.IsDefined(s.Kind) || !Enum.IsDefined(s.Rule)) throw new ValidationException($"steps[{i}]", "Choose who approves this step.");
            if (s.DueDays is < 1 or > 90) throw new ValidationException($"steps[{i}].dueDays", "A due time is between 1 and 90 days.");
            Guid? principal = s.Kind == ApproverKind.ProjectOwner ? null : s.PrincipalId ?? throw new ValidationException($"steps[{i}].principalId", "Choose who approves this step.");
            var exists = s.Kind switch
            {
                ApproverKind.User => await db.TenantMembers.AnyAsync(m => m.TenantId == tid && m.UserId == principal && m.Role != TenantRole.Guest, ct),
                ApproverKind.Team => await db.Teams.AnyAsync(t => t.Id == principal, ct),
                ApproverKind.JobRole => await db.OrgRoles.AnyAsync(r => r.Id == principal, ct),
                _ => true,
            };
            if (!exists) throw new ValidationException($"steps[{i}].principalId", "That person, team or role was not found.");
            steps.Add(new WorkflowStepSpec(sn, s.Kind, principal, s.Kind == ApproverKind.User ? ApprovalRule.Any : s.Rule, s.DueDays));
        }

        WorkflowDefinition w;
        if (id is { } wid)
        {
            w = await db.WorkflowDefinitions.FirstOrDefaultAsync(x => x.Id == wid, ct) ?? throw new NotFoundException("Workflow not found.");
            if (w.TypeId != req.TypeId) throw new ValidationException("typeId", "A workflow keeps the document type it was made for.");
        }
        else
        {
            if (await db.WorkflowDefinitions.CountAsync(ct) >= MaxWorkflows) throw new ValidationException("name", $"A workspace can have at most {MaxWorkflows} workflows.");
            if (await db.WorkflowDefinitions.AnyAsync(x => x.TypeId == req.TypeId, ct))
                throw new ConflictException(req.TypeId is null ? "There is already a default workflow. Edit it instead." : "This document type already has a workflow. Edit it instead.", "WORKFLOW_EXISTS");
            w = new WorkflowDefinition { TenantId = tid, TypeId = req.TypeId, CreatedAt = clock.Now, CreatedBy = ctx.UserId };
            db.WorkflowDefinitions.Add(w);
        }
        var before = id is null ? null : new { w.Name, w.IsActive, w.Remind, steps = ReadSteps(w.StepsJson).Count };
        w.Name = name; w.IsActive = req.IsActive; w.Remind = req.Remind; w.StepsJson = JsonSerializer.Serialize(steps, Json); w.UpdatedAt = clock.Now;
        recorder.Audit(id is null ? "document.workflow_created" : "document.workflow_changed", "DocumentWorkflow", w.Id, before, new { name, req.IsActive, req.Remind, req.TypeId, steps = steps.Select(s => new { s.Name, s.Kind, s.PrincipalId, s.Rule, s.DueDays }) });
        await db.SaveChangesAsync(ct);
        var types = await db.DocumentTypes.AsNoTracking().ToDictionaryAsync(t => t.Id, t => t.Name, ct);
        return await ToDtoAsync(w, types, ct);
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.DocsWorkflow, ct);
        var w = await db.WorkflowDefinitions.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Workflow not found.");
        db.WorkflowDefinitions.Remove(w);
        recorder.Audit("document.workflow_deleted", "DocumentWorkflow", w.Id, new { w.Name, w.TypeId });
        await db.SaveChangesAsync(ct);
    }

    private static List<WorkflowStepSpec> ReadSteps(string json) => JsonSerializer.Deserialize<List<WorkflowStepSpec>>(json, Json) ?? [];
    private static List<ApprovalStepSnapshot> ReadSnapshot(string json) => JsonSerializer.Deserialize<List<ApprovalStepSnapshot>>(json, Json) ?? [];

    /// <summary>The workflow in force for documents of this kind, or null (the owner publishes). A kind's own workflow wins over the default one; per-kind workflows are a Business feature.</summary>
    public async Task<WorkflowDefinition?> ResolveAsync(Guid typeId, CancellationToken ct = default)
    {
        if (await entitlements.GetValueAsync(FeatureKeys.CustomWorkflows, ct) == 0) return null;
        var perType = await entitlements.GetValueAsync(FeatureKeys.AdvancedPermissions, ct) != 0;
        var active = await db.WorkflowDefinitions.AsNoTracking().Where(w => w.IsActive && (w.TypeId == null || (perType && w.TypeId == typeId))).ToListAsync(ct);
        return active.FirstOrDefault(w => w.TypeId == typeId) ?? active.FirstOrDefault(w => w.TypeId == null);
    }

    // ------------------------------------------------------------------ reading one document's review

    public async Task<DocumentReviewDto> ReviewAsync(Guid documentId, CancellationToken ct = default)
    {
        var doc = await db.Documents.AsNoTracking().FirstOrDefaultAsync(d => d.Id == documentId, ct) ?? throw new NotFoundException("Document not found.");
        var def = await ResolveAsync(doc.TypeId, ct);
        var list = await db.DocumentApprovals.AsNoTracking().Where(a => a.DocumentId == documentId).OrderByDescending(a => a.SubmittedAt).Take(21).ToListAsync(ct);
        var dtos = new List<ApprovalDto>();
        foreach (var a in list) dtos.Add(await ToDtoAsync(doc, a, ct));
        var r = await rights.RightsAsync(doc, ct);
        var canSubmit = def is not null && r.Edit && DocumentStateMachine.Next(doc.Status, DocAction.Submit, doc.PublishedVersionId is not null, true) is not null;
        return new DocumentReviewDto(def is not null, def?.Name, def is null ? 0 : ReadSteps(def.StepsJson).Count, dtos.FirstOrDefault(), dtos.Skip(1).ToList(), canSubmit);
    }

    private async Task<ApprovalDto> ToDtoAsync(Document doc, DocumentApproval a, CancellationToken ct)
    {
        var steps = ReadSnapshot(a.StepsJson);
        var decisions = await db.ApprovalDecisions.AsNoTracking().Where(d => d.ApprovalId == a.Id).OrderBy(d => d.CreatedAt).ToListAsync(ct);
        var ids = steps.SelectMany(s => s.Approvers).Concat(decisions.Select(d => d.UserId)).Append(a.SubmittedBy).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        string Name(Guid id) => names.GetValueOrDefault(id) ?? "Former member";
        var stepDtos = new List<ApprovalStepDto>();
        for (var i = 0; i < steps.Count; i++)
        {
            var s = steps[i];
            var mine = decisions.Where(d => d.StepIndex == i).ToList();
            var people = s.Approvers.Select(u =>
            {
                var d = mine.LastOrDefault(x => x.UserId == u);
                return new ApprovalPersonDto(u, Name(u), d?.Decision.ToString(), d?.Comment, d?.CreatedAt);
            }).ToList();
            var state = a.State switch
            {
                ApprovalState.Approved or ApprovalState.Published => "Done",
                ApprovalState.Cancelled => i < a.CurrentStep ? "Done" : "Skipped",
                _ => i < a.CurrentStep ? "Done" : i == a.CurrentStep ? (a.State == ApprovalState.ChangesRequested ? "ChangesRequested" : "Current") : "Waiting",
            };
            stepDtos.Add(new ApprovalStepDto(s.Name, s.Who, s.Rule, s.DueDays, state, people));
        }
        var me = ctx.RequireUserId();
        var current = a.State == ApprovalState.Pending && a.CurrentStep < steps.Count ? steps[a.CurrentStep] : null;
        var canDecide = current is not null && me != a.SubmittedBy && current.Approvers.Contains(me) && !decisions.Any(d => d.StepIndex == a.CurrentStep && d.UserId == me);
        var r = await rights.RightsAsync(doc, ct);
        var canWithdraw = a.State is ApprovalState.Pending or ApprovalState.Approved && doc.Status is DocumentStatus.InReview or DocumentStatus.Approved && (me == a.SubmittedBy || r.Share);
        DateTime? due = current?.DueDays is { } days ? a.StepStartedAt.AddDays(days) : null;
        return new ApprovalDto(a.Id, a.State, a.WorkflowName, new UserRefDto(a.SubmittedBy, Name(a.SubmittedBy)), a.SubmittedAt, a.Summary, a.Reason, a.Major, a.CurrentStep, stepDtos, canDecide, canWithdraw, due, a.ClosedAt, a.ClosedNote);
    }

    /// <summary>Whether the signed-in person is asked to review the document now (or submitted it): they read the draft under review, not the published version.</summary>
    public async Task<bool> IsReviewerAsync(Guid documentId, CancellationToken ct = default)
    {
        var a = await db.DocumentApprovals.AsNoTracking().FirstOrDefaultAsync(x => x.DocumentId == documentId && x.State == ApprovalState.Pending, ct);
        if (a is null) return false;
        return a.SubmittedBy == ctx.RequireUserId() || ReadSnapshot(a.StepsJson).Any(s => s.Approvers.Contains(ctx.RequireUserId()));
    }

    public sealed record InboxRow(DocumentApproval Approval, string StepName, bool ToDecide, DateTime? DueAt);

    /// <summary>The reviews waiting on the signed-in person, and the ones they submitted that are still open.</summary>
    public async Task<(List<InboxRow> ToDecide, List<InboxRow> Mine)> InboxAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var open = await db.DocumentApprovals.AsNoTracking().Where(a => a.State == ApprovalState.Pending || a.State == ApprovalState.Approved).OrderByDescending(a => a.SubmittedAt).Take(500).ToListAsync(ct);
        var decided = (await db.ApprovalDecisions.AsNoTracking().Where(d => d.UserId == me).Select(d => new { d.ApprovalId, d.StepIndex }).ToListAsync(ct)).Select(d => (d.ApprovalId, d.StepIndex)).ToHashSet();
        var toDecide = new List<InboxRow>(); var mine = new List<InboxRow>();
        foreach (var a in open)
        {
            var steps = ReadSnapshot(a.StepsJson);
            var step = a.State == ApprovalState.Pending && a.CurrentStep < steps.Count ? steps[a.CurrentStep] : null;
            DateTime? due = step?.DueDays is { } d ? a.StepStartedAt.AddDays(d) : null;
            if (step is not null && a.SubmittedBy != me && step.Approvers.Contains(me) && !decided.Contains((a.Id, a.CurrentStep))) toDecide.Add(new InboxRow(a, step.Name, true, due));
            if (a.SubmittedBy == me) mine.Add(new InboxRow(a, step?.Name ?? (a.State == ApprovalState.Approved ? "Approved, ready to publish" : ""), false, due));
        }
        return (toDecide, mine);
    }

    // ------------------------------------------------------------------ submitting

    public async Task<DocumentReviewDto> SubmitAsync(Guid documentId, SubmitRequest req, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var me = ctx.RequireUserId();
        var doc = await db.Documents.FirstOrDefaultAsync(d => d.Id == documentId, ct) ?? throw new NotFoundException("Document not found.");
        var r = await rights.RightsAsync(doc, ct);
        if (!r.Edit) throw new ForbiddenException("You can read this document but not submit it.", "PERMISSION_DENIED");
        if (doc.Revision != req.Revision) throw Changed();
        var def = await ResolveAsync(doc.TypeId, ct) ?? throw new ConflictException("This kind of document has no approval workflow. Publish it directly.", "NO_WORKFLOW");
        var next = DocumentStateMachine.Next(doc.Status, DocAction.Submit, doc.PublishedVersionId is not null, true)
            ?? throw new ConflictException(doc.Status switch
            {
                DocumentStatus.InReview => "This document is already waiting for review.",
                DocumentStatus.Approved => "This document is approved. Publish it, or withdraw the approval to change it.",
                _ => "An archived document cannot be submitted. Reopen it first.",
            }, "ILLEGAL_TRANSITION");

        var summary = (req.ChangeSummary ?? "").Trim();
        if (summary.Length == 0) throw new ValidationException("changeSummary", "Say in a sentence what changed.");
        if (summary.Length > 500) throw new ValidationException("changeSummary", "Keep the summary under 500 characters.");
        var reason = string.IsNullOrWhiteSpace(req.ChangeReason) ? null : req.ChangeReason.Trim();
        if (reason is { Length: > 500 }) throw new ValidationException("changeReason", "Keep the reason under 500 characters.");

        var draft = await db.DocumentVersions.AsNoTracking().FirstAsync(v => v.Id == doc.DraftVersionId, ct);
        var latest = await db.DocumentVersions.AsNoTracking().Where(v => v.DocumentId == documentId && !v.IsDraft).OrderByDescending(v => v.Major).ThenByDescending(v => v.Minor).FirstOrDefaultAsync(ct);
        if (latest is not null && latest.ContentHash == draft.ContentHash) throw new ConflictException("There is nothing new to submit: the draft is the same as the last published version.", "NOTHING_TO_PUBLISH");

        // Who approves each step, decided now and kept: later changes to the workflow, a team or a role do not move a review that has started.
        var specs = ReadSteps(def.StepsJson);
        var snapshot = new List<ApprovalStepSnapshot>();
        foreach (var s in specs)
        {
            var approvers = await ResolveApproversAsync(s, doc, me, ct);
            if (approvers.Count == 0)
                throw new ValidationException("steps", $"Nobody can approve the step \"{s.Name}\" (you cannot approve your own submission). Ask an administrator to change the workflow.");
            snapshot.Add(new ApprovalStepSnapshot(s.Name, s.Kind, s.PrincipalId, await WhoAsync(s.Kind, s.PrincipalId, ct), s.Rule, s.DueDays, approvers));
        }

        var now = clock.Now;
        var approval = new DocumentApproval
        {
            TenantId = tid, DocumentId = doc.Id, VersionId = draft.Id, ContentHash = draft.ContentHash, State = ApprovalState.Pending, SubmittedBy = me, SubmittedAt = now, CurrentStep = 0, StepStartedAt = now,
            WorkflowName = def.Name, Remind = def.Remind, StepsJson = JsonSerializer.Serialize(snapshot, Json), Summary = summary, Reason = reason, Major = req.Major, CreatedAt = now, CreatedBy = me,
        };
        db.DocumentApprovals.Add(approval);
        doc.Status = next; Touch(doc);

        // Reviewers must be able to open what they are asked to review.
        var openers = (await rights.GetAsync(doc.Id, ct)).People.Select(p => p.UserId).ToHashSet();
        foreach (var u in snapshot.SelectMany(s => s.Approvers).Distinct().Where(u => !openers.Contains(u)))
            db.DocumentGrants.Add(new DocumentGrant { TenantId = tid, DocumentId = doc.Id, PrincipalType = GrantPrincipal.User, PrincipalId = u, Level = DocAccessLevel.Viewer, Note = ReviewerNote, CreatedAt = now, CreatedBy = me });

        var key = DocumentService.KeyOf(doc.Number);
        var who = await db.Users.Where(u => u.Id == me).Select(u => u.DisplayName).FirstAsync(ct);
        await notifier.SendAsync(snapshot[0].Approvers, doc, $"submitted:{approval.Id:N}:0", $"{who} asks you to review {key}", $"{doc.Title} · {summary}", ct: ct);
        recorder.Activity("document.submitted", "Document", doc.Id, $"Submitted {key} \"{doc.Title}\" for review", doc.ProjectId, newValue: summary);
        recorder.Audit("document.submitted", "Document", doc.Id, null, new { approval = approval.Id, workflow = def.Name, steps = snapshot.Select(s => s.Name), summary, reason, hash = draft.ContentHash });
        await SaveAsync(ct);
        return await ReviewAsync(documentId, ct);
    }

    private async Task<List<Guid>> ResolveApproversAsync(WorkflowStepSpec s, Document doc, Guid submitter, CancellationToken ct)
    {
        var tid = ctx.RequireTenantId();
        List<Guid> ids = s.Kind switch
        {
            ApproverKind.User => s.PrincipalId is { } u ? [u] : [],
            ApproverKind.Team => s.PrincipalId is { } t ? await db.TeamMembers.Where(m => m.TeamId == t).Select(m => m.UserId).ToListAsync(ct) : [],
            ApproverKind.JobRole => s.PrincipalId is { } r ? await db.TenantMembers.Where(m => m.TenantId == tid && m.OrgRoleId == r).Select(m => m.UserId).ToListAsync(ct) : [],
            _ => doc.ProjectId is { } p ? await db.Projects.Where(x => x.Id == p).Select(x => x.OwnerId).ToListAsync(ct) : [],
        };
        ids = ids.Where(i => i != submitter).Distinct().ToList();
        if (ids.Count == 0) return [];
        return await db.TenantMembers.Where(m => m.TenantId == tid && ids.Contains(m.UserId) && m.Role != TenantRole.Guest).Select(m => m.UserId).ToListAsync(ct);
    }

    // ------------------------------------------------------------------ deciding

    public Task<DocumentReviewDto> ApproveAsync(Guid documentId, DecideRequest req, CancellationToken ct = default) => DecideAsync(documentId, req, true, ct);
    public Task<DocumentReviewDto> RequestChangesAsync(Guid documentId, DecideRequest req, CancellationToken ct = default) => DecideAsync(documentId, req, false, ct);

    private async Task<DocumentReviewDto> DecideAsync(Guid documentId, DecideRequest req, bool approve, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var doc = await db.Documents.FirstOrDefaultAsync(d => d.Id == documentId, ct) ?? throw new NotFoundException("Document not found.");
        var a = await db.DocumentApprovals.FirstOrDefaultAsync(x => x.DocumentId == documentId && x.State == ApprovalState.Pending, ct)
            ?? throw new ConflictException("This document is not waiting for a decision.", "NOT_IN_REVIEW");
        var steps = ReadSnapshot(a.StepsJson);
        var step = steps[a.CurrentStep];
        if (a.SubmittedBy == me) throw new ForbiddenException("You cannot decide your own submission.", "OWN_SUBMISSION");
        if (!step.Approvers.Contains(me)) throw new ForbiddenException("You are not one of the people who decide this step.", "NOT_AN_APPROVER");
        if (await db.ApprovalDecisions.AnyAsync(d => d.ApprovalId == a.Id && d.StepIndex == a.CurrentStep && d.UserId == me, ct)) throw new ConflictException("You have already decided this step.", "ALREADY_DECIDED");
        var comment = string.IsNullOrWhiteSpace(req.Comment) ? null : req.Comment.Trim();
        if (comment is { Length: > 1000 }) throw new ValidationException("comment", "Keep the comment under 1000 characters.");
        if (!approve && comment is null) throw new ValidationException("comment", "Say what needs to change.");

        var draft = await db.DocumentVersions.AsNoTracking().FirstAsync(v => v.Id == doc.DraftVersionId, ct);
        if (draft.ContentHash != a.ContentHash) throw new ConflictException("The document changed after it was submitted. Ask for it to be submitted again.", "CONTENT_CHANGED");

        var now = clock.Now;
        db.ApprovalDecisions.Add(new ApprovalDecision { TenantId = doc.TenantId, ApprovalId = a.Id, DocumentId = doc.Id, StepIndex = a.CurrentStep, UserId = me, Decision = approve ? DecisionKind.Approved : DecisionKind.ChangesRequested, Comment = comment, CreatedAt = now, CreatedBy = me });
        var key = DocumentService.KeyOf(doc.Number);
        var who = await db.Users.Where(u => u.Id == me).Select(u => u.DisplayName).FirstAsync(ct);
        var starters = new[] { a.SubmittedBy, doc.OwnerId };

        if (!approve)
        {
            a.State = ApprovalState.ChangesRequested; a.ClosedAt = now; a.ClosedBy = me; a.ClosedNote = comment;
            doc.Status = DocumentStateMachine.Next(doc.Status, DocAction.RequestChanges, doc.PublishedVersionId is not null, true)!.Value;
            // The reviewer keeps their read access (to see the answer to their comments); it goes when the review is finally closed.
            await notifier.SendAsync(starters, doc, $"changes:{a.Id:N}", $"{who} asked for changes to {key}", comment, ct: ct);
            recorder.Activity("document.changes_requested", "Document", doc.Id, $"Asked for changes to {key} \"{doc.Title}\"", doc.ProjectId, newValue: comment);
            recorder.Audit("document.changes_requested", "Document", doc.Id, null, new { approval = a.Id, step = step.Name, comment });
        }
        else
        {
            var decided = (await db.ApprovalDecisions.Where(d => d.ApprovalId == a.Id && d.StepIndex == a.CurrentStep && d.Decision == DecisionKind.Approved).Select(d => d.UserId).ToListAsync(ct)).Append(me).Distinct().ToList();
            var stepDone = step.Rule == ApprovalRule.Any || step.Approvers.All(decided.Contains);
            if (!stepDone)
            {
                recorder.Activity("document.step_approved", "Document", doc.Id, $"{who} approved {key} (step \"{step.Name}\")", doc.ProjectId);
                recorder.Audit("document.step_approved", "Document", doc.Id, null, new { approval = a.Id, step = step.Name, partial = true, comment });
            }
            else if (a.CurrentStep + 1 < steps.Count)
            {
                a.CurrentStep++; a.StepStartedAt = now; a.ReminderSent = false;
                await notifier.SendAsync(steps[a.CurrentStep].Approvers, doc, $"submitted:{a.Id:N}:{a.CurrentStep}", $"{key} is waiting for your review", $"{doc.Title} · step \"{steps[a.CurrentStep].Name}\"", ct: ct);
                recorder.Activity("document.step_approved", "Document", doc.Id, $"{who} approved {key} (step \"{step.Name}\")", doc.ProjectId);
                recorder.Audit("document.step_approved", "Document", doc.Id, null, new { approval = a.Id, step = step.Name, next = steps[a.CurrentStep].Name, comment });
            }
            else
            {
                a.State = ApprovalState.Approved; a.ClosedAt = now; a.ClosedBy = me; a.ClosedNote = comment;
                doc.Status = DocumentStateMachine.Next(doc.Status, DocAction.ApproveFinal, doc.PublishedVersionId is not null, true)!.Value;
                await notifier.SendAsync(starters, doc, $"approved:{a.Id:N}", $"{key} was approved", $"{doc.Title} is ready to publish.", ct: ct);
                recorder.Activity("document.approved", "Document", doc.Id, $"Approved {key} \"{doc.Title}\"", doc.ProjectId);
                recorder.Audit("document.approved", "Document", doc.Id, null, new { approval = a.Id, step = step.Name, comment, hash = a.ContentHash });
            }
        }
        Touch(doc);
        await SaveAsync(ct);
        return await ReviewAsync(documentId, ct);
    }

    public async Task<DocumentReviewDto> WithdrawAsync(Guid documentId, DecideRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var doc = await db.Documents.FirstOrDefaultAsync(d => d.Id == documentId, ct) ?? throw new NotFoundException("Document not found.");
        var a = await db.DocumentApprovals.FirstOrDefaultAsync(x => x.DocumentId == documentId && (x.State == ApprovalState.Pending || x.State == ApprovalState.Approved), ct)
            ?? throw new ConflictException("There is nothing to withdraw.", "NOT_IN_REVIEW");
        if (a.SubmittedBy != me && !(await rights.RightsAsync(doc, ct)).Share) throw new ForbiddenException("Only the person who submitted it, the owner, a manager of this document or an administrator can withdraw it.", "PERMISSION_DENIED");
        doc.Status = DocumentStateMachine.Next(doc.Status, DocAction.Withdraw, doc.PublishedVersionId is not null, true) ?? throw new ConflictException("There is nothing to withdraw.", "ILLEGAL_TRANSITION");
        await CloseAsync(doc, a, ApprovalState.Cancelled, string.IsNullOrWhiteSpace(req.Comment) ? "Withdrawn" : req.Comment.Trim(), ct);
        Touch(doc);
        recorder.Activity("document.withdrawn", "Document", doc.Id, $"Withdrew {DocumentService.KeyOf(doc.Number)} from review", doc.ProjectId);
        recorder.Audit("document.withdrawn", "Document", doc.Id, null, new { approval = a.Id });
        await SaveAsync(ct);
        return await ReviewAsync(documentId, ct);
    }

    // ------------------------------------------------------------------ what other changes do to a review

    /// <summary>
    /// The words of a document changed. A review that is running, or an approval that is waiting to be published, no longer matches what was read, so it is
    /// cancelled and the document goes back to its draft (the approvers are told). Called by the code that changes content, before it saves.
    /// </summary>
    public async Task OnContentChangedAsync(Document doc, CancellationToken ct = default)
    {
        if (doc.Status is not (DocumentStatus.InReview or DocumentStatus.Approved)) return;
        var a = await db.DocumentApprovals.FirstOrDefaultAsync(x => x.DocumentId == doc.Id && (x.State == ApprovalState.Pending || x.State == ApprovalState.Approved), ct);
        doc.Status = DocumentStateMachine.Next(doc.Status, DocAction.Edit, doc.PublishedVersionId is not null, true)!.Value;
        if (a is null) return;
        var pending = a.State == ApprovalState.Pending;
        var steps = ReadSnapshot(a.StepsJson);
        await CloseAsync(doc, a, ApprovalState.Cancelled, "The document was edited", ct);
        if (pending && a.CurrentStep < steps.Count)
            await notifier.SendAsync(steps[a.CurrentStep].Approvers.Append(a.SubmittedBy), doc, $"voided:{a.Id:N}", $"The review of {DocumentService.KeyOf(doc.Number)} was cancelled", "The document was edited, so it has to be submitted again.", ct: ct);
        recorder.Audit("document.review_cancelled", "Document", doc.Id, null, new { approval = a.Id, reason = "edited" });
    }

    private async Task CloseAsync(Document doc, DocumentApproval a, ApprovalState state, string note, CancellationToken ct)
    {
        a.State = state; a.ClosedAt = clock.Now; a.ClosedBy = ctx.UserId; a.ClosedNote = note;
        await RemoveReviewerGrantsAsync(doc.Id, ct);
    }

    private async Task RemoveReviewerGrantsAsync(Guid documentId, CancellationToken ct)
    {
        var grants = await db.DocumentGrants.Where(g => g.DocumentId == documentId && g.Note == ReviewerNote && !g.Deny).ToListAsync(ct);
        db.DocumentGrants.RemoveRange(grants);
    }

    // ------------------------------------------------------------------ publishing

    /// <summary>The approval that lets this draft be published, when the document's kind has a workflow. Throws when the document must be approved first.</summary>
    public async Task<DocumentApproval?> RequireApprovedAsync(Document doc, string draftHash, CancellationToken ct = default)
    {
        if (await ResolveAsync(doc.TypeId, ct) is null) return null;
        var a = doc.Status == DocumentStatus.Approved
            ? await db.DocumentApprovals.Where(x => x.DocumentId == doc.Id && x.State == ApprovalState.Approved).OrderByDescending(x => x.SubmittedAt).FirstOrDefaultAsync(ct) : null;
        if (a is null) throw new ConflictException("This document needs approval before it is published. Submit it for review.", "APPROVAL_REQUIRED");
        if (a.ContentHash != draftHash) throw new ConflictException("The document changed after it was approved. Submit it for review again.", "CONTENT_CHANGED");
        return a;
    }

    /// <summary>Whether this document's publishing goes through a workflow (used by restore, which then only loads the old words into the draft).</summary>
    public async Task<bool> AppliesAsync(Document doc, CancellationToken ct = default) => await ResolveAsync(doc.TypeId, ct) is not null;

    /// <summary>After a version was published: closes the approval, removes review-only access and tells the people who care about the new version.</summary>
    public async Task OnPublishedAsync(Document doc, DocumentApproval? approval, string label, string summary, CancellationToken ct = default)
    {
        var people = new HashSet<Guid> { doc.OwnerId };
        if (approval is not null)
        {
            people.Add(approval.SubmittedBy);
            foreach (var s in ReadSnapshot(approval.StepsJson)) foreach (var u in s.Approvers) people.Add(u);
            approval.State = ApprovalState.Published; approval.ClosedAt = clock.Now; approval.ClosedBy = ctx.UserId;
            await RemoveReviewerGrantsAsync(doc.Id, ct);
        }
        var key = DocumentService.KeyOf(doc.Number);
        var openers = (await rights.GetAsync(doc.Id, ct)).People.Select(p => p.UserId).ToHashSet();
        var inside = people.Where(openers.Contains).ToList();
        await notifier.SendAsync(inside, doc, $"published:{label}", $"{key} version {label} was published", $"{doc.Title} · {summary}", ct: ct);

        // The people who build or verify what this document asks for hear about the new version once, however many links they have.
        var linked = await db.DocumentLinks.AsNoTracking().Where(l => l.DocumentId == doc.Id && (l.Relation == LinkRelation.Implements || l.Relation == LinkRelation.Verifies)).Select(l => new { l.TargetType, l.TargetId }).ToListAsync(ct);
        var tid = ctx.RequireTenantId();
        var assignees = new HashSet<Guid>();
        var taskIds = linked.Where(l => l.TargetType == LinkTarget.Task).Select(l => l.TargetId).ToList();
        foreach (var u in await db.Tasks.IgnoreQueryFilters().Where(t => t.TenantId == tid && taskIds.Contains(t.Id) && t.AssigneeId != null).Select(t => t.AssigneeId!.Value).ToListAsync(ct)) assignees.Add(u);
        var workIds = linked.Where(l => l.TargetType == LinkTarget.WorkItem).Select(l => l.TargetId).ToList();
        foreach (var u in await db.WorkTasks.IgnoreQueryFilters().Where(t => t.TenantId == tid && workIds.Contains(t.Id) && t.AssigneeId != null).Select(t => t.AssigneeId!.Value).ToListAsync(ct)) assignees.Add(u);
        var issueIds = linked.Where(l => l.TargetType == LinkTarget.Issue).Select(l => l.TargetId).ToList();
        foreach (var u in await db.StageIssues.IgnoreQueryFilters().Where(t => t.TenantId == tid && issueIds.Contains(t.Id) && t.AssigneeId != null).Select(t => t.AssigneeId!.Value).ToListAsync(ct)) assignees.Add(u);
        assignees.ExceptWith(inside);
        var canOpen = assignees.Where(openers.Contains).ToList();
        await notifier.SendAsync(canOpen, doc, $"released:{label}", $"{key} changed (version {label})", $"{doc.Title} · you work on something linked to it. {summary}", ct: ct);
        // Someone who builds a linked item but cannot open the document is told that it changed, without its name.
        await notifier.SendAsync(assignees.Except(canOpen), doc, $"released:{label}", "A document linked to your work changed", "A new version was published. Ask its owner for access to read it.", withLink: false, ct: ct);
    }

    // ------------------------------------------------------------------ reminders (run by the nightly job, across workspaces)

    /// <summary>Business plan: when a step has been waiting longer than its due time, the people who still have to decide are reminded once.</summary>
    public async Task<int> SendRemindersAsync(CancellationToken ct = default)
    {
        var now = clock.Now;
        var open = await db.DocumentApprovals.IgnoreQueryFilters().Where(a => a.State == ApprovalState.Pending && a.Remind && !a.ReminderSent).Take(200).ToListAsync(ct);
        var sent = 0;
        foreach (var a in open)
        {
            var steps = ReadSnapshot(a.StepsJson);
            if (a.CurrentStep >= steps.Count || steps[a.CurrentStep].DueDays is not { } days || a.StepStartedAt.AddDays(days) > now) continue;
            var doc = await db.Documents.IgnoreQueryFilters().FirstOrDefaultAsync(d => d.Id == a.DocumentId && !d.IsDeleted, ct);
            if (doc is null) continue;
            var decided = (await db.ApprovalDecisions.IgnoreQueryFilters().Where(d => d.ApprovalId == a.Id && d.StepIndex == a.CurrentStep).Select(d => d.UserId).ToListAsync(ct)).ToHashSet();
            foreach (var user in steps[a.CurrentStep].Approvers.Where(u => !decided.Contains(u)))
            {
                var key = "doc:" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"remind|{a.Id:N}|{a.CurrentStep}|{user:N}")))[..40];
                var n = new Notification
                {
                    TenantId = a.TenantId, UserId = user, Type = NotificationType.Document, DedupeKey = key, CreatedAt = now, Link = $"/documents/{doc.Id}",
                    Title = $"{DocumentService.KeyOf(doc.Number)} is waiting for your review", Body = $"{doc.Title} · the step \"{steps[a.CurrentStep].Name}\" was due {days} day(s) after it started.",
                };
                if (await router.ApplyAsync(n, ct)) { db.Notifications.Add(n); sent++; }
            }
            a.ReminderSent = true;
        }
        await db.SaveChangesAsync(ct);
        return sent;
    }

    // ------------------------------------------------------------------ helpers

    private static ConflictException Changed() => new("Someone else changed this document while you were editing. Reload it to see their changes.", "DOCUMENT_CHANGED");
    private void Touch(Document doc) { doc.Revision++; doc.UpdatedAt = clock.Now; doc.UpdatedBy = ctx.UserId; }

    private async Task SaveAsync(CancellationToken ct)
    {
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateConcurrencyException) { throw Changed(); }
    }
}
