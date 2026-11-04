using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The whole notification pipeline per event (docs/notifications-matrix.md): the event creates a notification row in the bell, the row is
/// announced live to the recipient's open tabs (SignalR "notification", which drives the badges, the sound and the desktop notice), and its
/// e-mail is queued; the person's settings (channels switched off, do not disturb) suppress or hold exactly what they say.
/// </summary>
[Collection("api")]
public class NotificationPipelineTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<(TestClient Owner, TestClient Admin, TestClient Member, Guid Project)> TeamAsync(string name)
    {
        var owner = await TestClient.RegisterAsync(factory, $"{name} Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var admin = await owner.AddMemberAsync(factory, TenantRole.Admin, $"{name} Ops");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, $"{name} Dev");
        return (owner, admin, member, await owner.CreateProjectAsync($"{name} Atlas"));
    }

    private List<ProjectManagement.Domain.Entities.Notification> Rows(Guid userId, NotificationType type) =>
        factory.WithDb(db => db.Notifications.IgnoreQueryFilters().AsNoTracking().Where(n => n.UserId == userId && n.Type == type).OrderBy(n => n.CreatedAt).ToList());

    private bool AnnouncedTo(Guid userId, Guid notificationId) => factory.Announced.Announced.Any(a => a.UserId == userId && a.NotificationId == notificationId);

    private async Task<string> AskAsync(TestClient requester, Guid approver, string title)
    {
        var created = await requester.Post("/api/v1/approvals", new
        {
            type = "Deployment", title, risk = "High",
            chain = new object[] { new { role = "Ops", userId = approver } },
        });
        Assert.True(created.Status == HttpStatusCode.Created, created.ToString());
        return S(created.Data!["id"]);
    }

    [Fact]
    public async Task Raising_an_approval_reaches_the_approver_in_the_bell_live_and_by_email()
    {
        var (_, admin, member, _) = await TeamAsync("Raise");
        var id = await AskAsync(member, admin.UserId, "Ship Billing API 3.1 to production");

        var row = Assert.Single(Rows(admin.UserId, NotificationType.Approval));
        Assert.Equal($"/approvals?open={id}", row.Link);
        Assert.True(row.InApp);
        Assert.True(row.Browser);            // desktop notice + sound on open tabs
        Assert.True(row.PushPending);        // and pushed to the phone / closed app
        Assert.True(row.EmailPending);       // and e-mailed
        Assert.True(AnnouncedTo(admin.UserId, row.Id), "the new approval was not announced live to the approver");

        // The badges read it: the bell's counts and the Approvals tab.
        var counts = (await admin.Get("/api/v1/notifications/counts")).Data!;
        Assert.True(counts["unread"]!.GetValue<int>() >= 1);
        Assert.True(counts["tabs"]!["approvals:work"]!.GetValue<int>() >= 1);
        Assert.Equal(1, (await admin.Get("/api/v1/approvals/counts")).Data!["needsMe"]!.GetValue<int>());

        // The e-mail actually goes out.
        using var scope = factory.Services.CreateScope();
        Assert.True(await scope.ServiceProvider.GetRequiredService<NotificationEmailService>().SendPendingAsync(batch: 5000) >= 1);
        Assert.NotNull(Rows(admin.UserId, NotificationType.Approval).Single().EmailedAt);
        // The requester is not told about their own request.
        Assert.Empty(Rows(member.UserId, NotificationType.Approval));
    }

    [Fact]
    public async Task Approving_and_rejecting_tell_the_requester_in_the_bell_live_and_by_email()
    {
        var (_, admin, member, _) = await TeamAsync("Decide");
        var yes = await AskAsync(member, admin.UserId, "Open the Pune office on Saturday");
        Assert.True((await admin.Post($"/api/v1/approvals/{yes}/decide", new { action = "approve", comment = "Go ahead." })).Ok);
        var no = await AskAsync(member, admin.UserId, "Buy a second build server");
        Assert.True((await admin.Post($"/api/v1/approvals/{no}/decide", new { action = "reject", comment = "Not this quarter." })).Ok);

        var rows = Rows(member.UserId, NotificationType.Approval);
        var approved = Assert.Single(rows, n => n.Title.StartsWith("Approved:"));
        var rejected = Assert.Single(rows, n => n.Title.StartsWith("Rejected:"));
        foreach (var n in new[] { approved, rejected })
        {
            Assert.True(n.InApp && n.Browser && n.EmailPending, $"{n.Title}: in-app {n.InApp}, desktop {n.Browser}, e-mail {n.EmailPending}");
            Assert.True(AnnouncedTo(member.UserId, n.Id), $"{n.Title} was not announced live");
        }
        Assert.Contains("Not this quarter", rejected.Body);
    }

    [Fact]
    public async Task Approval_deadlines_are_written_in_the_approvers_own_time_zone_not_utc()
    {
        var (_, admin, member, _) = await TeamAsync("Zone");
        factory.WithDb(db => { db.Users.First(u => u.Id == admin.UserId).TimeZone = "America/New_York"; return db.SaveChanges(); });
        await AskAsync(member, admin.UserId, "Rotate the payments signing key");
        var body = Rows(admin.UserId, NotificationType.Approval).Single().Body!;
        Assert.DoesNotContain("UTC", body);
        Assert.Matches(@"decide by \d{2} \w{3} \d{2}:\d{2} E[SD]T", body);
    }

    [Fact]
    public async Task Channels_switched_off_suppress_the_approval_and_do_not_disturb_holds_email_and_the_popup()
    {
        var (_, admin, member, _) = await TeamAsync("Quiet");
        // The approver switched e-mail and desktop off for approvals: the bell only, still announced (the badge must move).
        Assert.True((await admin.Put("/api/v1/me/notification-preferences", new { items = new[] { new { type = "Approval", inApp = true, email = false, browser = false } } })).Ok);
        await AskAsync(member, admin.UserId, "Extend the staging freeze");
        var bellOnly = Rows(admin.UserId, NotificationType.Approval).Single();
        Assert.True(bellOnly.InApp);
        Assert.False(bellOnly.EmailPending);
        Assert.False(bellOnly.Browser);
        Assert.False(bellOnly.PushPending);
        Assert.True(AnnouncedTo(admin.UserId, bellOnly.Id));

        // Everything off: no row at all, nothing announced.
        Assert.True((await admin.Put("/api/v1/me/notification-preferences", new { items = new[] { new { type = "Approval", inApp = false, email = false, browser = false } } })).Ok);
        await AskAsync(member, admin.UserId, "Archive the 2024 projects");
        Assert.Single(Rows(admin.UserId, NotificationType.Approval));

        // Do not disturb (the requester, for the decision): the bell still fills, no pop-up, and e-mail waits until it ends.
        Assert.True((await admin.Put("/api/v1/me/notification-preferences", new { items = new[] { new { type = "Approval", inApp = true, email = true, browser = true } } })).Ok);
        var until = DateTime.UtcNow.AddHours(2);
        Assert.True((await member.Send(HttpMethod.Put, "/api/v1/chat/status", new { dndUntil = until })).Ok);
        var id = await AskAsync(member, admin.UserId, "Raise the API rate limit");
        Assert.True((await admin.Post($"/api/v1/approvals/{id}/decide", new { action = "approve" })).Ok);
        var held = Rows(member.UserId, NotificationType.Approval).Single(n => n.Title.StartsWith("Approved:"));
        Assert.True(held.InApp);
        Assert.False(held.Browser);
        Assert.True(held.EmailPending);
        Assert.NotNull(held.DeliverAfter);
        Assert.True(held.DeliverAfter >= until.AddMinutes(-1));
        Assert.True(AnnouncedTo(member.UserId, held.Id));   // the badge still moves; only the noise waits
    }

    [Fact]
    public async Task Assigning_a_task_reaches_the_assignee_live_and_by_email()
    {
        var (owner, _, member, project) = await TeamAsync("Assign");
        await owner.CreateTaskAsync(project, "Reconcile the October ledger", new { title = "Reconcile the October ledger", assigneeId = member.UserId });
        var row = Assert.Single(Rows(member.UserId, NotificationType.TaskAssigned));
        Assert.True(row.InApp && row.Browser && row.EmailPending);
        Assert.True(AnnouncedTo(member.UserId, row.Id));
        Assert.Empty(Rows(owner.UserId, NotificationType.TaskAssigned));
    }

    [Fact]
    public async Task A_reminder_that_fires_is_in_the_bell_and_announced_live()
    {
        var (_, _, member, _) = await TeamAsync("Remind");
        var kolkata = ZoneTime.Find("Asia/Kolkata");
        var at = DateTime.UtcNow.AddHours(2);
        var made = await member.Post("/api/v1/reminders", new { title = "Call the auditor", when = new { at = ZoneTime.Write(ZoneTime.ToLocal(at, kolkata)), timeZone = "Asia/Kolkata" } });
        Assert.True(made.Ok, made.ToString());
        using (var scope = factory.Services.CreateScope()) await scope.ServiceProvider.GetRequiredService<ReminderEngine>().RunAsync(at.AddMinutes(2));
        var row = Assert.Single(Rows(member.UserId, NotificationType.Reminder), n => n.Title.Contains("Call the auditor"));
        Assert.True(row.InApp);
        Assert.True(AnnouncedTo(member.UserId, row.Id));
    }

    [Fact]
    public async Task The_shell_summary_matches_each_badge_endpoint_and_stays_inside_the_workspace()
    {
        var (_, admin, member, _) = await TeamAsync("Shell");
        await AskAsync(member, admin.UserId, "Renew the TLS certificate");
        var summary = await admin.Get("/api/v1/shell/summary");
        Assert.True(summary.Ok, summary.ToString());
        var d = summary.Data!;
        Assert.Equal(admin.WorkspaceId.ToString(), S(d["workspaceId"]));
        var counts = (await admin.Get("/api/v1/notifications/counts")).Data!;
        Assert.Equal(counts["unread"]!.GetValue<int>(), d["notifications"]!["unread"]!.GetValue<int>());
        Assert.Equal(1, d["approvals"]!["needsMe"]!.GetValue<int>());
        Assert.Equal((await admin.Get("/api/v1/chat/unread")).Data!.ToJsonString(), d["chatUnread"]!.ToJsonString());
        Assert.Equal((await admin.Get("/api/v1/reminders/counts")).Data!.ToJsonString(), d["reminders"]!.ToJsonString());

        // Someone in another workspace sees only their own numbers.
        var (_, otherAdmin, _, _) = await TeamAsync("Elsewhere");
        var theirs = (await otherAdmin.Get("/api/v1/shell/summary")).Data!;
        Assert.Equal(otherAdmin.WorkspaceId.ToString(), S(theirs["workspaceId"]));
        Assert.Equal(0, theirs["approvals"]!["needsMe"]!.GetValue<int>());
    }
}
