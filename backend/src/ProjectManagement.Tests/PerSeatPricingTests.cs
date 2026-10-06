using System.Net;
using Microsoft.EntityFrameworkCore;
using System.Text;
using System.Text.Json;
using ProjectManagement.Application.Features.Billing;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Per-person pricing: what seats, billing period and team size cost, what they give (members, pooled AI credits and storage), and how a change of seats is paid for.</summary>
[Collection("api")]
public class PerSeatPricingTests(ApiFactory factory)
{
    private static readonly PricingOptions Rules = new();

    [Fact]
    public void Prices_add_up_per_person_with_a_volume_discount_and_a_yearly_discount_that_together_stop_at_30_percent()
    {
        PriceQuote Q(string code, decimal unit, int seats, string period, bool perSeat = true) => Pricing.Quote(Rules, code, unit, "INR", perSeat, seats, period);

        Assert.Equal(349m, Q("PRO", 349m, 1, "monthly").ChargePerCycle);                                  // one person, no discount
        var twelve = Q("PRO", 349m, 12, "monthly");                                                       // 12 people: 10% off
        Assert.Equal((10, 0, 10, 3769m), (twelve.VolumePercent, twelve.AnnualPercent, twelve.TotalPercent, twelve.ChargePerCycle));
        var yearly = Q("PRO", 349m, 12, "yearly");                                                        // plus a year at once: 10% + 20% = 30%
        Assert.Equal((30, 12, 35179m), (yearly.TotalPercent, yearly.CycleMonths, yearly.ChargePerCycle));
        Assert.Equal(244.30m, yearly.EffectivePerSeatMonthly);
        Assert.Equal(50256m - 35179m, yearly.SavedPerCycle);
        Assert.Equal(30, Q("BUSINESS", 699m, 100, "yearly").TotalPercent);                               // 20% + 20% would be 40%: capped
        Assert.Equal(20, Q("BUSINESS", 699m, 100, "monthly").TotalPercent);
        Assert.Equal(15, Q("BUSINESS", 699m, 30, "monthly").VolumePercent);
        Assert.Equal(0, Q("BUSINESS", 699m, 9, "monthly").VolumePercent);
        Assert.Equal(349m, Q("X", 349m, 50, "monthly", perSeat: false).ChargePerCycle);                   // a flat plan is not multiplied by people
        Assert.Equal("monthly", Pricing.NormalizePeriod("whatever"));
    }

    [Fact]
    public async Task Seats_and_a_yearly_period_set_the_amount_the_members_limit_and_the_pooled_credits_and_storage()
    {
        var owner = await TestClient.RegisterAsync(factory, "Seat Owner");
        var tid = await owner.CreateOrgAsync("Seat Works");
        await owner.UpgradeAsync("BUSINESS", 5, "yearly");

        var overview = (await owner.Get("/api/v1/billing")).Data!;
        var invoice = overview["invoices"]![0]!;
        Assert.Equal(33552m, invoice["amount"]!.GetValue<decimal>());                                    // 699 x 5 x 12, 20% off
        Assert.Contains("5 seats, billed yearly (20% off)", invoice["description"]!.GetValue<string>());
        Assert.Equal((true, 5, "yearly"), (overview["seats"]!["perSeat"]!.GetValue<bool>(), overview["seats"]!["purchased"]!.GetValue<int>(), overview["seats"]!["period"]!.GetValue<string>()));
        Assert.True(DateTime.Parse(overview["plan"]!["periodEnd"]!.GetValue<string>()).ToUniversalTime() > DateTime.UtcNow.AddMonths(11));

        factory.WithDb(db => { db.Users.IgnoreQueryFilters().Where(u => u.Id == owner.UserId).ExecuteUpdate(s => s.SetProperty(u => u.IsPlatformAdmin, true)); return 0; });
        await owner.LoginAsync();
        var limits = (await owner.Get($"/api/v1/admin/tenants/{tid}")).Data!["limits"]!;
        Assert.Equal(5, limits["MAX_MEMBERS"]!.GetValue<int>());
        Assert.Equal(5 * 200, limits["AI_MONTHLY_CREDITS"]!.GetValue<int>());                           // 200 credits a person, pooled
        Assert.Equal(5 * 25600, limits["STORAGE_LIMIT_MB"]!.GetValue<int>());                           // 25 GB a person, pooled
    }

    [Fact]
    public async Task Nobody_can_pay_for_fewer_seats_than_there_are_people_and_a_full_workspace_is_told_to_add_seats()
    {
        var owner = await TestClient.RegisterAsync(factory, "Full Owner");
        await owner.CreateOrgAsync("Full House");
        await owner.UpgradeAsync("PRO", 2);

        var invitee = await TestClient.RegisterAsync(factory, "Second");
        Assert.True((await owner.Post("/api/v1/workspace/invitations", new { email = invitee.Email, role = "Member" })).Ok);        // 1 member + 1 invitation = 2 seats
        var third = await TestClient.RegisterAsync(factory, "Third");
        var full = await owner.Post("/api/v1/workspace/invitations", new { email = third.Email, role = "Member" });
        Assert.Equal(HttpStatusCode.Forbidden, full.Status);
        Assert.Equal("PLAN_LIMIT_REACHED", full.ErrorCode);
        Assert.Contains("Add seats", full.ToString());

        var tooFew = await owner.Post("/api/v1/billing/checkout", new { planCode = "PRO", startTrial = false, seats = 1 });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, tooFew.Status);
        Assert.Contains("at least 2 seats", tooFew.ToString());
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post("/api/v1/billing/checkout", new { planCode = "PRO", startTrial = false, seats = 100000 })).Status);

        Assert.True((await owner.Post("/api/v1/billing/checkout", new { planCode = "PRO", startTrial = false, seats = 3 })).Ok);       // more seats: the invitation now fits
        Assert.True((await owner.Post("/api/v1/workspace/invitations", new { email = third.Email, role = "Member" })).Ok);
    }

    [Fact]
    public async Task A_trial_has_five_seats_and_a_small_pool_of_credits_and_the_quote_shows_what_a_choice_gives()
    {
        var owner = await TestClient.RegisterAsync(factory, "Trial Owner");
        var tid = await owner.CreateOrgAsync("Trial Works");
        Assert.True((await owner.Post("/api/v1/billing/checkout", new { planCode = "BUSINESS", startTrial = true })).Ok);
        factory.WithDb(db => { db.Users.IgnoreQueryFilters().Where(u => u.Id == owner.UserId).ExecuteUpdate(s => s.SetProperty(u => u.IsPlatformAdmin, true)); return 0; });
        await owner.LoginAsync();
        var limits = (await owner.Get($"/api/v1/admin/tenants/{tid}")).Data!["limits"]!;
        Assert.Equal(5, limits["MAX_MEMBERS"]!.GetValue<int>());
        Assert.Equal(100, limits["AI_MONTHLY_CREDITS"]!.GetValue<int>());                                // 5 x 200 would be 1000: a trial is capped

        var q = (await owner.Get("/api/v1/billing/quote?planCode=PRO&seats=12&period=yearly")).Data!;
        Assert.Equal(35179m, q["quote"]!["chargePerCycle"]!.GetValue<decimal>());
        Assert.Equal(30, q["quote"]!["totalPercent"]!.GetValue<int>());
        Assert.Equal(12 * 60, q["aiCredits"]!.GetValue<int>());
        Assert.Equal(12 * 5120, q["storageMb"]!.GetValue<int>());
        Assert.Equal(1, q["minSeats"]!.GetValue<int>());
    }

    [Fact]
    public async Task With_a_payment_provider_the_yearly_amount_is_the_plan_and_adding_seats_starts_at_the_next_renewal_without_paying_twice()
    {
        factory.Payments.Hosted = true;
        try
        {
            var owner = await TestClient.RegisterAsync(factory, "Hosted Seats");
            await owner.CreateOrgAsync("Hosted Seats Ltd");
            string Sig(string pay, string sub) => FakePayments.CheckoutSignature(pay, sub);

            // 1. Three seats, yearly: the provider's plan is the whole yearly amount, charged once a year.
            var start = await owner.Post("/api/v1/billing/checkout", new { planCode = "PRO", startTrial = false, seats = 3, period = "yearly" });
            Assert.True(start.Ok, start.ToString());
            var first = start.Data!["payment"]!["subscriptionId"]!.GetValue<string>();
            Assert.Equal(("yearly", 10051m), factory.Payments.Plans[^1]);                                  // 349 x 3 x 12, 20% off
            Assert.Null(factory.Payments.Started[^1].StartAt);
            Assert.True((await owner.Post("/api/v1/billing/confirm", new { paymentId = "pay_s1", subscriptionId = first, signature = Sig("pay_s1", first) })).Ok);
            var overview = (await owner.Get("/api/v1/billing")).Data!;
            Assert.Equal(3, overview["seats"]!["purchased"]!.GetValue<int>());
            Assert.Equal(10051m, overview["invoices"]![0]!["amount"]!.GetValue<decimal>());
            Assert.Contains("3 seats", overview["invoices"]![0]!["description"]!.GetValue<string>());

            // 2. Two more seats while the year is paid for: the new amount starts at the renewal, the seats are there now, and nothing is charged today.
            var more = await owner.Post("/api/v1/billing/checkout", new { planCode = "PRO", startTrial = false, seats = 5, period = "yearly" });
            var second = more.Data!["payment"]!["subscriptionId"]!.GetValue<string>();
            Assert.NotNull(factory.Payments.Started[^1].StartAt);
            Assert.True(factory.Payments.Started[^1].StartAt > DateTime.UtcNow.AddMonths(11));
            Assert.True((await owner.Post("/api/v1/billing/confirm", new { paymentId = "pay_s2", subscriptionId = second, signature = Sig("pay_s2", second) })).Ok);
            overview = (await owner.Get("/api/v1/billing")).Data!;
            Assert.Equal(5, overview["seats"]!["purchased"]!.GetValue<int>());
            Assert.Single(overview["invoices"]!.AsArray());                                               // no new invoice yet
            Assert.Contains((first, true), factory.Payments.Cancelled);                                   // the old yearly payment will not renew on top of it

            // 3. Fewer seats: the paid ones stay until the renewal, then the new amount takes over.
            var fewer = await owner.Post("/api/v1/billing/checkout", new { planCode = "PRO", startTrial = false, seats = 2, period = "yearly" });
            var third = fewer.Data!["payment"]!["subscriptionId"]!.GetValue<string>();
            Assert.True((await owner.Post("/api/v1/billing/confirm", new { paymentId = "pay_s3", subscriptionId = third, signature = Sig("pay_s3", third) })).Ok);
            Assert.Equal(5, (await owner.Get("/api/v1/billing")).Data!["seats"]!["purchased"]!.GetValue<int>());
            var due = DateTime.UtcNow.AddYears(1).AddMinutes(1); var body = JsonSerializer.Serialize(new { @event = "subscription.charged", payload = new { subscription = new { entity = new { id = third, current_start = new DateTimeOffset(due).ToUnixTimeSeconds(), current_end = new DateTimeOffset(due.AddYears(1)).ToUnixTimeSeconds() } }, payment = new { entity = new { id = "pay_s3c", amount = 6965L * 100, currency = "INR" } } } });
            using var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/billing/webhooks/razorpay") { Content = new StringContent(body, Encoding.UTF8, "application/json") };
            req.Headers.Add("X-Razorpay-Signature", FakePayments.WebhookSignature(body)); req.Headers.Add("X-Razorpay-Event-Id", "evt_s3");
            using var res = await factory.CreateClient().SendAsync(req);
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            overview = (await owner.Get("/api/v1/billing")).Data!;
            Assert.Equal(2, overview["seats"]!["purchased"]!.GetValue<int>());
            Assert.Equal(2, overview["invoices"]!.AsArray().Count);
        }
        finally { factory.Payments.Hosted = false; }
    }
}
