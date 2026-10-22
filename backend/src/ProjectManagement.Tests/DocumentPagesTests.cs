using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Pages (Documents release 1): a free-form page type with one body, pages inside pages in the same project, moving without loops, deleting a
/// parent lifts its pages up, an emoji icon, @ / # / [[ mentions kept as data, and the pages that link to a page.
/// </summary>
[Collection("api")]
public class DocumentPagesTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static Guid Id(ApiResult r) => Guid.Parse(S(r.Data!["item"]!["id"]));

    private async Task<(TestClient Owner, Guid Page, Guid Project)> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Paula Pages");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var types = (await owner.Get("/api/v1/document-types")).Data!.AsArray();
        var page = Guid.Parse(S(types.First(t => S(t!["code"]) == "PAGE")!["id"]));
        var project = await owner.CreateProjectAsync("Handbook");
        return (owner, page, project);
    }

    private static Task<ApiResult> NewPage(TestClient c, Guid type, string title, Guid? project = null, Guid? parent = null, string? icon = null, string? body = null) =>
        c.Post("/api/v1/documents", new { title, typeId = type, projectId = project, parentId = parent, icon, sections = body is null ? null : new[] { new { key = "body", content = body } } });

    [Fact]
    public async Task A_page_has_one_free_form_body_and_pages_nest_inside_it_in_the_same_project()
    {
        var (owner, page, project) = await Setup();
        var root = await NewPage(owner, page, "Engineering handbook", project, icon: "📘");
        Assert.Equal(HttpStatusCode.Created, root.Status);
        Assert.Single(root.Data!["sections"]!.AsArray());
        Assert.Equal("body", S(root.Data["sections"]![0]!["key"]));
        Assert.Equal("📘", S(root.Data["item"]!["icon"]));

        // A page made inside another takes its project, without the project being named again.
        var child = await NewPage(owner, page, "Code review", parent: Id(root));
        Assert.Equal(HttpStatusCode.Created, child.Status);
        Assert.Equal(Id(root), Guid.Parse(S(child.Data!["item"]!["parentId"])));
        Assert.Equal(project, Guid.Parse(S(child.Data["item"]!["projectId"])));
        var second = await NewPage(owner, page, "Releases", parent: Id(root));
        Assert.Equal(1, second.Data!["item"]!["pageOrder"]!.GetValue<int>());

        // A different project cannot be named for a page inside this one.
        var other = await owner.CreateProjectAsync("Payments");
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await NewPage(owner, page, "Wrong place", other, parent: Id(root))).Status);

        // The catalog carries the tree.
        var catalog = (await owner.Get("/api/v1/doctracker/catalog")).Data!;
        var docs = catalog["projects"]!.AsArray().First(p => p!["id"] is not null && Guid.Parse(S(p["id"])) == project)!["documents"]!.AsArray();
        Assert.Equal(Id(root), Guid.Parse(S(docs.First(d => S(d!["title"]) == "Code review")!["parentId"])));
        Assert.Equal("📘", S(docs.First(d => S(d!["title"]) == "Engineering handbook")!["icon"]));
    }

    [Fact]
    public async Task Pages_move_and_reorder_but_never_into_themselves_and_deleting_a_parent_lifts_its_pages()
    {
        var (owner, page, project) = await Setup();
        var a = Id(await NewPage(owner, page, "A", project));
        var b = Id(await NewPage(owner, page, "B", parent: a));
        var c = Id(await NewPage(owner, page, "C", parent: b));

        // A inside C would make a loop (C is inside B, which is inside A); a page inside itself too.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put($"/api/v1/documents/{a}/place", new { parentId = c, pageOrder = 0 })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put($"/api/v1/documents/{a}/place", new { parentId = a, pageOrder = 0 })).Status);

        // C moves up beside B, first.
        var moved = await owner.Put($"/api/v1/documents/{c}/place", new { parentId = a, pageOrder = 0 });
        Assert.True(moved.Ok, moved.ToString());
        Assert.Equal(a, Guid.Parse(S(moved.Data!["item"]!["parentId"])));
        Assert.Equal(0, moved.Data["item"]!["pageOrder"]!.GetValue<int>());
        Assert.Equal(1, (await owner.Get($"/api/v1/documents/{b}")).Data!["item"]!["pageOrder"]!.GetValue<int>());

        // Deleting A keeps B and C: they move to the top level, where A was.
        Assert.True((await owner.Delete($"/api/v1/documents/{a}")).Ok);
        Assert.Null((await owner.Get($"/api/v1/documents/{b}")).Data!["item"]!["parentId"]);
        Assert.Null((await owner.Get($"/api/v1/documents/{c}")).Data!["item"]!["parentId"]);
    }

    [Fact]
    public async Task Icons_are_emoji_only_and_mentions_survive_saving_and_show_as_backlinks()
    {
        var (owner, page, project) = await Setup();
        var target = Id(await NewPage(owner, page, "Refund policy", project));
        Assert.True((await owner.Put($"/api/v1/documents/{target}/icon", new { icon = "💸" })).Ok);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put($"/api/v1/documents/{target}/icon", new { icon = "<b>x</b>" })).Status);
        Assert.Null((await owner.Put($"/api/v1/documents/{target}/icon", new { icon = "" })).Data!["item"]!["icon"]);

        // A page that links to it with [[ ]], mentions a person with @, and has a callout; an unknown kind of mention is dropped.
        var body = new JsonObject
        {
            ["type"] = "doc",
            ["content"] = new JsonArray(
                new JsonObject { ["type"] = "callout", ["attrs"] = new JsonObject { ["tone"] = "warning" }, ["content"] = new JsonArray(new JsonObject { ["type"] = "paragraph", ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = "Read first" }) }) },
                new JsonObject { ["type"] = "paragraph", ["content"] = new JsonArray(
                    new JsonObject { ["type"] = "text", ["text"] = "See " },
                    new JsonObject { ["type"] = "mention", ["attrs"] = new JsonObject { ["kind"] = "page", ["id"] = target.ToString(), ["label"] = "Refund policy" } },
                    new JsonObject { ["type"] = "mention", ["attrs"] = new JsonObject { ["kind"] = "person", ["id"] = owner.UserId.ToString(), ["label"] = "Paula Pages" } },
                    new JsonObject { ["type"] = "mention", ["attrs"] = new JsonObject { ["kind"] = "script", ["id"] = "x", ["label"] = "bad" } }) }),
        }.ToJsonString();
        var linker = await NewPage(owner, page, "Support playbook", project, body: body);
        Assert.Equal(HttpStatusCode.Created, linker.Status);
        var saved = JsonNode.Parse(S(linker.Data!["sections"]![0]!["content"]))!;
        Assert.Equal("warning", S(saved["content"]![0]!["attrs"]!["tone"]));
        var inline = saved["content"]![1]!["content"]!.AsArray();
        Assert.Equal(3, inline.Count);   // the text and two mentions; the unknown kind is gone
        Assert.Equal("page", S(inline[1]!["attrs"]!["kind"]));

        var back = await owner.Get($"/api/v1/documents/{target}/backlinks");
        Assert.True(back.Ok, back.ToString());
        Assert.Equal("Support playbook", S(back.Data!.AsArray().Single()!["title"]));

        // Mentioned names are searchable words of the page.
        var search = await owner.Get("/api/v1/documents?q=Paula");
        Assert.Contains(search.Data!["items"]!.AsArray(), d => S(d!["title"]) == "Support playbook");
    }
}
