using System.Net;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// DEMO lifecycle (owner request; test data only, in the test environment): a DEMO task, a DEMO reminder about it and a DEMO ticket for one
/// member, followed through every view that shows them - My Work, Today (inbox), Calendar and Reminders - while they are created, edited
/// (due date, status, assignee), completed, deleted and restored; plus a duplicate submit with one Idempotency-Key and invalid input.
/// Each check is one row of the reconciliation table (record × view: expected vs actual).
/// </summary>
[Collection("api")]
public class DemoLifecycleTests(ApiFactory factory)
{
    private const string TaskText = "Workspace validation and data consistency testing";
    private const string TicketText = "Workspace functionality, workflow, and data integrity validation";
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static string Iso(int days) => AppDay.Today.AddDays(days).ToString("yyyy-MM-dd");

    /// <summary>The reconciliation table: every check, with what was expected and what the API answered.</summary>
    private readonly List<(string Record, string View, string Expected, string Actual)> table = [];

    private void Check(string record, string view, string expected, string actual)
    {
        table.Add((record, view, expected, actual));
        Assert.True(expected == actual, $"{record} × {view}: expected {expected}, got {actual}");
    }

    private sealed record Views(JsonArray MyWork, JsonArray Inbox, JsonArray Calendar, JsonArray Reminders);

    private static async Task<Views> Read(TestClient c) => new(
        (await c.Get("/api/v1/work-items?mine=true&status=all&limit=200")).Data!["items"]!.AsArray(),
        (await c.Get("/api/v1/inbox")).Data!["rows"]!.AsArray(),
        (await c.Get($"/api/v1/calendar?from={Iso(-3)}&to={Iso(14)}&mine=true")).Data!.AsArray(),
        (await c.Get("/api/v1/reminders")).Data!["open"]!.AsArray());

    private static string In(JsonArray rows, string id, string field = "id") => rows.Any(r => r?[field]?.GetValue<string>() is { } v && v.Contains(id)) ? "listed" : "absent";
    private static string Field(JsonArray rows, string id, string field) => rows.FirstOrDefault(r => r?["id"]?.GetValue<string>() == id)?[field]?.ToString() ?? "absent";

    [Fact]
    public async Task Demo_records_appear_in_every_view_follow_every_edit_and_reminders_follow_their_task()
    {
        // ---- the workspace and its member (test data only)
        var owner = await TestClient.RegisterAsync(factory, "Owner Demo");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Prasanna Krishna");
        var project = await owner.CreateProjectAsync("DEMO Workspace");
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = member.UserId })).Ok);
        var bugFix = S((await owner.Get("/api/v1/work-types?includeInactive=true")).Data!.AsArray().First(t => S(t!["name"]) == "Bug Fix")!["id"]);

        // ---- create: a DEMO task due today, a DEMO reminder on it, a DEMO ticket (high priority) - all for Prasanna
        var task = await owner.Post("/api/v1/work-items", new { kind = "task", projectId = project, title = "DEMO task", description = TaskText, priority = "High", assigneeId = member.UserId, dueDate = Iso(0) });
        Assert.Equal(HttpStatusCode.Created, task.Status);
        var taskId = S(task.Data!["id"]);
        var reminder = await member.Post("/api/v1/reminders", new { title = "DEMO reminder", targetType = "Task", targetId = taskId, when = new { anchorDays = 1, anchorTime = "09:00", timeZone = "Asia/Kolkata" } });
        Assert.True(reminder.Ok, reminder.ToString());
        var reminderId = S(reminder.Data!["id"]);
        var ticket = await owner.Post("/api/v1/work-items", new { kind = "ticket", workTypeId = bugFix, title = "DEMO ticket", description = TicketText, priority = "High", assigneeId = member.UserId, dueDate = Iso(3) });
        Assert.Equal(HttpStatusCode.Created, ticket.Status);
        var ticketId = S(ticket.Data!["id"]);
        Check("DEMO task", "detail", TaskText, S((await member.Get($"/api/v1/work-items/{taskId}")).Data!["description"]));
        Check("DEMO ticket", "detail", TicketText, S((await member.Get($"/api/v1/work-items/{ticketId}")).Data!["description"]));

        var v = await Read(member);
        Check("DEMO task", "My Work", "listed", In(v.MyWork, taskId));
        Check("DEMO task", "Today (inbox)", "listed", In(v.Inbox, taskId, "href"));
        Check("DEMO task", "Calendar", "listed", In(v.Calendar, taskId));
        Check("DEMO ticket", "My Work", "listed", In(v.MyWork, ticketId));
        Check("DEMO ticket", "Today (inbox)", "listed", In(v.Inbox, ticketId, "href"));
        Check("DEMO ticket", "Calendar", "listed", In(v.Calendar, ticketId));
        Check("DEMO reminder", "Reminders", "listed", In(v.Reminders, reminderId));
        Check("DEMO reminder", "Reminders · target", "DEMO task", Field(v.Reminders, reminderId, "targetTitle"));

        // ---- edit: due date, status, assignee - every view follows
        async Task<int> Ver(string id) => (await owner.Get($"/api/v1/work-items/{id}")).Data!["version"]!.GetValue<int>();
        Assert.True((await owner.Patch($"/api/v1/work-items/{taskId}", new { version = await Ver(taskId), dueDate = Iso(2), title = "DEMO task (renamed)" })).Ok);
        v = await Read(member);
        Check("DEMO task", "My Work · due", Iso(2), Field(v.MyWork, taskId, "dueDate"));
        Check("DEMO task", "Today (inbox)", "absent", In(v.Inbox, taskId, "href"));                       // no longer due today
        Check("DEMO task", "Calendar · date", Iso(2), Field(v.Calendar, taskId, "date"));
        Check("DEMO reminder", "Reminders · target", "DEMO task (renamed)", Field(v.Reminders, reminderId, "targetTitle"));
        var fire = DateTime.Parse(Field(v.Reminders, reminderId, "nextFireAt"), null, System.Globalization.DateTimeStyles.AdjustToUniversal);
        Check("DEMO reminder", "Reminders · moved with due (a day after it)", Iso(3), DateOnly.FromDateTime(fire.AddMinutes(330)).ToString("yyyy-MM-dd"));

        Assert.True((await owner.Patch($"/api/v1/work-items/{ticketId}", new { version = await Ver(ticketId), status = "InProgress" })).Ok);
        v = await Read(member);
        Check("DEMO ticket", "My Work · status", "In Progress", Field(v.MyWork, ticketId, "status"));
        Check("DEMO ticket", "Calendar · status", "In Progress", Field(v.Calendar, ticketId, "status"));

        Assert.True((await owner.Patch($"/api/v1/work-items/{ticketId}", new { version = await Ver(ticketId), assigneeId = owner.UserId })).Ok);
        v = await Read(member);
        Check("DEMO ticket", "My Work (Prasanna) after reassign", "absent", In(v.MyWork, ticketId));
        Check("DEMO ticket", "Calendar (Prasanna) after reassign", "absent", In(v.Calendar, ticketId));
        Check("DEMO ticket", "My Work (new assignee)", "listed", In((await Read(owner)).MyWork, ticketId));

        // ---- complete: the reminder kept "only while open" finishes with the task
        var statuses = (await owner.Get($"/api/v1/projects/{project}")).Data!["statuses"]!.AsArray();
        var done = S(statuses.First(s => S(s!["category"]) == "Done")!["id"]);
        Assert.True((await member.Patch($"/api/v1/work-items/{taskId}", new { version = await Ver(taskId), statusId = done })).Ok);
        v = await Read(member);
        Check("DEMO task", "My Work · category", "Done", Field(v.MyWork, taskId, "category"));
        Check("DEMO reminder", "Reminders (open) after complete", "absent", In(v.Reminders, reminderId));
        var all = (await member.Get("/api/v1/reminders")).Data!["completed"]!.AsArray();
        Check("DEMO reminder", "Reminders (completed) after complete", "listed", In(all, reminderId));

        // ---- reopen, delete, restore: the reminder is orphaned with the task and comes back with it
        var todo = S(statuses.First(s => S(s!["category"]) == "Todo")!["id"]);
        Assert.True((await member.Patch($"/api/v1/work-items/{taskId}", new { version = await Ver(taskId), statusId = todo })).Ok);
        Assert.True((await member.Post($"/api/v1/reminders/{reminderId}/reopen")).Ok);
        Check("DEMO reminder", "Reminders after reopen", "listed", In((await Read(member)).Reminders, reminderId));
        Assert.True((await owner.Delete($"/api/v1/work-items/{taskId}")).Status is HttpStatusCode.NoContent or HttpStatusCode.OK);
        v = await Read(member);
        Check("DEMO task", "My Work after delete", "absent", In(v.MyWork, taskId));
        Check("DEMO task", "Calendar after delete", "absent", In(v.Calendar, taskId));
        Check("DEMO reminder", "Reminders after delete", "absent", In(v.Reminders, reminderId));
        using (var scope = factory.Services.CreateScope())
        {
            var ctx = scope.ServiceProvider.GetRequiredService<CurrentContext>();
            ctx.UserId = owner.UserId; ctx.TenantId = owner.WorkspaceId; ctx.Role = TenantRole.Owner;
            await scope.ServiceProvider.GetRequiredService<ProjectManagement.Application.Features.Tasks.TaskService>().RestoreAsync(Guid.Parse(taskId));
        }
        v = await Read(member);
        Check("DEMO task", "My Work after restore", "listed", In(v.MyWork, taskId));
        Check("DEMO reminder", "Reminders after restore", "listed", In(v.Reminders, reminderId));

        // ---- the same submit twice with one Idempotency-Key makes one record
        member.Extra["Idempotency-Key"] = $"demo-{Guid.NewGuid():N}";
        var r1 = await member.Post("/api/v1/reminders", new { title = "DEMO duplicate", when = new { at = DateTime.UtcNow.AddHours(5).AddMinutes(330).ToString("yyyy-MM-ddTHH:mm"), timeZone = "Asia/Kolkata" } });
        var r2 = await member.Post("/api/v1/reminders", new { title = "DEMO duplicate", when = new { at = DateTime.UtcNow.AddHours(5).AddMinutes(330).ToString("yyyy-MM-ddTHH:mm"), timeZone = "Asia/Kolkata" } });
        member.Extra.Remove("Idempotency-Key");
        Assert.True(r1.Ok && r2.Ok, r2.ToString());
        Check("DEMO duplicate", "Reminders · records", "1", (await Read(member)).Reminders.Count(r => S(r!["title"]) == "DEMO duplicate").ToString());
        Check("DEMO duplicate", "replayed id", S(r1.Data!["id"]), S(r2.Data!["id"]));

        // ---- invalid input is refused with 422
        Check("DEMO task", "invalid (no title)", "422", ((int)(await owner.Post("/api/v1/work-items", new { kind = "task", projectId = project, title = "" })).Status).ToString());
        Check("DEMO task", "invalid (due before start)", "422", ((int)(await owner.Post("/api/v1/work-items", new { kind = "task", projectId = project, title = "DEMO bad dates", startDate = Iso(3), dueDate = Iso(1) })).Status).ToString());
        Check("DEMO reminder", "invalid (time passed)", "422", ((int)(await member.Post("/api/v1/reminders", new { title = "DEMO past", when = new { at = "2020-01-01T09:00", timeZone = "Asia/Kolkata" } })).Status).ToString());

        // The reconciliation table, for the run's log.
        foreach (var (record, view, expected, actual) in table) Console.WriteLine($"| {record} | {view} | {expected} | {actual} |");
        Assert.All(table, t => Assert.Equal(t.Expected, t.Actual));
    }
}
