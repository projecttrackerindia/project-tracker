using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Reading time written in plain words: durations, days and keys, in English, Hindi and Telugu.</summary>
public class TimeWordsTests
{
    // A Wednesday.
    private static readonly DateOnly Wed = new(2026, 10, 21);
    private static List<TimePiece> P(string text, int day = 480) => TimeWords.Parse(text, Wed, day);
    private static TimePiece One(string text) => Assert.Single(P(text));

    [Fact]
    public void Pieces_are_split_and_a_day_carries_to_the_pieces_after_it()
    {
        var p = P("2h on PAY-12 yesterday, 30m standup");
        Assert.Equal(2, p.Count);
        Assert.Equal((120, Wed.AddDays(-1), "PAY-12", ""), (p[0].Minutes, p[0].Date, p[0].Key, p[0].Rest));
        Assert.Equal((30, Wed.AddDays(-1), (string?)null, "standup"), (p[1].Minutes, p[1].Date, p[1].Key, p[1].Rest));
        Assert.All(p, x => Assert.Null(x.Problem));

        var lead = P("Yesterday: 3 hours PAY-1 and 2 hours on PAY-2; 45 min email");
        Assert.Equal([180, 120, 45], lead.Select(x => x.Minutes));
        Assert.All(lead, x => Assert.Equal(Wed.AddDays(-1), x.Date));
        Assert.Equal("email", lead[2].Rest);

        // "and" stays inside a piece that says how long only once.
        var joined = One("2h PAY-1 design and testing");
        Assert.Equal(("PAY-1", "design and testing"), (joined.Key, joined.Rest));
        // The only day said anywhere applies to the pieces before it too.
        Assert.All(P("1h PAY-1, 2h PAY-2 on monday"), x => Assert.Equal(Wed.AddDays(-2), x.Date));
        Assert.Equal([Wed, Wed.AddDays(-1)], P("1h PAY-1 today, 2h PAY-2 yesterday").Select(x => x.Date));
    }

    [Theory]
    [InlineData("1h 30m PAY-3", 90)]
    [InlineData("1h30 PAY-3", 90)]
    [InlineData("1.5 hours PAY-3", 90)]
    [InlineData("90 mins PAY-3", 90)]
    [InlineData("1:45 on PAY-3", 105)]
    [InlineData("half an hour on PAY-3", 30)]
    [InlineData("an hour and a half on PAY-3", 90)]
    [InlineData("one and a half hours on PAY-3", 90)]
    [InlineData("an hour on PAY-3", 60)]
    [InlineData("two hours on PAY-3", 120)]
    [InlineData("a quarter of an hour on PAY-3", 15)]
    [InlineData("full day on PAY-3", 480)]
    [InlineData("half day on PAY-3", 240)]
    [InlineData("10am to 12:30 on PAY-3", 150)]
    [InlineData("from 9 to 11 on PAY-3", 120)]
    [InlineData("2 to 4pm on PAY-3", 120)]
    [InlineData("11am-1pm PAY-3", 120)]
    [InlineData("at 10:30 standup 15m", 15)]
    [InlineData("kal 2 ghante PAY-3", 120)]
    [InlineData("aadha ghanta PAY-3", 30)]
    [InlineData("ninna 3 gantalu PAY-3", 180)]
    [InlineData("2 घंटे PAY-3", 120)]
    [InlineData("నిన్న 2 గంటలు PAY-3", 120)]
    [InlineData("45 నిమిషాలు PAY-3", 45)]
    public void Durations_are_read(string text, int minutes) => Assert.Equal(minutes, One(text).Minutes);

    [Theory]
    [InlineData("2h PAY-1 today", 0)]
    [InlineData("2h PAY-1 yesterday", -1)]
    [InlineData("2h PAY-1 day before yesterday", -2)]
    [InlineData("2h PAY-1 3 days ago", -3)]
    [InlineData("2h PAY-1 on monday", -2)]
    [InlineData("2h PAY-1 last friday", -5)]
    [InlineData("2h PAY-1 fri", -5)]
    [InlineData("2h PAY-1 wednesday", 0)]
    [InlineData("2h PAY-1 last wednesday", -7)]
    [InlineData("2h PAY-1 12 oct", -9)]
    [InlineData("2h PAY-1 oct 12th", -9)]
    [InlineData("2h PAY-1 12/10", -9)]
    [InlineData("2h PAY-1 2026-10-12", -9)]
    [InlineData("kal 2h PAY-1", -1)]
    [InlineData("parso 2h PAY-1", -2)]
    [InlineData("ninna 2h PAY-1", -1)]
    [InlineData("ivala 2h PAY-1", 0)]
    [InlineData("कल 2 घंटे PAY-1", -1)]
    [InlineData("నిన్న 2h PAY-1", -1)]
    public void Days_are_read(string text, int offset)
    {
        var p = One(text);
        Assert.Equal(Wed.AddDays(offset), p.Date);
        Assert.Equal(("PAY-1", 120), (p.Key, p.Minutes));
    }

    [Fact]
    public void A_date_without_a_year_is_the_most_recent_one_and_what_is_missing_is_said()
    {
        Assert.Equal(new DateOnly(2025, 12, 25), One("1h PAY-1 25 dec").Date);
        Assert.Equal(new DateOnly(2025, 12, 25), One("1h PAY-1 25/12").Date);
        Assert.Contains("How long", One("standup with the team").Problem);
        Assert.Equal(0, One("PAY-4 code review").Minutes);
        Assert.Contains("not happened", One("2h PAY-1 2026-10-30").Problem);
        Assert.Contains("24 hours", One("30 hours PAY-1").Problem);
        Assert.Empty(P("yesterday"));
        Assert.Empty(P("   "));
    }

    [Fact]
    public void Keys_and_notes_are_taken_apart()
    {
        var p = One("I spent 2 hours on pay-12 fixing the reminder template");
        Assert.Equal(("PAY-12", 120, "fixing the reminder template"), (p.Key, p.Minutes, p.Rest));
        Assert.Equal("WT-3", One("worked 3h on wt-3").Key);
        Assert.Null(One("2h follow-up calls").Key);
        Assert.Equal("follow-up calls", One("2h follow-up calls").Rest);
        Assert.Equal(["reminder", "template"], TimeWords.Words("the reminder template for the team"));
    }
}

/// <summary>Logging time in plain words through the API: entries to check, matched to work, then logged.</summary>
[Collection("api")]
public class TimesheetWordsTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static int I(JsonNode? n) => n!.GetValue<int>();
    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd");

    [Fact]
    public async Task Words_become_entries_to_check_and_then_time()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Developer");
        var project = await owner.CreateProjectAsync("Client Portal");
        var login = await owner.CreateTaskAsync(project, "Build the login page", new { title = "Build the login page", priority = "Medium", assigneeId = dev.UserId });
        var standup = await owner.CreateTaskAsync(project, "Daily stand-up", new { title = "Daily stand-up", priority = "Low", assigneeId = dev.UserId });
        var loginKey = S(login["key"]);
        var yesterday = AppDay.Today.AddDays(-1);

        var parsed = await dev.Post("/api/v1/time/words", new { text = $"2h on {loginKey.ToLowerInvariant()} yesterday, 30m standup, 45m on XYZ-999" });
        Assert.True(parsed.Ok, parsed.ToString());
        var entries = parsed.Data!["entries"]!.AsArray();
        Assert.Equal(3, entries.Count);
        Assert.False(parsed.Data!["usedAi"]!.GetValue<bool>());
        Assert.Equal(480, I(parsed.Data!["dayMinutes"]));

        // By its key, with the day it says.
        Assert.Equal((120, Iso(yesterday), "key", S(login["id"])), (I(entries[0]!["minutes"]), S(entries[0]!["date"]), S(entries[0]!["match"]), S(entries[0]!["target"]!["targetId"])));
        Assert.Equal("task", S(entries[0]!["target"]!["kind"]));
        Assert.Equal("Client Portal", S(entries[0]!["target"]!["projectName"]));
        // By the words of its title ("standup" finds "Daily stand-up"), on the day carried over.
        Assert.Equal((30, Iso(yesterday), "title", S(standup["id"])), (I(entries[1]!["minutes"]), S(entries[1]!["date"]), S(entries[1]!["match"]), S(entries[1]!["target"]!["targetId"])));
        Assert.Equal("standup", S(entries[1]!["note"]));
        // A key nobody can see is said, with choices to pick from.
        Assert.Equal("none", S(entries[2]!["match"]));
        Assert.Contains("XYZ-999", S(entries[2]!["problem"]));
        Assert.Contains(entries[2]!["options"]!.AsArray(), o => S(o!["targetId"]) == S(login["id"]));

        // Nothing is logged until it is confirmed.
        Assert.Equal(0, I((await dev.Get($"/api/v1/tasks/{S(login["id"])}/time")).Data!["totalMinutes"]));

        var logged = await dev.Post("/api/v1/time/words/log", new
        {
            entries = new object[]
            {
                new { kind = "task", targetId = S(login["id"]), date = Iso(yesterday), minutes = 120, note = (string?)null },
                new { kind = "task", targetId = S(standup["id"]), date = Iso(yesterday), minutes = 30, note = "standup" },
                new { kind = "task", targetId = S(login["id"]), date = Iso(AppDay.Today.AddDays(3)), minutes = 30, note = (string?)null },
                new { kind = "task", targetId = S(login["id"]), date = Iso(yesterday), minutes = 0, note = (string?)null },
            },
        });
        Assert.True(logged.Ok, logged.ToString());
        Assert.Equal(2, I(logged.Data!["saved"]));
        Assert.Equal(150, I(logged.Data!["minutes"]));
        Assert.Equal(2, logged.Data!["errors"]!.AsArray().Count);
        Assert.Equal(120, I((await dev.Get($"/api/v1/tasks/{S(login["id"])}/time")).Data!["totalMinutes"]));
        var standupTime = (await dev.Get($"/api/v1/tasks/{S(standup["id"])}/time")).Data!["entries"]!.AsArray();
        Assert.Equal("standup", S(Assert.Single(standupTime)!["note"]));

        // Logged time now ranks first for words that match it.
        var again = (await dev.Post("/api/v1/time/words", new { text = "1h login page" })).Data!["entries"]![0]!;
        Assert.Equal(S(login["id"]), S(again["target"]!["targetId"]));
        Assert.Equal(Iso(AppDay.Today), S(again["date"]));

        // Empty words, nothing to log and a voice note on a server without speech to text are refused plainly.
        Assert.Equal(422, (int)(await dev.Post("/api/v1/time/words", new { text = " " })).Status);
        Assert.Equal(422, (int)(await dev.Post("/api/v1/time/words/log", new { entries = Array.Empty<object>() })).Status);
        var voice = await dev.Upload("/api/v1/time/words/voice", "words.wav", Encoding.ASCII.GetBytes("RIFF....WAVEfmt "));
        Assert.Equal(HttpStatusCode.Conflict, voice.Status);
    }
}
