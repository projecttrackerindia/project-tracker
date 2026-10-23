using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>A work item as it was before the assistant changed it, so Undo can put those values back.</summary>
public sealed record AiUndoBefore(string Target, Guid Id, Guid? ProjectId, string Title, string? Description, string? Status, Guid? StatusId, Priority Priority,
    Guid? AssigneeId, DateOnly? StartDate, DateOnly? DueDate, decimal? EstimatedHours);

/// <summary>
/// Undo for a change the person confirmed from an assistant card, for <see cref="Window"/> afterwards. It reverses the change through the same
/// services (so the person's own rights still apply): what was created is deleted, what was deleted comes back from the bin, what was
/// changed gets its earlier values. Things that left the building (a sent message, mail, a report, an invitation) cannot be undone and
/// never show the button.
/// </summary>
public class AiUndoService(IAppDbContext db, ICurrentContext ctx, TaskService tasks, WorkTaskService workTasks, ActionItemService actionItems, DocumentService documents,
    ReminderService reminders, TimeService time, AiWatchService watches)
{
    public static readonly TimeSpan Window = TimeSpan.FromMinutes(10);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };

    /// <summary>Kinds that can be undone, given what the confirmed result recorded.</summary>
    public static bool Supports(string kind) => kind is "create_task" or "create_work" or "create_action_item" or "create_document" or "reminder" or "delete_work" or "update_work" or "log_time" or "watch";

    /// <summary>A short description of what Undo will do, for the person (the card's button title and the result).</summary>
    public static string Describe(string kind) => kind switch
    {
        "create_task" or "create_work" or "create_action_item" => "Deletes what was created",
        "create_document" => "Moves the page to the bin",
        "reminder" => "Removes the reminder",
        "delete_work" => "Brings it back from the bin",
        "update_work" => "Puts back the earlier values (comments added stay)",
        "log_time" => "Removes the logged time",
        "watch" => "Stops the watch",
        _ => "",
    };

    public async Task RunAsync(AiProposal p, CancellationToken ct)
    {
        using var payload = JsonDocument.Parse(p.PayloadJson);
        var a = payload.RootElement;
        var id = p.ResultId;
        switch (p.Kind)
        {
            case "create_task":
                await tasks.DeleteAsync(id ?? throw Missing(), ct);
                return;
            case "create_work":
                await workTasks.DeleteAsync(id ?? throw Missing(), ct);
                return;
            case "create_action_item":
            {
                var itemId = id ?? throw Missing();
                var projectId = await db.WorkTasks.AsNoTracking().Where(w => w.Id == itemId).Select(w => w.RelatedProjectId).FirstOrDefaultAsync(ct) ?? throw new NotFoundException("Action item not found.");
                await actionItems.DeleteAsync(projectId, itemId, ct);
                return;
            }
            case "create_document":
                await documents.DeleteAsync(id ?? throw Missing(), ct);
                return;
            case "reminder":
                await reminders.DeleteAsync(id ?? throw Missing(), ct);
                return;
            case "delete_work":
            {
                var itemId = Guid(a, "id") ?? throw Missing();
                switch (Str(a, "target"))
                {
                    case "Task": await tasks.RestoreAsync(itemId, ct); break;
                    case "Operational": await workTasks.RestoreAsync(itemId, ct); break;
                    case "ActionItem": await actionItems.RestoreAsync(Guid(a, "projectId") ?? throw Missing(), itemId, ct); break;
                    default: throw Missing();
                }
                return;
            }
            case "log_time":
            {
                var ids = Undo<LoggedTime>(p)?.EntryIds ?? throw Missing();
                foreach (var entry in ids) await time.DeleteAsync(entry, ct);
                return;
            }
            case "watch":
                await watches.StopAsync(id ?? throw Missing(), ct);
                return;
            case "update_work":
                await PutBackAsync(Undo<AiUndoBefore>(p) ?? throw Missing(), ct);
                return;
            default:
                throw new ConflictException("This change cannot be undone here.", "AI_UNDO_UNSUPPORTED");
        }
    }

    private async Task PutBackAsync(AiUndoBefore b, CancellationToken ct)
    {
        switch (b.Target)
        {
            case "actionitem":
                await actionItems.UpdateAsync(b.ProjectId ?? throw Missing(), b.Id, new UpdateActionItemRequest(b.Title, b.Description, b.AssigneeId, b.DueDate, b.Priority,
                    Enum.Parse<ActionItemStatus>(b.Status ?? nameof(ActionItemStatus.Open), true)), ct);
                return;
            case "work":
            {
                var w = await workTasks.GetAsync(b.Id, ct);
                await workTasks.UpdateAsync(b.Id, new UpdateWorkTaskRequest(b.Title, b.Description, w.WorkTypeId, w.RelatedProject?.Id, b.AssigneeId, b.Priority,
                    Enum.Parse<WorkTaskStatus>(b.Status ?? nameof(WorkTaskStatus.ToDo), true), b.StartDate, b.DueDate, w.Version), ct);
                return;
            }
            default:
            {
                var t = (await tasks.GetAsync(b.Id, ct)).Task;
                await tasks.UpdateAsync(b.Id, new UpdateTaskRequest(b.Title, b.Description, b.StatusId ?? t.StatusId, b.Priority, b.AssigneeId, b.StartDate, b.DueDate,
                    b.EstimatedHours, t.ActualHours, t.Labels.Select(l => l.Id).ToList(), t.Version, t.MilestoneId, t.StageId, "Undo of a change made with the assistant"), ct);
                return;
            }
        }
    }

    private sealed record LoggedTime(List<Guid> EntryIds);

    private static T? Undo<T>(AiProposal p) where T : class => string.IsNullOrEmpty(p.UndoJson) ? null : JsonSerializer.Deserialize<T>(p.UndoJson, Json);
    private static ConflictException Missing() => new("What this change did was not recorded, so it cannot be undone here. Change it back by hand.", "AI_UNDO_UNAVAILABLE");
    private static string? Str(JsonElement a, string n) => a.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    private static Guid? Guid(JsonElement a, string n) => Str(a, n) is { } s && System.Guid.TryParse(s, out var g) ? g : null;
}
