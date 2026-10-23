using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Application.Features.Chat;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Application.Features.Vault;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>
/// Carries out the Home proposals of <see cref="AiHomeTools"/> once the person pressed Confirm, through the same services as the screens and
/// as the person, so every permission, lock, notification and audit entry applies as if they had done it by hand. Each result is checked
/// against what was approved before it is reported done.
/// </summary>
public class AiHomeActions(IAppDbContext db, ICurrentContext ctx, AgentReviewService review, TimesheetApprovalService timesheets, NotificationService notifications,
    ChatService chat, DocumentService documents, DocumentCommentService comments, PortfolioBoardService portfolio, VaultService vault, AgentFollowUpService followUps,
    ProjectManagement.Application.Features.Mailbox.MailboxService mail)
{
    private static string? Str(JsonElement a, string n) => a.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    private static Guid Id(JsonElement a, string n) => Guid.TryParse(Str(a, n), out var g) ? g : throw new ValidationException(n, "The approved suggestion is incomplete. Ask again.");

    /// <summary>Runs a Home proposal, or returns null when <paramref name="kind"/> is not one of them.</summary>
    public async Task<AiActionResult?> RunAsync(string kind, JsonElement a, Guid? executionId, CancellationToken ct)
    {
        switch (kind)
        {
            case "decide_agent_proposal":
            {
                var id = Id(a, "findingId");
                var projectId = Id(a, "projectId");
                if (Str(a, "decision") == "approve")
                {
                    var done = await review.ApproveAsync(id, null, ct);
                    if (done.Status != AgentFindingStatus.Applied) throw new ConflictException(done.Error ?? "The proposal could not be carried out. Open it in the project's Agent tab.", "AI_ACTION_UNVERIFIED");
                    return new AiActionResult(done.AppliedEntityId is { } made && done.TaskId is null && done.Kind == AgentFindingKind.CreateTask ? $"/projects/{projectId}?task={made}"
                        : done.TaskId is { } t ? $"/projects/{projectId}?task={t}" : $"/projects/{projectId}?tab=agent", done.AppliedEntityId ?? id);
                }
                var dismissed = await review.DismissAsync(id, ct, Str(a, "reason"));
                if (dismissed.Status != AgentFindingStatus.Dismissed) throw new ConflictException("The proposal could not be dismissed.", "AI_ACTION_UNVERIFIED");
                return new AiActionResult($"/projects/{projectId}?tab=agent", id);
            }
            case "review_timesheet":
            {
                var id = Id(a, "id");
                var note = Str(a, "note");
                var week = Str(a, "decision") == "approve"
                    ? await timesheets.ApproveAsync(id, new ReviewTimesheetRequest(note), ct)
                    : await timesheets.RejectAsync(id, new ReviewTimesheetRequest(note), ct);
                return new AiActionResult($"/timesheet/approvals?week={week.WeekStart:yyyy-MM-dd}", id);
            }
            case "submit_week":
            {
                var start = DateOnly.Parse(Str(a, "weekStart")!, System.Globalization.CultureInfo.InvariantCulture);
                var week = await timesheets.SubmitAsync(new SubmitTimesheetRequest(start, Str(a, "note")), ct);
                if (week.Status != "Submitted") throw new ConflictException("The week could not be verified as submitted. Check the timesheet.", "AI_ACTION_UNVERIFIED");
                return new AiActionResult($"/timesheet?week={week.WeekStart:yyyy-MM-dd}", week.Id);
            }
            case "clear_notification":
            {
                var id = Id(a, "id");
                if (Str(a, "action") == "done") await notifications.SetArchivedAsync(id, true, ct);
                else
                {
                    var until = a.TryGetProperty("until", out var u) && u.ValueKind == JsonValueKind.String ? u.GetDateTime() : throw new ValidationException("until", "When should it come back?");
                    await notifications.SnoozeAsync(id, DateTime.SpecifyKind(until, DateTimeKind.Utc), ct);
                }
                return new AiActionResult("/notifications", id);
            }
            case "chat_reply":
            {
                var conversationId = Id(a, "conversationId");
                Guid? root = Guid.TryParse(Str(a, "threadRootId"), out var r) ? r : null;
                var body = Str(a, "body") ?? throw new ValidationException("body", "Provide the approved message.");
                var receipt = executionId ?? throw new ConflictException("A message requires an exact approved action identity.", "AI_ACTION_ID_REQUIRED");
                var sent = await chat.SendAsync(conversationId, new SendMessageRequest(body, null, null, root), ct, receipt);
                var me = ctx.RequireUserId();
                if (!await db.ChatMessages.AsNoTracking().AnyAsync(m => m.Id == sent.Id && m.ConversationId == conversationId && m.SenderId == me && m.ThreadRootId == root && m.DeletedAt == null, ct))
                    throw new ConflictException("The message could not be verified. Check the chat before trying again.", "AI_MESSAGE_UNVERIFIED");
                return new AiActionResult(root is { } t ? $"/chat/{conversationId}?thread={t}&m={sent.Id}" : $"/chat/{conversationId}?m={sent.Id}", sent.Id);
            }
            case "edit_page":
                return await EditPageAsync(a, ct);
            case "page_comment":
            {
                var documentId = Id(a, "documentId");
                var made = await comments.AddAsync(documentId, new AddCommentRequest(Str(a, "body") ?? throw new ValidationException("body", "Write the comment.")), ct);
                return new AiActionResult($"/documents/{documentId}", made.Id);
            }
            case "apply_portfolio_option":
            {
                var projectId = Id(a, "projectId");
                var applied = await portfolio.ApplyAsync(projectId, new ApplyDecisionRequest(Str(a, "option") ?? throw new ValidationException("option", "Which option?")), ct);
                if (applied.Proposals == 0) throw new ConflictException("Nothing could be proposed.", "AI_ACTION_UNVERIFIED");
                return new AiActionResult($"/projects/{projectId}?tab=agent", projectId);
            }
            case "vault_request":
            {
                var reason = Str(a, "reason");
                var minutes = a.TryGetProperty("minutes", out var m) && m.ValueKind == JsonValueKind.Number ? m.GetInt32() : 0;
                switch (Str(a, "kind"))
                {
                    case "join":
                    {
                        var access = Enum.TryParse<VaultAccess>(Str(a, "access"), out var x) ? x : VaultAccess.View;
                        var made = await vault.RequestCollectionAsync(Id(a, "collectionId"), new VaultRequestInput(reason, minutes, access), ct);
                        return new AiActionResult("/vault?view=requests", made.Id);
                    }
                    case "use":
                    {
                        var made = await vault.RequestRevealAsync(Id(a, "itemId"), new VaultRequestInput(reason, minutes), ct);
                        return new AiActionResult("/vault?view=requests", made.Id);
                    }
                    case "rotate":
                    {
                        var item = await vault.RequestRotationAsync(Id(a, "itemId"), new VaultRotationRequest(reason), ct);
                        return new AiActionResult($"/vault?item={item.Id}", item.Id);
                    }
                    default: throw new ValidationException("kind", "This kind of vault request is not supported.");
                }
            }
            case "vault_share":
            {
                var collectionId = Id(a, "collectionId");
                var userId = Id(a, "userId");
                var access = Enum.Parse<VaultAccess>(Str(a, "access") ?? "View");
                DateTime? until = a.TryGetProperty("until", out var u) && u.ValueKind == JsonValueKind.String ? DateTime.SpecifyKind(u.GetDateTime(), DateTimeKind.Utc) : null;
                var saved = await vault.SharePersonAsync(collectionId, userId, access, until, ct);
                if (saved.Shares is { } shares && !shares.Any(s => s.PrincipalType == VaultPrincipal.User && s.PrincipalId == userId && s.Access == access))
                    throw new ConflictException("The new access could not be verified. Check the collection's sharing.", "AI_ACTION_UNVERIFIED");
                return new AiActionResult($"/vault?c={collectionId}", collectionId);
            }
            case "answer_check_in":
            {
                var id = Id(a, "commitmentId");
                DateOnly? newDate = DateOnly.TryParse(Str(a, "newDate"), System.Globalization.CultureInfo.InvariantCulture, out var nd) ? nd : null;
                var answered = await followUps.AnswerAsync(id, new AgentCheckInRequest(Str(a, "answer"), Str(a, "note"), newDate), ct);
                return new AiActionResult($"/projects/{answered.ProjectId}", id);
            }
            case "mail_reply":
            {
                var sent = await mail.SendAsync(new ProjectManagement.Application.Features.Mailbox.MailSendRequest(Str(a, "account")!, Str(a, "messageId"), "inbox",
                    a.TryGetProperty("replyAll", out var all) && all.ValueKind == JsonValueKind.True, null, null, null, Str(a, "body") ?? throw new ValidationException("body", "Write the reply."), true), ct);
                if (!sent.Accepted) throw new ConflictException("The mail server did not accept the reply. Check Mailbox before trying again.", "AI_ACTION_UNVERIFIED");
                return new AiActionResult("/mailbox", null);
            }
            case "mail_forward":
            {
                var sent = await mail.ForwardAsync(new ProjectManagement.Application.Features.Mailbox.MailForwardRequest(Str(a, "account")!, "inbox", Str(a, "messageId") ?? throw new ValidationException("messageId", "Choose the message."),
                    Str(a, "to") ?? throw new ValidationException("to", "Add a recipient."), Str(a, "cc"), Str(a, "note"), true), ct);
                if (!sent.Accepted) throw new ConflictException("The mail server did not accept the message. Check Mailbox before trying again.", "AI_ACTION_UNVERIFIED");
                return new AiActionResult("/mailbox", null);
            }
            default:
                return null;
        }
    }

    /// <summary>
    /// Adds to or rewrites one text section. The real values are loaded first (as an editor opening the page would), so a masked copy is never
    /// saved over them. Adding goes onto the latest text; rewriting needs the page unchanged since the suggestion was made.
    /// </summary>
    private async Task<AiActionResult> EditPageAsync(JsonElement a, CancellationToken ct)
    {
        var id = Id(a, "documentId");
        var key = Str(a, "sectionKey") ?? throw new ValidationException("section", "Which section?");
        var replace = Str(a, "mode") == "replace";
        var content = Str(a, "content") ?? throw new ValidationException("content", "Nothing to write.");
        var proposedAt = a.TryGetProperty("revision", out var rev) && rev.ValueKind == JsonValueKind.Number ? rev.GetInt32() : -1;
        var current = await documents.GetAsync(id, ct);
        if (!current.Can.Edit) throw new ForbiddenException("You can't edit this page.", "PERMISSION_DENIED");
        if (current.MaskedCount > 0) current = await documents.RevealAsync(id, new DocumentRevealRequest("Editing with the assistant", "edit"), ct);
        if (replace && current.Revision != proposedAt)
            throw new ConflictException("The page changed after this suggestion. Ask again so the new text is based on the latest version.", "VERSION_CONFLICT");
        var section = current.Sections.FirstOrDefault(s => s.Key == key && s.Kind == SectionKind.RichText)
            ?? throw new ValidationException("section", "That section is not on the page any more.");
        var added = AiToolbox.MarkdownToDoc(content);
        var next = replace ? added : Append(section.Content, added);
        var saved = await documents.SaveSectionsAsync(id, new SaveSectionsRequest(current.Revision, [new SectionInput(key, next)]), ct);
        if (saved.Revision == current.Revision && saved.Sections.FirstOrDefault(s => s.Key == key)?.Content == section.Content)
            throw new ConflictException("The change could not be verified. Open the page before trying again.", "AI_ACTION_UNVERIFIED");
        return new AiActionResult($"/documents/{id}", id);
    }

    /// <summary>The section's blocks, then the new ones (an empty section is simply replaced).</summary>
    public static string Append(string existing, string addition)
    {
        JsonObject? before = null;
        try { before = JsonNode.Parse(string.IsNullOrWhiteSpace(existing) ? "{}" : existing) as JsonObject; } catch (JsonException) { }
        var add = JsonNode.Parse(addition)!.AsObject();
        if (before?["content"] is not JsonArray blocks || blocks.Count == 0 || blocks.All(Empty)) return addition;
        var merged = new JsonArray();
        foreach (var b in blocks) merged.Add(b?.DeepClone());
        foreach (var b in add["content"]!.AsArray()) merged.Add(b?.DeepClone());
        before["content"] = merged;
        return before.ToJsonString();
    }

    private static bool Empty(JsonNode? block) => block is JsonObject o && (string?)o["type"] == "paragraph" && (o["content"] is not JsonArray c || c.Count == 0);
}
