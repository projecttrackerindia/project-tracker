using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public class NotificationDeliveryTimingTests(ApiFactory factory)
{
    [Fact]
    public async Task Inbox_preserves_the_deferred_browser_delivery_time_for_the_page_fallback()
    {
        var person = await TestClient.RegisterAsync(factory, "Deferred desktop alerts");
        await person.CreateOrgAsync();
        var after = DateTime.UtcNow.AddHours(1);
        var id = factory.WithDb(db =>
        {
            var notification = new Notification
            {
                TenantId = person.WorkspaceId, UserId = person.UserId, Type = NotificationType.Message,
                Title = "Held through quiet hours", CreatedAt = DateTime.UtcNow, InApp = true, Browser = true,
                PushPending = true, DeliverAfter = after
            };
            db.Notifications.Add(notification);
            db.SaveChanges();
            return notification.Id;
        });
        var result = await person.Get("/api/v1/notifications?unreadOnly=true");
        Assert.True(result.Ok);
        var item = result.Data!["items"]!.AsArray().Single(n => n!["id"]!.GetValue<Guid>() == id)!;
        Assert.True(item["browser"]!.GetValue<bool>());
        Assert.InRange(Math.Abs((item["deliverAfter"]!.GetValue<DateTime>() - after).TotalSeconds), 0, 1);
    }
}
