using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Infrastructure.Services;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Push to the Android app: its device token is kept like a browser subscription and the message is built for Firebase.</summary>
[Collection("api")]
public class NativePushTests(ApiFactory factory)
{
    [Fact]
    public async Task The_apps_device_token_is_stored_once_per_device_and_removed_with_unsubscribe()
    {
        var c = await TestClient.RegisterAsync(factory, "Native Push");
        await c.CreateOrgAsync("Native Co");
        var token = "dGVzdC10b2tlbi0x:APA91bExample_" + Guid.NewGuid().ToString("N");

        Assert.Equal(422, (int)(await c.Post("/api/v1/push/native", new { token = "has space" })).Status);
        Assert.Equal(422, (int)(await c.Post("/api/v1/push/native", new { token = "" })).Status);
        var first = await c.Post("/api/v1/push/native", new { token });
        Assert.True(first.Ok, first.ToString());
        var again = await c.Post("/api/v1/push/native", new { token });
        Assert.Equal(first.Data!["devices"]!.GetValue<int>(), again.Data!["devices"]!.GetValue<int>());
        Assert.False(again.Data!["nativeEnabled"]!.GetValue<bool>());   // no Firebase key is configured in tests

        // The same device can approve sign-ins like a browser can.
        var stored = factory.WithDb(db => db.PushSubscriptions.IgnoreQueryFilters().Count(s => s.Endpoint == "fcm:" + token));
        Assert.Equal(1, stored);

        var gone = await c.Post("/api/v1/push/unsubscribe", new { endpoint = "fcm:" + token });
        Assert.True(gone.Ok);
        Assert.Equal(0, factory.WithDb(db => db.PushSubscriptions.IgnoreQueryFilters().Count(s => s.Endpoint == "fcm:" + token)));
    }

    [Fact]
    public void The_firebase_message_shows_the_notification_and_carries_the_page_to_open()
    {
        var payload = JsonSerializer.Serialize(new { title = "Approve this sign-in?", body = "Open to check the number.", link = "/approve/abc", tag = "signin-1", type = "SignInRequest", urgent = true, number = (int?)null });
        using var doc = JsonDocument.Parse(FcmSender.BuildMessage("device-token", payload));
        var m = doc.RootElement.GetProperty("message");
        Assert.Equal("device-token", m.GetProperty("token").GetString());
        Assert.Equal("Approve this sign-in?", m.GetProperty("notification").GetProperty("title").GetString());
        var data = m.GetProperty("data");
        Assert.Equal("/approve/abc", data.GetProperty("link").GetString());
        Assert.Equal("True", data.GetProperty("urgent").GetString());   // data values are always strings
        Assert.False(data.TryGetProperty("number", out _));              // empty values are left out
        Assert.Equal("HIGH", m.GetProperty("android").GetProperty("priority").GetString());
    }
}
