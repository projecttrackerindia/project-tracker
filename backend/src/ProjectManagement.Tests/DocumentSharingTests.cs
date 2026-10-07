using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Sharing and files (release D2): who may open a document beyond its visibility, who may change that, and the explanation of it all.</summary>
[Collection("api")]
public class DocumentSharingTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<(TestClient Owner, Guid Brd)> Org(string plan = "BUSINESS", int seats = 10)
    {
        var owner = await TestClient.RegisterAsync(factory, "Sheila Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync(plan, seats);
        var brd = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "BRD")!["id"]));
        return (owner, brd);
    }

    private static async Task<Guid> Make(TestClient c, Guid type, string title, Guid? project = null, string? visibility = null)
    {
        var res = await c.Post("/api/v1/documents", new { title, typeId = type, projectId = project, visibility });
        Assert.True(res.Ok, res.ToString());
        return Guid.Parse(S(res.Data!["item"]!["id"]));
    }

    private static Task<ApiResult> Share(TestClient c, Guid doc, string type, Guid principal, string level = "Viewer", bool deny = false, DateTime? expires = null) =>
        c.Post($"/api/v1/documents/{doc}/grants", new { principalType = type, principalId = principal, level, deny, expiresAt = expires });

    private static async Task<Guid> Team(TestClient owner, string name, params TestClient[] members)
    {
        var team = Guid.Parse(S((await owner.Post("/api/v1/teams", new { name })).Data!["team"]!["id"]));
        foreach (var m in members) Assert.True((await owner.Post($"/api/v1/teams/{team}/members", new { userId = m.UserId, isLead = false })).Ok);
        return team;
    }

    [Fact]
    public async Task A_person_a_team_and_a_job_role_can_each_be_given_access_and_losing_it_takes_effect_on_the_next_request()
    {
        var (owner, brd) = await Org();
        var project = await owner.CreateProjectAsync("Closed project");
        var doc = await Make(owner, brd, "Closed BRD", project, "Private");
        var direct = await owner.AddMemberAsync(factory, TenantRole.Member, "Dina Direct");
        var viaTeam = await owner.AddMemberAsync(factory, TenantRole.Member, "Tara Team");
        var viaRole = await owner.AddMemberAsync(factory, TenantRole.Member, "Rory Role");
        var nobody = await owner.AddMemberAsync(factory, TenantRole.Member, "Nina Nobody");
        foreach (var c in new[] { direct, viaTeam, viaRole, nobody }) Assert.Equal(HttpStatusCode.NotFound, (await c.Get($"/api/v1/documents/{doc}")).Status);

        var team = await Team(owner, "QA", viaTeam);
        var role = Guid.Parse(S((await owner.Post("/api/v1/org/roles", new { name = "Business Analyst" })).Data!["id"]));
        Assert.True((await owner.Put($"/api/v1/org/members/{viaRole.UserId}/role", new { roleId = role })).Ok);

        Assert.True((await Share(owner, doc, "User", direct.UserId)).Ok);
        Assert.True((await Share(owner, doc, "Team", team, "Editor")).Ok);
        var granted = await Share(owner, doc, "JobRole", role);
        Assert.True(granted.Ok, granted.ToString());
        Assert.Equal(3, granted.Data!["grants"]!.AsArray().Count);

        Assert.False((await direct.Get($"/api/v1/documents/{doc}")).Data!["can"]!["edit"]!.GetValue<bool>());          // Viewer
        Assert.True((await viaTeam.Get($"/api/v1/documents/{doc}")).Data!["can"]!["edit"]!.GetValue<bool>());           // Editor, through the team
        Assert.True((await viaRole.Get($"/api/v1/documents/{doc}")).Ok);
        Assert.Equal(HttpStatusCode.NotFound, (await nobody.Get($"/api/v1/documents/{doc}")).Status);
        Assert.Contains(S((await viaTeam.Get("/api/v1/documents")).Data!["items"]![0]!["title"]), "Closed BRD");        // it shows in their list, too

        // An editor through the team can change the text; a viewer cannot.
        var rev = (await viaTeam.Get($"/api/v1/documents/{doc}")).Data!["revision"]!.GetValue<int>();
        Assert.True((await viaTeam.Put($"/api/v1/documents/{doc}/sections", new { revision = rev, sections = new[] { new { key = "scope", content = """{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"By the QA team"}]}]}""" } } })).Ok);
        Assert.Equal(HttpStatusCode.Forbidden, (await direct.Put($"/api/v1/documents/{doc}/sections", new { revision = rev + 1, sections = Array.Empty<object>() })).Status);

        // Take it back: gone on the very next request.
        var userGrant = S(granted.Data["grants"]!.AsArray().First(g => S(g!["principalType"]) == "User")!["id"]);
        Assert.True((await owner.Delete($"/api/v1/documents/{doc}/grants/{userGrant}")).Ok);
        Assert.Equal(HttpStatusCode.NotFound, (await direct.Get($"/api/v1/documents/{doc}")).Status);
        Assert.Equal(0, (await direct.Get("/api/v1/documents")).Data!["total"]!.GetValue<int>());
    }

    [Fact]
    public async Task Only_the_owner_a_manager_of_the_document_and_admins_can_share_it()
    {
        var (owner, brd) = await Org();
        var author = await owner.AddMemberAsync(factory, TenantRole.Member, "Alex Author");
        var editor = await owner.AddMemberAsync(factory, TenantRole.Member, "Edie Editor");
        var manager = await owner.AddMemberAsync(factory, TenantRole.Member, "Mo Manager");
        var friend = await owner.AddMemberAsync(factory, TenantRole.Member, "Fran Friend");
        var doc = await Make(author, brd, "Alex's doc", null, "Private");
        Assert.True((await Share(author, doc, "User", editor.UserId, "Editor")).Ok);
        Assert.True((await Share(author, doc, "User", manager.UserId, "Manager")).Ok);

        Assert.Equal(HttpStatusCode.Forbidden, (await Share(editor, doc, "User", friend.UserId)).Status);        // an editor edits; they do not hand out access
        Assert.Equal(HttpStatusCode.Forbidden, (await editor.Get($"/api/v1/documents/{doc}/access")).Data is { } d && d["canManage"]!.GetValue<bool>() ? HttpStatusCode.OK : HttpStatusCode.Forbidden);
        Assert.True((await Share(manager, doc, "User", friend.UserId)).Ok);                                      // a manager does
        Assert.True((await friend.Get($"/api/v1/documents/{doc}")).Ok);
        Assert.True((await Share(owner, doc, "User", friend.UserId, "Editor")).Ok);                              // an organization owner always can (and this upgrades Fran)
        Assert.True((await friend.Get($"/api/v1/documents/{doc}")).Data!["can"]!["edit"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Share(author, doc, "User", author.UserId)).Status);  // the owner already has everything
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Share(author, doc, "User", Guid.NewGuid())).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Share(author, doc, "Team", Guid.NewGuid())).Status);
    }

    [Fact]
    public async Task A_deny_and_an_end_date_belong_to_plans_with_advanced_permissions_and_a_deny_wins_except_over_organization_admins()
    {
        var (pro, brdPro) = await Org("PRO");
        var worker = await pro.AddMemberAsync(factory, TenantRole.Member, "Wes Worker");
        var docPro = await Make(pro, brdPro, "Pro doc", null, "Organization");
        var blocked = await Share(pro, docPro, "User", worker.UserId, "Viewer", deny: true);
        Assert.Equal(HttpStatusCode.Forbidden, blocked.Status); Assert.Equal("FEATURE_NOT_AVAILABLE", blocked.ErrorCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await Share(pro, docPro, "User", worker.UserId, "Viewer", expires: DateTime.UtcNow.AddDays(3))).Status);

        var (owner, brd) = await Org("BUSINESS");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mia Member");
        var admin = await owner.AddMemberAsync(factory, TenantRole.Admin, "Ada Admin");
        var team = await Team(owner, "Contractors", member);
        var doc = await Make(owner, brd, "Everyone but contractors", null, "Organization");
        Assert.True((await member.Get($"/api/v1/documents/{doc}")).Ok);

        Assert.True((await Share(owner, doc, "Team", team, deny: true)).Ok);
        Assert.Equal(HttpStatusCode.NotFound, (await member.Get($"/api/v1/documents/{doc}")).Status);              // the team is shut out ...
        Assert.True((await admin.Get($"/api/v1/documents/{doc}")).Ok);                                              // ... organization admins never are
        Assert.True((await Share(owner, doc, "User", member.UserId, "Editor")).Ok);                                 // a person grant does not beat a team deny
        Assert.Equal(HttpStatusCode.NotFound, (await member.Get($"/api/v1/documents/{doc}")).Status);

        // An end date: valid in the future, over the moment it passes.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Share(owner, doc, "User", admin.UserId, expires: DateTime.UtcNow.AddDays(-1))).Status);
        var contractor = await owner.AddMemberAsync(factory, TenantRole.Member, "Cody Contractor");
        var priv = await Make(owner, brd, "Short loan", null, "Private");
        Assert.True((await Share(owner, priv, "User", contractor.UserId, expires: DateTime.UtcNow.AddDays(3))).Ok);
        Assert.True((await contractor.Get($"/api/v1/documents/{priv}")).Ok);
        factory.WithDb(db => db.DocumentGrants.IgnoreQueryFilters().Where(g => g.DocumentId == priv).ExecuteUpdate(s => s.SetProperty(g => g.ExpiresAt, DateTime.UtcNow.AddMinutes(-5))));
        Assert.Equal(HttpStatusCode.NotFound, (await contractor.Get($"/api/v1/documents/{priv}")).Status);
    }

    [Fact]
    public Task The_explanation_of_who_can_open_a_document_matches_what_each_person_really_gets() => Matrix(teamsOnly: false);

    [Fact]
    public Task The_explanation_matches_too_when_the_workspace_limits_people_to_their_teams_projects() => Matrix(teamsOnly: true);

    private async Task Matrix(bool teamsOnly)
    {
        var (owner, brd) = await Org(seats: 20);
        if (teamsOnly) Assert.True((await owner.Put("/api/v1/workspace/project-visibility", new { mode = "teams" })).Ok);
        var project = await owner.CreateProjectAsync("Matrix project");
        var kinds = new[] { TenantRole.Member, TenantRole.Manager, TenantRole.Guest, TenantRole.Member, TenantRole.Member, TenantRole.Guest, TenantRole.Manager, TenantRole.Member, TenantRole.Member, TenantRole.Member, TenantRole.Guest, TenantRole.Member };
        var people = new List<TestClient>();
        for (var i = 0; i < kinds.Length; i++) people.Add(await owner.AddMemberAsync(factory, kinds[i], $"Person {i:00}"));
        var team = await Team(owner, "Matrix team", people[3], people[4]);
        var role = Guid.Parse(S((await owner.Post("/api/v1/org/roles", new { name = "Matrix role" })).Data!["id"]));
        Assert.True((await owner.Put($"/api/v1/org/members/{people[5].UserId}/role", new { roleId = role })).Ok);
        Assert.True((await owner.Put($"/api/v1/org/members/{people[7].UserId}/role", new { roleId = role })).Ok);
        foreach (var i in new[] { 2, 8 }) Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = people[i].UserId })).Ok);   // a guest and a member on the project

        var docs = new List<Guid>
        {
            await Make(owner, brd, "Project doc", project),
            await Make(owner, brd, "Private doc", project, "Private"),
            await Make(owner, brd, "Org doc", null, "Organization"),
        };
        var teamDoc = Guid.Parse(S((await owner.Post("/api/v1/documents", new { title = "Team doc", typeId = brd, visibility = "Team", teamId = team })).Data!["item"]!["id"]));
        docs.Add(teamDoc);
        // Extra doors and a shut door.
        Assert.True((await Share(owner, docs[1], "User", people[9].UserId, "Editor")).Ok);
        Assert.True((await Share(owner, docs[1], "Team", team, "Manager")).Ok);
        Assert.True((await Share(owner, docs[1], "JobRole", role)).Ok);
        Assert.True((await Share(owner, docs[0], "User", people[2].UserId, deny: true)).Ok);       // the guest on the project is blocked
        Assert.True((await Share(owner, docs[2], "User", people[10].UserId)).Ok);                  // a guest gets the organization doc by name
        Assert.True((await Share(owner, docs[3], "User", people[11].UserId, "Editor", expires: DateTime.UtcNow.AddDays(2))).Ok);

        var mismatches = new List<string>();
        foreach (var doc in docs)
        {
            var explained = (await owner.Get($"/api/v1/documents/{doc}/access")).Data!["people"]!.AsArray().ToDictionary(p => S(p!["userId"]), p => S(p!["level"]));
            foreach (var (c, i) in people.Select((c, i) => (c, i)).Append((owner, -1)))
            {
                var real = await c.Get($"/api/v1/documents/{doc}");
                var seen = real.Ok;
                var says = explained.TryGetValue(c.UserId.ToString(), out var level);
                if (seen != says) { mismatches.Add($"person {i} doc {doc}: opens={seen}, explained={says}"); continue; }
                if (!seen) continue;
                var edits = real.Data!["can"]!["edit"]!.GetValue<bool>();
                if (edits != (level is "Editor" or "Manager")) mismatches.Add($"person {i} doc {doc}: edit={edits}, explained level={level}");
                if (real.Data["can"]!["share"]!.GetValue<bool>() != (level == "Manager")) mismatches.Add($"person {i} doc {doc}: share differs, level={level}");
            }
        }
        Assert.True(mismatches.Count == 0, string.Join("\n", mismatches));
    }

    [Fact]
    public async Task The_explanation_names_the_reason_for_each_person()
    {
        var (owner, brd) = await Org();
        var project = await owner.CreateProjectAsync("Reasons");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mia Member");
        var team = await Team(owner, "Platform", member);
        var doc = await Make(owner, brd, "Reasoned", project, "Private");
        Assert.True((await Share(owner, doc, "Team", team)).Ok);
        var access = (await owner.Get($"/api/v1/documents/{doc}/access")).Data!;
        var mia = access["people"]!.AsArray().First(p => S(p!["name"]) == "Mia Member")!;
        Assert.Equal(["Shared with team Platform"], mia["reasons"]!.AsArray().Select(r => S(r)).ToArray());
        var sheila = access["people"]!.AsArray().First(p => S(p!["name"]) == "Sheila Owner")!;
        Assert.Contains("Owner", sheila["reasons"]!.AsArray().Select(r => S(r)));
        Assert.Equal("Only the owner (and the organization's owners and admins)", S(access["visibilityText"]));
        Assert.Equal(2, access["grants"]!.AsArray().Count + 1);
        Assert.Equal(1, access["grants"]![0]!["members"]!.GetValue<int>());
    }

    // ------------------------------------------------------------------ files

    private static byte[] Png() => Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");

    [Fact]
    public async Task Files_belong_to_the_document_images_in_the_text_must_be_its_own_files_and_the_plan_limits_apply()
    {
        var (owner, brd) = await Org();
        var doc = await Make(owner, brd, "With files", null, "Organization");
        var reader = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gus Guest");
        var stranger = await TestClient.RegisterAsync(factory, "Sam Stranger");
        await stranger.CreateOrgAsync();

        var up = await owner.Upload($"/api/v1/documents/{doc}/files", "diagram.png", Png());
        Assert.Equal(HttpStatusCode.Created, up.Status);
        var fileId = S(up.Data!["id"]);
        Assert.True(up.Data["isImage"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Upload($"/api/v1/documents/{doc}/files", "evil.png", Encoding.UTF8.GetBytes("MZ not a png"))).Status);   // the bytes must be what the name says
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Upload($"/api/v1/documents/{doc}/files", "run.exe", Encoding.UTF8.GetBytes("MZ"))).Status);
        Assert.Single((await owner.Get($"/api/v1/documents/{doc}/files")).Data!.AsArray());

        // An image in the text points at a file of this document by id; anything else is dropped.
        var rev = (await owner.Get($"/api/v1/documents/{doc}")).Data!["revision"]!.GetValue<int>();
        var content = "{\"type\":\"doc\",\"content\":[{\"type\":\"docImage\",\"attrs\":{\"fileId\":\"" + fileId + "\",\"alt\":\"Flow\"}},{\"type\":\"docImage\",\"attrs\":{\"fileId\":\"" + Guid.NewGuid() + "\",\"alt\":\"Foreign\"}},{\"type\":\"docImage\",\"attrs\":{\"fileId\":\"x\",\"src\":\"https://evil.example/p.png\"}}]}";
        var saved = await owner.Put($"/api/v1/documents/{doc}/sections", new { revision = rev, sections = new[] { new { key = "architecture", content } } });
        Assert.True(saved.Ok, saved.ToString());
        var stored = S(saved.Data!["sections"]!.AsArray().First(s => S(s!["key"]) == "architecture")!["content"]);
        Assert.Contains(fileId, stored); Assert.Contains("Flow", stored);
        Assert.DoesNotContain("Foreign", stored); Assert.DoesNotContain("evil.example", stored);

        // Anyone who can open the document can fetch the file (images inline); nobody else can.
        using (var res = await owner.Raw($"/api/v1/documents/{doc}/files/{fileId}/download?inline=true")) { Assert.Equal(HttpStatusCode.OK, res.StatusCode); Assert.Equal("image/png", res.Content.Headers.ContentType?.MediaType); }
        Assert.Equal(HttpStatusCode.NotFound, (await reader.Get($"/api/v1/documents/{doc}/files")).Status);          // guests cannot see organization documents at all
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.Get($"/api/v1/documents/{doc}/files")).Status);
        using (var res = await stranger.Raw($"/api/v1/documents/{doc}/files/{fileId}/download")) Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.Delete($"/api/v1/documents/{doc}/files/{fileId}")).Status);

        // A viewer cannot add or remove files.
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mia Member");
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Upload($"/api/v1/documents/{doc}/files", "note.txt", Encoding.UTF8.GetBytes("hello"))).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Delete($"/api/v1/documents/{doc}/files/{fileId}")).Status);
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Delete($"/api/v1/documents/{doc}/files/{fileId}")).Status);
        Assert.Empty((await owner.Get($"/api/v1/documents/{doc}/files")).Data!.AsArray());
    }

    [Fact]
    public async Task A_documents_files_count_against_the_workspace_storage()
    {
        var (owner, brd) = await Org();
        var doc = await Make(owner, brd, "Storage", null, "Organization");
        var before = (await owner.Get("/api/v1/attachments/limits")).Data!["storageUsedBytes"]!.GetValue<long>();
        Assert.True((await owner.Upload($"/api/v1/documents/{doc}/files", "notes.txt", Encoding.UTF8.GetBytes(new string('a', 5000)))).Ok);
        Assert.Equal(before + 5000, (await owner.Get("/api/v1/attachments/limits")).Data!["storageUsedBytes"]!.GetValue<long>());
        await owner.Delete($"/api/v1/documents/{doc}");
        Assert.Equal(before, (await owner.Get("/api/v1/attachments/limits")).Data!["storageUsedBytes"]!.GetValue<long>());   // a deleted document no longer counts
    }
}
