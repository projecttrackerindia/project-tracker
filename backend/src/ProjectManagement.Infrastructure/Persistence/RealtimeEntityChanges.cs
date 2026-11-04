using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain.Common;

namespace ProjectManagement.Infrastructure.Persistence;

/// <summary>
/// Turns what a save changes into compact live events (realtime sync): for each tracked entity of a kind that open screens show, its wire
/// type, id, project, operation (created / updated / deleted / restored) and the names of the changed properties - never their values. The
/// page reloads the details through the API with its own permissions. Personal things carry an audience (only those people hear of them).
/// Read before saving (the tracker is reset afterwards); published only once the save has committed.
/// </summary>
public static class RealtimeEntityChanges
{
    private enum Scope { Project, Personal }

    /// <summary>CLR entity name → wire type, how it is addressed, and the properties naming its project / its people / its parent.</summary>
    private sealed record Kind(string Type, Scope Scope, string[] ProjectProps, string[] PeopleProps, string[] ParentProps, string? IdProp = null);

    private static readonly string[] ProjectNames = ["ProjectId", "RelatedProjectId", "TargetProjectId", "ScopeProjectId"];

    private static readonly Dictionary<string, Kind> Kinds = new(StringComparer.Ordinal)
    {
        ["TaskItem"] = new("task", Scope.Project, ProjectNames, [], ["ParentTaskId"]),
        ["WorkTask"] = new("workTask", Scope.Project, ProjectNames, [], []),
        ["StageIssue"] = new("issue", Scope.Project, ProjectNames, [], []),
        ["Milestone"] = new("milestone", Scope.Project, ProjectNames, [], []),
        ["Project"] = new("project", Scope.Project, [], [], []),
        ["ProjectMember"] = new("projectMember", Scope.Personal, ProjectNames, ["UserId"], []),
        ["TaskComment"] = new("comment", Scope.Project, ProjectNames, [], ["TaskId"]),
        ["WorkTaskComment"] = new("comment", Scope.Project, ProjectNames, [], ["WorkTaskId"]),
        ["IssueComment"] = new("comment", Scope.Project, ProjectNames, [], ["IssueId"]),
        ["ProjectMeeting"] = new("calendarEvent", Scope.Project, ProjectNames, [], []),
        ["WorkspaceMeeting"] = new("calendarEvent", Scope.Personal, [], ["OrganizerUserId"], []),
        ["WorkspaceMeetingAttendee"] = new("calendarEvent", Scope.Personal, [], ["UserId"], [], "MeetingId"),
        ["Reminder"] = new("reminder", Scope.Personal, [], ["UserId"], []),
        ["Note"] = new("note", Scope.Personal, [], ["OwnerId"], []),
        ["ApprovalRequest"] = new("approval", Scope.Personal, [], ["RequesterId"], []),
        ["ApprovalRequestStep"] = new("approval", Scope.Personal, [], ["ApproverId"], [], "RequestId"),
        ["TimeEntry"] = new("timeEntry", Scope.Personal, [], ["UserId"], []),
        ["AttendanceDay"] = new("attendance", Scope.Personal, [], ["UserId"], []),
        ["SupportConversation"] = new("deskTicket", Scope.Project, [], [], []),
        ["ConversationMember"] = new("chatUnread", Scope.Personal, [], ["UserId"], [], "ConversationId"),
    };

    /// <summary>Bookkeeping columns that say nothing a screen shows.</summary>
    private static readonly HashSet<string> Quiet = new(StringComparer.Ordinal) { "UpdatedAt", "UpdatedBy", "Version", "ScopeProjectId", "ItemId", "SearchVector", "Embedding" };

    public static string WireType(string entityType, string? kind = null) => entityType switch
    {
        "Task" or "TaskItem" => "task",
        "WorkTask" => kind == "ActionItem" ? "actionItem" : "workTask",
        "StageIssue" or "Issue" => "issue",
        "Project" => "project",
        _ => entityType.Length == 0 ? "unknown" : char.ToLowerInvariant(entityType[0]) + entityType[1..],
    };

    public static List<ChangeEvent> Collect(ChangeTracker tracker, Guid? actor)
    {
        var list = new List<ChangeEvent>();
        foreach (var e in tracker.Entries())
        {
            if (e.State is not (EntityState.Added or EntityState.Modified or EntityState.Deleted)) continue;
            if (e.Entity is not ITenantScoped scoped || scoped.TenantId == Guid.Empty) continue;
            if (!Kinds.TryGetValue(e.Entity.GetType().Name, out var k)) continue;
            var id = k.IdProp is { } idp ? GuidOf(e, idp) : (e.Entity as Entity)?.Id;
            if (id is null) continue;

            string op;
            IReadOnlyList<string>? fields = null;
            if (e.State == EntityState.Added) op = k.IdProp is null ? "created" : "updated";
            else if (e.State == EntityState.Deleted) op = k.IdProp is null ? "deleted" : "updated";
            else
            {
                var changed = e.Properties.Where(p => p.IsModified && !Quiet.Contains(p.Metadata.Name)).Select(p => p.Metadata.Name).ToList();
                if (changed.Count == 0) continue;
                var softDelete = e.Properties.FirstOrDefault(p => p.Metadata.Name == "IsDeleted" && p.IsModified);
                op = softDelete is null ? "updated" : softDelete.CurrentValue is true ? "deleted" : "restored";
                fields = changed.Select(Camel).Where(f => f is not ("deletedAt" or "deletedBy")).ToList();
            }

            var type = k.Type == "workTask" ? WireType("WorkTask", ValueOf(e, "Kind")?.ToString()) : k.Type;
            var project = e.Entity.GetType().Name == "Project" ? id : k.ProjectProps.Select(p => GuidOf(e, p)).FirstOrDefault(g => g is not null);
            var parent = k.ParentProps.Select(p => GuidOf(e, p)).FirstOrDefault(g => g is not null);
            IReadOnlyList<Guid>? audience = null;
            if (k.Scope == Scope.Personal)
            {
                var people = k.PeopleProps.Select(p => GuidOf(e, p)).Where(g => g is not null).Select(g => g!.Value).ToList();
                // The person who made the change hears of it too (their other tabs and devices).
                if (actor is { } a && type is not ("projectMember" or "chatUnread")) people.Add(a);
                audience = people.Distinct().ToList();
                if (audience.Count == 0) continue;
            }
            list.Add(new ChangeEvent(scoped.TenantId, e.Entity.GetType().Name, id, project, $"{type}.{op}", actor, op, fields, audience, type, parent));
        }
        // One event per thing and save (a meeting and its attendee rows, an approval and its steps): fields merged, audiences joined.
        return list.GroupBy(c => (c.TenantId, c.Type, c.EntityId)).Select(g =>
        {
            var first = g.First();
            if (g.Count() == 1) return first;
            var op = g.Select(c => c.Op).FirstOrDefault(o => o is "created" or "deleted" or "restored") ?? "updated";
            var fields = g.SelectMany(c => c.Fields ?? Array.Empty<string>()).Distinct().ToList();
            var audience = g.Any(c => c.Audience is null) ? null : g.SelectMany(c => c.Audience!).Distinct().ToList();
            return first with { Op = op, Action = $"{first.Type}.{op}", Fields = fields.Count == 0 ? null : fields, Audience = audience, ProjectId = g.Select(c => c.ProjectId).FirstOrDefault(p => p is not null) };
        }).ToList();
    }

    /// <summary>Merges the activity-based events (which name the action, e.g. "task.created") with the entity-derived ones (op and fields).</summary>
    public static List<ChangeEvent> Merge(List<ChangeEvent> fromActivity, List<ChangeEvent> fromEntities)
    {
        var result = new List<ChangeEvent>(fromEntities);
        foreach (var a in fromActivity)
        {
            var type = WireType(a.EntityType);
            var twin = result.FindIndex(c => c.TenantId == a.TenantId && c.EntityId == a.EntityId && a.EntityId is not null
                && (c.Type == type || c.EntityType == a.EntityType || (type == "workTask" && c.Type == "actionItem")));
            if (twin >= 0) { var c = result[twin]; result[twin] = c with { EntityType = a.EntityType, Action = a.Action, ProjectId = c.ProjectId ?? a.ProjectId }; }
            else result.Add(a with { Type = type, Op = a.Op ?? OpOf(a.Action) });
        }
        return result;
    }

    private static string OpOf(string action)
    {
        var verb = action.Contains('.') ? action[(action.LastIndexOf('.') + 1)..] : action;
        return verb switch { "created" or "added" => "created", "deleted" or "removed" => "deleted", "restored" => "restored", _ => "updated" };
    }

    private static string Camel(string s) => s.Length == 0 ? s : char.ToLowerInvariant(s[0]) + s[1..];

    private static object? ValueOf(EntityEntry e, string name) =>
        e.Metadata.FindProperty(name) is null ? null : e.Property(name).CurrentValue;

    private static Guid? GuidOf(EntityEntry e, string name) => ValueOf(e, name) switch
    {
        Guid g when g != Guid.Empty => g,
        _ => null,
    };
}
