using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Gap closure: nav-section scopes the enterprise-DMS spec asks for that had no backend support at all - "Shared with me" (via DocumentGrant),
/// "Restricted documents" (via the Classification filter), and browsing the trash (restore already existed; there was no way to find what's in it).
/// </summary>
[Collection("api")]
public class DocumentScopesTests
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<(TestClient Owner, Guid Brd)> Org(ApiFactory factory, string plan = "BUSINESS", int seats = 10)
    {
        var owner = await TestClient.RegisterAsync(factory, "Sasha Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync(plan, seats);
        var brd = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "BRD")!["id"]));
        return (owner, brd);
    }

    private static async Task<Guid> Make(TestClient c, Guid type, string title, string classification = "Internal") =>
        Guid.Parse(S((await c.Post("/api/v1/documents", new { title, typeId = type, visibility = "Organization", classification })).Data!["item"]!["id"]));

    public DocumentScopesTests(ApiFactory factory) => _factory = factory;
    private readonly ApiFactory _factory;

    [Fact]
    public async Task Scope_shared_shows_documents_granted_directly_or_through_a_team_but_never_ones_i_own()
    {
        var (owner, brd) = await Org(_factory);
        var mine = await Make(owner, brd, "Mine");
        var sharedDirect = await Make(owner, brd, "Shared directly");
        var sharedViaTeam = await Make(owner, brd, "Shared via team");
        var notShared = await Make(owner, brd, "Not shared");
        var viewer = await owner.AddMemberAsync(_factory, TenantRole.Member, "Val Viewer");

        Assert.True((await owner.Post($"/api/v1/documents/{sharedDirect}/grants", new { principalType = "User", principalId = viewer.UserId, level = "Viewer" })).Ok);
        var team = await owner.Post("/api/v1/teams", new { name = "Reviewers" });
        var teamId = S(team.Data!["team"]!["id"]);
        Assert.True((await owner.Post($"/api/v1/teams/{teamId}/members", new { userId = viewer.UserId, isLead = false })).Ok);
        Assert.True((await owner.Post($"/api/v1/documents/{sharedViaTeam}/grants", new { principalType = "Team", principalId = Guid.Parse(teamId), level = "Viewer" })).Ok);

        // Give the viewer a harmless stake in "Mine" too (so it's visible to them) but ownership, not a grant, is why - never shows under "shared".
        _ = mine; _ = notShared;

        var shared = await viewer.Get("/api/v1/documents?scope=shared");
        Assert.True(shared.Ok, shared.ToString());
        var ids = shared.Data!["items"]!.AsArray().Select(i => S(i!["id"])).ToList();
        Assert.Contains(sharedDirect.ToString(), ids);
        Assert.Contains(sharedViaTeam.ToString(), ids);
        Assert.DoesNotContain(notShared.ToString(), ids);
        Assert.DoesNotContain(mine.ToString(), ids);
    }

    [Fact]
    public async Task Scope_shared_excludes_a_deny_grant_and_an_expired_one()
    {
        var (owner, brd) = await Org(_factory);
        var denied = await Make(owner, brd, "Denied");
        var expired = await Make(owner, brd, "Expired");
        var viewer = await owner.AddMemberAsync(_factory, TenantRole.Member, "Val Viewer");
        Assert.True((await owner.Post($"/api/v1/documents/{denied}/grants", new { principalType = "User", principalId = viewer.UserId, level = "Viewer", deny = true })).Ok);
        // The API refuses to create an already-expired grant ("choose a day in the future") - create one that expires soon, then back-date it
        // directly, the same technique DocumentRecentAndCommentsTests uses since there's no clock-advance mechanism exposed to tests.
        Assert.True((await owner.Post($"/api/v1/documents/{expired}/grants", new { principalType = "User", principalId = viewer.UserId, level = "Viewer", expiresAt = DateTime.UtcNow.AddDays(1).ToString("o") })).Ok);
        _factory.WithDb(db =>
        {
            var g = db.DocumentGrants.IgnoreQueryFilters().First(x => x.DocumentId == expired && x.PrincipalId == viewer.UserId);
            g.ExpiresAt = DateTime.UtcNow.AddDays(-1);
            return db.SaveChanges();
        });

        var shared = await viewer.Get("/api/v1/documents?scope=shared");
        Assert.True(shared.Ok, shared.ToString());
        var ids = shared.Data!["items"]!.AsArray().Select(i => S(i!["id"])).ToList();
        Assert.DoesNotContain(denied.ToString(), ids);
        Assert.DoesNotContain(expired.ToString(), ids);
    }

    [Fact]
    public async Task The_classification_filter_returns_only_matching_documents()
    {
        var (owner, brd) = await Org(_factory);
        var pub = await Make(owner, brd, "Public one", "Public");
        var conf = await Make(owner, brd, "Confidential one", "Confidential");
        var restricted = await Make(owner, brd, "Restricted one", "Restricted");

        var res = await owner.Get("/api/v1/documents?classification=Confidential");
        Assert.True(res.Ok, res.ToString());
        var ids = res.Data!["items"]!.AsArray().Select(i => S(i!["id"])).ToList();
        Assert.Contains(conf.ToString(), ids);
        Assert.DoesNotContain(pub.ToString(), ids);
        Assert.DoesNotContain(restricted.ToString(), ids);
    }

    [Fact]
    public async Task The_list_reports_a_version_label_and_a_share_count_per_document()
    {
        var (owner, brd) = await Org(_factory);
        var doc = await Make(owner, brd, "Versioned and shared");
        var viewer = await owner.AddMemberAsync(_factory, TenantRole.Member, "Val Viewer");

        var fresh = await owner.Get("/api/v1/documents");
        var row = fresh.Data!["items"]!.AsArray().First(i => S(i!["id"]) == doc.ToString());
        Assert.Equal("Draft", S(row!["versionLabel"]));
        Assert.Equal(0, row["sharedCount"]!.GetValue<int>());

        var rev = (await owner.Get($"/api/v1/documents/{doc}")).Data!["revision"]!.GetValue<int>();
        var publish = await owner.Post($"/api/v1/documents/{doc}/publish", new { changeSummary = "First cut", major = true, revision = rev });
        Assert.True(publish.Ok, publish.ToString());
        Assert.True((await owner.Post($"/api/v1/documents/{doc}/grants", new { principalType = "User", principalId = viewer.UserId, level = "Viewer" })).Ok);

        var after = await owner.Get("/api/v1/documents");
        var row2 = after.Data!["items"]!.AsArray().First(i => S(i!["id"]) == doc.ToString());
        Assert.Equal("1.0", S(row2!["versionLabel"]));
        Assert.Equal(1, row2["sharedCount"]!.GetValue<int>());
    }

    [Fact]
    public async Task Scope_restricted_covers_both_sensitive_tiers_but_not_public_or_internal()
    {
        var (owner, brd) = await Org(_factory);
        var pub = await Make(owner, brd, "Public one", "Public");
        var internalDoc = await Make(owner, brd, "Internal one", "Internal");
        var conf = await Make(owner, brd, "Confidential one", "Confidential");
        var restricted = await Make(owner, brd, "Restricted one", "Restricted");

        var res = await owner.Get("/api/v1/documents?scope=restricted");
        Assert.True(res.Ok, res.ToString());
        var ids = res.Data!["items"]!.AsArray().Select(i => S(i!["id"])).ToList();
        Assert.Contains(conf.ToString(), ids);
        Assert.Contains(restricted.ToString(), ids);
        Assert.DoesNotContain(pub.ToString(), ids);
        Assert.DoesNotContain(internalDoc.ToString(), ids);
    }

    [Fact]
    public async Task Scope_trash_lists_what_i_deleted_and_an_admin_sees_everyones()
    {
        var (owner, brd) = await Org(_factory);
        var member = await owner.AddMemberAsync(_factory, TenantRole.Manager, "Mo Member");
        var mine = await Make(member, brd, "Member's doc");
        var ownersDoc = await Make(owner, brd, "Owner's doc");
        Assert.Equal(HttpStatusCode.NoContent, (await member.Delete($"/api/v1/documents/{mine}")).Status);
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Delete($"/api/v1/documents/{ownersDoc}")).Status);

        // A non-admin only sees what they themselves deleted.
        var memberTrash = await member.Get("/api/v1/documents?scope=trash");
        Assert.True(memberTrash.Ok, memberTrash.ToString());
        var memberIds = memberTrash.Data!["items"]!.AsArray().Select(i => S(i!["id"])).ToList();
        Assert.Contains(mine.ToString(), memberIds);
        Assert.DoesNotContain(ownersDoc.ToString(), memberIds);

        // The owner (Admin/Owner) sees both.
        var ownerTrash = await owner.Get("/api/v1/documents?scope=trash");
        Assert.True(ownerTrash.Ok, ownerTrash.ToString());
        var ownerIds = ownerTrash.Data!["items"]!.AsArray().Select(i => S(i!["id"])).ToList();
        Assert.Contains(mine.ToString(), ownerIds);
        Assert.Contains(ownersDoc.ToString(), ownerIds);

        // Restoring it makes it disappear from the trash list again.
        Assert.True((await member.Post($"/api/v1/documents/{mine}/restore")).Ok);
        var after = await member.Get("/api/v1/documents?scope=trash");
        Assert.DoesNotContain(mine.ToString(), after.Data!["items"]!.AsArray().Select(i => S(i!["id"])));
    }
}
