using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Attendance;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.Issues;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.ProjectMeetings;
using ProjectManagement.Application.Features.Quality;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>
/// Carries out the proposals of <see cref="AiPowerTools"/> once the person pressed Confirm, through the same services as the screens and as
/// the person, so permissions, locks, validation, notifications and the audit trail apply exactly as if they had done it by hand. Where a
/// screen's controller adds a module gate the service itself does not, it is checked here too, so the assistant is never a way around it.
/// What Undo needs is recorded with the result; <see cref="UndoAsync"/> reverses it through the same services.
/// </summary>
public class AiPowerActions(IAppDbContext db, ICurrentContext ctx, PermissionService permissions, TaskService tasks, WorkTaskService workTasks, TimeService time,
    AttendanceService attendance, IssueService issues, MeetingService meetings, QualityService quality, DocumentWorkflowService workflows, MeetConnectService connect)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };

    /// <summary>Kinds whose result can be reversed safely within the undo window.</summary>
    public static bool Supports(string kind) => kind is "add_comment" or "create_issue" or "update_issue" or "update_time_entry" or "reschedule_meeting" or "update_meeting";

    public static string Describe(string kind) => kind switch
    {
        "add_comment" => "Deletes the comment",
        "create_issue" => "Deletes the reported issue",
        "update_issue" => "Puts back the earlier status and assignee",
        "update_time_entry" => "Puts back the earlier minutes, day and note",
        "reschedule_meeting" => "Moves the meeting back (attendees are told again)",
        "update_meeting" => "Puts back the earlier title and agenda",
        _ => "",
    };

    private static string? Str(JsonElement a, string n) => a.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    private static Guid Id(JsonElement a, string n) => Guid.TryParse(Str(a, n), out var g) ? g : throw new ValidationException(n, "The approved suggestion is incomplete. Ask again.");
    private static Guid? OptId(JsonElement a, string n) => Guid.TryParse(Str(a, n), out var g) ? g : null;
    private static bool True(JsonElement a, string n) => a.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.True;

    private async Task RequireLevelAsync(string module, int level, CancellationToken ct)
    {
        if (await permissions.LevelAsync(module, ct) < level) throw new ForbiddenException("Your role does not allow this.", "PERMISSION_DENIED");
    }

    /// <summary>Runs one of these proposals, or returns null when <paramref name="kind"/> is not one of them.</summary>
    public async Task<AiActionResult?> RunAsync(string kind, JsonElement a, CancellationToken ct)
    {
        switch (kind)
        {
            case "add_comment":
            {
                var id = Id(a, "id"); var body = Str(a, "body") ?? throw new ValidationException("body", "Write the comment.");
                if (Str(a, "target") == "Operational")
                {
                    await RequireLevelAsync(Modules.Work, AccessLevel.Edit, ct);
                    var made = await workTasks.AddCommentAsync(id, new WorkCommentRequest(body), ct);
                    return new AiActionResult($"/operations?task={id}", made.Id, JsonSerializer.Serialize(new { target = "Operational", itemId = id, commentId = made.Id }, Json));
                }
                await RequireLevelAsync(Modules.Tasks, AccessLevel.Edit, ct);
                var c = await tasks.AddCommentAsync(id, new CreateCommentRequest(body, null, null), ct);
                var projectId = await db.Tasks.AsNoTracking().Where(t => t.Id == id).Select(t => t.ProjectId).FirstOrDefaultAsync(ct);
                return new AiActionResult($"/projects/{projectId}?task={id}", c.Id, JsonSerializer.Serialize(new { target = "Task", itemId = id, commentId = c.Id }, Json));
            }
            case "create_issue":
            {
                await RequireLevelAsync(Modules.Projects, AccessLevel.View, ct); await RequireLevelAsync(Modules.Tasks, AccessLevel.View, ct);
                var projectId = Id(a, "projectId");
                Priority? severity = Enum.TryParse<Priority>(Str(a, "severity"), true, out var s) ? s : null;
                var made = await issues.CreateAsync(projectId, new CreateIssueRequest(null, Str(a, "title"), Str(a, "details"), severity, OptId(a, "assigneeId")), ct);
                return new AiActionResult($"/projects/{projectId}?issue={made.Issue.Id}", made.Issue.Id, JsonSerializer.Serialize(new { projectId, issueId = made.Issue.Id }, Json));
            }
            case "update_issue":
            {
                await RequireLevelAsync(Modules.Projects, AccessLevel.View, ct); await RequireLevelAsync(Modules.Tasks, AccessLevel.View, ct);
                var projectId = Id(a, "projectId"); var issueId = Id(a, "issueId");
                var before = (await issues.GetAsync(projectId, issueId, ct)).Issue;
                if (True(a, "setAssignee")) await issues.AssignAsync(projectId, issueId, new AssignIssueRequest(True(a, "unassign") ? null : OptId(a, "assigneeId")), ct);
                if (Enum.TryParse<IssueStatus>(Str(a, "status"), true, out var to)) await issues.ChangeStatusAsync(projectId, issueId, new ChangeIssueStatusRequest(to, Str(a, "note")), ct);
                return new AiActionResult($"/projects/{projectId}?issue={issueId}", issueId,
                    JsonSerializer.Serialize(new { projectId, issueId, status = before.Status, assigneeId = before.Assignee?.Id }, Json));
            }
            case "update_time_entry":
            {
                var id = Id(a, "entryId");
                var before = await db.TimeEntries.AsNoTracking().Where(e => e.Id == id).Select(e => new { e.Minutes, e.WorkDate, e.Note }).FirstOrDefaultAsync(ct)
                    ?? throw new NotFoundException("Time entry not found.");
                var minutes = a.GetProperty("minutes").GetInt32();
                var date = DateOnly.Parse(Str(a, "workDate")!);
                var saved = await time.UpdateAsync(id, new UpdateTimeRequest(minutes, date, Str(a, "note")), ct);
                return new AiActionResult($"/timesheet?week={TimesheetApprovalService.WeekOf(saved.WorkDate):yyyy-MM-dd}", id,
                    JsonSerializer.Serialize(new { entryId = id, minutes = before.Minutes, workDate = before.WorkDate, note = before.Note }, Json));
            }
            case "check_in":
            {
                var day = await attendance.CheckInAsync(new CheckInRequest(Str(a, "mode"), Str(a, "place"), Str(a, "note"), "web"), ct);
                return new AiActionResult("/attendance", day.Id);
            }
            case "check_out":
            {
                var done = await attendance.CheckOutAsync(new CheckOutRequest(Str(a, "note")), ct);
                return new AiActionResult("/attendance", done.Day.Id);
            }
            case "reschedule_meeting":
            {
                var id = Id(a, "meetingId");
                var before = await meetings.GetAsync(id, ct);
                await meetings.RescheduleAsync(id, new RescheduleMeetingRequest(DateTimeOffset.Parse(Str(a, "startTime")!), DateTimeOffset.Parse(Str(a, "endTime")!)), ct);
                return new AiActionResult(MeetingReminders.MeetLink(id, false), id, JsonSerializer.Serialize(new { meetingId = id, startTime = before.StartTime, endTime = before.EndTime }, Json));
            }
            case "update_meeting":
            {
                var id = Id(a, "meetingId");
                var before = await meetings.GetAsync(id, ct);
                await meetings.UpdateDetailsAsync(id, new UpdateMeetingDetailsRequest(Str(a, "title") ?? before.Title, Str(a, "description")), ct);
                return new AiActionResult(MeetingReminders.MeetLink(id, false), id, JsonSerializer.Serialize(new { meetingId = id, title = before.Title, description = before.Description }, Json));
            }
            case "capture_action_item":
            {
                // The same service as the meeting page's capture line, as the person: the item is theirs, with the meeting as its source.
                DateOnly? due = DateOnly.TryParse(Str(a, "dueDate"), System.Globalization.CultureInfo.InvariantCulture, out var dd) ? dd : null;
                var made = await connect.CaptureAsync(Str(a, "meetingRef") ?? "", new CaptureActionItemRequest(Str(a, "text"), null, null, OptId(a, "assigneeId"), due), ct);
                return new AiActionResult(ActionItemService.LinkOf(made.Item.ProjectId, made.Item.Id), made.Item.Id);
            }
            case "create_test_case":
            {
                await RequireLevelAsync(Modules.Work, AccessLevel.Edit, ct);
                var made = await quality.CreateCaseAsync(new UpsertTestCaseRequest(Str(a, "title"), Str(a, "steps"), Str(a, "expected"), Str(a, "priority"), null, OptId(a, "projectId")), ct);
                return new AiActionResult($"/quality?case={made.Id}", made.Id);
            }
            case "record_test_result":
            {
                await RequireLevelAsync(Modules.Work, AccessLevel.Edit, ct);
                var made = await quality.SetResultAsync(Id(a, "runId"), Id(a, "caseId"), new SetTestResultRequest(Str(a, "status"), Str(a, "actual")), ct);
                return new AiActionResult($"/quality?run={made.RunId}", made.Id);
            }
            case "decide_document_review":
            {
                await RequireLevelAsync(Modules.Documents, AccessLevel.View, ct);
                var id = Id(a, "documentId");
                var req = new DecideRequest(Str(a, "comment"));
                if (Str(a, "decision") == "approve") await workflows.ApproveAsync(id, req, ct);
                else await workflows.RequestChangesAsync(id, req, ct);
                return new AiActionResult($"/documents/{id}", id);
            }
            default:
                return null;
        }
    }

    /// <summary>Reverses one of these results, from what <see cref="RunAsync"/> recorded, through the same services and the person's own rights.</summary>
    public async Task UndoAsync(AiProposal p, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(p.UndoJson)) throw new ConflictException("What this change did was not recorded, so it cannot be undone here. Change it back by hand.", "AI_UNDO_UNAVAILABLE");
        using var doc = JsonDocument.Parse(p.UndoJson);
        var u = doc.RootElement;
        switch (p.Kind)
        {
            case "add_comment":
                if (Str(u, "target") == "Operational") await workTasks.DeleteCommentAsync(Id(u, "itemId"), Id(u, "commentId"), ct);
                else await tasks.DeleteCommentAsync(Id(u, "commentId"), ct);
                return;
            case "create_issue":
                await issues.DeleteAsync(Id(u, "projectId"), Id(u, "issueId"), ct);
                return;
            case "update_issue":
            {
                var projectId = Id(u, "projectId"); var issueId = Id(u, "issueId");
                var now = (await issues.GetAsync(projectId, issueId, ct)).Issue;
                var assignee = OptId(u, "assigneeId");
                if (now.Assignee?.Id != assignee) await issues.AssignAsync(projectId, issueId, new AssignIssueRequest(assignee), ct);
                if (Enum.TryParse<IssueStatus>(Str(u, "status"), true, out var was) && was != now.Status)
                    await issues.ChangeStatusAsync(projectId, issueId, new ChangeIssueStatusRequest(was, "Undo of a change made with the assistant"), ct);
                return;
            }
            case "update_time_entry":
                await time.UpdateAsync(Id(u, "entryId"), new UpdateTimeRequest(u.GetProperty("minutes").GetInt32(), DateOnly.Parse(Str(u, "workDate")!), Str(u, "note")), ct);
                return;
            case "reschedule_meeting":
                await meetings.RescheduleAsync(Id(u, "meetingId"), new RescheduleMeetingRequest(DateTimeOffset.Parse(Str(u, "startTime")!), DateTimeOffset.Parse(Str(u, "endTime")!)), ct);
                return;
            case "update_meeting":
                await meetings.UpdateDetailsAsync(Id(u, "meetingId"), new UpdateMeetingDetailsRequest(Str(u, "title") ?? "", Str(u, "description")), ct);
                return;
            default:
                throw new ConflictException("This change cannot be undone here.", "AI_UNDO_UNSUPPORTED");
        }
    }
}
