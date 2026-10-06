using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using ProjectManagement.Infrastructure.Persistence;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Plans are priced in one platform currency (INR by default), the prices are the administrator's to set, and the currency can be switched.</summary>
[Collection("api")]
public class BillingCurrencyTests(ApiFactory factory)
{
    private async Task<TestClient> Admin()
    {
        var c = await TestClient.RegisterAsync(factory, "Platform Admin");
        factory.WithDb(db => { db.Users.IgnoreQueryFilters().Where(u => u.Id == c.UserId).ExecuteUpdate(s => s.SetProperty(u => u.IsPlatformAdmin, true)); return 0; });
        await c.LoginAsync();
        return c;
    }

    private static JsonNode Plan(JsonArray plans, string code) => plans.Single(p => p!["code"]!.GetValue<string>() == code)!;

    private async Task<JsonArray> PlansSeenBy(TestClient c) => (await c.Get("/api/v1/billing")).Data!["plans"]!.AsArray();

    private async Task ResetCurrency(TestClient admin)
    {
        Assert.True((await admin.Put("/api/v1/admin/billing-settings", new { currency = "INR" })).Ok);
    }

    private static IConfiguration Config(params (string Key, string? Value)[] values) =>
        new ConfigurationBuilder().AddInMemoryCollection(values.Select(v => new KeyValuePair<string, string?>(v.Key, v.Value))).Build();

    // ------------------------------------------------------------------ defaults

    [Fact]
    public async Task Plans_are_priced_in_rupees_out_of_the_box_and_invoices_follow()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        var plans = await PlansSeenBy(c);
        Assert.All(plans, p => Assert.Equal("INR", p!["currency"]!.GetValue<string>()));
        Assert.Equal(0m, Plan(plans, "FREE")["priceMonthly"]!.GetValue<decimal>());
        Assert.Equal(349m, Plan(plans, "PRO")["priceMonthly"]!.GetValue<decimal>());
        Assert.Equal(699m, Plan(plans, "BUSINESS")["priceMonthly"]!.GetValue<decimal>());
        Assert.Null(Plan(plans, "ENTERPRISE")["priceMonthly"]);       // custom pricing

        await c.UpgradeAsync("PRO", 1);
        var invoice = (await c.Get("/api/v1/billing")).Data!["invoices"]!.AsArray().First()!;
        Assert.Equal("INR", invoice["currency"]!.GetValue<string>());
        Assert.Equal(349m, invoice["amount"]!.GetValue<decimal>());

        var admin = await Admin();
        var settings = (await admin.Get("/api/v1/admin/billing-settings")).Data!;
        Assert.Equal("INR", settings["currency"]!.GetValue<string>());
        Assert.Equal("INR", (await admin.Get("/api/v1/admin/billing")).Data!["currency"]!.GetValue<string>());
        Assert.Contains(settings["currencies"]!.AsArray(), x => x!["code"]!.GetValue<string>() == "USD");
    }

    // ------------------------------------------------------------------ the price is configurable

    [Fact]
    public async Task An_administrator_can_set_a_plans_price_and_new_invoices_use_it()
    {
        var admin = await Admin();
        var pro = Plan((await admin.Get("/api/v1/admin/plans")).Data!.AsArray(), "PRO");
        var id = pro["id"]!.GetValue<string>();
        object Body(decimal? price) => new { name = pro["name"]!.GetValue<string>(), description = pro["description"]?.GetValue<string>(), priceMonthly = price, isActive = true, features = pro["features"] };
        try
        {
            var before = await TestClient.RegisterAsync(factory); await before.CreateOrgAsync(); await before.UpgradeAsync("PRO", 1);

            var set = await admin.Put($"/api/v1/admin/plans/{id}", Body(1199.50m));
            Assert.True(set.Ok, set.ToString());
            Assert.Equal(1199.50m, set.Data!["priceMonthly"]!.GetValue<decimal>());
            Assert.Equal("INR", set.Data["currency"]!.GetValue<string>());

            var after = await TestClient.RegisterAsync(factory); await after.CreateOrgAsync();
            Assert.Equal(1199.50m, Plan(await PlansSeenBy(after), "PRO")["priceMonthly"]!.GetValue<decimal>());
            await after.UpgradeAsync("PRO", 1);
            Assert.Equal(1199.50m, (await after.Get("/api/v1/billing")).Data!["invoices"]!.AsArray().First()!["amount"]!.GetValue<decimal>());
            Assert.Equal(349m, (await before.Get("/api/v1/billing")).Data!["invoices"]!.AsArray().First()!["amount"]!.GetValue<decimal>());   // what was already charged stays

            Assert.Equal(HttpStatusCode.UnprocessableEntity, (await admin.Put($"/api/v1/admin/plans/{id}", Body(-5m))).Status);
            var custom = await admin.Put($"/api/v1/admin/plans/{id}", Body(null));            // no price = "contact sales"
            Assert.True(custom.Ok);
            Assert.Null(custom.Data!["priceMonthly"]);
        }
        finally { Assert.True((await admin.Put($"/api/v1/admin/plans/{id}", Body(349m))).Ok); }
    }

    // ------------------------------------------------------------------ the currency is configurable

    [Fact]
    public async Task The_billing_currency_can_be_switched_and_only_by_a_platform_administrator()
    {
        var admin = await Admin();
        var user = await TestClient.RegisterAsync(factory);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.Get("/api/v1/admin/billing-settings")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.Put("/api/v1/admin/billing-settings", new { currency = "USD" })).Status);

        var owner = await TestClient.RegisterAsync(factory); await owner.CreateOrgAsync(); await owner.UpgradeAsync("PRO", 1);   // an invoice issued in rupees
        try
        {
            var res = await admin.Put("/api/v1/admin/billing-settings", new { currency = "usd" });    // any case
            Assert.True(res.Ok, res.ToString());
            Assert.Equal("USD", res.Data!["currency"]!.GetValue<string>());
            Assert.All(await PlansSeenBy(owner), p => Assert.Equal("USD", p!["currency"]!.GetValue<string>()));
            Assert.All((await admin.Get("/api/v1/admin/plans")).Data!.AsArray(), p => Assert.Equal("USD", p!["currency"]!.GetValue<string>()));
            Assert.Equal("USD", (await admin.Get("/api/v1/admin/billing")).Data!["currency"]!.GetValue<string>());
            Assert.Equal("USD", (await admin.Get("/api/v1/admin/billing-settings")).Data!["currency"]!.GetValue<string>());

            // Prices are not converted, invoices already issued keep their currency and new ones use the new one.
            Assert.Equal(349m, Plan(await PlansSeenBy(owner), "PRO")["priceMonthly"]!.GetValue<decimal>());
            Assert.Equal("INR", (await owner.Get("/api/v1/billing")).Data!["invoices"]!.AsArray().First()!["currency"]!.GetValue<string>());
            var other = await TestClient.RegisterAsync(factory); await other.CreateOrgAsync(); await other.UpgradeAsync("PRO", 1);
            Assert.Equal("USD", (await other.Get("/api/v1/billing")).Data!["invoices"]!.AsArray().First()!["currency"]!.GetValue<string>());

            Assert.Contains("admin.billing_currency", (await admin.Get("/api/v1/admin/audit-logs?pageSize=50")).Data!.ToJsonString());
        }
        finally { await ResetCurrency(admin); }
        Assert.All(await PlansSeenBy(owner), p => Assert.Equal("INR", p!["currency"]!.GetValue<string>()));
    }

    [Fact]
    public async Task Only_listed_currencies_are_accepted()
    {
        var admin = await Admin();
        foreach (var bad in new[] { "XYZ", "", "  ", "US", "DOLLAR", "₹" })
            Assert.Equal(HttpStatusCode.UnprocessableEntity, (await admin.Put("/api/v1/admin/billing-settings", new { currency = bad })).Status);
        Assert.Equal("INR", (await admin.Get("/api/v1/admin/billing-settings")).Data!["currency"]!.GetValue<string>());
        Assert.Contains("INR", (await admin.Get("/api/v1/admin/billing-settings")).Data!["currencies"]!.AsArray().Select(x => x!["code"]!.GetValue<string>()));
    }

    // ------------------------------------------------------------------ start-up: configuration defaults and older databases

    [Fact]
    public async Task A_database_from_before_the_currency_existed_moves_its_dollar_starter_prices_to_rupees_and_keeps_custom_ones()
    {
        var admin = await Admin();
        try
        {
            factory.WithDb(db =>
            {
                db.PlatformSettings.Where(s => s.Key == "billing_currency").ExecuteDelete();
                db.Plans.Where(p => p.Code == "PRO").ExecuteUpdate(s => s.SetProperty(p => p.Currency, "USD").SetProperty(p => p.PriceMonthly, 12m));                // untouched starter price
                db.Plans.Where(p => p.Code == "BUSINESS").ExecuteUpdate(s => s.SetProperty(p => p.Currency, "USD").SetProperty(p => p.PriceMonthly, 35m));           // the administrator's own price
                DatabaseInitializer.SeedPlansAsync(db, default, Config()).GetAwaiter().GetResult();
                return 0;
            });
            var plans = (await admin.Get("/api/v1/admin/plans")).Data!.AsArray();
            Assert.Equal(("INR", 349m), (Plan(plans, "PRO")["currency"]!.GetValue<string>(), Plan(plans, "PRO")["priceMonthly"]!.GetValue<decimal>()));
            Assert.Equal(("INR", 35m), (Plan(plans, "BUSINESS")["currency"]!.GetValue<string>(), Plan(plans, "BUSINESS")["priceMonthly"]!.GetValue<decimal>()));   // labelled, not converted
            Assert.Equal("INR", (await admin.Get("/api/v1/admin/billing-settings")).Data!["currency"]!.GetValue<string>());
        }
        finally
        {
            factory.WithDb(db => { db.Plans.Where(p => p.Code == "BUSINESS").ExecuteUpdate(s => s.SetProperty(p => p.PriceMonthly, 699m)); return 0; });
        }
    }

    [Fact]
    public async Task The_deployment_can_choose_the_starting_currency_and_prices_but_the_administrators_choice_wins_afterwards()
    {
        var admin = await Admin();
        try
        {
            // Nothing stored yet: Billing:Currency decides. An unknown code falls back to INR.
            string Ensure(IConfiguration cfg) => factory.WithDb(db =>
            {
                db.PlatformSettings.Where(s => s.Key == "billing_currency").ExecuteDelete();
                return DatabaseInitializer.EnsureBillingCurrencyAsync(db, cfg, default).GetAwaiter().GetResult();
            });
            Assert.Equal("USD", Ensure(Config(("Billing:Currency", "usd"))));
            Assert.Equal("INR", Ensure(Config(("Billing:Currency", "NOPE"))));
            Assert.Equal("INR", Ensure(Config()));

            // Once the administrator has chosen, the configuration no longer overrides it.
            Assert.True((await admin.Put("/api/v1/admin/billing-settings", new { currency = "EUR" })).Ok);
            var kept = factory.WithDb(db => DatabaseInitializer.EnsureBillingCurrencyAsync(db, Config(("Billing:Currency", "USD")), default).GetAwaiter().GetResult());
            Assert.Equal("EUR", kept);
        }
        finally { await ResetCurrency(admin); }
    }

    [Fact]
    public async Task A_plan_that_is_created_at_start_up_takes_its_price_from_configuration_when_set()
    {
        var admin = await Admin();
        var enterprise = Plan((await admin.Get("/api/v1/admin/plans")).Data!.AsArray(), "ENTERPRISE");
        try
        {
            void Recreate(IConfiguration cfg) => factory.WithDb(db =>
            {
                var plan = db.Plans.Include(p => p.Features).Single(p => p.Code == "ENTERPRISE");
                db.PlanFeatures.RemoveRange(plan.Features); db.Plans.Remove(plan); db.SaveChanges();
                DatabaseInitializer.SeedPlansAsync(db, default, cfg).GetAwaiter().GetResult();
                return 0;
            });
            Recreate(Config(("Billing:Plans:ENTERPRISE:PriceMonthly", "9999")));
            var plans = (await admin.Get("/api/v1/admin/plans")).Data!.AsArray();
            Assert.Equal(9999m, Plan(plans, "ENTERPRISE")["priceMonthly"]!.GetValue<decimal>());
            Assert.Equal("INR", Plan(plans, "ENTERPRISE")["currency"]!.GetValue<string>());
            Assert.Equal(enterprise["features"]!["MAX_MEMBERS"]!.GetValue<long>(), Plan(plans, "ENTERPRISE")["features"]!["MAX_MEMBERS"]!.GetValue<long>());   // features seeded as before
        }
        finally
        {
            factory.WithDb(db =>
            {
                var plan = db.Plans.Include(p => p.Features).Single(p => p.Code == "ENTERPRISE");
                db.PlanFeatures.RemoveRange(plan.Features); db.Plans.Remove(plan); db.SaveChanges();
                DatabaseInitializer.SeedPlansAsync(db, default, Config()).GetAwaiter().GetResult();   // back to the built-in "custom pricing"
                return 0;
            });
        }
        Assert.Null(Plan((await admin.Get("/api/v1/admin/plans")).Data!.AsArray(), "ENTERPRISE")["priceMonthly"]);
    }
}
