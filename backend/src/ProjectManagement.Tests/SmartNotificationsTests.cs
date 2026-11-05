using System.Net;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Smart notifications: updates about one project close together are one group and only the first pings; urgent kinds ring, the rest stay a
/// quiet badge, and a person can move kinds between the two; a muted project or thread still lands in the centre but never rings or e-mails.
/// </summary>
[Collection("api")]
public class SmartNotificationsTests(ApiFactory factory)
{
    [Theory]
    [InlineData(NotificationType.Approval, "urgent")]
    [InlineData(NotificationType.Mention, "urgent")]
    [InlineData(NotificationType.DueSoon, "urgent")]
    [InlineData(NotificationType.Call, "urgent")]
    [InlineData(NotificationType.ServiceLevel, "urgent")]
    [InlineData(NotificationType.TaskUpdated, "normal")]
    [InlineData(NotificationType.ProjectUpdated, "normal")]
    public void Default_priorities(NotificationType type, string expected) => Assert.Equal(expected, NotificationPriority.Default(type));

    [Fact]
    public void Overrides_round_trip_and_security_stays_urgent()
    {
        var map = NotificationPriority.Parse("Approval=normal,TaskUpdated=urgent,Nope=urgent,Security=normal");
        Assert.Equal("normal", NotificationPriority.Of(NotificationType.Approval, map));
        Assert.Equal("urgent", NotificationPriority.Of(NotificationType.TaskUpdated, map));
        Assert.Equal("urgent", NotificationPriority.Of(NotificationType.Security, map));
        Assert.Equal("Approval=normal,TaskUpdated=urgent", NotificationPriority.Write(map));
    }

    [Fact]
    public void Groups_and_threads_come_from_the_link()
    {
        var p = Guid.NewGuid(); var t = Guid.NewGuid(); var c = Guid.NewGuid();
        Assert.Equal($"project:{p:N}", NotificationGroups.KeyOf($"/projects/{p}?task={t}"));
        Assert.Equal(t, NotificationGroups.ThreadOf($"/projects/{p}?task={t}"));
        Assert.Equal($"chat:{c:N}", NotificationGroups.KeyOf($"/chat/{c}"));
        Assert.Null(NotificationGroups.KeyOf("/settings/security"));
        Assert.Equal($"/projects/{p}", NotificationGroups.LinkPrefix($"/projects/{p}/board"));
    }

    [Fact]
    public async Task A_burst_on_one_project_pings_once_is_grouped_and_a_muted_project_stays_quiet()
    {
        var owner = await TestClient.RegisterAsync(factory, "Gita Grouper");
        await owner.CreateOrgAsync();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mona Member");
        var project = await owner.CreateProjectAsync("Fictional Ledger Revamp");
        await owner.Post($"/api/v1/projects/{project}/members", new { userId = member.UserId });

        for (var i = 1; i <= 3; i++)
            await owner.CreateTaskAsync(project, $"Fictional step {i}", new { title = $"Fictional step {i}", assigneeId = member.UserId });

        var rows = factory.WithDb(db => db.Notifications.Where(n => n.UserId == member.UserId && n.Type == NotificationType.TaskAssigned).OrderBy(n => n.CreatedAt)
            .Select(n => new { n.Browser, n.PushPending, n.EmailPending, n.Link }).ToList());
        Assert.Equal(3, rows.Count);
        Assert.True(rows[0].Browser);                        // the first of the burst pings
        Assert.All(rows.Skip(1), r => Assert.False(r.Browser || r.PushPending));   // the rest join its group quietly

        var list = (await member.Get("/api/v1/notifications?pageSize=10")).Data!["items"]!.AsArray();
        var assigned = list.Where(n => n!["type"]!.GetValue<string>() == "TaskAssigned").ToList();
        Assert.All(assigned, n => Assert.Equal($"project:{project:N}", n!["groupKey"]!.GetValue<string>()));
        Assert.All(assigned, n => Assert.Equal("Fictional Ledger Revamp", n!["groupLabel"]!.GetValue<string>()));
        Assert.All(assigned, n => Assert.Equal("normal", n!["priority"]!.GetValue<string>()));

        // Tune: task assignments ring as urgent.
        var saved = await member.Put("/api/v1/notifications/smart", new { priorities = new[] { new { type = "TaskAssigned", priority = "urgent" } } });
        Assert.True(saved.Ok, saved.ToString());
        var kind = saved.Data!["kinds"]!.AsArray().First(k => k!["type"]!.GetValue<string>() == "TaskAssigned")!;
        Assert.Equal("urgent", kind["priority"]!.GetValue<string>());
        Assert.Equal("urgent", (await member.Get("/api/v1/notifications?pageSize=10")).Data!["items"]!.AsArray()
            .First(n => n!["type"]!.GetValue<string>() == "TaskAssigned")!["priority"]!.GetValue<string>());

        // Mute the project: the next one still lands, but nothing rings or e-mails.
        var mute = await member.Post("/api/v1/notifications/mutes", new { scope = "project", targetId = project });
        Assert.True(mute.Ok, mute.ToString());
        Assert.Equal("Fictional Ledger Revamp", mute.Data!["label"]!.GetValue<string>());
        await owner.CreateTaskAsync(project, "Fictional step 4", new { title = "Fictional step 4", assigneeId = member.UserId });
        var last = factory.WithDb(db => db.Notifications.Where(n => n.UserId == member.UserId && n.Type == NotificationType.TaskAssigned).OrderByDescending(n => n.CreatedAt)
            .Select(n => new { n.InApp, n.Browser, n.PushPending, n.EmailPending }).First());
        Assert.True(last.InApp);
        Assert.False(last.Browser || last.PushPending || last.EmailPending);
        Assert.True((await member.Get("/api/v1/notifications?pageSize=10")).Data!["items"]!.AsArray()
            .First(n => n!["type"]!.GetValue<string>() == "TaskAssigned")!["muted"]!.GetValue<bool>());

        // Unmute.
        var smart = (await member.Get("/api/v1/notifications/smart")).Data!;
        var muteId = smart["mutes"]!.AsArray().Single()!["id"]!.GetValue<string>();
        Assert.Equal(HttpStatusCode.NoContent, (await member.Delete($"/api/v1/notifications/mutes/{muteId}")).Status);
        Assert.Empty((await member.Get("/api/v1/notifications/smart")).Data!["mutes"]!.AsArray());
    }

    [Fact]
    public async Task Mutes_are_checked_and_private()
    {
        var owner = await TestClient.RegisterAsync(factory, "Pia Private");
        await owner.CreateOrgAsync();
        var other = await TestClient.RegisterAsync(factory, "Oz Outsider");
        await other.CreateOrgAsync();
        var project = await owner.CreateProjectAsync("Fictional Vault");
        // Someone in another workspace cannot mute (or learn the name of) this project.
        Assert.Equal(HttpStatusCode.NotFound, (await other.Post("/api/v1/notifications/mutes", new { scope = "project", targetId = project })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post("/api/v1/notifications/mutes", new { scope = "planet", targetId = project })).Status);
        var thread = await owner.Post("/api/v1/notifications/mutes", new { scope = "thread", targetId = Guid.NewGuid(), label = "Fictional thread", hours = 8 });
        Assert.True(thread.Ok, thread.ToString());
        var id = thread.Data!["id"]!.GetValue<string>();
        Assert.Equal(HttpStatusCode.NotFound, (await other.Delete($"/api/v1/notifications/mutes/{id}")).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put("/api/v1/notifications/smart", new { groupWindowMinutes = 1 })).Status);
    }
}
