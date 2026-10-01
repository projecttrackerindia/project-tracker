using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Compliance;

public record DataPolicyDto(int? ActivityRetentionDays, int? NotificationRetentionDays, int? ChatRetentionDays, int? AuditRetentionDays,
    long PlanActivityDays, DateTime? LastPurgedAt, bool CanManage);
public record SaveDataPolicyRequest(int? ActivityRetentionDays, int? NotificationRetentionDays, int? ChatRetentionDays, int? AuditRetentionDays);

/// <summary>
/// How long a workspace keeps its history: activity, notifications, chat messages and the audit log. Empty keeps everything. Owners and
/// Admins decide; the nightly maintenance job deletes what is older. Minimums stop a policy from wiping out what an investigation needs.
/// </summary>
public class DataPolicyService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, EntitlementService entitlements)
{
    public const int MinActivity = 30, MinNotifications = 7, MinChat = 30, MinAudit = 365, Max = 3650;

    private bool IsAdmin => ctx.Role is TenantRole.Owner or TenantRole.Admin;

    public async Task<DataPolicyDto> GetAsync(CancellationToken ct = default)
    {
        if (!IsAdmin) throw new ForbiddenException("Only owners and admins can see the data policy.", "PERMISSION_DENIED");
        var p = await db.TenantDataPolicies.AsNoTracking().FirstOrDefaultAsync(ct);
        var plan = await entitlements.GetValueAsync(FeatureKeys.ActivityRetentionDays, ct);
        return new DataPolicyDto(p?.ActivityRetentionDays, p?.NotificationRetentionDays, p?.ChatRetentionDays, p?.AuditRetentionDays, plan, p?.LastPurgedAt, true);
    }

    public async Task<DataPolicyDto> SaveAsync(SaveDataPolicyRequest req, CancellationToken ct = default)
    {
        if (!IsAdmin) throw new ForbiddenException("Only owners and admins can change the data policy.", "PERMISSION_DENIED");
        static void Check(int? v, int min, string field, string what)
        {
            if (v is { } d && (d < min || d > Max)) throw new ValidationException(field, $"Keep {what} for at least {min} days (and at most {Max}), or leave it empty to keep everything.");
        }
        Check(req.ActivityRetentionDays, MinActivity, "activityRetentionDays", "activity");
        Check(req.NotificationRetentionDays, MinNotifications, "notificationRetentionDays", "notifications");
        Check(req.ChatRetentionDays, MinChat, "chatRetentionDays", "chat messages");
        Check(req.AuditRetentionDays, MinAudit, "auditRetentionDays", "the audit log");
        var tid = ctx.RequireTenantId();
        var p = await db.TenantDataPolicies.FirstOrDefaultAsync(ct);
        var before = p is null ? null : new { p.ActivityRetentionDays, p.NotificationRetentionDays, p.ChatRetentionDays, p.AuditRetentionDays };
        if (p is null) { p = new TenantDataPolicy { TenantId = tid, CreatedAt = clock.Now, CreatedBy = ctx.UserId }; db.TenantDataPolicies.Add(p); }
        p.ActivityRetentionDays = req.ActivityRetentionDays; p.NotificationRetentionDays = req.NotificationRetentionDays;
        p.ChatRetentionDays = req.ChatRetentionDays; p.AuditRetentionDays = req.AuditRetentionDays; p.UpdatedAt = clock.Now;
        recorder.Audit("data_policy.changed", "TenantDataPolicy", p.Id, before, req);
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    /// <summary>Applies every workspace's policy (maintenance job, no request context). Returns how many records were deleted.</summary>
    public static async Task<int> PurgeAllAsync(IAppDbContext db, DateTime now, ILogger log, CancellationToken ct)
    {
        var total = 0;
        var policies = await db.TenantDataPolicies.IgnoreQueryFilters().ToListAsync(ct);
        foreach (var p in policies)
        {
            var n = 0;
            if (p.ActivityRetentionDays is { } a)
            {
                var cutoff = now.AddDays(-a);
                n += await db.Activities.IgnoreQueryFilters().Where(x => x.TenantId == p.TenantId && x.CreatedAt < cutoff).ExecuteDeleteAsync(ct);
            }
            if (p.NotificationRetentionDays is { } nd)
            {
                var cutoff = now.AddDays(-nd);
                n += await db.Notifications.IgnoreQueryFilters().Where(x => x.TenantId == p.TenantId && x.CreatedAt < cutoff).ExecuteDeleteAsync(ct);
            }
            if (p.ChatRetentionDays is { } c)
            {
                var cutoff = now.AddDays(-c);
                n += await db.ChatMessages.IgnoreQueryFilters().Where(x => x.TenantId == p.TenantId && x.CreatedAt < cutoff).ExecuteDeleteAsync(ct);
            }
            if (p.AuditRetentionDays is { } au)
            {
                var cutoff = now.AddDays(-au);
                n += await db.AuditLogs.IgnoreQueryFilters().Where(x => x.TenantId == p.TenantId && x.CreatedAt < cutoff).ExecuteDeleteAsync(ct);
            }
            p.LastPurgedAt = now;
            if (n > 0) log.LogInformation("Data policy of workspace {Tenant}: deleted {Count} old record(s)", p.TenantId, n);
            total += n;
        }
        await db.SaveChangesAsync(ct);
        return total;
    }
}

/// <summary>
/// Everything a workspace holds, as JSON files in one zip (Owners only, built in the background like other exports): members, teams and the
/// org chart, projects with their stages, tasks, comments, checklists, custom fields and dependencies, operational work, time and approvals,
/// files (up to a size cap) and the activity and audit history. Secrets - passwords, API keys, webhook and sign-on secrets - are never included,
/// nor are private chats.
/// </summary>
public class WorkspaceExporter(IAppDbContext db, ICurrentContext ctx, AppClock clock, IFileStorage storage, ILogger<WorkspaceExporter> log)
{
    private const long MaxFileBytes = 250L * 1024 * 1024;
    private const int MaxHistory = 50_000;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull, ReferenceHandler = ReferenceHandler.IgnoreCycles,
        Converters = { new JsonStringEnumConverter() },
    };

    /// <summary>Writes the zip to a temporary file and returns its path (the caller uploads and deletes it).</summary>
    public async Task<string> WriteAsync(string workspaceName, CancellationToken ct)
    {
        if (ctx.Role != TenantRole.Owner) throw new ForbiddenException("Only the workspace owner can export all of its data.", "PERMISSION_DENIED");
        var tid = ctx.RequireTenantId();
        var path = Path.Combine(Path.GetTempPath(), $"pm-export-{Guid.NewGuid():N}.zip");
        await using (var file = File.Create(path))
        using (var zip = new ZipArchive(file, ZipArchiveMode.Create))
        {
            async Task Add<T>(string name, IQueryable<T> rows) where T : class
            {
                var list = await rows.AsNoTracking().ToListAsync(ct);
                var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
                await using var s = entry.Open();
                await JsonSerializer.SerializeAsync(s, list, Json, ct);
            }

            var readme = zip.CreateEntry("README.txt");
            await using (var w = new StreamWriter(readme.Open(), new UTF8Encoding(false)))
                await w.WriteAsync($"""
                    Data export of "{workspaceName}" ({tid}), made {clock.Now:yyyy-MM-dd HH:mm} UTC.

                    One JSON file per kind of record; ids link them (for example tasks.json "projectId" -> projects.json "id").
                    Dates are UTC. Files attached to tasks and work tasks are under files/ (up to {MaxFileBytes / 1024 / 1024} MB in total;
                    attachments.json lists every file, with "included": false for any left out).
                    Not included: passwords, API keys, webhook and sign-on secrets, and private (direct and group) chats.
                    History (activity.json, audit-log.json) holds the most recent {MaxHistory:N0} records each.
                    """);

            await Add("workspace.json", db.Tenants.Where(t => t.Id == tid).Select(t => new { t.Id, t.Name, t.Slug, t.Description, t.Type, t.CreatedAt, t.CostCurrency }));
            await Add("members.json", db.TenantMembers.Where(m => m.TenantId == tid).Select(m => new
            {
                m.UserId, m.User!.DisplayName, m.User.Email, m.Role, m.OrgRoleId, m.ReportsToUserId, m.CreatedAt, m.WeeklyCapacityMinutes, m.CostRate, m.BillRate,
            }));
            await Add("org-roles.json", db.OrgRoles.Select(r => new { r.Id, r.Name, r.Description, r.Color, r.ParentRoleId, r.IsDeleted }));
            await Add("teams.json", db.Teams.Select(t => new { t.Id, t.Name, t.Description, Members = t.Members.Select(m => m.UserId) }));
            await Add("project-groups.json", db.ProjectGroups);
            await Add("projects.json", db.Projects.IgnoreQueryFilters().Where(p => p.TenantId == tid).Select(p => new
            {
                p.Id, p.Name, p.Key, p.Description, p.Status, p.Priority, p.ProjectType, p.DeliveryMethod, p.OwnerId, p.TeamId, p.ProjectGroupId, p.StartDate, p.DueDate,
                p.IsBillable, p.BudgetHours, p.BudgetAmount, p.BillRate, p.ArchivedAt, p.IsDeleted, p.DeletedAt, p.CreatedAt,
                Members = p.Members.Select(m => m.UserId),
            }));
            await Add("workflow-statuses.json", db.WorkflowStatuses);
            await Add("project-stages.json", db.ProjectStages);
            await Add("milestones.json", db.Milestones.IgnoreQueryFilters().Where(m => m.TenantId == tid));
            await Add("sprints.json", db.Sprints);
            await Add("labels.json", db.Labels);
            await Add("tasks.json", db.Tasks.IgnoreQueryFilters().Where(t => t.TenantId == tid));
            await Add("task-labels.json", db.TaskLabels);
            await Add("task-dependencies.json", db.TaskDependencies);
            await Add("task-comments.json", db.TaskComments.IgnoreQueryFilters().Where(c => c.TenantId == tid));
            await Add("checklist-items.json", db.ChecklistItems);
            await Add("custom-fields.json", db.CustomFieldDefinitions);
            await Add("custom-field-values.json", db.CustomFieldValues);
            await Add("test-issues.json", db.StageIssues);
            await Add("work-types.json", db.WorkTypes);
            await Add("work-tasks.json", db.WorkTasks.IgnoreQueryFilters().Where(w => w.TenantId == tid));
            await Add("work-task-comments.json", db.WorkTaskComments.IgnoreQueryFilters().Where(c => c.TenantId == tid));
            await Add("time-entries.json", db.TimeEntries);
            await Add("timesheet-approvals.json", db.TimesheetApprovals);
            await Add("sla-policies.json", db.SlaPolicies);
            await Add("dev-links.json", db.DevLinks);
            await Add("project-chats.json", db.Conversations.Where(c => c.Type == ConversationType.Project).Select(c => new { c.Id, c.ProjectId, c.Name, c.CreatedAt }));
            await Add("project-chat-messages.json", db.ChatMessages.Where(m => db.Conversations.Any(c => c.Id == m.ConversationId && c.Type == ConversationType.Project))
                .Select(m => new { m.Id, m.ConversationId, m.SenderId, m.Kind, m.Body, m.CreatedAt, m.EditedAt }));
            await Add("activity.json", db.Activities.OrderByDescending(a => a.CreatedAt).Take(MaxHistory)
                .Select(a => new { a.Id, a.Action, a.EntityType, a.EntityId, a.ProjectId, a.ActorId, a.Summary, a.OldValue, a.NewValue, a.CreatedAt }));
            await Add("audit-log.json", db.AuditLogs.IgnoreQueryFilters().Where(a => a.TenantId == tid).OrderByDescending(a => a.CreatedAt).Take(MaxHistory)
                .Select(a => new { a.Id, a.Action, a.EntityType, a.EntityId, a.UserId, a.IpAddress, a.OldValue, a.NewValue, a.CreatedAt }));

            // Files: as many as fit under the cap, newest first; the list says which are in the zip.
            var files = await db.Attachments.AsNoTracking().Select(a => new { a.Id, Owner = "task", a.TaskId, IssueId = a.IssueId, WorkTaskId = (Guid?)null, ProjectId = (Guid?)a.ProjectId, a.FileName, a.ContentType, a.SizeBytes, a.StorageKey, a.CreatedAt })
                .ToListAsync(ct);
            var workFiles = await db.WorkTaskAttachments.AsNoTracking().Select(a => new { a.Id, Owner = "work-task", TaskId = (Guid?)null, IssueId = (Guid?)null, WorkTaskId = (Guid?)a.WorkTaskId, ProjectId = (Guid?)null, a.FileName, a.ContentType, a.SizeBytes, a.StorageKey, a.CreatedAt })
                .ToListAsync(ct);
            long used = 0;
            var listed = new List<object>();
            foreach (var f in files.Concat(workFiles).OrderByDescending(f => f.CreatedAt))
            {
                var include = used + f.SizeBytes <= MaxFileBytes;
                if (include)
                {
                    await using var src = await storage.OpenReadAsync(f.StorageKey, ct);
                    if (src is null) include = false;
                    else
                    {
                        var safe = string.Concat(f.FileName.Select(ch => Path.GetInvalidFileNameChars().Contains(ch) ? '_' : ch));
                        var entry = zip.CreateEntry($"files/{f.Id:N}-{safe}", CompressionLevel.Fastest);
                        await using var dst = entry.Open();
                        await src.CopyToAsync(dst, ct);
                        used += f.SizeBytes;
                    }
                }
                listed.Add(new { f.Id, f.Owner, f.TaskId, f.IssueId, f.WorkTaskId, f.ProjectId, f.FileName, f.ContentType, f.SizeBytes, f.CreatedAt, included = include, path = include ? $"files/{f.Id:N}-{f.FileName}" : null });
            }
            var att = zip.CreateEntry("attachments.json");
            await using (var s = att.Open()) await JsonSerializer.SerializeAsync(s, listed, Json, ct);
            log.LogInformation("Workspace {Tenant} exported ({Files} files, {MB} MB of them)", tid, listed.Count, used / 1024 / 1024);
        }
        return path;
    }
}
