using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.Inbox;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Due times and service levels: an optional time of day on every kind of work (round trip, "a later time needs a reason", kept when a client
/// does not send it), SLA clocks counted in working hours (default 09:30-18:30 Monday to Friday in the organization's zone), the SLA
/// resolve-by standing in as a ticket's due, breach state, the timeline's markers and the inbox ordered by time to breach.
/// </summary>
[Collection("api")]
public class DueTimeSlaTests(ApiFactory factory)
{
    private const string Url = "/api/v1/work-items";
    private static readonly NodaTime.DateTimeZone Kolkata = ZoneTime.Find("Asia/Kolkata");
    private static string Iso(int daysFromToday) => AppDay.Today.AddDays(daysFromToday).ToString("yyyy-MM-dd");
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static int I(JsonNode? n) => n!.GetValue<int>();
    private static int V(ApiResult r) => r.Data!["version"]!.GetValue<int>();
    private static DateTime At(JsonNode? n) => DateTime.Parse(S(n), null, System.Globalization.DateTimeStyles.RoundtripKind).ToUniversalTime();
    /// <summary>The UTC instant of a wall-clock time on a day in India (the test users' zone).</summary>
    private static DateTime Ist(int daysFromToday, int hour, int minute) => ZoneTime.ToUtc(AppDay.Today.AddDays(daysFromToday).ToDateTime(new TimeOnly(hour, minute)), Kolkata);

    private sealed record World(TestClient Owner, TestClient Dev, Guid Project, string BugFix, Guid Tenant);

    private async Task<World> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Developer");
        var project = await owner.CreateProjectAsync("Payment Engine");
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = dev.UserId })).Ok);
        var types = (await owner.Get("/api/v1/work-types?includeInactive=true")).Data!.AsArray();
        var bugFix = S(types.First(t => S(t!["name"]) == "Bug Fix")!["id"]);
        var tenant = factory.WithDb(db => db.Projects.IgnoreQueryFilters().First(p => p.Id == project).TenantId);
        return new World(owner, dev, project, bugFix, tenant);
    }

    private static async Task<ApiResult> New(TestClient c, object body)
    {
        var r = await c.Post(Url, body);
        Assert.True(r.Status == HttpStatusCode.Created, r.ToString());
        return r;
    }

    // ------------------------------------------------------------------ due times

    [Fact]
    public async Task A_due_time_round_trips_on_every_kind_and_moving_it_later_needs_a_reason()
    {
        var w = await Setup();
        var task = await New(w.Owner, new { kind = "task", projectId = w.Project, title = "Wire the refund API", assigneeId = w.Dev.UserId, dueDate = Iso(3), dueTime = "14:30" });
        Assert.Equal("14:30:00", S(task.Data!["dueTime"]));
        Assert.Equal(Ist(3, 14, 30), At(task.Data["dueAt"]));
        Assert.False(task.Data["dueFromSla"]!.GetValue<bool>());
        Assert.Equal("14:30:00", S(task.Data["detail"]!["dueTime"]));   // the task's own record carries it too
        var id = S(task.Data["id"]);

        // Lists carry the time and the instant.
        var row = (await w.Owner.Get($"{Url}?kind=task")).Data!["items"]!.AsArray().Single(r => S(r!["id"]) == id)!;
        Assert.Equal("14:30:00", S(row["dueTime"]));
        Assert.Equal(Ist(3, 14, 30), At(row["dueAt"]));

        // Later the same day is a delay: a reason is needed. Earlier is not.
        var later = await w.Owner.Patch($"{Url}/{id}", new { version = V(task), dueTime = "17:00" });
        Assert.Equal(422, (int)later.Status);
        var moved = await w.Owner.Patch($"{Url}/{id}", new { version = V(task), dueTime = "17:00", dueDateReason = "The bank moved the cut-over" });
        Assert.True(moved.Ok, moved.ToString());
        Assert.Equal("17:00:00", S(moved.Data!["dueTime"]));
        var earlier = await w.Owner.Patch($"{Url}/{id}", new { version = V(moved), dueTime = "10:00" });
        Assert.True(earlier.Ok, earlier.ToString());

        // Moving only the date keeps the time; taking the time away (due by the end of the day) is later again.
        var nextDay = await w.Owner.Patch($"{Url}/{id}", new { version = V(earlier), dueDate = Iso(2) });
        Assert.True(nextDay.Ok, nextDay.ToString());
        Assert.Equal("10:00:00", S(nextDay.Data!["dueTime"]));
        Assert.Equal(422, (int)(await w.Owner.Patch($"{Url}/{id}", new { version = V(nextDay), dueTime = (string?)null })).Status);
        var cleared = await w.Owner.Patch($"{Url}/{id}", new { version = V(nextDay), dueTime = (string?)null, dueDateReason = "Any time that day is fine" });
        Assert.True(cleared.Ok, cleared.ToString());
        Assert.Null(cleared.Data!["dueTime"]);
        Assert.Null(cleared.Data["dueAt"]);
        Assert.Equal(422, (int)(await w.Owner.Patch($"{Url}/{id}", new { version = V(cleared), dueTime = "25:99" })).Status);

        // Ticket and action item: created with a time; a client that does not know about times (the old PUT) keeps it.
        var ticket = await New(w.Owner, new { kind = "ticket", workTypeId = w.BugFix, title = "Card refunds stuck", priority = "Low", dueDate = Iso(1), dueTime = "09:45" });
        Assert.Equal("09:45:00", S(ticket.Data!["dueTime"]));
        var tid = S(ticket.Data["id"]);
        var old = (await w.Owner.Get($"/api/v1/work-tasks/{tid}")).Data!;
        Assert.Equal("09:45:00", S(old["dueTime"]));
        var put = await w.Owner.Put($"/api/v1/work-tasks/{tid}", new { title = "Card refunds stuck (bank side)", workTypeId = w.BugFix, priority = "Low", status = "ToDo", dueDate = Iso(1), version = I(old["version"]) });
        Assert.True(put.Ok, put.ToString());
        Assert.Equal("09:45:00", S(put.Data!["dueTime"]));
        var withTime = await w.Owner.Put($"/api/v1/work-tasks/{tid}", new { title = "Card refunds stuck (bank side)", workTypeId = w.BugFix, priority = "Low", status = "ToDo", dueDate = Iso(1), dueTime = "16:15:00", version = I(put.Data["version"]) });
        Assert.Equal("16:15:00", S(withTime.Data!["dueTime"]));
        var action = await New(w.Owner, new { kind = "action", projectId = w.Project, title = "Get the bank's sign-off", assigneeId = w.Dev.UserId, dueDate = Iso(2), dueTime = "11:00" });
        Assert.Equal("11:00:00", S(action.Data!["dueTime"]));
        Assert.Equal(Ist(2, 11, 0), At(action.Data["dueAt"]));

        // The timeline's deadline carries the instant, so Today and the Calendar mark it at its hour.
        var day = (await w.Dev.Get($"/api/v1/timeline?from={Iso(2)}&to={Iso(2)}&scope=me")).Data!["events"]!.AsArray();
        var due = day.Single(e => S(e!["type"]) == "due" && S(e["sourceId"]) == S(action.Data["id"]))!;
        Assert.Equal(Ist(2, 11, 0), At(due["dueAt"]));
    }

    // ------------------------------------------------------------------ working hours

    [Fact]
    public void Working_minutes_skip_nights_weekends_and_follow_the_zone()
    {
        var cal = new BusinessCalendar(SlaService.DayBits("1,2,3,4,5"), 9 * 60 + 30, 18 * 60 + 30, Kolkata);   // the default: 09:30-18:30 IST
        var fridayLate = new DateTime(2026, 10, 16, 12, 0, 0, DateTimeKind.Utc);   // Friday 17:30 IST
        Assert.Equal(new DateTime(2026, 10, 19, 7, 0, 0, DateTimeKind.Utc), cal.Add(fridayLate, 4 * 60));      // 1h Friday, 3h Monday: 12:30 IST
        Assert.Equal(new DateTime(2026, 10, 19, 4, 15, 0, DateTimeKind.Utc), cal.Add(new DateTime(2026, 10, 17, 6, 0, 0, DateTimeKind.Utc), 15));   // Saturday: Monday 09:45 IST
        Assert.Equal(new DateTime(2026, 10, 19, 13, 0, 0, DateTimeKind.Utc), cal.Add(new DateTime(2026, 10, 19, 4, 0, 0, DateTimeKind.Utc), 540));   // a whole working day: 18:30 IST
        Assert.Equal(240, cal.Between(fridayLate, new DateTime(2026, 10, 19, 7, 0, 0, DateTimeKind.Utc)));
        var utc = new BusinessCalendar(31, 9 * 60 + 30, 18 * 60 + 30, NodaTime.DateTimeZone.Utc);
        Assert.Equal(new DateTime(2026, 10, 16, 14, 0, 0, DateTimeKind.Utc), utc.Add(fridayLate, 120));   // the same hours in UTC: still Friday
        Assert.Equal(new DateTime(2026, 10, 19, 5, 0, 0, DateTimeKind.Utc), cal.Add(fridayLate, 120));    // in India: Monday 10:30

        Assert.Equal(31, SlaService.DayBits(null));
        Assert.Equal(96, SlaService.DayBits("6,7"));
        var suggested = SlaService.SuggestedFor(540);
        Assert.Equal((15, 240), (suggested[0].ResponseMinutes!.Value, suggested[0].ResolutionMinutes!.Value));   // Critical 15m / 4h
        Assert.Equal((60, 540), (suggested[1].ResponseMinutes!.Value, suggested[1].ResolutionMinutes!.Value));   // High 1h / 1 day
        Assert.Equal((240, 1620), (suggested[2].ResponseMinutes!.Value, suggested[2].ResolutionMinutes!.Value)); // Medium 4h / 3 days
        Assert.Equal((540, 2700), (suggested[3].ResponseMinutes!.Value, suggested[3].ResolutionMinutes!.Value)); // Low 1 day / 5 days
    }

    [Fact]
    public async Task Without_operations_settings_the_clocks_count_the_default_working_day()
    {
        var w = await Setup();
        var ops = (await w.Owner.Get("/api/v1/operations/settings")).Data!;
        Assert.True(ops["businessHoursOnly"]!.GetValue<bool>());
        Assert.Equal(570, I(ops["dayStartMinutes"]));
        Assert.Equal(1110, I(ops["dayEndMinutes"]));
        var sla = (await w.Owner.Get("/api/v1/work/sla")).Data!;
        Assert.True(sla["hours"]!["isDefault"]!.GetValue<bool>());
        Assert.Equal(5, sla["hours"]!["workDays"]!.AsArray().Count);
        Assert.Equal(15, I(sla["suggested"]![0]!["responseMinutes"]));
        Assert.Equal(540, I(sla["suggested"]![1]!["resolutionMinutes"]));

        Assert.True((await w.Owner.Put("/api/v1/work/sla", new { workTypeId = (Guid?)null, targets = SlaService.SuggestedFor(540) })).Ok);
        var ticket = await New(w.Owner, new { kind = "ticket", workTypeId = w.BugFix, title = "Checkout is down", priority = "Critical", assigneeId = w.Dev.UserId });
        var created = At(ticket.Data!["createdAt"]);
        var cal = new BusinessCalendar(31, 570, 1110, Kolkata);
        var resolveBy = At(ticket.Data["detail"]!["sla"]!["resolution"]!["dueAt"]);
        Assert.Equal(cal.Add(created, 240), resolveBy);                       // four working hours, whatever the time of day the test runs
        Assert.Equal(cal.Add(created, 15), At(ticket.Data["detail"]!["sla"]!["response"]!["dueAt"]));
        // No due time of its own: the resolve-by is its due.
        Assert.True(ticket.Data["dueFromSla"]!.GetValue<bool>());
        Assert.Equal(resolveBy, At(ticket.Data["dueAt"]));

        // Saved calendar-time settings switch the clocks back to calendar minutes for new work.
        Assert.True((await w.Owner.Put("/api/v1/operations/settings", new { businessHoursOnly = false, dayStartMinutes = 570, dayEndMinutes = 1110, workDays = new[] { 1, 2, 3, 4, 5 }, timeZone = "Asia/Kolkata", escalateOnBreach = false })).Ok);
        var later = await New(w.Owner, new { kind = "ticket", workTypeId = w.BugFix, title = "Refund webhook failing", priority = "Critical" });
        Assert.Equal(At(later.Data!["createdAt"]).AddMinutes(240), At(later.Data["detail"]!["sla"]!["resolution"]!["dueAt"]));
    }

    // ------------------------------------------------------------------ breach state and the inbox order

    private void SetResolveBy(Guid id, DateTime resolveBy) => factory.WithDb(db =>
    {
        var t = db.WorkTasks.IgnoreQueryFilters().Single(x => x.Id == id);
        t.ResolutionDueAt = resolveBy; t.ResolutionRiskAt = resolveBy.AddMinutes(-60);
        return db.SaveChanges();
    });

    [Fact]
    public async Task A_ticket_past_its_resolve_by_is_breached_and_an_explicit_due_time_wins()
    {
        var w = await Setup();
        Assert.True((await w.Owner.Put("/api/v1/work/sla", new { workTypeId = (Guid?)null, targets = SlaService.SuggestedFor(540) })).Ok);
        var late = await New(w.Owner, new { kind = "ticket", workTypeId = w.BugFix, title = "Payments failing", priority = "Critical", assigneeId = w.Dev.UserId });
        var lateId = Guid.Parse(S(late.Data!["id"]));
        var past = DateTime.UtcNow.AddMinutes(-5);
        SetResolveBy(lateId, past);
        var read = (await w.Dev.Get($"{Url}/{lateId}")).Data!;
        Assert.Equal("Breached", S(read["detail"]!["sla"]!["state"]));
        Assert.True(read["dueFromSla"]!.GetValue<bool>());
        Assert.InRange((At(read["dueAt"]) - past).Duration().TotalSeconds, 0, 1);
        var listed = (await w.Dev.Get($"{Url}?kind=ticket&mine=true")).Data!["items"]!.AsArray().Single(r => S(r!["id"]) == lateId.ToString())!;
        Assert.Equal("Breached", S(listed["slaState"]));

        // Completed: not breached any more (finished late counts as missed), and no longer held to a due.
        Assert.True((await w.Dev.Put($"/api/v1/work-tasks/{lateId}/status", new { status = "Completed" })).Ok);
        var done = (await w.Dev.Get($"{Url}/{lateId}")).Data!;
        Assert.Equal("Missed", S(done["detail"]!["sla"]!["state"]));
        Assert.Null(done["dueAt"]);

        var timed = await New(w.Owner, new { kind = "ticket", workTypeId = w.BugFix, title = "Statement export slow", priority = "High", dueDate = Iso(1), dueTime = "15:00" });
        Assert.False(timed.Data!["dueFromSla"]!.GetValue<bool>());
        Assert.Equal(Ist(1, 15, 0), At(timed.Data["dueAt"]));
    }

    [Fact]
    public async Task Needs_you_puts_the_soonest_breach_first_then_urgent_then_the_due_instant()
    {
        var w = await Setup();
        Assert.True((await w.Owner.Put("/api/v1/work/sla", new { workTypeId = (Guid?)null, targets = SlaService.SuggestedFor(540) })).Ok);
        async Task<Guid> Ticket(string title) => Guid.Parse(S((await New(w.Owner, new { kind = "ticket", workTypeId = w.BugFix, title, priority = "High", assigneeId = w.Dev.UserId })).Data!["id"]));
        var slow = await Ticket("Reports slow");
        var soon = await Ticket("Login loops");
        var gone = await Ticket("Payouts stuck");
        var now = DateTime.UtcNow;
        SetResolveBy(slow, now.AddHours(5));
        SetResolveBy(soon, now.AddHours(1));
        SetResolveBy(gone, now.AddMinutes(-10));
        await w.Owner.CreateTaskAsync(w.Project, "Board pack", new { title = "Board pack", priority = "Medium", assigneeId = w.Dev.UserId, dueDate = Iso(-2) });

        var rows = (await w.Dev.Get("/api/v1/inbox")).Data!["rows"]!.AsArray();
        var titles = rows.Select(r => S(r!["title"])).ToList();
        int Pos(string t) => titles.FindIndex(x => x.EndsWith(t));
        Assert.True(Pos("Payouts stuck") < Pos("Login loops") && Pos("Login loops") < Pos("Reports slow") && Pos("Reports slow") < Pos("Board pack"), string.Join(" | ", titles));
        var soonRow = rows.Single(r => S(r!["title"]).EndsWith("Login loops"))!;
        Assert.InRange((At(soonRow["breachAt"]) - now.AddHours(1)).Duration().TotalSeconds, 0, 1);
        Assert.Contains("SLA breached", S(rows.Single(r => S(r!["title"]).EndsWith("Payouts stuck"))!["sub"]));
    }

    [Fact]
    public void The_inbox_order_is_breach_then_urgent_then_due_then_priority()
    {
        var now = new DateTime(2026, 10, 29, 6, 0, 0, DateTimeKind.Utc);
        var open = new InboxActionDto("Open", "open");
        InboxRowDto Row(string id, bool urgent = false, DateTime? due = null, DateTime? breach = null, Priority? p = null, int ago = 0) =>
            new(id, "ticket", "assigned", id, "", open, null, now.AddMinutes(-ago), urgent, DueAt: due, BreachAt: breach, Priority: p);
        var ordered = InboxService.Order(new[] {
            Row("low-later", due: now.AddHours(8), p: Priority.Low),
            Row("high-later", due: now.AddHours(8), p: Priority.High),
            Row("urgent-no-sla", urgent: true),
            Row("breach-3h", breach: now.AddHours(3)),
            Row("breached", breach: now.AddMinutes(-1)),
            Row("due-soon", due: now.AddHours(1), p: Priority.Low),
            Row("mention", ago: 1),
        }).Select(r => r.Id).ToList();
        Assert.Equal(new[] { "breached", "breach-3h", "urgent-no-sla", "due-soon", "high-later", "low-later", "mention" }, ordered);
    }
}
