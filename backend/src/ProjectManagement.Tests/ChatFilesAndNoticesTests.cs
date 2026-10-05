using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Chat as a product: a message that arrives while you are away leaves a notice in the bell, files go through the plan's limits into file storage, and people react.</summary>
[Collection("api")]
public class ChatFilesAndNoticesTests(ApiFactory factory)
{
    private record Team(TestClient Ravi, TestClient Priya, TestClient Kumar);

    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1F, 0x15, 0xC4, 0x89];

    private async Task<Team> BuildTeam()
    {
        var ravi = await TestClient.RegisterAsync(factory, "Ravi");
        await ravi.CreateOrgAsync();
        await ravi.UpgradeAsync("BUSINESS");
        return new Team(ravi, await ravi.AddMemberAsync(factory, TenantRole.Member, "Priya"), await ravi.AddMemberAsync(factory, TenantRole.Member, "Kumar"));
    }

    private static async Task<string> Direct(TestClient from, TestClient to) =>
        (await from.Post("/api/v1/chat/conversations/direct", new { userId = to.UserId })).Data!["id"]!.GetValue<string>();

    private static async Task<JsonNode> Say(TestClient who, string conversation, string? body, params string[] files)
    {
        var res = await who.Post($"/api/v1/chat/conversations/{conversation}/messages", new { body, attachmentIds = files });
        Assert.Equal(HttpStatusCode.Created, res.Status);
        return res.Data!;
    }

    private static async Task<List<JsonNode>> Bell(TestClient who) =>
        (await who.Get("/api/v1/notifications")).Data!["items"]!.AsArray().Select(n => n!).Where(n => n["type"]!.GetValue<string>() == "Message").ToList();

    private void Override(TestClient who, string key, long value) => factory.WithDb(db =>
    {
        var row = db.TenantFeatureOverrides.FirstOrDefault(o => o.TenantId == who.WorkspaceId && o.FeatureKey == key);
        if (row is null) db.TenantFeatureOverrides.Add(row = new TenantFeatureOverride { TenantId = who.WorkspaceId, FeatureKey = key });
        row.Value = value; row.Reason = "test";
        db.SaveChanges();
        return 0;
    });

    // ------------------------------------------------------------------ notices in the bell

    [Fact]
    public async Task A_direct_message_leaves_one_notice_in_the_bell_that_stays_current_and_clears_when_read()
    {
        var t = await BuildTeam();
        var conv = await Direct(t.Ravi, t.Priya);
        await Say(t.Ravi, conv, "Hello Priya"); await Say(t.Ravi, conv, "Are you free at 3?"); await Say(t.Ravi, conv, "Need a quick review");

        var notice = Assert.Single(await Bell(t.Priya));                       // one per conversation, not one per message
        Assert.Equal("Ravi", notice["title"]!.GetValue<string>());
        Assert.Contains("3 new messages", notice["body"]!.GetValue<string>());
        Assert.Contains("Need a quick review", notice["body"]!.GetValue<string>());
        Assert.Equal($"/chat/{conv}", notice["link"]!.GetValue<string>());
        Assert.Equal(1, (await t.Priya.Get("/api/v1/notifications/unread-count")).Data!["count"]!.GetValue<int>());
        Assert.Empty(await Bell(t.Ravi));                                       // never for the sender

        Assert.True((await t.Priya.Post($"/api/v1/chat/conversations/{conv}/read")).Ok);
        Assert.Equal(0, (await t.Priya.Get("/api/v1/notifications/unread-count")).Data!["count"]!.GetValue<int>());   // reading the chat clears it

        await Say(t.Ravi, conv, "Thanks");
        var fresh = Assert.Single(await Bell(t.Priya), n => !n["isRead"]!.GetValue<bool>());
        Assert.Equal("Thanks", fresh["body"]!.GetValue<string>());              // a new conversation of news starts a new notice
    }

    [Fact]
    public async Task Group_messages_name_the_group_and_muting_or_switching_the_notice_off_silences_it()
    {
        var t = await BuildTeam();
        var group = (await t.Ravi.Post("/api/v1/chat/conversations/group", new { name = "Release team", memberIds = new[] { t.Priya.UserId, t.Kumar.UserId } })).Data!["id"]!.GetValue<string>();
        await Say(t.Ravi, group, "Freeze is tonight");
        Assert.Equal("Ravi in Release team", Assert.Single(await Bell(t.Priya))["title"]!.GetValue<string>());

        // Kumar muted the group: nothing for him. Priya switched chat notices off: nothing new for her either.
        Assert.True((await t.Kumar.Put($"/api/v1/chat/conversations/{group}/mute", new { muted = true })).Ok);
        var prefs = (await t.Priya.Get("/api/v1/me/notification-preferences")).Data!.AsArray().Select(p => p!).ToList();
        Assert.Contains(prefs, p => p["type"]!.GetValue<string>() == "Message");                                   // it is a choice in Settings → Notifications
        Assert.True((await t.Priya.Put("/api/v1/me/notification-preferences", new { items = new[] { new { type = "Message", inApp = false, email = false, browser = false } } })).Ok);
        await Say(t.Ravi, group, "Second message");
        Assert.DoesNotContain(await Bell(t.Kumar), n => n["body"]!.GetValue<string>().Contains("Second message"));   // nothing after he muted (the first one came before)
        var priya = Assert.Single(await Bell(t.Priya));                          // and for her only the one from before she switched it off
        Assert.DoesNotContain("Second message", priya["body"]!.GetValue<string>());
    }

    // ------------------------------------------------------------------ files

    [Fact]
    public async Task A_picture_goes_through_the_plan_limits_into_storage_and_is_visible_only_to_the_conversation()
    {
        var t = await BuildTeam();
        var conv = await Direct(t.Priya, t.Ravi);

        var up = await t.Priya.Upload($"/api/v1/chat/conversations/{conv}/files", "diagram.png", Png);
        Assert.Equal(HttpStatusCode.Created, up.Status);
        var fileId = up.Data!["id"]!.GetValue<string>();
        Assert.True(up.Data["isImage"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.NotFound, (await t.Ravi.Get($"/api/v1/chat/files/{fileId}")).Status);            // not sent yet: only the uploader can see it

        var msg = await Say(t.Priya, conv, null, fileId);                                                           // a file alone is a message
        Assert.Equal("diagram.png", msg["attachments"]![0]!["fileName"]!.GetValue<string>());
        Assert.Contains("Sent a file: diagram.png", (await Bell(t.Ravi)).Single()["body"]!.GetValue<string>());
        Assert.Equal(Png.Length, (await t.Ravi.Raw($"/api/v1/chat/files/{fileId}")).Content.ReadAsByteArrayAsync().Result.Length);   // the other person can open it
        Assert.Equal(HttpStatusCode.NotFound, (await t.Kumar.Get($"/api/v1/chat/files/{fileId}")).Status);          // a colleague who is not in it cannot
        Assert.Equal(HttpStatusCode.NotFound, (await t.Kumar.Get($"/api/v1/chat/files/{Guid.NewGuid()}")).Status);

        // It counts against the organization's storage like every other file.
        Assert.True((await t.Priya.Get("/api/v1/attachments/limits")).Data!["storageUsedBytes"]!.GetValue<long>() >= Png.Length);

        // Deleting the message removes the file from storage too.
        Assert.True((await t.Priya.Delete($"/api/v1/chat/messages/{msg["id"]!.GetValue<string>()}")).Ok);
        Assert.Equal(HttpStatusCode.NotFound, (await t.Ravi.Get($"/api/v1/chat/files/{fileId}")).Status);
        Assert.Empty(factory.WithDb(db => db.ChatAttachments.IgnoreQueryFilters().Where(a => a.ConversationId == Guid.Parse(conv)).ToList()));
    }

    [Fact]
    public async Task Chat_files_follow_the_plan_the_type_the_size_and_who_owns_the_upload()
    {
        var t = await BuildTeam();
        var conv = await Direct(t.Priya, t.Ravi);
        Assert.Equal("VALIDATION_FAILED", (await t.Priya.Upload($"/api/v1/chat/conversations/{conv}/files", "run.exe", [1, 2, 3, 4])).ErrorCode);
        Assert.Equal("VALIDATION_FAILED", (await t.Priya.Upload($"/api/v1/chat/conversations/{conv}/files", "fake.png", "just text, not a picture"u8.ToArray())).ErrorCode);

        Override(t.Ravi, FeatureKeys.MaxFileSizeMb, 1);
        var big = new byte[2 * 1024 * 1024]; Png.CopyTo(big, 0);
        Assert.Equal("PLAN_LIMIT_REACHED", (await t.Priya.Upload($"/api/v1/chat/conversations/{conv}/files", "big.png", big)).ErrorCode);

        var mine = (await t.Priya.Upload($"/api/v1/chat/conversations/{conv}/files", "ok.png", Png)).Data!["id"]!.GetValue<string>();
        // Somebody else's upload cannot be attached to your message, and neither can one from another conversation.
        var other = await Direct(t.Ravi, t.Kumar);
        var res = await t.Ravi.Post($"/api/v1/chat/conversations/{other}/messages", new { body = "here", attachmentIds = new[] { mine } });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.Status);
        Assert.True((await t.Priya.Delete($"/api/v1/chat/files/{mine}")).Ok);                                      // taking back an unsent file

        // The plan can switch chat files off altogether.
        Override(t.Ravi, FeatureKeys.ChatAttachments, 0);
        var denied = await t.Priya.Upload($"/api/v1/chat/conversations/{conv}/files", "ok.png", Png);
        Assert.False(denied.Ok); Assert.Equal(HttpStatusCode.Forbidden, denied.Status);
    }

    [Fact]
    public async Task The_chat_files_feature_is_part_of_every_plan_with_the_free_plan_off()
    {
        var plans = factory.WithDb(db => db.Plans.Include(p => p.Features).ToDictionary(p => p.Code, p => p.Features.FirstOrDefault(f => f.FeatureKey == FeatureKeys.ChatAttachments)?.Value));
        Assert.Equal(0, plans["FREE"]); Assert.Equal(1, plans["PRO"]); Assert.Equal(1, plans["BUSINESS"]); Assert.Equal(1, plans["ENTERPRISE"]);
    }

    // ------------------------------------------------------------------ reactions

    [Fact]
    public async Task People_react_with_one_of_a_small_set_of_emoji_once_each_and_take_it_back()
    {
        var t = await BuildTeam();
        var conv = await Direct(t.Ravi, t.Priya);
        var id = (await Say(t.Ravi, conv, "Shipped!"))["id"]!.GetValue<string>();

        var one = (await t.Priya.Put($"/api/v1/chat/messages/{id}/reaction", new { emoji = "🎉" })).Data!;
        Assert.Equal(1, one["reactions"]![0]!["count"]!.GetValue<int>()); Assert.True(one["reactions"]![0]!["mine"]!.GetValue<bool>());
        Assert.Equal(1, (await t.Priya.Put($"/api/v1/chat/messages/{id}/reaction", new { emoji = "🎉" })).Data!["reactions"]![0]!["count"]!.GetValue<int>());   // once each
        await t.Ravi.Put($"/api/v1/chat/messages/{id}/reaction", new { emoji = "🎉" });
        var seen = (await t.Ravi.Get($"/api/v1/chat/conversations/{conv}/messages")).Data!["items"]![0]!["reactions"]![0]!;
        Assert.Equal(2, seen["count"]!.GetValue<int>()); Assert.True(seen["mine"]!.GetValue<bool>());
        Assert.Contains("Priya", seen["names"]!.AsArray().Select(n => n!.GetValue<string>()));

        var gone = (await t.Priya.Delete($"/api/v1/chat/messages/{id}/reaction?emoji={Uri.EscapeDataString("🎉")}")).Data!;
        Assert.False(gone["reactions"]![0]!["mine"]!.GetValue<bool>()); Assert.Equal(1, gone["reactions"]![0]!["count"]!.GetValue<int>());

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await t.Priya.Put($"/api/v1/chat/messages/{id}/reaction", new { emoji = "💩" })).Status);   // not on offer
        Assert.Equal(HttpStatusCode.NotFound, (await t.Kumar.Put($"/api/v1/chat/messages/{id}/reaction", new { emoji = "👍" })).Status);              // not in the conversation
    }
}
