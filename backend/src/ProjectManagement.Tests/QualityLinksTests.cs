using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Quality ↔ API docs: a test case links the endpoints it verifies; the endpoint's "Tests" show the linked cases with the latest result per
/// environment and whether it is covered; Groot proposes cases from the endpoint; a project's coverage counts endpoints with a passing run.
/// Links to things the person cannot open are refused, and another person cannot read an endpoint's tests through a private document.
/// </summary>
[Collection("api")]
public class QualityLinksTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static int I(JsonNode? n) => n!.GetValue<int>();

    private static object Details => new
    {
        description = "Creates a loan dispatch.", auth = "inherit",
        parameters = new[] { new { name = "branch", @in = "query", required = true, type = "string", description = "Branch code", example = "HYD01", schema = (string?)null } },
        requestBody = new { contentType = "application/json", required = true, description = "The dispatch", schema = """{"type":"object","properties":{"pan":{"type":"string"},"amount":{"type":"integer"}},"required":["pan","amount"]}""", example = (string?)null },
        responses = new[] { new { status = "201", description = "Created", contentType = "application/json", schema = (string?)null, example = (string?)null } },
        dependencies = new[] { new { name = "Core banking", note = "Posts the disbursal" } },
    };

    [Fact]
    public async Task Cases_link_endpoints_and_make_their_tests_and_the_coverage()
    {
        var owner = await TestClient.RegisterAsync(factory, "Quill Tester");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var project = await owner.CreateProjectAsync("Lending Gateway");
        var type = S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "API")!["id"]);
        var doc = await owner.Post("/api/v1/documents", new { title = "Lending API", typeId = type, projectId = project, visibility = "Private" });
        Assert.True(doc.Ok, doc.ToString());
        var docId = S(doc.Data!["item"]!["id"]);
        var defs = await owner.Post($"/api/v1/documents/{docId}/api/definitions", new { name = "Lending", version = "v1", auth = "Bearer", servers = new[] { "https://api.example.com" } });
        Assert.True(defs.Ok, defs.ToString());
        var def = S(defs.Data!["definitions"]!.AsArray()[0]!["id"]);
        async Task<string> Endpoint(string method, string path)
        {
            var r = await owner.Post($"/api/v1/documents/{docId}/api/endpoints", new { definitionId = def, method, path, summary = "Dispatch a loan", tag = "Loans", deprecated = false, details = Details });
            Assert.True(r.Ok, r.ToString());
            return S(r.Data!["item"]!["id"]);
        }
        var dispatch = await Endpoint("POST", "/loans/dispatch");
        var status = await Endpoint("GET", "/loans/{id}");

        // Groot proposes cases from the endpoint: happy path (201), required field (400), auth (401/403), timeout, idempotency and masked logs.
        var proposals = (await owner.Get($"/api/v1/quality/endpoints/{dispatch}/suggestions")).Data!.AsArray();
        var kinds = proposals.Select(p => S(p!["kind"])).ToList();
        Assert.Equal(new[] { "happy", "required", "auth", "forbidden", "timeout", "idempotency", "masking" }, kinds);
        Assert.Contains("201", S(proposals[0]!["title"]));
        Assert.Contains("400", S(proposals[1]!["title"]));

        // The prefill of "Add test case" comes from the endpoint too.
        var empty = (await owner.Get($"/api/v1/quality/endpoints/{dispatch}/tests")).Data!;
        Assert.Empty(empty["cases"]!.AsArray());
        Assert.False(empty["covered"]!.GetValue<bool>());
        Assert.Equal("POST", S(empty["method"]));
        Assert.Contains("201", S(empty["draft"]!["expected"]));

        // A case confirmed from a proposal, linked to the endpoint.
        var p0 = proposals[0]!;
        var created = await owner.Post("/api/v1/quality/cases", new { title = S(p0["title"]), steps = S(p0["steps"]), expected = S(p0["expected"]), priority = S(p0["priority"]),
            projectId = project, links = new[] { new { kind = "endpoint", id = dispatch } } });
        Assert.True(created.Status == HttpStatusCode.Created, created.ToString());
        var caseId = S(created.Data!["id"]);
        Assert.Equal(docId, S(created.Data["links"]!.AsArray()[0]!["documentId"]));
        // Linking something that does not exist (or cannot be opened) is refused; an unknown kind too.
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Post("/api/v1/quality/cases", new { title = "Ghost", links = new[] { new { kind = "endpoint", id = Guid.NewGuid() } } })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post("/api/v1/quality/cases", new { title = "Odd", links = new[] { new { kind = "sprint", id = Guid.NewGuid() } } })).Status);

        // Runs in two environments: UAT failed, then SIT passed.
        var uat = S((await owner.Post("/api/v1/quality/runs", new { name = "UAT 2.1", environment = "UAT", projectId = project })).Data!["id"]);
        Assert.True((await owner.Put($"/api/v1/quality/runs/{uat}/results/{caseId}", new { status = "Fail", actual = "502 from core banking" })).Ok);
        var sit = S((await owner.Post("/api/v1/quality/runs", new { name = "SIT 2.1", environment = "SIT", projectId = project })).Data!["id"]);
        Assert.True((await owner.Put($"/api/v1/quality/runs/{sit}/results/{caseId}", new { status = "Pass" })).Ok);

        var tests = (await owner.Get($"/api/v1/quality/endpoints/{dispatch}/tests")).Data!;
        Assert.Single(tests["cases"]!.AsArray());
        var envs = tests["environments"]!.AsArray();
        Assert.Equal("Fail", S(envs.First(e => S(e!["environment"]) == "UAT")!["status"]));
        Assert.Equal("Pass", S(envs.First(e => S(e!["environment"]) == "SIT")!["status"]));
        Assert.True(tests["covered"]!.GetValue<bool>());
        // The proposal already taken is not proposed again.
        Assert.DoesNotContain((await owner.Get($"/api/v1/quality/endpoints/{dispatch}/suggestions")).Data!.AsArray(), p => S(p!["kind"]) == "happy");

        // Coverage: 1 of the project's 2 endpoints has a passing run; the other has no case at all.
        var cov = (await owner.Get($"/api/v1/quality/coverage?projectId={project}")).Data!["projects"]!.AsArray().Single()!;
        Assert.Equal(2, I(cov["endpoints"]));
        Assert.Equal(1, I(cov["covered"]));
        Assert.Equal(50, I(cov["percent"]));
        Assert.Equal(1, I(cov["untested"]));
        Assert.Equal(status, S(cov["untestedIds"]!.AsArray()[0]));

        // Someone who cannot open the private API document cannot read its endpoint's tests, nor link to it.
        var outsider = await owner.AddMemberAsync(factory, TenantRole.Member, "Otto Outsider");
        var hidden = await outsider.Get($"/api/v1/quality/endpoints/{dispatch}/tests");
        Assert.True(hidden.Status is HttpStatusCode.NotFound or HttpStatusCode.Forbidden, hidden.ToString());
        var theirs = await outsider.Get("/api/v1/quality/coverage");
        if (theirs.Ok) Assert.Empty(theirs.Data!["projects"]!.AsArray());
        var link = await outsider.Post("/api/v1/quality/cases", new { title = "Peek", links = new[] { new { kind = "endpoint", id = dispatch } } });
        Assert.True(link.Status is HttpStatusCode.NotFound or HttpStatusCode.Forbidden, link.ToString());
    }
}
