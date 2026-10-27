using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Quality (/api/v1/quality): test cases, runs, results set cell by cell in the matrix, readiness (pass rate and blockers = failed Critical or
/// High cases) and "File bug", which creates a ticket through the Work API linked to the result.
/// </summary>
[Collection("api")]
public class QualityTests(ApiFactory factory)
{
    private const string Url = "/api/v1/quality";
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static int I(JsonNode? n) => n!.GetValue<int>();

    private async Task<(TestClient Owner, Guid Project)> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Quinn Tester");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var project = await owner.CreateProjectAsync("SIA Internal API");
        return (owner, project);
    }

    private static async Task<string> NewCase(TestClient c, Guid project, string title, string priority)
    {
        var r = await c.Post($"{Url}/cases", new { title, priority, projectId = project, steps = "POST /sia/v1/loan/dispatch\nAssert status", expected = "200 · dispatch_id present" });
        Assert.True(r.Status == HttpStatusCode.Created, r.ToString());
        return S(r.Data!["id"]);
    }

    [Fact]
    public async Task Cases_runs_and_results_make_the_matrix_and_the_readiness()
    {
        var (owner, project) = await Setup();
        var c1 = await NewCase(owner, project, "Loan dispatch API returns 200 for valid PAN", "Critical");
        var c2 = await NewCase(owner, project, "Rejects invalid PAN with 422", "High");
        var c3 = await NewCase(owner, project, "Rate limit returns 429 after 100 rpm", "Low");
        var c4 = await NewCase(owner, project, "Masks Aadhaar in response logs", "Medium");

        var cases = (await owner.Get($"{Url}/cases?projectId={project}")).Data!.AsArray();
        Assert.Equal(4, cases.Count);
        Assert.Equal("TC-101", S(cases[0]!["key"]));
        Assert.Equal("TC-104", S(cases[3]!["key"]));
        Assert.Equal("SIA Internal API", S(cases[0]!["projectName"]));

        // Bad input is refused clearly.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"{Url}/cases", new { title = "" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"{Url}/cases", new { title = "x", priority = "Urgent" })).Status);

        // Editing a case keeps its key.
        var edited = await owner.Put($"{Url}/cases/{c3}", new { priority = "Medium" });
        Assert.True(edited.Ok, edited.ToString());
        Assert.Equal("Medium", S(edited.Data!["priority"]));
        Assert.Equal("TC-103", S(edited.Data["key"]));

        var dev = await owner.Post($"{Url}/runs", new { name = "DEV #212", environment = "DEV", build = "212", projectId = project });
        Assert.True(dev.Status == HttpStatusCode.Created, dev.ToString());
        var uat = await owner.Post($"{Url}/runs", new { name = "UAT 1.4", environment = "UAT", build = "214", projectId = project });
        var uatId = S(uat.Data!["id"]);
        Assert.Equal("Open", S(uat.Data["status"]));

        foreach (var c in new[] { c1, c2, c3, c4 })
            Assert.True((await owner.Put($"{Url}/runs/{S(dev.Data!["id"])}/results/{c}", new { status = "Pass" })).Ok);

        var fail = await owner.Put($"{Url}/runs/{uatId}/results/{c1}", new { status = "Fail", actual = "502 · CRIF token expired", evidence = "HTTP/1.1 502 Bad Gateway" });
        Assert.True(fail.Ok, fail.ToString());
        Assert.Equal("Fail", S(fail.Data!["status"]));
        Assert.Equal("Quinn Tester", S(fail.Data["runBy"]!["name"]));
        Assert.True((await owner.Put($"{Url}/runs/{uatId}/results/{c2}", new { status = "Pass" })).Ok);
        Assert.True((await owner.Put($"{Url}/runs/{uatId}/results/{c3}", new { status = "Blocked" })).Ok);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put($"{Url}/runs/{uatId}/results/{c4}", new { status = "Maybe" })).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Put($"{Url}/runs/{uatId}/results/{Guid.NewGuid()}", new { status = "Pass" })).Status);

        // Setting a result again replaces it (one per case and run).
        Assert.True((await owner.Put($"{Url}/runs/{uatId}/results/{c2}", new { status = "Pass", actual = "422 as expected" })).Ok);

        var runs = (await owner.Get($"{Url}/runs?projectId={project}")).Data!.AsArray();
        Assert.Equal("Running", S(runs.First(r => S(r!["id"]) == uatId)!["status"]));   // the first result starts the run

        var matrix = (await owner.Get($"{Url}/matrix?projectId={project}")).Data!;
        Assert.Equal(new[] { "DEV #212", "UAT 1.4" }, matrix["runs"]!.AsArray().Select(r => S(r!["name"])).ToArray());   // oldest first
        Assert.Equal(4, matrix["cases"]!.AsArray().Count);
        Assert.Equal(7, matrix["results"]!.AsArray().Count);

        // 1 pass of 3 run (pass, fail, blocked) = 33%; the failed Critical case is the one blocker; not ready.
        var ready = (await owner.Get($"{Url}/readiness?runId={uatId}")).Data!;
        Assert.Equal(4, I(ready["cases"]));
        Assert.Equal(3, I(ready["ran"]));
        Assert.Equal(1, I(ready["passed"]));
        Assert.Equal(1, I(ready["failed"]));
        Assert.Equal(1, I(ready["blocked"]));
        Assert.Equal(1, I(ready["notRun"]));
        Assert.Equal(33, I(ready["passPercent"]));
        Assert.Equal("TC-101", S(Assert.Single(ready["blockers"]!.AsArray())!["key"]));
        Assert.False(ready["ready"]!.GetValue<bool>());

        // The latest run is the default; once everything passes it is ready.
        foreach (var c in new[] { c1, c3, c4 }) Assert.True((await owner.Put($"{Url}/runs/{uatId}/results/{c}", new { status = "Pass" })).Ok);
        var latest = (await owner.Get($"{Url}/readiness?projectId={project}")).Data!;
        Assert.Equal("UAT 1.4", S(latest["run"]!["name"]));
        Assert.Equal(100, I(latest["passPercent"]));
        Assert.Empty(latest["blockers"]!.AsArray());
        Assert.True(latest["ready"]!.GetValue<bool>());
    }

    [Fact]
    public async Task File_bug_creates_a_ticket_linked_to_the_result()
    {
        var (owner, project) = await Setup();
        var c1 = await NewCase(owner, project, "Loan dispatch API returns 200 for valid PAN", "Critical");
        var run = S((await owner.Post($"{Url}/runs", new { name = "UAT 1.4", environment = "UAT", projectId = project })).Data!["id"]);
        var result = await owner.Put($"{Url}/runs/{run}/results/{c1}", new { status = "Fail", actual = "502 · CRIF token expired", evidence = "{ \"error\": \"BUREAU_AUTH_FAILED\" }" });
        var resultId = S(result.Data!["id"]);

        var bug = await owner.Post($"{Url}/results/{resultId}/bug", new { });
        Assert.True(bug.Status == HttpStatusCode.Created, bug.ToString());
        var item = bug.Data!["workItem"]!;
        Assert.Equal("ticket", S(item["kind"]));
        Assert.StartsWith("WT-", S(item["key"]));
        Assert.Contains("TC-101", S(item["title"]));
        Assert.Equal("Critical", S(item["priority"]));
        Assert.Equal("SIA Internal API", S(item["projectName"]));
        Assert.Contains("502 · CRIF token expired", S(item["description"]));
        Assert.Contains("BUREAU_AUTH_FAILED", S(item["description"]));
        Assert.Equal(S(item["id"]), S(bug.Data["result"]!["linkedWorkItemId"]));

        // The ticket is a real work item, and filing again returns the same one.
        Assert.True((await owner.Get($"/api/v1/work-items/{S(item["id"])}")).Ok);
        var again = await owner.Post($"{Url}/results/{resultId}/bug", new { });
        Assert.Equal(S(item["id"]), S(again.Data!["workItem"]!["id"]));
        var matrix = (await owner.Get($"{Url}/matrix?projectId={project}")).Data!;
        Assert.Equal(S(item["id"]), S(matrix["results"]![0]!["linkedWorkItemId"]));
    }

    [Fact]
    public async Task Quality_follows_the_Work_module_and_the_workspace()
    {
        var (owner, project) = await Setup();
        await NewCase(owner, project, "Only here", "Low");
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gus Guest");
        Assert.Equal(HttpStatusCode.Forbidden, (await guest.Post($"{Url}/cases", new { title = "Nope" })).Status);

        var stranger = await TestClient.RegisterAsync(factory, "Sam Stranger");
        await stranger.CreateOrgAsync();
        await stranger.UpgradeAsync("BUSINESS");
        Assert.Empty((await stranger.Get($"{Url}/cases")).Data!.AsArray());   // another workspace sees nothing
    }
}
