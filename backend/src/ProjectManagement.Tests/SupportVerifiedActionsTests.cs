using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Application.Features.Support;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// One WhatsApp connection for notifications and the support desk (no pasted keys), and verified actions: account facts from a connected
/// system, only after the customer types a one-time code sent to their registered mobile, and sent exactly as the system formatted them.
/// </summary>
[Collection("api")]
public class SupportVerifiedActionsTests(ApiFactory factory)
{
    private const string AppSecret = "platform-app-secret-for-tests-only";
    private const string Customer = "919812300456";
    private WhatsAppOptions O => factory.Services.GetRequiredService<IOptions<WhatsAppOptions>>().Value;
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private void Configure() { O.AppId = "123456789"; O.AppSecret = AppSecret; O.VerifyToken = "platform-verify-token-for-tests"; O.WebhookReceptionEnabled = true; }
    private void Reset() { O.AppId = null; O.AppSecret = null; O.VerifyToken = null; O.WebhookReceptionEnabled = false; factory.Ai.Reset(); factory.Connectors.Answers.Clear(); }

    private async Task<HttpResponseMessage> Platform(string business, string phoneId, string id, string text)
    {
        var body = JsonSerializer.Serialize(new
        {
            @object = "whatsapp_business_account",
            entry = new[] { new { id = business, changes = new[] { new { field = "messages", value = new {
                messaging_product = "whatsapp", metadata = new { display_phone_number = "919000000000", phone_number_id = phoneId },
                contacts = new[] { new { profile = new { name = "Kavya" }, wa_id = Customer } },
                messages = new[] { new { from = Customer, id, timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(), type = "text", text = new { body = text } } } } } } } },
        });
        using var client = factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/integrations/whatsapp/webhook") { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        request.Headers.Add("X-Hub-Signature-256", "sha256=" + Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(AppSecret), Encoding.UTF8.GetBytes(body))).ToLowerInvariant());
        return await client.SendAsync(request);
    }

    [Fact]
    public async Task The_signed_up_number_serves_the_desk_and_account_answers_need_the_one_time_code()
    {
        Configure();
        try
        {
            var owner = await TestClient.RegisterAsync(factory, "Verified Owner");
            await owner.CreateOrgAsync();
            await owner.UpgradeAsync("BUSINESS");
            var business = Random.Shared.NextInt64(1000000000000, 9999999999999).ToString();
            var phoneId = Random.Shared.NextInt64(1000000000000, 9999999999999).ToString();
            factory.WithDb(db =>
            {
                var secrets = factory.Services.GetRequiredService<ISecretProtector>();
                db.WhatsAppConnections.Add(new WhatsAppConnection
                {
                    TenantId = owner.WorkspaceId, AppId = "123456789", BusinessAccountId = business, PhoneNumberId = phoneId, DisplayName = "+91 90000 00000",
                    AccessTokenProtected = secrets.Protect("EAAG-connection-token"), InstalledBy = owner.UserId, ConnectedAt = DateTime.UtcNow.AddMinutes(-5), Active = true, CreatedAt = DateTime.UtcNow,
                });
                return db.SaveChanges();
            });

            // The connection is offered; the desk number uses it with nothing pasted.
            var offer = (await owner.Get("/api/v1/support/channels/connection")).Data!;
            Assert.True(offer["available"]!.GetValue<bool>());
            Assert.False(offer["alreadyUsed"]!.GetValue<bool>());
            var connector = await owner.Post("/api/v1/voice/connectors", new
            {
                name = "loan_lookup", description = "Loan and EMI by loan number", urlTemplate = "https://core.example.com/loans/{loanNumber}", enabled = true,
                flow = new
                {
                    inputs = new[] { new { name = "loanNumber", label = "loan number", type = "text", required = true } },
                    requiresVerifiedCaller = true,
                    fields = new[] { new { key = "emiAmount", path = "main.emi.amount", format = "inr", label = "EMI" }, new { key = "emiDate", path = "main.emi.due", format = "date", label = "due date" } },
                    templates = new Dictionary<string, string> { ["en"] = "Your next EMI of {emiAmount} is due on {emiDate}." },
                },
            });
            Assert.True(connector.Ok, connector.ToString());
            var channel = await owner.Post("/api/v1/support/channels", new
            {
                name = "Loans desk", phoneNumberId = "", businessAccountId = "", enabled = true, autoReply = true, agentName = "Asha", useConnection = true,
                verifiedActions = true, verifyConnector = "loan_lookup", verifyMobilePath = "main.customer.mobile",
            });
            Assert.True(channel.Ok, channel.ToString());
            Assert.True(channel.Data!["linked"]!.GetValue<bool>());
            Assert.Equal(phoneId, S(channel.Data["phoneNumberId"]));
            Assert.True((await owner.Get("/api/v1/support/channels/connection")).Data!["alreadyUsed"]!.GetValue<bool>());
            Assert.Equal("", factory.WithDb(db => db.SupportChannels.IgnoreQueryFilters().Single(c => c.PhoneNumberId == phoneId).AccessTokenProtected));

            factory.Connectors.Answers["/loans/LN778899"] = """{"customer":{"mobile":"98123 00456","name":"Kavya"},"emi":{"amount":12500,"due":"2026-11-05"}}""";
            factory.Ai.Reset(); factory.Ai.Configured = true;
            var processor = factory.Services.GetRequiredService<SupportReplyProcessor>();

            // 1. Asks for the EMI: the AI employee asks the server to send a code (the registered mobile is this chat's number).
            factory.Ai.Answer = (_, user) => user.Contains("Tool verify") ? """{"reply":"I have sent a code to your registered number. Please type it here.","language":"en","action":"none","confident":true}"""
                : """{"reply":"One moment.","language":"en","action":"none","confident":true,"tool":{"name":"verify","args":{"loanNumber":"LN778899"}}}""";
            Assert.Equal(HttpStatusCode.OK, (await Platform(business, phoneId, "wamid.V1", "When is my EMI due? Loan LN778899")).StatusCode);
            await processor.ProcessAsync();
            var codeMessage = Assert.Single(factory.SupportGraph.Sends, x => x.PhoneNumberId == phoneId && x.Text.StartsWith("Your verification code is"));
            Assert.Equal(Customer, codeMessage.To);
            var code = new string(codeMessage.Text.Where(char.IsDigit).Take(6).ToArray());
            Assert.Equal(6, code.Length);
            var chatId = S((await owner.Get("/api/v1/support/conversations")).Data!.AsArray().Single()!["id"]);
            var history = (await owner.Get($"/api/v1/support/conversations/{chatId}")).Data!.ToJsonString();
            Assert.DoesNotContain(code, history);   // the code is in no message the team or the AI can read
            Assert.Contains("ending 0456", history);

            // 2. A wrong code is counted; the right one verifies (and is never stored or passed on).
            factory.Ai.Answer = (_, _) => """{"reply":"That code does not match, please check it.","language":"en","action":"none","confident":true}""";
            var wrong = code == "000000" ? "111111" : "000000";
            Assert.Equal(HttpStatusCode.OK, (await Platform(business, phoneId, "wamid.V2", wrong)).StatusCode);
            await processor.ProcessAsync();
            Assert.Equal(1, factory.WithDb(db => db.SupportConversations.IgnoreQueryFilters().Single(c => c.Id == Guid.Parse(chatId)).OtpAttempts));

            factory.Ai.Answer = (system, user) => user.Contains("Tool lookup")
                ? """{"reply":"Here it is: 12,500 on 5 Nov.","language":"en","action":"none","confident":true}"""
                : """{"reply":"Checking.","language":"en","action":"none","confident":true,"tool":{"name":"lookup","args":{"connector":"loan_lookup","loanNumber":"LN778899"}}}""";
            Assert.Equal(HttpStatusCode.OK, (await Platform(business, phoneId, "wamid.V3", code)).StatusCode);
            await processor.ProcessAsync();
            Assert.DoesNotContain(code, factory.Ai.Prompts.Select(p => p.User + p.System).Aggregate("", (a, b) => a + b));
            var row = factory.WithDb(db => db.SupportConversations.IgnoreQueryFilters().Single(c => c.Id == Guid.Parse(chatId)));
            Assert.True(row.VerifiedUntil > DateTime.UtcNow);
            Assert.Null(row.OtpHash);
            // The facts go out exactly as the connected system's sentence; the AI's own figures do not.
            var facts = factory.SupportGraph.Sends.Last(x => x.PhoneNumberId == phoneId);
            Assert.StartsWith("Your next EMI of", facts.Text);
            Assert.DoesNotContain("12,500 on 5 Nov", facts.Text);
            var chat = (await owner.Get($"/api/v1/support/conversations/{chatId}")).Data!;
            Assert.NotNull(chat["chat"]!["verifiedUntil"]);

            // 3. Verified for one loan is not verified for another.
            factory.Connectors.Answers["/loans/LN111222"] = """{"customer":{"mobile":"9000000001"},"emi":{"amount":9000,"due":"2026-11-10"}}""";
            string? lookupResult = null;
            factory.Ai.Answer = (_, user) =>
            {
                if (user.Contains("Tool lookup")) { lookupResult = user; return """{"reply":"For that loan I need to verify you again.","language":"en","action":"none","confident":true}"""; }
                return """{"reply":"Checking.","language":"en","action":"none","confident":true,"tool":{"name":"lookup","args":{"connector":"loan_lookup","loanNumber":"LN111222"}}}""";
            };
            var callsBefore = factory.Connectors.Calls.Count(x => x == "/loans/LN111222");
            Assert.Equal(HttpStatusCode.OK, (await Platform(business, phoneId, "wamid.V4", "And my other loan LN111222?")).StatusCode);
            await processor.ProcessAsync();
            Assert.Contains("not verified for these details", lookupResult);
            Assert.Equal(callsBefore, factory.Connectors.Calls.Count(x => x == "/loans/LN111222"));   // the system was not even asked
        }
        finally { Reset(); }
    }

    [Fact]
    public async Task A_different_registered_number_needs_the_code_template()
    {
        Configure();
        try
        {
            var owner = await TestClient.RegisterAsync(factory, "Template Owner");
            await owner.CreateOrgAsync();
            await owner.UpgradeAsync("BUSINESS");
            var phoneId = Random.Shared.NextInt64(100000000000, 999999999999).ToString();
            Assert.True((await owner.Post("/api/v1/voice/connectors", new
            {
                name = "loan_lookup", description = "Loan", urlTemplate = "https://core.example.com/loans/{loanNumber}", enabled = true,
                flow = new { inputs = new[] { new { name = "loanNumber", label = "loan number", type = "text", required = true } }, requiresVerifiedCaller = true,
                    fields = new[] { new { key = "status", path = "main.status", format = "text", label = "status" } }, templates = new Dictionary<string, string> { ["en"] = "Your loan is {status}." } },
            })).Ok);
            // Verified actions need the connector and where the mobile number is.
            var missing = await owner.Post("/api/v1/support/channels", new
            {
                name = "Pasted desk", phoneNumberId = phoneId, businessAccountId = "100200300400500", accessToken = "EAAG" + new string('z', 60), appSecret = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
                enabled = true, autoReply = true, agentName = "Asha", verifiedActions = true,
            });
            Assert.Equal(422, (int)missing.Status);
            var saved = await owner.Post("/api/v1/support/channels", new
            {
                name = "Pasted desk", phoneNumberId = phoneId, businessAccountId = "100200300400500", accessToken = "EAAG" + new string('z', 60), appSecret = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
                enabled = true, autoReply = true, agentName = "Asha", verifiedActions = true, verifyConnector = "loan_lookup", verifyMobilePath = "main.mobile", otpTemplate = "verify_code",
            });
            Assert.True(saved.Ok, saved.ToString());
            Assert.False(saved.Data!["linked"]!.GetValue<bool>());
            Assert.Equal("verify_code", S(saved.Data["otpTemplate"]));
            Assert.Equal(422, (int)(await owner.Put($"/api/v1/support/channels/{S(saved.Data["id"])}", new
            {
                name = "Pasted desk", phoneNumberId = phoneId, businessAccountId = "100200300400500", enabled = true, autoReply = true, agentName = "Asha", verifyMobilePath = "not a path!",
            })).Status);
        }
        finally { Reset(); }
    }
}
