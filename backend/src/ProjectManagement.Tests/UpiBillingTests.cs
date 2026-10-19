using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Billing;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Paying for a plan by UPI QR (until a payment gateway is connected): one QR at a time, the next one when paying fails, an account that keeps
/// failing is skipped, the payer gives the UTR, and only a platform administrator's confirmation activates the plan and records the invoice.
/// </summary>
[Collection("api")]
public class UpiBillingTests(ApiFactory factory)
{
    private UpiOptions Upi => factory.Services.GetRequiredService<IOptions<UpiOptions>>().Value;

    private void Configure(string tag)
    {
        Upi.Enabled = true; Upi.FailureThreshold = 3; Upi.FailureWindowHours = 24;
        Upi.Accounts = [
            new UpiAccount { Id = $"first{tag}@axl", Name = "Test Payee", Label = "Bank A" },
            new UpiAccount { Id = $"second{tag}@axl", Name = "Test Payee", Label = "Bank B" },
            new UpiAccount { Id = $"third{tag}@ybl", Name = "Test Payee", Label = "Bank C" },
        ];
    }

    private void Reset() { Upi.Enabled = false; Upi.Accounts = []; }

    private async Task<TestClient> AdminAsync()
    {
        var admin = await TestClient.RegisterAsync(factory, "Payments Admin");
        factory.WithDb(db => { db.Users.First(u => u.Id == admin.UserId).IsPlatformAdmin = true; db.SaveChanges(); return 0; });
        return admin;
    }

    private static string Tag() => Guid.NewGuid().ToString("N")[..6];

    [Fact]
    public async Task A_plan_is_paid_by_UPI_QR_switching_QR_on_failure_and_activated_only_when_an_administrator_confirms()
    {
        var tag = Tag();
        Configure(tag);
        try
        {
            var owner = await TestClient.RegisterAsync(factory, "Upi Owner");
            await owner.CreateOrgAsync();
            var checkout = await owner.Post("/api/v1/billing/checkout", new { planCode = "BUSINESS", startTrial = false, seats = 3 });
            Assert.True(checkout.Ok, checkout.ToString());
            Assert.Equal("upi", checkout.Data!["paymentProvider"]!.GetValue<string>());
            Assert.NotEqual("BUSINESS", checkout.Data["plan"]!["code"]!.GetValue<string>());   // nothing changes before the money is confirmed
            var pay = checkout.Data["upi"]!;
            Assert.Equal($"first{tag}@axl", pay["upiId"]!.GetValue<string>());
            Assert.Equal("Bank A", pay["bankLabel"]!.GetValue<string>());
            var uri = pay["upiUri"]!.GetValue<string>();
            Assert.StartsWith($"upi://pay?pa=first{tag}%40axl&pn=Test%20Payee&am=", uri);
            Assert.Contains("&cu=INR&tn=Project%20Tracker%20PT-", uri);
            Assert.True(pay["amount"]!.GetValue<decimal>() > 0);

            // Paying the first QR fails: the second one is shown, then the third.
            var second = await owner.Post($"/api/v1/billing/upi/{pay["id"]}/failed", new { reason = "Bank server down" });
            Assert.True(second.Ok, second.ToString());
            Assert.Equal($"second{tag}@axl", second.Data!["upiId"]!.GetValue<string>());
            Assert.Equal(2, second.Data["attempt"]!.GetValue<int>());
            Assert.Equal(pay["amount"]!.GetValue<decimal>(), second.Data["amount"]!.GetValue<decimal>());
            var third = await owner.Post($"/api/v1/billing/upi/{second.Data["id"]}/failed", new { });
            Assert.Equal($"third{tag}@ybl", third.Data!["upiId"]!.GetValue<string>());
            var id = third.Data["id"]!.GetValue<string>();

            Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"/api/v1/billing/upi/{id}/paid", new { utr = "12-34" })).Status);
            var utr = Random.Shared.NextInt64(100000000000, 999999999999).ToString();
            var paid = await owner.Post($"/api/v1/billing/upi/{id}/paid", new { utr });
            Assert.True(paid.Ok, paid.ToString());
            Assert.Equal("submitted", paid.Data!["status"]!.GetValue<string>());
            Assert.Equal("submitted", (await owner.Get("/api/v1/billing")).Data!["upi"]!["status"]!.GetValue<string>());

            // Only a platform administrator confirms.
            Assert.Equal(HttpStatusCode.Forbidden, (await owner.Post($"/api/v1/admin/upi-payments/{id}/confirm", new { })).Status);
            var admin = await AdminAsync();
            var waiting = await admin.Get("/api/v1/admin/upi-payments?status=submitted");
            Assert.Contains(waiting.Data!.AsArray(), p => p!["id"]!.GetValue<string>() == id && p["utr"]!.GetValue<string>() == utr);
            var confirmed = await admin.Post($"/api/v1/admin/upi-payments/{id}/confirm", new { note = "Seen in the statement" });
            Assert.True(confirmed.Ok, confirmed.ToString());
            Assert.Equal("confirmed", confirmed.Data!["status"]!.GetValue<string>());

            var overview = (await owner.Get("/api/v1/billing")).Data!;
            Assert.Equal("BUSINESS", overview["plan"]!["code"]!.GetValue<string>());
            Assert.Equal("Active", overview["plan"]!["status"]!.GetValue<string>());
            Assert.Contains(overview["invoices"]!.AsArray(), i => i!["status"]!.GetValue<string>() == "Paid" && i["amount"]!.GetValue<decimal>() == pay["amount"]!.GetValue<decimal>());
            factory.WithDb(db =>
            {
                var sub = db.Subscriptions.IgnoreQueryFilters().Single(s => s.TenantId == owner.WorkspaceId);
                Assert.Equal("upi", sub.Provider);
                Assert.Equal(3, sub.Seats);
                Assert.True(sub.CurrentPeriodEnd > DateTime.UtcNow.AddDays(25));
                return 0;
            });

            // The same bank transaction cannot pay for a second purchase.
            var other = await TestClient.RegisterAsync(factory, "Upi Other");
            await other.CreateOrgAsync();
            var otherPay = (await other.Post("/api/v1/billing/checkout", new { planCode = "BUSINESS", startTrial = false, seats = 1 })).Data!["upi"]!;
            Assert.Equal(HttpStatusCode.Conflict, (await other.Post($"/api/v1/billing/upi/{otherPay["id"]}/paid", new { utr })).Status);

            // A rejected payment tells the payer why.
            Assert.True((await other.Post($"/api/v1/billing/upi/{otherPay["id"]}/paid", new { utr = Random.Shared.NextInt64(100000000000, 999999999999).ToString() })).Ok);
            Assert.Equal(HttpStatusCode.UnprocessableEntity, (await admin.Post($"/api/v1/admin/upi-payments/{otherPay["id"]}/reject", new { })).Status);
            Assert.True((await admin.Post($"/api/v1/admin/upi-payments/{otherPay["id"]}/reject", new { note = "No such payment in the statement." })).Ok);
            var rejected = (await other.Get("/api/v1/billing")).Data!["upi"]!;
            Assert.Equal("rejected", rejected["status"]!.GetValue<string>());
            Assert.Equal("No such payment in the statement.", rejected["decisionNote"]!.GetValue<string>());

            // At the end of the paid period nothing renews by itself: the plan goes past due and the owner is asked to pay again.
            factory.WithDb(db =>
            {
                var sub = db.Subscriptions.IgnoreQueryFilters().Single(s => s.TenantId == owner.WorkspaceId);
                sub.CurrentPeriodEnd = DateTime.UtcNow.AddMinutes(-5);
                db.SaveChanges();
                return 0;
            });
            await using (var scope = factory.Services.CreateAsyncScope())
                await scope.ServiceProvider.GetRequiredService<MaintenanceService>().RunSubscriptionLifecycleAsync();
            factory.WithDb(db =>
            {
                Assert.Equal(SubscriptionStatus.PastDue, db.Subscriptions.IgnoreQueryFilters().Single(s => s.TenantId == owner.WorkspaceId).Status);
                Assert.True(db.Notifications.IgnoreQueryFilters().Any(n => n.TenantId == owner.WorkspaceId && n.Title == "Time to renew your plan"));
                return 0;
            });
        }
        finally { Reset(); }
    }

    [Fact]
    public async Task An_account_that_keeps_failing_is_skipped_for_new_payments()
    {
        var tag = Tag();
        Configure(tag);
        try
        {
            var owner = await TestClient.RegisterAsync(factory, "Upi Skipper");
            await owner.CreateOrgAsync();
            for (var i = 0; i < 3; i++)
            {
                var start = (await owner.Post("/api/v1/billing/checkout", new { planCode = "BUSINESS", startTrial = false, seats = 1 })).Data!["upi"]!;
                Assert.Equal($"first{tag}@axl", start["upiId"]!.GetValue<string>());
                Assert.True((await owner.Post($"/api/v1/billing/upi/{start["id"]}/failed", new { reason = "Payment declined" })).Ok);
            }
            // Three failures with no payment since: new payments start with the next account.
            var next = (await owner.Post("/api/v1/billing/checkout", new { planCode = "BUSINESS", startTrial = false, seats = 1 })).Data!["upi"]!;
            Assert.Equal($"second{tag}@axl", next["upiId"]!.GetValue<string>());

            var admin = await AdminAsync();
            var health = (await admin.Get("/api/v1/admin/upi-accounts")).Data!.AsArray();
            Assert.Equal(3, health.Single(a => a!["upiId"]!.GetValue<string>() == $"first{tag}@axl")!["recentFailures"]!.GetValue<int>());
            Assert.True(health.Single(a => a!["upiId"]!.GetValue<string>() == $"second{tag}@axl")!["inUse"]!.GetValue<bool>());

            // Cancelling leaves nothing open.
            Assert.True((await owner.Post($"/api/v1/billing/upi/{next["id"]}/cancel", new { })).Ok);
            Assert.Null((await owner.Get("/api/v1/billing")).Data!["upi"]);
        }
        finally { Reset(); }
    }
}
