using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Persistence;

namespace ProjectManagement.Tests;

/// <summary>
/// The v2 table merge on a real PostgreSQL server: every old shape (project tasks with subtasks, labels, dependencies, checklists, custom
/// fields, comments and replies, files and time; stage issues with their history and files; tickets and action items with comments, files,
/// time, dev links and support tickets) is written into the schema as it was before (raw SQL), the migration runs (twice), and every row,
/// id, key, comment, file, time entry and link must be there, reachable through the model, with the foreign keys now pointing at WorkItems.
/// Then down and up again: nothing is lost either way. Runs where PM_TEST_POSTGRES points at a disposable server (the PostgreSQL CI job).
/// </summary>
public class WorkItemsMigrationTests
{
    private const string Before = "20261110001000_MeetTab";

    private sealed class Fixture(string databaseName, NpgsqlConnection admin, string connectionString) : IAsyncDisposable
    {
        public string ConnectionString => connectionString;

        public static async Task<Fixture> CreateAsync()
        {
            var configured = Environment.GetEnvironmentVariable("PM_TEST_POSTGRES")!;
            var databaseName = "pm_workitems_" + Guid.NewGuid().ToString("N");
            var admin = new NpgsqlConnection(new NpgsqlConnectionStringBuilder(configured) { Database = "postgres", Pooling = false }.ConnectionString);
            await admin.OpenAsync();
            await using (var create = new NpgsqlCommand($"CREATE DATABASE \"{databaseName}\"", admin)) await create.ExecuteNonQueryAsync();
            return new Fixture(databaseName, admin, new NpgsqlConnectionStringBuilder(configured) { Database = databaseName, Pooling = false }.ConnectionString);
        }

        public AppDbContext Db(CurrentContext? context = null) =>
            new(new DbContextOptionsBuilder<AppDbContext>().UseNpgsql(connectionString).Options, context ?? new CurrentContext(), TimeProvider.System);

        public async Task<long> Count(string sql)
        {
            await using var c = new NpgsqlConnection(connectionString);
            await c.OpenAsync();
            await using var cmd = new NpgsqlCommand(sql, c);
            return Convert.ToInt64(await cmd.ExecuteScalarAsync());
        }

        public async Task Exec(string sql)
        {
            await using var c = new NpgsqlConnection(connectionString);
            await c.OpenAsync();
            await using var cmd = new NpgsqlCommand(sql, c);
            await cmd.ExecuteNonQueryAsync();
        }

        public Task Row(string table, Dictionary<string, object> values) => OldSchemaRows.InsertAsync(connectionString, table, values);

        public async ValueTask DisposeAsync()
        {
            NpgsqlConnection.ClearAllPools();
            // Only the random database created above is removed.
            await using (var drop = new NpgsqlCommand($"DROP DATABASE \"{databaseName}\" WITH (FORCE)", admin)) await drop.ExecuteNonQueryAsync();
            await admin.DisposeAsync();
        }
    }

    /// <summary>Ids of everything seeded, to look for afterwards.</summary>
    private sealed record Seed(Guid Tenant, Guid Owner, Guid Dev, Guid Project, Guid Status, Guid Stage, Guid Parent, Guid Sub, Guid Deleted, Guid Issue,
        Guid Ticket, Guid Action, Guid TaskComment, Guid Reply, Guid WorkComment, Guid OrphanComment, Guid WorkFile, Guid TaskFile, Guid IssueFile,
        Guid TaskTime, Guid WorkTime, Guid Event, Guid Label, Guid Dependency, Guid Checklist, Guid FieldValue, Guid DevLink, Guid WorkType);

    private static async Task<Seed> SeedOldShapes(Fixture f)
    {
        var now = DateTime.UtcNow;
        Guid N() => Guid.NewGuid();
        var s = new Seed(N(), N(), N(), N(), N(), N(), N(), N(), N(), N(), N(), N(), N(), N(), N(), N(), N(), N(), N(), N(), N(), N(), N(), N(), N(), N(), N(), N());
        await f.Row("Users", new() { ["Id"] = s.Owner, ["Email"] = "owner@example.test", ["NormalizedEmail"] = "OWNER@EXAMPLE.TEST", ["DisplayName"] = "Olivia Owner", ["PasswordHash"] = "x", ["IsActive"] = true });
        await f.Row("Users", new() { ["Id"] = s.Dev, ["Email"] = "dev@example.test", ["NormalizedEmail"] = "DEV@EXAMPLE.TEST", ["DisplayName"] = "Dev Developer", ["PasswordHash"] = "x", ["IsActive"] = true });
        await f.Row("Tenants", new() { ["Id"] = s.Tenant, ["Name"] = "Acme", ["Slug"] = "acme-" + s.Tenant.ToString("N")[..8], ["Type"] = "Organization", ["OwnerUserId"] = s.Owner, ["Status"] = "Active" });
        await f.Row("Projects", new() { ["Id"] = s.Project, ["TenantId"] = s.Tenant, ["Name"] = "Payment Engine", ["Key"] = "PAY", ["Status"] = "Active", ["Priority"] = "Medium", ["OwnerId"] = s.Owner, ["ProjectType"] = "Other", ["DeliveryMethod"] = "Hybrid", ["StageScheduleMode"] = "Manual" });
        await f.Row("WorkflowStatuses", new() { ["Id"] = s.Status, ["TenantId"] = s.Tenant, ["ProjectId"] = s.Project, ["Name"] = "To Do", ["Order"] = 0, ["Category"] = "Todo", ["Color"] = "#888888" });
        await f.Row("ProjectStages", new() { ["Id"] = s.Stage, ["TenantId"] = s.Tenant, ["ProjectId"] = s.Project, ["Name"] = "Build", ["Order"] = 0 });
        await f.Row("Labels", new() { ["Id"] = s.Label, ["TenantId"] = s.Tenant, ["Name"] = "backend", ["Color"] = "#123456" });

        Dictionary<string, object> Task(Guid id, int number, string title) => new()
        {
            ["Id"] = id, ["TenantId"] = s.Tenant, ["ProjectId"] = s.Project, ["Number"] = number, ["Title"] = title, ["StatusId"] = s.Status, ["Priority"] = "High",
            ["ReporterId"] = s.Owner, ["Version"] = 3, ["Position"] = 1.5, ["CreatedAt"] = now,
        };
        var parent = Task(s.Parent, 12, "Wire the refund API"); parent["AssigneeId"] = s.Dev; parent["Description"] = "Use the v2 endpoint"; parent["StageId"] = s.Stage;
        parent["DueDate"] = new DateOnly(2026, 11, 20); parent["EstimatedHours"] = 6.5m;
        await f.Row("Tasks", parent);
        var sub = Task(s.Sub, 13, "Write the webhook"); sub["ParentTaskId"] = s.Parent;
        await f.Row("Tasks", sub);
        var gone = Task(s.Deleted, 14, "Old idea"); gone["IsDeleted"] = true; gone["DeletedAt"] = now; gone["DeletedBy"] = s.Owner;
        await f.Row("Tasks", gone);
        await f.Row("TaskLabels", new() { ["TenantId"] = s.Tenant, ["TaskId"] = s.Parent, ["LabelId"] = s.Label });
        await f.Row("TaskDependencies", new() { ["Id"] = s.Dependency, ["TenantId"] = s.Tenant, ["TaskId"] = s.Sub, ["DependsOnTaskId"] = s.Parent, ["Type"] = "FinishToStart" });
        await f.Row("ChecklistItems", new() { ["Id"] = s.Checklist, ["TenantId"] = s.Tenant, ["TaskId"] = s.Parent, ["Title"] = "Tests", ["Position"] = 1.0 });
        var field = Guid.NewGuid();
        await f.Row("CustomFieldDefinitions", new() { ["Id"] = field, ["TenantId"] = s.Tenant, ["Name"] = "Client", ["Type"] = "Text" });
        await f.Row("CustomFieldValues", new() { ["Id"] = s.FieldValue, ["TenantId"] = s.Tenant, ["TaskId"] = s.Parent, ["FieldId"] = field, ["Value"] = "Razorpay" });
        await f.Row("TaskComments", new() { ["Id"] = s.TaskComment, ["TenantId"] = s.Tenant, ["TaskId"] = s.Parent, ["AuthorId"] = s.Dev, ["Body"] = "Started", ["CreatedAt"] = now });
        await f.Row("TaskComments", new() { ["Id"] = s.Reply, ["TenantId"] = s.Tenant, ["TaskId"] = s.Parent, ["AuthorId"] = s.Owner, ["Body"] = "Thanks", ["ParentCommentId"] = s.TaskComment, ["CreatedAt"] = now });
        await f.Row("Attachments", new() { ["Id"] = s.TaskFile, ["TenantId"] = s.Tenant, ["ProjectId"] = s.Project, ["TaskId"] = s.Parent, ["FileName"] = "spec.pdf", ["ContentType"] = "application/pdf", ["SizeBytes"] = 10L, ["StorageKey"] = "k/1", ["Sha256"] = "aa" });
        await f.Row("TimeEntries", new() { ["Id"] = s.TaskTime, ["TenantId"] = s.Tenant, ["TaskId"] = s.Parent, ["ProjectId"] = s.Project, ["UserId"] = s.Dev, ["WorkDate"] = new DateOnly(2026, 10, 20), ["Minutes"] = 90 });
        await f.Row("DevLinks", new() { ["Id"] = s.DevLink, ["TenantId"] = s.Tenant, ["TaskId"] = s.Parent, ["Kind"] = "PullRequest", ["Url"] = "https://example.test/pr/1", ["Title"] = "PR 1", ["Provider"] = "GitHub", ["ExternalId"] = "1", ["State"] = "open" });

        // A stage issue with its history and a supporting file.
        await f.Row("StageIssues", new() { ["Id"] = s.Issue, ["TenantId"] = s.Tenant, ["ProjectId"] = s.Project, ["StageId"] = s.Stage, ["Number"] = 3, ["Title"] = "Refund total off by one",
            ["Details"] = "Seen on staging", ["Severity"] = "Critical", ["Status"] = "Observed", ["ReporterId"] = s.Owner, ["AssigneeId"] = s.Dev, ["CreatedAt"] = now });
        await f.Row("StageIssueEvents", new() { ["Id"] = s.Event, ["TenantId"] = s.Tenant, ["IssueId"] = s.Issue, ["Kind"] = "raised", ["ToStatus"] = "Observed", ["ActorId"] = s.Owner, ["CreatedAt"] = now });
        await f.Row("Attachments", new() { ["Id"] = s.IssueFile, ["TenantId"] = s.Tenant, ["ProjectId"] = s.Project, ["IssueId"] = s.Issue, ["FileName"] = "screen.png", ["ContentType"] = "image/png", ["SizeBytes"] = 20L, ["StorageKey"] = "k/2", ["Sha256"] = "bb" });

        // A ticket (operational work) and an action item, with comments, a file and time.
        await f.Row("WorkTypes", new() { ["Id"] = s.WorkType, ["TenantId"] = s.Tenant, ["Name"] = "Bug Fix", ["Order"] = 0, ["IsActive"] = true });
        await f.Row("WorkTasks", new() { ["Id"] = s.Ticket, ["TenantId"] = s.Tenant, ["Kind"] = "Operational", ["Number"] = 5, ["Title"] = "Printer on floor 2", ["Description"] = "Jams on A3",
            ["WorkTypeId"] = s.WorkType, ["RelatedProjectId"] = s.Project, ["Priority"] = "Low", ["Status"] = "InProgress", ["ReporterId"] = s.Owner, ["AssigneeId"] = s.Dev, ["Version"] = 4,
            ["ResolutionDueAt"] = now.AddDays(2), ["SlaPausedMinutes"] = 15, ["SlaAlerted"] = 1, ["CreatedAt"] = now });
        await f.Row("WorkTasks", new() { ["Id"] = s.Action, ["TenantId"] = s.Tenant, ["Kind"] = "ActionItem", ["Number"] = 6, ["Title"] = "Get the bank's sign-off", ["RelatedProjectId"] = s.Project,
            ["Priority"] = "Medium", ["Status"] = "ToDo", ["ReporterId"] = s.Owner, ["Version"] = 1, ["CreatedAt"] = now });
        await f.Row("WorkTaskComments", new() { ["Id"] = s.WorkComment, ["TenantId"] = s.Tenant, ["WorkTaskId"] = s.Ticket, ["AuthorId"] = s.Dev, ["Body"] = "Ordered a part", ["CreatedAt"] = now });
        // The old table did not check its work task: a comment of a work task that is gone stays behind in legacy_WorkTaskComments.
        await f.Row("WorkTaskComments", new() { ["Id"] = s.OrphanComment, ["TenantId"] = s.Tenant, ["WorkTaskId"] = Guid.NewGuid(), ["AuthorId"] = s.Dev, ["Body"] = "Orphan", ["CreatedAt"] = now });
        await f.Row("WorkTaskAttachments", new() { ["Id"] = s.WorkFile, ["TenantId"] = s.Tenant, ["WorkTaskId"] = s.Ticket, ["FileName"] = "invoice.pdf", ["ContentType"] = "application/pdf", ["SizeBytes"] = 30L, ["StorageKey"] = "k/3", ["Sha256"] = "cc", ["CreatedAt"] = now });
        await f.Row("TimeEntries", new() { ["Id"] = s.WorkTime, ["TenantId"] = s.Tenant, ["WorkTaskId"] = s.Ticket, ["UserId"] = s.Dev, ["WorkDate"] = new DateOnly(2026, 10, 21), ["Minutes"] = 45 });
        return s;
    }

    private static CurrentContext As(Seed s) => new() { UserId = s.Owner, TenantId = s.Tenant, Role = TenantRole.Owner, WorkspaceType = WorkspaceType.Organization };

    private static async Task AssertEverythingIsThere(Fixture f, Seed s)
    {
        await using var db = f.Db(As(s));
        // Through the model: each kind, by its own DbSet, with its values.
        var parent = await db.Tasks.Include(t => t.Labels).SingleAsync(t => t.Id == s.Parent);
        Assert.Equal((12, "Wire the refund API", "Use the v2 endpoint", Priority.High, 3, s.Dev, s.Stage), (parent.Number, parent.Title, parent.Description, parent.Priority, parent.Version, parent.AssigneeId!.Value, parent.StageId!.Value));
        Assert.Equal(6.5m, parent.EstimatedHours);
        Assert.Equal(new DateOnly(2026, 11, 20), parent.DueDate);
        Assert.Equal(s.Label, Assert.Single(parent.Labels).LabelId);
        Assert.Equal(s.Parent, (await db.Tasks.SingleAsync(t => t.Id == s.Sub)).ParentTaskId);
        Assert.False(await db.Tasks.AnyAsync(t => t.Id == s.Deleted));                                     // still in the bin
        Assert.True((await db.Tasks.IgnoreQueryFilters().SingleAsync(t => t.Id == s.Deleted)).IsDeleted);

        var issue = await db.StageIssues.SingleAsync(i => i.Id == s.Issue);
        Assert.Equal((3, "Refund total off by one", "Seen on staging", Priority.Critical, IssueStatus.Observed, s.Stage, s.Dev), (issue.Number, issue.Title, issue.Details, issue.Severity, issue.Status, issue.StageId!.Value, issue.AssigneeId!.Value));
        Assert.Equal(s.Issue, (await db.StageIssueEvents.SingleAsync(e => e.Id == s.Event)).IssueId);

        var ticket = await db.WorkTasks.SingleAsync(w => w.Id == s.Ticket);
        Assert.Equal((WorkTaskKind.Operational, 5, "Printer on floor 2", "Jams on A3", WorkTaskStatus.InProgress, Priority.Low, 4, 15, 1), (ticket.Kind, ticket.Number, ticket.Title, ticket.Description, ticket.Status, ticket.Priority, ticket.Version, ticket.SlaPausedMinutes, ticket.SlaAlerted));
        Assert.Equal(s.WorkType, ticket.WorkTypeId);
        Assert.Equal(s.Project, ticket.RelatedProjectId);
        var action = await db.WorkTasks.SingleAsync(w => w.Id == s.Action);
        Assert.Equal((WorkTaskKind.ActionItem, 6, WorkTaskStatus.ToDo), (action.Kind, action.Number, action.Status));

        // The one table holds all of them, each with its kind.
        Assert.Equal(6, await db.WorkItems.IgnoreQueryFilters().CountAsync());
        Assert.Equal(new[] { "Issue", "Task", "Task", "Task", "Work", "Work" }, (await db.WorkItems.IgnoreQueryFilters().Select(w => EF.Property<string>(w, "ItemType")).ToListAsync()).Order().ToArray());

        // Comments, files, time, links.
        var comments = await db.TaskComments.Where(c => c.TaskId == s.Parent).OrderBy(c => c.Body).ToListAsync();
        Assert.Equal(new[] { "Started", "Thanks" }, comments.Select(c => c.Body).ToArray());
        Assert.Equal(s.TaskComment, comments.Single(c => c.Id == s.Reply).ParentCommentId);
        Assert.Equal("Ordered a part", (await db.WorkTaskComments.SingleAsync(c => c.WorkTaskId == s.Ticket)).Body);
        Assert.False(await db.WorkItemComments.IgnoreQueryFilters().AnyAsync(c => c.Id == s.OrphanComment));
        Assert.Equal(1, await f.Count($"SELECT count(*) FROM \"legacy_WorkTaskComments\" WHERE \"Id\" = '{s.OrphanComment}'"));
        var file = await db.WorkTaskAttachments.SingleAsync(a => a.Id == s.WorkFile);
        Assert.Equal((s.Ticket, "invoice.pdf", "k/3", "cc", 30L), (file.WorkTaskId, file.FileName, file.StorageKey, file.Sha256, file.SizeBytes));
        Assert.Equal(s.Parent, (await db.Attachments.SingleAsync(a => a.Id == s.TaskFile)).TaskId);
        Assert.Equal(s.Issue, (await db.Attachments.SingleAsync(a => a.Id == s.IssueFile)).IssueId);
        Assert.Equal((s.Parent, 90), await db.TimeEntries.Where(e => e.Id == s.TaskTime).Select(e => ValueTuple.Create(e.TaskId!.Value, e.Minutes)).SingleAsync());
        Assert.Equal((s.Ticket, 45), await db.TimeEntries.Where(e => e.Id == s.WorkTime).Select(e => ValueTuple.Create(e.WorkTaskId!.Value, e.Minutes)).SingleAsync());
        Assert.Equal(s.Parent, (await db.TaskDependencies.SingleAsync(d => d.Id == s.Dependency)).DependsOnTaskId);
        Assert.Equal(s.Parent, (await db.ChecklistItems.SingleAsync(c => c.Id == s.Checklist)).TaskId);
        Assert.Equal("Razorpay", (await db.CustomFieldValues.SingleAsync(v => v.Id == s.FieldValue)).Value);
        Assert.Equal(s.Parent, (await db.DevLinks.SingleAsync(d => d.Id == s.DevLink)).TaskId);

        // Every foreign key that pointed at the old tables now points at WorkItems; none points at a legacy table.
        Assert.Equal(0, await f.Count("SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND (confrelid::regclass::text LIKE '%legacy_%' OR conrelid::regclass::text LIKE '%legacy_%')"));
        foreach (var (table, column) in new[] { ("TimeEntries", "TaskId"), ("TimeEntries", "WorkTaskId"), ("TaskDependencies", "DependsOnTaskId"), ("ChecklistItems", "TaskId"),
                     ("StageIssueEvents", "IssueId"), ("TaskLabels", "TaskId"), ("CustomFieldValues", "TaskId"), ("DevLinks", "TaskId"), ("SupportTickets", "WorkTaskId"),
                     ("WorkItemComments", "WorkItemId") })
            Assert.Equal(1, await f.Count($"""
                SELECT count(*) FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
                WHERE c.contype = 'f' AND c.conrelid = 'public."{table}"'::regclass AND c.confrelid = 'public."WorkItems"'::regclass AND a.attname = '{column}'
                """));
        // The keys work: a time entry for a task that does not exist is refused.
        await Assert.ThrowsAsync<PostgresException>(() => f.Exec($"INSERT INTO \"TimeEntries\" (\"Id\",\"TenantId\",\"TaskId\",\"UserId\",\"WorkDate\",\"Minutes\",\"CreatedAt\",\"Billable\") VALUES ('{Guid.NewGuid()}','{s.Tenant}','{Guid.NewGuid()}','{s.Dev}','2026-10-01',5,now(),false)"));
    }

    [PostgresExpansionFact]
    public async Task Every_old_row_key_comment_file_time_entry_and_link_survives_the_move_into_WorkItems_and_back()
    {
        await using var f = await Fixture.CreateAsync();
        await using (var db = f.Db()) await db.GetService<IMigrator>().MigrateAsync(Before);
        var s = await SeedOldShapes(f);

        await using (var db = f.Db())
        {
            await db.Database.MigrateAsync();
            await db.Database.MigrateAsync();   // a second run changes nothing
            Assert.Empty(await db.Database.GetPendingMigrationsAsync());
        }
        foreach (var legacy in new[] { "legacy_Tasks", "legacy_StageIssues", "legacy_WorkTasks", "legacy_TaskComments", "legacy_WorkTaskComments", "legacy_WorkTaskAttachments" })
            Assert.Equal(1, await f.Count($"SELECT count(*) FROM pg_class WHERE relname = '{legacy}'"));
        Assert.Equal(0, await f.Count("SELECT count(*) FROM pg_class WHERE relname IN ('Tasks','StageIssues','WorkTasks','TaskComments','WorkTaskComments','WorkTaskAttachments')"));
        await AssertEverythingIsThere(f, s);

        // Work after the upgrade: a new task, an edited ticket, a deleted issue comment's issue... then down to the old tables.
        var later = Guid.NewGuid();
        await using (var db = f.Db(As(s)))
        {
            db.Tasks.Add(new TaskItem { Id = later, TenantId = s.Tenant, ProjectId = s.Project, Number = 15, Title = "Added after the upgrade", StatusId = s.Status, ReporterId = s.Owner, CreatedAt = DateTime.UtcNow });
            var ticket = await db.WorkTasks.SingleAsync(w => w.Id == s.Ticket);
            ticket.Title = "Printer on floor 3"; ticket.Version++;
            db.IssueComments.Add(new IssueComment { TenantId = s.Tenant, IssueId = s.Issue, AuthorId = s.Owner, Body = "Checked on prod too", CreatedAt = DateTime.UtcNow });
            await db.SaveChangesAsync();
        }
        await using (var db = f.Db()) await db.GetService<IMigrator>().MigrateAsync(Before);
        Assert.Equal(0, await f.Count("SELECT count(*) FROM pg_class WHERE relname IN ('WorkItems','WorkItemComments','WorkItemAttachments')"));
        Assert.Equal(4, await f.Count("SELECT count(*) FROM \"Tasks\""));
        Assert.Equal(1, await f.Count($"SELECT count(*) FROM \"Tasks\" WHERE \"Id\" = '{later}' AND \"Number\" = 15 AND \"Title\" = 'Added after the upgrade'"));
        Assert.Equal(1, await f.Count($"SELECT count(*) FROM \"WorkTasks\" WHERE \"Id\" = '{s.Ticket}' AND \"Title\" = 'Printer on floor 3' AND \"Version\" = 5"));
        Assert.Equal(1, await f.Count($"SELECT count(*) FROM \"StageIssueEvents\" WHERE \"IssueId\" = '{s.Issue}' AND \"Kind\" = 'comment' AND \"Note\" = 'Checked on prod too'"));
        Assert.Equal(2, await f.Count("SELECT count(*) FROM \"WorkTaskComments\""));   // the orphan too
        Assert.Equal(1, await f.Count($"SELECT count(*) FROM pg_constraint WHERE conname = 'FK_TimeEntries_Tasks_TaskId'"));

        // And up again.
        await using (var db = f.Db()) await db.Database.MigrateAsync();
        await using (var db = f.Db(As(s)))
        {
            Assert.Equal("Added after the upgrade", (await db.Tasks.SingleAsync(t => t.Id == later)).Title);
            Assert.Equal("Printer on floor 3", (await db.WorkTasks.SingleAsync(t => t.Id == s.Ticket)).Title);
        }
    }

    [PostgresExpansionFact]
    public async Task A_row_the_new_keys_would_refuse_stops_the_upgrade_before_anything_changes()
    {
        await using var f = await Fixture.CreateAsync();
        await using (var db = f.Db()) await db.GetService<IMigrator>().MigrateAsync(Before);
        var s = await SeedOldShapes(f);
        // An issue of a project that is gone (the old table had no key on its project).
        await f.Row("StageIssues", new() { ["Id"] = Guid.NewGuid(), ["TenantId"] = s.Tenant, ["ProjectId"] = Guid.NewGuid(), ["Number"] = 9, ["Title"] = "Lost", ["Severity"] = "Low",
            ["Status"] = "Observed", ["ReporterId"] = s.Owner, ["CreatedAt"] = DateTime.UtcNow });
        await using (var db = f.Db())
        {
            var ex = await Assert.ThrowsAsync<PostgresException>(() => db.Database.MigrateAsync());
            Assert.Contains("project that no longer exists", ex.MessageText);
        }
        // Nothing changed: the old tables are all there, no new ones, and the migration is still pending.
        Assert.Equal(6, await f.Count("SELECT count(*) FROM pg_class WHERE relname IN ('Tasks','StageIssues','WorkTasks','TaskComments','WorkTaskComments','WorkTaskAttachments')"));
        Assert.Equal(0, await f.Count("SELECT count(*) FROM pg_class WHERE relname IN ('WorkItems','legacy_Tasks')"));
        Assert.Equal(1, await f.Count("SELECT count(*) FROM pg_constraint WHERE conname = 'FK_TimeEntries_Tasks_TaskId'"));
    }
}
