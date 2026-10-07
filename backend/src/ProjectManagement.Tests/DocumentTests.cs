using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Documents (release D1): created from a type's template, visible only to the people their visibility and project allow, linked both ways
/// to projects and work, limited by plan, and stored as data (never as markup).
/// </summary>
[Collection("api")]
public class DocumentTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<(TestClient Owner, Guid Brd)> OwnerWithTypes(string plan = "BUSINESS")
    {
        var owner = await TestClient.RegisterAsync(factory, "Dora Owner");
        await owner.CreateOrgAsync();
        if (plan != "FREE") await owner.UpgradeAsync(plan);
        var types = await owner.Get("/api/v1/document-types");
        Assert.True(types.Ok, types.ToString());
        var brd = Guid.Parse(S(types.Data!.AsArray().First(t => S(t!["code"]) == "BRD")!["id"]));
        return (owner, brd);
    }

    private static async Task<ApiResult> NewDoc(TestClient c, Guid type, string title = "Employee portal integration", Guid? project = null, string? visibility = null, Guid? team = null, object? sections = null) =>
        await c.Post("/api/v1/documents", new { title, typeId = type, projectId = project, teamId = team, visibility, sections });

    private static Guid Id(ApiResult r) => Guid.Parse(S(r.Data!["item"]!["id"]));

    // ------------------------------------------------------------------ types and creation

    [Fact]
    public async Task Every_workspace_gets_the_built_in_document_types_and_a_BRD_starts_from_its_template()
    {
        var (owner, brd) = await OwnerWithTypes();
        var types = (await owner.Get("/api/v1/document-types")).Data!.AsArray();
        Assert.Equal(16, types.Count);
        Assert.Contains(types, t => S(t!["code"]) == "API" && S(t["name"]) == "API documentation");

        var res = await NewDoc(owner, brd);
        Assert.Equal(HttpStatusCode.Created, res.Status);
        Assert.Equal("DOC-1", S(res.Data!["item"]!["key"]));
        Assert.Equal("Draft", S(res.Data["item"]!["status"]));
        Assert.Equal("Draft", S(res.Data["versionLabel"]));
        var sections = res.Data["sections"]!.AsArray();
        Assert.Equal(12, sections.Count);
        Assert.Equal("businessRequirements", S(sections[1]!["key"]));
        Assert.Equal("Table", S(sections.First(s => S(s!["key"]) == "risks")!["kind"]));
        Assert.True(res.Data["can"]!["edit"]!.GetValue<bool>());
        Assert.Equal("DOC-2", S((await NewDoc(owner, brd, "Second")).Data!["item"]!["key"]));
    }

    [Fact]
    public async Task Section_content_survives_a_reload_and_a_stale_save_is_refused_not_overwritten()
    {
        var (owner, brd) = await OwnerWithTypes();
        var created = await NewDoc(owner, brd);
        var id = Id(created);
        var text = """{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Employees must see their payslip."}]}]}""";
        var table = """{"columns":[{"key":"Risk","label":"Risk"},{"key":"Owner","label":"Owner"}],"rows":[{"Risk":"Late data","Owner":"Priya"}]}""";
        var rev = created.Data!["revision"]!.GetValue<int>();
        var saved = await owner.Put($"/api/v1/documents/{id}/sections", new { revision = rev, sections = new[] { new { key = "businessRequirements", content = text }, new { key = "risks", content = table } } });
        Assert.True(saved.Ok, saved.ToString());

        var again = (await owner.Get($"/api/v1/documents/{id}")).Data!;
        Assert.Contains("Employees must see their payslip.", S(again["sections"]!.AsArray().First(s => S(s!["key"]) == "businessRequirements")!["content"]));
        Assert.Contains("Late data", S(again["sections"]!.AsArray().First(s => S(s!["key"]) == "risks")!["content"]));

        var stale = await owner.Put($"/api/v1/documents/{id}/sections", new { revision = rev, sections = new[] { new { key = "scope", content = text } } });
        Assert.Equal(HttpStatusCode.Conflict, stale.Status);
        Assert.Equal("DOCUMENT_CHANGED", stale.ErrorCode);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put($"/api/v1/documents/{id}/sections", new { revision = saved.Data!["revision"]!.GetValue<int>(), sections = new[] { new { key = "nope", content = text } } })).Status);
    }

    [Fact]
    public async Task Rich_text_is_stored_as_data_and_anything_that_could_run_is_dropped()
    {
        var (owner, brd) = await OwnerWithTypes();
        var created = await NewDoc(owner, brd);
        var evil = """
            {"type":"doc","content":[
              {"type":"script","content":[{"type":"text","text":"alert(1)"}]},
              {"type":"paragraph","attrs":{"onclick":"steal()"},"content":[
                {"type":"text","text":"click me","marks":[{"type":"link","attrs":{"href":"javascript:alert(document.cookie)"}},{"type":"bold"}]},
                {"type":"text","text":"safe","marks":[{"type":"link","attrs":{"href":"https://example.com/a"}}]},
                {"type":"image","attrs":{"src":"x","onerror":"alert(1)"}}]}]}
            """;
        var saved = await owner.Put($"/api/v1/documents/{Id(created)}/sections", new { revision = created.Data!["revision"]!.GetValue<int>(), sections = new[] { new { key = "scope", content = evil } } });
        Assert.True(saved.Ok, saved.ToString());
        var stored = S(saved.Data!["sections"]!.AsArray().First(s => S(s!["key"]) == "scope")!["content"]);
        Assert.Contains("click me", stored);
        Assert.Contains("https://example.com/a", stored);
        Assert.DoesNotContain("javascript:", stored);
        Assert.DoesNotContain("script", stored);
        Assert.DoesNotContain("onclick", stored);
        Assert.DoesNotContain("onerror", stored);
        Assert.DoesNotContain("image", stored);
        Assert.DoesNotContain("alert(1)", stored);
    }

    [Fact]
    public void Content_rules_cap_depth_size_and_table_shape()
    {
        var deep = string.Concat(Enumerable.Repeat("""{"type":"blockquote","content":[""", 30)) + """{"type":"paragraph"}""" + string.Concat(Enumerable.Repeat("]}", 30));
        Assert.Throws<ProjectManagement.Application.Exceptions.ValidationException>(() => SectionContent.NormalizeRichText($$"""{"type":"doc","content":[{{deep}}]}"""));
        Assert.Throws<ProjectManagement.Application.Exceptions.ValidationException>(() => SectionContent.NormalizeRichText("not json"));
        Assert.Throws<ProjectManagement.Application.Exceptions.ValidationException>(() => SectionContent.NormalizeRichText(new string('x', SectionContent.MaxChars + 1)));
        Assert.Contains("paragraph", SectionContent.NormalizeRichText(null));

        var wide = "{\"columns\":[" + string.Join(",", Enumerable.Range(0, 30).Select(i => $"{{\"key\":\"c{i}\",\"label\":\"C{i}\"}}")) + "],\"rows\":[{\"c0\":\"" + new string('a', 5000) + "\",\"zzz\":\"x\"}]}";
        var clean = JsonNode.Parse(SectionContent.NormalizeTable(wide))!;
        Assert.Equal(SectionContent.MaxColumns, clean["columns"]!.AsArray().Count);
        Assert.Equal(SectionContent.MaxCell, S(clean["rows"]![0]!["c0"]).Length);
        Assert.Null(clean["rows"]![0]!["zzz"]);
    }

    // ------------------------------------------------------------------ who may see what

    [Fact]
    public async Task Another_organization_never_sees_a_document_on_any_endpoint()
    {
        var (owner, brd) = await OwnerWithTypes();
        var id = Id(await NewDoc(owner, brd));
        var stranger = await TestClient.RegisterAsync(factory, "Sam Stranger");
        await stranger.CreateOrgAsync();
        var linkId = Guid.NewGuid();

        foreach (var (status, what) in new[]
        {
            ((await stranger.Get($"/api/v1/documents/{id}")).Status, "get"),
            ((await stranger.Put($"/api/v1/documents/{id}", new { title = "x", visibility = "Organization", revision = 1 })).Status, "update"),
            ((await stranger.Put($"/api/v1/documents/{id}/sections", new { revision = 1, sections = Array.Empty<object>() })).Status, "save"),
            ((await stranger.Post($"/api/v1/documents/{id}/archive")).Status, "archive"),
            ((await stranger.Post($"/api/v1/documents/{id}/reopen")).Status, "reopen"),
            ((await stranger.Post($"/api/v1/documents/{id}/restore")).Status, "restore"),
            ((await stranger.Delete($"/api/v1/documents/{id}")).Status, "delete"),
            ((await stranger.Get($"/api/v1/documents/{id}/links")).Status, "links"),
            ((await stranger.Post($"/api/v1/documents/{id}/links", new { targetType = "Project", targetId = Guid.NewGuid() })).Status, "add link"),
            ((await stranger.Delete($"/api/v1/documents/{id}/links/{linkId}")).Status, "remove link"),
        })
            Assert.True(status == HttpStatusCode.NotFound, $"{what} answered {(int)status} to another organization");

        var list = await stranger.Get("/api/v1/documents");
        Assert.True(list.Ok); Assert.Empty(list.Data!["items"]!.AsArray()); Assert.Equal(0, list.Data["total"]!.GetValue<int>());
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.Get($"/api/v1/linked-documents?targetType=Project&targetId={Guid.NewGuid()}")).Status);
        Assert.Equal("Employee portal integration", S((await owner.Get($"/api/v1/documents/{id}")).Data!["item"]!["title"]));   // and it is still there for its own organization
    }

    [Fact]
    public async Task A_project_document_is_seen_only_by_the_people_who_reach_its_project_and_a_private_one_only_by_its_owner_and_admins()
    {
        var (owner, brd) = await OwnerWithTypes();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mia Member");
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gus Guest");
        var other = await owner.AddMemberAsync(factory, TenantRole.Member, "Otto Other");
        var project = await owner.CreateProjectAsync("Portal");
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = guest.UserId })).Ok);

        var inProject = Id(await NewDoc(owner, brd, "Portal BRD", project));
        var priv = Id(await NewDoc(member, brd, "Mia's notes", project, "Private"));
        var org = Id(await NewDoc(owner, brd, "Org policy", null, "Organization"));

        // The guest was added to the project: the project's document is theirs to read, not to write.
        var read = await guest.Get($"/api/v1/documents/{inProject}");
        Assert.True(read.Ok, read.ToString());
        Assert.False(read.Data!["can"]!["edit"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.Forbidden, (await guest.Put($"/api/v1/documents/{inProject}/sections", new { revision = read.Data["revision"]!.GetValue<int>(), sections = Array.Empty<object>() })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await NewDoc(guest, brd, "Guest doc", project)).Status);
        // ... but not the private one, nor the organization-wide one.
        Assert.Equal(HttpStatusCode.NotFound, (await guest.Get($"/api/v1/documents/{priv}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await guest.Get($"/api/v1/documents/{org}")).Status);
        Assert.Equal(["Portal BRD"], (await guest.Get("/api/v1/documents")).Data!["items"]!.AsArray().Select(i => S(i!["title"])).ToArray());

        // Private: its owner and the organization's owners and admins; nobody else, though they share the workspace and the project.
        Assert.True((await member.Get($"/api/v1/documents/{priv}")).Ok);
        Assert.True((await owner.Get($"/api/v1/documents/{priv}")).Ok);
        Assert.Equal(HttpStatusCode.NotFound, (await other.Get($"/api/v1/documents/{priv}")).Status);
        // Organization-wide: every member, no guest.
        Assert.True((await other.Get($"/api/v1/documents/{org}")).Ok);
    }

    [Fact]
    public async Task A_team_document_is_visible_to_the_team_and_a_project_document_cannot_be_wider_than_its_project()
    {
        var (owner, brd) = await OwnerWithTypes();
        var inTeam = await owner.AddMemberAsync(factory, TenantRole.Member, "Tina Team");
        var outside = await owner.AddMemberAsync(factory, TenantRole.Member, "Ollie Outside");
        var team = Guid.Parse(S((await owner.Post("/api/v1/teams", new { name = "Integration" })).Data!["team"]!["id"]));
        Assert.True((await owner.Post($"/api/v1/teams/{team}/members", new { userId = inTeam.UserId, isLead = false })).Ok);

        var doc = Id(await NewDoc(owner, brd, "Integration standards", null, "Team", team));
        Assert.True((await inTeam.Get($"/api/v1/documents/{doc}")).Ok);
        Assert.Equal(HttpStatusCode.NotFound, (await outside.Get($"/api/v1/documents/{doc}")).Status);
        // A person can share only with a team they belong to.
        Assert.Equal(HttpStatusCode.Forbidden, (await NewDoc(outside, brd, "Not mine", null, "Team", team)).Status);
        // A team document needs its team; a project document cannot claim to be visible to everyone.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await NewDoc(owner, brd, "No team", null, "Team")).Status);
        var project = await owner.CreateProjectAsync("Wide");
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await NewDoc(owner, brd, "Too wide", project, "Organization")).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await NewDoc(owner, brd, "Project, no project", null, "Project")).Status);
    }

    [Fact]
    public async Task People_edit_their_own_documents_and_only_roles_with_the_edit_right_edit_other_peoples()
    {
        var (owner, brd) = await OwnerWithTypes();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mia Member");
        var other = await owner.AddMemberAsync(factory, TenantRole.Member, "Otto Other");
        var manager = await owner.AddMemberAsync(factory, TenantRole.Manager, "Max Manager");
        var project = await owner.CreateProjectAsync("Shared");
        var mine = await NewDoc(member, brd, "Mia's BRD", project);
        Assert.Equal(HttpStatusCode.Created, mine.Status);
        var id = Id(mine);
        var rev = mine.Data!["revision"]!.GetValue<int>();

        // Another member can read it only if they reach the project; here the project is open to the workspace's people.
        var theirs = await other.Get($"/api/v1/documents/{id}");
        if (theirs.Ok) Assert.False(theirs.Data!["can"]!["edit"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.Forbidden, (await other.Put($"/api/v1/documents/{id}", new { title = "Hijack", visibility = "Project", revision = rev })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await other.Delete($"/api/v1/documents/{id}")).Status);

        var renamed = await member.Put($"/api/v1/documents/{id}", new { title = "Mia's BRD v2", visibility = "Project", revision = rev, tags = new[] { "Payroll", "payroll", "HR " } });
        Assert.True(renamed.Ok, renamed.ToString());
        Assert.Equal(["hr", "payroll"], renamed.Data!["item"]!["tags"]!.AsArray().Select(t => S(t)).ToArray());

        var byManager = await manager.Put($"/api/v1/documents/{id}", new { title = "Reviewed by Max", visibility = "Project", revision = renamed.Data["revision"]!.GetValue<int>() });
        Assert.True(byManager.Ok, byManager.ToString());
        // Handing it over needs a member of the workspace.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put($"/api/v1/documents/{id}", new { title = "x", visibility = "Project", revision = byManager.Data!["revision"]!.GetValue<int>(), ownerId = Guid.NewGuid() })).Status);
    }

    // ------------------------------------------------------------------ plan limit, delete and restore, paging

    [Fact]
    public async Task The_Free_plan_holds_ten_documents_and_a_paid_plan_has_no_limit()
    {
        var (owner, brd) = await OwnerWithTypes("FREE");
        for (var i = 1; i <= 10; i++) Assert.Equal(HttpStatusCode.Created, (await NewDoc(owner, brd, $"Doc {i}")).Status);
        var eleventh = await NewDoc(owner, brd, "Doc 11");
        Assert.Equal(HttpStatusCode.Forbidden, eleventh.Status);
        Assert.Equal("PLAN_LIMIT_REACHED", eleventh.ErrorCode);
        Assert.Contains("documents", eleventh.Json!["errors"]![0]!["message"]!.GetValue<string>());

        await owner.UpgradeAsync("PRO");
        Assert.Equal(HttpStatusCode.Created, (await NewDoc(owner, brd, "Doc 11")).Status);
    }

    [Fact]
    public async Task A_deleted_document_disappears_for_everyone_and_comes_back_for_its_owner_or_an_admin_within_thirty_days()
    {
        var (owner, brd) = await OwnerWithTypes();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mia Member");
        var other = await owner.AddMemberAsync(factory, TenantRole.Member, "Otto Other");
        var id = Id(await NewDoc(member, brd, "Short lived", null, "Organization"));

        Assert.Equal(HttpStatusCode.NoContent, (await member.Delete($"/api/v1/documents/{id}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await member.Get($"/api/v1/documents/{id}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Get($"/api/v1/documents/{id}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await other.Post($"/api/v1/documents/{id}/restore")).Status);   // not theirs to bring back

        Assert.True((await member.Post($"/api/v1/documents/{id}/restore")).Ok);
        Assert.True((await other.Get($"/api/v1/documents/{id}")).Ok);

        await member.Delete($"/api/v1/documents/{id}");
        factory.WithDb(db => db.Documents.IgnoreQueryFilters().Where(d => d.Id == id).ExecuteUpdate(s => s.SetProperty(d => d.DeletedAt, DateTime.UtcNow.AddDays(-31))));
        var late = await owner.Post($"/api/v1/documents/{id}/restore");
        Assert.Equal(HttpStatusCode.Conflict, late.Status); Assert.Equal("RECOVERY_EXPIRED", late.ErrorCode);
    }

    [Fact]
    public async Task Archived_documents_are_read_only_until_reopened()
    {
        var (owner, brd) = await OwnerWithTypes();
        var created = await NewDoc(owner, brd);
        var id = Id(created);
        var archived = await owner.Post($"/api/v1/documents/{id}/archive");
        Assert.True(archived.Ok, archived.ToString());
        Assert.Equal("Archived", S(archived.Data!["item"]!["status"]));
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.Put($"/api/v1/documents/{id}/sections", new { revision = archived.Data["revision"]!.GetValue<int>(), sections = Array.Empty<object>() })).Status);
        Assert.Equal("Draft", S((await owner.Post($"/api/v1/documents/{id}/reopen")).Data!["item"]!["status"]));
        Assert.Single((await owner.Get("/api/v1/documents?status=Draft")).Data!["items"]!.AsArray());
    }

    [Fact]
    public async Task The_list_pages_with_a_cursor_without_repeating_or_skipping_and_filters_by_project_type_tag_and_words()
    {
        var (owner, brd) = await OwnerWithTypes();
        var api = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "API")!["id"]));
        var project = await owner.CreateProjectAsync("Pager");
        for (var i = 1; i <= 23; i++) Assert.True((await NewDoc(owner, i % 2 == 0 ? api : brd, $"Paged document {i:00}", i <= 5 ? project : null, i <= 5 ? null : "Organization")).Ok);
        Assert.True((await owner.Post("/api/v1/documents", new { title = "JWT token guide", typeId = api, tags = new[] { "security" }, visibility = "Organization" })).Ok);

        var seen = new List<string>(); string? cursor = null; var pages = 0; int? total = null;
        do
        {
            var page = await owner.Get($"/api/v1/documents?limit=10{(cursor is null ? "" : "&cursor=" + Uri.EscapeDataString(cursor))}");
            Assert.True(page.Ok, page.ToString());
            if (pages == 0) total = page.Data!["total"]!.GetValue<int>(); else Assert.Null(page.Data!["total"]);
            seen.AddRange(page.Data["items"]!.AsArray().Select(i => S(i!["id"])));
            cursor = page.Data["nextCursor"]?.GetValue<string>(); pages++;
        } while (cursor is not null);
        Assert.Equal(3, pages);
        Assert.Equal(24, total);
        Assert.Equal(24, seen.Distinct().Count());

        Assert.Equal(5, (await owner.Get($"/api/v1/documents?projectId={project}")).Data!["total"]!.GetValue<int>());
        Assert.Equal(19, (await owner.Get("/api/v1/documents?general=true")).Data!["total"]!.GetValue<int>());
        Assert.Equal(12, (await owner.Get($"/api/v1/documents?typeId={api}")).Data!["total"]!.GetValue<int>());
        Assert.Equal("JWT token guide", S((await owner.Get("/api/v1/documents?tag=security")).Data!["items"]![0]!["title"]));
        Assert.Equal("JWT token guide", S((await owner.Get("/api/v1/documents?q=jwt")).Data!["items"]![0]!["title"]));
        Assert.Equal("Paged document 07", S((await owner.Get("/api/v1/documents?q=DOC-7")).Data!["items"]![0]!["title"]));
        Assert.True((await owner.Get("/api/v1/documents?limit=5000")).Data!["items"]!.AsArray().Count <= DocumentService.MaxPageSize);   // never more than one page's maximum
    }

    // ------------------------------------------------------------------ links

    [Fact]
    public async Task A_document_and_the_work_it_is_linked_to_show_each_other_with_live_progress()
    {
        var (owner, brd) = await OwnerWithTypes();
        var project = await owner.CreateProjectAsync("Portal");
        var t1 = S((await owner.CreateTaskAsync(project, "Build payslip screen"))["id"]);
        var t2 = S((await owner.CreateTaskAsync(project, "Load payroll data"))["id"]);
        var doc = Id(await NewDoc(owner, brd, "Portal BRD", project));

        Assert.True((await owner.Post($"/api/v1/documents/{doc}/links", new { targetType = "Task", targetId = t1, relation = "Implements" })).Ok);
        Assert.True((await owner.Post($"/api/v1/documents/{doc}/links", new { targetType = "Task", targetId = t2, relation = "Implements" })).Ok);
        Assert.True((await owner.Post($"/api/v1/documents/{doc}/links", new { targetType = "Project", targetId = project, relation = "Describes" })).Ok);
        Assert.Equal("LINK_EXISTS", (await owner.Post($"/api/v1/documents/{doc}/links", new { targetType = "Task", targetId = t1, relation = "Implements" })).ErrorCode);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Post($"/api/v1/documents/{doc}/links", new { targetType = "Task", targetId = Guid.NewGuid() })).Status);

        var work = (await owner.Get($"/api/v1/documents/{doc}/links")).Data!;
        Assert.Equal(2, work["total"]!.GetValue<int>());        // the project is linked but only tasks, work items and issues count towards progress
        Assert.Equal(0, work["done"]!.GetValue<int>());
        Assert.Equal(2, work["open"]!.GetValue<int>());
        Assert.Contains(work["items"]!.AsArray(), i => S(i!["title"]) == "Build payslip screen" && S(i["key"]).EndsWith("-1"));

        factory.WithDb(db =>
        {
            var task = db.Tasks.IgnoreQueryFilters().Include(t => t.Project).First(t => t.Id == Guid.Parse(t1));
            var done = db.WorkflowStatuses.IgnoreQueryFilters().First(s => s.ProjectId == task.ProjectId && s.Category == StatusCategory.Done);
            task.StatusId = done.Id; return db.SaveChanges();
        });
        var after = (await owner.Get($"/api/v1/documents/{doc}/links")).Data!;
        Assert.Equal(1, after["done"]!.GetValue<int>());
        Assert.Equal(1, after["open"]!.GetValue<int>());

        // From the task's side: the same document, and the project's.
        var fromTask = (await owner.Get($"/api/v1/linked-documents?targetType=Task&targetId={t1}")).Data!;
        Assert.Equal("DOC-1", S(fromTask["items"]![0]!["document"]!["key"]));
        Assert.Equal(1, (await owner.Get($"/api/v1/documents?projectId={project}")).Data!["items"]![0]!["linkedCount"]!.GetValue<int>() - 2);

        var linkId = S(work["items"]!.AsArray().First(i => S(i!["title"]) == "Load payroll data")!["linkId"]);
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Delete($"/api/v1/documents/{doc}/links/{linkId}")).Status);
        Assert.Equal(0, (await owner.Get($"/api/v1/linked-documents?targetType=Task&targetId={t2}")).Data!["items"]!.AsArray().Count);
    }

    [Fact]
    public async Task A_link_never_opens_a_door_a_restricted_document_is_counted_but_never_named()
    {
        var (owner, brd) = await OwnerWithTypes();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mia Member");
        var project = await owner.CreateProjectAsync("Open project");
        var task = S((await owner.CreateTaskAsync(project, "Shared task"))["id"]);
        var secret = Id(await NewDoc(owner, brd, "Confidential restructuring plan", project, "Private"));
        var open = Id(await NewDoc(owner, brd, "Public design", project));
        Assert.True((await owner.Post($"/api/v1/documents/{secret}/links", new { targetType = "Task", targetId = task })).Ok);
        Assert.True((await owner.Post($"/api/v1/documents/{open}/links", new { targetType = "Task", targetId = task })).Ok);

        var asMember = await member.Get($"/api/v1/linked-documents?targetType=Task&targetId={task}");
        Assert.True(asMember.Ok, asMember.ToString());
        Assert.Equal(["Public design"], asMember.Data!["items"]!.AsArray().Select(i => S(i!["document"]!["title"])).ToArray());
        Assert.Equal(1, asMember.Data["restricted"]!.GetValue<int>());
        Assert.DoesNotContain("Confidential", asMember.ToString());
        Assert.Equal(HttpStatusCode.NotFound, (await member.Get($"/api/v1/documents/{secret}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await member.Get($"/api/v1/documents/{secret}/links")).Status);
        // Linking what you cannot open is refused as "not found".
        Assert.Equal(HttpStatusCode.NotFound, (await member.Post($"/api/v1/documents/{secret}/links", new { targetType = "Project", targetId = project })).Status);

        // The other direction: a document linked to a task the person cannot see shows as a restricted item with no title.
        var hiddenProject = await owner.CreateProjectAsync("Hidden");
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gus Guest");
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = guest.UserId })).Ok);
        var hiddenTask = (await owner.CreateTaskAsync(hiddenProject, "Hidden task"))["id"]!.GetValue<string>();
        Assert.True((await owner.Post($"/api/v1/documents/{open}/links", new { targetType = "Task", targetId = hiddenTask })).Ok);
        var asGuest = (await guest.Get($"/api/v1/documents/{open}/links")).Data!;
        Assert.DoesNotContain("Hidden task", asGuest.ToJsonString());
        Assert.Equal(1, asGuest["restricted"]!.GetValue<int>());
    }

    // ------------------------------------------------------------------ roles, access profile, departments, audit

    [Fact]
    public void A_job_role_saved_before_documents_existed_can_read_documents_but_not_write_them()
    {
        var old = AccessProfile.Parse("""{"levels":{"projects":2,"tasks":2},"overrides":{}}""")!;
        Assert.Equal(AccessLevel.View, old.Level(Modules.Documents));
        Assert.DoesNotContain(Permissions.DocsCreate, old.Permissions());
        var edits = AccessProfile.Build(new Dictionary<string, int> { [Modules.Documents] = 2 }, new Dictionary<string, bool>());
        Assert.Contains(Permissions.DocsCreate, edits.Permissions());
        Assert.DoesNotContain(Permissions.DocsDelete, edits.Permissions());
        Assert.Equal(AccessLevel.View, AccessProfile.Build(new Dictionary<string, int>(), new Dictionary<string, bool>()).Level(Modules.Documents));
    }

    [Fact]
    public async Task Departments_are_one_level_deep_and_a_team_cannot_sit_inside_itself()
    {
        var (owner, _) = await OwnerWithTypes();
        async Task<Guid> Team(string name, Guid? parent = null) => Guid.Parse(S((await owner.Post("/api/v1/teams", new { name, parentTeamId = parent })).Data!["team"]!["id"]));
        var engineering = await Team("Engineering");
        var payments = await Team("Payments", engineering);
        Assert.Equal(engineering.ToString(), S((await owner.Get($"/api/v1/teams/{payments}")).Data!["team"]!["parentTeamId"]));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post("/api/v1/teams", new { name = "Deep", parentTeamId = payments })).Status);       // a team under a team under a team
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put($"/api/v1/teams/{engineering}", new { name = "Engineering", parentTeamId = payments })).Status);   // a department cannot move inside its own team
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put($"/api/v1/teams/{engineering}", new { name = "Engineering", parentTeamId = engineering })).Status);
        await owner.Delete($"/api/v1/teams/{engineering}");
        Assert.Null((await owner.Get($"/api/v1/teams/{payments}")).Data!["team"]!["parentTeamId"]);
    }

    [Fact]
    public async Task Creating_changing_linking_and_deleting_a_document_leave_an_audit_trail()
    {
        var (owner, brd) = await OwnerWithTypes();
        var project = await owner.CreateProjectAsync("Audited");
        var id = Id(await NewDoc(owner, brd, "Audited BRD", project));
        Assert.True((await owner.Post($"/api/v1/documents/{id}/links", new { targetType = "Project", targetId = project })).Ok);
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Delete($"/api/v1/documents/{id}")).Status);
        var actions = factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Where(a => a.EntityId == id).Select(a => a.Action).ToList());
        Assert.Contains("document.created", actions); Assert.Contains("document.linked", actions); Assert.Contains("document.deleted", actions);
        var activity = factory.WithDb(db => db.Activities.IgnoreQueryFilters().Where(a => a.EntityId == id).Select(a => a.Action).ToList());
        Assert.Contains("document.created", activity);
    }
}
