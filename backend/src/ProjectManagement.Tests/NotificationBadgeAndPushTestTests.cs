using System.Net;
using System.Security.Cryptography;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Per-tab badges (docs/badges.md): every unread notification counts on exactly one sidebar place, so the places add up to the bell; and the
/// "Send test notification" check in Settings → Notifications, which pushes to the person's devices now and reports each answer.
/// </summary>
[Collection("api")]
public class NotificationBadgeAndPushTestTests(ApiFactory factory)
{
    [Theory]
    [InlineData(NotificationType.Message, "/chat/1b2c", "messages")]
    [InlineData(NotificationType.Mention, "/projects/abc?chat=1", "messages")]
    [InlineData(NotificationType.Mention, "/projects/abc/tasks/9", "work")]
    [InlineData(NotificationType.Meeting, "/meet", "meetings")]
    [InlineData(NotificationType.Reminder, "/meet?open=w:1", "meetings")]
    [InlineData(NotificationType.TaskAssigned, "/projects/abc", "work")]
    [InlineData(NotificationType.TaskUpdated, "/projects/abc", "work")]
    [InlineData(NotificationType.DueSoon, "/projects/abc", "today")]
    [InlineData(NotificationType.Approval, "/timesheet", "today")]
    [InlineData(NotificationType.Security, "/settings/security", "today")]
    [InlineData(NotificationType.Document, "/documents/7", "library")]
    [InlineData(NotificationType.Comment, "/library/pages/3", "library")]
    [InlineData(NotificationType.PortfolioDigest, "/portfolio", "portfolio")]
    [InlineData(NotificationType.ServiceLevel, "/desk/12", "desk")]
    [InlineData(NotificationType.Reminder, "/mail/inbox", "mail")]
    [InlineData(NotificationType.Reminder, "/?tab=calendar", "calendar")]
    public void Each_kind_has_one_destination(NotificationType type, string link, string expected) =>
        Assert.Equal(expected, NotificationDestinations.Of(type, link));

    [Fact]
    public async Task Tab_counts_add_up_to_the_unread_total()
    {
        var c = await TestClient.RegisterAsync(factory, "Tara Tabs");
        await c.CreateOrgAsync();
        factory.WithDb(db =>
        {
            var now = DateTime.UtcNow;
            (NotificationType, string)[] rows = [(NotificationType.Message, $"/chat/{Guid.NewGuid()}"), (NotificationType.TaskAssigned, "/projects/x"),
                (NotificationType.Document, "/documents/1"), (NotificationType.Meeting, "/meet"), (NotificationType.Overdue, "/projects/x")];
            foreach (var (t, l) in rows) db.Notifications.Add(new Notification { TenantId = c.WorkspaceId, UserId = c.UserId, Type = t, Title = "Fictional", Link = l, InApp = true, CreatedAt = now });
            db.SaveChanges();
            return 0;
        });
        var counts = (await c.Get("/api/v1/notifications/counts")).Data!;
        var tabs = counts["tabs"]!.AsObject();
        Assert.Equal(counts["unread"]!.GetValue<int>(), tabs.Sum(t => t.Value!.GetValue<int>()));
        Assert.Equal(1, tabs["messages:messages"]!.GetValue<int>());
        Assert.Equal(1, tabs["work:work"]!.GetValue<int>());
        Assert.Equal(1, tabs["library:work"]!.GetValue<int>());
        Assert.Equal(1, tabs["meetings:meetings"]!.GetValue<int>());
        Assert.Equal(1, tabs["today:reminders"]!.GetValue<int>());
    }

    [Fact]
    public async Task Test_push_reports_each_device_and_drops_expired_ones()
    {
        var c = await TestClient.RegisterAsync(factory, "Pia Pushtest");
        await c.CreateOrgAsync();
        var none = (await c.Post("/api/v1/push/test", new { endpoint = (string?)null })).Data!;
        Assert.True(none["keysReady"]!.GetValue<bool>());
        Assert.Equal(0, none["devices"]!.GetValue<int>());

        using var device = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        var dp = device.ExportParameters(false);
        byte[] uaPublic = [0x04, .. dp.Q.X!, .. dp.Q.Y!];
        var endpoint = $"https://push.example.test/send/{Guid.NewGuid():N}";
        Assert.True((await c.Post("/api/v1/push/subscriptions", new { endpoint, keys = new { p256dh = Base64Url.Encode(uaPublic), auth = Base64Url.Encode(RandomNumberGenerator.GetBytes(16)) } })).Ok);

        var ok = (await c.Post("/api/v1/push/test", new { endpoint })).Data!;
        Assert.True(ok["thisDeviceKnown"]!.GetValue<bool>());
        var row = ok["results"]!.AsArray().Single()!;
        Assert.True(row["accepted"]!.GetValue<bool>());
        Assert.True(row["thisDevice"]!.GetValue<bool>());
        Assert.Contains(factory.Push.Sent, s => s.Url.ToString() == endpoint);

        factory.Push.Status = HttpStatusCode.Gone;
        try
        {
            var gone = (await c.Post("/api/v1/push/test", new { endpoint })).Data!;
            Assert.False(gone["results"]!.AsArray().Single()!["accepted"]!.GetValue<bool>());
            Assert.Equal(0, (await c.Get("/api/v1/push")).Data!["devices"]!.GetValue<int>());
        }
        finally { factory.Push.Status = HttpStatusCode.Created; }
    }
}
