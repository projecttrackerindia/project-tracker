using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public class WhatsAppInstallationTests(ApiFactory factory)
{
    private WhatsAppOptions Options => factory.Services.GetRequiredService<IOptions<WhatsAppOptions>>().Value;
    private void Configure()
    {
        Options.AppId = "123456789"; Options.AppSecret = "fake-whatsapp-app-secret-only"; Options.VerifyToken = "fake-whatsapp-verification-only";
        Options.ApiVersion = "v24.0"; Options.SignupVersion = "v4"; Options.EmbeddedSignupConfigId = "987654321";
        Options.InstallationEnabled = true; Options.WebhookReceptionEnabled = false;
    }
    private void Reset()
    {
        Options.InstallationEnabled = false; Options.WebhookReceptionEnabled = false; Options.AppId = null; Options.AppSecret = null;
        Options.VerifyToken = null; Options.ApiVersion = null; Options.SignupVersion = null; Options.EmbeddedSignupConfigId = null; factory.WhatsApp.Reset();
    }
    private static string Id() => Random.Shared.NextInt64(1000000000000, 9999999999999).ToString();
    private async Task<TestClient> Org(bool eligible = true)
    {
        var c = await TestClient.RegisterAsync(factory); await c.CreateOrgAsync(); await c.UpgradeAsync("BUSINESS");
        if (eligible) factory.WithDb(db => { db.TenantFeatureOverrides.Add(new TenantFeatureOverride { TenantId = c.WorkspaceId,
            FeatureKey = FeatureKeys.WhatsAppIntegration, Value = 1 }); db.SaveChanges(); return 0; });
        return c;
    }
    private async Task<(string State, string Cookie)> Start(TestClient c)
    {
        c.Extra.Remove("Cookie");
        var result = await c.Post("/api/v1/integrations/whatsapp/connect"); Assert.True(result.Ok, result.ToString());
        var cookie = result.Headers!["Set-Cookie"];
        Assert.Contains("httponly", cookie, StringComparison.OrdinalIgnoreCase); Assert.Contains("secure", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("samesite=strict", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("BrowserProof", result.Json!.ToJsonString(), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Secret", result.Json.ToJsonString(), StringComparison.OrdinalIgnoreCase);
        return (result.Data!["state"]!.GetValue<string>(), cookie.Split(';')[0]);
    }
    private Task<ApiResult> Complete(TestClient c, (string State, string Cookie) start, string code, string business, string phone)
    {
        c.Extra["Cookie"] = start.Cookie;
        return c.Post("/api/v1/integrations/whatsapp/complete", new { state = start.State, code, businessAccountId = business, phoneNumberId = phone });
    }
    private async Task Connect(TestClient c, string business, string phone)
    {
        var start = await Start(c); var result = await Complete(c, start, factory.WhatsApp.IssueCode(business, phone), business, phone);
        Assert.Equal(HttpStatusCode.NoContent, result.Status);
    }
    [Fact]
    public async Task Two_organizations_install_verified_assets_with_independent_protected_tokens_and_no_messaging()
    {
        try
        {
            Configure(); var a = await Org(); var b = await Org(); var ba = Id(); var pa = Id(); var bb = Id(); var pb = Id();
            await Connect(a, ba, pa); await Connect(b, bb, pb);
            factory.WithDb(db =>
            {
                var rows = db.WhatsAppConnections.IgnoreQueryFilters().Where(x => x.TenantId == a.WorkspaceId || x.TenantId == b.WorkspaceId).ToArray();
                Assert.Equal(2, rows.Length); Assert.NotEqual(rows[0].AccessTokenProtected, rows[1].AccessTokenProtected);
                Assert.All(rows, r => { Assert.DoesNotContain("fake_meta_", r.AccessTokenProtected); Assert.True(r.TokenExpiresAt > DateTime.UtcNow); });
                Assert.Equal(ba, rows.Single(x => x.TenantId == a.WorkspaceId).BusinessAccountId); return 0;
            });
            var status = await a.Get("/api/v1/integrations/whatsapp/status"); Assert.True(status.Data!["connected"]!.GetValue<bool>());
            Assert.False(status.Data["messagingEnabled"]!.GetValue<bool>()); Assert.False(status.Data["receptionEnabled"]!.GetValue<bool>());
            Assert.DoesNotContain("Token", status.Json!.ToJsonString(), StringComparison.OrdinalIgnoreCase);
        }
        finally { Reset(); }
    }
    [Fact]
    public async Task Unconfigured_disabled_ineligible_personal_and_member_installations_are_rejected()
    {
        try
        {
            Configure(); var a = await Org(); Options.InstallationEnabled = false;
            Assert.Equal(HttpStatusCode.Conflict, (await a.Post("/api/v1/integrations/whatsapp/connect")).Status);
            Options.InstallationEnabled = true; Options.ApiVersion = "../unsafe";
            Assert.Equal(HttpStatusCode.Conflict, (await a.Post("/api/v1/integrations/whatsapp/connect")).Status);
            Configure(); var b = await Org(false);
            Assert.Equal(HttpStatusCode.Forbidden, (await b.Post("/api/v1/integrations/whatsapp/connect")).Status);
            var member = await a.AddMemberAsync(factory, TenantRole.Member);
            Assert.Equal(HttpStatusCode.Forbidden, (await member.Post("/api/v1/integrations/whatsapp/connect")).Status);
            var personal = await TestClient.RegisterAsync(factory);
            Assert.Equal(HttpStatusCode.Forbidden, (await personal.Post("/api/v1/integrations/whatsapp/connect")).Status);
            Assert.Empty(factory.WhatsApp.RequestPaths);
        }
        finally { Reset(); }
    }
    [Fact]
    public async Task Completion_requires_matching_browser_current_organization_and_user_and_is_one_time()
    {
        try
        {
            Configure(); var a = await Org(); var b = await Org(); var start = await Start(a); var business = Id(); var phone = Id(); var code = factory.WhatsApp.IssueCode(business, phone);
            var missing = await a.Post("/api/v1/integrations/whatsapp/complete", new { state = start.State, code, businessAccountId = business, phoneNumberId = phone });
            Assert.Equal(HttpStatusCode.Unauthorized, missing.Status);
            Assert.Equal(HttpStatusCode.Unauthorized, (await Complete(b, start, code, business, phone)).Status);
            Assert.Empty(factory.WhatsApp.RequestPaths);
            Assert.Equal(HttpStatusCode.NoContent, (await Complete(a, start, code, business, phone)).Status);
            Assert.Equal(HttpStatusCode.Unauthorized, (await Complete(a, start, code, business, phone)).Status);
            Assert.Equal(3, factory.WhatsApp.RequestPaths.Count);
        }
        finally { Reset(); }
    }
    [Theory]
    [InlineData("business")]
    [InlineData("phone")]
    [InlineData("unverified")]
    [InlineData("paging")]
    [InlineData("oversized")]
    [InlineData("lifetime")]
    [InlineData("lost")]
    public async Task Invalid_provider_assets_or_responses_never_persist_credentials(string problem)
    {
        try
        {
            Configure(); var a = await Org(); var start = await Start(a); var business = Id(); var phone = Id();
            factory.WhatsApp.WrongBusiness = problem == "business"; factory.WhatsApp.WrongPhone = problem == "phone";
            factory.WhatsApp.UnverifiedPhone = problem == "unverified"; factory.WhatsApp.Paginated = problem == "paging";
            factory.WhatsApp.Oversized = problem == "oversized"; factory.WhatsApp.InvalidLifetime = problem == "lifetime"; factory.WhatsApp.LostResponse = problem == "lost";
            var result = await Complete(a, start, factory.WhatsApp.IssueCode(business, phone), business, phone);
            Assert.Equal(HttpStatusCode.Conflict, result.Status);
            Assert.DoesNotContain("fake_meta_", result.Json!.ToJsonString());
            Assert.DoesNotContain("fake-whatsapp-app-secret", result.Json.ToJsonString());
            factory.WithDb(db => { Assert.False(db.WhatsAppConnections.IgnoreQueryFilters().Any(x => x.TenantId == a.WorkspaceId)); return 0; });
        }
        finally { Reset(); }
    }
    [Fact]
    public async Task Same_provider_phone_cannot_be_mapped_to_a_second_customer_even_after_disconnect()
    {
        try
        {
            Configure(); var a = await Org(); var b = await Org(); var business = Id(); var phone = Id();
            await Connect(a, business, phone);
            Assert.Equal(HttpStatusCode.NoContent, (await a.Post("/api/v1/integrations/whatsapp/disconnect")).Status);
            var start = await Start(b);
            Assert.Equal(HttpStatusCode.Conflict, (await Complete(b, start, factory.WhatsApp.IssueCode(business, phone), business, phone)).Status);
            await Connect(a, business, phone); // Original organization can reconnect the same verified mapping.
            Assert.True((await a.Get("/api/v1/integrations/whatsapp/status")).Data!["connected"]!.GetValue<bool>());
        }
        finally { Reset(); }
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Membership_or_subscription_revoked_during_asset_verification_prevents_persistence(bool subscription)
    {
        try
        {
            Configure(); var a = await Org(); var start = await Start(a); var business = Id(); var phone = Id();
            factory.WhatsApp.BeforePhoneResponse = () => {
                factory.WithDb(db => { if (subscription) db.Subscriptions.Single(x => x.TenantId == a.WorkspaceId).Status = SubscriptionStatus.PastDue; else db.TenantMembers.Single(x => x.TenantId == a.WorkspaceId && x.UserId == a.UserId).Role = TenantRole.Member; db.SaveChanges(); return 0; });
                return Task.CompletedTask;
            };
            Assert.Equal(HttpStatusCode.Forbidden, (await Complete(a, start, factory.WhatsApp.IssueCode(business, phone), business, phone)).Status);
            factory.WithDb(db => { Assert.False(db.WhatsAppConnections.IgnoreQueryFilters().Any(x => x.TenantId == a.WorkspaceId)); return 0; });
        }
        finally { Reset(); }
    }
    [Fact]
    public async Task Disconnect_during_exchange_fences_late_installation_and_erases_the_attempt()
    {
        try
        {
            Configure(); var a = await Org(); var start = await Start(a); var business = Id(); var phone = Id();
            factory.WhatsApp.BeforePhoneResponse = async () => { Assert.Equal(HttpStatusCode.NoContent, (await a.Post("/api/v1/integrations/whatsapp/disconnect")).Status); };
            Assert.Equal(HttpStatusCode.Unauthorized, (await Complete(a, start, factory.WhatsApp.IssueCode(business, phone), business, phone)).Status);
            factory.WithDb(db => { Assert.False(db.WhatsAppConnections.IgnoreQueryFilters().Any(x => x.TenantId == a.WorkspaceId));
                Assert.False(db.ProviderOAuthAttempts.Any(x => x.Provider == "whatsapp" && x.TenantId == a.WorkspaceId)); return 0; });
        }
        finally { Reset(); }
    }
    [Fact]
    public async Task Expired_attempts_and_cancelled_preparation_cannot_be_completed()
    {
        try
        {
            Configure(); var a = await Org(); var start = await Start(a);
            factory.WithDb(db => { foreach (var p in db.ProviderOAuthAttempts.Where(x => x.Provider == "whatsapp" && x.TenantId == a.WorkspaceId)) p.ExpiresAt = DateTime.UtcNow.AddMinutes(-1); db.SaveChanges(); return 0; });
            var business = Id(); var phone = Id(); var code = factory.WhatsApp.IssueCode(business, phone);
            Assert.Equal(HttpStatusCode.Unauthorized, (await Complete(a, start, code, business, phone)).Status);
            start = await Start(a); a.Extra["Cookie"] = start.Cookie;
            Assert.Equal(HttpStatusCode.NoContent, (await a.Post("/api/v1/integrations/whatsapp/cancel", new { state = start.State })).Status);
            Assert.Equal(HttpStatusCode.Unauthorized, (await Complete(a, start, code, business, phone)).Status);
            Assert.Empty(factory.WhatsApp.RequestPaths);
        }
        finally { Reset(); }
    }
    [Fact]
    public async Task Parallel_completions_cannot_exchange_the_same_state_twice()
    {
        try
        {
            Configure(); var a = await Org(); var start = await Start(a); var business = Id(); var phone = Id(); var code = factory.WhatsApp.IssueCode(business, phone);
            a.Extra["Cookie"] = start.Cookie;
            var results = await Task.WhenAll(a.Post("/api/v1/integrations/whatsapp/complete", new { state = start.State, code, businessAccountId = business, phoneNumberId = phone }),
                a.Post("/api/v1/integrations/whatsapp/complete", new { state = start.State, code, businessAccountId = business, phoneNumberId = phone }));
            Assert.Single(results, r => r.Status == HttpStatusCode.NoContent); Assert.Single(results, r => r.Status == HttpStatusCode.Unauthorized);
            Assert.Equal(3, factory.WhatsApp.RequestPaths.Count);
        }
        finally { Reset(); }
    }
    [Fact]
    public async Task An_expired_known_token_is_not_connected_and_can_be_reverified_for_the_same_reserved_mapping()
    {
        try
        {
            Configure(); var a = await Org(); var business = Id(); var phone = Id(); await Connect(a, business, phone);
            factory.WithDb(db => { db.WhatsAppConnections.IgnoreQueryFilters().Single(x => x.TenantId == a.WorkspaceId).TokenExpiresAt = DateTime.UtcNow.AddMinutes(-1); db.SaveChanges(); return 0; });
            Assert.False((await a.Get("/api/v1/integrations/whatsapp/status")).Data!["connected"]!.GetValue<bool>());
            await Connect(a, business, phone);
            Assert.True((await a.Get("/api/v1/integrations/whatsapp/status")).Data!["connected"]!.GetValue<bool>());
        }
        finally { Reset(); }
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Configuration_changes_before_or_during_verification_never_bind_old_grants_to_new_configuration(bool during)
    {
        try
        {
            Configure(); var a = await Org(); var start = await Start(a); var business = Id(); var phone = Id();
            if (during) factory.WhatsApp.BeforePhoneResponse = () => { Options.EmbeddedSignupConfigId = "987654322"; return Task.CompletedTask; };
            else Options.EmbeddedSignupConfigId = "987654322";
            var result = await Complete(a, start, factory.WhatsApp.IssueCode(business, phone), business, phone);
            Assert.Equal(HttpStatusCode.Conflict, result.Status); Assert.Equal("WHATSAPP_CONFIGURATION_CHANGED", result.ErrorCode);
            if (!during) Assert.Empty(factory.WhatsApp.RequestPaths);
            factory.WithDb(db => { Assert.False(db.WhatsAppConnections.IgnoreQueryFilters().Any(x => x.TenantId == a.WorkspaceId)); return 0; });
        }
        finally { Reset(); }
    }
}