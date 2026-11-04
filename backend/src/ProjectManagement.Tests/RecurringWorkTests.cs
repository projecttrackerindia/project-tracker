using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Recurring;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The date arithmetic of repeat rules, on its own (no database).</summary>
public class RecurrenceRuleTests
{
    private static TaskRecurrence Rule(RecurrenceRuleDto rule, DateOnly anchor)
    {
        var r = new TaskRecurrence();
        RecurrenceRules.Apply(r, rule, anchor);
        return r;
    }

    private static DateOnly D(int y, int m, int d) => new(y, m, d);

    private static IReadOnlyList<DateOnly> Dates(TaskRecurrence r, DateOnly first, int count = 5) => RecurrenceRules.Preview(r, first, 1, count);

    [Fact]
    public void Daily_and_custom_intervals_step_on_a_grid_from_the_first_date()
    {
        Assert.Equal(new[] { D(2026, 11, 3), D(2026, 11, 4) }, Dates(Rule(new("daily"), D(2026, 11, 2)), D(2026, 11, 2), 2));
        var every3 = Rule(new("custom", 3, "day"), D(2026, 11, 2));
        Assert.Equal("daily", every3.Frequency);
        Assert.Equal(new[] { D(2026, 11, 5), D(2026, 11, 8) }, Dates(every3, D(2026, 11, 2), 2));
        Assert.Equal("Every 3 days", RecurrenceRules.Describe(every3));
    }

    [Fact]
    public void Weekdays_skip_the_weekend()
    {
        var r = Rule(new("weekdays"), D(2026, 11, 6));                    // a Friday
        Assert.Equal(new[] { D(2026, 11, 9), D(2026, 11, 10) }, Dates(r, D(2026, 11, 6), 2));
    }

    [Fact]
    public void Weekly_on_several_days_every_other_week()
    {
        var r = Rule(new("weekly", 2, DaysOfWeek: [1, 4]), D(2026, 11, 2));   // Monday 2 Nov
        Assert.Equal(new[] { D(2026, 11, 5), D(2026, 11, 16), D(2026, 11, 19), D(2026, 11, 30) }, Dates(r, D(2026, 11, 2), 4));
        Assert.Equal("Every 2 weeks on Mon, Thu", RecurrenceRules.Describe(r));
    }

    [Fact]
    public void Monthly_by_date_uses_the_last_day_of_a_short_month()
    {
        var r = Rule(new("monthly", MonthDay: 31), D(2027, 1, 31));
        Assert.Equal(new[] { D(2027, 2, 28), D(2027, 3, 31), D(2027, 4, 30) }, Dates(r, D(2027, 1, 31), 3));
    }

    [Fact]
    public void Monthly_by_nth_weekday_including_the_last_one()
    {
        var second = Rule(new("monthly", MonthWeek: 2, MonthWeekday: 2), D(2026, 11, 10));   // second Tuesday
        Assert.Equal(new[] { D(2026, 12, 8), D(2027, 1, 12) }, Dates(second, D(2026, 11, 10), 2));
        var last = Rule(new("monthly", 1, MonthWeek: 5, MonthWeekday: 5), D(2026, 11, 27));   // last Friday
        Assert.Equal(new[] { D(2026, 12, 25), D(2027, 1, 29) }, Dates(last, D(2026, 11, 27), 2));
        Assert.Equal("Every month on the last Fri", RecurrenceRules.Describe(last));
    }

    [Fact]
    public void A_series_ends_after_n_times_or_by_a_date_and_skipped_dates_count()
    {
        var n = Rule(new("daily", EndAfter: 3), D(2026, 11, 2));
        Assert.Equal(new[] { D(2026, 11, 3), D(2026, 11, 4) }, Dates(n, D(2026, 11, 2)));
        var by = Rule(new("weekly", EndBy: D(2026, 11, 20)), D(2026, 11, 2));
        Assert.Equal(new[] { D(2026, 11, 9), D(2026, 11, 16) }, Dates(by, D(2026, 11, 2)));
        var skip = Rule(new("daily", EndAfter: 3), D(2026, 11, 2));
        RecurrenceRules.AddSkipped(skip, D(2026, 11, 3));
        Assert.Equal(new[] { D(2026, 11, 4) }, Dates(skip, D(2026, 11, 2)));
    }

    [Fact]
    public void Rules_that_cannot_work_are_refused()
    {
        Assert.Throws<ProjectManagement.Application.Exceptions.ValidationException>(() => Rule(new("yearly"), D(2026, 11, 2)));
        Assert.Throws<ProjectManagement.Application.Exceptions.ValidationException>(() => Rule(new("weekly", DaysOfWeek: [8]), D(2026, 11, 2)));
        Assert.Throws<ProjectManagement.Application.Exceptions.ValidationException>(() => Rule(new("daily", EndBy: D(2026, 10, 1)), D(2026, 11, 2)));
    }
}

/// <summary>Repeating tasks through the API: the rule, the next occurrence on completion and ahead of time, skip, "all following", tenant safety.</summary>
[Collection("api")]
public class RecurringTaskTests(ApiFactory factory)
{
    private async Task<int> Advance(DateTime utc)
    {
        using var scope = factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<RecurrenceJob>().RunAsync(utc);
    }

    private static async Task<Guid> DoneStatus(TestClient c, Guid project) =>
        Guid.Parse((await c.Get($"/api/v1/projects/{project}/statuses")).Data!.AsArray().First(s => s!["category"]!.GetValue<string>() == "Done")!["id"]!.GetValue<string>());

    private static async Task Complete(TestClient c, Guid project, Guid task)
    {
        var res = await c.Patch($"/api/v1/tasks/{task}/move", new { statusId = await DoneStatus(c, project) });
        Assert.True(res.Ok, res.ToString());
    }

    private static async Task<List<JsonNode>> Tasks(TestClient c, Guid project) =>
        (await c.Get($"/api/v1/projects/{project}/tasks?pageSize=100")).Data!["items"]!.AsArray().Select(t => t!).ToList();

    private static Guid Id(JsonNode n) => Guid.Parse(n["id"]!.GetValue<string>());

    [Fact]
    public async Task A_weekly_task_makes_its_next_occurrence_when_completed_can_skip_one_and_ends_after_n_times()
    {
        var owner = await TestClient.RegisterAsync(factory, "Rhea Repeat");
        await owner.CreateOrgAsync();
        var project = await owner.CreateProjectAsync("Repeat Programme");
        var first = Id(await owner.CreateTaskAsync(project, "Weekly status note", new { title = "Weekly status note", priority = "High", dueDate = "2026-11-02", startDate = "2026-11-01" }));
        Assert.True((await owner.Post($"/api/v1/tasks/{first}/checklist", new { title = "Collect numbers" })).Ok);

        var set = await owner.Put($"/api/v1/tasks/{first}/recurrence", new { rule = new { frequency = "weekly", daysOfWeek = new[] { 1, 4 }, endAfter = 4 } });
        Assert.True(set.Ok, set.ToString());
        Assert.Equal("Every week on Mon, Thu · 4 times", set.Data!["summary"]!.GetValue<string>());
        Assert.Equal(new[] { "2026-11-05", "2026-11-09", "2026-11-12" }, set.Data!["next"]!.AsArray().Select(d => d!.GetValue<string>()));

        await Advance(new DateTime(2026, 10, 30, 6, 0, 0, DateTimeKind.Utc));          // before it is due: nothing is made yet
        Assert.Single(await Tasks(owner, project));

        await Complete(owner, project, first);
        await Advance(new DateTime(2026, 11, 2, 6, 0, 0, DateTimeKind.Utc));
        var all = await Tasks(owner, project);
        Assert.Equal(2, all.Count);
        var second = all.First(t => Id(t) != first);
        Assert.Equal("2026-11-05", second["dueDate"]!.GetValue<string>());
        Assert.Equal("2026-11-04", second["startDate"]!.GetValue<string>());    // keeps the one-day lead
        Assert.Equal("High", second["priority"]!.GetValue<string>());
        Assert.Equal(1, second["checklistTotal"]!.GetValue<int>());               // the checklist comes along, unticked
        Assert.Equal(2, (await owner.Get($"/api/v1/tasks/{Id(second)}/recurrence")).Data!["index"]!.GetValue<int>());

        // Skip the 5 Nov one: the same task moves to the next date, and 5 Nov is never made again.
        var skipped = await owner.Post($"/api/v1/tasks/{Id(second)}/recurrence/skip", new { });
        Assert.True(skipped.Ok, skipped.ToString());
        Assert.Equal("2026-11-09", skipped.Data!["date"]!.GetValue<string>());
        Assert.Equal(3, skipped.Data!["index"]!.GetValue<int>());

        await Complete(owner, project, Id(second));
        await Advance(new DateTime(2026, 11, 9, 6, 0, 0, DateTimeKind.Utc));
        var third = (await Tasks(owner, project)).Single(t => t["completedAt"] is null);
        Assert.Equal("2026-11-12", third["dueDate"]!.GetValue<string>());

        await Complete(owner, project, Id(third));
        await Advance(new DateTime(2026, 11, 12, 6, 0, 0, DateTimeKind.Utc));
        Assert.Equal(3, (await Tasks(owner, project)).Count);                         // the fourth was the last
        Assert.False((await owner.Get($"/api/v1/tasks/{Id(third)}/recurrence")).Data!["repeats"]!.GetValue<bool>());
    }

    [Fact]
    public async Task The_next_occurrence_is_made_a_few_days_ahead_while_the_current_one_is_still_open()
    {
        var owner = await TestClient.RegisterAsync(factory, "Ari Ahead");
        await owner.CreateOrgAsync();
        var project = await owner.CreateProjectAsync("Ahead Programme");
        var task = Id(await owner.CreateTaskAsync(project, "Daily stand-up notes", new { title = "Daily stand-up notes", priority = "Medium", dueDate = "2026-11-02" }));
        Assert.True((await owner.Put($"/api/v1/tasks/{task}/recurrence", new { rule = new { frequency = "daily", interval = 2 } })).Ok);
        await Advance(new DateTime(2026, 11, 2, 6, 0, 0, DateTimeKind.Utc));            // due today, the next one (4 Nov) is two days away
        var dates = (await Tasks(owner, project)).Select(t => t["dueDate"]!.GetValue<string>()).OrderBy(d => d).ToList();
        Assert.Equal(new[] { "2026-11-02", "2026-11-04" }, dates);
    }

    [Fact]
    public async Task Editing_this_one_or_all_following_and_changing_the_rule_from_a_later_occurrence_splits_the_series()
    {
        var owner = await TestClient.RegisterAsync(factory, "Fola Following");
        await owner.CreateOrgAsync();
        var project = await owner.CreateProjectAsync("Following Programme");
        var first = Id(await owner.CreateTaskAsync(project, "Invoice run", new { title = "Invoice run", priority = "Medium", dueDate = "2026-11-02" }));
        Assert.True((await owner.Put($"/api/v1/tasks/{first}/recurrence", new { rule = new { frequency = "weekly" } })).Ok);
        await Complete(owner, project, first);
        await Advance(new DateTime(2026, 11, 2, 6, 0, 0, DateTimeKind.Utc));
        var second = Id((await Tasks(owner, project)).Single(t => Id(t) != first));

        var only = await owner.Patch($"/api/v1/tasks/{second}/recurrence", new { scope = "this", title = "Invoice run (short week)" });
        Assert.True(only.Ok, only.ToString());
        var following = await owner.Patch($"/api/v1/tasks/{second}/recurrence", new { scope = "following", priority = "Critical", rule = new { frequency = "monthly", monthDay = 9 } });
        Assert.True(following.Ok, following.ToString());
        Assert.Equal("Every month on day 9", following.Data!["summary"]!.GetValue<string>());
        Assert.Equal(1, following.Data!["index"]!.GetValue<int>());                  // first of the new series
        var firstSeries = (await owner.Get($"/api/v1/tasks/{first}/recurrence")).Data!;
        Assert.False(firstSeries["repeats"]!.GetValue<bool>());                       // the old rule stopped before this one
        Assert.NotEqual(firstSeries["seriesId"]!.GetValue<string>(), following.Data!["seriesId"]!.GetValue<string>());

        var detail = (await owner.Get($"/api/v1/tasks/{second}")).Data!["task"]!;
        Assert.Equal("Invoice run (short week)", detail["title"]!.GetValue<string>());
        Assert.Equal("Critical", detail["priority"]!.GetValue<string>());
        Assert.Equal("Invoice run", (await owner.Get($"/api/v1/tasks/{first}")).Data!["task"]!["title"]!.GetValue<string>());

        var bad = await owner.Patch($"/api/v1/tasks/{second}/recurrence", new { scope = "everything" });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, bad.Status);
    }

    [Fact]
    public async Task Another_workspace_cannot_see_or_change_a_repeating_task_and_stop_ends_the_series()
    {
        var owner = await TestClient.RegisterAsync(factory, "Tara Tenant");
        await owner.CreateOrgAsync();
        var project = await owner.CreateProjectAsync("Private Programme");
        var task = Id(await owner.CreateTaskAsync(project, "Payroll check", new { title = "Payroll check", priority = "Medium", dueDate = "2026-11-03" }));
        Assert.True((await owner.Put($"/api/v1/tasks/{task}/recurrence", new { rule = new { frequency = "weekdays" } })).Ok);

        var other = await TestClient.RegisterAsync(factory, "Omar Other");
        await other.CreateOrgAsync();
        Assert.Equal(HttpStatusCode.NotFound, (await other.Get($"/api/v1/tasks/{task}/recurrence")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await other.Post($"/api/v1/tasks/{task}/recurrence/skip", new { })).Status);

        var stopped = await owner.Delete($"/api/v1/tasks/{task}/recurrence");
        Assert.True(stopped.Ok, stopped.ToString());
        Assert.False(stopped.Data!["repeats"]!.GetValue<bool>());
        await Advance(new DateTime(2026, 11, 3, 6, 0, 0, DateTimeKind.Utc));
        Assert.Single(await Tasks(owner, project));
    }
}

/// <summary>Project and task templates: save from a project, create from it with a new start date (every date shifts), task templates.</summary>
[Collection("api")]
public class WorkTemplateTests(ApiFactory factory)
{
    [Fact]
    public async Task Saving_a_project_as_a_template_and_creating_from_it_shifts_every_date_and_keeps_sections_subtasks_checklists_and_labels()
    {
        var owner = await TestClient.RegisterAsync(factory, "Tilly Template");
        await owner.CreateOrgAsync();
        var created = await owner.Post("/api/v1/projects", new { name = "Onboarding Alpha", priority = "High", startDate = "2026-11-02", dueDate = "2026-11-30" });
        Assert.True(created.Ok, created.ToString());
        var project = Guid.Parse(created.Data!["project"]!["id"]!.GetValue<string>());
        var label = await owner.Post("/api/v1/labels", new { name = "Kickoff", color = "#7c3aed" });
        var labelIds = label.Ok ? new[] { Guid.Parse(label.Data!["id"]!.GetValue<string>()) } : Array.Empty<Guid>();
        var parent = Guid.Parse((await owner.CreateTaskAsync(project, "Welcome pack", new { title = "Welcome pack", priority = "High", startDate = "2026-11-03", dueDate = "2026-11-05", labelIds, assigneeId = owner.UserId }))["id"]!.GetValue<string>());
        await owner.CreateTaskAsync(project, "Order laptop", new { title = "Order laptop", priority = "Medium", dueDate = "2026-11-04", parentTaskId = parent });
        Assert.True((await owner.Post($"/api/v1/tasks/{parent}/checklist", new { title = "Print badge" })).Ok);

        var saved = await owner.Post($"/api/v1/templates/from-project/{project}", new { name = "Client onboarding" });
        Assert.Equal(HttpStatusCode.Created, saved.Status);
        Assert.Equal(2, saved.Data!["taskCount"]!.GetValue<int>());
        Assert.Equal(28, saved.Data!["durationDays"]!.GetValue<int>());
        var templateId = saved.Data!["id"]!.GetValue<string>();
        var listed = (await owner.Get("/api/v1/templates?kind=project&q=onboard")).Data!.AsArray();
        Assert.Contains(listed, t => t!["id"]!.GetValue<string>() == templateId);

        var made = await owner.Post($"/api/v1/templates/{templateId}/create-project", new { name = "Onboarding Beta", startDate = "2027-01-04" });
        Assert.Equal(HttpStatusCode.Created, made.Status);
        var newProject = Guid.Parse(made.Data!["projectId"]!.GetValue<string>());
        var p = (await owner.Get($"/api/v1/projects/{newProject}")).Data!;
        Assert.Equal("2027-01-04", p["project"]!["startDate"]!.GetValue<string>());
        Assert.Equal("2027-02-01", p["project"]!["dueDate"]!.GetValue<string>());
        var tasks = (await owner.Get($"/api/v1/projects/{newProject}/tasks?includeSubtasks=true&pageSize=100")).Data!["items"]!.AsArray();
        var pack = tasks.First(t => t!["title"]!.GetValue<string>() == "Welcome pack")!;
        Assert.Equal("2027-01-05", pack["startDate"]!.GetValue<string>());          // one day after the start, as before
        Assert.Equal("2027-01-07", pack["dueDate"]!.GetValue<string>());
        Assert.Equal(owner.UserId.ToString(), pack["assignee"]!["id"]!.GetValue<string>());   // the project owner by role
        Assert.Equal(1, pack["checklistTotal"]!.GetValue<int>());
        Assert.Equal(1, pack["subtaskTotal"]!.GetValue<int>());
        if (labelIds.Length > 0) Assert.Equal("Kickoff", pack["labels"]![0]!["name"]!.GetValue<string>());
        var laptop = tasks.First(t => t!["title"]!.GetValue<string>() == "Order laptop")!;
        Assert.Equal("2027-01-06", laptop["dueDate"]!.GetValue<string>());
    }

    [Fact]
    public async Task A_task_template_creates_the_task_with_its_subtasks_from_a_start_date_and_stays_inside_its_workspace()
    {
        var owner = await TestClient.RegisterAsync(factory, "Tomas Task");
        await owner.CreateOrgAsync();
        var project = await owner.CreateProjectAsync("Ops Programme");
        var res = await owner.Post("/api/v1/templates", new
        {
            kind = "task", name = "Month-end close", description = "Close the books",
            content = new { tasks = new[] { new { title = "Close the books", priority = "High", startOffset = 0, dueOffset = 3, owner = "creator", checklist = new[] { "Bank reconciliation", "Accruals" },
                subtasks = new[] { new { title = "Post journals", dueOffset = 2 } } } } },
        });
        Assert.Equal(HttpStatusCode.Created, res.Status);
        var id = res.Data!["id"]!.GetValue<string>();
        var made = await owner.Post($"/api/v1/templates/{id}/create-task", new { projectId = project, startDate = "2026-12-01" });
        Assert.Equal(HttpStatusCode.Created, made.Status);
        Assert.Equal(2, made.Data!["taskIds"]!.AsArray().Count);
        var main = (await owner.Get($"/api/v1/tasks/{made.Data!["taskIds"]![0]!.GetValue<string>()}")).Data!;
        Assert.Equal("2026-12-04", main["task"]!["dueDate"]!.GetValue<string>());
        Assert.Equal(2, main["task"]!["checklistTotal"]!.GetValue<int>());
        Assert.Equal("2026-12-03", main["subtasks"]![0]!["dueDate"]!.GetValue<string>());

        var other = await TestClient.RegisterAsync(factory, "Otto Other");
        await other.CreateOrgAsync();
        Assert.Equal(HttpStatusCode.NotFound, (await other.Get($"/api/v1/templates/{id}")).Status);
        Assert.DoesNotContain(id, (await other.Get("/api/v1/templates")).Data!.ToJsonString());
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post("/api/v1/templates", new { kind = "task", name = "Empty", content = new { } })).Status);
    }
}

/// <summary>Records what would have been e-mailed.</summary>
public sealed class RecordingEmailSender : IEmailSender
{
    public string Name => "recording";
    public List<EmailMessage> Sent { get; } = [];
    public Task SendAsync(EmailMessage message, CancellationToken ct = default) { lock (Sent) Sent.Add(message); return Task.CompletedTask; }
}

/// <summary>The Monday manager e-mail: when it goes out (09:00 in the person's own zone), what it says, the plain-text part, unsubscribe, preview.</summary>
[Collection("api")]
public class ManagerDigestTests(ApiFactory factory)
{
    private async Task<RecordingEmailSender> Send(DateTime utc)
    {
        var mail = new RecordingEmailSender();
        using var scope = factory.Services.CreateScope();
        await ActivatorUtilities.CreateInstance<ManagerDigestService>(scope.ServiceProvider, (IEmailSender)mail).SendAsync(utc);
        return mail;
    }

    private static List<EmailMessage> To(RecordingEmailSender mail, string email) => mail.Sent.Where(m => m.To.Equals(email, StringComparison.OrdinalIgnoreCase)).ToList();

    private string EmailOf(Guid user) => factory.WithDb(db => db.Users.IgnoreQueryFilters().First(u => u.Id == user).Email);

    private void Zone(Guid user, string zone) => factory.WithDb(db => { db.Users.IgnoreQueryFilters().First(u => u.Id == user).TimeZone = zone; return db.SaveChanges(); });

    private static async Task<(Guid Project, Guid Todo, Guid Done)> Programme(TestClient c, string name)
    {
        var res = await c.Post("/api/v1/projects", new { name, priority = "High", status = "Active", startDate = "2026-10-01", dueDate = "2026-12-31" });
        Assert.True(res.Ok, res.ToString());
        var project = Guid.Parse(res.Data!["project"]!["id"]!.GetValue<string>());
        var statuses = (await c.Get($"/api/v1/projects/{project}/statuses")).Data!.AsArray();
        Guid Of(string cat) => Guid.Parse(statuses.First(s => s!["category"]!.GetValue<string>() == cat)!["id"]!.GetValue<string>());
        return (project, Of("Todo"), Of("Done"));
    }

    [Fact]
    public async Task Owners_get_the_e_mail_on_monday_at_nine_their_time_with_progress_done_slipped_overdue_and_next_week()
    {
        var owner = await TestClient.RegisterAsync(factory, "Maya Manager");
        await owner.CreateOrgAsync();
        var (project, todo, done) = await Programme(owner, "Harbour Launch");
        var shipped = Guid.Parse((await owner.CreateTaskAsync(project, "Sign vendor contract", new { title = "Sign vendor contract", priority = "Medium", dueDate = "2026-11-06" }))["id"]!.GetValue<string>());
        Assert.True((await owner.Patch($"/api/v1/tasks/{shipped}/move", new { statusId = done })).Ok);
        await owner.CreateTaskAsync(project, "Brief the press", new { title = "Brief the press", priority = "High", dueDate = "2026-11-04" });
        await owner.CreateTaskAsync(project, "Dry run", new { title = "Dry run", priority = "High", dueDate = "2026-11-11" });
        var moved = Guid.Parse((await owner.CreateTaskAsync(project, "Venue booking", new { title = "Venue booking", priority = "High", dueDate = "2026-11-05" }))["id"]!.GetValue<string>());
        var v = (await owner.Get($"/api/v1/tasks/{moved}")).Data!["task"]!["version"]!.GetValue<int>();
        var slip = await owner.Put($"/api/v1/tasks/{moved}", new { title = "Venue booking", priority = "High", statusId = todo, dueDate = "2026-11-20", version = v, dueDateReason = "Venue double-booked" });
        Assert.True(slip.Ok, slip.ToString());

        var email = EmailOf(owner.UserId);
        Zone(owner.UserId, "Asia/Kolkata");
        var monday = new DateTime(2026, 11, 9, 3, 30, 0, DateTimeKind.Utc);            // Monday 09:00 in India
        Assert.Empty(To(await Send(monday.AddHours(-1)), email));                         // 08:00: not yet
        Assert.Empty(To(await Send(monday.AddDays(1)), email));                           // Tuesday
        Assert.Empty(To(await Send(monday.AddHours(3)), email));                          // noon: too late, never sent late

        var mail = await Send(monday);
        var sent = Assert.Single(To(mail, email));
        Assert.StartsWith("Your week ahead:", sent.Subject);
        Assert.Equal("manager-digest", sent.Kind);
        Assert.Contains("Harbour Launch", sent.Html);
        Assert.Contains("Venue double-booked", sent.Html);                               // slipped, with the reason
        Assert.Contains("Brief the press", sent.Html);                                   // overdue on 9 Nov
        Assert.Contains("Dry run", sent.Html);                                           // due in the coming week
        Assert.Contains("#7c3aed", sent.Html);                                           // the brand purple
        Assert.Contains("Stop emails like this", sent.Html);
        Assert.NotNull(sent.Text);
        Assert.Contains("Harbour Launch", sent.Text);
        Assert.Contains("Stop these e-mails:", sent.Text);
        Assert.True(sent.Headers!.ContainsKey("List-Unsubscribe"));

        Assert.Empty(To(await Send(monday.AddMinutes(30)), email));                      // once per Monday

        // Unsubscribe from the link in the e-mail: the next Monday nothing is sent.
        var token = System.Text.RegularExpressions.Regex.Match(sent.Text!, @"token=([^\s&]+)").Groups[1].Value;
        var off = await owner.Post($"/api/v1/email/unsubscribe?token={token}", new { });
        Assert.True(off.Ok, off.ToString());
        Assert.Empty(To(await Send(monday.AddDays(7)), email));
    }

    [Fact]
    public async Task The_send_time_follows_the_person_s_own_zone_and_people_who_own_nothing_get_nothing()
    {
        var owner = await TestClient.RegisterAsync(factory, "Nico NewYork");
        await owner.CreateOrgAsync();
        await Programme(owner, "Hudson Rollout");
        var member = await owner.AddMemberAsync(factory, ProjectManagement.Domain.Enums.TenantRole.Member, "Mona Member");
        Zone(owner.UserId, "America/New_York");
        var email = EmailOf(owner.UserId);

        var indiaNine = new DateTime(2026, 11, 16, 3, 30, 0, DateTimeKind.Utc);
        Assert.Empty(To(await Send(indiaNine), email));                                  // 09:00 in India is still Sunday night in New York
        var newYorkNine = new DateTime(2026, 11, 16, 14, 0, 0, DateTimeKind.Utc);         // 09:00 EST
        var mail = await Send(newYorkNine);
        Assert.Single(To(mail, email));
        Assert.Empty(To(mail, EmailOf(member.UserId)));
    }

    [Fact]
    public async Task Admins_can_preview_the_e_mail_and_members_cannot()
    {
        var owner = await TestClient.RegisterAsync(factory, "Pia Preview");
        await owner.CreateOrgAsync();
        await Programme(owner, "Preview Programme");
        var preview = await owner.Get("/api/v1/digest/manager/preview");
        Assert.True(preview.Ok, preview.ToString());
        Assert.Contains("Preview Programme", preview.Data!["html"]!.GetValue<string>());
        Assert.Contains("Preview Programme", preview.Data!["text"]!.GetValue<string>());
        Assert.Equal("Preview Programme", preview.Data!["projects"]![0]!["name"]!.GetValue<string>());

        var member = await owner.AddMemberAsync(factory, ProjectManagement.Domain.Enums.TenantRole.Member, "Moe Member");
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get("/api/v1/digest/manager/preview")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Get($"/api/v1/digest/manager/preview?userId={member.UserId}")).Status);   // owns no projects
    }
}
