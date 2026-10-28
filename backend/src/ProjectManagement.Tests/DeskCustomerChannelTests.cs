using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Automation;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Services;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The Desk talks back to the customer on the ticket's own channel: status changes reach an e-mail customer, "Tell the customer" goes out on
/// WhatsApp or e-mail (a comment when there is no channel), scheduled ticket rules run once per ticket and wait, and saved replies are filled in.
/// </summary>
[Collection("api")]
public class DeskCustomerChannelTests(ApiFactory factory)
{
    private const string Secret = "f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6";
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<(TestClient Owner, TestClient Customer)> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Nila Lead");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var customer = await owner.AddMemberAsync(factory, TenantRole.Manager, "Kiran Patel");
        return (owner, customer);
    }

    /// <summary>A ticket raised by mail to the workspace's work mailbox, from <paramref name="from"/>.</summary>
    private async Task<JsonNode> MailedTicket(TestClient owner, TestClient from, string subject, string text)
    {
        var box = (await owner.Put("/api/v1/integrations/inbound-email", new { enabled = true })).Data!;
        using var anon = factory.CreateClient();
        var res = await anon.PostAsJsonAsync(new Uri(S(box["webhookUrl"])).PathAndQuery, new { From = $"Kiran Patel <{from.Email}>", To = "work@inbound.test", Subject = subject, Text = text });   // sent as camelCase JSON, so "text" (not TextBody)
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var key = (await res.Content.ReadFromJsonAsync<JsonNode>())!["data"]!["workTask"]!.GetValue<string>();
        return (await owner.Get($"/api/v1/work-tasks?q={Uri.EscapeDataString(subject)}")).Data!["items"]!.AsArray().First(t => S(t!["key"]) == key)!;
    }

    private async Task<List<string>> Comments(TestClient c, string id) =>
        (await c.Get($"/api/v1/work-tasks/{id}/comments")).Data!.AsArray().Select(x => S(x!["body"])).ToList();

    private List<DevEmail> MailsTo(string to) => factory.Services.GetRequiredService<DevMailbox>().Recent().Where(m => string.Equals(m.To, to, StringComparison.OrdinalIgnoreCase)).ToList();

    [Fact]
    public async Task Status_changes_reach_an_email_customer_and_are_kept_on_the_ticket()
    {
        var (owner, customer) = await Setup();
        var t = await MailedTicket(owner, customer, "VPN drops every hour", "Since Monday, loan LN-4400123 portal too.");
        var id = S(t["id"]);
        var key = S(t["key"]);

        Assert.True((await owner.Put($"/api/v1/work-tasks/{id}/status", new { status = "InProgress" })).Ok);
        Assert.Contains(MailsTo(customer.Email), m => m.Text!.Contains($"We are working on your request {key}"));
        Assert.True((await owner.Put($"/api/v1/work-tasks/{id}/status", new { status = "Completed" })).Ok);
        var mails = MailsTo(customer.Email);
        Assert.Contains(mails, m => m.Subject.Contains(key) && m.Text!.Contains("is resolved"));
        Assert.Contains(await Comments(owner, id), b => b.StartsWith("📣 Told the customer on e-mail") && b.Contains("is resolved"));

        // Mailbox switched off: the customer is not mailed, and the ticket says why.
        Assert.True((await owner.Put("/api/v1/integrations/inbound-email", new { enabled = false })).Ok);
        var before = MailsTo(customer.Email).Count;
        Assert.True((await owner.Put($"/api/v1/work-tasks/{id}/status", new { status = "Cancelled" })).Ok);
        Assert.Equal(before, MailsTo(customer.Email).Count);
        Assert.Contains(await Comments(owner, id), b => b.Contains("Not sent on e-mail (the work mailbox is switched off)"));
    }

    [Fact]
    public async Task Tell_the_customer_sends_on_email_or_whatsapp_and_falls_back_to_a_comment()
    {
        var (owner, customer) = await Setup();
        var rule = await owner.Post("/api/v1/automations", new
        {
            name = "Critical reassurance", isEnabled = true, trigger = "TicketChanged", action = "TellCustomer", actionText = "Hi {name}, {key} is with our lead now.",
            conditions = new object[] { new { field = "priority", value = "Critical" } },
        });
        Assert.Equal(HttpStatusCode.Created, rule.Status);

        // E-mail: filled in and mailed.
        var mailed = await MailedTicket(owner, customer, "Payroll export fails", "Export to bank fails.");
        var full = (await owner.Get($"/api/v1/work-tasks/{S(mailed["id"])}")).Data!;
        Assert.True((await owner.Put($"/api/v1/work-tasks/{S(mailed["id"])}", new
        {
            title = S(full["title"]), description = S(full["description"]), workTypeId = S(full["workTypeId"]), priority = "Critical", status = "ToDo", version = full["version"]!.GetValue<int>(),
        })).Ok);
        Assert.Contains(MailsTo(customer.Email), m => m.Text!.Contains($"Hi Kiran, {S(mailed["key"])} is with our lead now."));
        Assert.Contains(await Comments(owner, S(mailed["id"])), b => b.StartsWith("📣 Told the customer on e-mail"));

        // No channel (raised in the app): kept as a comment.
        var types = (await owner.Get("/api/v1/work-types?includeInactive=true")).Data!.AsArray();
        var app = (await owner.Post("/api/v1/work-tasks", new { title = "Laptop for new joiner", priority = "Critical", workTypeId = S(types[0]!["id"]) })).Data!;
        Assert.Contains(await Comments(owner, S(app["id"])), b => b.StartsWith("📣 To the customer: Hi Nila"));

        // WhatsApp: a chat raises a ticket; raising its priority tells the customer on WhatsApp.
        var phoneId = Random.Shared.NextInt64(100000000000, 999999999999).ToString();
        var channel = (await owner.Post("/api/v1/support/channels", new
        {
            name = "Care line", phoneNumberId = phoneId, businessAccountId = "100200300400500", accessToken = "EAAG" + new string('y', 60), appSecret = Secret,
            enabled = true, autoReply = false, agentName = "Asha",
        })).Data!;
        var body = JsonSerializer.Serialize(new
        {
            @object = "whatsapp_business_account",
            entry = new[] { new { id = "100200300400500", changes = new[] { new { field = "messages", value = new {
                messaging_product = "whatsapp", metadata = new { display_phone_number = "919000000000", phone_number_id = phoneId },
                contacts = new[] { new { profile = new { name = "Meera Rao" }, wa_id = "919812345678" } },
                messages = new[] { new { from = "919812345678", id = "wamid.DESK1", timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(), type = "text", text = new { body = "EMI not reflected" } } } } } } } },
        });
        using (var client = factory.CreateClient())
        using (var req = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/support/whatsapp/{S(channel["id"])}") { Content = new StringContent(body, Encoding.UTF8, "application/json") })
        {
            req.Headers.Add("X-Hub-Signature-256", "sha256=" + Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(Secret), Encoding.UTF8.GetBytes(body))).ToLowerInvariant());
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(req)).StatusCode);
        }
        var chat = (await owner.Get("/api/v1/support/conversations")).Data!.AsArray().First(c => S(c!["channelId"]) == S(channel["id"]))!;
        var raised = (await owner.Post($"/api/v1/support/conversations/{S(chat["id"])}/ticket")).Data!["chat"]!;
        var taskId = S(raised["workTaskId"]);
        var ticket = (await owner.Get($"/api/v1/work-tasks/{taskId}")).Data!;
        Assert.True((await owner.Put($"/api/v1/work-tasks/{taskId}", new
        {
            title = S(ticket["title"]), description = ticket["description"]?.GetValue<string>(), workTypeId = S(ticket["workTypeId"]), priority = "Critical", status = "ToDo", version = ticket["version"]!.GetValue<int>(),
        })).Ok);
        Assert.Contains(factory.SupportGraph.Sends, x => x.PhoneNumberId == phoneId && x.Text == $"Hi Meera, {S(raised["ticketKey"])} is with our lead now.");
        Assert.Contains(await Comments(owner, taskId), b => b.StartsWith("📣 Told the customer on WhatsApp"));

        // The agent's own reply from the Desk goes the same way.
        var reply = await owner.Post($"/api/v1/work-tasks/{taskId}/tell-customer", new { text = "We found the payment, it shows tomorrow." });
        Assert.True(reply.Ok, reply.ToString());
        Assert.Equal("whatsapp", S(reply.Data!["channel"]));
        Assert.True(reply.Data!["sent"]!.GetValue<bool>());
        Assert.Contains(factory.SupportGraph.Sends, x => x.PhoneNumberId == phoneId && x.Text == "We found the payment, it shows tomorrow.");
    }

    [Fact]
    public async Task Scheduled_ticket_rules_run_once_per_ticket_and_close_resolved_tickets_after_three_days()
    {
        var (owner, customer) = await Setup();
        var close = await owner.Post("/api/v1/automations", new
        {
            name = "Close resolved after 3 days", isEnabled = true, trigger = "TicketResolved", triggerDays = 3, action = "TellCustomer", actionText = "Hi {name}, we have closed {key}.",
            moreActions = new object[] { new { action = "CloseTicket" } },
        });
        Assert.Equal(HttpStatusCode.Created, close.Status);
        Assert.Contains("resolved for 3 days", S(close.Data!["summary"]));
        var nudge = await owner.Post("/api/v1/automations", new
        {
            name = "Nudge the queue", isEnabled = true, trigger = "TicketWaiting", triggerDays = 30, action = "AddComment", actionText = "Waiting 30 minutes without a reply.",
        });
        Assert.Equal(HttpStatusCode.Created, nudge.Status);
        Assert.Equal(422, (int)(await owner.Post("/api/v1/automations", new { name = "Bad", isEnabled = true, trigger = "TicketWaiting", triggerDays = 1, action = "AddComment", actionText = "x" })).Status);
        Assert.Equal(422, (int)(await owner.Post("/api/v1/automations", new { name = "Bad", isEnabled = true, trigger = "TaskCreated", action = "CloseTicket" })).Status);

        var t = await MailedTicket(owner, customer, "Printer queue stuck", "Floor 2 printer.");
        var id = Guid.Parse(S(t["id"]));
        async Task<int> Run() { using var scope = factory.Services.CreateScope(); return await scope.ServiceProvider.GetRequiredService<TicketRuleScheduler>().RunAsync(); }

        // Not yet waited 30 minutes: nothing. After: one nudge, however often the timer runs.
        await Run();
        Assert.DoesNotContain(await Comments(owner, S(t["id"])), b => b.Contains("Waiting 30 minutes"));
        factory.WithDb(db => { var w = db.WorkTasks.IgnoreQueryFilters().Single(x => x.Id == id); w.CreatedAt = w.CreatedAt.AddMinutes(-45); return db.SaveChanges(); });
        await Run(); await Run();
        Assert.Single(await Comments(owner, S(t["id"])), b => b.Contains("Waiting 30 minutes"));

        // Resolved today: not closed. Resolved four days ago: told, closed - once.
        Assert.True((await owner.Put($"/api/v1/work-tasks/{S(t["id"])}/status", new { status = "Completed" })).Ok);
        await Run();
        Assert.Null(factory.WithDb(db => db.WorkTasks.IgnoreQueryFilters().Single(x => x.Id == id).ResolutionAcceptedAt));
        factory.WithDb(db => { var w = db.WorkTasks.IgnoreQueryFilters().Single(x => x.Id == id); w.CompletedAt = w.CompletedAt!.Value.AddDays(-4); return db.SaveChanges(); });
        await Run(); await Run();
        Assert.NotNull(factory.WithDb(db => db.WorkTasks.IgnoreQueryFilters().Single(x => x.Id == id).ResolutionAcceptedAt));
        var comments = await Comments(owner, S(t["id"]));
        Assert.Single(comments, b => b.StartsWith("🔒 Closed by “Close resolved after 3 days”"));
        Assert.Single(MailsTo(customer.Email), m => m.Text!.Contains($"Hi Kiran, we have closed {S(t["key"])}."));
    }

    [Fact]
    public async Task Saved_replies_are_listed_and_filled_from_the_ticket()
    {
        var (owner, customer) = await Setup();
        var t = await MailedTicket(owner, customer, "Statement missing", "Please send the statement for loan LN-7712345.");
        var templates = (await owner.Get("/api/v1/desk/reply-templates")).Data!.AsArray();
        Assert.Contains(templates, x => S(x!["id"]) == "account");
        var filled = await owner.Post($"/api/v1/work-tasks/{S(t["id"])}/fill-reply", new { text = "Hi {name}, checking {account} under {key}. ETA {eta}. Ref {policy}" });
        Assert.True(filled.Ok, filled.ToString());
        Assert.StartsWith($"Hi Kiran, checking LN-7712345 under {S(t["key"])}.", S(filled.Data!["text"]));
        var missing = filled.Data!["missing"]!.AsArray().Select(x => S(x)).ToList();
        Assert.Contains("policy", missing);
    }
}
