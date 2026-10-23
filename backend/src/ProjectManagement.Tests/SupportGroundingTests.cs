using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Support;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The WhatsApp AI employee answers from approved, public DocTracker pages and the customer's own tickets, names the page it used, hands over
/// when unsure, and ratings show in Operations insights.
/// </summary>
[Collection("api")]
public class SupportGroundingTests(ApiFactory factory)
{
    private const string Secret = "f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6";
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static string Text(string t) => new JsonObject { ["type"] = "doc", ["content"] = new JsonArray(t.Split('\n').Select(line =>
        (JsonNode)new JsonObject { ["type"] = "paragraph", ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = line }) }).ToArray()) }.ToJsonString();

    [Fact]
    public void The_words_worth_searching_and_the_passages_around_them()
    {
        var terms = SupportKnowledge.Terms(["Hi sir, how many days for my refund to the card?", "hello"]);
        Assert.Equal(["many", "days", "refund", "card"], terms);
        Assert.Empty(SupportKnowledge.Terms(["hi", "ok thanks"]));
        var lines = new[] { "## Refunds", "Refunds go back to the original card.", "They take 7 working days.", "## Shipping", "We ship in 2 days.", "Tracking comes by SMS." };
        var text = SupportKnowledge.Passages(lines, ["refunds", "card"]);
        Assert.Contains("## Refunds", text);
        Assert.Contains("7 working days", text);   // the line after a match
        Assert.DoesNotContain("Tracking", text);
    }

    private async Task<HttpResponseMessage> Deliver(string channelId, string phoneId, string id, string text)
    {
        var body = JsonSerializer.Serialize(new
        {
            @object = "whatsapp_business_account",
            entry = new[] { new { id = "100200300400500", changes = new[] { new { field = "messages", value = new {
                messaging_product = "whatsapp", metadata = new { display_phone_number = "919000000000", phone_number_id = phoneId },
                contacts = new[] { new { profile = new { name = "Lakshmi" }, wa_id = "919812345670" } },
                messages = new[] { new { from = "919812345670", id, timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(), type = "text", text = new { body = text } } } } } } } },
        });
        using var client = factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/support/whatsapp/{channelId}") { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        request.Headers.Add("X-Hub-Signature-256", "sha256=" + Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(Secret), Encoding.UTF8.GetBytes(body))).ToLowerInvariant());
        return await client.SendAsync(request);
    }

    private static async Task<Guid> Page(TestClient owner, Guid type, string title, string body, string classification)
    {
        var created = await owner.Post("/api/v1/documents", new { title, typeId = type, visibility = "Organization", classification, sections = new[] { new { key = "body", content = Text(body) } } });
        Assert.True(created.Ok, created.ToString());
        var id = Guid.Parse(S(created.Data!["item"]!["id"]));
        var rev = (await owner.Get($"/api/v1/documents/{id}")).Data!["revision"]!.GetValue<int>();
        var pub = await owner.Post($"/api/v1/documents/{id}/publish", new { changeSummary = "First", major = true, revision = rev });
        Assert.True(pub.Ok, pub.ToString());
        return id;
    }

    [Fact]
    public async Task The_AI_employee_answers_from_public_pages_and_their_tickets_names_the_page_and_hands_over_when_unsure()
    {
        factory.Ai.Reset(); factory.Ai.Configured = true;
        try
        {
            var owner = await TestClient.RegisterAsync(factory, "Grounded Owner");
            await owner.CreateOrgAsync();
            await owner.UpgradeAsync("BUSINESS");
            var type = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "PAGE")!["id"]));
            var refund = await Page(owner, type, "Refund policy", "Refunds go back to the original card within 7 working days.\nFor help call 9876543210.", "Public");
            await Page(owner, type, "Refund approvals (internal)", "Refund over 50000 needs the CFO. Internal margin 12 percent.", "Internal");

            var phoneId = Random.Shared.NextInt64(100000000000, 999999999999).ToString();
            var channel = await owner.Post("/api/v1/support/channels", new
            {
                name = "Payments desk", phoneNumberId = phoneId, businessAccountId = "100200300400500", accessToken = "EAAG" + new string('y', 60), appSecret = Secret,
                enabled = true, autoReply = true, agentName = "Asha",
            });
            Assert.True(channel.Ok, channel.ToString());
            Assert.True(channel.Data!["answerFromDocuments"]!.GetValue<bool>());
            var channelId = S(channel.Data["id"]);
            var processor = factory.Services.GetRequiredService<SupportReplyProcessor>();

            // A question the public page answers: the prompt holds that page (personal data masked), never the internal one; the answer names it.
            factory.Ai.Answer = (system, _) => system.Contains("[D1] Refund policy")
                ? """{"reply":"As per our Refund policy, refunds go back to your card within 7 working days.","language":"en","action":"none","sources":["D1"],"confident":true}"""
                : """{"reply":"Let me check.","language":"en","action":"none","sources":[],"confident":true}""";
            Assert.Equal(HttpStatusCode.OK, (await Deliver(channelId, phoneId, "wamid.G1", "How many days for my refund to the card?")).StatusCode);
            await processor.ProcessAsync();
            var prompt = factory.Ai.Prompts.Last(x => x.System.Contains("WhatsApp support employee"));
            Assert.Contains("within 7 working days", prompt.System);
            Assert.DoesNotContain("Internal margin", prompt.System);
            Assert.DoesNotContain("9876543210", prompt.System);
            Assert.Contains(factory.SupportGraph.Sends, x => x.PhoneNumberId == phoneId && x.Text.StartsWith("As per our Refund policy"));
            var chatId = S((await owner.Get("/api/v1/support/conversations")).Data!.AsArray().Single()!["id"]);
            var ai = (await owner.Get($"/api/v1/support/conversations/{chatId}")).Data!["messages"]!.AsArray().Last(m => S(m!["from"]) == "ai")!;
            var source = Assert.Single(ai["sources"]!.AsArray())!;
            Assert.Equal(refund.ToString(), S(source["documentId"]));
            Assert.Equal("Refund policy", S(source["title"]));

            // Their own ticket is known to the AI employee when they ask about it.
            var ticket = await owner.Post($"/api/v1/support/conversations/{chatId}/ticket");
            Assert.True(ticket.Ok, ticket.ToString());
            var key = S(ticket.Data!["chat"]!["ticketKey"]);
            factory.WithDb(db => db.SupportConversations.IgnoreQueryFilters().Where(c => c.Id == Guid.Parse(chatId)).ExecuteUpdate(u => u.SetProperty(c => c.Mode, "ai")));
            factory.Ai.Answer = (_, _) => """{"reply":"Your ticket is received and waiting to be picked up.","language":"en","action":"none","sources":[],"confident":true}""";
            Assert.Equal(HttpStatusCode.OK, (await Deliver(channelId, phoneId, "wamid.G2", "Any update on my complaint?")).StatusCode);
            await processor.ProcessAsync();
            var second = factory.Ai.Prompts.Last(x => x.System.Contains("WhatsApp support employee"));
            Assert.Contains($"{key} \"", second.System);
            Assert.Contains("waiting to be picked up", second.System);

            // Not sure: no guess goes out; the customer is told a colleague will help, and the chat waits for a person.
            factory.Ai.Answer = (_, _) => """{"reply":"Probably 3 days.","language":"en","action":"none","sources":[],"confident":false}""";
            Assert.Equal(HttpStatusCode.OK, (await Deliver(channelId, phoneId, "wamid.G3", "Can I get the refund in cash at the branch?")).StatusCode);
            await processor.ProcessAsync();
            Assert.DoesNotContain(factory.SupportGraph.Sends, x => x.PhoneNumberId == phoneId && x.Text.Contains("Probably 3 days"));
            Assert.Contains(factory.SupportGraph.Sends, x => x.PhoneNumberId == phoneId && x.Text.StartsWith("One of my colleagues will help you"));
            var row = factory.WithDb(db => db.SupportConversations.IgnoreQueryFilters().Single(c => c.Id == Guid.Parse(chatId)));
            Assert.Equal("human", row.Mode);
            Assert.Equal("unsure", row.HandoverReason);
            Assert.NotNull(row.HandedOverAt);

            // Pages off for this number: nothing from the documents is read.
            var off = await owner.Put($"/api/v1/support/channels/{channelId}", new { name = "Payments desk", phoneNumberId = phoneId, businessAccountId = "100200300400500", enabled = true, autoReply = true, agentName = "Asha", answerFromDocuments = false });
            Assert.True(off.Ok, off.ToString());
            Assert.False(off.Data!["answerFromDocuments"]!.GetValue<bool>());

            // Ratings feed the Operations insights.
            factory.WithDb(db => db.SupportConversations.IgnoreQueryFilters().Where(c => c.Id == Guid.Parse(chatId))
                .ExecuteUpdate(u => u.SetProperty(c => c.Rating, 2).SetProperty(c => c.RatedAt, DateTime.UtcNow).SetProperty(c => c.RatingAskedAt, DateTime.UtcNow)));
            var insights = (await owner.Get("/api/v1/operations/insights?days=30")).Data!["satisfaction"]!;
            Assert.Equal(1, insights["rated"]!.GetValue<int>());
            Assert.Equal(2m, insights["average"]!.GetValue<decimal>());
            Assert.Equal(1, insights["distribution"]![1]!.GetValue<int>());
            Assert.Equal(key, S(insights["low"]![0]!["ticketKey"]));
            Assert.Equal(1, insights["handedOver"]!.GetValue<int>());
            Assert.Equal("Not in the documents", S(insights["handoverReasons"]![0]!["label"]));
        }
        finally { factory.Ai.Reset(); }
    }
}
