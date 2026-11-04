using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Mailbox;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The background mail watcher: a baseline first, then one alert per new message (headers only), backoff on failure, owner-only.</summary>
[Collection("api")]
public class MailWatchTests(ApiFactory factory)
{
    private sealed class FakeImap : IMailHeaderSource
    {
        public uint Validity = 7;
        public List<MailHeader> Inbox { get; } = [];
        public bool Fail;
        public int Calls;
        public Task<MailPollResult> PollAsync(MailAccount account, uint lastUid, int max, CancellationToken ct)
        {
            Calls++;
            if (Fail) throw new IOException("unreachable");
            var highest = Inbox.Count == 0 ? 0u : Inbox.Max(h => h.Uid);
            return Task.FromResult(new MailPollResult(Validity, highest, lastUid == 0 ? [] : Inbox.Where(h => h.Uid > lastUid).TakeLast(max).ToList()));
        }
    }
    private sealed class FixedTime(DateTimeOffset now) : TimeProvider { public DateTimeOffset Now = now; public override DateTimeOffset GetUtcNow() => Now; }

    private async Task<int> Run(FakeImap imap, FixedTime time)
    {
        using var scope = factory.Services.CreateScope();
        var sp = scope.ServiceProvider;
        var clock = new AppClock(time, sp.GetRequiredService<IOptions<AppOptions>>());
        return await new MailWatchMonitor(sp.GetRequiredService<IAppDbContext>(), imap, sp.GetRequiredService<NotificationRouter>(), clock, NullLogger<MailWatchMonitor>.Instance).RunAsync();
    }

    [Fact]
    public async Task New_mail_becomes_one_notification_for_the_owner_only()
    {
        var me = await TestClient.RegisterAsync(factory, "Wen Watcher");
        await me.CreateOrgAsync();
        var account = new MailAccount { TenantId = me.WorkspaceId, UserId = me.UserId, Provider = "rediff", Email = "wen@example.test", ImapHost = "imap.example.test", SecretProtected = "sealed" };
        factory.WithDb(db => { db.MailAccounts.Add(account); return db.SaveChanges(); });
        var imap = new FakeImap();
        imap.Inbox.Add(new MailHeader(10, "<old@example.test>", "Old Sender", "Already there", DateTimeOffset.UtcNow));
        var time = new FixedTime(DateTimeOffset.UtcNow);

        Assert.Equal(0, await Run(imap, time));               // first look: a baseline, no alert for mail already there
        imap.Inbox.Add(new MailHeader(11, "<new@example.test>", "Priya Vendor", "Invoice for October", DateTimeOffset.UtcNow));
        Assert.Equal(0, await Run(imap, time));               // polled at most every two minutes
        time.Now = time.Now.AddMinutes(3);
        Assert.Equal(1, await Run(imap, time));
        time.Now = time.Now.AddMinutes(3);
        Assert.Equal(0, await Run(imap, time));               // never twice

        var notes = factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == me.UserId && n.Type == NotificationType.Message).ToList());
        var note = Assert.Single(notes);
        Assert.Equal("New mail from Priya Vendor", note.Title);
        Assert.Equal("Invoice for October", note.Body);
        Assert.Equal(me.WorkspaceId, note.TenantId);
        Assert.Contains(factory.Announced.Announced, a => a.NotificationId == note.Id && a.UserId == me.UserId);
        // Only the last UID and message ids are stored - no subject or body.
        var state = factory.WithDb(db => db.UserUiPreferences.Single(p => p.Key == MailWatchMonitor.KeyOf(account.Id)).Value);
        Assert.DoesNotContain("Invoice", state);
        Assert.Contains("\"LastUid\":11", state);

        // A burst is one summary; a failure backs off.
        for (uint u = 12; u < 17; u++) imap.Inbox.Add(new MailHeader(u, $"<b{u}@example.test>", $"Sender {u}", "Burst", DateTimeOffset.UtcNow));
        time.Now = time.Now.AddMinutes(3);
        Assert.Equal(1, await Run(imap, time));
        Assert.Contains(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == me.UserId).Select(n => n.Title).ToList()), t => t == "5 new emails");
        imap.Fail = true;
        time.Now = time.Now.AddMinutes(3);
        await Run(imap, time);
        var calls = imap.Calls;
        time.Now = time.Now.AddMinutes(3);
        await Run(imap, time);
        Assert.Equal(calls, imap.Calls);                       // backing off: not tried again within four minutes
    }
}
