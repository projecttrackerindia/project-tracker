using System.Net;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Every page lives under /{organization address}/…: the address is made from the name, never clashes with the app's own paths, and links that leave the app carry it.</summary>
[Collection("api")]
public class OrganizationAddressTests(ApiFactory factory)
{
    [Theory]
    [InlineData("Acme Bank", "acme-bank")]
    [InlineData("Quruize Technologies", "quruize-technologies")]
    [InlineData("Projects", "projects-org")]       // a page of the app
    [InlineData("AI", "ai-org")]
    [InlineData("Settings", "settings-org")]
    [InlineData("API", "api-org")]                 // served by the web server
    [InlineData("---", "workspace-org")]           // nothing usable in the name
    public void An_address_is_made_from_the_name_and_never_equals_a_name_the_app_uses(string name, string expected) =>
        Assert.Equal(expected, WorkspaceSlugs.For(name));

    [Fact]
    public async Task A_new_organization_gets_its_own_unique_address_that_the_app_reports()
    {
        var owner = await TestClient.RegisterAsync(factory, "Ada Owner");
        var one = await owner.Post("/api/v1/workspaces", new { name = "Projects" });
        var two = await owner.Post("/api/v1/workspaces", new { name = "Projects" });
        Assert.Equal(HttpStatusCode.Created, one.Status);
        Assert.Equal("projects-org", one.Data!["slug"]!.GetValue<string>());
        var second = two.Data!["slug"]!.GetValue<string>();
        Assert.StartsWith("projects-org-", second);                      // the same name again does not collide
        // The sign-in context carries it for the whole workspace list, so the browser can map an address to an organization.
        var ctx = (await owner.Get("/api/v1/me")).Data!;
        var slugs = ctx["workspaces"]!.AsArray().Select(w => w!["slug"]!.GetValue<string>()).ToList();
        Assert.Contains("projects-org", slugs);
        Assert.Contains(second, slugs);
        Assert.All(slugs, s => Assert.False(WorkspaceSlugs.IsReserved(s), s));
    }

    [Theory]
    [InlineData("acme", "/projects/42?task=7", "/acme/projects/42?task=7")]
    [InlineData("acme", "/operations?task=9", "/acme/operations?task=9")]
    [InlineData("acme", "/r/one-time-key", "/r/one-time-key")]            // works without signing in: stays as it is
    [InlineData("acme", null, "/acme/")]
    [InlineData(null, "/projects/42", "/projects/42")]
    public void Links_that_leave_the_app_say_which_organization_they_belong_to(string? slug, string? path, string expected) =>
        Assert.Equal(expected, NotificationEmailService.OrgLink(slug, path));

    [Fact]
    public void No_existing_organization_keeps_an_address_that_the_app_reserves()
    {
        // The migration renamed any such organization; this guards the list against drifting from what exists in the test database.
        var clashing = factory.WithDb(db => db.Tenants.IgnoreQueryFilters().Select(t => t.Slug).ToList()).Where(WorkspaceSlugs.IsReserved).ToList();
        Assert.Empty(clashing);
    }
}
