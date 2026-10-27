using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Releases (/api/v1/releases): items, runs and the go/no-go (work done, no open bugs, tests ready), approving against a "no go" only with a
/// reason, shipping. And a project's status set by hand (/projects/{id}/health): shown instead of the calculated one, with why, and cleared.
/// </summary>
[Collection("api")]
public class ReleasesAndHealthTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static bool B(JsonNode? n) => n!.GetValue<bool>();

    [Fact]
    public async Task A_release_is_go_only_when_its_work_is_done_bugs_closed_and_tests_ready()
    {
        var owner = await TestClient.RegisterAsync(factory, "Rhea Release");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var project = await owner.CreateProjectAsync("Payments Platform");
        var task = S((await owner.CreateTaskAsync(project, "Bulk payout API"))["id"]);

        var created = await owner.Post("/api/v1/releases", new { name = "v2.4", projectId = project, targetDate = DateTime.UtcNow.AddDays(10).ToString("yyyy-MM-dd") });
        Assert.True(created.Status == HttpStatusCode.Created, created.ToString());
        var id = S(created.Data!["id"]);
        Assert.Equal("Planned", S(created.Data["status"]));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post("/api/v1/releases", new { name = " " })).Status);

        var withItem = await owner.Put($"/api/v1/releases/{id}/items", new { add = new[] { task } });
        Assert.True(withItem.Ok, withItem.ToString());
        Assert.False(B(withItem.Data!["go"]));
        Assert.Equal(1, withItem.Data["open"]!.GetValue<int>());
        Assert.Contains("1 of 1 items are still open", withItem.Data.ToJsonString());

        // A passing run tied to the release: the tests check turns green, but open work still says no go.
        var tc = await owner.Post("/api/v1/quality/cases", new { title = "Payout returns 200", priority = "High", projectId = project });
        var run = await owner.Post("/api/v1/quality/runs", new { name = "UAT 2.4", environment = "UAT", projectId = project });
        Assert.True((await owner.Put($"/api/v1/quality/runs/{S(run.Data!["id"])}/results/{S(tc.Data!["id"])}", new { status = "Pass" })).Ok);
        var tied = await owner.Put($"/api/v1/releases/{id}/runs/{S(run.Data["id"])}", new { });
        Assert.True(tied.Ok, tied.ToString());
        Assert.True(tied.Data!["checks"]!.AsArray().First(c => S(c!["key"]) == "tests")!["ok"]!.GetValue<bool>());

        // Approving a "no go" needs a reason, which is kept.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"/api/v1/releases/{id}/approve", new { })).Status);
        Assert.Equal(HttpStatusCode.Conflict, (await owner.Post($"/api/v1/releases/{id}/ship", new { })).Status);
        var approved = await owner.Post($"/api/v1/releases/{id}/approve", new { reason = "The open item is a doc change that can follow." });
        Assert.True(approved.Ok, approved.ToString());
        Assert.Equal("Approved", S(approved.Data!["release"]!["status"]));
        Assert.Contains("doc change", S(approved.Data["release"]!["notes"]));
        var shipped = await owner.Post($"/api/v1/releases/{id}/ship", new { });
        Assert.Equal("Shipped", S(shipped.Data!["release"]!["status"]));
        Assert.Equal(HttpStatusCode.Conflict, (await owner.Put($"/api/v1/releases/{id}/items", new { add = Array.Empty<string>() })).Status);
    }

    [Fact]
    public async Task A_status_set_by_hand_is_shown_with_its_reason_until_cleared()
    {
        var owner = await TestClient.RegisterAsync(factory, "Hari Health");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var project = await owner.CreateProjectAsync("Credit Bureau Connect");

        var before = await owner.Get($"/api/v1/projects/{project}/health");
        Assert.True(before.Ok, before.ToString());
        Assert.Null(before.Data!["override"]);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put($"/api/v1/projects/{project}/health", new { health = "AtRisk" })).Status);   // needs a reason
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put($"/api/v1/projects/{project}/health", new { health = "Green", note = "x" })).Status);
        var set = await owner.Put($"/api/v1/projects/{project}/health", new { health = "AtRisk", note = "Bureau sandbox keys not shared", until = DateTime.UtcNow.AddDays(7).ToString("yyyy-MM-dd") });
        Assert.True(set.Ok, set.ToString());
        Assert.Equal("AtRisk", S(set.Data!["health"]));
        Assert.Equal("Bureau sandbox keys not shared", S(set.Data["note"]));
        Assert.Equal("Hari Health", S(set.Data["setBy"]!["name"]));

        var list = await owner.Get("/api/v1/projects?pageSize=50");
        Assert.Contains("\"AtRisk\"", list.Data!.ToJsonString());   // the list shows the status set by hand

        var cleared = await owner.Put($"/api/v1/projects/{project}/health", new { health = (string?)null });
        Assert.True(cleared.Ok, cleared.ToString());
        Assert.Null(cleared.Data!["override"]);
        Assert.Equal(S(cleared.Data["calculated"]), S(cleared.Data["health"]));
    }

    [Fact]
    public async Task The_weekly_report_is_written_from_the_projects_data()
    {
        var owner = await TestClient.RegisterAsync(factory, "Wren Weekly");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var project = await owner.CreateProjectAsync("Customer App");
        await owner.CreateTaskAsync(project, "Onboarding screens", new { title = "Onboarding screens", dueDate = DateTime.UtcNow.AddDays(3).ToString("yyyy-MM-dd") });
        var r = await owner.Get($"/api/v1/project-status/projects/{project}/weekly");
        Assert.True(r.Ok, r.ToString());
        var text = S(r.Data!["text"]);
        Assert.Contains("Customer App", text);
        Assert.Contains("What moved", text);
        Assert.Contains("Next week", text);
        Assert.Contains("Onboarding screens", text);
        Assert.Equal(1, r.Data["next"]!.GetValue<int>());
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"/api/v1/project-status/projects/{project}/weekly/send", new { text = " " })).Status);
    }

    [Fact]
    public async Task The_weekly_report_page_has_sourced_sections_a_friday_reminder_and_a_history_of_sends()
    {
        var owner = await TestClient.RegisterAsync(factory, "Pia Pager");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var project = await owner.CreateProjectAsync("Payments Hub");
        await owner.CreateTaskAsync(project, "Refund API", new { title = "Refund API", dueDate = DateTime.UtcNow.AddDays(2).ToString("yyyy-MM-dd") });
        var r = await owner.Get($"/api/v1/project-status/projects/{project}/weekly");
        Assert.True(r.Ok, r.ToString());
        Assert.NotNull(r.Data!["sources"]);
        Assert.False(string.IsNullOrWhiteSpace(S(r.Data["verdict"])));
        var next = r.Data["nextItems"]!.AsArray();
        Assert.Single(next);
        Assert.Contains("Refund API", S(next[0]!["text"]));
        Assert.StartsWith($"/projects/{project}?task=", S(next[0]!["link"]));
        Assert.Contains(r.Data["people"]!.AsArray(), p => S(p!["id"]) == owner.UserId.ToString());
        Assert.Empty(r.Data["history"]!.AsArray());
        Assert.Null(r.Data["schedule"]);

        // Every Friday 5 PM: a repeating reminder that opens the report page; asking twice keeps one.
        var s1 = await owner.Post($"/api/v1/project-status/projects/{project}/weekly/schedule", new { timeZone = "Asia/Kolkata" });
        Assert.True(s1.Ok, s1.ToString());
        var s2 = await owner.Post($"/api/v1/project-status/projects/{project}/weekly/schedule", new { timeZone = "Asia/Kolkata" });
        Assert.Equal(S(s1.Data!["reminderId"]), S(s2.Data!["reminderId"]));
        var list = await owner.Get("/api/v1/reminders");
        Assert.Contains(list.Data!["open"]!.AsArray(), x => S(x!["id"]) == S(s1.Data["reminderId"]) && S(x["link"]) == $"/work/projects/{project}/report");
        Assert.NotNull((await owner.Get($"/api/v1/project-status/projects/{project}/weekly")).Data!["schedule"]);

        // Mail only, to a person on the project; then the history strip shows it.
        var sent = await owner.Post($"/api/v1/project-status/projects/{project}/weekly/send", new { text = "**Payments Hub**\n- Refund API", chat = false, mail = true, recipients = new[] { owner.UserId } });
        Assert.True(sent.Ok, sent.ToString());
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"/api/v1/project-status/projects/{project}/weekly/send", new { text = "x", chat = false, mail = true, recipients = new[] { Guid.NewGuid() } })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"/api/v1/project-status/projects/{project}/weekly/send", new { text = "x", chat = false, mail = false })).Status);
        var after = await owner.Get($"/api/v1/project-status/projects/{project}/weekly");
        var hist = after.Data!["history"]!.AsArray();
        Assert.Single(hist);
        Assert.Contains(hist[0]!["channels"]!.AsArray(), c => S(c) == "mail");

        Assert.True((await owner.Delete($"/api/v1/project-status/projects/{project}/weekly/schedule")).Ok);
        Assert.Null((await owner.Get($"/api/v1/project-status/projects/{project}/weekly")).Data!["schedule"]);
    }
}
