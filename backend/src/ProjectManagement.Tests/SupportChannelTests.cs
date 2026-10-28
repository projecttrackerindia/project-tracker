using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.Support;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Teams connect their own WhatsApp Business numbers; Meta's messages must carry the number's signature and are stored encrypted.</summary>
[Collection("api")]
public class SupportChannelTests(ApiFactory factory)
{
    private const string Secret = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

    private static object Connect(string phoneId, bool withToken = true) => new
    {
        name = "IT helpdesk", phoneNumberId = phoneId, businessAccountId = "100200300400500",
        accessToken = withToken ? "EAAG" + new string('x', 60) : null, appSecret = withToken ? Secret : null, enabled = true, autoReply = false, agentName = "Asha",
    };

    private static string Payload(string phoneId, string messageId, string text) => JsonSerializer.Serialize(new
    {
        @object = "whatsapp_business_account",
        entry = new[] { new { id = "100200300400500", changes = new[] { new { field = "messages", value = new {
            messaging_product = "whatsapp", metadata = new { display_phone_number = "919000000000", phone_number_id = phoneId },
            contacts = new[] { new { profile = new { name = "Ravi Kumar" }, wa_id = "919876543210" } },
            messages = new[] { new { from = "919876543210", id = messageId, timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(), type = "text",
                text = new { body = text } } } } } } } },
    });

    private async Task<HttpResponseMessage> Deliver(string channelId, string body, string? secret = Secret)
    {
        using var client = factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/support/whatsapp/{channelId}") { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        var digest = HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret ?? "wrong-secret-wrong-secret"), Encoding.UTF8.GetBytes(body));
        request.Headers.Add("X-Hub-Signature-256", "sha256=" + Convert.ToHexString(digest).ToLowerInvariant());
        return await client.SendAsync(request);
    }

    [Fact]
    public async Task A_team_connects_its_number_and_signed_messages_become_encrypted_chats()
    {
        var owner = await TestClient.RegisterAsync(factory, "Sana Support");
        await owner.CreateOrgAsync();
        var phoneId = Random.Shared.NextInt64(100000000000, 999999999999).ToString();

        Assert.Equal(422, (int)(await owner.Post("/api/v1/support/channels", Connect(phoneId, withToken: false))).Status);
        Assert.Equal(422, (int)(await owner.Post("/api/v1/support/channels", new { name = "IT", phoneNumberId = "12ab", businessAccountId = "1", accessToken = "x", appSecret = "y", enabled = true, autoReply = true })).Status);
        var created = await owner.Post("/api/v1/support/channels", Connect(phoneId));
        Assert.Equal(HttpStatusCode.Created, created.Status);
        var channel = created.Data!;
        var id = channel["id"]!.GetValue<string>();
        Assert.EndsWith($"/api/v1/support/whatsapp/{id}", channel["webhookUrl"]!.GetValue<string>());
        var verify = channel["verifyToken"]!.GetValue<string>();
        Assert.Equal(32, verify.Length);
        Assert.DoesNotContain(Secret, created.Json!.ToJsonString());
        Assert.DoesNotContain("EAAG", created.Json!.ToJsonString());
        Assert.Equal(HttpStatusCode.Conflict, (await owner.Post("/api/v1/support/channels", Connect(phoneId))).Status);

        // Meta's handshake: only this channel's verify token is accepted.
        using (var client = factory.CreateClient())
        {
            var ok = await client.GetAsync($"/api/v1/support/whatsapp/{id}?hub.mode=subscribe&hub.verify_token={verify}&hub.challenge=12345");
            Assert.Equal("12345", await ok.Content.ReadAsStringAsync());
            Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync($"/api/v1/support/whatsapp/{id}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1")).StatusCode);
        }

        var body = Payload(phoneId, "wamid.TEST1", "నా లాగిన్ పని చేయడం లేదు, password reset కావాలి");
        Assert.Equal(HttpStatusCode.Unauthorized, (await Deliver(id, body, secret: null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Deliver(id, body)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Deliver(id, body)).StatusCode);   // Meta repeats a delivery: no duplicate message

        var chats = (await owner.Get("/api/v1/support/conversations")).Data!.AsArray();
        var chat = Assert.Single(chats)!;
        Assert.Equal("Ravi Kumar", chat["contactName"]!.GetValue<string>());
        Assert.DoesNotContain("9876543210", chat["contact"]!.GetValue<string>());   // the list masks the number
        Assert.True(chat["canReply"]!.GetValue<bool>());
        var full = await owner.Get($"/api/v1/support/conversations/{chat["id"]!.GetValue<string>()}");
        Assert.Single(full.Data!["messages"]!.AsArray());
        Assert.Equal("+919876543210", full.Data!["chat"]!["contact"]!.GetValue<string>());

        // Stored encrypted: neither the number nor the words are in the database in clear.
        factory.WithDb(db =>
        {
            var row = db.SupportConversations.IgnoreQueryFilters().Single(c => c.ChannelId == Guid.Parse(id));
            Assert.DoesNotContain("9876543210", row.ContactProtected + row.MessagesProtected + row.ContactKey);
            Assert.DoesNotContain("password", row.MessagesProtected);
            return 0;
        });

        var ticket = await owner.Post($"/api/v1/support/conversations/{chat["id"]!.GetValue<string>()}/ticket");
        Assert.True(ticket.Ok, ticket.ToString());
        Assert.StartsWith("WT-", ticket.Data!["chat"]!["ticketKey"]!.GetValue<string>());
        var closed = await owner.Post($"/api/v1/support/conversations/{chat["id"]!.GetValue<string>()}/close");
        Assert.Equal("closed", closed.Data!["chat"]!["status"]!.GetValue<string>());
    }

    private static string Payload(string phoneId, string messageId, object message) => JsonSerializer.Serialize(new
    {
        @object = "whatsapp_business_account",
        entry = new[] { new { id = "100200300400500", changes = new[] { new { field = "messages", value = new {
            messaging_product = "whatsapp", metadata = new { display_phone_number = "919000000000", phone_number_id = phoneId },
            contacts = new[] { new { profile = new { name = "Ravi Kumar" }, wa_id = "919876543210" } },
            messages = new[] { message } } } } } },
    });

    private static object Text(string id, string text) => new { from = "919876543210", id, timestamp = "1700000000", type = "text", text = new { body = text } };

    [Fact]
    public async Task The_desk_queues_assigns_shows_media_and_keeps_the_customer_told_until_they_rate_it()
    {
        var owner = await TestClient.RegisterAsync(factory, "Desk Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var mia = await owner.AddMemberAsync(factory, TenantRole.Admin, "Mia Desk");
        var phoneId = Random.Shared.NextInt64(100000000000, 999999999999).ToString();
        var channel = (await owner.Post("/api/v1/support/channels", Connect(phoneId))).Data!;
        var channelId = channel["id"]!.GetValue<string>();
        Assert.Equal(15, channel["firstReplyMinutes"]!.GetValue<int>());

        // Desk settings: saved replies, a first-reply time; a bad template name is refused.
        var save = new
        {
            name = "IT helpdesk", phoneNumberId = phoneId, businessAccountId = "100200300400500", enabled = true, autoReply = false, agentName = "Asha",
            firstReplyMinutes = 10, updateTemplate = "ticket_update", updateTemplateLanguage = "en",
            savedReplies = new[] { new { title = "Reset steps", text = "Open the portal and press Forgot password." } },
        };
        var saved = await owner.Put($"/api/v1/support/channels/{channelId}", save);
        Assert.True(saved.Ok, saved.ToString());
        Assert.Equal(10, saved.Data!["firstReplyMinutes"]!.GetValue<int>());
        Assert.Equal(422, (int)(await owner.Put($"/api/v1/support/channels/{channelId}", new { save.name, save.phoneNumberId, save.businessAccountId, enabled = true, autoReply = false, updateTemplate = "Bad Name!" })).Status);

        // A message arrives: with the AI employee off it waits in the team's queue, unassigned, with a first-reply clock.
        Assert.Equal(HttpStatusCode.OK, (await Deliver(channelId, Payload(phoneId, "wamid.D1", Text("wamid.D1", "Printer is not working")))).StatusCode);
        var queues = (await owner.Get("/api/v1/support/queues")).Data!;
        Assert.Equal(1, queues["unassigned"]!.GetValue<int>());
        Assert.Equal(1, queues["waiting"]!.GetValue<int>());
        var chat = Assert.Single((await owner.Get("/api/v1/support/conversations?view=unassigned")).Data!.AsArray())!;
        var chatId = chat["id"]!.GetValue<string>();
        Assert.Equal("human", chat["mode"]!.GetValue<string>());
        Assert.NotNull(chat["replyDueAt"]);

        // Someone from another workspace (here: only their own personal one) cannot be handed the chat.
        var stranger = await TestClient.RegisterAsync(factory, "Zed Outside");
        Assert.Equal(422, (int)(await owner.Post($"/api/v1/support/conversations/{chatId}/assign", new { userId = stranger.UserId })).Status);

        // Given to Mia: she is told, it is in her queue, not in the owner's.
        var given = await owner.Post($"/api/v1/support/conversations/{chatId}/assign", new { userId = mia.UserId });
        Assert.True(given.Ok, given.ToString());
        Assert.Equal("Mia Desk", given.Data!["chat"]!["assigneeName"]!.GetValue<string>());
        Assert.Single((await mia.Get("/api/v1/support/conversations?view=mine")).Data!.AsArray());
        Assert.Empty((await owner.Get("/api/v1/support/conversations?view=mine")).Data!.AsArray());
        Assert.Contains((await mia.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), n => n!["title"]!.GetValue<string>().Contains("gave you a WhatsApp chat"));
        Assert.Equal("Reset steps", given.Data["savedReplies"]![0]!["title"]!.GetValue<string>());

        // Mia answers: it goes out on WhatsApp and the clock stops.
        var replied = await mia.Post($"/api/v1/support/conversations/{chatId}/reply", new { text = "Which floor are you on?" });
        Assert.True(replied.Ok, replied.ToString());
        Assert.Null(replied.Data!["chat"]!["waitingSince"]);
        Assert.Contains(factory.SupportGraph.Sends, x => x.PhoneNumberId == phoneId && x.To == "919876543210" && x.Text == "Which floor are you on?");

        // A photo: listed with its media id, and opened through the inbox (fetched from Meta with the number's token).
        factory.SupportGraph.Media["7700112233"] = ([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3], "image/jpeg");
        var photo = new { from = "919876543210", id = "wamid.D2", timestamp = "1700000001", type = "image", image = new { id = "7700112233", mime_type = "image/jpeg", caption = "the error" } };
        Assert.Equal(HttpStatusCode.OK, (await Deliver(channelId, Payload(phoneId, "wamid.D2", photo))).StatusCode);
        var full = (await mia.Get($"/api/v1/support/conversations/{chatId}")).Data!;
        var media = full["messages"]!.AsArray().Last()!["media"]!;
        Assert.Equal("image", media["kind"]!.GetValue<string>());
        using (var file = await mia.Raw($"/api/v1/support/conversations/{chatId}/media/7700112233"))
        {
            Assert.Equal(HttpStatusCode.OK, file.StatusCode);
            Assert.Equal("image/jpeg", file.Content.Headers.ContentType?.MediaType);
            Assert.Equal(new byte[] { 0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3 }, await file.Content.ReadAsByteArrayAsync());
        }
        using (var missing = await mia.Raw($"/api/v1/support/conversations/{chatId}/media/9999")) Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);

        // A ticket raised by a person: the update round tells the customer, then that it is resolved, and asks for a rating.
        var ticket = await mia.Post($"/api/v1/support/conversations/{chatId}/ticket");
        Assert.True(ticket.Ok, ticket.ToString());
        var key = ticket.Data!["chat"]!["ticketKey"]!.GetValue<string>();
        var taskId = ticket.Data["chat"]!["workTaskId"]!.GetValue<string>();
        var processor = factory.Services.GetRequiredService<SupportReplyProcessor>();
        int Told() => factory.SupportGraph.Sends.Count(x => x.PhoneNumberId == phoneId && x.Text.Contains(key));
        await processor.TicketUpdatesAsync();
        Assert.Contains(factory.SupportGraph.Sends, x => x.Text.Contains(key) && x.Text.Contains("raised"));
        await processor.TicketUpdatesAsync();
        Assert.Equal(1, Told());   // told once
        Assert.True((await mia.Put($"/api/v1/work-tasks/{taskId}/status", new { status = "Completed" })).Ok);
        await processor.TicketUpdatesAsync();
        Assert.Equal(2, Told());
        Assert.Contains(factory.SupportGraph.Sends, x => x.Text.Contains(key) && x.Text.Contains("resolved"));
        Assert.Contains(factory.SupportGraph.Sends, x => x.Text.Contains("1 (poor) to 5 (great)"));
        var closed = (await mia.Get($"/api/v1/support/conversations/{chatId}")).Data!["chat"]!;
        Assert.Equal("closed", closed["status"]!.GetValue<string>());

        // "5" is the rating: thanked, and the chat stays closed.
        Assert.Equal(HttpStatusCode.OK, (await Deliver(channelId, Payload(phoneId, "wamid.D3", Text("wamid.D3", "5")))).StatusCode);
        var rated = (await mia.Get($"/api/v1/support/conversations/{chatId}")).Data!["chat"]!;
        Assert.Equal(5, rated["rating"]!.GetValue<int>());
        Assert.Equal("closed", rated["status"]!.GetValue<string>());
        Assert.Contains(factory.SupportGraph.Sends, x => x.Text.StartsWith("Thank you for the rating"));
    }

    [Fact]
    public void Signatures_must_match_the_app_secret()
    {
        var body = Encoding.UTF8.GetBytes("{\"a\":1}");
        var good = "sha256=" + Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(Secret), body)).ToLowerInvariant();
        Assert.True(SupportChannelService.SignatureValid(Secret, body, good));
        Assert.False(SupportChannelService.SignatureValid("other", body, good));
        Assert.False(SupportChannelService.SignatureValid(Secret, body, null));
        Assert.False(SupportChannelService.SignatureValid(Secret, body, "sha1=abc"));
    }
}
