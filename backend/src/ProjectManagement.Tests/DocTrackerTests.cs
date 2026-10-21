using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>DocTracker: projects with their APIs (scored), documents and architecture; endpoint values masked with an audited reveal.</summary>
[Collection("api")]
public class DocTrackerTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    [Fact]
    public async Task Catalog_groups_apis_by_project_scores_them_and_masks_endpoint_values()
    {
        var owner = await TestClient.RegisterAsync(factory, "Dee Tracker");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var pid = (await owner.CreateProjectAsync("Collections")).ToString();

        // "New endpoint" from a project with no API document yet makes one; asking again reuses it.
        var home = await owner.Post($"/api/v1/doctracker/api-home?projectId={pid}", new { });
        Assert.True(home.Ok, home.ToString());
        var doc = S(home.Data!["documentId"]); var def = S(home.Data!["definitionId"]);
        Assert.Equal(doc, S((await owner.Post($"/api/v1/doctracker/api-home?projectId={pid}", new { })).Data!["documentId"]));

        var ep = await owner.Post($"/api/v1/documents/{doc}/api/endpoints", new
        {
            definitionId = def, method = "POST", path = "/loans/{id}/pay", summary = "Pay an EMI", tag = "Loans", deprecated = false,
            details = new
            {
                description = "Takes a payment.", auth = "inherit",
                parameters = new[] { new { name = "mobile", @in = "query", required = true, type = "string", description = "Customer mobile", example = "9876543210", schema = (string?)null } },
                requestBody = new { contentType = "application/json", required = true, description = "", schema = (string?)null, example = """{"pan":"ABCDE1234F","amount":500}""" },
                responses = new[] { new { status = "200", description = "OK", contentType = "application/json", schema = (string?)null, example = """{"ok":true}""" } },
            },
        });
        Assert.True(ep.Ok, ep.ToString());
        var eid = S(ep.Data!["item"]!["id"]);

        var catalog = await owner.Get("/api/v1/doctracker/catalog");
        Assert.True(catalog.Ok, catalog.ToString());
        var p = catalog.Data!["projects"]!.AsArray().First(x => x!["id"] is not null && S(x["id"]) == pid)!;
        var e = p["endpoints"]!.AsArray().Single()!;
        Assert.Equal("Loans", S(e["tag"]));
        Assert.Equal(90, e["score"]!.GetValue<int>());   // everything but error cases
        Assert.Contains("No error cases", e["gaps"]!.AsArray().Select(S));
        Assert.Contains(p["documents"]!.AsArray(), d => d!["isApi"]!.GetValue<bool>());
        Assert.Contains(catalog.Data!["projects"]!.AsArray(), x => S(x!["name"]) == "General");

        // Reading masks the example values; an edit unlock and a reasoned read reveal show them.
        var read = await owner.Get($"/api/v1/documents/{doc}/api/endpoints/{eid}");
        Assert.DoesNotContain("9876543210", read.Json!.ToJsonString());
        Assert.DoesNotContain("ABCDE1234F", read.Json!.ToJsonString());
        Assert.True(read.Data!["maskedCount"]!.GetValue<int>() >= 2);
        Assert.Equal(422, (int)(await owner.Post($"/api/v1/documents/{doc}/api/endpoints/{eid}/reveal", new { purpose = "read", reason = "" })).Status);
        var shown = await owner.Post($"/api/v1/documents/{doc}/api/endpoints/{eid}/reveal", new { purpose = "read", reason = "Partner integration call" });
        Assert.True(shown.Ok, shown.ToString());
        Assert.Contains("9876543210", shown.Json!.ToJsonString());
        Assert.Contains("9876543210", (await owner.Post($"/api/v1/documents/{doc}/api/endpoints/{eid}/reveal", new { purpose = "edit" })).Json!.ToJsonString());
    }

    [Fact]
    public async Task Architecture_is_saved_per_project_and_validated()
    {
        var owner = await TestClient.RegisterAsync(factory, "Arun Arch");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var pid = (await owner.CreateProjectAsync("Gateway")).ToString();

        var empty = await owner.Get($"/api/v1/doctracker/architecture?projectId={pid}");
        Assert.True(empty.Ok, empty.ToString());
        Assert.Empty(empty.Data!["diagrams"]!.AsArray());
        Assert.True(empty.Data!["canEdit"]!.GetValue<bool>());

        var data = new
        {
            nodes = new object[] { new { id = "a", kind = "icon", icon = "mobile", label = "App", x = 0, y = 0 }, new { id = "b", kind = "icon", icon = "server", label = "API", x = 200, y = 0 } },
            edges = new object[] { new { id = "e1", source = "a", target = "b", label = "HTTPS" } },
        };
        var saved = await owner.Put($"/api/v1/doctracker/architecture?projectId={pid}", new { diagrams = new[] { new { key = "main", title = "Overview", kind = "architecture", data } }, notes = "Mobile calls the API." });
        Assert.True(saved.Ok, saved.ToString());
        var d = saved.Data!["diagrams"]!.AsArray().Single()!;
        Assert.Equal("Overview", S(d["title"]));
        Assert.Equal(2, d["data"]!["nodes"]!.AsArray().Count);
        Assert.Equal("Mobile calls the API.", S((await owner.Get($"/api/v1/doctracker/architecture?projectId={pid}")).Data!["notes"]));

        var dup = await owner.Put($"/api/v1/doctracker/architecture?projectId={pid}", new { diagrams = new[] { new { key = "x", title = "A", kind = "flow", data }, new { key = "x", title = "B", kind = "flow", data } } });
        Assert.Equal(422, (int)dup.Status);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Get($"/api/v1/doctracker/architecture?projectId={Guid.NewGuid()}")).Status);

        // The organization-wide one (no project).
        Assert.True((await owner.Put("/api/v1/doctracker/architecture", new { diagrams = Array.Empty<object>(), notes = "" })).Ok);
        var catalog = await owner.Get("/api/v1/doctracker/catalog");
        Assert.Equal(1, catalog.Data!["projects"]!.AsArray().First(x => x!["id"] is not null && S(x["id"]) == pid)!["diagrams"]!.GetValue<int>());
    }
}
