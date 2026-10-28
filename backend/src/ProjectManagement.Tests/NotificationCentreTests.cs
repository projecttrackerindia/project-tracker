using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The Notification Centre (the bell next to + New): categories and their badge counts, read / unread, delete, clearing a stacked group, a
/// category or everything, snoozing, and meeting reminders that know when the meeting starts and where to join.
/// </summary>
[Collection("api")]
public class NotificationCentreTests(ApiFactory factory)
{
    private async Task<TestClient> Person(string name)
    {
        var c = await TestClient.RegisterAsync(factory, name);
        await c.CreateOrgAsync();
        return c;
    }

    /// <summary>Puts notifications straight into the person's Notification Centre (one of each kind the filters split).</summary>
    private Dictionary<string, Guid> Seed(TestClient c, params (string Key, NotificationType Type, string? Link)[] rows) => factory.WithDb(db =>
    {
        var now = DateTime.UtcNow;
        var ids = new Dictionary<string, Guid>();
        var i = 0;
        foreach (var (key, type, link) in rows)
        {
            var n = new Notification { TenantId = c.WorkspaceId, UserId = c.UserId, Type = type, Title = $"{key} title", Body = $"{key} body", Link = link, InApp = true, CreatedAt = now.AddSeconds(-i++) };
            db.Notifications.Add(n);
            ids[key] = n.Id;
        }
        db.SaveChanges();
        return ids;
    });

    private static readonly (string, NotificationType, string?)[] OneOfEach =
    [
        ("msg", NotificationType.Message, $"/chat/{Guid.NewGuid()}"),
        ("mention", NotificationType.Mention, "/my-work"),
        ("reminder", NotificationType.Reminder, "/?tab=reminders"),
        ("overdue", NotificationType.Overdue, "/my-work"),
        ("meetingReminder", NotificationType.Reminder, $"/meet?open=w:{Guid.NewGuid()}"),
        ("invite", NotificationType.Meeting, "/meet"),
        ("assigned", NotificationType.TaskAssigned, "/my-work"),
    ];

    private static List<string> Titles(ApiResult r) => r.Data!["items"]!.AsArray().Select(x => x!["title"]!.GetValue<string>()).ToList();

    [Fact]
    public async Task Counts_split_unread_by_category_and_each_filter_lists_only_its_own()
    {
        var c = await Person("Nora Centre");
        Seed(c, OneOfEach);
        var counts = (await c.Get("/api/v1/notifications/counts")).Data!;
        Assert.Equal(2, counts["messages"]!.GetValue<int>());
        Assert.Equal(2, counts["reminders"]!.GetValue<int>());
        Assert.Equal(2, counts["meetings"]!.GetValue<int>());
        Assert.Equal(counts["unread"]!.GetValue<int>(), counts["messages"]!.GetValue<int>() + counts["reminders"]!.GetValue<int>() + counts["meetings"]!.GetValue<int>() + counts["work"]!.GetValue<int>());
        Assert.Equal(counts["unread"]!.GetValue<int>(), counts["needsYou"]!.GetValue<int>() + counts["forInfo"]!.GetValue<int>());

        var meetings = await c.Get("/api/v1/notifications?category=meetings");
        Assert.Equal(new[] { "meetingReminder title", "invite title" }, Titles(meetings).ToArray());
        Assert.All(meetings.Data!["items"]!.AsArray(), x => Assert.Equal("meetings", x!["category"]!.GetValue<string>()));
        Assert.Equal(new[] { "reminder title", "overdue title" }, Titles(await c.Get("/api/v1/notifications?category=reminders")).ToArray());
        Assert.Equal(new[] { "msg title", "mention title" }, Titles(await c.Get("/api/v1/notifications?category=messages")).ToArray());
        Assert.Contains("assigned title", Titles(await c.Get("/api/v1/notifications?category=work")));
        Assert.DoesNotContain("msg title", Titles(await c.Get("/api/v1/notifications?category=work")));
    }

    [Fact]
    public async Task Read_and_unread_toggle_and_mark_all_read_can_be_limited_to_a_category()
    {
        var c = await Person("Ravi Reader");
        var ids = Seed(c, OneOfEach);
        Assert.Equal(204, (int)(await c.Post($"/api/v1/notifications/{ids["msg"]}/read")).Status);
        Assert.Equal(1, (await c.Get("/api/v1/notifications/counts")).Data!["messages"]!.GetValue<int>());
        Assert.Equal(204, (int)(await c.Post($"/api/v1/notifications/{ids["msg"]}/unread")).Status);
        Assert.Equal(2, (await c.Get("/api/v1/notifications/counts")).Data!["messages"]!.GetValue<int>());

        Assert.True((await c.Post("/api/v1/notifications/read-all?category=messages")).Ok);
        var after = (await c.Get("/api/v1/notifications/counts")).Data!;
        Assert.Equal(0, after["messages"]!.GetValue<int>());
        Assert.Equal(2, after["reminders"]!.GetValue<int>());

        // Someone else's notification cannot be touched.
        var other = await Person("Olga Other");
        Assert.Equal(404, (int)(await other.Post($"/api/v1/notifications/{ids["reminder"]}/unread")).Status);
        Assert.Equal(404, (int)(await other.Delete($"/api/v1/notifications/{ids["reminder"]}")).Status);
    }

    [Fact]
    public async Task Delete_removes_it_for_this_person_only_and_clear_takes_a_group_a_category_or_everything()
    {
        var c = await Person("Dev Deleter");
        var ids = Seed(c, OneOfEach);
        Assert.Equal(204, (int)(await c.Delete($"/api/v1/notifications/{ids["assigned"]}")).Status);
        Assert.DoesNotContain("assigned title", Titles(await c.Get("/api/v1/notifications")));
        Assert.Contains("assigned title", Titles(await c.Get("/api/v1/notifications?archived=true")));   // soft: still findable

        var group = await c.Post("/api/v1/notifications/clear", new { ids = new[] { ids["msg"], ids["mention"] } });
        Assert.True(group.Ok, group.ToString());
        Assert.Equal(2, group.Data!["cleared"]!.GetValue<int>());
        Assert.Equal(0, (await c.Get("/api/v1/notifications/counts")).Data!["messages"]!.GetValue<int>());

        Assert.Equal(422, (int)(await c.Post("/api/v1/notifications/clear", new { category = "nonsense" })).Status);
        var meet = await c.Post("/api/v1/notifications/clear", new { category = "meetings" });
        Assert.Equal(2, meet.Data!["cleared"]!.GetValue<int>());
        Assert.Contains("reminder title", Titles(await c.Get("/api/v1/notifications")));

        // Clear all leaves a snoozed one snoozed.
        Assert.Equal(204, (int)(await c.Post($"/api/v1/notifications/{ids["reminder"]}/snooze", new { until = DateTime.UtcNow.AddHours(1) })).Status);
        var all = await c.Post("/api/v1/notifications/clear", new { });
        Assert.True(all.Ok, all.ToString());
        Assert.Empty((await c.Get("/api/v1/notifications")).Data!["items"]!.AsArray());
        var counts = (await c.Get("/api/v1/notifications/counts")).Data!;
        Assert.Equal(0, counts["unread"]!.GetValue<int>());
        Assert.Equal(1, counts["snoozed"]!.GetValue<int>());
    }

    [Fact]
    public async Task Snooze_hides_it_until_then_and_queues_the_push_again_for_that_moment()
    {
        var c = await Person("Sam Snoozer");
        var ids = Seed(c, ("ping", NotificationType.Reminder, "/?tab=reminders"));
        factory.WithDb(db => { db.Notifications.IgnoreQueryFilters().Single(n => n.Id == ids["ping"]).Browser = true; return db.SaveChanges(); });
        Assert.Equal(422, (int)(await c.Post($"/api/v1/notifications/{ids["ping"]}/snooze", new { until = DateTime.UtcNow.AddMinutes(1) })).Status);
        var until = DateTime.UtcNow.AddHours(2);
        Assert.Equal(204, (int)(await c.Post($"/api/v1/notifications/{ids["ping"]}/snooze", new { until })).Status);
        Assert.Empty((await c.Get("/api/v1/notifications")).Data!["items"]!.AsArray());
        Assert.Equal(0, (await c.Get("/api/v1/notifications/counts")).Data!["reminders"]!.GetValue<int>());
        var row = factory.WithDb(db => db.Notifications.IgnoreQueryFilters().AsNoTracking().Single(n => n.Id == ids["ping"]));
        Assert.True(row.PushPending);
        Assert.NotNull(row.DeliverAfter);
        Assert.True(Math.Abs((row.DeliverAfter!.Value - until).TotalSeconds) < 2);

        // Null brings it back now.
        Assert.Equal(204, (int)(await c.Post($"/api/v1/notifications/{ids["ping"]}/snooze", new { until = (DateTime?)null })).Status);
        Assert.Single((await c.Get("/api/v1/notifications")).Data!["items"]!.AsArray());
    }

    [Fact]
    public async Task A_meeting_reminder_knows_when_the_meeting_starts_and_where_to_join()
    {
        var c = await Person("Mina Meets");
        var meetingId = Guid.NewGuid();
        var start = DateTime.UtcNow.AddMinutes(8);
        factory.WithDb(db =>
        {
            db.WorkspaceMeetings.Add(new WorkspaceMeeting
            {
                Id = meetingId, TenantId = c.WorkspaceId, OrganizerUserId = c.UserId, Title = "Weekly sync", StartTimeUtc = start, EndTimeUtc = start.AddMinutes(30),
                Provider = MeetingProvider.ProjectTracker, CreatedAt = DateTime.UtcNow,
            });
            return db.SaveChanges();
        });
        Seed(c, ("Starts in 8 minutes: Weekly sync", NotificationType.Reminder, $"/calls/meeting/w/{meetingId}"));
        var item = (await c.Get("/api/v1/notifications?category=meetings")).Data!["items"]!.AsArray().Single()!;
        Assert.Equal("meetings", item["category"]!.GetValue<string>());
        Assert.Equal($"/calls/meeting/w/{meetingId}", item["joinLink"]!.GetValue<string>());
        Assert.True(Math.Abs((item["startsAt"]!.GetValue<DateTime>().ToUniversalTime() - start).TotalSeconds) < 2);
    }
}
