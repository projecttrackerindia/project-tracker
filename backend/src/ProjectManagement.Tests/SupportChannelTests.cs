using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.Support;
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
