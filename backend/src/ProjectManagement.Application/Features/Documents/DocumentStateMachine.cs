using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Documents;

/// <summary>Everything that can change a document's status.</summary>
public enum DocAction { Submit, Withdraw, ApproveFinal, RequestChanges, Publish, Archive, Reopen, Edit }

/// <summary>
/// The one place that says which status changes are allowed. <c>Next</c> answers "from this status, after this action, which status?" or null when the
/// action is not allowed there. With a workflow, a document is published only from Approved; without one (Free plan, or no workflow set up) the owner
/// publishes straight from Draft or Published.
/// </summary>
public static class DocumentStateMachine
{
    public static DocumentStatus? Next(DocumentStatus from, DocAction action, bool hasPublished, bool workflow)
    {
        var back = hasPublished ? DocumentStatus.Published : DocumentStatus.Draft;
        return (from, action) switch
        {
            (DocumentStatus.Draft or DocumentStatus.ChangesRequested or DocumentStatus.Published, DocAction.Submit) when workflow => DocumentStatus.InReview,
            (DocumentStatus.InReview or DocumentStatus.Approved, DocAction.Withdraw) => back,
            (DocumentStatus.InReview, DocAction.ApproveFinal) => DocumentStatus.Approved,
            (DocumentStatus.InReview, DocAction.RequestChanges) => DocumentStatus.ChangesRequested,
            (DocumentStatus.Approved, DocAction.Publish) when workflow => DocumentStatus.Published,
            (DocumentStatus.Draft or DocumentStatus.Published, DocAction.Publish) when !workflow => DocumentStatus.Published,
            (DocumentStatus.Draft or DocumentStatus.Published or DocumentStatus.ChangesRequested or DocumentStatus.Approved, DocAction.Archive) => DocumentStatus.Archived,
            (DocumentStatus.Archived, DocAction.Reopen) => back,
            // Changing the words of a document that is being reviewed, or has been approved, voids the review.
            (DocumentStatus.InReview or DocumentStatus.Approved, DocAction.Edit) => back == DocumentStatus.Published ? DocumentStatus.Published : DocumentStatus.Draft,
            (DocumentStatus.Draft or DocumentStatus.ChangesRequested or DocumentStatus.Published, DocAction.Edit) => from,
            _ => null,
        };
    }
}
