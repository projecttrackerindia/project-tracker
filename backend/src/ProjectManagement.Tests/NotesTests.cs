using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Notes (/api/v1/notes): write, edit, pin, tag and search; private until shared (with people or the workspace); people shared on a note can
/// edit it but only its owner shares or deletes it; an @mention tells the person once; nothing crosses workspaces.
/// </summary>
[Collection("api")]
public class NotesTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private static object[] Blocks(string text, Guid? mention = null) =>
    [
        new { type = "heading", text = "Before the cut" },
        new { type = "check", text, done = false },
        new { type = "paragraph", text = "Owner on call", marks = mention is { } m ? new object[] { new { type = "mention", userId = m, label = "@Tom" } } : Array.Empty<object>() },
    ];

    [Fact]
    public async Task Notes_are_written_searched_pinned_and_tagged()
    {
        var owner = await TestClient.RegisterAsync(factory, "Nora Notes");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        var project = await owner.CreateProjectAsync("Atlas");

        var created = await owner.Post("/api/v1/notes", new { title = "Release 2.4 checklist", content = Blocks("Freeze main at 14:30"), folder = "Atlas", tags = new[] { "#Release", "qa" }, projectId = project });
        Assert.True(created.Status == HttpStatusCode.Created, created.ToString());
        var id = S(created.Data!["id"]);
        Assert.Equal(new[] { "release", "qa" }, created.Data["tags"]!.AsArray().Select(S).ToArray());
        Assert.Equal("heading", S(created.Data["content"]![0]!["type"]));
        await owner.Post("/api/v1/notes", new { title = "Reading list", content = Blocks("Shape Up"), folder = "Personal" });

        var found = await owner.Get("/api/v1/notes?q=freeze%20main");
        Assert.Single(found.Data!["items"]!.AsArray());
        Assert.Equal(id, S(found.Data["items"]![0]!["id"]));
        Assert.Single((await owner.Get("/api/v1/notes?tag=release")).Data!["items"]!.AsArray());
        Assert.Single((await owner.Get("/api/v1/notes?folder=personal")).Data!["items"]!.AsArray());

        var pinned = await owner.Patch($"/api/v1/notes/{id}", new { pinned = true, title = "Release 2.4 checklist (final)" });
        Assert.True(pinned.Ok, pinned.ToString());
        Assert.Equal("Release 2.4 checklist (final)", S(pinned.Data!["title"]));
        Assert.Equal("Freeze main at 14:30", S(pinned.Data["content"]![1]!["text"]));   // untouched fields stay
        var list = await owner.Get("/api/v1/notes");
        Assert.Equal(1, list.Data!["counts"]!["pinned"]!.GetValue<int>());
        Assert.Equal(id, S(list.Data["items"]![0]!["id"]));   // pinned first
        Assert.Contains(list.Data["folders"]!.AsArray(), f => S(f!["name"]) == "Atlas");

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post("/api/v1/notes", new { title = "x", content = new { not = "a list" } })).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Post("/api/v1/notes", new { title = "x", projectId = Guid.NewGuid() })).Status);

        Assert.Equal(HttpStatusCode.NoContent, (await owner.Delete($"/api/v1/notes/{id}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Get($"/api/v1/notes/{id}")).Status);
    }

    [Fact]
    public async Task Notes_are_private_until_shared_and_stay_in_their_workspace()
    {
        var owner = await TestClient.RegisterAsync(factory, "Sana Share");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        var mei = await owner.AddMemberAsync(factory, TenantRole.Member, "Mei Member");
        var tom = await owner.AddMemberAsync(factory, TenantRole.Member, "Tom Member");

        var created = await owner.Post("/api/v1/notes", new { title = "1:1 with Lena", content = Blocks("Option B", mention: tom.UserId) });
        var id = S(created.Data!["id"]);
        Assert.Contains((await tom.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), n => S(n!["link"]) == $"/notes?open={id}");

        Assert.Equal(HttpStatusCode.NotFound, (await mei.Get($"/api/v1/notes/{id}")).Status);
        Assert.Empty((await mei.Get("/api/v1/notes")).Data!["items"]!.AsArray());

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put($"/api/v1/notes/{id}/sharing", new { sharing = "people", userIds = Array.Empty<Guid>() })).Status);
        var shared = await owner.Put($"/api/v1/notes/{id}/sharing", new { sharing = "people", userIds = new[] { mei.UserId } });
        Assert.True(shared.Ok, shared.ToString());
        Assert.True((await mei.Get($"/api/v1/notes/{id}")).Ok);
        Assert.Equal(1, (await mei.Get("/api/v1/notes?view=shared")).Data!["counts"]!["shared"]!.GetValue<int>());
        Assert.Equal(HttpStatusCode.NotFound, (await tom.Get($"/api/v1/notes/{id}")).Status);

        // Shared people edit; only the owner shares or deletes.
        Assert.True((await mei.Patch($"/api/v1/notes/{id}", new { content = Blocks("Option B, illustration set") })).Ok);
        Assert.Equal(HttpStatusCode.NotFound, (await mei.Put($"/api/v1/notes/{id}/sharing", new { sharing = "workspace" })).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await mei.Delete($"/api/v1/notes/{id}")).Status);

        Assert.True((await owner.Put($"/api/v1/notes/{id}/sharing", new { sharing = "workspace" })).Ok);
        Assert.True((await tom.Get($"/api/v1/notes/{id}")).Ok);

        var outsider = await TestClient.RegisterAsync(factory, "Olly Outsider");
        await outsider.CreateOrgAsync();
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Get($"/api/v1/notes/{id}")).Status);
        Assert.Empty((await outsider.Get("/api/v1/notes")).Data!["items"]!.AsArray());
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Patch($"/api/v1/notes/{id}", new { title = "mine now" })).Status);
    }
}
