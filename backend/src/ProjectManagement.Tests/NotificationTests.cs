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
