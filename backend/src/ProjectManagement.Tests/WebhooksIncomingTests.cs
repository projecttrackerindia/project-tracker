using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Webhooks release 2: incoming addresses that raise tickets and tasks (repeats merged, "resolved" closes), outgoing filters, the event
/// explorer, replay of one or many deliveries, the full history, health and the warning before the automatic switch-off, and the new events.
/// </summary>
[Collection("api")]
public class WebhooksIncomingTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private string NewUrl() => $"http://receiver.test/{Guid.NewGuid():N}";
    private Task RunAsync() => factory.Services.GetRequiredService<WebhookProcessor>().RunAsync();

    private async Task<TestClient> Owner()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        await c.UpgradeAsync("BUSINESS");
        return c;
    }

    private async Task<HttpResponseMessage> PostIn(string url, string body, string contentType = "application/json", string? secret = null)
    {
        using var client = factory.CreateClient();
        var path = new Uri(url).AbsolutePath;
        using var req = new HttpRequestMessage(HttpMethod.Post, path) { Content = new StringContent(body, Encoding.UTF8, contentType) };
        if (secret is not null) req.Headers.Add("X-Webhook-Secret", secret);
        return await client.SendAsync(req);
    }

    private static async Task<JsonNode> Json(HttpResponseMessage r) => JsonNode.Parse(await r.Content.ReadAsStringAsync())!;

    // ------------------------------------------------------------------ incoming

    [Fact]
    public async Task An_alert_becomes_one_ticket_repeats_are_merged_and_resolved_closes_it()
    {
        var c = await Owner();
        var created = await c.Post("/api/v1/incoming-webhooks", new
        {
            name = "Grafana alerts", target = "ticket", defaultPriority = "Medium", mergeMinutes = 60, requireSecret = true,
            mapping = new
            {
                title = "{{alerts.0.labels.alertname}} on {{alerts.0.labels.instance}}", description = "{{alerts.0.annotations.summary}}",
                priority = "{{alerts.0.labels.severity}}", priorityMap = new Dictionary<string, string> { ["page"] = "Critical" },
                dedupeKey = "{{alerts.0.fingerprint}}", resolveWhen = "{{status}}", resolveValues = "resolved",
            },
        });
        Assert.Equal(HttpStatusCode.Created, created.Status);
        var url = S(created.Data!["hook"]!["url"]); var secret = S(created.Data["secret"]); var id = S(created.Data["hook"]!["id"]);
        Assert.Contains("/api/v1/hooks/in/", url);
        Assert.True(created.Data["hook"]!["requiresSecret"]!.GetValue<bool>());

        string Alert(string status) => "{\"status\":\"" + status + "\"," + """ "alerts":[{"fingerprint":"ab12","labels":{"alertname":"CoreBankingEOD","instance":"cbs-01","severity":"page"},"annotations":{"summary":"EOD batch failed at step 4"}}]}""";

        Assert.Equal(HttpStatusCode.Unauthorized, (await PostIn(url, Alert("firing"))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await PostIn(url, Alert("firing"), secret: "whsec_wrong")).StatusCode);
        var first = await PostIn(url, Alert("firing"), secret: secret);
        Assert.Equal(HttpStatusCode.Accepted, first.StatusCode);
        var receipt = await Json(first);
        Assert.Equal("created", S(receipt["data"]!["status"]));
        var key = S(receipt["data"]!["key"]);
        Assert.StartsWith("WT-", key);

        var tickets = (await c.Get("/api/v1/work-tasks?q=CoreBankingEOD")).Data!["items"]!.AsArray();
        var ticket = Assert.Single(tickets)!;
        Assert.Equal("CoreBankingEOD on cbs-01", S(ticket["title"]));
        Assert.Equal("Critical", S(ticket["priority"]));

        // Two repeats: merged into the same ticket with a count, a comment on the second.
        for (var i = 0; i < 2; i++) Assert.Equal("merged", S((await Json(await PostIn(url, Alert("firing"), secret: secret)))["data"]!["status"]));
        Assert.Single((await c.Get("/api/v1/work-tasks?q=CoreBankingEOD")).Data!["items"]!.AsArray());
        var events = (await c.Get($"/api/v1/incoming-webhooks/{id}/events")).Data!;
        Assert.Equal(5, events["total"]!.GetValue<int>());   // two refused, one created, two merged
        Assert.Equal(3, events["items"]![0]!["count"]!.GetValue<int>());
        Assert.Contains(events["items"]!.AsArray(), e => S(e!["status"]) == "rejected");
        var comments = (await c.Get($"/api/v1/work-tasks/{ticket["id"]}/comments")).Data!.AsArray();
        Assert.Contains(comments, x => S(x!["body"]).Contains("Seen again: 2 times"));

        // Resolved closes it; the next firing raises a new ticket.
        Assert.Equal("resolved", S((await Json(await PostIn(url, Alert("resolved"), secret: secret)))["data"]!["status"]));
        Assert.Equal("Completed", S((await c.Get($"/api/v1/work-tasks/{ticket["id"]}")).Data!["status"]));
        var again = await Json(await PostIn(url, Alert("firing"), secret: secret));
        Assert.Equal("created", S(again["data"]!["status"]));
        Assert.NotEqual(key, S(again["data"]!["key"]));

        // The last request is kept for mapping by example; the list shows the counts.
        Assert.Contains("CoreBankingEOD", S((await c.Get($"/api/v1/incoming-webhooks/{id}/sample")).Data!["sample"]));
        var hook = (await c.Get("/api/v1/incoming-webhooks")).Data!.AsArray().Single(h => S(h!["id"]) == id)!;
        Assert.Equal(2, hook["createdCount"]!.GetValue<int>());
        Assert.Equal(2, hook["mergedCount"]!.GetValue<int>());

        // A new address: the old one stops working.
        var rotated = (await c.Post($"/api/v1/incoming-webhooks/{id}/rotate")).Data!;
        Assert.Equal(HttpStatusCode.NotFound, (await PostIn(url, Alert("firing"), secret: secret)).StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, (await PostIn(S(rotated["hook"]!["url"]), Alert("firing"), secret: S(rotated["secret"]))).StatusCode);
    }

    [Fact]
    public async Task Forms_and_text_raise_project_tasks_and_a_switched_off_address_ignores_them()
    {
        var c = await Owner();
        var project = await c.CreateProjectAsync("Website");
        var created = (await c.Post("/api/v1/incoming-webhooks", new { name = "Contact form", target = "task", projectId = project,
            mapping = new { title = "Website enquiry from {{name}}", description = "{{message}}", dedupeKey = "{{email}}" } })).Data!;
        var url = S(created["hook"]!["url"]); var id = S(created["hook"]!["id"]);
        Assert.Null(created["secret"]);
        var r = await Json(await PostIn(url, "name=Kavya+Rao&email=kavya%40example.com&message=Need+a+quote", "application/x-www-form-urlencoded"));
        Assert.Equal("created", S(r["data"]!["status"]));
        Assert.Contains("-", S(r["data"]!["key"]));
        var tasks = (await c.Get($"/api/v1/projects/{project}/tasks")).Data!["items"]!.AsArray();
        Assert.Contains(tasks, t => S(t!["title"]) == "Website enquiry from Kavya Rao");

        Assert.True((await c.Put($"/api/v1/incoming-webhooks/{id}", new { isActive = false })).Ok);
        Assert.Equal("ignored", S((await Json(await PostIn(url, "plain words, no form", "text/plain")))["data"]!["status"]));
        Assert.Equal(HttpStatusCode.NotFound, (await PostIn(url.Replace(url[^6..], "000000"), "{}")).StatusCode);

        // Mapping by example: a first guess from a request, and what it makes of it.
        var sample = """{"incident":{"title":"Payment API 5xx","severity":"P1","service":"payments","id":"INC-9"},"status":"triggered"}""";
        var guess = (await c.Post("/api/v1/incoming-webhooks/suggest", new { sample })).Data!;
        Assert.Equal("{{incident.title}} on {{incident.service}}", S(guess["title"]));
        Assert.Equal("{{incident.severity}}", S(guess["priority"]));
        var preview = (await c.Post("/api/v1/incoming-webhooks/preview", new { sample, mapping = guess })).Data!;
        Assert.Equal("Payment API 5xx on payments", S(preview["title"]));
        Assert.Equal("Critical", S(preview["priority"]));
        Assert.Contains(preview["fields"]!.AsArray(), f => S(f!["placeholder"]) == "{{incident.id}}");
        Assert.Empty(preview["problems"]!.AsArray());
    }

    [Fact]
    public void Templates_read_paths_arrays_and_priorities()
    {
        var body = IncomingTemplates.Parse("""{"a":{"b":[{"c":"x"},{"c":"y"}]},"n":3}""", "application/json");
        Assert.Equal("y and 3", IncomingTemplates.Render("{{a.b.1.c}} and {{n}}", body));
        Assert.Equal("", IncomingTemplates.Render("{{missing.path}}", body));
        Assert.Equal(Priority.Critical, IncomingTemplates.PriorityOf("P1", null));
        Assert.Equal(Priority.High, IncomingTemplates.PriorityOf("error", null));
        Assert.Equal(Priority.Low, IncomingTemplates.PriorityOf("custom", new() { ["custom"] = "Low" }));
        Assert.Null(IncomingTemplates.PriorityOf("whatever", null));
        Assert.Equal("hello there", S(IncomingTemplates.Parse("hello there", "text/plain")["text"]));
    }

    // ------------------------------------------------------------------ outgoing

    private async Task<(string Id, string Url)> Hook(TestClient c, object body)
    {
        var res = await c.Post("/api/v1/webhooks", body);
        Assert.Equal(HttpStatusCode.Created, res.Status);
        return (S(res.Data!["webhook"]!["id"]), S(res.Data["webhook"]!["url"]));
    }

    [Fact]
    public async Task Filters_send_only_the_chosen_projects_priorities_and_status_changes()
    {
        var c = await Owner();
        var pay = await c.CreateProjectAsync("Payments");
        var web = await c.CreateProjectAsync("Web");
        var url = NewUrl();
        var (id, _) = await Hook(c, new { name = "Only PAY high", url, events = new[] { "task.*" }, filterProjects = new[] { pay }, filterPriorities = new[] { "High" }, filterStatuses = new[] { "Done" } });
        var hook = (await c.Get("/api/v1/webhooks")).Data!.AsArray().Single(h => S(h!["id"]) == id)!;
        Assert.Equal(pay.ToString(), S(hook["filterProjects"]![0]));

        await c.CreateTaskAsync(web, "Other project", new { title = "Other project", priority = "High" });
        await c.CreateTaskAsync(pay, "Low one", new { title = "Low one", priority = "Low" });
        var high = await c.CreateTaskAsync(pay, "High one", new { title = "High one", priority = "High" });
        var statuses = (await c.Get($"/api/v1/projects/{pay}/statuses")).Data!.AsArray();
        string Status(string n) => S(statuses.First(s => S(s!["name"]) == n)!["id"]);
        await c.Send(HttpMethod.Patch, $"/api/v1/tasks/{high["id"]}/move", new { statusId = Status("In Progress") });
        await c.Send(HttpMethod.Patch, $"/api/v1/tasks/{high["id"]}/move", new { statusId = Status("Done") });
        await RunAsync();

        var sent = factory.Webhooks.To(url).Select(s => JsonNode.Parse(s.Body)!).ToList();
        Assert.NotEmpty(sent);
        Assert.All(sent, s => Assert.Equal(S(high["id"]), S(s["data"]!["entity"]!["id"])));
        Assert.Contains(sent, s => S(s["event"]) == "task.created");
        Assert.Single(sent, s => S(s["event"]) == "task.status_changed");
        Assert.Contains(sent, s => S(s["event"]) == "task.status_changed" && S(s["data"]!["newValue"]) == "Done");
    }

    [Fact]
    public async Task Explorer_tests_history_replay_and_health()
    {
        var c = await Owner();
        var url = NewUrl();
        var (id, _) = await Hook(c, new { name = "Receiver", url });

        var catalogue = (await c.Get("/api/v1/webhooks/catalogue")).Data!.AsArray();
        var published = catalogue.Single(e => S(e!["event"]) == "document.published")!;
        Assert.Equal("DocTracker pages", S(published["groupLabel"]));
        Assert.Contains("Published", S(published["sample"]!["summary"]));
        Assert.Contains(catalogue, e => S(e!["event"]) == "whatsapp.rated");
        Assert.Contains(catalogue, e => S(e!["event"]) == "reminder.fired");

        // A test of one event: its sample, marked as a test.
        Assert.Equal(HttpStatusCode.Accepted, (await c.Post($"/api/v1/webhooks/{id}/test", new { @event = "issue.reported" })).Status);
        Assert.Equal(422, (int)(await c.Post($"/api/v1/webhooks/{id}/test", new { @event = "nope.nothing" })).Status);
        for (var i = 0; i < 54; i++) await c.Post($"/api/v1/webhooks/{id}/test");
        await RunAsync(); await RunAsync(); await RunAsync();
        var test = factory.Webhooks.To(url).Select(s => JsonNode.Parse(s.Body)!).Single(s => S(s["event"]) == "issue.reported");
        Assert.True(test["test"]!.GetValue<bool>());

        // The whole history, a page at a time, and one delivery in full.
        var page1 = (await c.Get($"/api/v1/webhooks/{id}/history?page=1&pageSize=50")).Data!;
        Assert.Equal(55, page1["total"]!.GetValue<int>());
        Assert.Equal(50, page1["items"]!.AsArray().Count);
        Assert.Equal(5, (await c.Get($"/api/v1/webhooks/{id}/history?page=2&pageSize=50")).Data!["items"]!.AsArray().Count);
        Assert.Equal(1, (await c.Get($"/api/v1/webhooks/{id}/history?event=issue.reported")).Data!["total"]!.GetValue<int>());
        var one = S(page1["items"]![0]!["id"]);
        var detail = (await c.Get($"/api/v1/webhooks/{id}/deliveries/{one}")).Data!;
        Assert.Contains("\"event\"", S(detail["payload"]));
        Assert.NotNull(detail["delivery"]!["durationMs"]);

        // Replay one, then every failed one in a window.
        var replay = (await c.Post($"/api/v1/webhooks/{id}/deliveries/{one}/replay")).Data!;
        Assert.Equal(one, S(replay["replayOf"]));
        factory.WithDb(db => db.WebhookDeliveries.IgnoreQueryFilters().Where(d => d.WebhookId == Guid.Parse(id) && d.EventType == "ping")
            .OrderBy(d => d.CreatedAt).Take(3).ExecuteUpdate(u => u.SetProperty(d => d.Status, WebhookDeliveryStatus.Failed)));
        var bulk = (await c.Post($"/api/v1/webhooks/{id}/replay", new { from = DateTime.UtcNow.AddHours(-1), to = DateTime.UtcNow.AddMinutes(1), onlyFailed = true })).Data!;
        Assert.Equal(3, bulk["queued"]!.GetValue<int>());
        Assert.Equal(0, (await c.Post($"/api/v1/webhooks/{id}/replay", new { from = DateTime.UtcNow.AddHours(-1), to = DateTime.UtcNow.AddMinutes(1), onlyFailed = true })).Data!["queued"]!.GetValue<int>());
        await RunAsync();

        var health = (await c.Get($"/api/v1/webhooks/{id}/health?days=7")).Data!;
        Assert.Equal(7, health["series"]!.AsArray().Count);
        Assert.True(health["total"]!.GetValue<int>() >= 55);
        Assert.NotNull(health["averageMs"]);
        Assert.Equal(10, health["disableAfter"]!.GetValue<int>());
        Assert.NotNull((await c.Get("/api/v1/webhooks")).Data![0]!["health"]!["successRate"]);
    }

    [Fact]
    public async Task The_owner_is_warned_half_way_to_the_automatic_switch_off()
    {
        var c = await Owner();
        var url = NewUrl();
        var (id, _) = await Hook(c, new { name = "Flaky", url });
        factory.Webhooks.Status = u => u == url ? 500 : 200;
        try
        {
            await c.Post($"/api/v1/webhooks/{id}/test", new { @event = "task.created" });
            factory.WithDb(db =>
            {
                db.Webhooks.IgnoreQueryFilters().Where(w => w.Id == Guid.Parse(id)).ExecuteUpdate(u => u.SetProperty(w => w.ConsecutiveFailures, WebhookProcessor.WarnAfterFailures - 1));
                return db.WebhookDeliveries.IgnoreQueryFilters().Where(d => d.WebhookId == Guid.Parse(id)).ExecuteUpdate(u => u.SetProperty(d => d.Attempts, WebhookProcessor.MaxAttempts - 1));
            });
            await RunAsync();
            var health = (await c.Get($"/api/v1/webhooks/{id}/health")).Data!;
            Assert.True(health["warned"]!.GetValue<bool>());
            Assert.Equal(WebhookProcessor.WarnAfterFailures, health["consecutiveFailures"]!.GetValue<int>());
            Assert.Contains((await c.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), n => S(n!["title"]) == "Webhook “Flaky” keeps failing");
        }
        finally { factory.Webhooks.Status = _ => 200; }
    }

    [Fact]
    public async Task Reminders_about_work_are_events_and_private_notes_are_not()
    {
        var c = await Owner();
        var url = NewUrl();
        await Hook(c, new { name = "Reminders", url, events = new[] { "reminder.*" } });
        var project = await c.CreateProjectAsync("Atlas");
        var task = await c.CreateTaskAsync(project, "Send the estimate");
        var about = (await c.Post("/api/v1/reminders", new { title = "Estimate", targetType = "Task", targetId = task["id"], when = new { at = "2030-01-01T09:00", timeZone = "UTC" } })).Data!;
        var note = (await c.Post("/api/v1/reminders", new { title = "Call the bank", when = new { at = "2030-01-01T09:00", timeZone = "UTC" } })).Data!;
        Assert.True((await c.Post($"/api/v1/reminders/{about["id"]}/done")).Ok);
        Assert.True((await c.Post($"/api/v1/reminders/{note["id"]}/done")).Ok);
        await RunAsync();
        var sent = factory.Webhooks.To(url).Select(s => JsonNode.Parse(s.Body)!).ToList();
        var done = Assert.Single(sent);
        Assert.Equal("reminder.completed", S(done["event"]));
        Assert.Equal("Estimate", S(done["data"]!["title"]));
        Assert.Equal(S(task["key"]), S(done["data"]!["target"]!["key"]));
    }

    [Fact]
    public void Secrets_and_personal_data_are_never_sent()
    {
        Assert.False(WebhookEvents.Matches("*", "document.secret_revealed"));
        Assert.False(WebhookEvents.Matches("document.*", "document.pii_revealed"));
        Assert.True(WebhookEvents.Matches("document.*", "document.published"));
        Assert.True(WebhookFilters.StatusMatches("Done", "Completed"));
        Assert.False(WebhookFilters.StatusMatches("Done", "In Progress"));
    }
}
