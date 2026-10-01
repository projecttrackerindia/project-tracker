using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Compliance;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Application.Features.Reports;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Slack / Teams messages and audit streaming, the calendar feed, email to work task, Git linking, retention and the workspace export.</summary>
[Collection("api")]
public class IntegrationTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static string Iso(int days) => DateOnly.FromDateTime(DateTime.UtcNow).AddDays(days).ToString("yyyy-MM-dd");

    private sealed record Org(TestClient Owner, TestClient Dev, Guid Project, string Key);

    private async Task<Org> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Manager, "Dev Developer");
        var project = await owner.CreateProjectAsync("Atlas");
        var key = S((await owner.Get($"/api/v1/projects/{project}")).Data!["project"]!["key"]);
        return new Org(owner, dev, project, key);
    }

    private Task RunWebhooks() => factory.Services.GetRequiredService<WebhookProcessor>().RunAsync();

    // ------------------------------------------------------------------ Slack, Teams, audit stream

    [Fact]
    public async Task Webhooks_can_post_Slack_and_Teams_messages_and_stream_the_audit_log()
    {
        var o = await Setup();
        var slack = $"http://hooks.slack.test/{Guid.NewGuid():N}";
        var teams = $"http://teams.test/{Guid.NewGuid():N}";
        var siem = $"http://siem.test/{Guid.NewGuid():N}";
        var all = $"http://all.test/{Guid.NewGuid():N}";
        Assert.Equal(HttpStatusCode.Created, (await o.Owner.Post("/api/v1/webhooks", new { name = "Slack", url = slack, events = new[] { "task.*" }, format = "Slack" })).Status);
        Assert.Equal(HttpStatusCode.Created, (await o.Owner.Post("/api/v1/webhooks", new { name = "Teams", url = teams, events = new[] { "task.created" }, format = "Teams" })).Status);
        Assert.Equal(HttpStatusCode.Created, (await o.Owner.Post("/api/v1/webhooks", new { name = "SIEM", url = siem, events = new[] { "audit.logged" } })).Status);
        Assert.Equal(HttpStatusCode.Created, (await o.Owner.Post("/api/v1/webhooks", new { name = "All", url = all })).Status);

        var task = await o.Owner.CreateTaskAsync(o.Project, "Ship the release notes");
        Assert.True((await o.Owner.Put("/api/v1/workspace/data-policy", new { activityRetentionDays = 400 })).Ok);   // an audited change
        await RunWebhooks();

        var s = JsonNode.Parse(factory.Webhooks.To(slack).Single().Body)!;
        Assert.Contains("Ship the release notes", S(s["text"]));
        Assert.Equal("section", S(s["blocks"]![0]!["type"]));
        Assert.Contains($"/projects/{o.Project}?task={S(task["id"])}", S(s["blocks"]![2]!["elements"]![0]!["url"]));

        var t = JsonNode.Parse(factory.Webhooks.To(teams).Single().Body)!;
        Assert.Equal("message", S(t["type"]));
        var card = t["attachments"]![0]!["content"]!;
        Assert.Equal("AdaptiveCard", S(card["type"]));
        Assert.Equal("Task created", S(card["body"]![0]!["text"]));

        // The audit stream carries audit records only, and "*" never includes them.
        var audit = factory.Webhooks.To(siem).Select(x => JsonNode.Parse(x.Body)!).ToList();
        Assert.Contains(audit, a => S(a["event"]) == "audit.logged" && S(a["data"]!["action"]) == "data_policy.changed");
        Assert.DoesNotContain(audit, a => S(a["event"]) != "audit.logged");
        Assert.DoesNotContain(factory.Webhooks.To(all), x => x.Headers["X-PM-Event"] == "audit.logged");
        Assert.Contains(factory.Webhooks.To(all), x => x.Headers["X-PM-Event"] == "task.created");
    }

    // ------------------------------------------------------------------ calendar feed

    [Fact]
    public async Task The_calendar_feed_lists_my_dated_work_and_dies_when_reset()
    {
        var o = await Setup();
        await o.Owner.CreateTaskAsync(o.Project, "Board review", new { title = "Board review", priority = "High", assigneeId = o.Dev.UserId, dueDate = Iso(5) });
        await o.Owner.CreateTaskAsync(o.Project, "Not mine", new { title = "Not mine", priority = "Low", assigneeId = o.Owner.UserId, dueDate = Iso(3) });
        Assert.False((await o.Dev.Get("/api/v1/calendar/feed")).Data!["enabled"]!.GetValue<bool>());
        var url = S((await o.Dev.Post("/api/v1/calendar/feed")).Data!["url"]);
        Assert.EndsWith(".ics", url);

        var anon = factory.CreateClient();
        var res = await anon.GetAsync(new Uri(url).PathAndQuery);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("text/calendar", res.Content.Headers.ContentType!.MediaType);
        var ics = await res.Content.ReadAsStringAsync();
        Assert.StartsWith("BEGIN:VCALENDAR", ics);
        Assert.Contains($"SUMMARY:{o.Key}-", ics);
        Assert.Contains("Board review", ics);
        Assert.DoesNotContain("Not mine", ics);
        Assert.Contains($"DTSTART;VALUE=DATE:{Iso(5).Replace("-", "")}", ics);
        Assert.All(ics.Split("\r\n"), line => Assert.True(Encoding.UTF8.GetByteCount(line) <= 75, line));

        // The address can be shown again; a reset kills the old one.
        Assert.Equal(url, S((await o.Dev.Get("/api/v1/calendar/feed")).Data!["url"]));
        var fresh = S((await o.Dev.Post("/api/v1/calendar/feed")).Data!["url"]);
        Assert.NotEqual(url, fresh);
        Assert.Equal(HttpStatusCode.NotFound, (await anon.GetAsync(new Uri(url).PathAndQuery)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await anon.GetAsync("/api/v1/calendar/feed/cal_nothing.ics")).StatusCode);
    }

    // ------------------------------------------------------------------ email to work task

    [Fact]
    public async Task Email_from_a_member_becomes_a_work_task_and_strangers_are_refused()
    {
        var o = await Setup();
        Assert.Equal(HttpStatusCode.Forbidden, (await o.Dev.Put("/api/v1/integrations/inbound-email", new { enabled = true })).Status);
        var box = (await o.Owner.Put("/api/v1/integrations/inbound-email", new { enabled = true, priority = "High" })).Data!;
        var hook = new Uri(S(box["webhookUrl"])).PathAndQuery;
        var anon = factory.CreateClient();

        // Postmark-style JSON from a member.
        var res = await anon.PostAsJsonAsync(hook, new { From = $"Dev Developer <{o.Dev.Email}>", To = "work@inbound.test", Subject = "Re: FW: Printer on floor 3 is jammed", TextBody = "Paper stuck again." });
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var key = (await res.Content.ReadFromJsonAsync<JsonNode>())!["data"]!["workTask"]!.GetValue<string>();
        var created = (await o.Owner.Get("/api/v1/work-tasks?q=Printer")).Data!["items"]![0]!;
        Assert.Equal(key, S(created["key"]));
        Assert.Equal("Printer on floor 3 is jammed", S(created["title"]));
        Assert.Equal("High", S(created["priority"]));
        Assert.Equal(o.Dev.UserId.ToString(), S(created["reporter"]!["id"]));
        Assert.Contains("Raised by email", S(created["description"]));

        // Mailgun-style form post.
        var form = new FormUrlEncodedContent(new Dictionary<string, string> { ["sender"] = o.Owner.Email, ["recipient"] = "work@inbound.test", ["subject"] = "Monthly backup check", ["body-plain"] = "Please verify." });
        Assert.Equal(HttpStatusCode.OK, (await anon.PostAsync(hook, form)).StatusCode);

        // Someone who is not a member, and an unknown mailbox, are refused.
        var stranger = await anon.PostAsJsonAsync(hook, new { from = "attacker@evil.test", subject = "Pay this invoice", text = "..." });
        Assert.Equal(HttpStatusCode.Forbidden, stranger.StatusCode);
        Assert.Contains("not a member", S((await o.Owner.Get("/api/v1/integrations/inbound-email")).Data!["lastError"]));
        Assert.Equal(HttpStatusCode.NotFound, (await anon.PostAsJsonAsync("/api/v1/inbound/email/000000000000000000000000", new { from = o.Dev.Email, subject = "x" })).StatusCode);

        // A new address retires the old one.
        await o.Owner.Post("/api/v1/integrations/inbound-email/reset");
        Assert.Equal(HttpStatusCode.NotFound, (await anon.PostAsJsonAsync(hook, new { from = o.Dev.Email, subject = "Old address" })).StatusCode);
    }

    // ------------------------------------------------------------------ Git

    private static string Sign(string secret, string body) => "sha256=" + Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(body))).ToLowerInvariant();

    [Fact]
    public async Task Commits_link_to_tasks_and_fixes_completes_them()
    {
        var o = await Setup();
        var task = await o.Owner.CreateTaskAsync(o.Project, "Login fails on Safari", new { title = "Login fails on Safari", priority = "High", assigneeId = o.Dev.UserId });
        var number = task["number"]!.GetValue<int>();
        var created = await o.Owner.Post("/api/v1/integrations/git", new { provider = "GitHub", name = "acme/web" });
        Assert.Equal(HttpStatusCode.Created, created.Status);
        var secret = S(created.Data!["secret"]);
        var path = new Uri(S(created.Data!["connection"]!["webhookUrl"])).PathAndQuery;
        var anon = factory.CreateClient();

        async Task<HttpResponseMessage> Push(string message, string? signWith = null, string branch = "main")
        {
            var body = JsonSerializer.Serialize(new
            {
                @ref = $"refs/heads/{branch}", repository = new { full_name = "acme/web", default_branch = "main" },
                commits = new[] { new { id = Convert.ToHexString(RandomNumberGenerator.GetBytes(20)).ToLowerInvariant(), message, url = "https://github.com/acme/web/commit/x",
                    timestamp = DateTime.UtcNow.ToString("o"), author = new { name = "Dev", email = o.Dev.Email, username = "dev" } } },
            });
            var req = new HttpRequestMessage(HttpMethod.Post, path) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
            req.Headers.Add("X-GitHub-Event", "push");
            req.Headers.Add("X-Hub-Signature-256", Sign(signWith ?? secret, body));
            return await anon.SendAsync(req);
        }

        Assert.Equal(HttpStatusCode.Unauthorized, (await Push($"Touches {o.Key}-{number}", signWith: "wrong")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Push($"Refactor the session code ({o.Key}-{number})", branch: "feature/x")).StatusCode);
        var links = (await o.Dev.Get($"/api/v1/tasks/{S(task["id"])}/dev-links")).Data!.AsArray();
        Assert.Single(links);
        Assert.Equal("commit", S(links[0]!["kind"]));
        Assert.NotEqual("Done", S((await o.Owner.Get($"/api/v1/tasks/{S(task["id"])}")).Data!["task"]!["statusCategory"]));   // a feature branch only links

        // "Fixes KEY" on the default branch completes it, as the commit's author (a member).
        Assert.Equal(HttpStatusCode.OK, (await Push($"Fixes {o.Key}-{number}: handle Safari cookies")).StatusCode);
        Assert.Equal(2, (await o.Dev.Get($"/api/v1/tasks/{S(task["id"])}/dev-links")).Data!.AsArray().Count);
        Assert.Equal("Done", S((await o.Owner.Get($"/api/v1/tasks/{S(task["id"])}")).Data!["task"]!["statusCategory"]));

        // Azure DevOps: a merged pull request that closes operational work, with basic authentication.
        var types = (await o.Owner.Get("/api/v1/work-types")).Data!.AsArray();
        var work = (await o.Owner.Post("/api/v1/work-tasks", new { title = "Rotate the certificates", workTypeId = S(types[0]!["id"]) })).Data!;
        var ado = await o.Owner.Post("/api/v1/integrations/git", new { provider = "AzureDevOps", name = "acme project" });
        var adoPath = new Uri(S(ado.Data!["connection"]!["webhookUrl"])).PathAndQuery;
        var adoBody = JsonSerializer.Serialize(new
        {
            eventType = "git.pullrequest.merged",
            resource = new { pullRequestId = 42, title = $"Closes {S(work["key"])} new certs", description = "", status = "completed", repository = new { name = "infra", webUrl = "https://dev.azure.com/acme/_git/infra" }, createdBy = new { displayName = "Dev", uniqueName = o.Dev.Email } },
        });
        var adoReq = new HttpRequestMessage(HttpMethod.Post, adoPath) { Content = new StringContent(adoBody, Encoding.UTF8, "application/json") };
        adoReq.Headers.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"hook:{S(ado.Data!["secret"])}")));
        Assert.Equal(HttpStatusCode.OK, (await anon.SendAsync(adoReq)).StatusCode);
        var wlinks = (await o.Owner.Get($"/api/v1/work-tasks/{S(work["id"])}/dev-links")).Data!.AsArray();
        Assert.Equal("pull_request", S(wlinks.Single()!["kind"]));
        Assert.Equal("merged", S(wlinks.Single()!["state"]));
        Assert.Equal("Completed", S((await o.Owner.Get($"/api/v1/work-tasks/{S(work["id"])}")).Data!["status"]));
    }

    // ------------------------------------------------------------------ retention and export

    [Fact]
    public async Task The_data_policy_deletes_old_history_and_the_owner_can_export_everything()
    {
        var o = await Setup();
        Assert.Equal(422, (int)(await o.Owner.Put("/api/v1/workspace/data-policy", new { activityRetentionDays = 5 })).Status);
        Assert.Equal(422, (int)(await o.Owner.Put("/api/v1/workspace/data-policy", new { auditRetentionDays = 30 })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await o.Dev.Get("/api/v1/workspace/data-policy")).Status);
        var saved = (await o.Owner.Put("/api/v1/workspace/data-policy", new { activityRetentionDays = 30, notificationRetentionDays = 30 })).Data!;
        Assert.Equal(30, saved["activityRetentionDays"]!.GetValue<int>());

        await o.Owner.CreateTaskAsync(o.Project, "Old news");
        var tenant = o.Owner.WorkspaceId;
        factory.WithDb(db =>
        {
            foreach (var a in db.Activities.IgnoreQueryFilters().Where(a => a.TenantId == tenant)) a.CreatedAt = DateTime.UtcNow.AddDays(-45);
            return db.SaveChanges();
        });
        using (var scope = factory.Services.CreateScope())
            await DataPolicyService.PurgeAllAsync(scope.ServiceProvider.GetRequiredService<IAppDbContext>(), DateTime.UtcNow, NullLogger.Instance, default);
        Assert.Equal(0, factory.WithDb(db => db.Activities.IgnoreQueryFilters().Count(a => a.TenantId == tenant)));

        // Only the owner may export everything, and only as a zip.
        Assert.Equal(HttpStatusCode.Forbidden, (await o.Dev.Post("/api/v1/reports/exports", new { kind = "WorkspaceExport", format = "Zip" })).Status);
        Assert.Equal(422, (int)(await o.Owner.Post("/api/v1/reports/exports", new { kind = "WorkspaceExport", format = "Csv" })).Status);
        await o.Owner.CreateTaskAsync(o.Project, "Exported task");
        var req = await o.Owner.Post("/api/v1/reports/exports", new { kind = "WorkspaceExport", format = "Zip" });
        Assert.True(req.Ok, req.ToString());
        await factory.Services.GetRequiredService<ReportExportProcessor>().ProcessPendingAsync();
        var id = S(req.Data!["id"]);
        Assert.Equal("Ready", S((await o.Owner.Get($"/api/v1/reports/exports/{id}")).Data!["status"]));
        var file = await o.Owner.Raw($"/api/v1/reports/exports/{id}/file");
        Assert.Equal("application/zip", file.Content.Headers.ContentType!.MediaType);
        using var zip = new ZipArchive(new MemoryStream(await file.Content.ReadAsByteArrayAsync()));
        var names = zip.Entries.Select(e => e.FullName).ToList();
        foreach (var n in new[] { "README.txt", "workspace.json", "members.json", "projects.json", "tasks.json", "time-entries.json", "audit-log.json", "attachments.json" }) Assert.Contains(n, names);
        string Read(string n) { using var r = new StreamReader(zip.GetEntry(n)!.Open()); return r.ReadToEnd(); }
        Assert.Contains("Exported task", Read("tasks.json"));
        Assert.Contains(o.Dev.Email, Read("members.json"));
        foreach (var e in zip.Entries.Where(e => e.FullName.EndsWith(".json")))
        {
            var text = Read(e.FullName);
            Assert.DoesNotContain("passwordHash", text, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("secretProtected", text, StringComparison.OrdinalIgnoreCase);
        }
    }
}
