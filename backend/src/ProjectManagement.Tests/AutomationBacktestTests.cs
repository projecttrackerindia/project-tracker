using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Application.Features.Automation;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Automations: several AND conditions, drafts, Desk ticket rules and the 7-day backtest (dry run).</summary>
[Collection("api")]
public class AutomationBacktestTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<(TestClient Owner, TestClient Dev, Guid Project)> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Manager, "Dev Developer");
        return (owner, dev, await owner.CreateProjectAsync("Atlas"));
    }

    private static async Task<JsonNode> Ticket(TestClient owner, string title, string priority)
    {
        var types = (await owner.Get("/api/v1/work-types?includeInactive=true")).Data!.AsArray();
        var r = await owner.Post("/api/v1/work-tasks", new { title, priority, workTypeId = S(types.First(t => S(t!["name"]) == "Bug Fix")!["id"]) });
        Assert.True(r.Ok, r.ToString());
        return r.Data!;
    }

    [Fact]
    public async Task Every_condition_must_hold_and_drafts_never_run()
    {
        var (owner, dev, project) = await Setup();
        var rule = await owner.Post("/api/v1/automations", new
        {
            name = "Unowned high work", isEnabled = true, trigger = "TaskCreated", action = "AddComment", actionText = "Needs an owner",
            conditions = new object[] { new { field = "priority", value = "High" }, new { field = "unassigned" } },
        });
        Assert.Equal(HttpStatusCode.Created, rule.Status);
        Assert.Equal(2, rule.Data!["conditions"]!.AsArray().Count);
        Assert.Contains("priority is High and nobody is assigned", S(rule.Data!["summary"]));
        Assert.False(rule.Data!["isDraft"]!.GetValue<bool>());

        // A draft is kept but switched off, whatever isEnabled says.
        var draft = await owner.Post("/api/v1/automations", new
        {
            name = "Not yet", isEnabled = true, isDraft = true, trigger = "TaskCreated", action = "AddComment", actionText = "Draft ran",
        });
        Assert.Equal(HttpStatusCode.Created, draft.Status);
        Assert.True(draft.Data!["isDraft"]!.GetValue<bool>());
        Assert.False(draft.Data!["isEnabled"]!.GetValue<bool>());

        async Task<List<string>> Comments(JsonNode task) =>
            (await owner.Get($"/api/v1/tasks/{S(task["id"])}/comments")).Data!.AsArray().Select(c => S(c!["body"])).ToList();

        var both = await owner.CreateTaskAsync(project, "Both hold", new { title = "Both hold", priority = "High" });
        var assigned = await owner.CreateTaskAsync(project, "Has owner", new { title = "Has owner", priority = "High", assigneeId = dev.UserId });
        var low = await owner.CreateTaskAsync(project, "Low one", new { title = "Low one", priority = "Low" });
        Assert.Contains(await Comments(both), b => b.Contains("Needs an owner"));
        Assert.DoesNotContain(await Comments(assigned), b => b.Contains("Needs an owner"));
        Assert.DoesNotContain(await Comments(low), b => b.Contains("Needs an owner"));
        Assert.DoesNotContain(await Comments(both), b => b.Contains("Draft ran"));

        // Bad conditions are refused; the original single-action format keeps working (no conditions, no extras).
        Assert.Equal(422, (int)(await owner.Post("/api/v1/automations", new
        {
            name = "x", isEnabled = true, trigger = "TaskCreated", action = "SetPriority", actionPriority = "Low", conditions = new object[] { new { field = "noReply", minutes = 30 } },
        })).Status);
        Assert.Equal(422, (int)(await owner.Post("/api/v1/automations", new
        {
            name = "x", isEnabled = true, trigger = "TaskCreated", action = "TellCustomer", actionText = "Hi",
        })).Status);
        var plain = await owner.Post("/api/v1/automations", new { name = "Plain", isEnabled = false, trigger = "TaskCreated", action = "SetPriority", actionPriority = "Low" });
        Assert.Equal(0, plain.Data!["conditions"]!.AsArray().Count);
    }

    [Fact]
    public async Task Ticket_rules_check_conditions_and_tell_the_customer()
    {
        var (owner, _, _) = await Setup();
        var rule = await owner.Post("/api/v1/automations", new
        {
            name = "Critical tickets", isEnabled = true, trigger = "TicketCreated", action = "TellCustomer", actionText = "We're on it",
            conditions = new object[] { new { field = "priority", value = "Critical" } },
        });
        Assert.Equal(HttpStatusCode.Created, rule.Status);
        Assert.Contains("Desk ticket", S(rule.Data!["summary"]));
        var critical = await Ticket(owner, "Payments down", "Critical");
        var minor = await Ticket(owner, "Typo on page", "Low");
        var c1 = (await owner.Get($"/api/v1/work-tasks/{S(critical["id"])}/comments")).Data!.AsArray().Select(c => S(c!["body"])).ToList();
        var c2 = (await owner.Get($"/api/v1/work-tasks/{S(minor["id"])}/comments")).Data!.AsArray().Select(c => S(c!["body"])).ToList();
        Assert.Contains(c1, b => b.Contains("We're on it"));
        Assert.DoesNotContain(c2, b => b.Contains("We're on it"));
    }

    [Fact]
    public async Task Backtest_counts_what_would_have_fired_over_the_last_7_days_without_changing_anything()
    {
        var (owner, _, project) = await Setup();
        await owner.CreateTaskAsync(project, "One", new { title = "One", priority = "High" });
        await owner.CreateTaskAsync(project, "Two", new { title = "Two", priority = "High" });
        var low = await owner.CreateTaskAsync(project, "Three", new { title = "Three", priority = "Low" });

        var bt = await owner.Post("/api/v1/automations/backtest", new
        {
            name = "Try", isEnabled = true, trigger = "TaskCreated", action = "SetPriority", actionPriority = "Critical",
            conditions = new object[] { new { field = "priority", value = "High" } },
        });
        Assert.True(bt.Ok, bt.ToString());
        Assert.Equal(2, bt.Data!["total"]!.GetValue<int>());
        var days = bt.Data!["days"]!.AsArray();
        Assert.Equal(7, days.Count);
        Assert.Equal(2, days.Sum(d => d!["count"]!.GetValue<int>()));
        Assert.Equal(2, bt.Data!["items"]!.AsArray().Count);
        Assert.All(bt.Data!["items"]!.AsArray(), i => Assert.False(i!["isTicket"]!.GetValue<bool>()));

        // Nothing changed: no rule was saved and the tasks keep their priority.
        Assert.Empty((await owner.Get("/api/v1/automations")).Data!.AsArray());
        Assert.Equal("Low", S((await owner.Get($"/api/v1/tasks/{S(low["id"])}")).Data!["task"]!["priority"]));

        // Tickets: created in the window, filtered by the condition.
        await Ticket(owner, "Server on fire", "Critical");
        await Ticket(owner, "Small thing", "Low");
        var tickets = await owner.Post("/api/v1/automations/backtest", new
        {
            name = "Try tickets", isEnabled = true, trigger = "TicketCreated", action = "AddComment", actionText = "x",
            conditions = new object[] { new { field = "priority", value = "Critical" } },
        });
        Assert.True(tickets.Ok, tickets.ToString());
        Assert.Equal(1, tickets.Data!["total"]!.GetValue<int>());
        Assert.True(tickets.Data!["items"]![0]!["isTicket"]!.GetValue<bool>());
        Assert.StartsWith("WT-", S(tickets.Data!["items"]![0]!["key"]));

        // A ticket waiting for a reply: not 30 minutes yet, so it would not have fired.
        var waiting = await owner.Post("/api/v1/automations/backtest", new
        {
            name = "Silent", isEnabled = true, trigger = "TicketChanged", action = "AddComment", actionText = "x",
            conditions = new object[] { new { field = "noReply", minutes = 30 } },
        });
        Assert.Equal(0, waiting.Data!["total"]!.GetValue<int>());
    }

    [Fact]
    public void Conditions_are_anded_and_business_hours_follow_the_calendar()
    {
        var hours = new AutomationHours(31, 9 * 60, 18 * 60, NodaTime.DateTimeZone.Utc);   // Monday to Friday, 9 to 6, UTC
        var monday10 = new DateTime(2026, 10, 26, 10, 0, 0, DateTimeKind.Utc);
        var monday20 = new DateTime(2026, 10, 26, 20, 0, 0, DateTimeKind.Utc);
        var saturday = new DateTime(2026, 10, 31, 11, 0, 0, DateTimeKind.Utc);
        Assert.True(hours.Within(monday10));
        Assert.False(hours.Within(monday20));
        Assert.False(hours.Within(saturday));

        var conds = new List<AutomationConditionDto> { new("priority", "Critical"), new("businessHours"), new("noReply", null, 30) };
        var created = monday10.AddMinutes(-45);
        Assert.Null(AutomationConditions.Failing(conds, Priority.Critical, "ToDo", null, created, null, monday10, hours));
        Assert.NotNull(AutomationConditions.Failing(conds, Priority.High, "ToDo", null, created, null, monday10, hours));
        Assert.NotNull(AutomationConditions.Failing(conds, Priority.Critical, "ToDo", null, created, null, monday20, hours));
        Assert.NotNull(AutomationConditions.Failing(conds, Priority.Critical, "ToDo", null, created, created.AddMinutes(10), monday10, hours));
        Assert.NotNull(AutomationConditions.Failing(conds, Priority.Critical, "ToDo", null, monday10.AddMinutes(-5), null, monday10, hours));
    }
}
