using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Persistence;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Notification channels (in-app / e-mail / desktop) chosen per user, background e-mail delivery, and security alerts.</summary>
[Collection("api")]
public class NotificationTests(ApiFactory factory)
{
    private static Task<ApiResult> SetPrefs(TestClient c, params (string Type, bool InApp, bool Email, bool Browser)[] items) =>
        c.Put("/api/v1/me/notification-preferences", new { items = items.Select(i => new { type = i.Type, i.InApp, i.Email, i.Browser }).ToArray() });

    [Fact]
    public async Task Saving_every_kind_of_notification_at_once_works_as_the_settings_page_does()
    {
        var c = await TestClient.RegisterAsync(factory, "Sana Saver");
        await c.CreateOrgAsync();
        var all = (await c.Get("/api/v1/me/notification-preferences")).Data!.AsArray();
        var items = all.Select(p => new { type = p!["type"]!.GetValue<string>(), inApp = true, email = false, browser = false }).ToArray();
        Assert.Equal(items.Length, ProjectManagement.Domain.NotificationCatalog.All.Length);
        Assert.True((await c.Put("/api/v1/me/notification-preferences", new { items })).Ok);   // not "Too many items"
    }

    private static JsonNode Pref(JsonNode list, string type) => list.AsArray().First(p => p!["type"]!.GetValue<string>() == type)!;

    private async Task<int> SendPendingAsync()
    {
        using var scope = factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<NotificationEmailService>().SendPendingAsync();
    }

    private async Task<List<JsonNode>> MailboxFor(TestClient c)
    {
        var res = await c.Send(HttpMethod.Get, "/api/v1/dev/emails", null, true);
        return res.Data!.AsArray().Where(m => string.Equals(m!["to"]!.GetValue<string>(), c.Email, StringComparison.OrdinalIgnoreCase)).Select(m => m!).ToList();
    }

    /// <summary>An organization with a member (Mia) and a project; the owner assigns tasks to Mia.</summary>
    private async Task<(TestClient Owner, TestClient Mia, Guid Project)> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var mia = await owner.AddMemberAsync(factory, TenantRole.Member, "Mia");
        return (owner, mia, await owner.CreateProjectAsync("Atlas"));
    }

    private static Task<JsonNode> Assign(TestClient owner, Guid project, TestClient to, string title) =>
        owner.CreateTaskAsync(project, title, new { title, priority = "Low", assigneeId = to.UserId });

    [Fact]
    public async Task Preferences_default_to_the_catalog_and_can_be_changed_but_security_alerts_stay_on()
    {
        var c = await TestClient.RegisterAsync(factory);
        var first = await c.Get("/api/v1/me/notification-preferences");
        Assert.True(first.Ok, first.ToString());
        Assert.Equal(ProjectManagement.Domain.NotificationCatalog.All.Length, first.Data!.AsArray().Count);
        Assert.True(Pref(first.Data, "TaskAssigned")["email"]!.GetValue<bool>());
        Assert.True(Pref(first.Data, "Comment")["email"]!.GetValue<bool>());
        Assert.True(Pref(first.Data, "TaskAssigned")["browser"]!.GetValue<bool>());

        var saved = await SetPrefs(c, ("TaskAssigned", true, false, true), ("Comment", false, true, false), ("Security", false, false, false));
        Assert.True(saved.Ok, saved.ToString());
        var afterTask = Pref(saved.Data!, "TaskAssigned");
        Assert.True(afterTask["inApp"]!.GetValue<bool>());
        Assert.False(afterTask["email"]!.GetValue<bool>());
        Assert.True(afterTask["browser"]!.GetValue<bool>());
        Assert.False(Pref(saved.Data!, "Comment")["inApp"]!.GetValue<bool>());
        var security = Pref(saved.Data!, "Security");
        Assert.True(security["inApp"]!.GetValue<bool>());     // locked on, whatever was sent
        Assert.True(security["email"]!.GetValue<bool>());
        Assert.True(security["locked"]!.GetValue<bool>());

        // Persisted per user.
        Assert.False(Pref((await c.Get("/api/v1/me/notification-preferences")).Data!, "Comment")["inApp"]!.GetValue<bool>());
        var other = await TestClient.RegisterAsync(factory);
        Assert.True(Pref((await other.Get("/api/v1/me/notification-preferences")).Data!, "Comment")["inApp"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.BadRequest, (await c.Put("/api/v1/me/notification-preferences", new { items = new[] { new { type = "Nope", inApp = true, email = true, browser = false } } })).Status);
    }

    [Fact]
    public async Task Assigning_a_task_notifies_in_the_app_and_queues_an_email_that_the_worker_sends()
    {
        var (owner, mia, project) = await Setup();
        await Assign(owner, project, mia, "Write the spec");

        var bell = await mia.Get("/api/v1/notifications");
        Assert.Contains(bell.Data!["items"]!.AsArray(), n => n!["type"]!.GetValue<string>() == "TaskAssigned");
        Assert.True(bell.Data["items"]![0]!["browser"]!.GetValue<bool>());    // desktop/mobile push by default, same as e-mail

        Assert.DoesNotContain(await MailboxFor(mia), m => m["subject"]!.GetValue<string>().StartsWith("You were assigned")); // nothing is sent inside the request
        Assert.True(await SendPendingAsync() >= 1);
        var mails = await MailboxFor(mia);
        Assert.Single(mails, m => m!["subject"]!.GetValue<string>().StartsWith("You were assigned"));
        Assert.Contains("Write the spec", mails[0]["text"]!.GetValue<string>());
        Assert.Contains("/projects/", mails[0]["text"]!.GetValue<string>());

        Assert.Equal(0, await SendPendingAsync());           // sent once, never twice
    }

    [Fact]
    public async Task Channels_follow_the_recipients_choices()
    {
        var (owner, mia, project) = await Setup();

        // E-mail only: nothing in the bell, still an email.
        await SetPrefs(mia, ("TaskAssigned", false, true, false));
        await Assign(owner, project, mia, "Email only");
        Assert.DoesNotContain((await mia.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), n => n!["title"]!.GetValue<string>().Contains("assigned") || n["body"]?.GetValue<string>() == "Email only");
        Assert.Equal(0, (await mia.Get("/api/v1/notifications/unread-count")).Data!["count"]!.GetValue<int>());
        await SendPendingAsync();
        Assert.Contains(await MailboxFor(mia), m => m["text"]!.GetValue<string>().Contains("Email only"));

        // In-app only: in the bell, no email.
        await SetPrefs(mia, ("TaskAssigned", true, false, false));
        await Assign(owner, project, mia, "Bell only");
        Assert.Contains((await mia.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), n => n!["body"]?.GetValue<string>() == "Bell only");
        await SendPendingAsync();
        Assert.DoesNotContain(await MailboxFor(mia), m => m["text"]!.GetValue<string>().Contains("Bell only"));

        // Desktop notification flag reaches the client, only together with the in-app item.
        await SetPrefs(mia, ("TaskAssigned", true, false, true));
        await Assign(owner, project, mia, "Desktop too");
        var desk = (await mia.Get("/api/v1/notifications")).Data!["items"]!.AsArray().First(n => n!["body"]?.GetValue<string>() == "Desktop too")!;
        Assert.True(desk["browser"]!.GetValue<bool>());

        // Everything off: no notification at all.
        await SetPrefs(mia, ("TaskAssigned", false, false, false));
        var before = (await mia.Get("/api/v1/notifications")).Data!["totalItems"]!.GetValue<int>();
        await Assign(owner, project, mia, "Nothing");
        Assert.Equal(before, (await mia.Get("/api/v1/notifications")).Data!["totalItems"]!.GetValue<int>());
        await SendPendingAsync();
        Assert.DoesNotContain(await MailboxFor(mia), m => m["text"]!.GetValue<string>().Contains("Nothing"));
    }

    [Fact]
    public async Task Mentions_and_comments_both_e_mail_by_default()
    {
        var (owner, mia, project) = await Setup();
        var task = await Assign(owner, project, mia, "Discuss");
        var taskId = task["id"]!.GetValue<string>();
        var miaId = mia.UserId;
        Assert.True((await owner.Post($"/api/v1/tasks/{taskId}/comments", new { body = "@Mia please look", mentionUserIds = new[] { miaId } })).Ok);
        Assert.True((await owner.Post($"/api/v1/tasks/{taskId}/comments", new { body = "Plain remark" })).Ok);

        await SendPendingAsync();
        // Three batchable notices (assigned, mentioned, commented) land together as one digest (title-only text), not three separate e-mails.
        var texts = (await MailboxFor(mia)).Select(m => m["text"]!.GetValue<string>()).ToList();
        Assert.Contains(texts, t => t.Contains("You were mentioned on"));  // mention e-mails by default
        Assert.Contains(texts, t => t.Contains("New comment on"));        // comment e-mails by default too
        Assert.Contains((await mia.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), n => n!["type"]!.GetValue<string>() == "Comment");
    }

    [Fact]
    public async Task The_inbox_splits_what_needs_you_from_updates_and_archived_notices_leave_it_but_stay_findable()
    {
        var (owner, mia, project) = await Setup();
        var task = await Assign(owner, project, mia, "Lanes");                 // assigned: needs you
        var taskId = task["id"]!.GetValue<string>();
        Assert.True((await owner.Post($"/api/v1/tasks/{taskId}/comments", new { body = "Just so you know" })).Ok);   // a comment: for your information

        var counts = (await mia.Get("/api/v1/notifications/counts")).Data!;
        Assert.True(counts["needsYou"]!.GetValue<int>() >= 1);
        Assert.True(counts["forInfo"]!.GetValue<int>() >= 1);
        Assert.Equal(counts["unread"]!.GetValue<int>(), counts["needsYou"]!.GetValue<int>() + counts["forInfo"]!.GetValue<int>());

        var needs = (await mia.Get("/api/v1/notifications?lane=needs")).Data!["items"]!.AsArray();
        Assert.All(needs, n => Assert.True(n!["needsYou"]!.GetValue<bool>()));
        Assert.Contains(needs, n => n!["type"]!.GetValue<string>() == "TaskAssigned");
        var info = (await mia.Get("/api/v1/notifications?lane=info")).Data!["items"]!.AsArray();
        Assert.Contains(info, n => n!["type"]!.GetValue<string>() == "Comment");
        Assert.DoesNotContain(info, n => n!["type"]!.GetValue<string>() == "TaskAssigned");

        // Archiving puts it away (and reads it); it shows under Archived and can come back.
        var comment = info.First(n => n!["type"]!.GetValue<string>() == "Comment")!["id"]!.GetValue<string>();
        Assert.Equal(HttpStatusCode.NoContent, (await mia.Post($"/api/v1/notifications/{comment}/archive", new { })).Status);
        Assert.DoesNotContain((await mia.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), n => n!["id"]!.GetValue<string>() == comment);
        var archived = (await mia.Get("/api/v1/notifications?archived=true")).Data!["items"]!.AsArray();
        var put = archived.Single(n => n!["id"]!.GetValue<string>() == comment)!;
        Assert.True(put["isRead"]!.GetValue<bool>());
        Assert.True(put["archived"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.NoContent, (await mia.Post($"/api/v1/notifications/{comment}/unarchive", new { })).Status);
        Assert.Contains((await mia.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), n => n!["id"]!.GetValue<string>() == comment);

        // Someone else's notification cannot be archived.
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Post($"/api/v1/notifications/{comment}/archive", new { })).Status);

        // Clear read: everything read leaves the inbox; unread stays.
        Assert.True((await mia.Post($"/api/v1/notifications/{comment}/read", new { })).Ok);
        var cleared = await mia.Post("/api/v1/notifications/archive-read", new { });
        Assert.True(cleared.Data!["archived"]!.GetValue<int>() >= 1);
        var left = (await mia.Get("/api/v1/notifications")).Data!["items"]!.AsArray();
        Assert.All(left, n => Assert.False(n!["isRead"]!.GetValue<bool>()));
        Assert.Contains(left, n => n!["type"]!.GetValue<string>() == "TaskAssigned");
    }

    private static JsonNode Find(JsonNode list, Func<JsonNode, bool> match) => list["items"]!.AsArray().First(n => match(n!))!;
    private static string[] ActionsOf(JsonNode n) => n["actions"]!.AsArray().Select(a => a!.GetValue<string>()).ToArray();

    [Fact]
    public async Task A_notification_can_be_acted_on_in_place_with_the_same_rules_as_the_page()
    {
        var (owner, mia, project) = await Setup();
        var task = await Assign(owner, project, mia, "Act in place");
        var taskId = task["id"]!.GetValue<string>();
        var key = task["key"]!.GetValue<string>();

        // Assigned: done, reply and snooze are offered.
        var assigned = Find((await mia.Get("/api/v1/notifications")).Data!, n => n["type"]!.GetValue<string>() == "TaskAssigned" && n["title"]!.GetValue<string>().Contains(key));
        Assert.Equal(new[] { "done", "reply", "snooze" }, ActionsOf(assigned));
        var aid = assigned["id"]!.GetValue<string>();

        // Reply straight from it: a comment on the task, by Mia; the notice stays (read).
        Assert.Equal(422, (int)(await mia.Post($"/api/v1/notifications/{aid}/act", new { action = "reply", text = "" })).Status);
        var replied = await mia.Post($"/api/v1/notifications/{aid}/act", new { action = "reply", text = "On it today" });
        Assert.True(replied.Ok, replied.ToString());
        Assert.False(replied.Data!["archived"]!.GetValue<bool>());
        var comments = (await owner.Get($"/api/v1/tasks/{taskId}/comments")).Data!.AsArray();
        Assert.Contains(comments, c => c!["body"]!.GetValue<string>() == "On it today" && c["author"]!["id"]!.GetValue<string>() == mia.UserId.ToString());

        // Done: the task moves to a Done status through the board's own rules, and the notice is put away.
        var done = await mia.Post($"/api/v1/notifications/{aid}/act", new { action = "done" });
        Assert.True(done.Ok, done.ToString());
        Assert.True(done.Data!["archived"]!.GetValue<bool>());
        Assert.Equal("Done", (await owner.Get($"/api/v1/tasks/{taskId}")).Data!["task"]!["statusCategory"]!.GetValue<string>());
        Assert.DoesNotContain((await mia.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), n => n!["id"]!.GetValue<string>() == aid);

        // Someone else's notification cannot be acted on; an action that does not fit is refused.
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Post($"/api/v1/notifications/{aid}/act", new { action = "done" })).Status);
        Assert.Equal(422, (int)(await mia.Post($"/api/v1/notifications/{aid}/act", new { action = "approve" })).Status);
    }

    [Fact]
    public async Task In_digest_mode_updates_wait_for_the_daily_email_while_what_needs_you_comes_at_once()
    {
        var (owner, mia, project) = await Setup();
        var settings = (await mia.Get("/api/v1/reminders/settings")).Data!.AsObject();
        settings["digestTime"] = "18:00";
        settings["quietStart"] = null; settings["quietEnd"] = null;   // so only the digest holds anything back
        var saved = await mia.Put("/api/v1/reminders/settings", settings);
        Assert.True(saved.Ok, saved.ToString());
        Assert.Equal("18:00", saved.Data!["digestTime"]!.GetValue<string>());

        var task = await Assign(owner, project, mia, "Digest check");
        Assert.True((await owner.Post($"/api/v1/tasks/{task["id"]!.GetValue<string>()}/comments", new { body = "FYI only" })).Ok);
        factory.WithDb(db =>
        {
            var rows = db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == mia.UserId).ToList();
            var assigned = rows.Single(n => n.Type == NotificationType.TaskAssigned && n.Body == "Digest check");
            Assert.Null(assigned.DeliverAfter);                          // needs her: now
            var comment = rows.Single(n => n.Type == NotificationType.Comment);
            Assert.False(comment.PushPending);                           // an update: no push
            Assert.NotNull(comment.DeliverAfter);                         // and its email waits for 18:00
            Assert.True(comment.DeliverAfter > DateTime.UtcNow && comment.DeliverAfter <= DateTime.UtcNow.AddDays(1));
            Assert.True(comment.InApp);                                   // still in the inbox at once
            return 0;
        });

        // Turning it off brings the old behaviour back.
        settings["digestTime"] = null;
        Assert.Null((await mia.Put("/api/v1/reminders/settings", settings)).Data!["digestTime"]);
    }

    [Fact]
    public async Task A_snoozed_notification_leaves_the_inbox_and_counts_until_it_comes_back()
    {
        var (owner, mia, project) = await Setup();
        var task = await Assign(owner, project, mia, "Snooze me");
        var key = task["key"]!.GetValue<string>();
        var n = Find((await mia.Get("/api/v1/notifications")).Data!, x => x["title"]!.GetValue<string>().Contains(key));
        var id = n["id"]!.GetValue<string>();
        var before = (await mia.Get("/api/v1/notifications/counts")).Data!;

        Assert.Equal(422, (int)(await mia.Post($"/api/v1/notifications/{id}/act", new { action = "snooze", until = DateTime.UtcNow.AddMinutes(1) })).Status);
        var snoozed = await mia.Post($"/api/v1/notifications/{id}/act", new { action = "snooze", until = DateTime.UtcNow.AddHours(3) });
        Assert.True(snoozed.Ok, snoozed.ToString());

        Assert.DoesNotContain((await mia.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), x => x!["id"]!.GetValue<string>() == id);
        var after = (await mia.Get("/api/v1/notifications/counts")).Data!;
        Assert.Equal(before["unread"]!.GetValue<int>() - 1, after["unread"]!.GetValue<int>());
        Assert.Equal(1, after["snoozed"]!.GetValue<int>());
        var resting = Assert.Single((await mia.Get("/api/v1/notifications?lane=snoozed")).Data!["items"]!.AsArray())!;
        Assert.NotNull(resting["snoozedUntil"]);

        // When the time comes it is back on top, unread, and waiting to be pushed again.
        factory.WithDb(db =>
        {
            var row = db.Notifications.IgnoreQueryFilters().Single(x => x.Id == Guid.Parse(id));
            row.SnoozedUntil = DateTime.UtcNow.AddMinutes(-1);
            db.SaveChanges();
            return 0;
        });
        var back = (await mia.Get("/api/v1/notifications")).Data!["items"]!.AsArray()[0]!;
        Assert.Equal(id, back["id"]!.GetValue<string>());
        Assert.False(back["isRead"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Changing_a_task_s_priority_or_due_date_notifies_the_assignee_without_touching_the_assignee_field()
    {
        var (owner, mia, project) = await Setup();
        var task = await Assign(owner, project, mia, "Discuss");
        var taskId = task["id"]!.GetValue<string>();
        var statuses = (await owner.Get($"/api/v1/projects/{project}/statuses")).Data!.AsArray();
        var statusId = statuses[0]!["id"]!.GetValue<string>();

        var upd = await owner.Put($"/api/v1/tasks/{taskId}", new { title = "Discuss", statusId, priority = "High", assigneeId = mia.UserId, version = task["version"]!.GetValue<int>() });
        Assert.True(upd.Ok, upd.ToString());

        var bell = (await mia.Get("/api/v1/notifications")).Data!["items"]!.AsArray();
        Assert.Contains(bell, n => n!["type"]!.GetValue<string>() == "TaskUpdated" && n["body"]!.GetValue<string>().Contains("priority"));
        await SendPendingAsync();
        Assert.Contains(await MailboxFor(mia), m => m["text"]!.GetValue<string>().Contains("priority"));
    }

    [Fact]
    public async Task A_project_s_status_change_notifies_its_members_by_e_mail()
    {
        var (owner, mia, project) = await Setup();
        await owner.Post($"/api/v1/projects/{project}/members", new { userId = mia.UserId });
        var detail = (await owner.Get($"/api/v1/projects/{project}")).Data!;
        var p = detail["project"]!;

        var upd = await owner.Put($"/api/v1/projects/{project}", new
        {
            name = p["name"]!.GetValue<string>(), priority = p["priority"]!.GetValue<string>(), status = "Completed", version = p["version"]!.GetValue<int>(),
        });
        Assert.True(upd.Ok, upd.ToString());

        var bell = (await mia.Get("/api/v1/notifications")).Data!["items"]!.AsArray();
        Assert.Contains(bell, n => n!["type"]!.GetValue<string>() == "ProjectUpdated");
        await SendPendingAsync();
        Assert.Contains(await MailboxFor(mia), m => m["subject"]!.GetValue<string>().Contains("Completed"));
    }

    [Fact]
    public async Task Changing_the_password_raises_a_security_alert_that_cannot_be_switched_off()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        await SetPrefs(c, ("Security", false, false, false));

        var res = await c.Post("/api/v1/me/password", new { currentPassword = "Passw0rd!x", newPassword = "Another1!pass" });
        Assert.Equal(HttpStatusCode.NoContent, res.Status);
        var relog = await c.LoginAsync("Another1!pass");
        Assert.True(relog.Ok, relog.ToString());
        await c.SwitchToAsync((await c.Get("/api/v1/workspaces")).Data!.AsArray().First(w => w!["type"]!.GetValue<string>() == "Organization")!["id"]!.GetValue<Guid>());

        var bell = (await c.Get("/api/v1/notifications")).Data!["items"]!.AsArray();
        Assert.Contains(bell, n => n!["type"]!.GetValue<string>() == "Security" && n["title"]!.GetValue<string>().Contains("password"));
        await SendPendingAsync();
        Assert.Contains(await MailboxFor(c), m => m["subject"]!.GetValue<string>().Contains("password was changed"));
    }

    [Fact]
    public async Task Failing_mail_servers_are_retried_a_limited_number_of_times_and_never_break_the_request()
    {
        var (owner, mia, project) = await Setup();
        await Assign(owner, project, mia, "Flaky mail");

        // Same database, but a mail server that is down.
        var failure = factory.WithDb(db =>
        {
            var options = Options.Create(new AppOptions { WebBaseUrl = "http://localhost:8080" });
            var svc = new NotificationEmailService(db, new BrokenSender(), options, new AppClock(TimeProvider.System, options), NullLogger<NotificationEmailService>.Instance);
            for (var i = 0; i < NotificationEmailService.MaxAttempts + 2; i++) svc.SendPendingAsync().GetAwaiter().GetResult();
            return db.Notifications.IgnoreQueryFilters().First(n => n.UserId == mia.UserId && n.Body == "Flaky mail");
        });
        Assert.Equal(NotificationEmailService.MaxAttempts, failure.EmailAttempts);
        Assert.False(failure.EmailPending);        // given up...
        Assert.Null(failure.EmailedAt);
        Assert.Contains((await mia.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), n => n!["body"]?.GetValue<string>() == "Flaky mail"); // ...but still in the bell
    }

    [Fact]
    public async Task The_test_email_button_reports_what_happened()
    {
        var c = await TestClient.RegisterAsync(factory);
        var res = await c.Post("/api/v1/me/notification-preferences/test-email");
        Assert.True(res.Ok, res.ToString());
        Assert.Equal("log", res.Data!["provider"]!.GetValue<string>());
        Assert.True(res.Data["delivered"]!.GetValue<bool>());
        Assert.Contains("not connected", res.Data["message"]!.GetValue<string>());
        Assert.Contains(await MailboxFor(c), m => m["subject"]!.GetValue<string>() == "Test notification");
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.Send(HttpMethod.Post, "/api/v1/me/notification-preferences/test-email", new { }, anonymous: true)).Status);
    }

    private sealed class BrokenSender : IEmailSender
    {
        public string Name => "smtp";
        public Task SendAsync(EmailMessage message, CancellationToken ct = default) => throw new InvalidOperationException("SMTP server unreachable");
    }
}
