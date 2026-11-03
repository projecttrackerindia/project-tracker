using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Desk;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Desk phase 1: signed WhatsApp messages join the durable queue once, become routed tickets with an acknowledgement, unaccepted offers
/// escalate, failures end as dead letters, voice intake asks for consent first, and keys are write-only. All with fictional data.
/// </summary>
[Collection("api")]
public class DeskOmnichannelTests(ApiFactory factory)
{
    private const string Secret = "f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6";
    private const string Customer = "919812300000";

    private static object Connect(string phoneId) => new
    {
        name = "Branch helpdesk", phoneNumberId = phoneId, businessAccountId = "100200300400500", accessToken = "EAAG" + new string('y', 60), appSecret = Secret,
        enabled = true, autoReply = false, agentName = "Asha",
    };

    private static object Settings(Guid? supervisor = null, int threshold = 40, int maxReassignments = 1, bool voice = false, string? sarvamKey = null) => new
    {
        intakeEnabled = true, autoAcknowledge = true, autoCreateTicket = true, ackMessage = (string?)null, routingEnabled = true, confidenceThreshold = threshold,
        acceptMinutes = 10, maxReassignments, supervisorId = supervisor, notifyOnWhatsApp = false, voiceEnabled = voice, sarvamApiKey = sarvamKey,
        voiceLanguages = new[] { "en", "hi" }, consentPrompt = (string?)null, recordCalls = true, retentionDays = 30, telephonyProvider = "none", telephonyKey = (string?)null,
    };

    private static string Payload(string phoneId, string messageId, string text) => JsonSerializer.Serialize(new
    {
        @object = "whatsapp_business_account",
        entry = new[] { new { id = "100200300400500", changes = new[] { new { field = "messages", value = new {
            messaging_product = "whatsapp", metadata = new { display_phone_number = "919000000001", phone_number_id = phoneId },
            contacts = new[] { new { profile = new { name = "Lakshmi Rao" }, wa_id = Customer } },
            messages = new[] { new { from = Customer, id = messageId, timestamp = "1700000000", type = "text", text = new { body = text } } } } } } } },
    });

    private async Task<HttpResponseMessage> Deliver(string channelId, string body, bool signed = true)
    {
        using var client = factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/support/whatsapp/{channelId}") { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        var digest = HMACSHA256.HashData(Encoding.UTF8.GetBytes(signed ? Secret : "not-the-secret-not-the-secret-00"), Encoding.UTF8.GetBytes(body));
        request.Headers.Add("X-Hub-Signature-256", "sha256=" + Convert.ToHexString(digest).ToLowerInvariant());
        return await client.SendAsync(request);
    }

    private int Events(Guid channelId) => factory.WithDb(db => db.DeskInboundEvents.IgnoreQueryFilters().Count(e => e.ChannelId == channelId));

    /// <summary>Runs the Desk queue until this channel's events are settled (the background worker may take some of them first).</summary>
    private async Task DrainAsync(Guid channelId)
    {
        var processor = factory.Services.GetRequiredService<DeskQueueProcessor>();
        for (var i = 0; i < 60; i++)
        {
            await processor.ProcessAsync();
            if (factory.WithDb(db => db.DeskInboundEvents.IgnoreQueryFilters().Where(e => e.ChannelId == channelId).All(e => e.Status == "done" || e.Status == "dead"))) return;
            await Task.Delay(250);
        }
        Assert.Fail("The Desk queue did not settle.");
    }

    private async Task<(TestClient Owner, Guid Workspace, Guid ChannelId, string PhoneId)> SetUpAsync(string name)
    {
        factory.Ai.Reset();
        var owner = await TestClient.RegisterAsync(factory, name);
        var workspace = await owner.CreateOrgAsync();
        var phoneId = Random.Shared.NextInt64(100000000000, 999999999999).ToString();
        var channel = await owner.Post("/api/v1/support/channels", Connect(phoneId));
        Assert.Equal(HttpStatusCode.Created, channel.Status);
        return (owner, workspace, Guid.Parse(channel.Data!["id"]!.GetValue<string>()), phoneId);
    }

    [Fact]
    public async Task Only_signed_messages_are_queued_and_a_repeated_delivery_is_queued_once()
    {
        var (owner, _, channelId, phoneId) = await SetUpAsync("Queue Owner");
        // Intake off (the default): messages still reach the chat inbox, nothing is queued.
        Assert.Equal(HttpStatusCode.OK, (await Deliver(channelId.ToString(), Payload(phoneId, "wamid.Q0", "hello")))).StatusCode);
        Assert.Equal(0, Events(channelId));

        Assert.True((await owner.Put("/api/v1/desk/settings", Settings())).Ok);
        var body = Payload(phoneId, "wamid.Q1", "My EMI payment was debited twice");
        Assert.Equal(HttpStatusCode.Unauthorized, (await Deliver(channelId.ToString(), body, signed: false)).StatusCode);
        Assert.Equal(0, Events(channelId));
        Assert.Equal(HttpStatusCode.OK, (await Deliver(channelId.ToString(), body)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Deliver(channelId.ToString(), body)).StatusCode);   // Meta retries the same message id
        Assert.Equal(1, Events(channelId));
        Assert.Equal(HttpStatusCode.OK, (await Deliver(channelId.ToString(), Payload(phoneId, "wamid.Q2", "Any update?")))).StatusCode);
        Assert.Equal(2, Events(channelId));
        // The queue keeps no message text or phone number.
        factory.WithDb(db =>
        {
            var rows = db.DeskInboundEvents.IgnoreQueryFilters().Where(e => e.ChannelId == channelId).ToList();
            Assert.All(rows, r => Assert.DoesNotContain(Customer, r.ProviderMessageId + r.LastError));
            return 0;
        });
    }

    [Fact]
    public async Task A_whatsapp_request_becomes_a_routed_acknowledged_ticket_and_unaccepted_offers_escalate()
    {
        var (owner, _, channelId, phoneId) = await SetUpAsync("Desk Supervisor");
        await owner.UpgradeAsync("BUSINESS");
        var mia = await owner.AddMemberAsync(factory, TenantRole.Manager, "Mia Engineer");
        Assert.True((await owner.Put("/api/v1/desk/settings", Settings(owner.UserId))).Ok);
        var profile = await owner.Put($"/api/v1/desk/engineers/{mia.UserId}", new { status = "available", skills = new[] { "access" }, department = "IT", maxActive = 5 });
        Assert.True(profile.Ok, profile.ToString());
        // An engineer cannot change someone else's profile; they can set their own status.
        Assert.Equal(HttpStatusCode.Forbidden, (await mia.Put($"/api/v1/desk/engineers/{owner.UserId}", new { status = "available", maxActive = 5 })).Status);
        Assert.True((await owner.Post("/api/v1/desk/engineers/me/status", new { status = "offline" })).Ok);

        var sentBefore = factory.SupportGraph.Sends.Count(s => s.To == Customer);
        Assert.Equal(HttpStatusCode.OK, (await Deliver(channelId.ToString(), Payload(phoneId, "wamid.R1", "I cannot login, the password reset OTP never arrives")))).StatusCode);
        await DrainAsync(channelId);

        var taskId = factory.WithDb(db => db.DeskInboundEvents.IgnoreQueryFilters().Single(e => e.ChannelId == channelId).WorkTaskId);
        Assert.NotNull(taskId);
        factory.WithDb(db =>
        {
            Assert.Equal(taskId, db.SupportConversations.IgnoreQueryFilters().Single(c => c.ChannelId == channelId).WorkTaskId);
            var insight = db.DeskTicketInsights.IgnoreQueryFilters().Single(i => i.WorkTaskId == taskId);
            Assert.Equal("whatsapp", insight.Channel);
            Assert.False(insight.NeedsReview);
            Assert.Equal(mia.UserId, db.WorkTasks.IgnoreQueryFilters().Single(t => t.Id == taskId).AssigneeId);
            return 0;
        });
        // The customer was acknowledged on WhatsApp with the ticket key.
        Assert.Contains(factory.SupportGraph.Sends.Where(s => s.To == Customer).Skip(sentBefore), s => s.Text.Contains("WT-"));

        var panel = await mia.Get($"/api/v1/desk/tickets/{taskId}/routing");
        Assert.True(panel.Ok, panel.ToString());
        Assert.Equal(mia.UserId.ToString(), panel.Data!["current"]!["assignee"]!["id"]!.GetValue<string>());
        Assert.Equal("auto", panel.Data!["current"]!["method"]!.GetValue<string>());
        Assert.True(panel.Data!["canAccept"]!.GetValue<bool>());
        // The WhatsApp thread is on the ticket.
        var thread = await mia.Get($"/api/v1/desk/tickets/{taskId}/whatsapp");
        Assert.True(thread.Ok, thread.ToString());
        Assert.Contains(thread.Data!["messages"]!.AsArray(), m => m!["from"]!.GetValue<string>() == "contact");

        // Another workspace cannot see it.
        var stranger = await TestClient.RegisterAsync(factory, "Other Org");
        await stranger.CreateOrgAsync();
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.Get($"/api/v1/desk/tickets/{taskId}/routing")).Status);

        // Only the person it was offered to can accept.
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.Post($"/api/v1/desk/tickets/{taskId}/accept")).Status);
        var accepted = await mia.Post($"/api/v1/desk/tickets/{taskId}/accept");
        Assert.True(accepted.Ok, accepted.ToString());
        Assert.NotNull(accepted.Data!["current"]!["acceptedAt"]);

        // An offer nobody accepted moves on; with nobody else free it goes to the supervisor's review queue.
        factory.WithDb(db =>
        {
            var a = db.DeskAssignments.IgnoreQueryFilters().Single(x => x.WorkTaskId == taskId && x.Active);
            a.AcceptedAt = null; a.AcceptDueAt = DateTime.UtcNow.AddMinutes(-1);
            db.SaveChanges();
            return 0;
        });
        await factory.Services.GetRequiredService<DeskQueueProcessor>().EscalateAsync();
        var moved = (await owner.Get($"/api/v1/desk/tickets/{taskId}/routing")).Data!;
        Assert.Equal("review", moved["current"]!["method"]!.GetValue<string>());
        Assert.Equal(1, moved["current"]!["reassignments"]!.GetValue<int>());

        // A supervisor overrides: no acceptance window. An engineer cannot override.
        Assert.Equal(HttpStatusCode.Forbidden, (await mia.Post($"/api/v1/desk/tickets/{taskId}/override", new { userId = mia.UserId, reason = "VIP" })).Status);
        var overridden = await owner.Post($"/api/v1/desk/tickets/{taskId}/override", new { userId = mia.UserId, reason = "VIP customer" });
        Assert.True(overridden.Ok, overridden.ToString());
        Assert.Equal("override", overridden.Data!["current"]!["method"]!.GetValue<string>());
        Assert.Null(overridden.Data!["current"]!["acceptDueAt"]);

        // Past the limit of moves, the supervisor is told once.
        factory.WithDb(db =>
        {
            var a = db.DeskAssignments.IgnoreQueryFilters().Single(x => x.WorkTaskId == taskId && x.Active);
            a.AcceptDueAt = DateTime.UtcNow.AddMinutes(-1); a.Reassignments = 1;
            db.SaveChanges();
            return 0;
        });
        await factory.Services.GetRequiredService<DeskQueueProcessor>().EscalateAsync();
        factory.WithDb(db =>
        {
            Assert.NotNull(db.DeskAssignments.IgnoreQueryFilters().Single(x => x.WorkTaskId == taskId && x.Active).EscalatedAt);
            return 0;
        });
    }

    [Fact]
    public async Task A_message_that_keeps_failing_ends_as_a_dead_letter_an_admin_can_retry()
    {
        var (owner, workspace, _, _) = await SetUpAsync("Dead Letter Owner");
        Assert.True((await owner.Put("/api/v1/desk/settings", Settings())).Ok);
        var orphan = Guid.NewGuid();   // a channel that no longer exists: the event cannot be handled
        var id = factory.WithDb(db =>
        {
            var e = new DeskInboundEvent { TenantId = workspace, ProviderMessageId = "wamid.DEAD" + Guid.NewGuid().ToString("N")[..6], ChannelId = orphan, ConversationId = Guid.NewGuid(),
                Status = "pending", Attempts = DeskRules.MaxAttempts - 1, NextAttemptAt = DateTime.UtcNow.AddMinutes(-1), CreatedAt = DateTime.UtcNow };
            db.DeskInboundEvents.Add(e); db.SaveChanges();
            return e.Id;
        });
        await DrainAsync(orphan);
        var queue = await owner.Get("/api/v1/desk/queue");
        Assert.True(queue.Ok, queue.ToString());
        Assert.Equal(1, queue.Data!["dead"]!.GetValue<int>());
        Assert.False(string.IsNullOrEmpty(factory.WithDb(db => db.DeskInboundEvents.IgnoreQueryFilters().Single(e => e.Id == id).LastError)));
        var retried = await owner.Post($"/api/v1/desk/queue/{id}/retry");
        Assert.True(retried.Ok, retried.ToString());
        Assert.Equal("pending", factory.WithDb(db => db.DeskInboundEvents.IgnoreQueryFilters().Single(e => e.Id == id).Status));
        Assert.Equal(HttpStatusCode.Conflict, (await owner.Post($"/api/v1/desk/queue/{id}/retry")).Status);
        factory.WithDb(db => { db.DeskInboundEvents.IgnoreQueryFilters().Where(e => e.Id == id).ExecuteDelete(); return 0; });
    }

    [Fact]
    public async Task Voice_intake_says_it_is_automated_asks_before_recording_and_files_a_ticket()
    {
        var (owner, _, _, _) = await SetUpAsync("Voice Owner");
        Assert.Equal(HttpStatusCode.Conflict, (await owner.Post("/api/v1/desk/voice/sessions", new { language = "en" })).Status);   // voice is off
        Assert.True((await owner.Put("/api/v1/desk/settings", Settings(voice: true))).Ok);
        var start = await owner.Post("/api/v1/desk/voice/sessions", new { language = "en" });
        Assert.Equal(HttpStatusCode.Created, start.Status);
        Assert.Contains("automated", start.Data!["say"]!.GetValue<string>(), StringComparison.OrdinalIgnoreCase);
        Assert.Contains("record", start.Data!["say"]!.GetValue<string>(), StringComparison.OrdinalIgnoreCase);
        var id = start.Data!["session"]!["id"]!.GetValue<string>();
        Assert.Equal("consent", start.Data!["session"]!["status"]!.GetValue<string>());
        // Nothing is taken before the caller answers.
        Assert.Equal(HttpStatusCode.Conflict, (await owner.Post($"/api/v1/desk/voice/sessions/{id}/say", new { text = "My VPN is down" })).Status);
        var consent = await owner.Post($"/api/v1/desk/voice/sessions/{id}/consent", new { agree = false });
        Assert.True(consent.Ok, consent.ToString());
        Assert.Contains("not be recorded", consent.Data!["say"]!.GetValue<string>());
        Assert.True((await owner.Post($"/api/v1/desk/voice/sessions/{id}/say", new { text = "The VPN app shows error 809 since this morning, only for me" })).Ok);
        var done = await owner.Post($"/api/v1/desk/voice/sessions/{id}/complete");
        Assert.True(done.Ok, done.ToString());
        Assert.Equal("completed", done.Data!["status"]!.GetValue<string>());
        Assert.False(done.Data!["recorded"]!.GetValue<bool>());   // declined: no audio kept
        Assert.StartsWith("WT-", done.Data!["ticketKey"]!.GetValue<string>());
        var ticket = done.Data!["workTaskId"]!.GetValue<string>();
        var sessions = await owner.Get($"/api/v1/desk/tickets/{ticket}/voice");
        Assert.Single(sessions.Data!.AsArray());
        Assert.Equal("voice", factory.WithDb(db => db.DeskTicketInsights.IgnoreQueryFilters().Single(i => i.WorkTaskId == Guid.Parse(ticket)).Channel));
        // Transcripts are stored encrypted.
        Assert.DoesNotContain("809", factory.WithDb(db => db.DeskVoiceSessions.IgnoreQueryFilters().Single(v => v.Id == Guid.Parse(id)).TranscriptProtected));
        // Phone callbacks are refused honestly until a telephony provider is connected.
        var call = await owner.Post($"/api/v1/desk/tickets/{ticket}/callback", new { number = "+91 98123 00000" });
        Assert.Equal(HttpStatusCode.Conflict, call.Status);
        Assert.Equal("TELEPHONY_NOT_CONFIGURED", call.ErrorCode);
    }

    [Fact]
    public async Task Keys_are_write_only_and_only_admins_change_desk_settings()
    {
        var (owner, workspace, _, _) = await SetUpAsync("Settings Owner");
        await owner.UpgradeAsync("BUSINESS");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Plain Member");
        const string key = "sk_test_fictional_0123456789abcdef";
        var saved = await owner.Put("/api/v1/desk/settings", Settings(sarvamKey: key));
        Assert.True(saved.Ok, saved.ToString());
        Assert.True(saved.Data!["hasSarvamKey"]!.GetValue<bool>());
        Assert.DoesNotContain(key, saved.Json!.ToJsonString());
        Assert.DoesNotContain(key, (await owner.Get("/api/v1/desk/settings")).Json!.ToJsonString());
        Assert.NotEqual(key, factory.WithDb(db => db.DeskSettings.IgnoreQueryFilters().Single(s => s.TenantId == workspace).SarvamApiKeyProtected));
        // Leaving the key out keeps it; "" removes it.
        Assert.True((await owner.Put("/api/v1/desk/settings", Settings())).Data!["hasSarvamKey"]!.GetValue<bool>());
        Assert.False((await owner.Put("/api/v1/desk/settings", Settings(sarvamKey: ""))).Data!["hasSarvamKey"]!.GetValue<bool>());
        Assert.Equal(422, (int)(await owner.Put("/api/v1/desk/settings", Settings(threshold: 140))).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Put("/api/v1/desk/settings", Settings())).Status);
    }
}
