using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Work;

public record SupportResolutionDto(Guid WorkTaskId, int WorkVersion, string? Note, DateTime? ProposedAt, DateTime? AcceptedAt,
    bool Current, bool CanPropose, bool CanAccept, Guid? DocumentId, string? DocumentVersion);
public record ProposeSupportResolutionRequest(int WorkVersion, string Note, Guid? DocumentId = null);
public record AcceptSupportResolutionRequest(int WorkVersion);

/// <summary>Reuses operational work authorization and SLA lifecycle. Model output never accepts or completes work.</summary>
public class SupportResolutionService(IAppDbContext db, ICurrentContext ctx, AppClock clock, WorkTaskService work,
    DocumentService documents, PermissionService permissions, Recorder recorder)
{
    public async Task<SupportResolutionDto> GetAsync(Guid id, CancellationToken ct)
    {
        var task = await work.GetAsync(id, ct);
        var row = await db.WorkTasks.AsNoTracking().SingleAsync(t => t.Id == id && t.Kind == WorkTaskKind.Operational, ct);
        var current = row.Status == WorkTaskStatus.Completed && row.CompletedAt != null && row.ResolutionWorkVersion == row.Version;
        return new(id, row.Version, row.ResolutionNote, row.ResolutionProposedAt, current ? row.ResolutionAcceptedAt : null, current,
            task.Can.Edit && row.Status == WorkTaskStatus.Completed, current && row.ResolutionNote != null && row.ReporterId == ctx.RequireUserId() && row.ResolutionAcceptedAt == null,
            row.ResolutionDocumentId, row.ResolutionDocumentVersion);
    }

    public async Task<SupportResolutionDto> ProposeAsync(Guid id, ProposeSupportResolutionRequest req, CancellationToken ct)
    {
        await permissions.RequireModuleAsync(Modules.Work, AccessLevel.Edit, ct);
        var task = await work.GetAsync(id, ct);
        if (!task.Can.Edit) throw new ForbiddenException("You cannot propose a resolution for this work.");
        var note = (req.Note ?? "").Trim();
        if (note.Length is < 10 or > 8000) throw new ValidationException("note", "Describe the verified fix in 10 to 8000 characters.");
        string? documentVersion = null;
        if (req.DocumentId is { } documentId)
        {
            var doc = await documents.GetAsync(documentId, ct);
            if (doc.PublishedLabel is null || doc.HasUnpublishedChanges || doc.Item.Status == DocumentStatus.Archived)
                throw new ValidationException("documentId", "Link a published knowledge document without unpublished changes.");
            documentVersion = doc.PublishedLabel;
        }
        await using var tx = await db.Database.BeginOwnedTransactionAsync(ct);
        var row = await db.WorkTasks.SingleAsync(t => t.Id == id && t.Kind == WorkTaskKind.Operational, ct);
        if (row.Version != req.WorkVersion) throw new ConflictException("This work changed. Reload before proposing its resolution.", "SUPPORT_RESOLUTION_STALE");
        if (row.Status != WorkTaskStatus.Completed || row.CompletedAt is null)
            throw new ConflictException("Complete and verify the work before proposing its resolution.", "SUPPORT_NOT_COMPLETED");
        row.Version++; row.ResolutionWorkVersion = row.Version; row.ResolutionNote = note;
        row.ResolutionProposedAt = clock.Now; row.ResolutionProposedBy = ctx.RequireUserId();
        row.ResolutionAcceptedAt = null; row.ResolutionAcceptedBy = null;
        row.ResolutionDocumentId = req.DocumentId; row.ResolutionDocumentVersion = documentVersion;
        recorder.Audit("support.resolution_proposed", "WorkTask", id, null, new { row.Version, documentId = req.DocumentId, documentVersion });
        await db.SaveChangesAsync(ct); await tx.CommitIfOwnedAsync(ct);
        return await GetAsync(id, ct);
    }

    public async Task<SupportResolutionDto> AcceptAsync(Guid id, AcceptSupportResolutionRequest req, CancellationToken ct)
    {
        await work.GetAsync(id, ct);
        await using var tx = await db.Database.BeginOwnedTransactionAsync(ct);
        var row = await db.WorkTasks.SingleAsync(t => t.Id == id && t.Kind == WorkTaskKind.Operational, ct);
        if (row.ReporterId != ctx.RequireUserId()) throw new ForbiddenException("Only the person who raised this work can acknowledge its resolution.");
        if (row.Status != WorkTaskStatus.Completed || row.ResolutionNote == null || row.ResolutionWorkVersion != row.Version || row.Version != req.WorkVersion)
            throw new ConflictException("The proposed resolution is stale. Reload and verify the current work.", "SUPPORT_RESOLUTION_STALE");
        if (row.ResolutionAcceptedAt == null)
        {
            row.Version++; row.ResolutionWorkVersion = row.Version;
            row.ResolutionAcceptedAt = clock.Now; row.ResolutionAcceptedBy = ctx.RequireUserId();
            recorder.Audit("support.resolution_accepted", "WorkTask", id, null, new { row.Version, row.ResolutionDocumentId, row.ResolutionDocumentVersion });
            await db.SaveChangesAsync(ct);
        }
        await tx.CommitIfOwnedAsync(ct); return await GetAsync(id, ct);
    }
}
