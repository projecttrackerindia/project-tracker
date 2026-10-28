using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Editing from the Calendar writes the real records: a time entry is placed, moved and resized by its start and end (the same entry the
/// timesheet grid edits), a stale edit is refused instead of overwriting, a submitted week stays locked, someone else's entry is not yours to
/// move, a due date moved later needs its reason, and a meeting held by Project Tracker can be renamed by its organizer.
/// </summary>
[Collection("api")]
public class CalendarEditTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd");
    /// <summary>A wall-clock time on a day in the application's zone (India by default), as UTC.</summary>
    private static DateTime At(DateOnly d, int h, int m = 0) => DateTime.SpecifyKind(d.ToDateTime(new TimeOnly(h, m)).AddMinutes(-AppDay.OffsetMinutes), DateTimeKind.Utc);

    private async Task<(TestClient Owner, Guid Project, Guid Task)> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Kiran Calendar");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var project = await owner.CreateProjectAsync("Harbour Lights");
        var task = Guid.Parse(S((await owner.CreateTaskAsync(project, "Wire the lamp sensors", new { title = "Wire the lamp sensors", assigneeId = owner.UserId }))["id"]));
        return (owner, project, task);
    }

    [Fact]
    public async Task A_time_entry_is_placed_moved_and_resized_by_its_start_and_end()
    {
        var (c, project, task) = await Setup();
        var day = AppDay.Today.AddDays(-1);
        var made = await c.Post($"/api/v1/tasks/{task}/time", new { minutes = 0, startedAt = At(day, 10), endedAt = At(day, 11, 30), note = "Sensor bench" });
        Assert.True(made.Ok, made.ToString());
        Assert.Equal(90, made.Data!["minutes"]!.GetValue<int>());
        Assert.Equal(Iso(day), S(made.Data["workDate"]));
        Assert.False(made.Data["isRunning"]!.GetValue<bool>());
        var id = S(made.Data["id"]);
        var stamp = S(made.Data["stamp"]);

        // The timeline shows it at its real time, not approximated.
        var tl = (await c.Get($"/api/v1/timeline?from={Iso(day)}&to={Iso(day)}")).Data!;
        var ev = tl["events"]!.AsArray().First(e => S(e!["id"]) == $"time:{id}")!;
        Assert.False(ev["approximated"]!.GetValue<bool>());

        // Drag to 14:00 and stretch to 15:15: minutes follow, the stamp changes, the task's actual hours follow.
        var moved = await c.Put($"/api/v1/time/{id}", new { minutes = 0, workDate = Iso(day), note = "Sensor bench", startedAt = At(day, 14), endedAt = At(day, 15, 15), stamp });
        Assert.True(moved.Ok, moved.ToString());
        Assert.Equal(75, moved.Data!["minutes"]!.GetValue<int>());
        Assert.NotEqual(stamp, S(moved.Data["stamp"]));
        Assert.Equal(1.25m, (await c.Get($"/api/v1/tasks/{task}")).Data!["task"]!["actualHours"]!.GetValue<decimal>());

        // The same entry edited as minutes (the timesheet grid) keeps its start; the end follows.
        var asMinutes = await c.Put($"/api/v1/time/{id}", new { minutes = 30, workDate = Iso(day), note = "Sensor bench" });
        Assert.True(asMinutes.Ok, asMinutes.ToString());
        var placed = (await c.Get($"/api/v1/timeline?from={Iso(day)}&to={Iso(day)}")).Data!["events"]!.AsArray().First(e => S(e!["id"]) == $"time:{id}")!;
        Assert.Equal(At(day, 14), DateTime.Parse(S(placed["start"])).ToUniversalTime());
        Assert.Equal(At(day, 14, 30), DateTime.Parse(S(placed["end"])).ToUniversalTime());
    }

    [Fact]
    public async Task A_stale_edit_is_refused_instead_of_overwriting()
    {
        var (c, _, task) = await Setup();
        var day = AppDay.Today.AddDays(-1);
        var made = (await c.Post($"/api/v1/tasks/{task}/time", new { minutes = 45, workDate = Iso(day) })).Data!;
        var id = S(made["id"]); var seen = S(made["stamp"]);
        Assert.True((await c.Put($"/api/v1/time/{id}", new { minutes = 50, workDate = Iso(day), stamp = seen })).Ok);
        var stale = await c.Put($"/api/v1/time/{id}", new { minutes = 60, workDate = Iso(day), stamp = seen });
        Assert.Equal(HttpStatusCode.Conflict, stale.Status);
        Assert.Equal("TIME_ENTRY_CHANGED", stale.ErrorCode);
    }

    [Fact]
    public async Task Placement_is_validated()
    {
        var (c, _, task) = await Setup();
        var day = AppDay.Today.AddDays(-1);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post($"/api/v1/tasks/{task}/time", new { minutes = 0, startedAt = At(day, 12), endedAt = At(day, 11) })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post($"/api/v1/tasks/{task}/time", new { minutes = 0, startedAt = At(day, 12) })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post($"/api/v1/tasks/{task}/time", new { minutes = 0, startedAt = DateTime.UtcNow.AddHours(2), endedAt = DateTime.UtcNow.AddHours(3) })).Status);
    }

    [Fact]
    public async Task A_submitted_week_cannot_be_changed_from_the_calendar()
    {
        var (c, _, task) = await Setup();
        var day = AppDay.Today.AddDays(-7);
        var made = (await c.Post($"/api/v1/tasks/{task}/time", new { minutes = 0, startedAt = At(day, 9), endedAt = At(day, 10) })).Data!;
        var week = ProjectManagement.Application.Features.Time.TimesheetApprovalService.WeekOf(day);
        Assert.True((await c.Post("/api/v1/time/week/submit", new { weekStart = Iso(week) })).Ok);

        var entry = (await c.Get($"/api/v1/time?from={Iso(day)}&to={Iso(day)}")).Data!["entries"]!.AsArray().First(e => S(e!["id"]) == S(made["id"]))!;
        Assert.True(entry["locked"]!.GetValue<bool>());
        Assert.False(entry["canEdit"]!.GetValue<bool>());
        var move = await c.Put($"/api/v1/time/{S(made["id"])}", new { minutes = 0, workDate = Iso(day), startedAt = At(day, 11), endedAt = At(day, 12) });
        Assert.Equal(HttpStatusCode.Conflict, move.Status);
        Assert.Equal("TIMESHEET_LOCKED", move.ErrorCode);
        // Nor can new time be placed into it.
        var add = await c.Post($"/api/v1/tasks/{task}/time", new { minutes = 0, startedAt = At(day, 15), endedAt = At(day, 16) });
        Assert.Equal("TIMESHEET_LOCKED", add.ErrorCode);
        Assert.Equal(HttpStatusCode.Conflict, (await c.Delete($"/api/v1/time/{S(made["id"])}")).Status);
    }

    [Fact]
    public async Task Only_your_own_time_moves_and_only_onto_work_you_can_log_on()
    {
        var (c, project, task) = await Setup();
        var member = await c.AddMemberAsync(factory, TenantRole.Member, "Mira Member");
        var day = AppDay.Today.AddDays(-1);
        var id = S((await c.Post($"/api/v1/tasks/{task}/time", new { minutes = 0, startedAt = At(day, 9), endedAt = At(day, 10) })).Data!["id"]);
        var theirs = await member.Put($"/api/v1/time/{id}", new { minutes = 0, workDate = Iso(day), startedAt = At(day, 13), endedAt = At(day, 14) });
        Assert.Equal(HttpStatusCode.Forbidden, theirs.Status);

        // Moving the time to another task of the same project works, and both tasks' actual hours follow.
        var other = Guid.Parse(S((await c.CreateTaskAsync(project, "Paint the poles", new { title = "Paint the poles" }))["id"]));
        var re = await c.Put($"/api/v1/time/{id}", new { minutes = 60, workDate = Iso(day), taskId = other });
        Assert.True(re.Ok, re.ToString());
        Assert.Equal(other.ToString(), S(re.Data!["taskId"]));
        Assert.Equal(1m, (await c.Get($"/api/v1/tasks/{other}")).Data!["task"]!["actualHours"]!.GetValue<decimal>());
        Assert.Equal(0m, (await c.Get($"/api/v1/tasks/{task}")).Data!["task"]!["actualHours"]!.GetValue<decimal>());
        // A task the caller cannot see is not a place to move time to.
        Assert.Equal(HttpStatusCode.NotFound, (await c.Put($"/api/v1/time/{id}", new { minutes = 60, workDate = Iso(day), taskId = Guid.NewGuid() })).Status);
    }

    [Fact]
    public async Task Moving_a_due_date_later_needs_a_reason()
    {
        var (c, _, task) = await Setup();
        var due = AppDay.Today.AddDays(3);
        var t = (await c.Get($"/api/v1/tasks/{task}")).Data!["task"]!;
        Assert.True((await c.Put($"/api/v1/tasks/{task}", new { title = S(t["title"]), priority = "Medium", statusId = S(t["statusId"]), assigneeId = S(t["assignee"]!["id"]), dueDate = Iso(due), version = t["version"]!.GetValue<int>() })).Ok);
        t = (await c.Get($"/api/v1/tasks/{task}")).Data!["task"]!;
        var later = await c.Put($"/api/v1/tasks/{task}", new { title = S(t["title"]), priority = "Medium", statusId = S(t["statusId"]), assigneeId = S(t["assignee"]!["id"]), dueDate = Iso(due.AddDays(2)), version = t["version"]!.GetValue<int>() });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, later.Status);
        var withReason = await c.Put($"/api/v1/tasks/{task}", new { title = S(t["title"]), priority = "Medium", statusId = S(t["statusId"]), assigneeId = S(t["assignee"]!["id"]), dueDate = Iso(due.AddDays(2)), version = t["version"]!.GetValue<int>(), dueDateReason = "Waiting on the pole supplier" });
        Assert.True(withReason.Ok, withReason.ToString());
        // An old version is refused (someone else changed it in between).
        var stale = await c.Put($"/api/v1/tasks/{task}", new { title = S(t["title"]), priority = "Medium", statusId = S(t["statusId"]), assigneeId = S(t["assignee"]!["id"]), dueDate = Iso(due), version = t["version"]!.GetValue<int>() });
        Assert.Equal(HttpStatusCode.Conflict, stale.Status);
    }

    [Fact]
    public async Task The_organizer_renames_a_meeting_held_by_project_tracker_and_others_cannot()
    {
        var (c, project, _) = await Setup();
        var member = await c.AddMemberAsync(factory, TenantRole.Member, "Mira Member");
        await c.Post($"/api/v1/projects/{project}/members", new { userId = member.UserId, role = "Member" });
        var start = DateTimeOffset.UtcNow.AddDays(1);
        var made = await c.Post($"/api/v1/projects/{project}/meetings/schedule", new { title = "Lamp review", startTime = start, endTime = start.AddHours(1), timeZone = "UTC", service = "ours" });
        Assert.True(made.Ok, made.ToString());
        var id = S(made.Data!["id"]);

        var renamed = await c.Send(HttpMethod.Patch, $"/api/v1/meetings/{id}", new { title = "Lamp review · sign-off", description = "1. Sensor results\n2. Paint colour" });
        Assert.True(renamed.Ok, renamed.ToString());
        Assert.Equal("Lamp review · sign-off", S(renamed.Data!["title"]));
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Send(HttpMethod.Patch, $"/api/v1/meetings/{id}", new { title = "Mine now" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Send(HttpMethod.Patch, $"/api/v1/meetings/{id}", new { title = "  " })).Status);

        // A Google meeting is edited in Google Calendar, so the invitation never says something else.
        var google = await c.Post($"/api/v1/projects/{project}/meetings/schedule", new { title = "On Meet", startTime = start, endTime = start.AddHours(1), timeZone = "UTC", service = "google" });
        if (google.Ok)
        {
            var g = await c.Send(HttpMethod.Patch, $"/api/v1/meetings/{S(google.Data!["id"])}", new { title = "Renamed" });
            Assert.Equal(HttpStatusCode.Conflict, g.Status);
            Assert.Equal("MEETING_EDIT_IN_CALENDAR", g.ErrorCode);
        }
    }
}
