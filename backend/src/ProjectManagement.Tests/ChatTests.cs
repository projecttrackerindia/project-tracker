using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Chat: private chats and groups, who may see what, unread counts, edits and deletes, and live delivery through the hub.</summary>
[Collection("api")]
public class ChatTests(ApiFactory factory)
{
    private record Team(TestClient Ravi, TestClient Priya, TestClient Kumar);

    private async Task<Team> BuildTeam()
    {
        var ravi = await TestClient.RegisterAsync(factory, "Ravi");
        await ravi.CreateOrgAsync();
        await ravi.UpgradeAsync("BUSINESS");
        var priya = await ravi.AddMemberAsync(factory, TenantRole.Member, "Priya");
        var kumar = await ravi.AddMemberAsync(factory, TenantRole.Member, "Kumar");
        return new Team(ravi, priya, kumar);
    }

    private static async Task<string> Direct(TestClient from, TestClient to)
    {
        var res = await from.Post("/api/v1/chat/conversations/direct", new { userId = to.UserId });
        Assert.True(res.Ok, res.ToString());
        return res.Data!["id"]!.GetValue<string>();
    }

    private static async Task<string> Group(TestClient from, string name, params TestClient[] others)
    {
        var res = await from.Post("/api/v1/chat/conversations/group", new { name, memberIds = others.Select(o => o.UserId).ToArray() });
        Assert.Equal(HttpStatusCode.Created, res.Status);
        return res.Data!["id"]!.GetValue<string>();
    }

    private static async Task<JsonNode> Say(TestClient who, string conversation, string body, string? replyTo = null)
    {
        var res = await who.Post($"/api/v1/chat/conversations/{conversation}/messages", new { body, replyToId = replyTo });
        Assert.Equal(HttpStatusCode.Created, res.Status);
        return res.Data!;
    }

    private static async Task<JsonNode> Thread(TestClient who, string conversation, string query = "")
    {
        var res = await who.Get($"/api/v1/chat/conversations/{conversation}/messages{query}");
        Assert.True(res.Ok, res.ToString());
        return res.Data!;
    }

    private static async Task<JsonNode?> InList(TestClient who, string conversation) =>
        (await who.Get("/api/v1/chat/conversations")).Data!.AsArray().FirstOrDefault(c => c!["id"]!.GetValue<string>() == conversation);

    private static string[] Bodies(JsonNode page) => page["items"]!.AsArray().Select(m => m!["body"]!.GetValue<string>()).ToArray();

    // ------------------------------------------------------------------ who may chat

    [Fact]
    public async Task Chat_is_for_organizations_and_not_for_guests_or_personal_workspaces()
    {
        var personal = await TestClient.RegisterAsync(factory);
        var res = await personal.Get("/api/v1/chat/conversations");
        Assert.Equal(HttpStatusCode.Forbidden, res.Status);
        Assert.Equal("CHAT_NOT_AVAILABLE", res.ErrorCode);

        var (ravi, _, _) = await BuildTeam();
        var guest = await ravi.AddMemberAsync(factory, TenantRole.Guest, "Guest");
        Assert.Equal("CHAT_NOT_AVAILABLE", (await guest.Get("/api/v1/chat/people")).ErrorCode);
        // Nor can a guest be picked as somebody to talk to.
        var people = (await ravi.Get("/api/v1/chat/people")).Data!.AsArray().Select(p => p!["name"]!.GetValue<string>()).ToArray();
        Assert.DoesNotContain("Guest", people);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await ravi.Post("/api/v1/chat/conversations/direct", new { userId = guest.UserId })).Status);
    }

    [Fact]
    public async Task People_lists_the_other_members_only()
    {
        var (ravi, _, _) = await BuildTeam();
        var names = (await ravi.Get("/api/v1/chat/people")).Data!.AsArray().Select(p => p!["name"]!.GetValue<string>()).OrderBy(n => n).ToArray();
        Assert.Equal(["Kumar", "Priya"], names);
    }

    // ------------------------------------------------------------------ direct chats

    [Fact]
    public async Task Two_people_share_one_direct_chat_whoever_opens_it()
    {
        var (ravi, priya, _) = await BuildTeam();
        var fromRavi = await Direct(ravi, priya);
        Assert.Equal(fromRavi, await Direct(priya, ravi));
        Assert.Equal(fromRavi, await Direct(ravi, priya));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await ravi.Post("/api/v1/chat/conversations/direct", new { userId = ravi.UserId })).Status);

        var dto = (await ravi.Get($"/api/v1/chat/conversations/{fromRavi}")).Data!;
        Assert.Equal("Direct", dto["type"]!.GetValue<string>());
        Assert.Equal("Priya", dto["name"]!.GetValue<string>());                       // named after the other person...
        Assert.Equal("Ravi", (await priya.Get($"/api/v1/chat/conversations/{fromRavi}")).Data!["name"]!.GetValue<string>());   // ...for each of them
    }

    [Fact]
    public async Task A_chat_someone_opened_stays_hidden_until_they_write()
    {
        var (ravi, priya, _) = await BuildTeam();
        var id = await Direct(ravi, priya);
        Assert.NotNull(await InList(ravi, id));      // the person who opened it sees it
        Assert.Null(await InList(priya, id));        // the other person does not, yet

        await Say(ravi, id, "Hi Priya");
        Assert.NotNull(await InList(priya, id));
    }

    [Fact]
    public async Task Messages_arrive_with_unread_counts_that_clear_when_read()
    {
        var (ravi, priya, _) = await BuildTeam();
        var id = await Direct(ravi, priya);
        await Say(ravi, id, "First");
        await Say(ravi, id, "Second");

        var forPriya = (await InList(priya, id))!;
        Assert.Equal(2, forPriya["unread"]!.GetValue<int>());
        Assert.Equal("Second", forPriya["lastMessage"]!["snippet"]!.GetValue<string>());
        Assert.Equal(2, (await priya.Get("/api/v1/chat/unread")).Data!["count"]!.GetValue<int>());
        Assert.Equal(0, (await InList(ravi, id))!["unread"]!.GetValue<int>());         // your own messages are never unread

        Assert.Equal(HttpStatusCode.NoContent, (await priya.Post($"/api/v1/chat/conversations/{id}/read")).Status);
        Assert.Equal(0, (await InList(priya, id))!["unread"]!.GetValue<int>());
        Assert.Equal(0, (await priya.Get("/api/v1/chat/unread")).Data!["count"]!.GetValue<int>());

        await Say(priya, id, "Thanks");
        Assert.Equal(1, (await InList(ravi, id))!["unread"]!.GetValue<int>());
        Assert.Equal(["First", "Second", "Thanks"], Bodies(await Thread(ravi, id)));
    }

    [Fact]
    public async Task Muted_conversations_do_not_count_towards_the_badge()
    {
        var (ravi, priya, _) = await BuildTeam();
        var id = await Direct(ravi, priya);
        await Say(ravi, id, "ping");
        Assert.Equal(1, (await priya.Get("/api/v1/chat/unread")).Data!["count"]!.GetValue<int>());

        Assert.Equal(HttpStatusCode.NoContent, (await priya.Put($"/api/v1/chat/conversations/{id}/mute", new { muted = true })).Status);
        Assert.Equal(0, (await priya.Get("/api/v1/chat/unread")).Data!["count"]!.GetValue<int>());
        Assert.True((await InList(priya, id))!["isMuted"]!.GetValue<bool>());
        Assert.Equal(1, (await InList(priya, id))!["unread"]!.GetValue<int>());   // still counted on the conversation itself
    }

    // ------------------------------------------------------------------ messages

    [Fact]
    public async Task Messages_are_validated_and_replies_must_stay_in_the_conversation()
    {
        var (ravi, priya, kumar) = await BuildTeam();
        var id = await Direct(ravi, priya);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await ravi.Post($"/api/v1/chat/conversations/{id}/messages", new { body = "   " })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await ravi.Post($"/api/v1/chat/conversations/{id}/messages", new { body = new string('x', 4001) })).Status);
        Assert.Equal(HttpStatusCode.Created, (await ravi.Post($"/api/v1/chat/conversations/{id}/messages", new { body = new string('x', 4000) })).Status);

        var other = await Direct(ravi, kumar);
        var elsewhere = await Say(ravi, other, "In another chat");
        var bad = await ravi.Post($"/api/v1/chat/conversations/{id}/messages", new { body = "re", replyToId = elsewhere["id"]!.GetValue<string>() });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, bad.Status);

        var first = await Say(ravi, id, "Question?");
        var reply = await Say(priya, id, "Answer.", first["id"]!.GetValue<string>());
        Assert.Equal("Question?", reply["replyTo"]!["snippet"]!.GetValue<string>());
        Assert.Equal("Ravi", reply["replyTo"]!["senderName"]!.GetValue<string>());
    }

    [Fact]
    public async Task People_can_edit_and_delete_only_their_own_messages()
    {
        var (ravi, priya, _) = await BuildTeam();
        var id = await Direct(ravi, priya);
        var msg = (await Say(ravi, id, "Typo here"))["id"]!.GetValue<string>();

        Assert.Equal("MESSAGE_NOT_YOURS", (await priya.Put($"/api/v1/chat/messages/{msg}", new { body = "hijack" })).ErrorCode);
        Assert.Equal("MESSAGE_NOT_YOURS", (await priya.Delete($"/api/v1/chat/messages/{msg}")).ErrorCode);

        var edited = await ravi.Put($"/api/v1/chat/messages/{msg}", new { body = "Fixed" });
        Assert.True(edited.Ok, edited.ToString());
        Assert.NotNull(edited.Data!["editedAt"]);
        Assert.Equal("Fixed", (await InList(priya, id))!["lastMessage"]!["snippet"]!.GetValue<string>());

        Assert.Equal(HttpStatusCode.NoContent, (await ravi.Delete($"/api/v1/chat/messages/{msg}")).Status);
        var page = await Thread(priya, id);
        var item = page["items"]!.AsArray().Single()!;
        Assert.True(item["isDeleted"]!.GetValue<bool>());
        Assert.Equal("", item["body"]!.GetValue<string>());                                            // the text is gone, not just hidden
        Assert.Equal("MESSAGE_DELETED", (await ravi.Put($"/api/v1/chat/messages/{msg}", new { body = "again" })).ErrorCode);
    }

    [Fact]
    public async Task Long_threads_load_in_pages_from_the_newest_end()
    {
        var (ravi, priya, _) = await BuildTeam();
        var id = await Direct(ravi, priya);
        for (var i = 1; i <= 25; i++) await Say(ravi, id, $"m{i:00}");

        var newest = await Thread(priya, id, "?limit=10");
        Assert.True(newest["hasMore"]!.GetValue<bool>());
        Assert.Equal(Enumerable.Range(16, 10).Select(i => $"m{i:00}"), Bodies(newest));

        var before = Uri.EscapeDataString(newest["items"]![0]!["createdAt"]!.GetValue<string>());
        var older = await Thread(priya, id, $"?limit=10&before={before}");
        Assert.Equal(Enumerable.Range(6, 10).Select(i => $"m{i:00}"), Bodies(older));

        var before2 = Uri.EscapeDataString(older["items"]![0]!["createdAt"]!.GetValue<string>());
        var oldest = await Thread(priya, id, $"?limit=10&before={before2}");
        Assert.False(oldest["hasMore"]!.GetValue<bool>());
        Assert.Equal(Enumerable.Range(1, 5).Select(i => $"m{i:00}"), Bodies(oldest));
    }

    [Fact]
    public async Task Search_finds_messages_only_in_conversations_you_are_in()
    {
        var (ravi, priya, kumar) = await BuildTeam();
        await Say(ravi, await Direct(ravi, priya), "The quarterly budget is ready");
        await Say(ravi, await Direct(ravi, kumar), "Budget for the offsite");

        var hits = (await priya.Get("/api/v1/chat/search?q=BUDGET")).Data!.AsArray();
        Assert.Single(hits);                                                  // Priya is not in the chat with Kumar
        Assert.Equal("Ravi", hits[0]!["conversationName"]!.GetValue<string>());
        Assert.Equal(2, (await ravi.Get("/api/v1/chat/search?q=budget")).Data!.AsArray().Count);
        Assert.Empty((await ravi.Get("/api/v1/chat/search?q=b")).Data!.AsArray());   // too short to search
    }

    // ------------------------------------------------------------------ formatting and emoji

    [Fact]
    public async Task Formatting_marks_and_emoji_are_kept_in_the_message_while_previews_and_search_show_plain_words()
    {
        var (ravi, priya, _) = await BuildTeam();
        var id = await Direct(ravi, priya);
        const string body = "**Deploy** is *not* ready, __really__ soon 🎉👍";
        var sent = await Say(ravi, id, body);

        Assert.Equal(body, sent["body"]!.GetValue<string>());                                   // stored and returned exactly as written
        Assert.Equal([body], Bodies(await Thread(priya, id)));
        Assert.Equal("Deploy is not ready, really soon 🎉👍", (await InList(priya, id))!["lastMessage"]!["snippet"]!.GetValue<string>());
        var hit = (await priya.Get("/api/v1/chat/search?q=deploy")).Data!.AsArray().Single()!;
        Assert.Equal("Deploy is not ready, really soon 🎉👍", hit["snippet"]!.GetValue<string>());

        var reply = await Say(priya, id, "Thanks!", sent["id"]!.GetValue<string>());
        Assert.Equal("Deploy is not ready, really soon 🎉👍", reply["replyTo"]!["snippet"]!.GetValue<string>());
    }

    [Fact]
    public async Task Marks_that_are_not_formatting_are_left_alone()
    {
        var (ravi, priya, _) = await BuildTeam();
        var id = await Direct(ravi, priya);
        // Not real formatting, so the mark characters stay in the preview (only ordinary whitespace collapsing applies, same as always).
        foreach (var (plain, expected) in new[] { ("2 * 3 * 4 = 24", "2 * 3 * 4 = 24"), ("call my__var__name later", "call my__var__name later"),
            ("a**b**c stays", "a**b**c stays"), ("trailing * star", "trailing * star"), ("**  spaced  **", "** spaced **") })
        {
            await Say(ravi, id, plain);
            Assert.Equal(expected, (await InList(priya, id))!["lastMessage"]!["snippet"]!.GetValue<string>());
        }
    }

    [Fact]
    public async Task A_preview_never_cuts_an_emoji_in_half()
    {
        var (ravi, priya, _) = await BuildTeam();
        var id = await Direct(ravi, priya);
        // The emoji sits exactly where the 140-character preview is cut.
        await Say(ravi, id, new string('a', 138) + "🎉" + " and then some more words to make it long");
        var snippet = (await InList(priya, id))!["lastMessage"]!["snippet"]!.GetValue<string>();
        Assert.EndsWith("…", snippet);
        _ = new System.Text.UTF8Encoding(false, throwOnInvalidBytes: true).GetBytes(snippet);   // throws on a lone half of an emoji

        await Say(ravi, id, new string('b', 130) + string.Concat(Enumerable.Repeat("😀", 10)));   // long enough to be cut, with whole emoji before the cut
        Assert.EndsWith("😀…", (await InList(priya, id))!["lastMessage"]!["snippet"]!.GetValue<string>());
    }

    // ------------------------------------------------------------------ groups

    [Fact]
    public async Task A_group_has_members_a_creator_who_administers_it_and_a_thread_that_starts_with_who_made_it()
    {
        var (ravi, priya, kumar) = await BuildTeam();
        var id = await Group(ravi, "Launch team", priya, kumar);

        var dto = (await priya.Get($"/api/v1/chat/conversations/{id}")).Data!;
        Assert.Equal("Group", dto["type"]!.GetValue<string>());
        Assert.Equal("Launch team", dto["name"]!.GetValue<string>());
        Assert.Equal(3, dto["members"]!.AsArray().Count);
        Assert.False(dto["canManage"]!.GetValue<bool>());
        Assert.True((await ravi.Get($"/api/v1/chat/conversations/{id}")).Data!["canManage"]!.GetValue<bool>());
        Assert.Contains("created the group", Bodies(await Thread(priya, id)).Single());
        Assert.NotNull(await InList(kumar, id));      // a group shows up for everyone straight away

        await Say(kumar, id, "Hello team");
        Assert.Equal(1, (await InList(priya, id))!["unread"]!.GetValue<int>());
        Assert.Equal(1, (await InList(ravi, id))!["unread"]!.GetValue<int>());
    }

    [Fact]
    public async Task Group_names_and_sizes_are_checked()
    {
        var (ravi, priya, _) = await BuildTeam();
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await ravi.Post("/api/v1/chat/conversations/group", new { name = "x", memberIds = new[] { priya.UserId } })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await ravi.Post("/api/v1/chat/conversations/group", new { name = "Solo", memberIds = Array.Empty<Guid>() })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await ravi.Post("/api/v1/chat/conversations/group", new { name = "Ghosts", memberIds = new[] { Guid.NewGuid() } })).Status);
    }

    [Fact]
    public async Task Only_group_admins_rename_add_and_remove_and_new_people_do_not_see_earlier_messages()
    {
        var (ravi, priya, kumar) = await BuildTeam();
        var id = await Group(ravi, "Core", priya);
        await Say(ravi, id, "Secret plan from before Kumar joined");

        Assert.Equal("GROUP_ADMIN_REQUIRED", (await priya.Put($"/api/v1/chat/conversations/{id}", new { name = "Mine now" })).ErrorCode);
        Assert.Equal("GROUP_ADMIN_REQUIRED", (await priya.Post($"/api/v1/chat/conversations/{id}/members", new { userIds = new[] { kumar.UserId } })).ErrorCode);
        Assert.Equal("GROUP_ADMIN_REQUIRED", (await priya.Delete($"/api/v1/chat/conversations/{id}/members/{ravi.UserId}")).ErrorCode);

        Assert.Equal("Core team", (await ravi.Put($"/api/v1/chat/conversations/{id}", new { name = "Core team" })).Data!["name"]!.GetValue<string>());
        Assert.True((await ravi.Post($"/api/v1/chat/conversations/{id}/members", new { userIds = new[] { kumar.UserId } })).Ok);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await ravi.Post($"/api/v1/chat/conversations/{id}/members", new { userIds = new[] { kumar.UserId } })).Status);   // already in

        var seenByKumar = string.Join(" | ", Bodies(await Thread(kumar, id)));
        Assert.DoesNotContain("Secret plan", seenByKumar);
        Assert.Contains("added Kumar", seenByKumar);
        await Say(priya, id, "Welcome Kumar");
        Assert.Contains("Welcome Kumar", Bodies(await Thread(kumar, id)));
    }

    [Fact]
    public async Task Leaving_and_removal_end_access_and_a_group_never_loses_its_last_admin()
    {
        var (ravi, priya, kumar) = await BuildTeam();
        var id = await Group(ravi, "Crew", priya, kumar);

        Assert.Equal(HttpStatusCode.NoContent, (await kumar.Delete($"/api/v1/chat/conversations/{id}/members/{kumar.UserId}")).Status);   // leaves
        Assert.Equal(HttpStatusCode.NotFound, (await kumar.Get($"/api/v1/chat/conversations/{id}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await kumar.Get($"/api/v1/chat/conversations/{id}/messages")).Status);
        Assert.Contains("Kumar left the group", Bodies(await Thread(ravi, id)));

        // The only admin leaves: someone else takes over.
        Assert.Equal(HttpStatusCode.NoContent, (await ravi.Delete($"/api/v1/chat/conversations/{id}/members/{ravi.UserId}")).Status);
        Assert.True((await priya.Get($"/api/v1/chat/conversations/{id}")).Data!["canManage"]!.GetValue<bool>());

        // The last person leaves: the group is gone.
        Assert.Equal(HttpStatusCode.NoContent, (await priya.Delete($"/api/v1/chat/conversations/{id}/members/{priya.UserId}")).Status);
        Assert.Empty((await priya.Get("/api/v1/chat/conversations")).Data!.AsArray().Where(c => c!["id"]!.GetValue<string>() == id));
    }

    [Fact]
    public async Task A_group_admin_can_delete_anyones_message_but_a_member_only_their_own()
    {
        var (ravi, priya, kumar) = await BuildTeam();
        var id = await Group(ravi, "Moderated", priya, kumar);
        var rude = (await Say(priya, id, "something off"))["id"]!.GetValue<string>();
        Assert.Equal("MESSAGE_NOT_YOURS", (await kumar.Delete($"/api/v1/chat/messages/{rude}")).ErrorCode);
        Assert.Equal(HttpStatusCode.NoContent, (await ravi.Delete($"/api/v1/chat/messages/{rude}")).Status);
    }

    [Fact]
    public async Task A_direct_chat_cannot_be_renamed_or_grown()
    {
        var (ravi, priya, kumar) = await BuildTeam();
        var id = await Direct(ravi, priya);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await ravi.Put($"/api/v1/chat/conversations/{id}", new { name = "Renamed" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await ravi.Post($"/api/v1/chat/conversations/{id}/members", new { userIds = new[] { kumar.UserId } })).Status);
    }

    // ------------------------------------------------------------------ isolation

    [Fact]
    public async Task Outsiders_and_other_workspaces_see_nothing_and_cannot_reach_in()
    {
        var (ravi, priya, kumar) = await BuildTeam();
        var id = await Direct(ravi, priya);
        var msg = (await Say(ravi, id, "Private"))["id"]!.GetValue<string>();

        // A third member of the same workspace who is not in the chat.
        Assert.Equal(HttpStatusCode.NotFound, (await kumar.Get($"/api/v1/chat/conversations/{id}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await kumar.Post($"/api/v1/chat/conversations/{id}/messages", new { body = "let me in" })).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await kumar.Put($"/api/v1/chat/messages/{msg}", new { body = "x" })).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await kumar.Delete($"/api/v1/chat/messages/{msg}")).Status);
        Assert.Empty((await kumar.Get("/api/v1/chat/search?q=private")).Data!.AsArray());

        // A person in a different organization.
        var (otherOwner, otherMember, _) = await BuildTeam();
        Assert.Equal(HttpStatusCode.NotFound, (await otherOwner.Get($"/api/v1/chat/conversations/{id}")).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await otherOwner.Post("/api/v1/chat/conversations/direct", new { userId = ravi.UserId })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await otherOwner.Post("/api/v1/chat/conversations/group", new { name = "Poach", memberIds = new[] { priya.UserId } })).Status);
        Assert.Empty((await otherMember.Get("/api/v1/chat/conversations")).Data!.AsArray());
    }

    [Fact]
    public async Task Someone_who_left_the_workspace_can_no_longer_be_written_to()
    {
        var (ravi, priya, _) = await BuildTeam();
        var id = await Direct(ravi, priya);
        await Say(ravi, id, "Before");
        var removed = await ravi.Delete($"/api/v1/workspace/members/{priya.UserId}");
        Assert.True(removed.Ok, removed.ToString());

        var after = await ravi.Post($"/api/v1/chat/conversations/{id}/messages", new { body = "After" });
        Assert.Equal(HttpStatusCode.Conflict, after.Status);
        Assert.Equal("CHAT_PARTNER_UNAVAILABLE", after.ErrorCode);
        Assert.Contains("Before", Bodies(await Thread(ravi, id)));      // the history is still readable
    }

    // ------------------------------------------------------------------ live delivery

    private async Task<(HubConnection Connection, List<(string Name, JsonElement Payload)> Events)> Live(TestClient who)
    {
        var events = new List<(string, JsonElement)>();
        var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(factory.Server.BaseAddress, "/hubs/chat"), o =>
            {
                o.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler();
                o.Transports = HttpTransportType.LongPolling;
                o.AccessTokenProvider = () => Task.FromResult<string?>(who.Token);
            }).Build();
        foreach (var name in new[] { "message", "message.updated", "conversation", "read", "typing", "presence" })
            connection.On<JsonElement>(name, payload => { lock (events) events.Add((name, payload.Clone())); });
        await connection.StartAsync();
        return (connection, events);
    }

    private static async Task<T> Eventually<T>(Func<T?> probe, int seconds = 5) where T : struct
    {
        for (var i = 0; i < seconds * 20; i++)
        {
            if (probe() is { } found) return found;
            await Task.Delay(50);
        }
        throw new Xunit.Sdk.XunitException("The expected live event did not arrive.");
    }

    [Fact]
    public async Task New_messages_edits_reads_and_typing_reach_the_other_person_live()
    {
        var (ravi, priya, kumar) = await BuildTeam();
        var id = await Direct(ravi, priya);
        var (priyaLive, priyaEvents) = await Live(priya);
        var (kumarLive, kumarEvents) = await Live(kumar);
        await using var _1 = priyaLive; await using var _2 = kumarLive;

        var sent = await Say(ravi, id, "Live hello");
        var got = await Eventually(() => { lock (priyaEvents) return priyaEvents.Where(e => e.Name == "message").Select(e => (JsonElement?)e.Payload).FirstOrDefault(); });
        Assert.Equal(id, got.GetProperty("conversationId").GetString());
        Assert.Equal("Live hello", got.GetProperty("message").GetProperty("body").GetString());
        Assert.Equal("Ravi", got.GetProperty("message").GetProperty("senderName").GetString());
        Assert.Equal("User", got.GetProperty("message").GetProperty("kind").GetString());     // enums are text, like the API

        await ravi.Put($"/api/v1/chat/messages/{sent["id"]!.GetValue<string>()}", new { body = "Edited live" });
        var edit = await Eventually(() => { lock (priyaEvents) return priyaEvents.Where(e => e.Name == "message.updated").Select(e => (JsonElement?)e.Payload).FirstOrDefault(); });
        Assert.Equal("Edited live", edit.GetProperty("message").GetProperty("body").GetString());

        // Typing goes to the others in the conversation, not to the typist and not to outsiders.
        await priyaLive.InvokeAsync("Typing", Guid.Parse(id));
        await kumarLive.InvokeAsync("Typing", Guid.Parse(id));   // Kumar is not in this chat: ignored
        await Task.Delay(300);
        lock (kumarEvents) Assert.DoesNotContain(kumarEvents, e => e.Name is "message" or "message.updated" or "typing");   // an outsider hears nothing about it
        lock (priyaEvents) Assert.DoesNotContain(priyaEvents, e => e.Name == "typing");

        await priya.Post($"/api/v1/chat/conversations/{id}/read");
        await Task.Delay(300);
        Assert.NotNull(await InList(priya, id));
    }

    [Fact]
    public async Task Presence_shows_who_has_the_app_open()
    {
        var (ravi, priya, _) = await BuildTeam();
        Assert.False((await ravi.Get("/api/v1/chat/people")).Data!.AsArray().Single(p => p!["name"]!.GetValue<string>() == "Priya")!["online"]!.GetValue<bool>());

        var (watcher, events) = await Live(ravi);
        await using var _1 = watcher;
        var (priyaLive, _) = await Live(priya);
        JsonElement? PresenceOf(bool online) { lock (events) return events.Where(e => e.Name == "presence" && e.Payload.GetProperty("userId").GetString() == priya.UserId.ToString()
            && e.Payload.GetProperty("online").GetBoolean() == online).Select(e => (JsonElement?)e.Payload).FirstOrDefault(); }
        await Eventually(() => PresenceOf(true));
        Assert.True((await ravi.Get("/api/v1/chat/people")).Data!.AsArray().Single(p => p!["name"]!.GetValue<string>() == "Priya")!["online"]!.GetValue<bool>());

        // Closing the last tab makes the person go offline after a short pause (so a page reload does not flicker).
        await priyaLive.DisposeAsync();
        await Eventually(() => PresenceOf(false), seconds: 10);
        Assert.False((await ravi.Get("/api/v1/chat/people")).Data!.AsArray().Single(p => p!["name"]!.GetValue<string>() == "Priya")!["online"]!.GetValue<bool>());
    }

    [Fact]
    public async Task The_live_connection_needs_a_valid_token_and_an_organization_workspace()
    {
        var anonymous = new HubConnectionBuilder()
            .WithUrl(new Uri(factory.Server.BaseAddress, "/hubs/chat"), o => { o.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler(); o.Transports = HttpTransportType.LongPolling; }).Build();
        await Assert.ThrowsAnyAsync<Exception>(() => anonymous.StartAsync());

        // A personal workspace has nobody to chat with: the server closes the connection straight away.
        var personal = await TestClient.RegisterAsync(factory);
        var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(factory.Server.BaseAddress, "/hubs/chat"), o =>
            {
                o.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler();
                o.Transports = HttpTransportType.LongPolling;
                o.AccessTokenProvider = () => Task.FromResult<string?>(personal.Token);
            }).Build();
        var closed = new TaskCompletionSource();
        connection.Closed += _ => { closed.TrySetResult(); return Task.CompletedTask; };
        try { await connection.StartAsync(); } catch { closed.TrySetResult(); }
        Assert.Same(closed.Task, await Task.WhenAny(closed.Task, Task.Delay(5000)));
        await connection.DisposeAsync();
    }
}
