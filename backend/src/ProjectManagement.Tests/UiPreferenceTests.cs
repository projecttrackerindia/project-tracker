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
}
