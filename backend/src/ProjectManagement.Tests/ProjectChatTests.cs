using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The team chat of a project: open to the project's team, its owner and the organization's Owners, Admins and Managers - nobody else.
/// Supports @mentions (with a notification for the person mentioned) and keeps its unread numbers apart from the main chat.
/// </summary>
[Collection("api")]
public class ProjectChatTests(ApiFactory factory)
{
    private sealed record World(TestClient Owner, TestClient Admin, TestClient Manager, TestClient Dev, TestClient Tester, TestClient Outsider, Guid Project);

    private async Task<World> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var admin = await owner.AddMemberAsync(factory, TenantRole.Admin, "Adam Admin");
        var manager = await owner.AddMemberAsync(factory, TenantRole.Manager, "Maya Manager");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Developer");
        var tester = await owner.AddMemberAsync(factory, TenantRole.Member, "Tara Tester");
        var outsider = await owner.AddMemberAsync(factory, TenantRole.Member, "Olly Outsider");
        // The team of the project: the developer and the tester. The manager, the admin and the outsider are not on it.
        var res = await owner.Post("/api/v1/projects", new { name = "Atlas", priority = "Medium", memberIds = new[] { dev.UserId, tester.UserId } });
        Assert.True(res.Ok, res.ToString());
        return new World(owner, admin, manager, dev, tester, outsider, Guid.Parse(res.Data!["project"]!["id"]!.GetValue<string>()));
    }

    private static Task<ApiResult> Open(TestClient c, Guid project) => c.Post($"/api/v1/chat/projects/{project}/open");
    private static Guid ChatId(ApiResult r) => Guid.Parse(r.Data!["id"]!.GetValue<string>());
    private static Task<ApiResult> Say(TestClient c, Guid chat, string body) => c.Post($"/api/v1/chat/conversations/{chat}/messages", new { body });
    private static string Mention(TestClient who, string name) => $"@[{name}]({who.UserId})";

    private static async Task<JsonArray> Notifications(TestClient c) => (await c.Get("/api/v1/notifications")).Data!["items"]!.AsArray();

    // ------------------------------------------------------------------ who may use it

    [Fact]
    public async Task Only_the_project_team_and_the_organizations_owners_admins_and_managers_can_open_the_chat()
    {
        var w = await Setup();
        var first = await Open(w.Dev, w.Project);
        Assert.True(first.Ok, first.ToString());
        Assert.Equal("Project", first.Data!["type"]!.GetValue<string>());
        Assert.Equal("Atlas", first.Data["name"]!.GetValue<string>());
        Assert.Equal(w.Project.ToString(), first.Data["projectId"]!.GetValue<string>());
        var id = ChatId(first);

        // Everyone who is allowed in lands in the same chat.
        foreach (var c in new[] { w.Owner, w.Admin, w.Manager, w.Tester })
        {
            var r = await Open(c, w.Project);
            Assert.True(r.Ok, r.ToString());
            Assert.Equal(id, ChatId(r));
        }
        // The people list shows who is in it: the team plus the people who oversee the organization.
        var names = (await Open(w.Dev, w.Project)).Data!["members"]!.AsArray().Select(m => m!["name"]!.GetValue<string>()).ToArray();
        Assert.Equal(new[] { "Adam Admin", "Dev Developer", "Maya Manager", "Olivia Owner", "Tara Tester" }, names.OrderBy(n => n).ToArray());

        // Somebody who is not on the project gets "not found", as for a project that does not exist - and cannot read or write by guessing the id.
        var no = await Open(w.Outsider, w.Project);
        Assert.Equal(404, (int)no.Status);
        Assert.Equal(404, (int)(await w.Outsider.Get($"/api/v1/chat/conversations/{id}/messages")).Status);
        Assert.Equal(404, (int)(await Say(w.Outsider, id, "let me in")).Status);
        Assert.Equal(404, (int)(await w.Outsider.Get($"/api/v1/chat/conversations/{id}")).Status);
    }

    [Fact]
    public async Task Guests_and_people_of_other_workspaces_have_no_access()
    {
        var w = await Setup();
        var guest = await w.Owner.AddMemberAsync(factory, TenantRole.Guest, "Gus Guest");
        Assert.True((await w.Owner.Post($"/api/v1/projects/{w.Project}/members", new { userId = guest.UserId })).Ok);
        Assert.Equal(403, (int)(await Open(guest, w.Project)).Status);        // guests never use chat, even on their own project

        var stranger = await TestClient.RegisterAsync(factory, "Sam Stranger");
        await stranger.CreateOrgAsync();
        Assert.Equal(404, (int)(await Open(stranger, w.Project)).Status);
    }

    [Fact]
    public async Task Leaving_the_project_ends_access_at_once_and_joining_it_gives_access()
    {
        var w = await Setup();
        var chat = ChatId(await Open(w.Dev, w.Project));
        Assert.True((await Say(w.Dev, chat, "hello team")).Ok);
        Assert.True((await w.Owner.Delete($"/api/v1/projects/{w.Project}/members/{w.Dev.UserId}")).Ok);
        Assert.Equal(404, (int)(await Open(w.Dev, w.Project)).Status);
        Assert.Equal(404, (int)(await w.Dev.Get($"/api/v1/chat/conversations/{chat}/messages")).Status);

        Assert.Equal(404, (int)(await Open(w.Outsider, w.Project)).Status);
        Assert.True((await w.Owner.Post($"/api/v1/projects/{w.Project}/members", new { userId = w.Outsider.UserId })).Ok);
        var joined = await Open(w.Outsider, w.Project);
        Assert.True(joined.Ok, joined.ToString());
        // A person who joins sees the project's whole conversation.
        Assert.Contains((await w.Outsider.Get($"/api/v1/chat/conversations/{chat}/messages")).Data!["items"]!.AsArray(), m => m!["body"]!.GetValue<string>() == "hello team");
    }

    // ------------------------------------------------------------------ messages

    [Fact]
    public async Task Members_send_and_receive_and_project_chats_stay_out_of_the_main_chat()
    {
        var w = await Setup();
        var chat = ChatId(await Open(w.Tester, w.Project));
        Assert.True((await Say(w.Tester, chat, "Build 42 is ready for testing")).Ok);

        // The developer has one unread message for this project...
        var unread = (await w.Dev.Get("/api/v1/chat/projects/unread")).Data!.AsArray();
        Assert.Single(unread);
        Assert.Equal(w.Project.ToString(), unread[0]!["projectId"]!.GetValue<string>());
        Assert.Equal(1, unread[0]!["unread"]!.GetValue<int>());
        Assert.Equal(0, unread[0]!["mentions"]!.GetValue<int>());
        Assert.Equal(1, (await Open(w.Dev, w.Project)).Data!["unread"]!.GetValue<int>());
        // ...but it does not appear in the main chat: not in the conversation list, not in the badge, not in search.
        Assert.Empty((await w.Dev.Get("/api/v1/chat/conversations")).Data!.AsArray());
        Assert.Equal(0, (await w.Dev.Get("/api/v1/chat/unread")).Data!["count"]!.GetValue<int>());
        Assert.Empty((await w.Dev.Get("/api/v1/chat/search?q=Build")).Data!.AsArray());

        // The sender has nothing unread; reading clears it for the reader.
        Assert.Empty((await w.Tester.Get("/api/v1/chat/projects/unread")).Data!.AsArray());
        Assert.True((await w.Dev.Post($"/api/v1/chat/conversations/{chat}/read")).Ok);
        Assert.Empty((await w.Dev.Get("/api/v1/chat/projects/unread")).Data!.AsArray());

        // The people who oversee the organization see it too, and can answer.
        var seen = (await w.Manager.Get($"/api/v1/chat/conversations/{chat}/messages")).Data!["items"]!.AsArray();
        Assert.Contains(seen, m => m!["body"]!.GetValue<string>().StartsWith("Build 42"));
        Assert.True((await Say(w.Manager, chat, "Thanks, on it")).Ok);
    }

    [Fact]
    public async Task Only_admins_and_the_owner_can_remove_other_peoples_messages_and_an_archived_project_chat_is_read_only()
    {
        var w = await Setup();
        var chat = ChatId(await Open(w.Dev, w.Project));
        var m1 = Guid.Parse((await Say(w.Dev, chat, "first")).Data!["id"]!.GetValue<string>());
        var m2 = Guid.Parse((await Say(w.Dev, chat, "second")).Data!["id"]!.GetValue<string>());

        Assert.Equal(403, (int)(await w.Tester.Delete($"/api/v1/chat/messages/{m1}")).Status);   // a team mate cannot
        Assert.Equal(403, (int)(await w.Manager.Delete($"/api/v1/chat/messages/{m1}")).Status);  // and neither can a manager
        Assert.Equal(204, (int)(await w.Admin.Delete($"/api/v1/chat/messages/{m1}")).Status);         // an admin can
        Assert.Equal(204, (int)(await w.Dev.Delete($"/api/v1/chat/messages/{m2}")).Status);       // you can always remove your own
        var left = (await w.Owner.Get($"/api/v1/chat/conversations/{chat}/messages")).Data!["items"]!.AsArray();
        Assert.All(left, m => Assert.True(m!["isDeleted"]!.GetValue<bool>()));

        // An archived project is read-only, chat included.
        var archive = await w.Owner.Send(HttpMethod.Patch, $"/api/v1/projects/{w.Project}/move", new { status = "Archived" });
        Assert.True(archive.Ok, archive.ToString());
        var blocked = await Say(w.Dev, chat, "anyone there?");
        Assert.Equal(409, (int)blocked.Status);
        Assert.Equal("PROJECT_ARCHIVED", blocked.ErrorCode);
    }

    // ------------------------------------------------------------------ mentions

    [Fact]
    public async Task A_mention_notifies_the_person_and_shows_as_unread_mention_until_they_read_the_chat()
    {
        var w = await Setup();
        var chat = ChatId(await Open(w.Tester, w.Project));
        var sent = await Say(w.Tester, chat, $"{Mention(w.Dev, "Dev Developer")} please look at the login bug");
        Assert.True(sent.Ok, sent.ToString());
        Assert.Contains($"@[Dev Developer]({w.Dev.UserId})", sent.Data!["body"]!.GetValue<string>());

        // The mentioned developer gets a notification that leads to the chat...
        var note = (await Notifications(w.Dev)).Single(n => n!["type"]!.GetValue<string>() == "Mention")!;
        Assert.Contains("Tara Tester mentioned you in Atlas", note["title"]!.GetValue<string>());
        Assert.Contains("@Dev Developer please look at the login bug", note["body"]!.GetValue<string>());   // the words, not the markup
        Assert.Equal($"/projects/{w.Project}?chat=1", note["link"]!.GetValue<string>());
        // ...somebody who was not mentioned does not, and neither does the person who wrote it.
        Assert.DoesNotContain(await Notifications(w.Manager), n => n!["type"]!.GetValue<string>() == "Mention");
        Assert.DoesNotContain(await Notifications(w.Tester), n => n!["type"]!.GetValue<string>() == "Mention");

        // The indicator: one unread message that mentions the developer, until they read it.
        var unread = (await w.Dev.Get("/api/v1/chat/projects/unread")).Data!.AsArray().Single()!;
        Assert.Equal(1, unread["mentions"]!.GetValue<int>());
        Assert.Equal(1, (await Open(w.Dev, w.Project)).Data!["unreadMentions"]!.GetValue<int>());
        Assert.Equal(0, (await w.Manager.Get("/api/v1/chat/projects/unread")).Data!.AsArray().Single()!["mentions"]!.GetValue<int>());
        Assert.True((await w.Dev.Post($"/api/v1/chat/conversations/{chat}/read")).Ok);
        Assert.Empty((await w.Dev.Get("/api/v1/chat/projects/unread")).Data!.AsArray());
        Assert.Equal(0, (await Open(w.Dev, w.Project)).Data!["unreadMentions"]!.GetValue<int>());
    }

    [Fact]
    public async Task Only_people_who_are_in_the_chat_can_be_mentioned_and_names_cannot_be_forged()
    {
        var w = await Setup();
        var chat = ChatId(await Open(w.Dev, w.Project));
        // The outsider is not in this chat, so a mention of them is plain text and they hear nothing.
        var res = await Say(w.Dev, chat, $"cc {Mention(w.Outsider, "Olly Outsider")} and {Mention(w.Manager, "Definitely Someone Else")}");
        Assert.True(res.Ok, res.ToString());
        var body = res.Data!["body"]!.GetValue<string>();
        Assert.Contains("cc @Olly Outsider and", body);                                       // turned into plain text
        Assert.Contains($"@[Maya Manager]({w.Manager.UserId})", body);                        // the real name replaces the forged one
        Assert.DoesNotContain(await Notifications(w.Outsider), n => n!["type"]!.GetValue<string>() == "Mention");
        Assert.Single(await Notifications(w.Manager), n => n!["type"]!.GetValue<string>() == "Mention");
    }

    [Fact]
    public async Task Editing_a_message_notifies_only_the_people_newly_mentioned()
    {
        var w = await Setup();
        var chat = ChatId(await Open(w.Dev, w.Project));
        var sent = await Say(w.Dev, chat, $"{Mention(w.Tester, "Tara Tester")} can you check this?");
        var id = Guid.Parse(sent.Data!["id"]!.GetValue<string>());
        Assert.Single(await Notifications(w.Tester), n => n!["type"]!.GetValue<string>() == "Mention");

        var edited = await w.Dev.Put($"/api/v1/chat/messages/{id}", new { body = $"{Mention(w.Tester, "Tara Tester")} and {Mention(w.Admin, "Adam Admin")} can you check this?" });
        Assert.True(edited.Ok, edited.ToString());
        Assert.Single(await Notifications(w.Tester), n => n!["type"]!.GetValue<string>() == "Mention");   // not told twice
        Assert.Single(await Notifications(w.Admin), n => n!["type"]!.GetValue<string>() == "Mention");    // the newly mentioned person is
    }

    [Fact]
    public async Task Mentions_in_a_private_chat_are_just_text()
    {
        var w = await Setup();
        var dm = (await w.Dev.Post("/api/v1/chat/conversations/direct", new { userId = w.Tester.UserId })).Data!["id"]!.GetValue<string>();
        var res = await w.Dev.Post($"/api/v1/chat/conversations/{dm}/messages", new { body = $"hi {Mention(w.Tester, "Tara Tester")}" });
        Assert.True(res.Ok, res.ToString());
        Assert.Equal("hi @Tara Tester", res.Data!["body"]!.GetValue<string>());
        Assert.DoesNotContain(await Notifications(w.Tester), n => n!["type"]!.GetValue<string>() == "Mention");
    }
}
