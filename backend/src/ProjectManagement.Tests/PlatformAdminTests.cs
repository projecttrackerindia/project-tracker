using System.Net;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Platform administration: billing overview, usage, exceptions to plans, platform switches and system health.</summary>
[Collection("api")]
public class PlatformAdminTests(ApiFactory factory)
{
    private async Task<TestClient> Admin()
    {
        var c = await TestClient.RegisterAsync(factory, "Platform Admin");
        factory.WithDb(db => { db.Users.IgnoreQueryFilters().Where(u => u.Id == c.UserId).ExecuteUpdate(s => s.SetProperty(u => u.IsPlatformAdmin, true)); return 0; });
        await c.LoginAsync();
        return c;
    }

    private async Task<(TestClient Owner, Guid Tenant, string Name)> Org(string plan = "FREE")
    {
        var c = await TestClient.RegisterAsync(factory);
        var name = $"Org {Guid.NewGuid():N}"[..16];
        var res = await c.Post("/api/v1/workspaces", new { name });
        var id = Guid.Parse(res.Data!["id"]!.GetValue<string>());
        await c.SwitchToAsync(id);
        if (plan != "FREE") await c.UpgradeAsync(plan);
        return (c, id, name);
    }

    [Fact]
    public async Task Everything_here_is_for_platform_administrators_only()
    {
        var user = await TestClient.RegisterAsync(factory);
        foreach (var path in new[] { "/api/v1/admin/billing", "/api/v1/admin/usage", "/api/v1/admin/health", "/api/v1/admin/settings", $"/api/v1/admin/tenants/{Guid.NewGuid()}/overrides" })
            Assert.Equal(HttpStatusCode.Forbidden, (await user.Get(path)).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.Put("/api/v1/admin/settings", new { signupsEnabled = true, maintenanceMode = false, announcement = "x", announcementLevel = "info" })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.Put($"/api/v1/admin/tenants/{Guid.NewGuid()}/overrides/API_ACCESS", new { value = 1, reason = "because" })).Status);
    }

    // ------------------------------------------------------------------ billing

    [Fact]
    public async Task Billing_overview_adds_up_recurring_revenue_by_plan_and_lists_invoices()
    {
        var admin = await Admin();
        var (_, _, name) = await Org("BUSINESS");
        var b = (await admin.Get("/api/v1/admin/billing")).Data!;
        var price = (await admin.Get("/api/v1/admin/plans")).Data!.AsArray().Single(p => p!["code"]!.GetValue<string>() == "BUSINESS")!["priceMonthly"]!.GetValue<decimal>();   // whatever the plan costs right now

        Assert.True(b["mrr"]!.GetValue<decimal>() >= price);
        Assert.Equal(b["mrr"]!.GetValue<decimal>() * 12, b["arr"]!.GetValue<decimal>());
        var business = b["byPlan"]!.AsArray().Single(p => p!["planCode"]!.GetValue<string>() == "BUSINESS")!;
        Assert.True(business["organizations"]!.GetValue<int>() >= 1);
        Assert.True(business["mrr"]!.GetValue<decimal>() >= business["organizations"]!.GetValue<int>() * price * 0.7m);   // every organization pays for at least one seat, discounts take off at most 30%
        Assert.Contains(name, b["recentInvoices"]!.ToJsonString());
        Assert.True(b["payingOrganizations"]!.GetValue<int>() >= 1);
        Assert.True(b["revenueLast30Days"]!.GetValue<decimal>() >= price);
    }

    // ------------------------------------------------------------------ usage

    [Fact]
    public async Task Usage_shows_counts_per_organization_and_warns_near_plan_limits_without_any_content()
    {
        var admin = await Admin();
        var (owner, tenant, name) = await Org("FREE");
        for (var i = 0; i < 5; i++) await owner.CreateProjectAsync($"P{i}");        // the Free plan allows 5 projects

        var page = (await admin.Get($"/api/v1/admin/usage?q={name}")).Data!;
        var row = page["items"]!.AsArray().Single(r => r!["tenantId"]!.GetValue<string>() == tenant.ToString())!;
        Assert.Equal(1, row["members"]!.GetValue<int>());
        Assert.True(row["projects"]!.GetValue<int>() >= 5);
        Assert.Contains(row["warnings"]!.AsArray(), w => w!["metric"]!.GetValue<string>() == "projects");
        Assert.NotNull(row["lastActivityAt"]);
        // Customer content never reaches the platform view.
                Assert.DoesNotContain("P0", page.ToJsonString());

        var warned = (await admin.Get("/api/v1/admin/usage?warningsOnly=true&pageSize=100")).Data!["items"]!.AsArray();
        Assert.All(warned, r => Assert.NotEmpty(r!["warnings"]!.AsArray()));
        Assert.Equal(HttpStatusCode.OK, (await admin.Get("/api/v1/admin/usage?sort=storage&type=Organization")).Status);
    }

    // ------------------------------------------------------------------ exceptions to a plan

    [Fact]
    public async Task An_override_gives_one_organization_a_feature_until_it_ends()
    {
        var admin = await Admin();
        var (owner, tenant, _) = await Org("FREE");
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.Post("/api/v1/api-keys", new { name = "x", scope = "ReadOnly" })).Status);
        var before = (await owner.Get("/api/v1/me/fingerprint")).Data!["fingerprint"]!.GetValue<string>();

        var set = await admin.Put($"/api/v1/admin/tenants/{tenant}/overrides/API_ACCESS", new { value = 1, reason = "30 day evaluation", expiresInDays = 30 });
        Assert.True(set.Ok, set.ToString());
        Assert.Equal(1, set.Data![0]!["value"]!.GetValue<int>());
        Assert.Equal(0, set.Data[0]!["planValue"]!.GetValue<int>());

        Assert.Equal(HttpStatusCode.Created, (await owner.Post("/api/v1/api-keys", new { name = "x", scope = "ReadOnly" })).Status);
        Assert.Equal(1, (await owner.Get("/api/v1/me")).Data!["current"]!["entitlements"]!["API_ACCESS"]!.GetValue<int>());
        Assert.NotEqual(before, (await owner.Get("/api/v1/me/fingerprint")).Data!["fingerprint"]!.GetValue<string>()); // menus follow it too

        // It applies to that organization only.
        var (other, _, _) = await Org("FREE");
        Assert.Equal(HttpStatusCode.Forbidden, (await other.Post("/api/v1/api-keys", new { name = "x", scope = "ReadOnly" })).Status);

        // When it ends, so does the feature.
        factory.WithDb(db => { db.TenantFeatureOverrides.IgnoreQueryFilters().Where(o => o.TenantId == tenant).ExecuteUpdate(s => s.SetProperty(o => o.ExpiresAt, DateTime.UtcNow.AddMinutes(-1))); return 0; });
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.Post("/api/v1/api-keys", new { name = "y", scope = "ReadOnly" })).Status);

        var actions = factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Where(a => a.UserId == admin.UserId).Select(a => a.Action).ToList());
        Assert.Contains("admin.feature_override_set", actions);
    }

    [Fact]
    public async Task Limits_can_be_raised_and_overrides_removed_and_bad_ones_are_refused()
    {
        var admin = await Admin();
        var (owner, tenant, _) = await Org("FREE");
        var raised = await admin.Put($"/api/v1/admin/tenants/{tenant}/overrides/PROJECT_LIMIT", new { value = 50, reason = "Enterprise pilot" });
        Assert.True(raised.Ok, raised.ToString());
        Assert.Equal(50, (await owner.Get("/api/v1/me")).Data!["current"]!["entitlements"]!["PROJECT_LIMIT"]!.GetValue<int>());

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await admin.Put($"/api/v1/admin/tenants/{tenant}/overrides/NOT_A_FEATURE", new { value = 1, reason = "why not" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await admin.Put($"/api/v1/admin/tenants/{tenant}/overrides/API_ACCESS", new { value = 5, reason = "a switch is 0 or 1" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await admin.Put($"/api/v1/admin/tenants/{tenant}/overrides/PROJECT_LIMIT", new { value = -5, reason = "negative" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await admin.Put($"/api/v1/admin/tenants/{tenant}/overrides/PROJECT_LIMIT", new { value = 10, reason = "" })).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.Put($"/api/v1/admin/tenants/{Guid.NewGuid()}/overrides/PROJECT_LIMIT", new { value = 10, reason = "no such org" })).Status);

        Assert.Equal(HttpStatusCode.OK, (await admin.Delete($"/api/v1/admin/tenants/{tenant}/overrides/PROJECT_LIMIT")).Status);
        Assert.Equal(5, (await owner.Get("/api/v1/me")).Data!["current"]!["entitlements"]!["PROJECT_LIMIT"]!.GetValue<int>());
        Assert.Equal(HttpStatusCode.NotFound, (await admin.Delete($"/api/v1/admin/tenants/{tenant}/overrides/PROJECT_LIMIT")).Status);
    }

    // ------------------------------------------------------------------ platform switches

    [Fact]
    public async Task Closing_sign_ups_keeps_out_newcomers_but_not_people_who_were_invited()
    {
        var admin = await Admin();
        var (owner, _, _) = await Org("PRO");
        try
        {
            Assert.True((await admin.Put("/api/v1/admin/settings", new { signupsEnabled = false, maintenanceMode = false, announcement = "", announcementLevel = "info" })).Ok);

            var stranger = new TestClient(factory);
            var refused = await stranger.Send(HttpMethod.Post, "/api/v1/auth/register", new { email = $"new-{Guid.NewGuid():N}@example.com", password = "Passw0rd!x", displayName = "New", acceptedTerms = true }, true);
            Assert.Equal(HttpStatusCode.Forbidden, refused.Status);
            Assert.Equal("SIGNUPS_DISABLED", refused.ErrorCode);

            var invitedEmail = $"invited-{Guid.NewGuid():N}@example.com";
            Assert.True((await owner.Post("/api/v1/workspace/invitations", new { email = invitedEmail, role = "Member" })).Ok);
            var ok = await stranger.Send(HttpMethod.Post, "/api/v1/auth/register", new { email = invitedEmail, password = "Passw0rd!x", displayName = "Invited", acceptedTerms = true }, true);
            Assert.Equal(HttpStatusCode.Created, ok.Status);
        }
        finally { await admin.Put("/api/v1/admin/settings", new { signupsEnabled = true, maintenanceMode = false, announcement = "", announcementLevel = "info" }); }

        var again = await new TestClient(factory).Send(HttpMethod.Post, "/api/v1/auth/register", new { email = $"later-{Guid.NewGuid():N}@example.com", password = "Passw0rd!x", displayName = "Later", acceptedTerms = true }, true);
        Assert.Equal(HttpStatusCode.Created, again.Status);
    }

    [Fact]
    public async Task Maintenance_mode_pauses_changes_for_everyone_but_administrators_and_shows_the_announcement()
    {
        var admin = await Admin();
        var (owner, _, _) = await Org("FREE");
        var project = await owner.CreateProjectAsync("Before");
        try
        {
            Assert.True((await admin.Put("/api/v1/admin/settings", new { signupsEnabled = true, maintenanceMode = true, announcement = "Upgrading tonight at 22:00", announcementLevel = "warning" })).Ok);

            var status = await new TestClient(factory).Send(HttpMethod.Get, "/api/v1/platform/status", null, true);   // anyone can see it, signed in or not
            Assert.True(status.Data!["maintenanceMode"]!.GetValue<bool>());
            Assert.Equal("Upgrading tonight at 22:00", status.Data["announcement"]!.GetValue<string>());
            Assert.Equal("warning", status.Data["announcementLevel"]!.GetValue<string>());

            var blocked = await owner.Post("/api/v1/projects", new { name = "During", priority = "Low" });
            Assert.Equal(HttpStatusCode.ServiceUnavailable, blocked.Status);
            Assert.Equal("MAINTENANCE_MODE", blocked.ErrorCode);
            Assert.True((await owner.Get($"/api/v1/projects/{project}")).Ok);                       // reading still works
            Assert.True((await owner.LoginAsync()).Ok);                                            // and so does signing in
            Assert.True((await admin.Post("/api/v1/workspaces", new { name = $"Admin org {Guid.NewGuid():N}"[..14] })).Ok);   // administrators may still change things
        }
        finally { await admin.Put("/api/v1/admin/settings", new { signupsEnabled = true, maintenanceMode = false, announcement = "", announcementLevel = "info" }); }

        Assert.True((await owner.Post("/api/v1/projects", new { name = "After", priority = "Low" })).Ok);
        Assert.Null((await new TestClient(factory).Send(HttpMethod.Get, "/api/v1/platform/status", null, true)).Data!["announcement"]);
    }

    [Fact]
    public async Task Platform_settings_are_validated()
    {
        var admin = await Admin();
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await admin.Put("/api/v1/admin/settings", new { signupsEnabled = true, maintenanceMode = false, announcement = new string('x', 301), announcementLevel = "info" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await admin.Put("/api/v1/admin/settings", new { signupsEnabled = true, maintenanceMode = false, announcement = "", announcementLevel = "purple" })).Status);
    }

    // ------------------------------------------------------------------ health

    [Fact]
    public async Task Health_reports_database_queues_traffic_and_a_verdict()
    {
        var admin = await Admin();
        var (owner, _, _) = await Org("PRO");
        await owner.Post("/api/v1/reports/exports", new { kind = "Project", format = "Csv" });   // something waiting in a queue

        var h = (await admin.Get("/api/v1/admin/health")).Data!;
        // Shared test database: emails that other tests left unsent can make the verdict "degraded", but never "down".
        Assert.Contains(h["status"]!.GetValue<string>(), new[] { "ok", "degraded" });
        Assert.True(h["database"]!["reachable"]!.GetValue<bool>());
        Assert.Contains(Environment.GetEnvironmentVariable("PM_TEST_POSTGRES") is null ? "Sqlite" : "PostgreSQL", h["database"]!["provider"]!.GetValue<string>());
        Assert.True(h["database"]!["pendingMigrations"]!.GetValue<int>() >= 0); // the test database is created from the model, not from migrations
        Assert.True(h["traffic"]!["requests"]!.GetValue<long>() > 0);
        Assert.True(h["queues"]!["reportsWaiting"]!.GetValue<int>() >= 1);
        Assert.True(h["uptimeSeconds"]!.GetValue<long>() >= 0);
        Assert.False(string.IsNullOrWhiteSpace(h["version"]!.GetValue<string>()));
    }
}
