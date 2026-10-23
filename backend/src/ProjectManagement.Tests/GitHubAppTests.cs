using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The ProjectTracker GitHub App: install checked against who installed it, a branch from a task, status following the code, checks,
/// reviews and risk on the task, the review queue and its nudges, release notes, delivery metrics and a revert reopening the work.
/// </summary>
[Collection("api")]
public class GitHubAppTests(ApiFactory factory)
{
    private const string Secret = "github-app-webhook-secret-for-tests";
    private GitHubAppOptions O => factory.Services.GetRequiredService<IOptions<GitHubAppOptions>>().Value;
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private void Configure()
    {
        using var rsa = RSA.Create(2048);
        O.AppId = "123456"; O.Slug = "projecttracker-test"; O.PrivateKey = rsa.ExportRSAPrivateKeyPem(); O.WebhookSecret = Secret; O.ClientId = "Iv1.test"; O.ClientSecret = "client-secret";
        O.ApiBaseUrl = "https://api.github.test"; O.WebBaseUrl = "https://github.test";
    }
    private static async Task<string> StatusOf(TestClient c, Guid taskId) => S((await c.Get($"/api/v1/tasks/{taskId}")).Data!["task"]!["statusName"]);
    private void Reset() { O.AppId = null; O.Slug = null; O.PrivateKey = null; O.WebhookSecret = null; O.ClientId = null; O.ClientSecret = null; factory.GitHub.Routes.Clear(); }

    private async Task<HttpResponseMessage> Hook(string evt, object payload, string secret = Secret)
    {
        var body = JsonSerializer.Serialize(payload);
        using var client = factory.CreateClient();
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/integrations/github-app/webhook") { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        req.Headers.Add("X-GitHub-Event", evt);
        req.Headers.Add("X-Hub-Signature-256", "sha256=" + Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(body))).ToLowerInvariant());
        return await client.SendAsync(req);
    }

    private static object Pr(long installation, int number, string title, string body, string action, bool merged = false, string? mergedAt = null, long[]? reviewers = null, string sha = "abc123") => new
    {
        action, installation = new { id = installation },
        repository = new { full_name = "acme/payments", html_url = "https://github.test/acme/payments" },
        pull_request = new
        {
            number, title, body, state = merged ? "closed" : "open", merged, merged_at = mergedAt, draft = false,
            html_url = $"https://github.test/acme/payments/pull/{number}", created_at = DateTime.UtcNow.AddHours(-3).ToString("o"), updated_at = DateTime.UtcNow.ToString("o"),
            head = new { @ref = "feature", sha }, user = new { login = "ravi", id = 9001 },
            requested_reviewers = (reviewers ?? []).Select(r => new { login = $"user{r}", id = r }).ToArray(),
            additions = 1200, deletions = 30, changed_files = 1,
        },
    };

    [Fact]
    public async Task Install_branch_status_risk_reviews_release_notes_and_metrics()
    {
        Configure();
        try
        {
            var owner = await TestClient.RegisterAsync(factory, "Git Owner");
            await owner.CreateOrgAsync();
            await owner.UpgradeAsync("BUSINESS");
            var installation = Random.Shared.NextInt64(10_000_000, 99_999_999);
            var gh = factory.GitHub.Routes;
            gh[$"POST /app/installations/{installation}/access_tokens"] = """{"token":"ghs_test","expires_at":"2099-01-01T00:00:00Z"}""";
            gh[$"GET /app/installations/{installation}"] = """{"account":{"login":"acme","type":"Organization"},"repository_selection":"selected"}""";
            gh["GET /installation/repositories"] = """{"repositories":[{"full_name":"acme/payments"},{"full_name":"acme/web"}]}""";
            gh["POST /login/oauth/access_token"] = """{"access_token":"gho_user"}""";
            gh["GET /user/installations"] = "{\"installations\":[{\"id\":" + installation + "}]}";

            // Install: the state seals this workspace and person; the code proves the installer can reach the installation.
            var start = await owner.Post("/api/v1/integrations/github-app/install");
            Assert.True(start.Ok, start.ToString());
            var url = S(start.Data!["url"]);
            Assert.StartsWith("https://github.test/apps/projecttracker-test/installations/new?state=", url);
            var state = Uri.UnescapeDataString(url[(url.IndexOf("state=", StringComparison.Ordinal) + 6)..]);
            Assert.Equal(HttpStatusCode.Forbidden, (await owner.Post("/api/v1/integrations/github-app/complete", new { installationId = installation + 1, setupAction = "install", code = "c", state })).Status);
            Assert.Equal(422, (int)(await owner.Post("/api/v1/integrations/github-app/complete", new { installationId = installation, setupAction = "install", code = "c", state = "forged" })).Status);
            var done = await owner.Post("/api/v1/integrations/github-app/complete", new { installationId = installation, setupAction = "install", code = "c", state });
            Assert.True(done.Ok, done.ToString());
            Assert.Equal("acme", S(done.Data!["account"]));
            Assert.Contains("acme/payments", done.Data["repositories"]!.AsArray().Select(r => S(r)));
            Assert.True((await owner.Put("/api/v1/integrations/github-app", new { riskyPaths = new[] { "src/payments" } })).Ok);

            var project = await owner.CreateProjectAsync("Refunds");
            var task = await owner.CreateTaskAsync(project, "Fix refund rounding");
            var taskId = Guid.Parse(S(task["id"])); var taskKey = S(task["key"]);

            // A branch from the task, named with its key.
            gh["GET /repos/acme/payments"] = """{"default_branch":"main"}""";
            gh["GET /repos/acme/payments/git/ref/heads/main"] = """{"object":{"sha":"base0001"}}""";
            gh["POST /repos/acme/payments/git/refs"] = """{"ref":"refs/heads/x"}""";
            var branch = await owner.Post($"/api/v1/tasks/{taskId}/github-branch", new { repository = "acme/payments" });
            Assert.True(branch.Ok, branch.ToString());
            Assert.Equal($"{taskKey}-fix-refund-rounding", S(branch.Data!["name"]));
            Assert.Contains(factory.GitHub.Calls, c => c.Method == "POST" && c.Path == "/repos/acme/payments/git/refs" && c.Body!.Contains($"refs/heads/{taskKey}-fix-refund-rounding") && c.Body.Contains("base0001"));
            Assert.Equal(422, (int)(await owner.Post($"/api/v1/tasks/{taskId}/github-branch", new { repository = "someone/else" })).Status);

            // A pull request opens: linked, moved to review, scored for risk with its reasons.
            gh["GET /repos/acme/payments/pulls/42/files"] = """[{"filename":"src/payments/refund.cs","additions":1200,"deletions":30}]""";
            Assert.Equal(HttpStatusCode.Unauthorized, (await Hook("pull_request", Pr(installation, 42, $"{taskKey} Fix refund rounding", "", "opened", reviewers: [9002]), "wrong-secret")).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await Hook("pull_request", Pr(installation, 42, $"{taskKey} Fix refund rounding", "", "opened", reviewers: [9002]))).StatusCode);
            Assert.Equal("Review", await StatusOf(owner, taskId));
            var links = (await owner.Get($"/api/v1/tasks/{taskId}/dev-links")).Data!.AsArray();
            var pr = links.First(l => S(l!["kind"]) == "pull_request")!;
            Assert.True(pr["riskScore"]!.GetValue<int>() >= 75);
            var reasons = pr["riskReasons"]!.AsArray().Select(r => S(r)).ToList();
            Assert.Contains(reasons, r => r.Contains("lines changed"));
            Assert.Contains("Code changed with no test changed", reasons);
            Assert.Contains(reasons, r => r.StartsWith("First change to src/payments"));
            Assert.Contains(links, l => S(l!["kind"]) == "branch");

            // The review queue: the requested reviewer (GitHub account connected) sees it waiting.
            factory.WithDb(db => { db.UserLogins.Add(new UserLogin { UserId = owner.UserId, Provider = "github", Subject = "9002", CreatedAt = DateTime.UtcNow }); return db.SaveChanges(); });
            var queue = (await owner.Get("/api/v1/me/review-queue")).Data!;
            Assert.Equal(1, queue["waitingOnMe"]!.GetValue<int>());
            Assert.Equal(taskKey, S(queue["items"]![0]!["taskKey"]));

            // Two days later with no review: a nudge.
            factory.WithDb(db => db.DevLinks.IgnoreQueryFilters().Where(l => l.ExternalId == "42" && l.Repository == "acme/payments").ExecuteUpdate(u => u.SetProperty(l => l.ReviewRequestedAt, DateTime.UtcNow.AddDays(-3))));
            using (var scope = factory.Services.CreateScope()) Assert.True(await scope.ServiceProvider.GetRequiredService<ReminderEngine>().ReviewNudgesAsync(DateTime.UtcNow) >= 1);
            Assert.Contains((await owner.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), n => S(n!["title"]).Contains("acme/payments#42 waits on your review"));

            // Checks pass, the review approves, the merge completes the task ("Fixes"), and production gets it.
            Assert.Equal(HttpStatusCode.OK, (await Hook("check_suite", new { action = "completed", installation = new { id = installation }, check_suite = new { head_sha = "abc123", status = "completed", conclusion = "success" } })).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await Hook("pull_request_review", new { action = "submitted", installation = new { id = installation }, repository = new { full_name = "acme/payments" },
                review = new { state = "APPROVED", user = new { id = 9002 } }, pull_request = new { number = 42 } })).StatusCode);
            pr = (await owner.Get($"/api/v1/tasks/{taskId}/dev-links")).Data!.AsArray().First(l => S(l!["kind"]) == "pull_request")!;
            Assert.Equal("success", S(pr["checksState"]));
            Assert.Equal("approved", S(pr["reviewState"]));
            gh["GET /repos/acme/payments/pulls/42/commits"] = new JsonArray(new JsonObject { ["commit"] = new JsonObject { ["author"] = new JsonObject { ["date"] = DateTime.UtcNow.AddHours(-30).ToString("o") } } }).ToJsonString();
            Assert.Equal(HttpStatusCode.OK, (await Hook("pull_request", Pr(installation, 42, $"{taskKey} Fix refund rounding", $"Fixes {taskKey}", "closed", merged: true, mergedAt: DateTime.UtcNow.AddHours(-2).ToString("o")))).StatusCode);
            Assert.Equal("Done", await StatusOf(owner, taskId));
            Assert.Equal(HttpStatusCode.OK, (await Hook("deployment_status", new { action = "created", installation = new { id = installation }, repository = new { full_name = "acme/payments" },
                deployment = new { id = 555001, environment = "production", sha = "merge001", created_at = DateTime.UtcNow.AddHours(-1).ToString("o") },
                deployment_status = new { state = "success", updated_at = DateTime.UtcNow.ToString("o") } })).StatusCode);
            var metrics = (await owner.Get($"/api/v1/integrations/github-app/delivery?projectId={project}")).Data!;
            Assert.True(metrics["leadTimeHours"]!.GetValue<decimal>() >= 29);
            Assert.Equal("first commit to production", S(metrics["leadTimeBasis"]));
            Assert.True(metrics["deploysPerWeek"]!.GetValue<decimal>() > 0);

            // Release notes from merged pull requests, and as a draft page.
            var notes = (await owner.Get($"/api/v1/projects/{project}/release-notes")).Data!;
            Assert.Equal(taskKey, S(notes["tasks"]![0]!["key"]));
            Assert.Contains("acme/payments#42", S(notes["markdown"]));
            var page = await owner.Post($"/api/v1/projects/{project}/release-notes/page");
            Assert.True(page.Ok, page.ToString());

            // A merged revert reopens the work.
            gh["GET /repos/acme/payments/pulls/43/files"] = """[{"filename":"src/payments/refund.cs","additions":30,"deletions":1200},{"filename":"tests/refund.test.cs","additions":0,"deletions":10}]""";
            gh["GET /repos/acme/payments/pulls/43/commits"] = "[]";
            Assert.Equal(HttpStatusCode.OK, (await Hook("pull_request", Pr(installation, 43, $"Revert \"{taskKey} Fix refund rounding\"", "Reverts acme/payments#42", "closed", merged: true, mergedAt: DateTime.UtcNow.ToString("o"), sha: "rev0001"))).StatusCode);
            Assert.Equal("In Progress", await StatusOf(owner, taskId));

            // Disconnect: later events from that installation are ignored.
            Assert.Equal(HttpStatusCode.NoContent, (await owner.Delete("/api/v1/integrations/github-app")).Status);
            Assert.False((await owner.Get("/api/v1/integrations/github-app")).Data!["installed"]!.GetValue<bool>());
        }
        finally { Reset(); }
    }

    [Fact]
    public void Branch_names_carry_the_task_key_and_a_short_slug()
    {
        Assert.Equal("PAY-12-fix-portal-login", GitHubAppService.BranchName("PAY-12", "Fix portal login!"));
        Assert.Equal("PAY-12", GitHubAppService.BranchName("PAY-12", "!!!"));
        Assert.True(GitHubAppService.BranchName("PAY-12", new string('a', 200)).Length <= 47);
        Assert.True(GitHubAppService.IsProduction("Production"));
        Assert.False(GitHubAppService.IsProduction("staging"));
    }
}
