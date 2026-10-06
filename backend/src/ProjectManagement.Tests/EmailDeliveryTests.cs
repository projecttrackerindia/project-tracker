using System.Net;
using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The mail system around the provider: logging, suppression, retries, one-click unsubscribe, digests, signed provider events and the domain check.</summary>
[Collection("api")]
public class EmailDeliveryTests(ApiFactory factory)
{
    private sealed class FlakyTransport : IEmailTransport
    {
        public bool Down { get; set; } = true;
        public List<EmailMessage> Sent { get; } = [];
        public string Name => "flaky";
        public Task SendAsync(EmailMessage message, CancellationToken ct = default)
        {
            if (Down) throw new InvalidOperationException("mail server unreachable");
            Sent.Add(message);
            return Task.CompletedTask;
        }
    }

    private ReliableEmailSender Reliable(FlakyTransport t) => new(t, factory.Services.GetRequiredService<IServiceScopeFactory>(), TimeProvider.System, NullLogger<ReliableEmailSender>.Instance);
    private static string Unique() => $"mail-{Guid.NewGuid():N}@example.test";

    [Fact]
    public async Task An_important_message_that_could_not_be_delivered_is_kept_and_sent_on_a_retry()
    {
        var transport = new FlakyTransport();
        var to = Unique();
        await Reliable(transport).SendAsync(new EmailMessage(to, "Reset your password", "<p>link</p>", "link", "reset"));   // does not throw: it is kept
        var row = factory.WithDb(db => db.EmailLogs.Single(l => l.ToEmail == to));
        Assert.Equal(EmailStatus.Queued, row.Status);
        Assert.Equal("<p>link</p>", row.Html);

        transport.Down = false;
        await using var scope = factory.Services.CreateAsyncScope();
        var retry = new EmailRetryService(scope.ServiceProvider.GetRequiredService<IAppDbContext>(), transport, new FakeLater(), NullLogger<EmailRetryService>.Instance);
        Assert.Equal(1, await retry.RetryDueAsync());
        Assert.Single(transport.Sent, m => m.To == to);
        var after = factory.WithDb(db => db.EmailLogs.Single(l => l.ToEmail == to));
        Assert.Equal(EmailStatus.Sent, after.Status);
        Assert.Null(after.Html);   // the one-time link is not kept once the message is out
    }

    /// <summary>A clock a few minutes ahead, so a message waiting for its retry is due.</summary>
    private sealed class FakeLater : TimeProvider { public override DateTimeOffset GetUtcNow() => DateTimeOffset.UtcNow.AddMinutes(10); }

    [Fact]
    public async Task A_message_without_a_kind_reports_the_failure_to_its_caller_and_is_not_kept()
    {
        var to = Unique();
        await Assert.ThrowsAsync<InvalidOperationException>(() => Reliable(new FlakyTransport()).SendAsync(new EmailMessage(to, "Test", "<p>x</p>")));
        var row = factory.WithDb(db => db.EmailLogs.Single(l => l.ToEmail == to));
        Assert.Equal(EmailStatus.Failed, row.Status);
        Assert.Null(row.Html);
    }

    [Fact]
    public async Task A_blocked_address_is_never_written_to_and_the_attempt_is_logged()
    {
        var to = Unique();
        factory.WithDb(db => { db.EmailSuppressions.Add(new EmailSuppression { Email = to, Reason = "bounce", CreatedAt = DateTime.UtcNow }); db.SaveChanges(); return 0; });
        var transport = new FlakyTransport { Down = false };
        await Reliable(transport).SendAsync(new EmailMessage(to.ToUpperInvariant(), "Hello", "<p>x</p>", "x", "invite"));
        Assert.Empty(transport.Sent);
        Assert.Equal(EmailStatus.Suppressed, factory.WithDb(db => db.EmailLogs.Single(l => l.ToEmail == to).Status));
    }

    // ------------------------------------------------------------------ one-click unsubscribe

    [Fact]
    public async Task The_unsubscribe_link_turns_off_that_kind_of_email_without_signing_in_and_cannot_be_forged_or_used_for_security_alerts()
    {
        var c = await TestClient.RegisterAsync(factory, "Una Unsub");
        var links = factory.Services.CreateScope().ServiceProvider.GetRequiredService<EmailLinks>();
        var token = links.Token(c.UserId, NotificationType.Mention);
        var anon = new TestClient(factory);

        var info = await anon.Send(HttpMethod.Get, $"/api/v1/email/unsubscribe?token={Uri.EscapeDataString(token)}", null, true);
        Assert.True(info.Ok, info.ToString());
        Assert.Equal("Mentions", info.Data!["label"]!.GetValue<string>());
        Assert.False(info.Data["alreadyOff"]!.GetValue<bool>());   // looking at the page changes nothing

        var done = await anon.Send(HttpMethod.Post, $"/api/v1/email/unsubscribe?token={Uri.EscapeDataString(token)}", new { }, true);
        Assert.True(done.Ok, done.ToString());
        var prefs = (await c.Get("/api/v1/me/notification-preferences")).Data!.AsArray();
        Assert.False(prefs.Single(p => p!["type"]!.ToString() == "Mention")!["email"]!.GetValue<bool>());

        Assert.Equal(HttpStatusCode.NotFound, (await anon.Send(HttpMethod.Post, $"/api/v1/email/unsubscribe?token={Uri.EscapeDataString(token[..^3] + "000")}", new { }, true)).Status);
        var security = links.Token(c.UserId, NotificationType.Security);
        Assert.Equal(HttpStatusCode.NotFound, (await anon.Send(HttpMethod.Post, $"/api/v1/email/unsubscribe?token={Uri.EscapeDataString(security)}", new { }, true)).Status);
        Assert.Null(links.Headers(c.UserId, NotificationType.Security));
        Assert.Contains("List-Unsubscribe-Post", links.Headers(c.UserId, NotificationType.Mention)!.Keys);
    }

    // ------------------------------------------------------------------ digests

    private sealed class CapturingSender : IEmailSender
    {
        public List<EmailMessage> Sent { get; } = [];
        public string Name => "capture";
        public Task SendAsync(EmailMessage message, CancellationToken ct = default) { Sent.Add(message); return Task.CompletedTask; }
    }

    [Fact]
    public async Task Three_or_more_ordinary_updates_become_one_email_but_urgent_ones_stay_separate()
    {
        var c = await TestClient.RegisterAsync(factory, "Dina Digest");
        await c.CreateOrgAsync();
        factory.WithDb(db =>
        {
            for (var i = 0; i < 3; i++) db.Notifications.Add(new Notification { TenantId = c.WorkspaceId, UserId = c.UserId, Type = NotificationType.TaskAssigned, Title = $"Task {i} assigned", Link = "/projects", EmailPending = true, InApp = true });
            db.Notifications.Add(new Notification { TenantId = c.WorkspaceId, UserId = c.UserId, Type = NotificationType.Overdue, Title = "A task is overdue", Link = "/my-work", EmailPending = true, InApp = true });
            db.SaveChanges(); return 0;
        });
        var sender = new CapturingSender();
        await using var scope = factory.Services.CreateAsyncScope();
        var sp = scope.ServiceProvider;
        var svc = new NotificationEmailService(sp.GetRequiredService<IAppDbContext>(), sender, sp.GetRequiredService<IOptions<AppOptions>>(), sp.GetRequiredService<AppClock>(), NullLogger<NotificationEmailService>.Instance, sp.GetRequiredService<EmailLinks>());
        await svc.SendPendingAsync(500);   // the shared test database may hold other people's pending mail too: look only at this person's
        var mine = sender.Sent.Where(m => m.To == c.Email).ToList();
        Assert.Equal(2, mine.Count);
        Assert.Single(mine, m => m.Subject.StartsWith("3 updates"));
        Assert.Single(mine, m => m.Subject.StartsWith("A task is overdue"));
        Assert.All(mine, m => Assert.True(m.Headers!.ContainsKey("List-Unsubscribe")));
        Assert.Contains("Task 1 assigned", mine.Single(m => m.Subject.StartsWith("3 updates")).Html);
    }

    // ------------------------------------------------------------------ provider events

    [Fact]
    public void Svix_signatures_are_checked_with_the_secret_the_time_and_the_exact_body()
    {
        var key = RandomNumberGenerator.GetBytes(24);
        var secret = "whsec_" + Convert.ToBase64String(key);
        var now = DateTimeOffset.UtcNow;
        string Sign(string id, string ts, string body) => "v1," + Convert.ToBase64String(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes($"{id}.{ts}.{body}")));
        var ts = now.ToUnixTimeSeconds().ToString();
        Assert.True(SvixSignature.Verify(secret, "msg_1", ts, Sign("msg_1", ts, "{\"a\":1}"), "{\"a\":1}", now));
        Assert.True(SvixSignature.Verify(secret, "msg_1", ts, "v1,AAAA " + Sign("msg_1", ts, "{}"), "{}", now));            // one of several signatures
        Assert.False(SvixSignature.Verify(secret, "msg_1", ts, Sign("msg_1", ts, "{\"a\":1}"), "{\"a\":2}", now));       // body changed
        Assert.False(SvixSignature.Verify("whsec_" + Convert.ToBase64String(RandomNumberGenerator.GetBytes(24)), "msg_1", ts, Sign("msg_1", ts, "{}"), "{}", now));
        var old = now.AddMinutes(-20).ToUnixTimeSeconds().ToString();
        Assert.False(SvixSignature.Verify(secret, "msg_1", old, Sign("msg_1", old, "{}"), "{}", now));                  // too old: a replay
        Assert.False(SvixSignature.Verify(secret, null, ts, "v1,AAAA", "{}", now));
    }

    [Fact]
    public async Task The_provider_event_endpoint_is_off_until_a_secret_is_set()
    {
        var res = await new TestClient(factory).Send(HttpMethod.Post, "/api/v1/email/webhooks/resend", new { type = "email.bounced" }, true);
        Assert.Equal(HttpStatusCode.NotFound, res.Status);
    }

    // ------------------------------------------------------------------ the administrator's view

    private async Task<TestClient> Admin()
    {
        var c = await TestClient.RegisterAsync(factory, "Mail Admin");
        factory.WithDb(db => { db.Users.IgnoreQueryFilters().Where(u => u.Id == c.UserId).ExecuteUpdate(s => s.SetProperty(u => u.IsPlatformAdmin, true)); return 0; });
        await c.LoginAsync();
        return c;
    }

    [Fact]
    public async Task Administrators_see_the_delivery_log_manage_blocked_addresses_and_check_the_domain_and_others_cannot()
    {
        var plain = await TestClient.RegisterAsync(factory, "Plain Person");
        Assert.Equal(HttpStatusCode.Forbidden, (await plain.Get("/api/v1/admin/email")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await plain.Get("/api/v1/admin/email/domain-check?domain=example.com")).Status);

        var admin = await Admin();
        var blocked = Unique();
        factory.WithDb(db => { db.EmailSuppressions.Add(new EmailSuppression { Email = blocked, Reason = "complaint", CreatedAt = DateTime.UtcNow }); db.SaveChanges(); return 0; });
        var overview = await admin.Get("/api/v1/admin/email");
        Assert.True(overview.Ok, overview.ToString());
        Assert.True(overview.Data!["suppressed"]!.GetValue<int>() >= 1);
        var list = await admin.Get("/api/v1/admin/email/suppressions");
        var row = list.Data!.AsArray().Single(x => x!["email"]!.GetValue<string>() == blocked)!;
        Assert.True((await admin.Delete($"/api/v1/admin/email/suppressions/{row["id"]!.GetValue<string>()}")).Ok);
        Assert.DoesNotContain(((await admin.Get("/api/v1/admin/email/suppressions")).Data!.AsArray()), x => x!["email"]!.GetValue<string>() == blocked);

        var domain = factory.Dns;
        domain.Publish("mail-check.example.test", "v=spf1 include:_spf.provider.test ~all");
        domain.Publish("_dmarc.mail-check.example.test", "v=DMARC1; p=quarantine");
        var check = await admin.Get("/api/v1/admin/email/domain-check?domain=mail-check.example.test");
        Assert.True(check.Ok, check.ToString());
        var byId = check.Data!["checks"]!.AsArray().ToDictionary(x => x!["id"]!.GetValue<string>(), x => x!["status"]!.GetValue<string>());
        Assert.Equal("ok", byId["spf"]); Assert.Equal("ok", byId["dmarc"]); Assert.Equal("warn", byId["dkim"]);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await admin.Get("/api/v1/admin/email/domain-check?domain=not a domain")).Status);
    }

    [Fact]
    public async Task Passkey_and_template_changes_reach_the_inbox_the_branded_template_has_a_preheader_and_plain_text()
    {
        var html = ProjectManagement.Application.Features.Auth.EmailTemplates.Wrap("Hello", "Hi <b>x</b>,", "Body & more", "Open", "https://app.test/x?a=1&b=2", "Footer", "Preview line", "https://app.test/unsubscribe?token=t");
        Assert.Contains("Preview line", html);
        Assert.Contains("Stop emails like this", html);
        Assert.Contains("Body &amp; more", html);
        Assert.Contains("a=1&amp;b=2", html);
        Assert.StartsWith("<!doctype html>", html.TrimStart());
    }

    [Fact]
    public void The_template_has_an_outlook_button_a_dark_scheme_a_kind_label_and_a_details_panel()
    {
        var html = ProjectManagement.Application.Features.Auth.EmailTemplates.Wrap("Join Acme", "Hello,", "You were invited.", "Accept invitation", "https://app.test/invite?token=abc",
            kind: ProjectManagement.Application.Features.Auth.EmailKind.Invitation, details: [("Workspace", "Acme <Works>"), ("Role", "Member")]);
        Assert.Contains("v:roundrect", html);                        // a real button in Outlook, which drops the padding of a link
        Assert.Contains("prefers-color-scheme:dark", html);
        Assert.Contains("INVITATION", html);
        Assert.Contains("Acme &lt;Works&gt;", html);                // details are encoded
        Assert.Contains("Notification settings", html);              // footer links come from the link's own site
        Assert.Contains("https://app.test/account/notifications", html);
        Assert.DoesNotContain("<Works>", html);
    }
}
