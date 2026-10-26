using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Home's inbox: rows gathered from work, mentions and reminders that already exist; filters; "Later"; and a briefing found by rules.</summary>
[Collection("api")]
public class InboxTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private sealed record Org(TestClient Owner, TestClient Dev, Guid Project, string Key, Guid Tenant);

    private async Task<Org> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Developer");
        var project = await owner.CreateProjectAsync("Atlas");
        var key = S((await owner.Get($"/api/v1/projects/{project}")).Data!["project"]!["key"]);
        var tenant = factory.WithDb(db => db.Projects.IgnoreQueryFilters().First(p => p.Id == project).TenantId);
        return new Org(owner, dev, project, key, tenant);
    }

    private static JsonArray Rows(ApiResult r) => r.Data!["rows"]!.AsArray();

    [Fact]
    public async Task The_inbox_gathers_late_work_mentions_and_reminders_with_one_action_each()
    {
        var o = await Setup();
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        await o.Owner.CreateTaskAsync(o.Project, "Board pack", new { title = "Board pack", priority = "Medium", assigneeId = o.Dev.UserId, dueDate = today.AddDays(-3).ToString("yyyy-MM-dd") });
        await o.Owner.CreateTaskAsync(o.Project, "Far away", new { title = "Far away", priority = "Low", assigneeId = o.Dev.UserId, dueDate = today.AddDays(20).ToString("yyyy-MM-dd") });
        await o.Owner.CreateTaskAsync(o.Project, "Someone else's", new { title = "Someone else's", priority = "Medium", assigneeId = o.Owner.UserId, dueDate = today.AddDays(-3).ToString("yyyy-MM-dd") });
        Guid mentionId = Guid.Empty, reminderId = Guid.Empty;
        factory.WithDb(db =>
        {
            var n = new Notification { TenantId = o.Tenant, UserId = o.Dev.UserId, Type = NotificationType.Mention, Title = "Olivia mentioned you in Atlas", Body = "@Dev can you check the totals?", Link = "/chat/x", InApp = true };
            db.Notifications.Add(n);
            db.Notifications.Add(new Notification { TenantId = o.Tenant, UserId = o.Dev.UserId, Type = NotificationType.Mention, Title = "Already read", Link = "/chat/y", InApp = true, ReadAt = DateTime.UtcNow });
            db.Notifications.Add(new Notification { TenantId = o.Tenant, UserId = o.Owner.UserId, Type = NotificationType.Mention, Title = "Not for Dev", Link = "/chat/z", InApp = true });
            var r = new Reminder { TenantId = o.Tenant, UserId = o.Dev.UserId, Source = ReminderSource.Personal, State = ReminderState.Fired, Title = "Call the auditor", TimeZone = "Asia/Kolkata", LastFiredAt = DateTime.UtcNow.AddMinutes(-5) };
            db.Reminders.Add(r);
            db.SaveChanges();
            mentionId = n.Id; reminderId = r.Id;
            return 0;
        });

        var all = await o.Dev.Get("/api/v1/inbox");
        Assert.True(all.Ok, all.ToString());
        var rows = Rows(all);
        var late = Assert.Single(rows, r => S(r!["title"]).EndsWith("Board pack"));
        Assert.Equal("task", S(late!["kind"]));
        Assert.Equal("assigned", S(late["group"]));
        Assert.Contains("overdue since", S(late["sub"]));
        Assert.Equal("Open", S(late["action"]!["label"]));
        Assert.StartsWith("/work?item=", S(late["href"]));
        Assert.True(late["urgent"]!.GetValue<bool>());
        Assert.DoesNotContain(rows, r => S(r!["title"]).EndsWith("Far away"));            // not due yet: not in the inbox
        Assert.DoesNotContain(rows, r => S(r!["title"]).EndsWith("Someone else's"));      // not theirs
        var mention = Assert.Single(rows, r => S(r!["kind"]) == "mention");
        Assert.Equal($"mention:{mentionId:N}", S(mention!["id"]));
        Assert.Equal("Reply", S(mention["action"]!["label"]));
        var reminder = Assert.Single(rows, r => S(r!["kind"]) == "reminder");
        Assert.Equal("Done", S(reminder!["action"]!["label"]));
        Assert.Equal($"/api/v1/reminders/{reminderId}/done", S(reminder["action"]!["endpoint"]));
        Assert.Equal(S(rows[0]!["id"]), S(late["id"]));                                   // urgent first
        Assert.Equal(3, all.Data!["counts"]!["all"]!.GetValue<int>());
        Assert.Equal(2, all.Data["counts"]!["assigned"]!.GetValue<int>());
        Assert.Equal(1, all.Data["counts"]!["mentions"]!.GetValue<int>());

        // Filters pick one group.
        Assert.All(Rows(await o.Dev.Get("/api/v1/inbox?filter=mentions")), r => Assert.Equal("mention", S(r!["kind"])));
        Assert.Empty(Rows(await o.Dev.Get("/api/v1/inbox?filter=decisions")));
        Assert.Equal(2, Rows(await o.Dev.Get("/api/v1/inbox?filter=assigned")).Count);

        // The owner's inbox is their own.
        var ownerRows = Rows(await o.Owner.Get("/api/v1/inbox"));
        Assert.Contains(ownerRows, r => S(r!["title"]).EndsWith("Someone else's"));
        Assert.DoesNotContain(ownerRows, r => S(r!["title"]).EndsWith("Board pack"));
    }

    [Fact]
    public async Task Later_hides_a_row_until_tomorrow_for_that_person_only()
    {
        var o = await Setup();
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        await o.Owner.CreateTaskAsync(o.Project, "Board pack", new { title = "Board pack", priority = "Medium", assigneeId = o.Dev.UserId, dueDate = today.AddDays(-2).ToString("yyyy-MM-dd") });
        var row = Assert.Single(Rows(await o.Dev.Get("/api/v1/inbox")));
        var id = S(row!["id"]);

        Assert.True((await o.Dev.Post($"/api/v1/inbox/{Uri.EscapeDataString(id)}/later", new { })).Ok);
        var after = await o.Dev.Get("/api/v1/inbox");
        Assert.Empty(Rows(after));
        Assert.Equal(1, after.Data!["later"]!.GetValue<int>());
        Assert.Equal(0, after.Data["counts"]!["all"]!.GetValue<int>());

        // Snoozed until tomorrow morning, not forever.
        var stored = factory.WithDb(db => db.UserUiPreferences.IgnoreQueryFilters().Single(p => p.UserId == o.Dev.UserId && p.Key.StartsWith("il:")).Value);
        var until = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, DateTime>>(stored)![id];
        Assert.InRange(until, DateTime.UtcNow.AddHours(1), DateTime.UtcNow.AddHours(36));

        // Once that time passes, it is back.
        factory.WithDb(db =>
        {
            var p = db.UserUiPreferences.IgnoreQueryFilters().Single(x => x.UserId == o.Dev.UserId && x.Key.StartsWith("il:"));
            p.Value = System.Text.Json.JsonSerializer.Serialize(new Dictionary<string, DateTime> { [id] = DateTime.UtcNow.AddMinutes(-1) });
            db.SaveChanges();
            return 0;
        });
        Assert.Single(Rows(await o.Dev.Get("/api/v1/inbox")));

        // A row id that is not one is refused.
        Assert.Equal("VALIDATION_FAILED", (await o.Dev.Post("/api/v1/inbox/nonsense/later", new { })).ErrorCode);
    }

    [Fact]
    public async Task The_briefing_is_found_by_rules_and_works_without_ai()
    {
        var o = await Setup();
        var empty = await o.Dev.Get("/api/v1/inbox/briefing");
        Assert.True(empty.Ok, empty.ToString());
        Assert.Equal(0, empty.Data!["count"]!.GetValue<int>());
        Assert.Equal("You're all caught up.", S(empty.Data["headline"]));
        Assert.Empty(empty.Data["reasons"]!.AsArray());

        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        await o.Owner.CreateTaskAsync(o.Project, "Board pack", new { title = "Board pack", priority = "High", assigneeId = o.Dev.UserId, dueDate = today.AddDays(-2).ToString("yyyy-MM-dd") });
        await o.Owner.CreateTaskAsync(o.Project, "Minutes", new { title = "Minutes", priority = "Medium", assigneeId = o.Dev.UserId, dueDate = today.AddDays(-1).ToString("yyyy-MM-dd") });
        var b = await o.Dev.Get("/api/v1/inbox/briefing");
        Assert.Equal(2, b.Data!["count"]!.GetValue<int>());
        Assert.Equal("2 things need you.", S(b.Data["headline"]));
        Assert.Equal(2, b.Data["stats"]!["overdue"]!.GetValue<int>());
        Assert.Contains(b.Data["reasons"]!.AsArray(), r => S(r).Contains("Board pack"));
        Assert.False(string.IsNullOrWhiteSpace(S(b.Data["sources"])));
        // Rules only: the briefing never spends AI credits.
        Assert.Equal(0, factory.WithDb(db => db.AiCreditReservations.IgnoreQueryFilters().Count(e => e.TenantId == o.Tenant)));
    }
}
