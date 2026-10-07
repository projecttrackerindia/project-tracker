using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using Microsoft.EntityFrameworkCore;

namespace ProjectManagement.Application.Features.Documents;

public record ReviewItemDto(Guid ApprovalId, DocumentItemDto Document, string Step, string State, UserRefDto SubmittedBy, DateTime SubmittedAt, string Summary, DateTime? DueAt, bool Overdue);
public record DocumentInboxDto(IReadOnlyList<ReviewItemDto> ToReview, IReadOnlyList<ReviewItemDto> Submitted, IReadOnlyList<AccessRequestDto> AccessToDecide, IReadOnlyList<AccessRequestDto> MyAccessRequests, int Waiting);

/// <summary>Everything waiting on the signed-in person in one place: reviews to decide, their own submissions, access requests to answer and the ones they made.</summary>
public class DocumentInboxService(IAppDbContext db, AppClock clock, DocumentWorkflowService workflows, DocumentAccessRequestService requests, DocumentService documents)
{
    public async Task<DocumentInboxDto> GetAsync(CancellationToken ct = default)
    {
        var (toDecide, mine) = await workflows.InboxAsync(ct);
        var ids = toDecide.Concat(mine).Select(r => r.Approval.DocumentId).Distinct().ToList();
        var docs = (await documents.ListByIdsAsync(ids, ct)).ToDictionary(d => d.Id);
        var submitters = toDecide.Concat(mine).Select(r => r.Approval.SubmittedBy).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => submitters.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var now = clock.Now;
        List<ReviewItemDto> Build(IEnumerable<DocumentWorkflowService.InboxRow> rows) => rows.Where(r => docs.ContainsKey(r.Approval.DocumentId)).Select(r => new ReviewItemDto(r.Approval.Id, docs[r.Approval.DocumentId], r.StepName, r.Approval.State.ToString(),
            new UserRefDto(r.Approval.SubmittedBy, names.GetValueOrDefault(r.Approval.SubmittedBy) ?? "Former member"), r.Approval.SubmittedAt, r.Approval.Summary, r.DueAt, r.DueAt is { } d && d < now)).ToList();
        var review = Build(toDecide);
        var (decide, own) = await requests.InboxAsync(ct);
        return new DocumentInboxDto(review, Build(mine), decide, own, review.Count + decide.Count);
    }

}
