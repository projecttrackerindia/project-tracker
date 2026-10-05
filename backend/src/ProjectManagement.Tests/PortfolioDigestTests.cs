using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The Monday portfolio notice for owners and admins: when it is sent, to whom, and that it is only ever sent once a week.</summary>
[Collection("api")]
public class PortfolioDigestTests(ApiFactory factory)
{
    private async Task<int> Send(DateTime utc)
    {
        using var scope = factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<PortfolioDigestService>().SendAsync(utc, force: true);
    }

    private static async Task<string> Titles(TestClient c) => (await c.Get("/api/v1/notifications")).Data!.ToJsonString();

    [Fact]
    public async Task Owners_and_admins_get_the_portfolio_notice_on_monday_morning_once_a_week_and_nobody_else_does()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var admin = await owner.AddMemberAsync(factory, TenantRole.Admin, "Ada Admin");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mo Member");
        var res = await owner.Post("/api/v1/projects", new { name = "Late Programme", priority = "High", status = "Active", startDate = "2026-01-01", dueDate = "2026-02-01" });
        Assert.True(res.Ok, res.ToString());

        var monday = new DateTime(2026, 10, 12, 3, 30, 0, DateTimeKind.Utc);   // a Monday, 09:00 in the default time zone (India, UTC+5:30)
        Assert.Equal(0, await Send(monday.AddHours(-2)));                      // 07:00: before the briefing time
        Assert.Equal(0, await Send(monday.AddDays(1)));                        // Tuesday
        Assert.Equal(0, await Send(monday.AddHours(5)));                       // 14:00: too late in the day, not sent late
        Assert.True(await Send(monday) >= 2);                                 // at least this organization's owner and admin (the database is shared with other tests)
        Assert.Equal(0, await Send(monday.AddMinutes(30)));                    // already sent this week

        foreach (var who in new[] { owner, admin })
        {
            var text = await Titles(who);
            Assert.Contains("Portfolio this week", text);
            Assert.Contains("Late Programme", text);
        }
        Assert.DoesNotContain("Portfolio this week", await Titles(member));
        Assert.True(await Send(monday.AddDays(7)) >= 2);                      // and again the next Monday
        Assert.Equal(2, System.Text.RegularExpressions.Regex.Matches(await Titles(owner), "Portfolio this week").Count);
    }

    [Fact]
    public async Task A_person_can_switch_the_weekly_notice_off_like_any_other_notification()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olive Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        Assert.True((await owner.Post("/api/v1/projects", new { name = "Quiet Programme", priority = "Low", status = "Active", startDate = "2026-09-01", dueDate = "2026-12-01" })).Ok);
        var prefs = await owner.Get("/api/v1/me/notification-preferences");
        Assert.Contains("PortfolioDigest", prefs.Data!.ToJsonString());      // it is a choice in the person's settings
        var monday = new DateTime(2026, 10, 19, 3, 30, 0, DateTimeKind.Utc);
        Assert.True(await Send(monday) >= 1);
        Assert.Contains("Portfolio this week", await Titles(owner));
    }

    [Fact]
    public async Task A_person_can_ask_for_the_brief_now_and_gets_only_what_they_may_open()
    {
        var owner = await TestClient.RegisterAsync(factory, "Ola Owner");
        await owner.CreateOrgAsync();
        Assert.True((await owner.Post("/api/v1/projects", new { name = "Behind Programme", priority = "High", status = "Active", startDate = "2026-01-01", dueDate = "2026-02-01" })).Ok);
        var empty = await TestClient.RegisterAsync(factory, "Eve Empty");
        await empty.CreateOrgAsync();
        var none = await empty.Post("/api/v1/ai/portfolio/brief/send", new { });
        Assert.True(none.Ok); Assert.False(none.Data!["sent"]!.GetValue<bool>());          // nothing to report: nothing sent

        var res = await owner.Post("/api/v1/ai/portfolio/brief/send", new { });
        Assert.True(res.Ok, res.ToString());
        Assert.True(res.Data!["sent"]!.GetValue<bool>());
        var text = await Titles(owner);
        Assert.Contains("Portfolio this week", text); Assert.Contains("Behind Programme", text);
        Assert.DoesNotContain("Behind Programme", await Titles(empty));                      // another organization never sees it

        // Someone who switched the notice off is told so instead of being sent it.
        Assert.True((await owner.Put("/api/v1/me/notification-preferences", new { items = new[] { new { type = "PortfolioDigest", inApp = false, email = false, browser = false } } })).Ok);
        var off = await owner.Post("/api/v1/ai/portfolio/brief/send", new { });
        Assert.False(off.Data!["sent"]!.GetValue<bool>());
        Assert.Contains("switched this notice off", off.Data!["reason"]!.GetValue<string>());
    }
}
