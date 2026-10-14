using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Gap closure: "Recently viewed" document tracking (a per-viewer <see cref="DocumentView"/> row, upserted and throttled on every GET of a document)
/// and document comments (<see cref="DocumentComment"/>, a running conversation anyone who may open the document can read and add to, distinct
/// from an approval decision's comment).
/// </summary>
[Collection("api")]
public class DocumentRecentAndCommentsTests(ApiFactory factory) : IAsyncLifetime
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    /// <summary>Notice e-mail/push delivery would otherwise crowd the batch other notification tests count on (same cleanup as DocumentSharingTests).</summary>
    public Task DisposeAsync()
    {
        factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.Type == NotificationType.Document && (n.EmailPending || n.PushPending)).ExecuteUpdate(s => s.SetProperty(n => n.EmailPending, false).SetProperty(n => n.PushPending, false)));
        return Task.CompletedTask;
    }
    public Task InitializeAsync() => Task.CompletedTask;

    private async Task<(TestClient Owner, Guid Brd)> Org(string plan = "BUSINESS", int seats = 10)
    {
        var owner = await TestClient.RegisterAsync(factory, "Rowan Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync(plan, seats);
        var brd = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "BRD")!["id"]));
        return (owner, brd);
    }

    private static async Task<Guid> Make(TestClient c, Guid type, string title) =>
        Guid.Parse(S((await c.Post("/api/v1/documents", new { title, typeId = type, visibility = "Organization" })).Data!["item"]!["id"]));

    // ------------------------------------------------------------------ recently viewed

    [Fact]
    public async Task Opening_a_document_creates_a_view_row_once_and_a_second_open_right_after_does_not_write_again()
    {
        var (owner, brd) = await Org();
        var doc = await Make(owner, brd, "Pricing strategy");

        var get1 = await owner.Get($"/api/v1/documents/{doc}");
        Assert.True(get1.Ok, get1.ToString());
        var rows1 = factory.WithDb(db => db.DocumentViews.IgnoreQueryFilters().Where(v => v.DocumentId == doc && v.UserId == owner.UserId).ToList());
        var row = Assert.Single(rows1);
        var firstViewedAt = row.ViewedAt;

        // A second GET moments later is throttled: the row is not touched again (still exactly one row, same timestamp).
        await Task.Delay(50);
        var get2 = await owner.Get($"/api/v1/documents/{doc}");
        Assert.True(get2.Ok, get2.ToString());
        var rows2 = factory.WithDb(db => db.DocumentViews.IgnoreQueryFilters().Where(v => v.DocumentId == doc && v.UserId == owner.UserId).ToList());
        var row2 = Assert.Single(rows2);
        Assert.Equal(firstViewedAt, row2.ViewedAt);
    }

    [Fact]
    public async Task A_view_older_than_the_throttle_window_is_refreshed_not_duplicated()
    {
        var (owner, brd) = await Org();
        var doc = await Make(owner, brd, "Old view");
        Assert.True((await owner.Get($"/api/v1/documents/{doc}")).Ok);

        // Back-date the row past the 5-minute throttle window directly in the database (no clock-advance mechanism is exposed to tests).
        var staleAt = DateTime.UtcNow.AddMinutes(-10);
        factory.WithDb(db =>
        {
            var row = db.DocumentViews.IgnoreQueryFilters().First(v => v.DocumentId == doc && v.UserId == owner.UserId);
            row.ViewedAt = staleAt;
            return db.SaveChanges();
        });

        Assert.True((await owner.Get($"/api/v1/documents/{doc}")).Ok);
        var rows = factory.WithDb(db => db.DocumentViews.IgnoreQueryFilters().Where(v => v.DocumentId == doc && v.UserId == owner.UserId).ToList());
        var row2 = Assert.Single(rows);   // still one row, not a second one
        Assert.True(row2.ViewedAt > staleAt);
    }

    [Fact]
    public async Task Scope_recent_returns_viewed_documents_newest_first_and_excludes_ones_never_opened()
    {
        var (owner, brd) = await Org();
        var a = await Make(owner, brd, "Doc A");
        var b = await Make(owner, brd, "Doc B");
        var c = await Make(owner, brd, "Doc C (never opened)");
        Assert.True((await owner.Get($"/api/v1/documents/{a}")).Ok);
        await Task.Delay(20);
        Assert.True((await owner.Get($"/api/v1/documents/{b}")).Ok);   // viewed after A, so should come first

        var recent = await owner.Get("/api/v1/documents?scope=recent");
        Assert.True(recent.Ok, recent.ToString());
        var ids = recent.Data!["items"]!.AsArray().Select(i => S(i!["id"])).ToList();
        Assert.Equal(new[] { b.ToString(), a.ToString() }, ids);
        Assert.DoesNotContain(c.ToString(), ids);
    }

    [Fact]
    public async Task Scope_recent_never_shows_a_document_whose_access_was_since_revoked()
    {
        var (owner, brd) = await Org();
        var doc = await Make(owner, brd, "Private later");
        var viewer = await owner.AddMemberAsync(factory, TenantRole.Member, "Vicky Viewer");
        Assert.True((await viewer.Get($"/api/v1/documents/{doc}")).Ok);
        var beforeRevoke = await viewer.Get("/api/v1/documents?scope=recent");
        Assert.Single(beforeRevoke.Data!["items"]!.AsArray());

        // The owner makes it private to themself - the viewer can no longer open it at all.
        var rev = (await owner.Get($"/api/v1/documents/{doc}")).Data!["revision"]!.GetValue<int>();
        var update = await owner.Put($"/api/v1/documents/{doc}", new { title = "Private later", visibility = "Private", tags = Array.Empty<string>(), revision = rev });
        Assert.True(update.Ok, update.ToString());

        Assert.Equal(HttpStatusCode.NotFound, (await viewer.Get($"/api/v1/documents/{doc}")).Status);   // not visible at all now
        var recent = await viewer.Get("/api/v1/documents?scope=recent");
        Assert.True(recent.Ok, recent.ToString());
        Assert.Empty(recent.Data!["items"]!.AsArray());   // the revoked document never resurfaces through "recently viewed" either
    }

    // ------------------------------------------------------------------ comments

    [Fact]
    public async Task Comments_can_be_listed_and_added_and_are_audited()
    {
        var (owner, brd) = await Org();
        var doc = await Make(owner, brd, "Discuss me");

        var empty = await owner.Get($"/api/v1/documents/{doc}/comments");
        Assert.True(empty.Ok, empty.ToString());
        Assert.Empty(empty.Data!.AsArray());

        var add = await owner.Post($"/api/v1/documents/{doc}/comments", new { body = "Looks good, one nit on section 2." });
        Assert.Equal(HttpStatusCode.Created, add.Status);
        Assert.Equal("Looks good, one nit on section 2.", S(add.Data!["body"]));
        Assert.True(add.Data!["mine"]!.GetValue<bool>());

        var list = await owner.Get($"/api/v1/documents/{doc}/comments");
        Assert.True(list.Ok, list.ToString());
        var items = list.Data!.AsArray();
        Assert.Single(items);
        Assert.Equal("Looks good, one nit on section 2.", S(items[0]!["body"]));

        var actions = factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Where(a => a.EntityId == doc).Select(a => a.Action).ToList());
        Assert.Contains("document.comment_added", actions);
    }

    [Fact]
    public async Task An_empty_or_too_long_comment_is_rejected()
    {
        var (owner, brd) = await Org();
        var doc = await Make(owner, brd, "Validate me");
        Assert.False((await owner.Post($"/api/v1/documents/{doc}/comments", new { body = "   " })).Ok);
        Assert.False((await owner.Post($"/api/v1/documents/{doc}/comments", new { body = new string('x', 4001) })).Ok);
        Assert.True((await owner.Post($"/api/v1/documents/{doc}/comments", new { body = new string('x', 4000) })).Ok);
    }

    [Fact]
    public async Task Someone_who_cannot_open_the_document_cannot_add_a_comment()
    {
        var (owner, brd) = await Org();
        var doc = Guid.Parse(S((await owner.Post("/api/v1/documents", new { title = "Owner only", typeId = brd, visibility = "Private" })).Data!["item"]!["id"]));
        var outsider = await owner.AddMemberAsync(factory, TenantRole.Member, "Oscar Outsider");

        // A private document does not exist for anyone but its owner (and org admins) - the same not-found convention SecretService uses for a
        // document that is not visible, never a 403 that would confirm the document exists.
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Get($"/api/v1/documents/{doc}/comments")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Post($"/api/v1/documents/{doc}/comments", new { body = "Let me in?" })).Status);
    }

    [Fact]
    public async Task Adding_a_comment_notifies_the_owner_and_prior_commenters_but_never_the_commenter_themselves()
    {
        var (owner, brd) = await Org(seats: 10);
        var doc = await Make(owner, brd, "Team doc");
        var alice = await owner.AddMemberAsync(factory, TenantRole.Member, "Alice");
        var bob = await owner.AddMemberAsync(factory, TenantRole.Member, "Bob");

        // Alice comments first: the owner should be notified (Alice is not the owner), but Alice herself should not be.
        Assert.True((await alice.Post($"/api/v1/documents/{doc}/comments", new { body = "First comment" })).Ok);
        var afterAlice = factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.Type == NotificationType.Document && n.Link == $"/documents/{doc}").ToList());
        Assert.Contains(afterAlice, n => n.UserId == owner.UserId);
        Assert.DoesNotContain(afterAlice, n => n.UserId == alice.UserId);

        // Bob comments next: both the owner and Alice (a prior commenter) are notified; Bob himself is not.
        Assert.True((await bob.Post($"/api/v1/documents/{doc}/comments", new { body = "Second comment" })).Ok);
        var afterBob = factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.Type == NotificationType.Document && n.Link == $"/documents/{doc}").ToList());
        Assert.Contains(afterBob, n => n.UserId == owner.UserId);
        Assert.Contains(afterBob, n => n.UserId == alice.UserId);
        Assert.DoesNotContain(afterBob, n => n.UserId == bob.UserId);
    }
}
