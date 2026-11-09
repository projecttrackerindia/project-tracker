using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Application.Features.Load;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The Load arithmetic on its own: sizes, calibration, medians, spreading and the four states.</summary>
public class LoadMathTests
{
    private static readonly DateOnly Mon = new(2026, 11, 9);
    private static bool Weekday(DateOnly d) => d.DayOfWeek is not DayOfWeek.Saturday and not DayOfWeek.Sunday;

    [Fact]
    public void Sizes_map_to_hours_and_unknown_sizes_are_refused()
    {
        Assert.Equal(1, LoadMath.SizeHours("S")); Assert.Equal(4, LoadMath.SizeHours("m")); Assert.Equal(8, LoadMath.SizeHours("L")); Assert.Equal(24, LoadMath.SizeHours("XL"));
        Assert.Null(LoadMath.SizeHours(null));
        Assert.Equal("XL", LoadMath.NormaliseSize(" xl ", out var ok)); Assert.True(ok);
        Assert.Null(LoadMath.NormaliseSize("", out ok)); Assert.True(ok);
        LoadMath.NormaliseSize("XXL", out ok); Assert.False(ok);
    }

    [Fact]
    public void Calibration_needs_three_items_and_is_bounded()
    {
        Assert.Equal(1, LoadMath.Calibration([(4, 8), (4, 8)]));
        Assert.Equal(1.6, LoadMath.Calibration([(1, 10), (1, 10), (1, 10)]));
        Assert.Equal(0.7, LoadMath.Calibration([(10, 1), (10, 1), (10, 1)]));
        Assert.Equal(1.25, LoadMath.Calibration([(4, 5), (4, 5), (4, 5)]), 3);
        Assert.Null(LoadMath.Median([1, 2]));
        Assert.Equal(3, LoadMath.Median([5, 1, 3]));
    }

    [Fact]
    public void Work_is_spread_over_working_days_until_due_and_overdue_work_lands_today()
    {
        Assert.Equal([Mon, Mon.AddDays(1), Mon.AddDays(2)], LoadMath.SpreadDays(Mon, null, Mon.AddDays(2), Weekday));
        Assert.Equal([Mon], LoadMath.SpreadDays(Mon, null, Mon.AddDays(-4), Weekday));
        // Due Saturday: Mon-Fri; starting Thursday: Thu-Fri.
        Assert.Equal(5, LoadMath.SpreadDays(Mon, null, Mon.AddDays(5), Weekday).Count);
        Assert.Equal([Mon.AddDays(3), Mon.AddDays(4)], LoadMath.SpreadDays(Mon, Mon.AddDays(3), Mon.AddDays(5), Weekday));
        // Undated: the next ten working days.
        Assert.Equal(10, LoadMath.SpreadDays(Mon, null, null, Weekday).Count);
    }

    [Fact]
    public void States_follow_the_share_of_capacity()
    {
        Assert.Equal(LoadMath.Free, LoadMath.State(49));
        Assert.Equal(LoadMath.Balanced, LoadMath.State(50));
        Assert.Equal(LoadMath.Balanced, LoadMath.State(85));
        Assert.Equal(LoadMath.Stretched, LoadMath.State(110));
        Assert.Equal(LoadMath.Overloaded, LoadMath.State(111));
        Assert.Equal(999, LoadMath.Percent(60, 0));
        Assert.Equal("Wed–Thu", LoadMath.Range([Mon.AddDays(2), Mon.AddDays(3)]));
    }
}

/// <summary>The Load API: who sees whom, the day detail, sizes, the self-signal, the picker and moving work.</summary>
[Collection("api")]
public class LoadApiTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd");
    private static DateOnly WorkingDaysAhead(int n)
    {
        var d = AppDay.Today; var left = n;
        while (left > 0) { d = d.AddDays(1); if (d.DayOfWeek is not DayOfWeek.Saturday and not DayOfWeek.Sunday) left--; }
        return d;
    }

    [Fact]
    public async Task Load_shows_overloaded_people_first_only_to_those_who_may_see_them_and_moves_work()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Developer");
        var peer = await owner.AddMemberAsync(factory, TenantRole.Member, "Pat Peer");
        var project = await owner.CreateProjectAsync("Load Project");
        var due = WorkingDaysAhead(2);
        var big = await owner.CreateTaskAsync(project, "Big piece", new { title = "Big piece", priority = "Medium", assigneeId = dev.UserId, dueDate = Iso(due), estimatedHours = 40 });
        var small = await owner.CreateTaskAsync(project, "Small piece", new { title = "Small piece", priority = "Medium", assigneeId = dev.UserId, dueDate = Iso(due) });
        var bigId = S(big["id"]); var smallId = S(small["id"]);

        var load = await owner.Get("/api/v1/load?scope=people");
        Assert.True(load.Ok, load.ToString());
        var rows = load.Data!["rows"]!.AsArray();
        Assert.Equal(dev.UserId.ToString(), S(rows[0]!["id"]));
        Assert.Equal("overloaded", S(rows[0]!["state"]));
        Assert.Equal(14, rows[0]!["days"]!.AsArray().Count);
        Assert.Contains("2 tasks due", S(rows[0]!["reason"]));

        // A member with no team and no reports sees only themselves; another person's day is not theirs to open.
        var mine = (await peer.Get("/api/v1/load")).Data!["rows"]!.AsArray();
        Assert.Single(mine);
        Assert.Equal(peer.UserId.ToString(), S(mine[0]!["id"]));
        Assert.Equal(HttpStatusCode.NotFound, (await peer.Get($"/api/v1/load/{dev.UserId}/day/{Iso(due)}")).Status);

        // The day detail lists what fills it.
        var firstWorkDay = S(rows[0]!["days"]!.AsArray().First(d => S(d!["state"]) == "overloaded")!["date"]);
        var day = await owner.Get($"/api/v1/load/{dev.UserId}/day/{firstWorkDay}");
        Assert.True(day.Ok, day.ToString());
        Assert.Contains(day.Data!["items"]!.AsArray(), i => S(i!["title"]) == "Big piece" && S(i["basis"]) == "estimate");
        Assert.Contains(day.Data!["items"]!.AsArray(), i => S(i!["title"]) == "Small piece" && S(i["basis"]) == "default");

        // Sizes: S/M/L/XL only, and shown on the task.
        var sized = await owner.Put($"/api/v1/tasks/{smallId}/size", new { size = "l" });
        Assert.True(sized.Ok, sized.ToString());
        Assert.Equal("L", S(sized.Data!["size"]));
        Assert.Equal(422, (int)(await owner.Put($"/api/v1/tasks/{smallId}/size", new { size = "XXL" })).Status);

        // The self-signal.
        Assert.True((await peer.Put("/api/v1/load/signal", new { signal = "room" })).Ok);
        Assert.Equal(422, (int)(await peer.Put("/api/v1/load/signal", new { signal = "bored" })).Status);
        Assert.Equal("room", S((await peer.Get("/api/v1/load")).Data!["mySignal"]));

        // Suggestions and the picker: Pat has room.
        var sugg = await owner.Get("/api/v1/load/suggestions");
        Assert.True(sugg.Ok, sugg.ToString());
        var fit = await owner.Get($"/api/v1/load/fit?due={Iso(due)}&size=M&current={dev.UserId}");
        Assert.True(fit.Ok, fit.ToString());
        var best = fit.Data!["people"]!.AsArray().First();
        Assert.True(best!["bestFit"]!.GetValue<bool>());
        Assert.NotEqual(dev.UserId.ToString(), S(best["userId"]));

        // Move it (and the dry run says what would move).
        var dry = await owner.Post("/api/v1/load/reassign", new { toUserId = peer.UserId, items = new[] { new { kind = "task", id = bigId } }, dryRun = true });
        Assert.True(dry.Ok, dry.ToString());
        Assert.Equal(dev.UserId.ToString(), S(dry.Data!["items"]![0]!["fromUserId"]));
        var moved = await owner.Post("/api/v1/load/reassign", new { toUserId = peer.UserId, items = new[] { new { kind = "task", id = bigId } } });
        Assert.True(moved.Ok, moved.ToString());
        var after = (await owner.Get($"/api/v1/tasks/{bigId}")).Data!;
        Assert.Equal(peer.UserId.ToString(), S((after["task"] ?? after)["assignee"]!["id"]));
        // The cache saw the change: Dev is no longer overloaded by the big piece.
        var devRow = (await owner.Get("/api/v1/load")).Data!["rows"]!.AsArray().First(r => S(r!["id"]) == dev.UserId.ToString());
        Assert.NotEqual("overloaded", S(devRow!["state"]));

        Assert.Equal(422, (int)(await owner.Get("/api/v1/load?scope=planets")).Status);
    }
}
