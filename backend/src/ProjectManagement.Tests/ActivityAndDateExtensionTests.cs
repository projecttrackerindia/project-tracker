using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Field-level activity (GET /api/v1/activity), the date-extension rule (a later date needs a reason on every path, 422
/// DATE_EXTENSION_REASON_REQUIRED otherwise, kept as date history and told to the owner and the project manager), restore endpoints for Undo,
/// change notices folded per burst, and action items that are never saved twice. Fictional data only.
/// </summary>
[Collection("api")]
public class ActivityAndDateExtensionTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n?.GetValue<string>()!;   // null for a JSON null (an event has no field)
    private static string Iso(int days) => AppDay.Today.AddDays(days).ToString("yyyy-MM-dd");

    private sealed record World(TestClient Lead, TestClient Dev, Guid Project);

    private async Task<World> Setup(string name = "Lantern Rollout")
    {
        var lead = await TestClient.RegisterAsync(factory, "Lena Lead");
        await lead.CreateOrgAsync();
        await lead.UpgradeAsync("BUSINESS");
        var dev = await lead.AddMemberAsync(factory, TenantRole.Member, "Dario Dev");
        var made = await lead.Post("/api/v1/projects", new { name, priority = "Medium", ownerId = lead.UserId, startDate = Iso(-5), dueDate = Iso(60) });
        Assert.True(made.Ok, made.ToString());
        var project = Guid.Parse(S(made.Data!["project"]!["id"]));
        Assert.True((await lead.Post($"/api/v1/projects/{project}/members", new { userId = dev.UserId })).Ok);
        return new World(lead, dev, project);
    }

    private static async Task<int> Version(TestClient c, Guid id) => (await c.Get($"/api/v1/work-items/{id}")).Data!["version"]!.GetValue<int>();

    private static async Task<Guid> TaskAsync(TestClient c, Guid project, string title, object body) =>
        Guid.Parse(S((await c.CreateTaskAsync(project, title, body))["id"]));

    private static async Task<JsonArray> Activity(TestClient c, string type, Guid id, int page = 1, int pageSize = 50)
    {
        var res = await c.Get($"/api/v1/activity?entityType={type}&entityId={id}&page={page}&pageSize={pageSize}");
        Assert.True(res.Ok, res.ToString());
        return res.Data!["items"]!.AsArray();
    }

    private static async Task<JsonArray> Bell(TestClient c) => (await c.Get("/api/v1/notifications")).Data!["items"]!.AsArray();

    // ------------------------------------------------------------------ activity

    [Fact]
    public async Task Activity_lists_who_changed_which_field_from_what_to_what_paged_and_only_for_people_who_can_see_it()
    {
        var w = await Setup();
        var task = await TaskAsync(w.Lead, w.Project, "Draft the beacon spec", new { title = "Draft the beacon spec", priority = "Low" });
        var renamed = await w.Lead.Patch($"/api/v1/work-items/{task}", new { version = await Version(w.Lead, task), title = "Draft the beacon protocol", priority = "High" });
        Assert.True(renamed.Ok, renamed.ToString());

        var items = await Activity(w.Lead, "task", task);
        var title = items.Single(i => S(i!["field"]) == "Title" && S(i["action"]) == "updated")!;
        Assert.Equal("Draft the beacon spec", S(title["from"]));
        Assert.Equal("Draft the beacon protocol", S(title["to"]));
        Assert.Equal("Lena Lead", S(title["actor"]!["name"]));
        Assert.Contains(items, i => S(i!["field"]) == "Priority" && S(i["from"]) == "Low" && S(i["to"]) == "High");
        Assert.Contains(items, i => S(i!["action"]) == "created" && i["field"] is null);
        Assert.All(items, i => Assert.False(string.IsNullOrEmpty(S(i!["summary"]))));
        Assert.Equal(items.Count, items.Select(i => S(i!["id"])).Distinct().Count());

        // Paged: newest first, one per page.
        var paged = await w.Lead.Get($"/api/v1/activity?entityType=task&entityId={task}&page=2&pageSize=1");
        Assert.Equal(1, paged.Data!["items"]!.AsArray().Count);
        Assert.Equal(items.Count, paged.Data!["totalItems"]!.GetValue<int>());

        // Someone outside the workspace gets 404; an unknown kind is refused; the workspace feed still works without entityType.
        var stranger = await TestClient.RegisterAsync(factory, "Sven Stranger");
        await stranger.CreateOrgAsync();
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.Get($"/api/v1/activity?entityType=task&entityId={task}")).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await w.Lead.Get($"/api/v1/activity?entityType=spaceship&entityId={task}")).Status);
        Assert.True((await w.Lead.Get("/api/v1/activity")).Ok);
    }

    [Fact]
    public async Task Activity_covers_projects_action_items_notes_reminders_and_approvals()
    {
        var w = await Setup("Harbor Ledger");
        var renamed = await w.Lead.Get($"/api/v1/projects/{w.Project}");
        Assert.True(renamed.Ok, renamed.ToString());
        Assert.NotEmpty(await Activity(w.Lead, "project", w.Project));

        var item = await w.Lead.Post($"/api/v1/projects/{w.Project}/action-items", new { title = "Collect the dock permits", priority = "Medium" });
        Assert.True(item.Ok, item.ToString());
        var itemId = Guid.Parse(S(item.Data!["id"]));
        Assert.True((await w.Lead.Put($"/api/v1/projects/{w.Project}/action-items/{itemId}/status", new { status = "InProgress" })).Ok);
        Assert.Contains(await Activity(w.Lead, "action-item", itemId), i => S(i!["field"]) == "Status" && S(i["to"]) == "InProgress");

        var note = await w.Lead.Post("/api/v1/notes", new { title = "Harbor kickoff" });
        Assert.True(note.Ok, note.ToString());
        var noteId = Guid.Parse(S(note.Data!["id"]));
        Assert.True((await w.Lead.Patch($"/api/v1/notes/{noteId}", new { title = "Harbor kickoff notes" })).Ok);
        Assert.Contains(await Activity(w.Lead, "note", noteId), i => S(i!["field"]) == "Title" && S(i["to"]) == "Harbor kickoff notes");
        Assert.Equal(HttpStatusCode.NotFound, (await w.Dev.Get($"/api/v1/activity?entityType=note&entityId={noteId}")).Status);   // a private note

        var reminder = await w.Lead.Post("/api/v1/reminders", new { title = "Check the tide tables", when = new { at = DateTime.UtcNow.AddDays(2).ToString("yyyy-MM-ddTHH:mm"), timeZone = "UTC" } });
        Assert.True(reminder.Ok, reminder.ToString());
        var reminderId = Guid.Parse(S(reminder.Data!["id"]));
        Assert.True((await w.Lead.Put($"/api/v1/reminders/{reminderId}", new { title = "Check the tide tables twice" })).Ok);
        Assert.Contains(await Activity(w.Lead, "reminder", reminderId), i => S(i!["field"]) == "Title" && S(i["to"]) == "Check the tide tables twice");
        Assert.Equal(HttpStatusCode.NotFound, (await w.Dev.Get($"/api/v1/activity?entityType=reminder&entityId={reminderId}")).Status);
    }

    // ------------------------------------------------------------------ date extensions

    [Fact]
    public async Task A_later_date_without_a_reason_is_refused_on_every_path_and_kept_with_its_reason_when_given()
    {
        var w = await Setup("Quarry Atlas");
        var task = await TaskAsync(w.Lead, w.Project, "Survey the north pit", new { title = "Survey the north pit", priority = "Medium", startDate = Iso(1), dueDate = Iso(10) });

        // The one Work API (also what the plan sheet, the timeline and the calendar use): a later start or due needs a reason.
        var noReason = await w.Lead.Patch($"/api/v1/work-items/{task}", new { version = await Version(w.Lead, task), startDate = Iso(3) });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, noReason.Status);
        Assert.Equal("DATE_EXTENSION_REASON_REQUIRED", noReason.ErrorCode);
        Assert.Equal("extensionReason", S(noReason.Json!["errors"]![0]!["field"]));
        var laterDue = await w.Lead.Patch($"/api/v1/work-items/{task}", new { version = await Version(w.Lead, task), dueDate = Iso(14) });
        Assert.Equal("DATE_EXTENSION_REASON_REQUIRED", laterDue.ErrorCode);
        // Earlier needs nothing.
        Assert.True((await w.Lead.Patch($"/api/v1/work-items/{task}", new { version = await Version(w.Lead, task), dueDate = Iso(9) })).Ok);

        var moved = await w.Lead.Patch($"/api/v1/work-items/{task}", new { version = await Version(w.Lead, task), startDate = Iso(2), dueDate = Iso(15), extensionReason = "Drill rig arrives late" });
        Assert.True(moved.Ok, moved.ToString());
        var history = await Activity(w.Lead, "task", task);
        var due = history.First(i => S(i!["action"]) == "date_extended" && S(i["field"]) == "Due date")!;
        Assert.Equal(Iso(9), S(due["from"]));
        Assert.Equal(Iso(15), S(due["to"]));
        Assert.Equal("Drill rig arrives late", S(due["reason"]));
        Assert.Contains(history, i => S(i!["action"]) == "date_extended" && S(i["field"]) == "Start date" && S(i["reason"]) == "Drill rig arrives late");

        // The task carries its slip: the first due date, how many extensions, days late against the original.
        var dto = (await w.Lead.Get($"/api/v1/tasks/{task}")).Data!["task"]!;
        Assert.Equal(Iso(10), S(dto["originalDate"]));
        Assert.Equal(1, dto["extensionCount"]!.GetValue<int>());
        Assert.Equal(5, dto["totalSlipDays"]!.GetValue<int>());

        // Plan sheet bulk: refused per row without the batch's reason.
        var bulk = await w.Lead.Post("/api/v1/portfolio/sheet/bulk", new { changes = new object[] { new { id = task, version = await Version(w.Lead, task), startDate = Iso(4) } } });
        Assert.True(bulk.Ok, bulk.ToString());
        Assert.Equal("DATE_EXTENSION_REASON_REQUIRED", S(bulk.Data!["rows"]![0]!["code"]));

        // Projects: a later start or due date.
        var project = (await w.Lead.Get($"/api/v1/projects/{w.Project}")).Data!["project"]!;
        var projectBody = new { name = "Quarry Atlas", priority = "Medium", status = S(project["status"]), ownerId = w.Lead.UserId, startDate = Iso(-5), dueDate = Iso(70), version = project["version"]!.GetValue<int>() };
        var refusedProject = await w.Lead.Put($"/api/v1/projects/{w.Project}", projectBody);
        Assert.Equal("DATE_EXTENSION_REASON_REQUIRED", refusedProject.ErrorCode);
        var savedProject = await w.Lead.Put($"/api/v1/projects/{w.Project}", new { name = "Quarry Atlas", priority = "Medium", status = S(project["status"]), ownerId = w.Lead.UserId, startDate = Iso(-5), dueDate = Iso(70), version = project["version"]!.GetValue<int>(), extensionReason = "Permit review extended" });
        Assert.True(savedProject.Ok, savedProject.ToString());
        var after = (await w.Lead.Get($"/api/v1/projects/{w.Project}")).Data!["project"]!;
        Assert.Equal(Iso(60), S(after["originalDate"]));
        Assert.Equal(1, after["extensionCount"]!.GetValue<int>());
        Assert.Equal(10, after["totalSlipDays"]!.GetValue<int>());

        // Action items and milestones.
        var item = Guid.Parse(S((await w.Lead.Post($"/api/v1/projects/{w.Project}/action-items", new { title = "Book the blasting crew", dueDate = Iso(5) })).Data!["id"]));
        var refusedItem = await w.Lead.Put($"/api/v1/projects/{w.Project}/action-items/{item}", new { title = "Book the blasting crew", dueDate = Iso(8), priority = "Medium", status = "Open" });
        Assert.Equal("DATE_EXTENSION_REASON_REQUIRED", refusedItem.ErrorCode);
        Assert.True((await w.Lead.Put($"/api/v1/projects/{w.Project}/action-items/{item}", new { title = "Book the blasting crew", dueDate = Iso(8), priority = "Medium", status = "Open", extensionReason = "Crew on another site" })).Ok);
        var slipped = (await w.Lead.Get($"/api/v1/projects/{w.Project}/action-items")).Data!.AsArray().Single(x => S(x!["id"]) == item.ToString())!;
        Assert.Equal(Iso(5), S(slipped["originalDate"]));
        Assert.Equal(1, slipped["extensionCount"]!.GetValue<int>());
        Assert.Equal(3, slipped["totalSlipDays"]!.GetValue<int>());
        Assert.Contains(await Activity(w.Lead, "actionitem", item), i => S(i!["action"]) == "date_extended" && S(i["reason"]) == "Crew on another site");

        var milestone = Guid.Parse(S((await w.Lead.Post($"/api/v1/projects/{w.Project}/milestones", new { name = "Pit open", dueDate = Iso(20), status = "Pending" })).Data![0]!["id"]));
        var refusedMilestone = await w.Lead.Put($"/api/v1/projects/{w.Project}/milestones/{milestone}", new { name = "Pit open", dueDate = Iso(25), status = "Pending" });
        Assert.Equal("DATE_EXTENSION_REASON_REQUIRED", refusedMilestone.ErrorCode);
        Assert.True((await w.Lead.Put($"/api/v1/projects/{w.Project}/milestones/{milestone}", new { name = "Pit open", dueDate = Iso(25), status = "Pending", extensionReason = "Survey moved" })).Ok);
        Assert.Contains(await Activity(w.Lead, "project", w.Project), i => S(i!["field"]) == "Milestone due date" && S(i["reason"]) == "Survey moved");
    }

    [Fact]
    public async Task An_extension_tells_the_owner_and_the_project_manager_with_the_reason_and_never_the_person_who_moved_it()
    {
        var w = await Setup("Meadow Grid");
        var task = await TaskAsync(w.Lead, w.Project, "Wire the substation", new { title = "Wire the substation", priority = "Medium", assigneeId = w.Dev.UserId, dueDate = Iso(7) });
        var moved = await w.Dev.Patch($"/api/v1/work-items/{task}", new { version = await Version(w.Dev, task), dueDate = Iso(12), extensionReason = "Transformer delivery slipped" });
        Assert.True(moved.Ok, moved.ToString());

        var lead = (await Bell(w.Lead)).Where(n => n!["link"]?.GetValue<string>()?.Contains(task.ToString()) == true).ToList();
        Assert.Contains(lead, n => S(n!["body"]).Contains("Transformer delivery slipped"));
        Assert.DoesNotContain(await Bell(w.Dev), n => n!["body"]?.GetValue<string>()?.Contains("Transformer delivery slipped") == true);
    }

    // ------------------------------------------------------------------ notifications

    [Fact]
    public async Task Changes_in_quick_succession_to_one_task_fold_into_one_notice_per_person()
    {
        var w = await Setup("Orchard Sync");
        var task = await TaskAsync(w.Lead, w.Project, "Index the orchard rows", new { title = "Index the orchard rows", priority = "Low", assigneeId = w.Dev.UserId });
        Assert.True((await w.Lead.Patch($"/api/v1/work-items/{task}", new { version = await Version(w.Lead, task), priority = "High" })).Ok);
        Assert.True((await w.Lead.Patch($"/api/v1/work-items/{task}", new { version = await Version(w.Lead, task), title = "Index every orchard row" })).Ok);

        var notices = (await Bell(w.Dev)).Where(n => S(n!["type"]) == "TaskUpdated" && n["link"]?.GetValue<string>()?.Contains(task.ToString()) == true).ToList();
        var one = Assert.Single(notices)!;
        Assert.Contains("priority", S(one["body"]));
        Assert.Contains("renamed", S(one["body"]));
        // The person who made the changes is not told about them.
        Assert.DoesNotContain(await Bell(w.Lead), n => S(n!["type"]) == "TaskUpdated" && n["link"]?.GetValue<string>()?.Contains(task.ToString()) == true);
    }

    // ------------------------------------------------------------------ restore

    [Fact]
    public async Task Restore_brings_back_projects_tasks_action_items_notes_and_reminders_and_their_archived_notices()
    {
        var w = await Setup("Glacier Desk");
        var task = await TaskAsync(w.Lead, w.Project, "Calibrate the ice probe", new { title = "Calibrate the ice probe", priority = "Medium", assigneeId = w.Dev.UserId });
        Assert.Contains(await Bell(w.Dev), n => n!["link"]?.GetValue<string>()?.Contains(task.ToString()) == true);

        Assert.Equal(HttpStatusCode.NoContent, (await w.Lead.Delete($"/api/v1/tasks/{task}")).Status);
        Assert.DoesNotContain(await Bell(w.Dev), n => n!["link"]?.GetValue<string>()?.Contains($"task={task}") == true);
        var back = await w.Lead.Post($"/api/v1/tasks/{task}/restore");
        Assert.True(back.Ok, back.ToString());
        Assert.Equal(task.ToString(), S(back.Data!["task"]!["id"]));
        Assert.Contains(await Bell(w.Dev), n => n!["link"]?.GetValue<string>()?.Contains($"task={task}") == true && S(n["type"]) == "TaskAssigned");
        Assert.Equal(HttpStatusCode.NotFound, (await w.Lead.Post($"/api/v1/tasks/{task}/restore")).Status);   // not deleted any more

        var item = Guid.Parse(S((await w.Lead.Post($"/api/v1/projects/{w.Project}/action-items", new { title = "Order spare probes" })).Data!["id"]));
        Assert.Equal(HttpStatusCode.NoContent, (await w.Lead.Delete($"/api/v1/projects/{w.Project}/action-items/{item}")).Status);
        var itemBack = await w.Lead.Post($"/api/v1/projects/{w.Project}/action-items/{item}/restore");
        Assert.True(itemBack.Ok, itemBack.ToString());
        Assert.Equal("Order spare probes", S(itemBack.Data!["title"]));

        var note = Guid.Parse(S((await w.Lead.Post("/api/v1/notes", new { title = "Probe log" })).Data!["id"]));
        Assert.Equal(HttpStatusCode.NoContent, (await w.Lead.Delete($"/api/v1/notes/{note}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await w.Lead.Get($"/api/v1/notes/{note}")).Status);
        Assert.Equal("Probe log", S((await w.Lead.Post($"/api/v1/notes/{note}/restore")).Data!["title"]));
        Assert.True((await w.Lead.Get($"/api/v1/notes/{note}")).Ok);

        var reminder = Guid.Parse(S((await w.Lead.Post("/api/v1/reminders", new { title = "Recharge the probe", when = new { at = DateTime.UtcNow.AddDays(1).ToString("yyyy-MM-ddTHH:mm"), timeZone = "UTC" } })).Data!["id"]));
        Assert.Equal(HttpStatusCode.NoContent, (await w.Lead.Delete($"/api/v1/reminders/{reminder}")).Status);
        Assert.DoesNotContain((await w.Lead.Get("/api/v1/reminders")).Data!["open"]!.AsArray(), r => S(r!["id"]) == reminder.ToString());
        Assert.Equal("Scheduled", S((await w.Lead.Post($"/api/v1/reminders/{reminder}/restore")).Data!["state"]));
        Assert.Contains((await w.Lead.Get("/api/v1/reminders")).Data!["open"]!.AsArray(), r => S(r!["id"]) == reminder.ToString());
        Assert.Equal(HttpStatusCode.NotFound, (await w.Dev.Post($"/api/v1/reminders/{reminder}/restore")).Status);

        // The project, with the task and action item deleted with it.
        Assert.Equal(HttpStatusCode.NoContent, (await w.Lead.Delete($"/api/v1/projects/{w.Project}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await w.Lead.Get($"/api/v1/tasks/{task}")).Status);
        Assert.False((await w.Dev.Post($"/api/v1/projects/{w.Project}/restore")).Ok);   // not theirs to undo
        var projectBack = await w.Lead.Post($"/api/v1/projects/{w.Project}/restore");
        Assert.True(projectBack.Ok, projectBack.ToString());
        Assert.True((await w.Lead.Get($"/api/v1/tasks/{task}")).Ok);
        Assert.Contains((await w.Lead.Get($"/api/v1/projects/{w.Project}/action-items")).Data!.AsArray(), x => S(x!["id"]) == item.ToString());
        Assert.Contains(await Activity(w.Lead, "project", w.Project), i => S(i!["action"]) == "restored");
    }

    // ------------------------------------------------------------------ action items saved once

    [Fact]
    public async Task The_same_action_item_sent_twice_at_once_is_saved_once()
    {
        var w = await Setup("Canyon Relay");
        var url = $"/api/v1/projects/{w.Project}/action-items";
        var body = new { title = "Confirm the relay tower lease", assigneeId = w.Dev.UserId, dueDate = Iso(4) };
        var both = await Task.WhenAll(w.Lead.Post(url, body), w.Lead.Post(url, body));
        Assert.All(both, r => Assert.True(r.Ok, r.ToString()));
        Assert.Equal(S(both[0].Data!["id"]), S(both[1].Data!["id"]));
        var again = await w.Lead.Post(url, new { title = "confirm the relay tower lease ", assigneeId = w.Dev.UserId, dueDate = Iso(4) });
        Assert.Equal(S(both[0].Data!["id"]), S(again.Data!["id"]));
        Assert.Single((await w.Lead.Get(url)).Data!.AsArray(), x => S(x!["title"]) == "Confirm the relay tower lease");

        // A different owner or date is a different item.
        var other = await w.Lead.Post(url, new { title = "Confirm the relay tower lease", dueDate = Iso(6) });
        Assert.NotEqual(S(both[0].Data!["id"]), S(other.Data!["id"]));
    }
}
