using System.Net;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public class FlowRegressionTests(ApiFactory factory)
{
    [Fact]
    public async Task A_view_only_assignee_cannot_edit_the_task_or_its_related_work()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Viewer");
        var project = await owner.CreateProjectAsync();
        var task = await owner.CreateTaskAsync(project, "Original", new { title = "Original", priority = "Low", assigneeId = member.UserId });
        var id = task["id"]!.GetValue<string>();
        var role = (await owner.Post("/api/v1/org/roles", new { name = "View only" })).Data!["id"]!.GetValue<string>();
        Assert.True((await owner.Put($"/api/v1/org/members/{member.UserId}/role", new { roleId = role })).Ok);
        Assert.True((await owner.Put($"/api/v1/org/roles/{role}/access", new { modules = new { projects = 1, tasks = 1 }, actions = new { } })).Ok);

        var read = await member.Get($"/api/v1/tasks/{id}");
        Assert.True(read.Ok);
        Assert.False(read.Data!["task"]!["canEdit"]!.GetValue<bool>());
        var edit = await member.Put($"/api/v1/tasks/{id}", new { title = "Changed", priority = "Low", statusId = task["statusId"]!.GetValue<string>(), assigneeId = member.UserId, version = task["version"]!.GetValue<int>() });
        Assert.Equal(HttpStatusCode.Forbidden, edit.Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Send(HttpMethod.Patch, $"/api/v1/tasks/{id}/move", new { statusId = task["statusId"]!.GetValue<string>() })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Post($"/api/v1/tasks/{id}/checklist", new { title = "No edits" })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Post($"/api/v1/tasks/{id}/timer/start")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Upload($"/api/v1/projects/{project}/tasks/{id}/attachments", "note.txt", "blocked"u8.ToArray())).Status);
        Assert.Equal("Original", (await owner.Get($"/api/v1/tasks/{id}")).Data!["task"]!["title"]!.GetValue<string>());

        // Removing the explicit restriction restores normal assignee editing.
        Assert.True((await owner.Delete($"/api/v1/org/roles/{role}/access")).Ok);
        Assert.True((await member.Get($"/api/v1/tasks/{id}")).Data!["task"]!["canEdit"]!.GetValue<bool>());
        Assert.True((await member.Put($"/api/v1/tasks/{id}", new { title = "Allowed", priority = "Low", statusId = task["statusId"]!.GetValue<string>(), assigneeId = member.UserId, version = task["version"]!.GetValue<int>() })).Ok);
    }

    [Fact]
    public async Task A_suspended_organization_refuses_acceptance_without_consuming_the_invitation()
    {
        var owner = await TestClient.RegisterAsync(factory);
        var org = await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        var person = await TestClient.RegisterAsync(factory);
        Assert.True((await owner.Post("/api/v1/workspace/invitations", new { email = person.Email, role = "Member" })).Ok);
        var token = await person.MailboxToken("invite");
        factory.WithDb(db => { db.Tenants.Single(t => t.Id == org).Status = TenantStatus.Suspended; db.SaveChanges(); return 0; });

        var refused = await person.Post("/api/v1/invitations/accept", new { token });
        Assert.Equal(HttpStatusCode.Conflict, refused.Status);
        Assert.Equal("INVITATION_INVALID", refused.ErrorCode);
        Assert.False((await person.Get($"/api/v1/invitations/lookup?token={Uri.EscapeDataString(token)}")).Data!["accepted"]!.GetValue<bool>());
        Assert.False(factory.WithDb(db => db.TenantMembers.Any(m => m.TenantId == org && m.UserId == person.UserId)));

        factory.WithDb(db => { db.Tenants.Single(t => t.Id == org).Status = TenantStatus.Active; db.SaveChanges(); return 0; });
        Assert.True((await person.Post("/api/v1/invitations/accept", new { token })).Ok);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Acceptance_rechecks_the_destination_limit_after_downgrade_or_expiry(bool expired)
    {
        var owner = await TestClient.RegisterAsync(factory);
        var org = await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO", 2);
        var person = await TestClient.RegisterAsync(factory); // still in their one-seat personal workspace
        Assert.True((await owner.Post("/api/v1/workspace/invitations", new { email = person.Email, role = "Member" })).Ok);
        var token = await person.MailboxToken("invite");
        if (expired) factory.WithDb(db => { db.Subscriptions.Single(s => s.TenantId == org).Status = SubscriptionStatus.Expired; db.SaveChanges(); return 0; });
        else Assert.True((await owner.Post("/api/v1/billing/checkout", new { planCode = "FREE", startTrial = false })).Ok);

        var refused = await person.Post("/api/v1/invitations/accept", new { token });
        Assert.Equal(HttpStatusCode.Forbidden, refused.Status);
        Assert.Equal("PLAN_LIMIT_REACHED", refused.ErrorCode);
        Assert.False((await person.Get($"/api/v1/invitations/lookup?token={Uri.EscapeDataString(token)}")).Data!["accepted"]!.GetValue<bool>());
        Assert.False(factory.WithDb(db => db.TenantMembers.Any(m => m.TenantId == org && m.UserId == person.UserId)));

        await owner.UpgradeAsync("PRO", 2);
        // The pending invitation is converted to a member, not counted twice; the personal plan is irrelevant.
        var accepted = await person.Post("/api/v1/invitations/accept", new { token });
        Assert.True(accepted.Ok, accepted.ToString());
        Assert.Equal(2, accepted.Data!["memberCount"]!.GetValue<int>());
        Assert.Equal("PRO", accepted.Data["planCode"]!.GetValue<string>());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Repeating_a_trial_request_never_starts_a_paid_checkout(bool hosted)
    {
        factory.Payments.Hosted = hosted;
        try
        {
            var owner = await TestClient.RegisterAsync(factory);
            await owner.CreateOrgAsync();
            var started = factory.Payments.Started.Count;
            Assert.True((await owner.Post("/api/v1/billing/checkout", new { planCode = "BUSINESS", startTrial = true })).Ok);
            var refused = await owner.Post("/api/v1/billing/checkout", new { planCode = "PRO", startTrial = true });
            Assert.Equal(HttpStatusCode.Conflict, refused.Status);
            Assert.Equal("TRIAL_NOT_AVAILABLE", refused.ErrorCode);
            var overview = (await owner.Get("/api/v1/billing")).Data!;
            Assert.Equal("Trial", overview["plan"]!["status"]!.GetValue<string>());
            Assert.Equal("BUSINESS", overview["plan"]!["code"]!.GetValue<string>());
            Assert.Empty(overview["invoices"]!.AsArray());
            Assert.Equal(started, factory.Payments.Started.Count);
        }
        finally { factory.Payments.Hosted = false; }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Pending_or_active_provider_subscriptions_cannot_be_replaced_with_a_trial(bool confirmed)
    {
        factory.Payments.Hosted = true;
        try
        {
            var owner = await TestClient.RegisterAsync(factory);
            var org = await owner.CreateOrgAsync();
            var checkout = await owner.Post("/api/v1/billing/checkout", new { planCode = "PRO", startTrial = false });
            var subscription = checkout.Data!["payment"]!["subscriptionId"]!.GetValue<string>();
            if (confirmed) Assert.True((await owner.Post("/api/v1/billing/confirm", new { paymentId = "pay_trial_guard", subscriptionId = subscription, signature = FakePayments.CheckoutSignature("pay_trial_guard", subscription) })).Ok);
            var before = factory.WithDb(db => db.Subscriptions.AsNoTracking().Single(s => s.TenantId == org));
            var starts = factory.Payments.Started.Count;
            var cancels = factory.Payments.Cancelled.Count;
            Assert.False((await owner.Get("/api/v1/billing")).Data!["trialAvailable"]!.GetValue<bool>());
            var refused = await owner.Post("/api/v1/billing/checkout", new { planCode = "BUSINESS", startTrial = true });
            Assert.Equal("TRIAL_NOT_AVAILABLE", refused.ErrorCode);
            var after = factory.WithDb(db => db.Subscriptions.AsNoTracking().Single(s => s.TenantId == org));
            Assert.Equal(before.PlanId, after.PlanId);
            Assert.Equal(before.Status, after.Status);
            Assert.Equal(before.CurrentPeriodEnd, after.CurrentPeriodEnd);
            Assert.Equal(before.ProviderSubscriptionId, after.ProviderSubscriptionId);
            Assert.Equal(before.PendingProviderSubscriptionId, after.PendingProviderSubscriptionId);
            Assert.Equal(starts, factory.Payments.Started.Count);
            Assert.Equal(cancels, factory.Payments.Cancelled.Count);
        }
        finally { factory.Payments.Hosted = false; }
    }

    [Theory]
    [InlineData("/invite?token=invited-person", "/invite?token=invited-person")]
    [InlineData("https://external.example", null)]
    [InlineData("//external.example", null)]
    [InlineData("/\\external.example", null)]
    [InlineData("/\n/external.example", null)]
    public async Task Registration_and_resend_carry_only_safe_return_paths_into_verification_emails(string returnUrl, string? expected)
    {
        var person = new TestClient(factory) { Email = $"redirect-{Guid.NewGuid():N}@example.com" };
        Assert.True((await person.Send(HttpMethod.Post, "/api/v1/auth/register", new { email = person.Email, password = "Passw0rd!x", displayName = "Al", acceptedTerms = true, returnUrl }, true)).Ok);
        async Task CheckLink()
        {
            var mail = (await person.Send(HttpMethod.Get, "/api/v1/dev/emails", null, true)).Data!.AsArray().First(m => m!["to"]!.GetValue<string>() == person.Email)!;
            var match = Regex.Match(mail["text"]!.GetValue<string>(), @"verify-email\?([^\s]+)");
            Assert.True(match.Success);
            var query = QueryHelpers.ParseQuery(match.Groups[1].Value);
            Assert.Equal(expected, query.TryGetValue("redirect", out var redirect) ? redirect.ToString() : null);
        }
        await CheckLink();
        Assert.True((await person.Send(HttpMethod.Post, "/api/v1/auth/resend-verification", new { email = person.Email, returnUrl }, true)).Ok);
        await CheckLink();
        await person.VerifyEmailAsync();
        Assert.True((await person.LoginAsync()).Ok);
    }
}
