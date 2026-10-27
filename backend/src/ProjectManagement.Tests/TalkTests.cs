using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Application.Features.Talk;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Talk: chat, mail and meetings in one list. Chats keep their conversation id (old /chat links still open them), meetings are one row per
/// meeting with a rounded-square avatar, and mail shows as "not connected" (with no rows) until the person connects a mailbox.
/// </summary>
[Collection("api")]
public class TalkTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n?.GetValue<string>() ?? "";

    [Fact]
    public async Task Chats_groups_and_meetings_come_back_as_one_list_with_filters()
    {
        var owner = await TestClient.RegisterAsync(factory, "Meera");
        await owner.CreateOrgAsync(); await owner.UpgradeAsync("PRO");
        var mate = await owner.AddMemberAsync(factory, TenantRole.Member, "Ravi");
        var third = await owner.AddMemberAsync(factory, TenantRole.Member, "Asha");

        var direct = await owner.Post("/api/v1/chat/conversations/direct", new { userId = mate.UserId });
        Assert.True(direct.Ok, direct.ToString());
        var directId = S(direct.Data!["id"]);
        Assert.True((await owner.Post($"/api/v1/chat/conversations/{directId}/messages", new { body = "Can you send it as a mail?" })).Ok);
        var group = await owner.Post("/api/v1/chat/conversations/group", new { name = "MuleSoft Support", memberIds = new[] { mate.UserId, third.UserId } });
        Assert.True(group.Ok, group.ToString());
        var groupId = S(group.Data!["id"]);
        Assert.True((await mate.Post($"/api/v1/chat/conversations/{groupId}/messages", new { body = "Server is back" })).Ok);

        var project = await owner.CreateProjectAsync("Atlas");
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = mate.UserId })).Ok);
        var start = DateTimeOffset.UtcNow.AddHours(20);
        var made = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", new { title = "Daily status call", startTime = start, endTime = start.AddMinutes(30),
            timeZone = "Asia/Kolkata", participantUserIds = new[] { mate.UserId }, notetaker = "off" });
        Assert.True(made.Status == HttpStatusCode.Created, made.ToString());
        var meetingId = S(made.Data!["id"]);

        var all = await owner.Get("/api/v1/talk/conversations");
        Assert.True(all.Ok, all.ToString());
        Assert.True(all.Data!["chatAvailable"]!.GetValue<bool>());
        Assert.Equal("not-connected", S(all.Data["mail"]!["state"]));
        var items = all.Data["items"]!.AsArray();

        var chatRow = items.Single(i => S(i!["id"]) == directId)!;
        Assert.Equal("chat", S(chatRow["kind"]));
        Assert.Equal("You: Can you send it as a mail?", S(chatRow["last"]));
        Assert.False(chatRow["group"]!.GetValue<bool>());
        Assert.Equal(mate.UserId.ToString(), S(chatRow["avatar"]!["userId"]));

        var groupRow = items.Single(i => S(i!["id"]) == groupId)!;
        Assert.True(groupRow["group"]!.GetValue<bool>());
        Assert.Equal("Ravi: Server is back", S(groupRow["last"]));
        Assert.Equal("MS", S(groupRow["avatar"]!["initials"]));

        var meetingRow = items.Single(i => S(i!["kind"]) == "meeting")!;
        Assert.Equal($"meet:p:{meetingId}", S(meetingRow["id"]));
        Assert.Equal($"p:{meetingId}", S(meetingRow["meetingRef"]));
        Assert.True(meetingRow["avatar"]!["square"]!.GetValue<bool>());
        Assert.True(meetingRow["upcoming"]!.GetValue<bool>());
        Assert.Contains("Atlas", S(meetingRow["sub"]));
        Assert.DoesNotContain("by AI", S(meetingRow["sub"]));
        Assert.DoesNotContain(items, i => S(i!["kind"]) == "mail");

        // The other person sees the same conversations from their side.
        var theirs = (await mate.Get("/api/v1/talk/conversations")).Data!["items"]!.AsArray();
        Assert.Equal("Can you send it as a mail?", S(theirs.Single(i => S(i!["id"]) == directId)!["last"]));
        Assert.Equal(1, theirs.Single(i => S(i!["id"]) == directId)!["unread"]!.GetValue<int>());
        Assert.Contains(theirs, i => S(i!["kind"]) == "meeting");

        // Filters keep only their kind.
        var chats = (await owner.Get("/api/v1/talk/conversations?f=chat")).Data!["items"]!.AsArray();
        Assert.All(chats, i => Assert.Equal("chat", S(i!["kind"])));
        Assert.Equal(2, chats.Count);
        var meetings = (await owner.Get("/api/v1/talk/conversations?f=meetings")).Data!["items"]!.AsArray();
        Assert.Single(meetings);
        // f=talk (the Talk page now that mail has its own place): chats and meetings, never mail.
        var talkOnly = (await owner.Get("/api/v1/talk/conversations?f=talk")).Data!["items"]!.AsArray();
        Assert.Contains(talkOnly, r => S(r!["kind"]) == "chat");
        Assert.Contains(talkOnly, r => S(r!["kind"]) == "meeting");
        Assert.DoesNotContain(talkOnly, r => S(r!["kind"]) == "mail");
        var mail = await owner.Get("/api/v1/talk/conversations?f=mail");
        Assert.Empty(mail.Data!["items"]!.AsArray());
        Assert.Equal("not-connected", S(mail.Data["mail"]!["state"]));
    }

    [Fact]
    public async Task A_cancelled_meeting_leaves_the_list()
    {
        var owner = await TestClient.RegisterAsync(factory, "Meera");
        await owner.CreateOrgAsync(); await owner.UpgradeAsync("PRO");
        var project = await owner.CreateProjectAsync("Borealis");
        var start = DateTimeOffset.UtcNow.AddHours(5);
        var made = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", new { title = "Release review", startTime = start, endTime = start.AddMinutes(30),
            timeZone = "Asia/Kolkata", participantUserIds = Array.Empty<Guid>(), notetaker = "off" });
        Assert.Equal(HttpStatusCode.Created, made.Status);
        Assert.Single((await owner.Get("/api/v1/talk/conversations?f=meetings")).Data!["items"]!.AsArray());
        var id = S(made.Data!["id"]);
        Assert.True((await owner.Post($"/api/v1/meetings/{id}/cancel")).Ok);
        Assert.Empty((await owner.Get("/api/v1/talk/conversations?f=meetings")).Data!["items"]!.AsArray());
    }

    [Fact]
    public void Names_and_initials_read_like_a_person()
    {
        Assert.Equal("Asha Rao", TalkService.SenderName("\"Asha Rao\" <asha@x.com>"));
        Assert.Equal("asha@x.com", TalkService.SenderName("<asha@x.com>"));
        Assert.Equal("CD", TalkService.Initials("Chalumuri Devaraju"));
        Assert.Equal("IX", TalkService.Initials("ixeaf"));
        Assert.Equal("?", TalkService.Initials(""));
    }

    [Fact]
    public void Mail_attachments_make_a_multipart_body_and_are_checked()
    {
        var plain = ProjectManagement.Application.Features.Mailbox.MailboxService.Body("Hi", null);
        Assert.IsType<MimeKit.TextPart>(plain);
        var data = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes("a,b\n1,2"));
        var multi = ProjectManagement.Application.Features.Mailbox.MailboxService.Body("Hi", [new("../../report.csv", "text/csv", data)]);
        var part = Assert.IsType<MimeKit.Multipart>(multi);
        var file = part.OfType<MimeKit.MimePart>().Single(p => p.IsAttachment);
        Assert.Equal("report.csv", file.FileName);
        Assert.Throws<ProjectManagement.Application.Exceptions.ValidationException>(() =>
            ProjectManagement.Application.Features.Mailbox.MailboxService.Files([new("x.bin", null, "not base64!")]));
    }
}
