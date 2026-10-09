using System.Net;
using ProjectManagement.Application.Features.Chat;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Features.Workspaces;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Ai;

public sealed record AiActionResult(string? Link, Guid? RecordId = null);

/// <summary>
/// Carries out a change the assistant proposed, after the person pressed Confirm. It goes through the same services as the app's own
/// screens, as the person, so their permissions, plan limits, validation, notifications and audit trail all apply exactly as if they had
/// made the change by hand.
/// </summary>
public class AiActionRunner(IAppDbContext db, ICurrentContext ctx, Recorder recorder, TaskService tasks, WorkTaskService workTasks, ActionItemService actionItems,
    ReminderService reminders, ChatService messages, ProjectService projects, WorkspaceService workspaces, DocumentService documents, IEmailSender email,
    ProjectManagement.Application.Features.ProjectMeetings.MeetingService meetings, ILogger<AiActionRunner> log)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };

    private async Task ClaimOriginalReminderAsync(JsonElement a, CancellationToken ct)
    {
        if (Str(a, "supersedesMessageId") is not { } source) return;
        if (!System.Guid.TryParse(source, out var id)) throw new ConflictException("The original reminder suggestion is invalid.", "AI_ACTION_HANDLED");
        var me = ctx.RequireUserId(); var tenant = ctx.RequireTenantId();
        var original = await db.AiMessages.AsNoTracking().Where(m => m.Id == id && m.UserId == me && m.TenantId == tenant && m.Role == "assistant")
            .Select(m => new { m.ActionsJson }).FirstOrDefaultAsync(ct) ?? throw new NotFoundException("Original reminder suggestion not found.");
        var all = JsonSerializer.Deserialize<List<AiProposal>>(original.ActionsJson ?? "[]", Json) ?? [];
        var index = all.FindIndex(p => p.Id == Str(a, "supersedesProposalId") && p.Kind == "reminder");
        if (index < 0 || all[index].Status != "proposed" || all.Any(p => p.Status == "running"))
            throw new ConflictException("The original reminder or another replacement was already handled. Check Reminders before trying again.", "AI_ACTION_HANDLED");
        all[index] = all[index] with { Status = "dismissed", Error = "Replaced by a confirmed reminder suggestion." };
        var updated = JsonSerializer.Serialize(all, Json);
        if (await db.AiMessages.Where(m => m.Id == id && m.TenantId == tenant && m.UserId == me && m.ActionsJson == original.ActionsJson)
            .ExecuteUpdateAsync(s => s.SetProperty(m => m.ActionsJson, updated), ct) != 1)
            throw new ConflictException("The original reminder is already being handled.", "AI_ACTION_HANDLED");
    }

    public async Task<AiActionResult> RunAsync(AiProposal p, CancellationToken ct, Guid? executionId = null)
    {
        using var doc = JsonDocument.Parse(p.PayloadJson);
        var a = doc.RootElement;
        switch (p.Kind)
        {
            case "create_project":
            {
                var type = Enum.Parse<ProjectType>(Str(a, "projectType") ?? "NewProject", true);
                var created = await projects.CreateAsync(new CreateProjectRequest(Str(a, "name")!, null, Str(a, "description"), Prio(a), null, Guid(a, "ownerId"), Guid(a, "teamId"), Date(a, "startDate"), Date(a, "dueDate"), null,
                    null, Guid(a, "projectGroupId"), type), ct);
                return new AiActionResult($"/projects/{created.Project.Id}");
            }
            case "invite_member":
            {
                await workspaces.InviteAsync(new InviteRequest(Str(a, "email")!, Enum.Parse<TenantRole>(Str(a, "role") ?? "Member", true)), ct);
                return new AiActionResult("/people/invitations");
            }
            case "update_work":
                return await UpdateWorkAsync(a, ct);
            case "update_project":
                return await UpdateProjectAsync(a, ct);
            case "create_task":
            {
                var projectId = await ProjectIdAsync(a, ct);
                decimal? hours = a.TryGetProperty("estimateHours", out var eh) && eh.ValueKind == JsonValueKind.Number ? eh.GetDecimal() : null;
                var t = await tasks.CreateAsync(projectId, new CreateTaskRequest(Str(a, "title")!, Str(a, "description"), null, Prio(a), Guid(a, "assigneeId"), Date(a, "startDate"), Date(a, "dueDate"), hours, null, null), ct);
                if (Str(a, "comment") is { } first) await tasks.AddCommentAsync(t.Id, new CreateCommentRequest(first, null, null), ct);
                return new AiActionResult($"/projects/{projectId}?task={t.Id}");
            }
            case "create_work":
            {
                var w = await workTasks.CreateAsync(new CreateWorkTaskRequest(Str(a, "title"), Str(a, "description"), Guid(a, "workTypeId"), Guid(a, "projectId") ?? (Str(a, "projectName") is null ? null : await ProjectIdAsync(a, ct)), Guid(a, "assigneeId"), Prio(a), null, null, Date(a, "dueDate")), ct);
                return new AiActionResult("/operations");
            }
            case "create_action_item":
            {
                var projectId = await ProjectIdAsync(a, ct);
                await actionItems.CreateAsync(projectId, new CreateActionItemRequest(Str(a, "title"), Str(a, "details"), Guid(a, "assigneeId"), Date(a, "dueDate"), Prio(a)), ct);
                return new AiActionResult($"/projects/{projectId}");
            }
            case "update_reminder":
            {
                var id = Guid(a, "reminderId") ?? throw new ValidationException("id", "Choose a saved reminder.");
                var list = await reminders.ListAsync(ct);
                var existing = list.Open.Concat(list.Sent).FirstOrDefault(r => r.Id == id && r.CanEdit)
                    ?? throw new NotFoundException("Reminder not available to edit.");
                await reminders.UpdateAsync(id,
                    new SaveReminderRequest(null, existing.Note, ReminderTarget.None, null, null,
                        new ReminderWhen(Str(a, "at"), Str(a, "timeZone"), null, null, existing.Recurrence), null, null), ct);
                return new AiActionResult("/reminders");
            }
            case "reminder":
            {
                await ClaimOriginalReminderAsync(a, ct);
                var target = Enum.TryParse<ReminderTarget>(Str(a, "targetType"), true, out var tt) ? tt : ReminderTarget.None;
                await reminders.CreateAsync(new SaveReminderRequest(Str(a, "title"), null, target, target == ReminderTarget.None ? null : Guid(a, "targetId"), Guid(a, "forUserId"),
                    new ReminderWhen(Str(a, "at"), Str(a, "timeZone"), null, null, null), null, null), ct);
                return new AiActionResult("/reminders");
            }
            case "send_message":
            {
                var recipient = Guid(a, "recipientId") ?? throw new ValidationException("recipient", "Choose a recipient.");
                var body = Str(a, "body") ?? throw new ValidationException("body", "Provide the approved message.");
                var receiptId = executionId ?? throw new ConflictException("A message requires an exact approved action identity.", "AI_ACTION_ID_REQUIRED");
                var conversation = await messages.OpenDirectAsync(new OpenDirectRequest(recipient), ct);
                var sent = await messages.SendAsync(conversation.Id, new SendMessageRequest(body, null), ct, receiptId);
                var stored = await db.ChatMessages.AsNoTracking().AnyAsync(m => m.Id == sent.Id && m.ConversationId == conversation.Id
                    && m.SenderId == ctx.UserId && m.Body == body && m.DeletedAt == null, ct);
                if (!stored || sent.Body != body) throw new ConflictException("The exact approved message could not be verified. Check chat before retrying.", "AI_MESSAGE_UNVERIFIED");
                return new AiActionResult($"/chat/{conversation.Id}", sent.Id);
            }
            case "send_report":
                await SendReportAsync(a, ct);
                return new AiActionResult(null);
            case "create_document":
            {
                IReadOnlyList<SectionInput>? sections = a.TryGetProperty("sections", out var secEl) && secEl.ValueKind == JsonValueKind.Array
                    ? secEl.EnumerateArray().Select(s => new SectionInput(Str(s, "key")!, Str(s, "content"))).ToList() : null;
                var tags = a.TryGetProperty("tags", out var tagsEl) && tagsEl.ValueKind == JsonValueKind.Array
                    ? tagsEl.EnumerateArray().Select(t => t.GetString()!).ToList() : null;
                var d = await documents.CreateAsync(new CreateDocumentRequest(Str(a, "title")!, Guid(a, "typeId")!.Value, Guid(a, "projectId"), Guid(a, "teamId"), null, tags, sections), ct);
                return new AiActionResult($"/documents/{d.Item.Id}");
            }
            case "start_meeting":
            {
                var projectId = Guid(a, "projectId")!.Value;
                var m = await meetings.StartNowAsync(projectId, new ProjectManagement.Application.Features.ProjectMeetings.StartMeetingRequest(Str(a, "title"), Guids(a, "participantUserIds")), ct);
                return new AiActionResult($"/projects/{projectId}?tab=meetings&meeting={m.Id}");
            }
            case "schedule_meeting":
            {
                var projectId = Guid(a, "projectId")!.Value;
                var m = await meetings.ScheduleAsync(projectId, new ProjectManagement.Application.Features.ProjectMeetings.ScheduleMeetingRequest(
                    Str(a, "title")!, Str(a, "description"), DateTimeOffset.Parse(Str(a, "startTime")!), DateTimeOffset.Parse(Str(a, "endTime")!), Str(a, "timeZone") ?? "UTC", Guids(a, "participantUserIds")), ct);
                return new AiActionResult($"/projects/{projectId}?tab=meetings&meeting={m.Id}");
            }
            default:
                throw new ValidationException("action", "This kind of suggestion is not supported.");
        }
    }

    /// <summary>The project a proposal is for: the one it named, or (when it was proposed together with that project) the one with that name, which exists by now.</summary>
    private async Task<Guid> ProjectIdAsync(JsonElement a, CancellationToken ct)
    {
        if (Guid(a, "projectId") is { } id) return id;
        var name = Str(a, "projectName") ?? throw new ValidationException("project", "Which project?");
        var found = await db.Projects.AsNoTracking().Where(p => p.Name.ToLower() == name.ToLower()).Select(p => (Guid?)p.Id).FirstOrDefaultAsync(ct);
        return found ?? throw new ValidationException("project", $"The project “{name}” does not exist yet. Confirm its creation first.");
    }

    private async Task<AiActionResult> UpdateProjectAsync(JsonElement a, CancellationToken ct)
    {
        var id = Guid(a, "id")!.Value;
        var cur = (await projects.GetAsync(id, ct)).Project;
        Priority? priority = Enum.TryParse<Priority>(Str(a, "priority"), true, out var pr) ? pr : null;
        ProjectStatus? status = Enum.TryParse<ProjectStatus>(Str(a, "status"), true, out var ps) ? ps : null;
        await projects.UpdateAsync(id, new UpdateProjectRequest(Str(a, "name") ?? cur.Name, Str(a, "description") ?? cur.Description, priority ?? cur.Priority, status ?? cur.Status,
            Guid(a, "ownerId") ?? cur.Owner?.Id, cur.TeamId, Date(a, "startDate") ?? cur.StartDate, Date(a, "dueDate") ?? cur.DueDate, cur.Version, cur.EnforceDependencies, cur.ProjectGroupId,
            Str(a, "reason")), ct);
        return new AiActionResult($"/projects/{id}");
    }

    private async Task<AiActionResult> UpdateWorkAsync(JsonElement a, CancellationToken ct)
    {
        var id = Guid(a, "id")!.Value;
        var assigneeId = Guid(a, "assigneeId"); var unassign = a.TryGetProperty("unassign", out var u) && u.ValueKind == JsonValueKind.True;
        var due = Date(a, "dueDate"); var statusName = Str(a, "statusName"); var comment = Str(a, "comment");
        Priority? priority = Enum.TryParse<Priority>(Str(a, "priority"), true, out var pr) ? pr : null;
        if (Str(a, "target") == "actionitem")
        {
            var projectId = Guid(a, "projectId")!.Value;
            var cur = (await actionItems.ListAsync(projectId, ct)).First(i => i.Id == id);
            var status = statusName is null ? cur.Status : Enum.Parse<ActionItemStatus>(statusName, true);
            await actionItems.UpdateAsync(projectId, id, new UpdateActionItemRequest(Str(a, "newTitle") ?? cur.Title, Str(a, "newDescription") ?? cur.Details,
                unassign ? null : assigneeId ?? cur.Assignee?.Id, due ?? cur.DueDate, priority ?? cur.Priority, status), ct);
            return new AiActionResult(ActionItemService.LinkOf(projectId, id));
        }
        if (Str(a, "target") == "work")
        {
            var w = await workTasks.GetAsync(id, ct);
            var status = statusName is null ? w.Status : Enum.Parse<WorkTaskStatus>(statusName, true);
            await workTasks.UpdateAsync(id, new UpdateWorkTaskRequest(Str(a, "newTitle") ?? w.Title, Str(a, "newDescription") ?? w.Description, w.WorkTypeId, w.RelatedProject?.Id, unassign ? null : assigneeId ?? w.Assignee?.Id, priority ?? w.Priority,
                status, Date(a, "startDate") ?? w.StartDate, due ?? w.DueDate, w.Version), ct);
            if (comment is not null) await workTasks.AddCommentAsync(id, new WorkCommentRequest(comment), ct);
            return new AiActionResult($"/operations?task={id}");
        }
        var t = (await tasks.GetAsync(id, ct)).Task;
        var statusId = t.StatusId;
        if (statusName is not null)
            statusId = await db.WorkflowStatuses.AsNoTracking().Where(x => x.ProjectId == t.ProjectId && x.Name == statusName).Select(x => x.Id).FirstOrDefaultAsync(ct) is var sid && sid != System.Guid.Empty
                ? sid : throw new ValidationException("status", $"The status “{statusName}” no longer exists on this project.");
        decimal? newHours = a.TryGetProperty("estimateHours", out var eh) && eh.ValueKind == JsonValueKind.Number ? eh.GetDecimal() : null;
        await tasks.UpdateAsync(id, new UpdateTaskRequest(Str(a, "newTitle") ?? t.Title, Str(a, "newDescription") ?? t.Description, statusId, priority ?? t.Priority, unassign ? null : assigneeId ?? t.Assignee?.Id, Date(a, "startDate") ?? t.StartDate, due ?? t.DueDate,
            newHours ?? t.EstimatedHours, t.ActualHours, t.Labels.Select(l => l.Id).ToList(), t.Version, t.MilestoneId, t.StageId, Str(a, "reason")), ct);
        if (comment is not null) await tasks.AddCommentAsync(id, new CreateCommentRequest(comment, null, null), ct);
        return new AiActionResult($"/projects/{t.ProjectId}?task={id}");
    }

    private async Task SendReportAsync(JsonElement a, CancellationToken ct)
    {
        var tid = ctx.RequireTenantId(); var me = ctx.RequireUserId();
        var ids = a.TryGetProperty("recipientIds", out var arr) && arr.ValueKind == JsonValueKind.Array ? arr.EnumerateArray().Select(x => System.Guid.Parse(x.GetString()!)).ToList() : [me];
        // The people are checked again now: only active, non-guest members of this workspace, whatever was proposed earlier.
        var people = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && ids.Contains(m.UserId) && m.Role != TenantRole.Guest && m.User!.IsActive).Select(m => new { m.User!.Email, m.User.DisplayName }).ToListAsync(ct);
        if (people.Count == 0) throw new ConflictException("None of the recipients can receive the report any more.", "AI_NO_RECIPIENTS");
        var sender = await db.Users.AsNoTracking().Where(u => u.Id == me).Select(u => u.DisplayName).FirstAsync(ct);
        var workspace = await db.Tenants.AsNoTracking().Where(t => t.Id == tid).Select(t => t.Name).FirstAsync(ct);
        var title = Str(a, "title")!; var body = Str(a, "body")!;
        var sent = 0;
        foreach (var person in people)
        {
            var message = new EmailMessage(person.Email, $"{title} — {workspace}", ReportMail.Html(title, body, sender, workspace), $"{title}\n\n{body}\n\nPrepared with the AI assistant for {sender}. Check it before relying on it.");
            if (await email.TrySendAsync(message, log, ct)) sent++;
        }
        if (sent == 0) throw new ConflictException("The email could not be sent. Try again in a moment.", "AI_EMAIL_FAILED");
        recorder.Audit("ai.report_sent", "AiAssistant", null, null, new { title, recipients = sent });
    }

    private static string? Str(JsonElement a, string n) => a.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    private static Guid? Guid(JsonElement a, string n) => Str(a, n) is { } s && System.Guid.TryParse(s, out var g) ? g : null;
    private static List<Guid>? Guids(JsonElement a, string n) => a.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.Array ? v.EnumerateArray().Select(x => System.Guid.Parse(x.GetString()!)).ToList() : null;
    private static DateOnly? Date(JsonElement a, string n) => DateOnly.TryParse(Str(a, n), out var d) ? d : null;
    private static Priority Prio(JsonElement a) => Enum.TryParse<Priority>(Str(a, "priority"), true, out var p) ? p : Priority.Medium;
}

/// <summary>A written report as an email. Everything the model wrote is HTML-encoded first; only a few Markdown shapes are then turned into markup.</summary>
public static class ReportMail
{
    private static string E(string s) => WebUtility.HtmlEncode(s);
    private static string Inline(string s) => Regex.Replace(E(s), @"\*\*(.+?)\*\*", "<b>$1</b>");

    public static string Html(string title, string markdown, string sender, string workspace)
    {
        var sb = new StringBuilder();
        sb.Append("<div style=\"font-family:Segoe UI,Arial,sans-serif;max-width:680px;margin:0 auto;color:#1f2430;line-height:1.55\">");
        sb.Append($"<h2 style=\"margin:0 0 4px\">{E(title)}</h2><div style=\"color:#6b7280;font-size:13px;margin-bottom:18px\">{E(workspace)}</div>");
        var inList = false; var inTable = false;
        void CloseBlocks() { if (inList) { sb.Append("</ul>"); inList = false; } if (inTable) { sb.Append("</table>"); inTable = false; } }
        foreach (var raw in markdown.Replace("\r", "").Split('\n'))
        {
            var line = raw.TrimEnd();
            if (Regex.IsMatch(line, @"^\s*[-*•]\s+") || Regex.IsMatch(line, @"^\s*\d+[.)]\s+"))
            {
                if (inTable) { sb.Append("</table>"); inTable = false; }
                if (!inList) { sb.Append("<ul style=\"padding-left:20px\">"); inList = true; }
                sb.Append("<li>").Append(Inline(Regex.Replace(line, @"^\s*([-*•]|\d+[.)])\s+", ""))).Append("</li>");
                continue;
            }
            if (line.TrimStart().StartsWith('|'))
            {
                if (Regex.IsMatch(line, @"^\s*\|[\s:|-]+\|?\s*$")) continue;   // the --- separator row
                if (inList) { sb.Append("</ul>"); inList = false; }
                if (!inTable) { sb.Append("<table style=\"border-collapse:collapse;margin:8px 0;font-size:14px\">"); inTable = true; }
                var cells = line.Trim().Trim('|').Split('|').Select(c => c.Trim());
                sb.Append("<tr>").Append(string.Concat(cells.Select(c => $"<td style=\"border:1px solid #e5e7eb;padding:5px 9px\">{Inline(c)}</td>"))).Append("</tr>");
                continue;
            }
            CloseBlocks();
            if (string.IsNullOrWhiteSpace(line)) continue;
            var h = Regex.Match(line, @"^(#{1,4})\s+(.*)$");
            if (h.Success) sb.Append($"<h{h.Groups[1].Length + 2} style=\"margin:18px 0 6px\">{Inline(h.Groups[2].Value)}</h{h.Groups[1].Length + 2}>");
            else sb.Append($"<p style=\"margin:8px 0\">{Inline(line)}</p>");
        }
        CloseBlocks();
        sb.Append($"<hr style=\"border:none;border-top:1px solid #e5e7eb;margin:24px 0 10px\"><div style=\"color:#6b7280;font-size:12px\">Prepared with the AI assistant for {E(sender)}. Check it before relying on it.</div></div>");
        return sb.ToString();
    }
}
