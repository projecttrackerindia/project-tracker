using System.Net;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Each person's sidebar layout is saved with their account, only theirs, and can go back to the default.</summary>
[Collection("api")]
public class UiPreferenceTests(ApiFactory factory)
{
    [Fact]
    public async Task The_sidebar_layout_is_saved_per_person_and_validated()
    {
        var asha = await TestClient.RegisterAsync(factory, "Asha Layout");
        var ravi = await TestClient.RegisterAsync(factory, "Ravi Layout");
        var empty = await asha.Get("/api/v1/me/ui/sidebar");
        Assert.True(empty.Ok, empty.ToString());
        Assert.Null(empty.Data!["value"]);

        var layout = new { version = 1, pinned = new[] { "/timesheet" }, hidden = new[] { "/activity" }, collapsed = new[] { "Insights" }, order = new { Home = new[] { "/calendar", "/" } } };
        var saved = await asha.Put("/api/v1/me/ui/sidebar", new { value = layout });
        Assert.True(saved.Ok, saved.ToString());
        Assert.Equal("/timesheet", saved.Data!["value"]!["pinned"]![0]!.GetValue<string>());
        var again = await asha.Put("/api/v1/me/ui/sidebar", new { value = new { version = 1, pinned = new[] { "/calendar" } } });
        Assert.True(again.Ok, again.ToString());
        Assert.Equal("/calendar", (await asha.Get("/api/v1/me/ui/sidebar")).Data!["value"]!["pinned"]![0]!.GetValue<string>());
        Assert.Null((await ravi.Get("/api/v1/me/ui/sidebar")).Data!["value"]);   // only mine

        Assert.Equal(HttpStatusCode.NotFound, (await asha.Get("/api/v1/me/ui/everything")).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await asha.Put("/api/v1/me/ui/sidebar", new { value = new[] { 1, 2 } })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await asha.Put("/api/v1/me/ui/sidebar", new { value = new { pinned = new string('x', 9000) } })).Status);
        Assert.True((await asha.Put("/api/v1/me/ui/sidebar", new { value = (object?)null })).Ok);
        Assert.Null((await asha.Get("/api/v1/me/ui/sidebar")).Data!["value"]);
    }

    [Fact]
    public async Task Sidebar_project_pins_are_saved_per_person()
    {
        var asha = await TestClient.RegisterAsync(factory, "Asha Pins");
        Assert.Null((await asha.Get("/api/v1/me/ui/pins")).Data!["value"]);
        var pins = new Dictionary<string, object> { ["w1"] = new { pinned = new[] { "p1", "p2" }, hidden = new[] { "p3" } } };
        var saved = await asha.Put("/api/v1/me/ui/pins", new { value = pins });
        Assert.True(saved.Ok, saved.ToString());
        Assert.Equal("p2", (await asha.Get("/api/v1/me/ui/pins")).Data!["value"]!["w1"]!["pinned"]![1]!.GetValue<string>());
    }

    [Fact]
    public async Task Conversation_pins_and_hidden_chats_follow_the_person_and_allow_a_larger_value()
    {
        var asha = await TestClient.RegisterAsync(factory, "Asha Chats");
        var ravi = await TestClient.RegisterAsync(factory, "Ravi Chats");
        Assert.Null((await asha.Get("/api/v1/me/ui/conversations")).Data!["value"]);
        var hidden = Enumerable.Range(0, 150).ToDictionary(i => $"c{i:D4}-0000-0000-0000-000000000000", _ => "2026-10-01T10:00:00Z");
        var value = new Dictionary<string, object> { ["w1"] = new { pinned = new[] { "c1", "c2" }, hidden } };
        var saved = await asha.Put("/api/v1/me/ui/conversations", new { value });   // over 8,000 characters: allowed for this key
        Assert.True(saved.Ok, saved.ToString());
        Assert.Equal("c2", (await asha.Get("/api/v1/me/ui/conversations")).Data!["value"]!["w1"]!["pinned"]![1]!.GetValue<string>());
        Assert.Null((await ravi.Get("/api/v1/me/ui/conversations")).Data!["value"]);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await asha.Put("/api/v1/me/ui/conversations", new { value = new { pinned = new string('x', 33000) } })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await asha.Put("/api/v1/me/ui/sidebar", new { value })).Status);   // others keep 8,000
    }

    [Fact]
    public async Task A_chosen_card_theme_is_saved_and_shown_on_the_profile_to_others()
    {
        var owner = await TestClient.RegisterAsync(factory, "Owner Theme");
        var saved = await owner.Put("/api/v1/me/ui/profile", new { value = new { theme = "ocean" } });
        Assert.True(saved.Ok, saved.ToString());
        var uid = owner.UserId;
        var profile = await owner.Get($"/api/v1/workspace/members/{uid}/profile");
        Assert.True(profile.Ok, profile.ToString());
        Assert.Equal("ocean", profile.Data!["theme"]!.GetValue<string>());
        Assert.True((await owner.Put("/api/v1/me/ui/profile", new { value = new { theme = "not-a-theme" } })).Ok);
        Assert.Null((await owner.Get($"/api/v1/workspace/members/{uid}/profile")).Data!["theme"]);   // an unknown theme is never shown
    }
}
