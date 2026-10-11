using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public class WhatsAppGatewayTests(ApiFactory factory)
{
    private const string App = "123456789";
    private const string Secret = "fake-whatsapp-app-secret-only";
    private const string Verify = "fake-whatsapp-verification-only";
    private WhatsAppOptions Options => factory.Services.GetRequiredService<IOptions<WhatsAppOptions>>().Value;
    private void Configure(bool enabled = true)
    { Options.AppId = App; Options.AppSecret = Secret; Options.VerifyToken = Verify; Options.WebhookReceptionEnabled = enabled; }
    private void Reset() { Options.WebhookReceptionEnabled = false; Options.AppId = null; Options.AppSecret = null; Options.VerifyToken = null; }
    private static string ProviderId() => Random.Shared.NextInt64(1000000000000, 9999999999999).ToString();
    private async Task<TestClient> Org(bool eligible = true)
    {
        var c = await TestClient.RegisterAsync(factory); await c.CreateOrgAsync(); await c.UpgradeAsync("BUSINESS");
        if (eligible) factory.WithDb(db =>
        {
            db.TenantFeatureOverrides.Add(new TenantFeatureOverride { TenantId = c.WorkspaceId, FeatureKey = FeatureKeys.WhatsAppIntegration, Value = 1 });
            db.SaveChanges(); return 0;
        });
        return c;
    }
    // Fixtures stand in for future verified OAuth installations; no public/manual installation endpoint exists.
    private WhatsAppConnection Install(TestClient owner, string? business = null, string? phone = null)
    {
        using var scope = factory.Services.CreateScope();
        var protectedToken = scope.ServiceProvider.GetRequiredService<ISecretProtector>().Protect("fake-business-token-" + owner.UserId);
        return factory.WithDb(db =>
        {
            var c = new WhatsAppConnection { TenantId = owner.WorkspaceId, AppId = App, BusinessAccountId = business ?? ProviderId(),
                PhoneNumberId = phone ?? ProviderId(), DisplayName = "Organization business", InstalledBy = owner.UserId,
                ConnectedAt = DateTime.UtcNow.AddMinutes(-5), Active = true, AccessTokenProtected = protectedToken };
            db.WhatsAppConnections.Add(c); db.SaveChanges(); return c;
        });
    }
    private static object Entry(WhatsAppConnection c, string messageId, long? stamp = null, string? business = null, string? phone = null) => new
    {
        id = business ?? c.BusinessAccountId,
        changes = new[] { new { field = "messages", value = new { messaging_product = "whatsapp",
            metadata = new { phone_number_id = phone ?? c.PhoneNumberId },
            messages = new[] { new { id = messageId, type = "text", timestamp = (stamp ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds()).ToString(),
                from = "919876543210", text = new { body = "Confidential acquisition project and secret attachment" } } } } } }
    };
    private static string Body(params object[] entries) => JsonSerializer.Serialize(new { @object = "whatsapp_business_account", entry = entries });
    private async Task<HttpResponseMessage> Event(string body, bool valid = true, string? signedBody = null)
    {
        using var client = factory.CreateClient(); using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/integrations/whatsapp/webhook");
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        var digest = HMACSHA256.HashData(Encoding.UTF8.GetBytes(Secret), Encoding.UTF8.GetBytes(signedBody ?? body));
        request.Headers.Add("X-Hub-Signature-256", "sha256=" + (valid ? Convert.ToHexString(digest).ToLowerInvariant() : new string('0', 64)));
        return await client.SendAsync(request);
    }
    private int Count(TestClient c) => factory.WithDb(db => db.WhatsAppInboundReceipts.IgnoreQueryFilters().Count(x => x.TenantId == c.WorkspaceId));

    [Fact]
    public async Task Deployment_gate_blocks_webhooks_and_does_not_offer_installation_or_sending()
    {
        try
        {
            var a = await Org(); Configure(false);
            var status = await a.Get("/api/v1/integrations/whatsapp/status"); Assert.True(status.Ok, status.ToString());
            Assert.False(status.Data!["installationEnabled"]!.GetValue<bool>());
            Assert.False(status.Data["messagingEnabled"]!.GetValue<bool>());
            using var response = await Event(Body()); Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        }
        finally { Reset(); }
    }
    [Fact]
    public async Task Verification_returns_exact_challenge_only_for_configured_secret_and_subscribe_mode()
    {
        try
        {
            Configure(); using var client = factory.CreateClient();
            using var good = await client.GetAsync("/api/v1/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=" + Verify + "&hub.challenge=12345");
            Assert.Equal(HttpStatusCode.OK, good.StatusCode); Assert.Equal("12345", await good.Content.ReadAsStringAsync());
            using var bad = await client.GetAsync("/api/v1/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong-token-string&hub.challenge=12345");
            Assert.Equal(HttpStatusCode.Unauthorized, bad.StatusCode);
            using var wrongMode = await client.GetAsync("/api/v1/integrations/whatsapp/webhook?hub.mode=unsubscribe&hub.verify_token=" + Verify + "&hub.challenge=12345");
            Assert.Equal(HttpStatusCode.Unauthorized, wrongMode.StatusCode);
        }
        finally { Reset(); }
    }
    [Fact]
    public async Task Two_organizations_are_routed_by_exact_business_and_phone_mapping_and_keep_metadata_private()
    {
        try
        {
            var a = await Org(); var b = await Org(); var ca = Install(a); var cb = Install(b); Configure();
            using var response = await Event(Body(Entry(ca, "wamid.a"), Entry(cb, "wamid.b")));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode); Assert.Equal(1, Count(a)); Assert.Equal(1, Count(b));
            var ra = await a.Get("/api/v1/integrations/whatsapp/receipts"); var rb = await b.Get("/api/v1/integrations/whatsapp/receipts");
            Assert.True(ra.Ok, ra.ToString()); Assert.True(rb.Ok, rb.ToString());
            var receiptA = ra.Data!.AsArray().Single()!; var receiptB = rb.Data!.AsArray().Single()!;
            Assert.NotEqual(receiptA["id"]!.GetValue<string>(), receiptB["id"]!.GetValue<string>());
            Assert.Equal("identity_verification_required", receiptA["outcome"]!.GetValue<string>());
            var serialized = ra.Json!.ToJsonString() + (await a.Get("/api/v1/integrations/whatsapp/status")).Json!.ToJsonString();
            Assert.DoesNotContain("919876543210", serialized); Assert.DoesNotContain("Confidential", serialized);
            Assert.DoesNotContain("wamid", serialized); Assert.DoesNotContain("Token", serialized, StringComparison.OrdinalIgnoreCase);
            factory.WithDb(db => { var rows = db.WhatsAppInboundReceipts.IgnoreQueryFilters().Where(x => x.TenantId == a.WorkspaceId || x.TenantId == b.WorkspaceId).ToArray();
                Assert.Equal(2, rows.Length); Assert.All(rows, r => Assert.Equal("text", r.MessageType)); return 0; });
        }
        finally { Reset(); }
    }
    [Fact]
    public async Task Invalid_signature_and_raw_body_mutation_cannot_store_any_receipts()
    {
        try
        {
            var a = await Org(); var c = Install(a); Configure(); var body = Body(Entry(c, "wamid.invalid"));
            using var invalid = await Event(body, false); Assert.Equal(HttpStatusCode.Unauthorized, invalid.StatusCode);
            using var modified = await Event(body + " ", signedBody: body); Assert.Equal(HttpStatusCode.Unauthorized, modified.StatusCode);
            Assert.Equal(0, Count(a));
        }
        finally { Reset(); }
    }
    [Fact]
    public async Task Crossed_account_mapping_unknown_phone_and_wrong_application_are_ignored()
    {
        try
        {
            var a = await Org(); var b = await Org(); var ca = Install(a); var cb = Install(b); Configure();
            using var wrongPair = await Event(Body(Entry(ca, "wamid.cross", business: cb.BusinessAccountId), Entry(ca, "wamid.unknown", phone: ProviderId())));
            Assert.Equal(HttpStatusCode.OK, wrongPair.StatusCode); Assert.Equal(0, Count(a)); Assert.Equal(0, Count(b));
            Options.AppId = ProviderId();
            using var wrongApp = await Event(Body(Entry(ca, "wamid.app"))); Assert.Equal(HttpStatusCode.OK, wrongApp.StatusCode); Assert.Equal(0, Count(a));
        }
        finally { Reset(); }
    }
    [Fact]
    public async Task Duplicate_retries_and_simultaneous_deliveries_create_one_receipt()
    {
        try
        {
            var a = await Org(); var c = Install(a); Configure(); var entry = Entry(c, "wamid.concurrent"); var body = Body(entry, entry);
            var replies = await Task.WhenAll(Event(body), Event(body));
            foreach (var reply in replies) { using (reply) Assert.Equal(HttpStatusCode.OK, reply.StatusCode); }
            using var retry = await Event(body); Assert.Equal(HttpStatusCode.OK, retry.StatusCode); Assert.Equal(1, Count(a));
        }
        finally { Reset(); }
    }
    [Fact]
    public async Task Ineligible_expired_or_inactive_organizations_do_not_receive_metadata()
    {
        try
        {
            var a = await Org(false); var ca = Install(a); var b = await Org(); var cb = Install(b); Configure();
            factory.WithDb(db => { db.Subscriptions.Single(x => x.TenantId == b.WorkspaceId).Status = SubscriptionStatus.PastDue; db.SaveChanges(); return 0; });
            using var response = await Event(Body(Entry(ca, "wamid.no-plan"), Entry(cb, "wamid.expired")));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode); Assert.Equal(0, Count(a)); Assert.Equal(0, Count(b));
            Assert.Equal(HttpStatusCode.Forbidden, (await a.Get("/api/v1/integrations/whatsapp/receipts")).Status);
        }
        finally { Reset(); }
    }
    [Fact]
    public async Task Members_and_personal_workspaces_cannot_manage_or_read_organization_receipts()
    {
        try
        {
            var owner = await Org(); var member = await owner.AddMemberAsync(factory, TenantRole.Member); Configure();
            Assert.Equal(HttpStatusCode.Forbidden, (await member.Get("/api/v1/integrations/whatsapp/status")).Status);
            Assert.Equal(HttpStatusCode.Forbidden, (await member.Get("/api/v1/integrations/whatsapp/receipts")).Status);
            Assert.Equal(HttpStatusCode.Forbidden, (await member.Post("/api/v1/integrations/whatsapp/disconnect")).Status);
            var personal = await TestClient.RegisterAsync(factory);
            Assert.Equal(HttpStatusCode.Forbidden, (await personal.Get("/api/v1/integrations/whatsapp/status")).Status);
        }
        finally { Reset(); }
    }
    [Fact]
    public async Task Disconnect_erases_usable_credentials_stops_reception_and_does_not_touch_other_organizations()
    {
        try
        {
            var a = await Org(); var b = await Org(); var ca = Install(a); var cb = Install(b); Configure();
            Assert.Equal(HttpStatusCode.NoContent, (await a.Post("/api/v1/integrations/whatsapp/disconnect")).Status);
            using var response = await Event(Body(Entry(ca, "wamid.disconnected"), Entry(cb, "wamid.active")));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode); Assert.Equal(0, Count(a)); Assert.Equal(1, Count(b));
            factory.WithDb(db => { var row = db.WhatsAppConnections.IgnoreQueryFilters().Single(x => x.TenantId == a.WorkspaceId);
                Assert.False(row.Active); Assert.Equal("", row.AccessTokenProtected); Assert.Equal(ca.PhoneNumberId, row.PhoneNumberId); return 0; });
            Assert.True((await b.Get("/api/v1/integrations/whatsapp/status")).Data!["connected"]!.GetValue<bool>());
        }
        finally { Reset(); }
    }
    [Fact]
    public async Task Signed_malformed_oversized_or_partly_invalid_batches_do_not_partially_persist()
    {
        try
        {
            var a = await Org(); var c = Install(a); Configure();
            using var malformed = await Event("{"); Assert.Equal(HttpStatusCode.UnprocessableEntity, malformed.StatusCode);
            using var oversized = await Event(new string('x', 64 * 1024 + 1)); Assert.Equal(HttpStatusCode.UnprocessableEntity, oversized.StatusCode);
            using var invalid = await Event(Body(Entry(c, "wamid.valid"), new { id = "not-a-business", changes = Array.Empty<object>() }));
            Assert.Equal(HttpStatusCode.UnprocessableEntity, invalid.StatusCode); Assert.Equal(0, Count(a));
        }
        finally { Reset(); }
    }
    [Fact]
    public async Task Old_future_and_preinstallation_events_cannot_reintroduce_expired_receipts()
    {
        try
        {
            var a = await Org(); var c = Install(a); Configure(); var now = DateTimeOffset.UtcNow;
            using var response = await Event(Body(Entry(c, "wamid.old", now.AddDays(-31).ToUnixTimeSeconds()),
                Entry(c, "wamid.future", now.AddMinutes(10).ToUnixTimeSeconds()), Entry(c, "wamid.before", now.AddMinutes(-10).ToUnixTimeSeconds())));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode); Assert.Equal(0, Count(a));
        }
        finally { Reset(); }
    }
    [Fact]
    public async Task Metadata_lists_are_bounded_offset_explicit_and_exclude_expired_receipts()
    {
        try
        {
            var a = await Org(); var c = Install(a); Configure();
            factory.WithDb(db =>
            {
                db.WhatsAppInboundReceipts.Add(new WhatsAppInboundReceipt { TenantId = a.WorkspaceId, AppId = App,
                    PhoneNumberId = c.PhoneNumberId, ProviderMessageId = "wamid.expired", MessageType = "text",
                    ReceivedAt = DateTime.UtcNow.AddDays(-31), ProviderCreatedAt = DateTime.UtcNow.AddDays(-31) });
                db.SaveChanges(); return 0;
            });
            var entries = Enumerable.Range(0, 55).Select(n => Entry(c, "wamid.bounded-" + n)).ToArray();
            // At most 20 entries per envelope; repeated batches use different provider IDs.
            foreach (var batch in entries.Chunk(20))
            { using var response = await Event(Body(batch)); Assert.Equal(HttpStatusCode.OK, response.StatusCode); }
            Assert.Equal(55, Count(a)); // Lazy retention removed the old row.
            var result = await a.Get("/api/v1/integrations/whatsapp/receipts"); Assert.True(result.Ok, result.ToString());
            Assert.Equal(50, result.Data!.AsArray().Count);
            Assert.All(result.Data.AsArray(), row =>
            {
                Assert.EndsWith("+00:00", row!["receivedAt"]!.GetValue<string>());
                Assert.EndsWith("+00:00", row["providerCreatedAt"]!.GetValue<string>());
            });
        }
        finally { Reset(); }
    }
    [Fact]
    public async Task A_provider_phone_mapping_cannot_be_reused_by_another_organization_even_after_disconnect()
    {
        try
        {
            var a = await Org(); var b = await Org(); var c = Install(a); Configure();
            factory.WithDb(db =>
            {
                var first = db.WhatsAppConnections.IgnoreQueryFilters().Single(x => x.Id == c.Id);
                Assert.DoesNotContain("fake-business-token", first.AccessTokenProtected);
                return 0;
            });
            Assert.Equal(HttpStatusCode.NoContent, (await a.Post("/api/v1/integrations/whatsapp/disconnect")).Status);
            Assert.Throws<DbUpdateException>(() => Install(b, phone: c.PhoneNumberId));
            Assert.False((await b.Get("/api/v1/integrations/whatsapp/status")).Data!["connected"]!.GetValue<bool>());
        }
        finally { Reset(); }
    }
}