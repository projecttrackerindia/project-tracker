using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Plan sheet follow-ups: watching a task (the eye) puts you among the people told about its changes; a change notice carries its effect on the work
/// waiting on it, says whether it was e-mailed and can be undone from the notice (once, while it still stands) or from the e-mail's signed link (only
/// by the person it was sent to); the change e-mail has its own layout. Fictional data only.
/// </summary>
[Collection("api")]
public class PlanSheetFollowUpTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd");
    private static DateOnly Today => DateOnly.FromDateTime(DateTime.UtcNow);
    private static async Task<int> Version(TestClient c, Guid id) => (await c.Get($"/api/v1/work-items/{id}")).Data!["version"]!.GetValue<int>();

    private sealed record Seed(TestClient Lead, TestClient Watcher, Guid Project, Guid Batch, Guid Retry);

    private async Task<Seed> SeedAsync()
    {
        var lead = await TestClient.RegisterAsync(factory, "Tomas Ortega");
        await lead.CreateOrgAsync();
        await lead.UpgradeAsync("BUSINESS");
        var watcher = await lead.AddMemberAsync(factory, TenantRole.Admin, "Lena Park");
        var created = await lead.Post("/api/v1/projects", new { name = "Bureau Link", priority = "Medium", ownerId = lead.UserId, startDate = Iso(Today.AddDays(-5)), dueDate = Iso(Today.AddDays(60)) });
        Assert.True(created.Ok, created.ToString());
        var project = Guid.Parse(S(created.Data!["project"]!["id"]));
        var batch = Guid.Parse(S((await lead.CreateTaskAsync(project, "Bulk enquiry batch job", new { title = "Bulk enquiry batch job", priority = "Medium", startDate = Iso(Today), dueDate = Iso(Today.AddDays(6)) }))["id"]));
        var retry = Guid.Parse(S((await lead.CreateTaskAsync(project, "Retry with back-off", new { title = "Retry with back-off", priority = "Medium", dueDate = Iso(Today.AddDays(12)) }))["id"]));
        Assert.True((await lead.Post($"/api/v1/tasks/{retry}/dependencies", new { dependsOnTaskId = batch })).Ok);
        return new Seed(lead, watcher, project, batch, retry);
    }

    private static async Task<JsonNode> NoticeAsync(TestClient who, Guid task) =>
        (await who.Get("/api/v1/notifications")).Data!["items"]!.AsArray().First(n => n!["link"]?.GetValue<string>()?.Contains(task.ToString()) == true && S(n["type"]) == "TaskUpdated")!;

    [Fact]
    public async Task A_watcher_is_told_with_the_effect_and_can_undo_the_change_once()
    {
        var s = await SeedAsync();
        // Watch, see yourself among the watchers, and the eye can be turned off and on again.
        var w = await s.Watcher.Put($"/api/v1/portfolio/sheet/tasks/{s.Batch}/watch", new { });
        Assert.True(w.Ok, w.ToString());
        Assert.True(w.Data!["watching"]!.GetValue<bool>());
        Assert.Contains(w.Data!["watchers"]!.AsArray(), x => S(x!["name"]) == "Lena Park");
        Assert.False((await s.Watcher.Delete($"/api/v1/portfolio/sheet/tasks/{s.Batch}/watch")).Data!["watching"]!.GetValue<bool>());
        Assert.True((await s.Watcher.Put($"/api/v1/portfolio/sheet/tasks/{s.Batch}/watch", new { })).Data!["watching"]!.GetValue<bool>());
        Assert.True((await s.Lead.Get($"/api/v1/portfolio/sheet/tasks/{s.Batch}/watchers")).Data!["watchers"]!.AsArray().Count == 1);
        Assert.Equal(HttpStatusCode.NotFound, (await s.Watcher.Put($"/api/v1/portfolio/sheet/tasks/{Guid.NewGuid()}/watch", new { })).Status);

        // The lead moves the batch job's due date later: the watcher is told, with what it does to the task waiting on it.
        var res = await s.Lead.Post("/api/v1/portfolio/sheet/bulk", new
        {
            dueDateReason = "Bureau sandbox down",
            changes = new object[] { new { id = s.Batch, version = await Version(s.Lead, s.Batch), dueDate = Iso(Today.AddDays(15)) } },
        });
        var row = res.Data!["rows"]![0]!;
        Assert.True(row["ok"]!.GetValue<bool>(), res.ToString());
        Assert.True(row["told"]!.GetValue<int>() >= 1, res.ToString());
        var retryKey = S((await s.Lead.Get($"/api/v1/work-items/{s.Retry}")).Data!["key"]);
        var note = await NoticeAsync(s.Watcher, s.Batch);
        Assert.StartsWith("Tomas Ortega moved ", S(note["title"]));
        Assert.Contains("Due: ", S(note["body"]));
        Assert.Contains($"Effect: {retryKey} starts later", S(note["body"]));
        Assert.True(note["canUndo"]!.GetValue<bool>(), note.ToJsonString());
        Assert.NotNull(note["emailed"]);

        // Undo from the notice: the due date goes back, once.
        var undo = await s.Watcher.Post("/api/v1/portfolio/sheet/undo", new { notificationId = S(note["id"]) });
        Assert.True(undo.Ok, undo.ToString());
        Assert.Equal(1, undo.Data!["changed"]!.GetValue<int>());
        Assert.Equal(Iso(Today.AddDays(6)), S((await s.Lead.Get($"/api/v1/work-items/{s.Batch}")).Data!["dueDate"]));
        var again = await s.Watcher.Post("/api/v1/portfolio/sheet/undo", new { notificationId = S(note["id"]) });
        Assert.Equal(HttpStatusCode.Conflict, again.Status);

        // A link that was not signed for this person (or was tampered with) does nothing.
        Assert.Equal(HttpStatusCode.NotFound, (await s.Watcher.Post("/api/v1/portfolio/sheet/undo", new { token = "00.11.22.33" })).Status);
        Assert.Equal(422, (int)(await s.Watcher.Post("/api/v1/portfolio/sheet/undo", new { })).Status);
    }

    [Fact]
    public async Task An_undo_link_is_signed_for_one_person_and_expires()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var links = scope.ServiceProvider.GetRequiredService<EmailLinks>();
        Guid change = Guid.NewGuid(), user = Guid.NewGuid();
        var token = links.UndoToken(change, user, DateTime.UtcNow.AddDays(1));
        Assert.True(links.TryReadUndo(token, DateTime.UtcNow, out var c, out var u));
        Assert.Equal(change, c);
        Assert.Equal(user, u);
        Assert.False(links.TryReadUndo(token, DateTime.UtcNow.AddDays(2), out _, out _));
        Assert.False(links.TryReadUndo(token.Replace(user.ToString("N"), Guid.NewGuid().ToString("N")), DateTime.UtcNow, out _, out _));
    }

    [Fact]
    public async Task The_change_email_has_before_after_effect_undo_and_digest()
    {
        var s = await SeedAsync();
        Assert.True((await s.Watcher.Put($"/api/v1/portfolio/sheet/tasks/{s.Batch}/watch", new { })).Ok);
        var res = await s.Lead.Post("/api/v1/portfolio/sheet/bulk", new
        {
            dueDateReason = "Bureau sandbox down",
            changes = new object[] { new { id = s.Batch, version = await Version(s.Lead, s.Batch), dueDate = Iso(Today.AddDays(8)) } },
        });
        Assert.True(res.Data!["rows"]![0]!["ok"]!.GetValue<bool>(), res.ToString());
        var noticeId = Guid.Parse(S((await NoticeAsync(s.Watcher, s.Batch))["id"]));
        // Only this notice waits for e-mail, so it is sent on its own (not folded into a digest).
        factory.WithDb(db =>
        {
            foreach (var n in db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == s.Watcher.UserId)) { n.EmailPending = n.Id == noticeId; n.DeliverAfter = null; n.EmailAttempts = 0; }
            db.SaveChanges(); return 0;
        });
        var sender = new Capture();
        await using var scope = factory.Services.CreateAsyncScope();
        var sp = scope.ServiceProvider;
        var svc = new NotificationEmailService(sp.GetRequiredService<IAppDbContext>(), sender, sp.GetRequiredService<IOptions<AppOptions>>(), sp.GetRequiredService<AppClock>(), NullLogger<NotificationEmailService>.Instance, sp.GetRequiredService<EmailLinks>());
        await svc.SendPendingAsync(500);
        var mail = Assert.Single(sender.Sent, m => m.To == s.Watcher.Email);
        Assert.Contains("Tomas moved a due date", mail.Html);
        Assert.Contains("BUREAU LINK".ToLowerInvariant(), mail.Html.ToLowerInvariant());
        Assert.Contains(">Before<", mail.Html);
        Assert.Contains("+2d", mail.Html);
        Assert.Contains("Effect", mail.Html);
        Assert.Contains("starts later", mail.Html);
        Assert.Contains("Open in ProjectTracker", mail.Html);
        Assert.Contains("Undo change", mail.Html);
        Assert.Contains("undo=", mail.Html);
        Assert.Contains("Switch to digest", mail.Html);
        Assert.Contains("digest=on", mail.Html);
        Assert.Contains("role=\"presentation\"", mail.Html);   // table layout for Outlook and Gmail
    }

    [Fact]
    public void The_change_template_encodes_every_value()
    {
        var html = EmailTemplates.Change(new ChangeEmail("<b>Proj</b>", "javascript:alert(1)", "Ravi <moved> a date", "CB-02 · <script>x</script>", "Tue 28 Oct", "Thu 30 Oct", "+2d",
            [("Effect", "CB-03 & CB-05 start later")], "https://app.example.com/open", null, null, "9:00", null, null, "You get this because you watch it.", "Due moved"));
        Assert.DoesNotContain("<script>x", html);
        Assert.DoesNotContain("javascript:", html);
        Assert.Contains("&lt;b&gt;Proj&lt;/b&gt;", html);
        Assert.Contains("CB-03 &amp; CB-05 start later", html);
        Assert.DoesNotContain("Undo change", html);
        Assert.DoesNotContain("Switch to digest", html);
    }

    private sealed class Capture : IEmailSender
    {
        public List<EmailMessage> Sent { get; } = [];
        public string Name => "capture";
        public Task SendAsync(EmailMessage message, CancellationToken ct = default) { Sent.Add(message); return Task.CompletedTask; }
    }
}
