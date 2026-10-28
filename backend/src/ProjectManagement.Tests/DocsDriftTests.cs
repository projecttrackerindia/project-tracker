using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.ApiDocs;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Library gaps: API drift (the documented sample response against the live API), freshness on every page (verifiedAt / staleSince in the
/// catalog), AI-drawn boxes getting C4 level and type, and pull request / checks chips for My Work.
/// </summary>
[Collection("api")]
public class DocsDriftTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    // ------------------------------------------------------------------ comparing shapes

    [Fact]
    public void Diff_reports_missing_extra_and_changed_type_fields_but_not_nulls()
    {
        var documented = JsonNode.Parse("""{"id":"pay_1","amount":120,"status":"paid","payer":{"name":"Rhea Tan","vpa":"rhea@upi"},"items":[{"sku":"A1","qty":1}],"note":null}""");
        var live = JsonNode.Parse("""{"id":"pay_9","amount":"120.00","payer":{"name":"Rhea Tan"},"items":[{"sku":"A1","qty":1,"tax":2}],"note":"x","currency":"INR"}""");
        var d = ApiDriftService.Diff(documented, live);
        Assert.Contains(d, f => f.Path == "amount" && f.Kind == "type" && f.Documented == "number" && f.Live == "string");
        Assert.Contains(d, f => f.Path == "status" && f.Kind == "missing");
        Assert.Contains(d, f => f.Path == "payer.vpa" && f.Kind == "missing");
        Assert.Contains(d, f => f.Path == "items[].tax" && f.Kind == "extra" && f.Live == "number");
        Assert.Contains(d, f => f.Path == "currency" && f.Kind == "extra");
        Assert.DoesNotContain(d, f => f.Path == "note");
        Assert.Equal(5, d.Count);
        Assert.Empty(ApiDriftService.Diff(JsonNode.Parse("""{"a":[1,2]}"""), JsonNode.Parse("""{"a":[3]}""")));
    }

    [Fact]
    public void Environments_are_named_by_label_never_by_address()
    {
        string[] three = ["https://pay-dev.fictive.test", "https://pay-uat.fictive.test", "https://payments.fictive.test"];
        Assert.Equal("DEV", ApiDriftService.EnvLabel(three, 0));
        Assert.Equal("UAT", ApiDriftService.EnvLabel(three, 1));
        Assert.Equal("PROD", ApiDriftService.EnvLabel(three, 2));
        Assert.Equal("ENV 5", ApiDriftService.EnvLabel(["https://a.test", "https://b.test", "https://c.test", "https://d.test", "https://e.test"], 4));
    }

    // ------------------------------------------------------------------ checking against live

    private async Task<(TestClient Owner, Guid Doc, Guid Endpoint)> ApiWithSample(string server, string auth = "Bearer")
    {
        var owner = await TestClient.RegisterAsync(factory, "Nila Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS", 10);
        var type = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "API")!["id"]));
        var made = await owner.Post("/api/v1/documents", new { title = "Collections API", typeId = type, visibility = "Organization" });
        Assert.True(made.Ok, made.ToString());
        var doc = Guid.Parse(S(made.Data!["item"]!["id"]));
        var def = await owner.Post($"/api/v1/documents/{doc}/api/definitions", new { name = "Collections", version = "v1", auth, servers = new[] { server } });
        Assert.True(def.Ok, def.ToString());
        var defId = Guid.Parse(S(def.Data!["definitions"]![0]!["id"]));
        var ep = await owner.Post($"/api/v1/documents/{doc}/api/endpoints", new
        {
            definitionId = defId, method = "GET", path = "/v1/dues/{loanId}", summary = "Dues of a loan", tag = "Dues", deprecated = false,
            details = new
            {
                auth = "inherit",
                parameters = new[] { new { name = "loanId", @in = "path", required = true, type = "string", description = "The loan", example = "LN-1001", schema = (string?)null } },
                responses = new[] { new { status = "200", description = "OK", contentType = "application/json", schema = (string?)null, example = """{"loanId":"LN-1001","due":4200,"dueDate":"2026-11-05","penalty":0}""" } },
            },
        });
        Assert.True(ep.Ok, ep.ToString());
        return (owner, doc, Guid.Parse(S(ep.Data!["item"]!["id"])));
    }

    [Fact]
    public async Task Check_against_live_calls_the_api_with_the_stored_token_and_reports_drift_without_hosts_or_secrets()
    {
        var (owner, doc, ep) = await ApiWithSample("https://collect-uat.fictive.test");
        var secret = await owner.Post($"/api/v1/documents/{doc}/secrets", new { label = "UAT bearer token", value = "tok_live_9f8e7d", note = "for checks", @class = "Secret" });
        Assert.True(secret.Ok, secret.ToString());
        factory.LiveApi.Answers["/v1/dues/LN-2002"] = """{"loanId":"LN-2002","due":"4200","dueDate":"2026-11-05","overdueDays":3}""";
        var hashBefore = factory.WithDb(db => db.ApiEndpoints.IgnoreQueryFilters().Where(e => e.Id == ep).Select(e => e.Hash).First());

        var res = await owner.Post($"/api/v1/documents/{doc}/api/endpoints/{ep}/live-check", new { env = 0, values = new Dictionary<string, string> { ["path:loanId"] = "LN-2002" } });
        Assert.True(res.Ok, res.ToString());
        Assert.True(res.Data!["differs"]!.GetValue<bool>());
        Assert.Equal("UAT", S(res.Data["env"]));
        var fields = res.Data["fields"]!.AsArray();
        Assert.Contains(fields, f => S(f!["path"]) == "due" && S(f["kind"]) == "type");
        Assert.Contains(fields, f => S(f!["path"]) == "penalty" && S(f["kind"]) == "missing");
        Assert.Contains(fields, f => S(f!["path"]) == "overdueDays" && S(f["kind"]) == "extra");
        Assert.Contains("Bearer tok_live_9f8e7d", factory.LiveApi.Authorizations);
        var text = res.Data.ToJsonString();
        Assert.DoesNotContain("fictive.test", text);
        Assert.DoesNotContain("tok_live", text);
        Assert.DoesNotContain("LN-2002", text);   // values from the live response are never kept

        // Kept with the endpoint, shown on its page and in the catalog, and not a change of the document.
        var got = await owner.Get($"/api/v1/documents/{doc}/api/endpoints/{ep}");
        Assert.True(got.Data!["liveCheck"]!["differs"]!.GetValue<bool>());
        var cat = await owner.Get("/api/v1/doctracker/catalog");
        var drift = cat.Data!["projects"]!.AsArray().SelectMany(p => p!["endpoints"]!.AsArray()).First(e => S(e!["id"]) == ep.ToString())!["drift"]!;
        Assert.Equal(1, drift["missing"]!.GetValue<int>());
        Assert.Equal(1, drift["extra"]!.GetValue<int>());
        Assert.Equal(1, drift["changed"]!.GetValue<int>());
        Assert.Equal(hashBefore, factory.WithDb(db => db.ApiEndpoints.IgnoreQueryFilters().Where(e => e.Id == ep).Select(e => e.Hash).First()));
        Assert.True(factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Any(a => a.Action == "document.secret_used" && a.EntityId == doc)));
    }

    [Fact]
    public async Task A_private_environment_is_refused_without_naming_it_and_a_pasted_response_is_compared_instead()
    {
        var (owner, doc, ep) = await ApiWithSample("https://10.20.30.40", auth: "None");
        var res = await owner.Post($"/api/v1/documents/{doc}/api/endpoints/{ep}/live-check", new { env = 0 });
        Assert.True(res.Ok, res.ToString());
        Assert.False(res.Data!["differs"]!.GetValue<bool>());
        Assert.Contains("private network", S(res.Data["error"]));
        Assert.DoesNotContain("10.20.30.40", res.Data.ToJsonString());

        var pasted = await owner.Post($"/api/v1/documents/{doc}/api/endpoints/{ep}/live-check", new { liveBody = """{"loanId":"LN-1","due":10,"dueDate":"2026-11-05","penalty":0}""" });
        Assert.True(pasted.Ok, pasted.ToString());
        Assert.Equal("pasted", S(pasted.Data!["source"]));
        Assert.False(pasted.Data["differs"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Only_reads_are_sent_to_the_live_api()
    {
        var (owner, doc, _) = await ApiWithSample("https://collect.fictive.test", auth: "None");
        var defId = S((await owner.Get($"/api/v1/documents/{doc}/api")).Data!["definitions"]![0]!["id"]);
        var post = await owner.Post($"/api/v1/documents/{doc}/api/endpoints", new
        {
            definitionId = defId, method = "POST", path = "/v1/payments", summary = "Take a payment", tag = "Payments", deprecated = false,
            details = new { auth = "inherit", responses = new[] { new { status = "201", description = "Created", contentType = "application/json", schema = (string?)null, example = """{"id":"p1"}""" } } },
        });
        Assert.True(post.Ok, post.ToString());
        var calls = factory.LiveApi.Authorizations.Count;
        var res = await owner.Post($"/api/v1/documents/{doc}/api/endpoints/{S(post.Data!["item"]!["id"])}/live-check", new { env = 0 });
        Assert.True(res.Ok, res.ToString());
        Assert.Contains("Only GET calls", S(res.Data!["error"]));
        Assert.Equal(calls, factory.LiveApi.Authorizations.Count);
    }

    [Fact]
    public async Task Readers_cannot_run_a_live_check()
    {
        var (owner, doc, ep) = await ApiWithSample("https://collect.fictive.test", auth: "None");
        var reader = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gita Guest");
        var res = await reader.Post($"/api/v1/documents/{doc}/api/endpoints/{ep}/live-check", new { liveBody = "{}" });
        Assert.False(res.Ok);
    }

    // ------------------------------------------------------------------ freshness in the catalog

    [Fact]
    public async Task The_catalog_carries_each_pages_verified_and_stale_dates()
    {
        var (owner, doc, _) = await ApiWithSample("https://collect.fictive.test", auth: "None");
        var verified = await owner.Post($"/api/v1/documents/{doc}/verify", new { note = (string?)null });
        Assert.True(verified.Ok, verified.ToString());
        var cat = await owner.Get("/api/v1/doctracker/catalog");
        var d = cat.Data!["projects"]!.AsArray().SelectMany(p => p!["documents"]!.AsArray()).First(x => S(x!["id"]) == doc.ToString())!;
        Assert.NotNull(d["verifiedAt"]);
    }

    // ------------------------------------------------------------------ AI-drawn boxes get C4 details

    [Fact]
    public void Drawn_boxes_get_a_type_from_their_icon_and_a_level_from_their_type_or_the_tab()
    {
        var data = ArchDiagram.Clean(JsonNode.Parse("""
            {"nodes":[{"id":"a","kind":"icon","icon":"user","label":"Borrower"},{"id":"b","kind":"icon","icon":"api","label":"Loan API","tech":".NET 9"},
                      {"id":"c","kind":"icon","icon":"database","label":"Loans DB","ctype":"db","level":"deployment"},{"id":"d","kind":"icon","ctype":"spaceship","label":"?"},
                      {"id":"f","kind":"frame","label":"DMZ"}],"edges":[]}
            """));
        var c4 = ArchDiagram.ApplyC4(data, "components");
        JsonObject N(string id) => c4["nodes"]!.AsArray().OfType<JsonObject>().First(n => S(n["id"]) == id);
        Assert.Equal("person", S(N("a")["ctype"])); Assert.Equal("context", S(N("a")["level"]));
        Assert.Equal("api", S(N("b")["ctype"])); Assert.Equal("components", S(N("b")["level"])); Assert.Equal(".NET 9", S(N("b")["tech"]));
        Assert.Equal("deployment", S(N("c")["level"]));
        Assert.Null(N("d")["ctype"]);
        Assert.Equal("zone", S(N("f")["ctype"]));
        Assert.Equal("containers", ArchDiagram.LevelOr("nonsense"));
    }

    // ------------------------------------------------------------------ pull request chips for My Work

    [Fact]
    public async Task Dev_status_lists_pull_requests_with_checks_for_visible_items_only()
    {
        var owner = await TestClient.RegisterAsync(factory, "Ira Owner");
        await owner.CreateOrgAsync();
        var project = await owner.CreateProjectAsync();
        var task = Guid.Parse(S((await owner.CreateTaskAsync(project, "Retry failed mandates"))["id"]));
        var tenant = owner.WorkspaceId;
        factory.WithDb(db =>
        {
            db.DevLinks.Add(new DevLink { TenantId = tenant, TaskId = task, Provider = GitProvider.GitHub, Kind = "pull_request", ExternalId = "412", Title = "Retry mandates", Url = "https://github.com/fictive/collect/pull/412", Repository = "fictive/collect", State = "open", ChecksState = "failure", OccurredAt = DateTime.UtcNow.AddHours(-2) });
            db.DevLinks.Add(new DevLink { TenantId = tenant, TaskId = task, Provider = GitProvider.GitHub, Kind = "pull_request", ExternalId = "398", Title = "Mandate model", Url = "https://github.com/fictive/collect/pull/398", Repository = "fictive/collect", State = "merged", ChecksState = "success", OccurredAt = DateTime.UtcNow.AddDays(-2) });
            db.DevLinks.Add(new DevLink { TenantId = tenant, TaskId = task, Provider = GitProvider.GitHub, Kind = "commit", ExternalId = "abc1234", Title = "wip", Url = "https://github.com/fictive/collect/commit/abc1234", OccurredAt = DateTime.UtcNow });
            return db.SaveChanges();
        });
        var res = await owner.Get($"/api/v1/dev-links/status?ids={task},{Guid.NewGuid()}");
        Assert.True(res.Ok, res.ToString());
        var item = res.Data!.AsArray().Single()!;
        Assert.Equal(task.ToString(), S(item["itemId"]));
        var pulls = item["pulls"]!.AsArray();
        Assert.Equal(2, pulls.Count);
        Assert.Equal("412", S(pulls[0]!["number"])); Assert.Equal("open", S(pulls[0]!["state"])); Assert.Equal("failure", S(pulls[0]!["checks"]));
        Assert.Equal("merged", S(pulls[1]!["state"]));

        var stranger = await TestClient.RegisterAsync(factory, "Other Org");
        await stranger.CreateOrgAsync();
        var none = await stranger.Get($"/api/v1/dev-links/status?ids={task}");
        Assert.True(none.Ok, none.ToString());
        Assert.Empty(none.Data!.AsArray());
    }
}
