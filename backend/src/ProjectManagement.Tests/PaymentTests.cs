using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Services;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Hosted payments (Razorpay): the payment window, the browser's confirmation, signed webhooks, cancelling, and the provider client itself.</summary>
[Collection("api")]
public class PaymentTests(ApiFactory factory)
{
    private async Task<(TestClient Owner, string Sub)> StartPro()
    {
        var owner = await TestClient.RegisterAsync(factory, "Pay Owner");
        await owner.CreateOrgAsync();
        var res = await owner.Post("/api/v1/billing/checkout", new { planCode = "PRO", startTrial = false });
        Assert.True(res.Ok, res.ToString());
        return (owner, res.Data!["payment"]!["subscriptionId"]!.GetValue<string>());
    }

    private static string Plan(TestClient c, ApiResult overview) => overview.Data!["plan"]!["code"]!.GetValue<string>();

    private async Task<ApiResult> Webhook(string type, string subId, string eventId, object? payment = null, long? start = null, long? end = null, string? bodyOverride = null, string? signature = null)
    {
        var body = bodyOverride ?? JsonSerializer.Serialize(new
        {
            @event = type,
            payload = new
            {
                subscription = new { entity = new { id = subId, status = "active", current_start = start, current_end = end } },
                payment = payment is null ? null : new { entity = payment },
            },
        });
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/billing/webhooks/razorpay") { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        req.Headers.Add("X-Razorpay-Signature", signature ?? FakePayments.WebhookSignature(body));
        req.Headers.Add("X-Razorpay-Event-Id", eventId);
        using var res = await factory.CreateClient().SendAsync(req);
        return new ApiResult(res.StatusCode, null);
    }

    private static object Pay(string id, long paise = 99900) => new { id, amount = paise, currency = "INR", status = "captured" };
    private static long Unix(DateTime d) => new DateTimeOffset(d, TimeSpan.Zero).ToUnixTimeSeconds();

    [Fact]
    public async Task Choosing_a_paid_plan_opens_a_payment_window_and_changes_nothing_until_it_is_paid()
    {
        factory.Payments.Hosted = true;
        try
        {
            var (owner, sub) = await StartPro();
            var overview = await owner.Get("/api/v1/billing");
            Assert.Equal("FREE", Plan(owner, overview));              // not yet
            Assert.Equal("razorpay", overview.Data!["paymentProvider"]!.GetValue<string>());

            var wrong = await owner.Post("/api/v1/billing/confirm", new { paymentId = "pay_1", subscriptionId = sub, signature = "forged" });
            Assert.Equal(HttpStatusCode.BadRequest, wrong.Status);
            Assert.Equal("PAYMENT_SIGNATURE_INVALID", wrong.ErrorCode);
            Assert.Equal("FREE", Plan(owner, await owner.Get("/api/v1/billing")));

            var elsewhere = await owner.Post("/api/v1/billing/confirm", new { paymentId = "pay_1", subscriptionId = "sub_other", signature = FakePayments.CheckoutSignature("pay_1", "sub_other") });
            Assert.Equal("PAYMENT_NOT_PENDING", elsewhere.ErrorCode);

            var ok = await owner.Post("/api/v1/billing/confirm", new { paymentId = "pay_1", subscriptionId = sub, signature = FakePayments.CheckoutSignature("pay_1", sub) });
            Assert.True(ok.Ok, ok.ToString());
            var again = await owner.Get("/api/v1/billing");
            Assert.True("PRO" == Plan(owner, again), "separate request: " + again.ToString().Substring(0, 200) + " | confirm: " + ok.ToString().Substring(0, 120));
            Assert.Equal("Active", ok.Data!["plan"]!["status"]!.GetValue<string>());
            var invoices = ok.Data["invoices"]!.AsArray();
            Assert.Single(invoices);
            Assert.Equal("Paid", invoices[0]!["status"]!.GetValue<string>());
        }
        finally { factory.Payments.Hosted = false; }
    }

    [Fact]
    public async Task The_webhook_activates_the_plan_even_if_the_browser_never_reported_back_and_each_event_counts_once()
    {
        factory.Payments.Hosted = true;
        try
        {
            var (owner, sub) = await StartPro();
            var start = DateTime.UtcNow; var end = start.AddMonths(1);
            Assert.Equal(HttpStatusCode.OK, (await Webhook("subscription.charged", sub, "evt_1", Pay("pay_w1"), Unix(start), Unix(end))).Status);
            var overview = await owner.Get("/api/v1/billing");
            Assert.Equal("PRO", Plan(owner, overview));
            Assert.Single(overview.Data!["invoices"]!.AsArray());

            Assert.Equal(HttpStatusCode.OK, (await Webhook("subscription.charged", sub, "evt_1", Pay("pay_w1"), Unix(start), Unix(end))).Status);                  // the provider retried
            Assert.Equal(HttpStatusCode.OK, (await Webhook("subscription.charged", sub, "evt_1b", Pay("pay_w1"), Unix(start), Unix(end))).Status);                 // same payment, a new event id
            Assert.Single((await owner.Get("/api/v1/billing")).Data!["invoices"]!.AsArray());

            var next = end.AddMonths(1);
            await Webhook("subscription.charged", sub, "evt_2", Pay("pay_w2"), Unix(end), Unix(next));
            var after = await owner.Get("/api/v1/billing");
            Assert.Equal(2, after.Data!["invoices"]!.AsArray().Count);
            Assert.Equal(next.Date, DateTime.Parse(after.Data["plan"]!["periodEnd"]!.GetValue<string>()).ToUniversalTime().Date);
        }
        finally { factory.Payments.Hosted = false; }
    }

    [Fact]
    public async Task A_webhook_with_a_bad_signature_is_refused_and_one_for_an_unknown_subscription_is_ignored()
    {
        Assert.Equal(HttpStatusCode.Unauthorized, (await Webhook("subscription.charged", "sub_x", "evt_bad", signature: "nope")).Status);
        Assert.Equal(HttpStatusCode.OK, (await Webhook("subscription.charged", "sub_nobody_knows", "evt_unknown", Pay("pay_u"))).Status);
    }

    [Fact]
    public async Task Failed_webhook_processing_rolls_back_admission_and_can_be_retried()
    {
        factory.Payments.Hosted = true;
        try
        {
            var (owner, sub) = await StartPro();
            var eventId = "retry_" + Guid.NewGuid().ToString("N");
            var failed = await Webhook("subscription.charged", sub, eventId, new { id = "pay_retry", amount = "invalid", currency = "INR" });
            Assert.Equal(HttpStatusCode.InternalServerError, failed.Status);
            Assert.False(factory.WithDb(db => db.BillingEvents.Any(e => e.ProviderEventId == eventId)));
            Assert.Empty((await owner.Get("/api/v1/billing")).Data!["invoices"]!.AsArray());
            var retry = await Webhook("subscription.charged", sub, eventId, Pay("pay_retry"));
            Assert.Equal(HttpStatusCode.OK, retry.Status);
            Assert.Single((await owner.Get("/api/v1/billing")).Data!["invoices"]!.AsArray());
            Assert.True(factory.WithDb(db => db.BillingEvents.Any(e => e.ProviderEventId == eventId)));
        }
        finally { factory.Payments.Hosted = false; }
    }

    [Fact]
    public async Task A_failed_renewal_puts_the_workspace_past_due_and_tells_the_owner_and_cancelling_keeps_the_paid_period()
    {
        factory.Payments.Hosted = true;
        try
        {
            var (owner, sub) = await StartPro();
            await Webhook("subscription.charged", sub, "evt_a", Pay("pay_f1"), Unix(DateTime.UtcNow), Unix(DateTime.UtcNow.AddMonths(1)));
            await Webhook("subscription.halted", sub, "evt_h");
            Assert.Equal("PastDue", (await owner.Get("/api/v1/billing")).Data!["plan"]!["status"]!.GetValue<string>());
            var notes = (await owner.Get("/api/v1/notifications?pageSize=20")).Json!.ToJsonString();
            Assert.Contains("Payment failed", notes);

            // Paying again (a new charge) brings it back.
            await Webhook("subscription.charged", sub, "evt_c", Pay("pay_f2"), Unix(DateTime.UtcNow), Unix(DateTime.UtcNow.AddMonths(1)));
            Assert.Equal("Active", (await owner.Get("/api/v1/billing")).Data!["plan"]!["status"]!.GetValue<string>());

            var cancelled = await owner.Post("/api/v1/billing/cancel");
            Assert.True(cancelled.Ok, cancelled.ToString());
            Assert.Contains(factory.Payments.Cancelled, c => c.Id == sub && c.AtCycleEnd);       // stops at the end of the period at the provider too
            Assert.Equal("PRO", Plan(owner, await owner.Get("/api/v1/billing")));                // the paid month is still theirs
            var resume = await owner.Post("/api/v1/billing/resume");
            Assert.Equal("CANNOT_RESUME", resume.ErrorCode);                                      // a cancelled mandate cannot be switched back on
        }
        finally { factory.Payments.Hosted = false; }
    }

    [Fact]
    public async Task Switching_plans_ends_the_older_recurring_payment_and_going_back_to_free_ends_it_too()
    {
        factory.Payments.Hosted = true;
        try
        {
            var (owner, pro) = await StartPro();
            await owner.Post("/api/v1/billing/confirm", new { paymentId = "pay_s1", subscriptionId = pro, signature = FakePayments.CheckoutSignature("pay_s1", pro) });
            var biz = (await owner.Post("/api/v1/billing/checkout", new { planCode = "BUSINESS", startTrial = false })).Data!["payment"]!["subscriptionId"]!.GetValue<string>();
            await owner.Post("/api/v1/billing/confirm", new { paymentId = "pay_s2", subscriptionId = biz, signature = FakePayments.CheckoutSignature("pay_s2", biz) });
            Assert.Equal("BUSINESS", Plan(owner, await owner.Get("/api/v1/billing")));
            Assert.Contains(factory.Payments.Cancelled, c => c.Id == pro && !c.AtCycleEnd);

            var free = await owner.Post("/api/v1/billing/checkout", new { planCode = "FREE", startTrial = false });
            Assert.True(free.Ok, free.ToString());
            Assert.Equal("FREE", Plan(owner, free));
            Assert.Contains(factory.Payments.Cancelled, c => c.Id == biz && !c.AtCycleEnd);
        }
        finally { factory.Payments.Hosted = false; }
    }

    [Fact]
    public async Task Only_someone_who_may_manage_billing_can_confirm_and_a_provider_failure_is_reported_politely()
    {
        var owner = await TestClient.RegisterAsync(factory, "Pay Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");                                  // simulated payments: a Pro workspace has room for a second person
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Plain Member");
        factory.Payments.Hosted = true;
        try
        {
            Assert.Equal(HttpStatusCode.Forbidden, (await member.Post("/api/v1/billing/confirm", new { paymentId = "p", subscriptionId = "s", signature = "x" })).Status);
            Assert.Equal(HttpStatusCode.Forbidden, (await member.Post("/api/v1/billing/checkout", new { planCode = "BUSINESS", startTrial = false })).Status);

            factory.Payments.FailToStart = true;
            var failed = await owner.Post("/api/v1/billing/checkout", new { planCode = "BUSINESS", startTrial = false });
            Assert.Equal(HttpStatusCode.BadGateway, failed.Status);
            Assert.Equal("PAYMENT_PROVIDER_ERROR", failed.ErrorCode);
            Assert.Equal("PRO", Plan(owner, await owner.Get("/api/v1/billing")));
        }
        finally { factory.Payments.Hosted = false; factory.Payments.FailToStart = false; }
    }

    // ------------------------------------------------------------------ the provider client

    private sealed class Stub : HttpMessageHandler
    {
        public List<(HttpRequestMessage Req, string Body)> Calls { get; } = [];
        public HttpStatusCode Status { get; set; } = HttpStatusCode.OK;
        public string Reply { get; set; } = "{\"id\":\"plan_ABC\"}";
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls.Add((request, request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct)));
            return new HttpResponseMessage(Status) { Content = new StringContent(Reply, Encoding.UTF8, "application/json") };
        }
    }

    private static RazorpayPaymentProvider Client(Stub stub) => new(new HttpClient(stub), Options.Create(new RazorpayOptions { KeyId = "rzp_test_key", KeySecret = "secret", WebhookSecret = "hook", BaseUrl = "https://rzp.test/v1" }), NullLogger<RazorpayPaymentProvider>.Instance);

    [Fact]
    public async Task The_razorpay_client_creates_plans_in_paise_subscriptions_and_cancellations_with_basic_auth_and_checks_signatures()
    {
        var stub = new Stub();
        var rzp = Client(stub);
        Assert.Equal("plan_ABC", await rzp.EnsurePlanAsync("PRO", "Pro", 999m, "INR", null, null));
        var plan = JsonDocument.Parse(stub.Calls[0].Body).RootElement;
        Assert.Equal(99900, plan.GetProperty("item").GetProperty("amount").GetInt64());
        Assert.Equal("monthly", plan.GetProperty("period").GetString());
        Assert.Equal("Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes("rzp_test_key:secret")), stub.Calls[0].Req.Headers.Authorization!.ToString());
        Assert.Equal("plan_OLD", await rzp.EnsurePlanAsync("PRO", "Pro", 999m, "INR", "plan_OLD", 999m));      // same price: reused, no call
        Assert.Single(stub.Calls);

        stub.Reply = "{\"id\":\"sub_XYZ\"}";
        var checkout = await rzp.StartSubscriptionAsync(Guid.NewGuid(), "PRO", "Pro", "plan_ABC", 999m, "INR");
        Assert.Equal("sub_XYZ", checkout.SubscriptionId); Assert.Equal("rzp_test_key", checkout.KeyId); Assert.Equal(99900, checkout.AmountMinor);
        Assert.Equal(120, JsonDocument.Parse(stub.Calls[^1].Body).RootElement.GetProperty("total_count").GetInt32());

        await rzp.CancelSubscriptionAsync("sub_XYZ", atCycleEnd: true);
        Assert.EndsWith("/subscriptions/sub_XYZ/cancel", stub.Calls[^1].Req.RequestUri!.AbsolutePath);
        Assert.Equal(1, JsonDocument.Parse(stub.Calls[^1].Body).RootElement.GetProperty("cancel_at_cycle_end").GetInt32());

        Assert.True(rzp.VerifyCheckout("pay_1", "sub_1", RazorpaySignature.Hex("secret", "pay_1|sub_1")));
        Assert.False(rzp.VerifyCheckout("pay_1", "sub_1", RazorpaySignature.Hex("secret", "pay_1|sub_2")));
        Assert.True(rzp.VerifyWebhook("{}", RazorpaySignature.Hex("hook", "{}").ToUpperInvariant()));
        Assert.False(rzp.VerifyWebhook("{}", null));
        Assert.Equal(1000, RazorpaySignature.Minor(10m, "INR")); Assert.Equal(10, RazorpaySignature.Minor(10m, "JPY"));
    }

    [Fact]
    public async Task A_refusal_from_razorpay_becomes_a_clear_error_without_leaking_the_keys()
    {
        var stub = new Stub { Status = HttpStatusCode.BadRequest, Reply = "{\"error\":{\"code\":\"BAD_REQUEST_ERROR\",\"description\":\"The amount must be at least 100 paise\"}}" };
        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => Client(stub).EnsurePlanAsync("PRO", "Pro", 0.5m, "INR", null, null));
        Assert.Contains("at least 100 paise", ex.Message);
        Assert.DoesNotContain("secret", ex.Message);
    }

    [Fact]
    public async Task A_provider_paid_subscription_is_never_charged_by_the_server_and_goes_past_due_only_when_the_provider_is_silent_for_days()
    {
        factory.Payments.Hosted = true;
        try
        {
            var (owner, sub) = await StartPro();
            await Webhook("subscription.charged", sub, "evt_l1", Pay("pay_l1"), Unix(DateTime.UtcNow.AddMonths(-1)), Unix(DateTime.UtcNow.AddDays(-1)));
            async Task Run() { await using var scope = factory.Services.CreateAsyncScope(); await scope.ServiceProvider.GetRequiredService<ProjectManagement.Application.Features.Billing.MaintenanceService>().RunSubscriptionLifecycleAsync(); }
            await Run();
            Assert.Equal("Active", (await owner.Get("/api/v1/billing")).Data!["plan"]!["status"]!.GetValue<string>());          // a day late: the provider may just be slow
            Assert.Single((await owner.Get("/api/v1/billing")).Data!["invoices"]!.AsArray());                                    // and no charge was made by us
            factory.WithDb(db => { db.Subscriptions.IgnoreQueryFilters().Where(x => x.TenantId == owner.WorkspaceId).ExecuteUpdate(u => u.SetProperty(x => x.CurrentPeriodEnd, DateTime.UtcNow.AddDays(-4))); return 0; });
            await Run();
            Assert.Equal("PastDue", (await owner.Get("/api/v1/billing")).Data!["plan"]!["status"]!.GetValue<string>());
        }
        finally { factory.Payments.Hosted = false; }
    }
}
