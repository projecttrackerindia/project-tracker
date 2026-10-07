using System.Diagnostics;
using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.ApiDocs;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>API documentation (release D4): the API reference of a document, import and export, versions and breaking changes, limits and speed.</summary>
[Collection("api")]
public class ApiDocTests(ApiFactory factory) : IAsyncLifetime
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    public Task InitializeAsync() => Task.CompletedTask;
    public Task DisposeAsync()
    {
        factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.Type == NotificationType.Document && (n.EmailPending || n.PushPending)).ExecuteUpdate(s => s.SetProperty(n => n.EmailPending, false).SetProperty(n => n.PushPending, false)));
        return Task.CompletedTask;
    }

    private async Task<(TestClient Owner, Guid Doc)> Org(string plan = "BUSINESS", int seats = 10)
    {
        var owner = await TestClient.RegisterAsync(factory, "Ada Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync(plan, seats);
        var type = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "API")!["id"]));
        var res = await owner.Post("/api/v1/documents", new { title = "Payments API", typeId = type, visibility = "Organization" });
        Assert.True(res.Ok, res.ToString());
        return (owner, Guid.Parse(S(res.Data!["item"]!["id"])));
    }

    private static async Task<Guid> Api(TestClient c, Guid doc, string name = "Payments", string auth = "Bearer")
    {
        var res = await c.Post($"/api/v1/documents/{doc}/api/definitions", new { name, version = "v1", auth, servers = new[] { "https://api.example.com" } });
        Assert.True(res.Ok, res.ToString());
        return Guid.Parse(S(res.Data!["definitions"]!.AsArray().First(d => S(d!["name"]) == name)!["id"]));
    }

    private static object Details(object? extra = null) => new
    {
        description = "Returns a payment.", auth = "inherit",
        parameters = new[] { new { name = "id", @in = "path", required = true, type = "string", description = "The payment", example = "pay_1", schema = (string?)null } },
        responses = new[] { new { status = "200", description = "OK", contentType = "application/json", schema = """{"type":"object","properties":{"id":{"type":"string"},"amount":{"type":"integer"}},"required":["id"]}""", example = (string?)null } },
    };

    private static Task<ApiResult> AddEndpoint(TestClient c, Guid doc, Guid def, string method, string path, string summary = "A call", object? details = null, string? tag = "Payments") =>
        c.Post($"/api/v1/documents/{doc}/api/endpoints", new { definitionId = def, method, path, summary, tag, deprecated = false, details = details ?? Details() });

    private static async Task<int> Revision(TestClient c, Guid doc) => (await c.Get($"/api/v1/documents/{doc}")).Data!["revision"]!.GetValue<int>();
    private static async Task<ApiResult> Publish(TestClient c, Guid doc, string summary = "Release") => await c.Post($"/api/v1/documents/{doc}/publish", new { changeSummary = summary, major = false, revision = await Revision(c, doc) });

    // ------------------------------------------------------------------ the breaking-change detector

    private static EndpointView View(string method, string path, EndpointDetails d, string auth = "None", bool deprecated = false, string summary = "s") => new("API", method, path, summary, deprecated, auth, d);
    private static EndpointDetails D(Action<EndpointDetails>? shape = null) { var d = new EndpointDetails(); shape?.Invoke(d); return d; }
    private const string User = """{"type":"object","properties":{"id":{"type":"string"},"name":{"type":"string"},"age":{"type":"integer"}},"required":["id"]}""";

    [Fact]
    public void Removing_a_required_parameter_or_changing_the_shape_of_a_response_is_breaking()
    {
        var before = View("GET", "/users/{id}", D(d => { d.Parameters.Add(new ApiParam("id", "path", true, "string", null, null, null)); d.Parameters.Add(new ApiParam("expand", "query", true, "string", null, null, null)); d.Responses.Add(new ApiResponse("200", "ok", "application/json", User, null)); }));
        var after = View("GET", "/users/{id}", D(d => { d.Parameters.Add(new ApiParam("id", "path", true, "string", null, null, null)); d.Responses.Add(new ApiResponse("200", "ok", "application/json", """{"type":"object","properties":{"id":{"type":"string"},"age":{"type":"string"}},"required":["id"]}""", null)); }));
        var c = ApiChangeDetector.Compare([before], [after]);
        Assert.Contains(c.Items, i => i.Code == "param.removed.required" && i.Level == ChangeLevel.Breaking);
        Assert.Contains(c.Items, i => i.Code == "schema.property.removed" && i.Level == ChangeLevel.Breaking && i.Message.Contains("name"));
        Assert.Contains(c.Items, i => i.Code == "schema.type" && i.Level == ChangeLevel.Breaking && i.Message.Contains("age"));
        Assert.Equal(3, c.Breaking);
        Assert.Equal(1, c.Modified);
    }

    [Fact]
    public void Additions_and_wording_are_never_breaking()
    {
        var before = View("GET", "/users", D(d => { d.Description = "Old words"; d.Parameters.Add(new ApiParam("limit", "query", false, "integer", null, null, null)); d.Responses.Add(new ApiResponse("200", "ok", "application/json", User, null)); }));
        var after = View("GET", "/users", D(d =>
        {
            d.Description = "New words";
            d.Parameters.Add(new ApiParam("limit", "query", false, "integer", null, null, null)); d.Parameters.Add(new ApiParam("cursor", "query", false, "string", null, null, null));
            d.Responses.Add(new ApiResponse("200", "ok", "application/json", User.Replace("\"age\":{\"type\":\"integer\"}", "\"age\":{\"type\":\"integer\"},\"email\":{\"type\":\"string\"}"), null));
            d.Responses.Add(new ApiResponse("429", "slow down", null, null, null));
        }), summary: "A better summary");
        var added = View("POST", "/users", D());
        var c = ApiChangeDetector.Compare([before], [after, added]);
        Assert.Equal(0, c.Breaking);
        Assert.Equal(0, c.Warnings);
        Assert.True(c.Info >= 5);
        Assert.Equal(1, c.Added);
        Assert.Empty(ApiChangeDetector.Compare([before], [before]).Items);
    }

    [Fact]
    public void The_detector_knows_what_callers_notice_in_requests_responses_and_authentication()
    {
        var req = D(d => { d.RequestBody = new ApiBody("application/json", false, null, """{"type":"object","properties":{"a":{"type":"string"}}}""", null); d.Responses.Add(new ApiResponse("200", "ok", "application/json", null, null)); d.Responses.Add(new ApiResponse("404", "none", null, null, null)); });
        var changed = D(d =>
        {
            d.RequestBody = new ApiBody("application/json", true, null, """{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"string"}},"required":["b"]}""", null);
            d.Parameters.Add(new ApiParam("tenant", "header", true, "string", null, null, null));
        });
        var c = ApiChangeDetector.Compare([View("POST", "/x", req, "None")], [View("POST", "/x", changed, "Bearer")]);
        foreach (var code in new[] { "body.required", "schema.property.added.required", "param.added.required", "response.removed", "auth.required" })
            Assert.Contains(c.Items, i => i.Code == code && i.Level == ChangeLevel.Breaking);
        Assert.Contains(c.Items, i => i.Code == "response.removed.other" && i.Level == ChangeLevel.Warning);   // a 404 gone is worth a look, not a break
        Assert.Contains(ApiChangeDetector.Compare([View("GET", "/gone", D())], []).Items, i => i.Code == "endpoint.removed" && i.Level == ChangeLevel.Breaking);
        Assert.Contains(ApiChangeDetector.Compare([View("GET", "/a", D(), deprecated: false)], [View("GET", "/a", D(), deprecated: true)]).Items, i => i.Code == "endpoint.deprecated" && i.Level == ChangeLevel.Warning);
        Assert.Contains(ApiChangeDetector.Compare([View("GET", "/a", D(d => d.Parameters.Add(new ApiParam("p", "query", false, "string", null, null, null))))], [View("GET", "/a", D(d => d.Parameters.Add(new ApiParam("p", "query", true, "string", null, null, null))))]).Items, i => i.Code == "param.required");
    }

    // ------------------------------------------------------------------ the reference: definitions and endpoints

    [Fact]
    public async Task An_API_has_endpoints_that_are_unique_by_method_and_path_and_checked_on_the_way_in()
    {
        var (owner, doc) = await Org();
        var api = await Api(owner, doc);
        var made = await AddEndpoint(owner, doc, api, "get", "payments/{id}/", "Get a payment");
        Assert.True(made.Ok, made.ToString());
        Assert.Equal("GET", S(made.Data!["item"]!["method"]));
        Assert.Equal("/payments/{id}", S(made.Data["item"]!["path"]));                                                        // one leading slash, none at the end
        Assert.Equal(HttpStatusCode.Conflict, (await AddEndpoint(owner, doc, api, "GET", "/payments/{id}")).Status);
        Assert.True((await AddEndpoint(owner, doc, api, "DELETE", "/payments/{id}")).Ok);                                   // another method on the same path is fine
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await AddEndpoint(owner, doc, api, "FETCH", "/x")).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await AddEndpoint(owner, doc, api, "GET", "/has space")).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await AddEndpoint(owner, doc, api, "GET", "/x", details: new { parameters = new[] { new { name = "p", @in = "elsewhere", required = false } } })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await AddEndpoint(owner, doc, api, "GET", "/x", details: new { responses = new[] { new { status = "200", description = "bad", contentType = "application/json", schema = "{not json", example = (string?)null } } })).Status);
        Assert.Equal(HttpStatusCode.Conflict, (await owner.Post($"/api/v1/documents/{doc}/api/definitions", new { name = "Payments", auth = "None" })).Status);

        var id = S(made.Data["item"]!["id"]);
        var changed = await owner.Put($"/api/v1/documents/{doc}/api/endpoints/{id}", new { definitionId = api, method = "GET", path = "/payments/{id}", summary = "Fetch a payment", tag = "Payments", deprecated = true, details = Details() });
        Assert.True(changed.Ok, changed.ToString());
        Assert.True(changed.Data!["item"]!["deprecated"]!.GetValue<bool>());
        var page = (await owner.Get($"/api/v1/documents/{doc}/api/endpoints?definitionId={api}")).Data!;
        Assert.Equal(2, page["total"]!.GetValue<int>());
        Assert.Equal("payments", S((await owner.Get($"/api/v1/documents/{doc}/api/endpoints?q=PAYMENTS&method=delete")).Data!["items"]![0]!["path"]).Trim('/').Split('/')[0]);
        Assert.Equal(1, (await owner.Get($"/api/v1/documents/{doc}/api/endpoints?method=DELETE")).Data!["total"]!.GetValue<int>());
        Assert.True((await owner.Delete($"/api/v1/documents/{doc}/api/endpoints/{id}")).Ok);
        Assert.Equal(1, (await owner.Get($"/api/v1/documents/{doc}/api")).Data!["endpoints"]!.GetValue<int>());
    }

    [Fact]
    public async Task Readers_see_the_published_API_and_editors_the_working_copy_and_changing_the_API_is_a_change_of_the_document()
    {
        var (owner, doc) = await Org();
        var reader = await owner.AddMemberAsync(factory, TenantRole.Member, "Rae Reader");
        var api = await Api(owner, doc);
        Assert.True((await AddEndpoint(owner, doc, api, "GET", "/a")).Ok);
        // nothing published: a reader sees the same as everyone
        Assert.True((await owner.Post($"/api/v1/documents/{doc}/api/endpoints", new { definitionId = api, method = "GET", path = "/b", summary = "", deprecated = false, details = Details() })).Ok);
        Assert.Equal(2, (await reader.Get($"/api/v1/documents/{doc}/api")).Data!["endpoints"]!.GetValue<int>());

        var first = await Publish(owner, doc, "First release");
        Assert.True(first.Ok, first.ToString());
        Assert.True((await AddEndpoint(owner, doc, api, "GET", "/c")).Ok);                                                      // a change after publishing
        var seenByReader = (await reader.Get($"/api/v1/documents/{doc}/api")).Data!;
        Assert.Equal(2, seenByReader["endpoints"]!.GetValue<int>());
        Assert.Equal("1.0", S(seenByReader["reading"]));
        Assert.False(seenByReader["live"]!.GetValue<bool>());
        Assert.Equal(3, (await owner.Get($"/api/v1/documents/{doc}/api")).Data!["endpoints"]!.GetValue<int>());
        Assert.True((await owner.Get($"/api/v1/documents/{doc}")).Data!["hasUnpublishedChanges"]!.GetValue<bool>());           // the API counts as part of the document
        Assert.Equal(HttpStatusCode.Forbidden, (await AddEndpoint(reader, doc, api, "GET", "/nope")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await reader.Delete($"/api/v1/documents/{doc}/api/definitions/{api}")).Status);

        var second = await Publish(owner, doc, "Added /c");
        Assert.True(second.Ok, second.ToString());
        Assert.Equal(3, (await reader.Get($"/api/v1/documents/{doc}/api")).Data!["endpoints"]!.GetValue<int>());
        Assert.Equal(HttpStatusCode.Conflict, (await Publish(owner, doc, "Nothing new")).Status);                              // nothing changed since

        // and the old version can still be read
        var v10 = S((await owner.Get($"/api/v1/documents/{doc}/versions")).Data!["items"]!.AsArray().First(v => S(v!["label"]) == "1.0")!["id"]);
        Assert.Equal(2, (await reader.Get($"/api/v1/documents/{doc}/api?versionId={v10}")).Data!["endpoints"]!.GetValue<int>());
        Assert.Equal(2, (await reader.Get($"/api/v1/documents/{doc}/api/endpoints?versionId={v10}")).Data!["total"]!.GetValue<int>());
    }

    [Fact]
    public async Task What_changed_between_versions_names_the_breaking_changes_and_a_restore_brings_the_old_API_back()
    {
        var (owner, doc) = await Org();
        var api = await Api(owner, doc);
        var get = await AddEndpoint(owner, doc, api, "GET", "/payments/{id}", "Get a payment", new
        {
            parameters = new[] { new { name = "id", @in = "path", required = true, type = "string", description = (string?)null, example = (string?)null, schema = (string?)null }, new { name = "currency", @in = "query", required = true, type = "string", description = (string?)null, example = (string?)null, schema = (string?)null } },
            responses = new[] { new { status = "200", description = "OK", contentType = "application/json", schema = User, example = (string?)null } },
        });
        Assert.True(get.Ok, get.ToString());
        Assert.True((await AddEndpoint(owner, doc, api, "POST", "/refunds")).Ok);
        Assert.True((await Publish(owner, doc, "1.0")).Ok);

        // 1.1: additive only
        Assert.True((await AddEndpoint(owner, doc, api, "GET", "/payments")).Ok);
        Assert.True((await Publish(owner, doc, "Added a list")).Ok);
        // 1.2: a required parameter goes, a response property goes, an endpoint goes
        var id = S(get.Data!["item"]!["id"]);
        Assert.True((await owner.Put($"/api/v1/documents/{doc}/api/endpoints/{id}", new
        {
            definitionId = api, method = "GET", path = "/payments/{id}", summary = "Get a payment", tag = "Payments", deprecated = false,
            details = new
            {
                parameters = new[] { new { name = "id", @in = "path", required = true, type = "string", description = (string?)null, example = (string?)null, schema = (string?)null } },
                responses = new[] { new { status = "200", description = "OK", contentType = "application/json", schema = """{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}""", example = (string?)null } },
            },
        })).Ok);
        var refunds = S((await owner.Get($"/api/v1/documents/{doc}/api/endpoints?q=refunds")).Data!["items"]![0]!["id"]);
        Assert.True((await owner.Delete($"/api/v1/documents/{doc}/api/endpoints/{refunds}")).Ok);
        Assert.True((await Publish(owner, doc, "Tidy up")).Ok);

        var versions = (await owner.Get($"/api/v1/documents/{doc}/versions")).Data!["items"]!.AsArray();
        string V(string label) => S(versions.First(v => S(v!["label"]) == label)!["id"]);
        var additive = (await owner.Get($"/api/v1/documents/{doc}/api/changes?from={V("1.0")}&to={V("1.1")}")).Data!;
        Assert.Equal(0, additive["breaking"]!.GetValue<int>());
        Assert.Equal(0, additive["warnings"]!.GetValue<int>());
        Assert.Equal(1, additive["added"]!.GetValue<int>());
        var breaking = (await owner.Get($"/api/v1/documents/{doc}/api/changes?from={V("1.1")}&to={V("1.2")}")).Data!;
        var codes = breaking["items"]!.AsArray().Select(i => S(i!["code"])).ToList();
        Assert.Contains("param.removed.required", codes); Assert.Contains("schema.property.removed", codes); Assert.Contains("endpoint.removed", codes);
        Assert.Equal(4, breaking["breaking"]!.GetValue<int>());                                                                   // the parameter, the two response properties and the endpoint
        Assert.Equal("Breaking", S(breaking["items"]![0]!["level"]).Replace("0", "Breaking"));                                  // breaking changes come first
        var wide = (await owner.Get($"/api/v1/documents/{doc}/api/changes?from={V("1.0")}&to={V("1.2")}")).Data!;
        Assert.True(wide["breaking"]!.GetValue<int>() >= 3);

        // Restoring 1.0 brings its API back as the working copy and publishes it again as 1.3
        var restored = await owner.Post($"/api/v1/documents/{doc}/versions/{V("1.0")}/restore", new { reason = "Roll back", discardChanges = true, revision = await Revision(owner, doc) });
        Assert.True(restored.Ok, restored.ToString());
        Assert.Equal(2, (await owner.Get($"/api/v1/documents/{doc}/api")).Data!["endpoints"]!.GetValue<int>());
        Assert.Contains((await owner.Get($"/api/v1/documents/{doc}/api/endpoints?q=refunds")).Data!["items"]!.AsArray(), e => S(e!["method"]) == "POST");
        var latest = S((await owner.Get($"/api/v1/documents/{doc}/versions")).Data!["publishedLabel"]);
        Assert.Equal("1.3", latest);
        Assert.Equal(2, (await owner.Get($"/api/v1/documents/{doc}/api?versionId={restored.Data!["items"]!.AsArray().First(v => S(v!["label"]) == "1.3")["id"]}")).Data!["endpoints"]!.GetValue<int>());
        Assert.False((await owner.Get($"/api/v1/documents/{doc}")).Data!["hasUnpublishedChanges"]!.GetValue<bool>());
    }

    [Fact]
    public async Task With_an_approval_workflow_changing_the_API_voids_the_review()
    {
        var (owner, doc) = await Org("PRO");
        var reviewer = await owner.AddMemberAsync(factory, TenantRole.Member, "Rita Reviewer");
        Assert.True((await owner.Post("/api/v1/document-workflows", new { name = "Review", isActive = true, remind = false, steps = new[] { new { name = "Review", kind = "User", principalId = reviewer.UserId, rule = "Any", dueDays = (int?)null } } })).Ok);
        var api = await Api(owner, doc);
        Assert.True((await AddEndpoint(owner, doc, api, "GET", "/a")).Ok);
        Assert.True((await owner.Post($"/api/v1/documents/{doc}/submit", new { changeSummary = "First", major = false, revision = await Revision(owner, doc) })).Ok);
        Assert.Equal("InReview", S((await owner.Get($"/api/v1/documents/{doc}")).Data!["item"]!["status"]));
        Assert.True((await AddEndpoint(owner, doc, api, "GET", "/b")).Ok);                                                      // the API changed after it was read
        Assert.Equal("Draft", S((await owner.Get($"/api/v1/documents/{doc}")).Data!["item"]!["status"]));
        Assert.Equal(HttpStatusCode.Conflict, (await reviewer.Post($"/api/v1/documents/{doc}/approve", new { })).Status);
    }

    // ------------------------------------------------------------------ plans

    [Fact]
    public async Task The_plan_limits_the_number_of_endpoints_a_workspace_documents_and_an_import_that_does_not_fit_changes_nothing()
    {
        var (owner, doc) = await Org("FREE", 1);
        var api = await Api(owner, doc);
        factory.WithDb(db =>
        {
            var tenant = db.Documents.IgnoreQueryFilters().Where(d => d.Id == doc).Select(d => d.TenantId).First();
            for (var i = 0; i < 49; i++) db.ApiEndpoints.Add(new ApiEndpoint { TenantId = tenant, DocumentId = doc, DefinitionId = api, Method = ApiMethod.Get, Path = $"/seed/{i}", Summary = "s", DetailsJson = "{}", Hash = $"h{i}", CreatedAt = DateTime.UtcNow });
            db.SaveChanges(); return 0;
        });
        Assert.True((await AddEndpoint(owner, doc, api, "GET", "/fiftieth")).Ok);
        var over = await AddEndpoint(owner, doc, api, "GET", "/fifty-first");
        Assert.False(over.Ok);
        Assert.Equal(50, (await owner.Get($"/api/v1/documents/{doc}/api")).Data!["endpoints"]!.GetValue<int>());
        var spec = Spec(5, 1);
        var refused = await owner.Post($"/api/v1/documents/{doc}/api/import", new { content = spec, fileName = "big.json", definitionId = api, mode = "merge", dryRun = false });
        Assert.False(refused.Ok);
        Assert.Equal(50, (await owner.Get($"/api/v1/documents/{doc}/api")).Data!["endpoints"]!.GetValue<int>());                // not one of the five arrived
        Assert.True((await owner.Post($"/api/v1/documents/{doc}/api/import", new { content = spec, fileName = "big.json", definitionId = api, mode = "merge", dryRun = true })).Ok);   // a dry run still says what would happen
    }

    // ------------------------------------------------------------------ import and export

    /// <summary>An OpenAPI file with <paramref name="paths"/> paths, each with <paramref name="methods"/> operations.</summary>
    private static string Spec(int paths, int methods)
    {
        var p = new JsonObject();
        var verbs = new[] { "get", "post", "put", "delete" };
        for (var i = 0; i < paths; i++)
        {
            var item = new JsonObject();
            for (var m = 0; m < methods; m++)
            {
                var op = new JsonObject
                {
                    ["summary"] = $"Operation {i}-{m}", ["description"] = $"Does thing {i}", ["tags"] = new JsonArray($"Group{i % 7}"),
                    ["parameters"] = new JsonArray(
                        new JsonObject { ["name"] = "id", ["in"] = "path", ["required"] = true, ["schema"] = new JsonObject { ["type"] = "string" } },
                        new JsonObject { ["name"] = "limit", ["in"] = "query", ["required"] = false, ["description"] = "Page size", ["schema"] = new JsonObject { ["type"] = "integer" }, ["example"] = 25 }),
                    ["responses"] = new JsonObject
                    {
                        ["200"] = new JsonObject { ["description"] = "OK", ["content"] = new JsonObject { ["application/json"] = new JsonObject { ["schema"] = new JsonObject { ["type"] = "object", ["properties"] = new JsonObject { ["id"] = new JsonObject { ["type"] = "string" }, ["total"] = new JsonObject { ["type"] = "integer" } }, ["required"] = new JsonArray("id") }, ["example"] = new JsonObject { ["id"] = "x", ["total"] = 3 } } } },
                        ["404"] = new JsonObject { ["description"] = "Not found" },
                    },
                };
                if (verbs[m % 4] is "post" or "put")
                    op["requestBody"] = new JsonObject { ["required"] = true, ["content"] = new JsonObject { ["application/json"] = new JsonObject { ["schema"] = new JsonObject { ["type"] = "object", ["properties"] = new JsonObject { ["name"] = new JsonObject { ["type"] = "string" } } } } } };
                if (i % 5 == 0) op["deprecated"] = true;
                item[verbs[m % 4]] = op;
            }
            p[$"/things{i}/{{id}}"] = item;
        }
        var doc = new JsonObject { ["openapi"] = "3.0.3", ["info"] = new JsonObject { ["title"] = "Things API", ["version"] = "2.4.0", ["description"] = "All the things" }, ["servers"] = new JsonArray(new JsonObject { ["url"] = "https://things.example.com" }), ["paths"] = p };
        return doc.ToJsonString();
    }

    /// <summary>What an OpenAPI file says about each operation, in a form that can be compared.</summary>
    private static SortedSet<string> Meaning(JsonNode spec)
    {
        var set = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var (path, item) in spec["paths"]!.AsObject())
            foreach (var (method, opNode) in item!.AsObject())
            {
                var op = opNode!.AsObject();
                var parts = new List<string> { $"{method.ToUpperInvariant()} {path}", $"summary={op["summary"]}", $"tag={op["tags"]?[0]}", $"deprecated={op["deprecated"]?.ToString() ?? "false"}", $"desc={op["description"]}" };
                foreach (var p in op["parameters"]?.AsArray() ?? []) parts.Add($"param {p!["name"]}/{p["in"]}/{p["required"]}/{p["schema"]?.ToJsonString()}/{p["example"]?.ToJsonString()}");
                if (op["requestBody"] is JsonObject rb) foreach (var (ct, media) in rb["content"]!.AsObject()) parts.Add($"body {ct}/{rb["required"]}/{media!["schema"]?.ToJsonString()}/{media["example"]?.ToJsonString()}");
                foreach (var (status, r) in op["responses"]!.AsObject())
                {
                    parts.Add($"response {status}/{r!["description"]}");
                    if (r["content"] is JsonObject c) foreach (var (ct, media) in c) parts.Add($"response {status} {ct}/{media!["schema"]?.ToJsonString()}/{media["example"]?.ToJsonString()}");
                }
                set.Add(string.Join("\n", parts.OrderBy(x => x, StringComparer.Ordinal)));
            }
        return set;
    }

    [Fact]
    public async Task A_500_endpoint_OpenAPI_file_imports_quickly_and_exports_back_to_the_same_meaning()
    {
        var (owner, doc) = await Org();
        var spec = Spec(125, 4);                                                                                                   // 500 operations
        var timer = Stopwatch.StartNew();
        var dry = await owner.Post($"/api/v1/documents/{doc}/api/import", new { content = spec, fileName = "things.json", mode = "merge", dryRun = true });
        Assert.True(dry.Ok, dry.ToString());
        Assert.Equal(500, dry.Data!["added"]!.GetValue<int>());
        Assert.False(dry.Data["applied"]!.GetValue<bool>());
        Assert.Equal(0, (await owner.Get($"/api/v1/documents/{doc}/api")).Data!["endpoints"]!.GetValue<int>());                 // a dry run writes nothing
        var res = await owner.Post($"/api/v1/documents/{doc}/api/import", new { content = spec, fileName = "things.json", mode = "merge", dryRun = false });
        timer.Stop();
        Assert.True(res.Ok, res.ToString());
        Assert.True(timer.Elapsed < TimeSpan.FromSeconds(30), $"took {timer.Elapsed}");
        Assert.Equal(500, res.Data!["added"]!.GetValue<int>());
        Assert.Equal("Things API", S(res.Data["definition"]));
        var overview = (await owner.Get($"/api/v1/documents/{doc}/api")).Data!;
        Assert.Equal(500, overview["endpoints"]!.GetValue<int>());
        Assert.Equal("2.4.0", S(overview["definitions"]![0]!["version"]));
        Assert.Equal("https://things.example.com", S(overview["definitions"]![0]!["servers"]![0]));

        // the same file again changes nothing
        var again = await owner.Post($"/api/v1/documents/{doc}/api/import", new { content = spec, fileName = "things.json", definitionId = S(overview["definitions"]![0]!["id"]), mode = "merge", dryRun = false });
        Assert.Equal(500, again.Data!["unchanged"]!.GetValue<int>());
        Assert.Equal(0, again.Data["added"]!.GetValue<int>() + again.Data["updated"]!.GetValue<int>());

        var export = await owner.Raw($"/api/v1/documents/{doc}/api/export?format=openapi");
        Assert.True(export.IsSuccessStatusCode);
        var exported = JsonNode.Parse(await export.Content.ReadAsStringAsync())!;
        Assert.Equal("3.0.3", S(exported["openapi"]));
        var before = Meaning(JsonNode.Parse(spec)!); var after = Meaning(exported);
        Assert.Equal(500, after.Count);
        Assert.Equal(before, after);
    }

    [Fact]
    public async Task Imports_report_problems_with_the_line_they_are_on_and_follow_references_and_read_YAML()
    {
        var (owner, doc) = await Org();
        async Task<JsonNode> Dry(string text, string file = "x.json") { var r = await owner.Post($"/api/v1/documents/{doc}/api/import", new { content = text, fileName = file, mode = "merge", dryRun = true }); Assert.True(r.Ok, r.ToString()); return r.Data!; }

        var broken = await Dry("{\n  \"openapi\": \"3.0.0\",\n  \"paths\": {\n    \"/a\": { \"get\": \n  }\n}");
        Assert.False(broken["success"]!.GetValue<bool>());
        Assert.True(broken["issues"]![0]!["line"]!.GetValue<int>() >= 5);
        Assert.Contains("JSON", S(broken["issues"]![0]!["message"]));
        Assert.False((await Dry("openapi: 3.0.0\npaths:\n  /a:\n   get: [unclosed", "x.yaml"))["success"]!.GetValue<bool>());
        Assert.Contains("Swagger 2.0", S((await Dry("""{"swagger":"2.0","paths":{}}"""))["issues"]![0]!["message"]));
        Assert.False((await Dry("""{"openapi":"3.0.0","info":{"title":"x","version":"1"}}"""))["success"]!.GetValue<bool>());           // no paths

        // a bad path and a duplicate are reported, the rest still imports
        var partial = await Dry("""{"openapi":"3.0.0","info":{"title":"Mixed","version":"1"},"paths":{"/ok":{"get":{"summary":"fine","responses":{"200":{"description":"ok"}}}},"/has space":{"get":{"responses":{"200":{"description":"x"}}}}}}""");
        Assert.True(partial["success"]!.GetValue<bool>());
        Assert.Equal(1, partial["added"]!.GetValue<int>());
        Assert.Contains(partial["issues"]!.AsArray(), i => S(i!["severity"]) == "error" && S(i["message"]).Contains("has space") && i["pointer"] is not null && i["line"] is not null);

        // components are followed; a loop and a reference to another file are left empty, with a warning
        var refs = await owner.Post($"/api/v1/documents/{doc}/api/import", new
        {
            content = """
            {"openapi":"3.0.0","info":{"title":"Refs","version":"1"},
             "paths":{"/users":{"get":{"responses":{"200":{"description":"ok","content":{"application/json":{"schema":{"$ref":"#/components/schemas/User"}}}},"400":{"$ref":"#/components/responses/Bad"},"500":{"$ref":"other.json#/Err"}}}}},
             "components":{"schemas":{"User":{"type":"object","properties":{"id":{"type":"string"},"friend":{"$ref":"#/components/schemas/User"}}}},"responses":{"Bad":{"description":"Bad request"}}}}
            """, fileName = "refs.json", mode = "merge", dryRun = false,
        });
        Assert.True(refs.Ok, refs.ToString());
        Assert.Contains(refs.Data!["issues"]!.AsArray(), i => S(i!["message"]).Contains("outside the file"));
        var ep = S((await owner.Get($"/api/v1/documents/{doc}/api/endpoints?q=users")).Data!["items"]![0]!["id"]);
        var details = (await owner.Get($"/api/v1/documents/{doc}/api/endpoints/{ep}")).Data!["details"]!;
        Assert.Contains("\"id\"", S(details["responses"]![0]!["schema"]));
        Assert.Equal("Bad request", S(details["responses"]!.AsArray().First(r => S(r!["status"]) == "400")!["description"]));

        // the same API in YAML
        var yaml = await owner.Post($"/api/v1/documents/{doc}/api/import", new
        {
            content = "openapi: 3.0.3\ninfo:\n  title: Yaml API\n  version: '2'\nservers:\n  - url: https://y.example.com\npaths:\n  /pets/{id}:\n    get:\n      summary: A pet\n      tags: [Pets]\n      parameters:\n        - name: id\n          in: path\n          required: true\n          schema:\n            type: integer\n      responses:\n        '200':\n          description: The pet\n", fileName = "pets.yaml", mode = "merge", dryRun = false,
        });
        Assert.True(yaml.Ok, yaml.ToString());
        Assert.Equal("Yaml API", S(yaml.Data!["definition"]));
        Assert.Equal("openapi", S(yaml.Data["format"]));
        Assert.Equal(1, yaml.Data["added"]!.GetValue<int>());
    }

    [Fact]
    public async Task Postman_collections_come_in_and_go_out()
    {
        var (owner, doc) = await Org();
        var collection = new JsonObject
        {
            ["info"] = new JsonObject { ["name"] = "Shop", ["schema"] = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
            ["variable"] = new JsonArray(new JsonObject { ["key"] = "baseUrl", ["value"] = "https://shop.example.com" }),
            ["item"] = new JsonArray(
                new JsonObject
                {
                    ["name"] = "Orders",
                    ["item"] = new JsonArray(
                        new JsonObject
                        {
                            ["name"] = "Get an order",
                            ["request"] = new JsonObject { ["method"] = "GET", ["url"] = new JsonObject { ["raw"] = "{{baseUrl}}/orders/:id?expand=items", ["path"] = new JsonArray("orders", ":id"), ["query"] = new JsonArray(new JsonObject { ["key"] = "expand", ["value"] = "items" }), ["variable"] = new JsonArray(new JsonObject { ["key"] = "id", ["value"] = "42" }) } },
                            ["response"] = new JsonArray(new JsonObject { ["name"] = "OK", ["code"] = 200, ["header"] = new JsonArray(new JsonObject { ["key"] = "Content-Type", ["value"] = "application/json" }), ["body"] = "{\"id\":42}" }),
                        },
                        new JsonObject
                        {
                            ["name"] = "Create an order",
                            ["request"] = new JsonObject { ["method"] = "POST", ["header"] = new JsonArray(new JsonObject { ["key"] = "Content-Type", ["value"] = "application/json" }), ["url"] = "{{baseUrl}}/orders", ["body"] = new JsonObject { ["mode"] = "raw", ["raw"] = "{\"sku\":\"a\"}" } },
                        })
                },
                new JsonObject { ["name"] = "Health", ["request"] = new JsonObject { ["method"] = "GET", ["url"] = new JsonObject { ["raw"] = "{{baseUrl}}/health", ["path"] = new JsonArray("health") } } }),
        };
        var res = await owner.Post($"/api/v1/documents/{doc}/api/import", new { content = collection.ToJsonString(), fileName = "shop.json", mode = "merge", dryRun = false });
        Assert.True(res.Ok, res.ToString());
        Assert.Equal("postman", S(res.Data!["format"]));
        Assert.Equal(3, res.Data["added"]!.GetValue<int>());
        var items = (await owner.Get($"/api/v1/documents/{doc}/api/endpoints")).Data!["items"]!.AsArray();
        Assert.Contains(items, i => S(i!["path"]) == "/orders/{id}" && S(i["tag"]) == "Orders");
        Assert.Contains(items, i => S(i!["path"]) == "/health" && i["tag"] is null);
        var order = S(items.First(i => S(i!["path"]) == "/orders/{id}")!["id"]);
        var details = (await owner.Get($"/api/v1/documents/{doc}/api/endpoints/{order}")).Data!["details"]!;
        Assert.Contains(details["parameters"]!.AsArray(), p => S(p!["name"]) == "id" && S(p["in"]) == "path" && p["required"]!.GetValue<bool>());
        Assert.Contains(details["parameters"]!.AsArray(), p => S(p!["name"]) == "expand" && S(p["in"]) == "query");
        Assert.Equal("200", S(details["responses"]![0]!["status"]));

        var export = JsonNode.Parse(await (await owner.Raw($"/api/v1/documents/{doc}/api/export?format=postman")).Content.ReadAsStringAsync())!;
        Assert.Contains("postman", S(export["info"]!["schema"]));
        var requests = new List<string>();
        void Collect(JsonArray a) { foreach (var n in a) { if (n!["item"] is JsonArray c) Collect(c); else requests.Add($"{n["request"]!["method"]} {string.Join('/', n["request"]!["url"]!["path"]!.AsArray().Select(x => x!.ToString()))}"); } }
        Collect(export["item"]!.AsArray());
        Assert.Equal(["GET health", "GET orders/:id", "POST orders"], requests.Order().ToArray());
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Get($"/api/v1/documents/{doc}/api/export?format=wsdl")).Status);
    }

    // ------------------------------------------------------------------ speed and bounds

    [Fact]
    public async Task A_document_with_5000_endpoints_opens_by_API_and_pages_and_searches_fast_and_nothing_is_unbounded()
    {
        var (owner, doc) = await Org();
        var a = await Api(owner, doc, "Big");
        var b = await Api(owner, doc, "Small");
        factory.WithDb(db =>
        {
            var tenant = db.Documents.IgnoreQueryFilters().Where(d => d.Id == doc).Select(d => d.TenantId).First();
            var verbs = new[] { ApiMethod.Get, ApiMethod.Post, ApiMethod.Put, ApiMethod.Delete };
            for (var i = 0; i < 5000; i++)
                db.ApiEndpoints.Add(new ApiEndpoint { TenantId = tenant, DocumentId = doc, DefinitionId = i < 4950 ? a : b, Method = verbs[i % 4], Path = $"/area{i / 4:D4}/items/{{id}}", Summary = $"Endpoint {i}", Tag = $"Group {i % 20}", DetailsJson = "{\"description\":\"d\"}", Hash = $"h{i}", CreatedAt = DateTime.UtcNow });
            db.SaveChanges(); return 0;
        });
        Assert.Equal(5000, (await owner.Get($"/api/v1/documents/{doc}/api")).Data!["endpoints"]!.GetValue<int>());

        // the tree: open the API (counts), then a page of its endpoints
        var times = new List<double>();
        for (var i = 0; i < 20; i++)
        {
            var sw = Stopwatch.StartNew();
            var overview = await owner.Get($"/api/v1/documents/{doc}/api");
            var page = await owner.Get($"/api/v1/documents/{doc}/api/endpoints?definitionId={a}&limit=50");
            sw.Stop();
            Assert.True(overview.Ok && page.Ok);
            Assert.Equal(50, page.Data!["items"]!.AsArray().Count);
            times.Add(sw.Elapsed.TotalMilliseconds);
        }
        Assert.True(Percentile(times, 95) < 500, $"tree p95 {Percentile(times, 95):F0} ms");

        times.Clear();
        for (var i = 0; i < 20; i++)
        {
            var sw = Stopwatch.StartNew();
            var res = await owner.Get($"/api/v1/documents/{doc}/api/endpoints?q=area0{i % 10}&limit=50");
            sw.Stop();
            Assert.True(res.Ok); Assert.NotEmpty(res.Data!["items"]!.AsArray());
            times.Add(sw.Elapsed.TotalMilliseconds);
        }
        Assert.True(Percentile(times, 95) < 300, $"search p95 {Percentile(times, 95):F0} ms");

        // paging walks every endpoint exactly once, in path order
        var seen = new HashSet<string>(); string? cursor = null; var pages = 0; string last = "";
        do
        {
            var res = await owner.Get($"/api/v1/documents/{doc}/api/endpoints?definitionId={a}&limit=200{(cursor is null ? "" : $"&cursor={cursor}")}");
            var items = res.Data!["items"]!.AsArray();
            Assert.True(items.Count <= 200);
            foreach (var it in items) { Assert.True(seen.Add(S(it!["id"]))); Assert.True(string.CompareOrdinal(last, S(it["path"])) <= 0); last = S(it["path"]); }
            cursor = res.Data["nextCursor"]?.GetValue<string>(); pages++;
        } while (cursor is not null && pages < 100);
        Assert.Equal(4950, seen.Count);

        // no list is unbounded
        Assert.Equal(200, (await owner.Get($"/api/v1/documents/{doc}/api/endpoints?limit=100000")).Data!["items"]!.AsArray().Count);
        Assert.False((await owner.Get("/api/v1/api-search?q=a")).Ok);
        Assert.True((await owner.Get("/api/v1/api-search?q=area&limit=100000")).Data!.AsArray().Count <= 50);
    }

    private static double Percentile(List<double> v, int p) { var s = v.Order().ToList(); return s[Math.Min(s.Count - 1, (int)Math.Ceiling(p / 100.0 * s.Count) - 1)]; }

    [Fact]
    public async Task Search_finds_published_endpoints_only_in_documents_the_person_may_open()
    {
        var (owner, doc) = await Org();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mia Member");
        var stranger = await owner.AddMemberAsync(factory, TenantRole.Member, "Sam Stranger");
        var api = await Api(owner, doc);
        Assert.True((await AddEndpoint(owner, doc, api, "GET", "/invoices/{id}", "Get an invoice")).Ok);
        Assert.Empty((await member.Get("/api/v1/api-search?q=invoices")).Data!.AsArray());                                       // not published yet
        Assert.True((await Publish(owner, doc, "First")).Ok);
        var hit = (await member.Get("/api/v1/api-search?q=INVOICE")).Data!.AsArray();
        Assert.Single(hit);
        Assert.Equal("/invoices/{id}", S(hit[0]!["path"]));
        Assert.StartsWith("DOC-", S(hit[0]!["documentKey"]));

        var type = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "API")!["id"]));
        var secret = Guid.Parse(S((await owner.Post("/api/v1/documents", new { title = "Secret API", typeId = type, visibility = "Private" })).Data!["item"]!["id"]));
        var sapi = await Api(owner, secret, "Secret");
        Assert.True((await AddEndpoint(owner, secret, sapi, "GET", "/invoices/secret", "hidden")).Ok);
        Assert.True((await Publish(owner, secret, "Secret v1")).Ok);
        Assert.Single((await member.Get("/api/v1/api-search?q=invoices")).Data!.AsArray());                                       // the private one is invisible to them
        Assert.Equal(2, (await owner.Get("/api/v1/api-search?q=invoices")).Data!.AsArray().Count);
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.Get($"/api/v1/documents/{secret}/api")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.Get($"/api/v1/documents/{secret}/api/endpoints")).Status);

        var (other, _) = await Org();
        Assert.Empty((await other.Get("/api/v1/api-search?q=invoices")).Data!.AsArray());                                         // another workspace sees nothing
        Assert.Equal(HttpStatusCode.NotFound, (await other.Get($"/api/v1/documents/{doc}/api")).Status);
    }
}
