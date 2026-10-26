using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The assistant's Google Meet tools (spec section 21): list_project_meetings (read), propose_start_meeting and
/// propose_schedule_meeting (write - proposed, then only actually created once the person confirms, same as every other write tool).</summary>
[Collection("api")]
public class AiMeetingToolsTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<(TestClient Owner, Guid Project)> SetupAsync()
    {
        factory.Chat.Reset();
        factory.Chat.Configured = true;
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");   // AI_ACTIONS is on from Business up
        var project = await owner.CreateProjectAsync("Atlas");
        await ConnectGoogleAsync(owner);
        return (owner, project);
    }

    /// <summary>The same connect round trip ProjectMeetingTests drives in full, through the fake Google provider.</summary>
    private async Task ConnectGoogleAsync(TestClient c)
    {
        var start = await c.Get("/api/v1/integrations/google/connect");
        Assert.True(start.Ok, start.ToString());
        var authorize = new Uri(start.Data!["url"]!.GetValue<string>());
        var state = authorize.Query.TrimStart('?').Split('&').Select(p => p.Split('=', 2)).First(kv => kv[0] == "state")[1];
        var code = factory.GoogleCalendar.IssueCode(c.Email);
        using var noRedirect = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        noRedirect.DefaultRequestHeaders.Add("Cookie",start.Headers["Set-Cookie"].Split((char)59)[0]);
        using var cb = await noRedirect.GetAsync($"/api/v1/integrations/google/callback?code={code}&state={state}");
        Assert.Equal(HttpStatusCode.Redirect, cb.StatusCode);
    }

    private sealed record Stream(List<(string Name, JsonNode Data)> Events)
    {
        public JsonNode Last(string name) => Events.Last(e => e.Name == name).Data;
        public JsonNode Done => Last("done")["message"]!;
    }

    private static async Task<Stream> Ask(TestClient c, string text)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/ai/ask") { Content = JsonContent.Create(new { text, timeZone = "UTC" }) };
        req.Headers.Add("X-Token-Delivery", "body");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", c.Token);
        using var res = await c.Http.SendAsync(req);
        var body = await res.Content.ReadAsStringAsync();
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var events = body.Split("\n\n", StringSplitOptions.RemoveEmptyEntries).Select(block =>
        {
            var lines = block.Split('\n');
            return (lines[0]["event: ".Length..], JsonNode.Parse(lines[1]["data: ".Length..])!);
        }).ToList();
        return new Stream(events);
    }

    [Fact]
    public async Task Scheduling_a_meeting_through_the_assistant_waits_for_confirmation_then_creates_the_real_meeting()
    {
        var (owner, project) = await SetupAsync();
        var at = DateTime.UtcNow.AddDays(2).ToString("yyyy-MM-dd'T'HH:mm");
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool("propose_schedule_meeting", new { project = "Atlas", title = "Sprint planning", at, duration_minutes = 45 }));
        factory.Chat.Script.Enqueue(_ => FakeAiChat.Say("I have prepared that for you to confirm."));

        var res = await Ask(owner, "Schedule a meeting with the project team for sprint planning");
        var card = res.Last("action")["action"]!;
        Assert.Equal("proposed", S(card["status"]));
        Assert.Empty(factory.WithDb(db => db.ProjectMeetings.IgnoreQueryFilters().Where(m => m.ProjectId == project).ToList()));

        var confirm = await owner.Post($"/api/v1/ai/messages/{S(res.Done["id"])}/actions/{S(card["id"])}/confirm");
        Assert.True(confirm.Ok, confirm.ToString());
        Assert.Equal("done", S(confirm.Data!["status"]));
        var created = Assert.Single(factory.WithDb(db => db.ProjectMeetings.IgnoreQueryFilters().Where(m => m.ProjectId == project).ToList()));
        Assert.Equal("Sprint planning", created.Title);
        Assert.StartsWith("https://meet.google.com/", created.GoogleMeetUri);

        // Confirming twice must not create a second meeting.
        var again = await owner.Post($"/api/v1/ai/messages/{S(res.Done["id"])}/actions/{S(card["id"])}/confirm");
        Assert.Equal("AI_ACTION_HANDLED", again.ErrorCode);
        Assert.Single(factory.WithDb(db => db.ProjectMeetings.IgnoreQueryFilters().Where(m => m.ProjectId == project).ToList()));
    }

    [Fact]
    public async Task The_assistant_uses_the_time_zone_chosen_in_the_profile_not_the_browser_s()
    {
        // The person chose Asia/Kolkata in their profile; their browser happens to report UTC. "Tomorrow at 4 pm" is 16:00 in Kolkata: 10:30 UTC.
        var (owner, project) = await SetupAsync();
        factory.WithDb(db => { var u = db.Users.IgnoreQueryFilters().Single(x => x.Id == owner.UserId); u.TimeZone = "Asia/Kolkata"; db.SaveChanges(); return 0; });
        var tomorrow = DateOnly.FromDateTime(DateTime.UtcNow.AddMinutes(330)).AddDays(1);
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool("propose_schedule_meeting", new { project = "Atlas", title = "Release review", at = $"{tomorrow:yyyy-MM-dd}T16:00", duration_minutes = 30 }));
        factory.Chat.Script.Enqueue(_ => FakeAiChat.Say("Ready for you to confirm."));
        var res = await Ask(owner, "Schedule a release review tomorrow at 4pm");

        // The model was told the person's own zone and local time.
        Assert.Contains("(Asia/Kolkata)", factory.Chat.Requests.First().Context);
        var card = res.Last("action")["action"]!;
        Assert.Contains("(Asia/Kolkata)", S(card["summary"]));
        Assert.True((await owner.Post($"/api/v1/ai/messages/{S(res.Done["id"])}/actions/{S(card["id"])}/confirm")).Ok);
        var created = Assert.Single(factory.WithDb(db => db.ProjectMeetings.IgnoreQueryFilters().Where(m => m.ProjectId == project).ToList()));
        Assert.Equal(tomorrow.ToDateTime(new TimeOnly(10, 30)), created.StartTimeUtc);
    }

    [Fact]
    public async Task Listing_meetings_reads_them_without_any_confirmation_needed()
    {
        var (owner, project) = await SetupAsync();
        var created = await owner.Post($"/api/v1/projects/{project}/meetings/start", new { title = "Daily standup" });
        Assert.True(created.Ok, created.ToString());

        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool("list_project_meetings", new { project = "Atlas" }));
        factory.Chat.Script.Enqueue(_ => FakeAiChat.Say("Atlas has one meeting: Daily standup."));
        var res = await Ask(owner, "What meetings are scheduled for Atlas?");
        var text = string.Concat(res.Events.Where(e => e.Name == "text").Select(e => S(e.Data["delta"])));
        Assert.Contains("Daily standup", text);
    }

    [Fact]
    public async Task Agent_repeating_scrum_keeps_the_series_in_one_explicit_confirmation()
    {
        var (owner, project) = await SetupAsync();
        var at = DateTime.UtcNow.AddDays(2).ToString("yyyy-MM-dd'T'HH:mm");
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool("propose_schedule_meeting", new { project="Atlas",title="Scrum",at,duration_minutes=15,repeat_frequency="Daily",occurrences=10 }));
        factory.Chat.Script.Enqueue(_ => FakeAiChat.Say("Review the series before invitations are sent."));
        var res = await Ask(owner,"Schedule ten daily scrum calls on Atlas");
        var card = res.Last("action")["action"]!;
        Assert.Equal("proposed",S(card["status"]));
        Assert.Contains("10 sessions",card.ToJsonString());
        Assert.Empty(factory.WithDb(db=>db.ProjectMeetings.IgnoreQueryFilters().Where(m=>m.ProjectId==project).ToList()));
        var confirm=await owner.Post($"/api/v1/ai/messages/{S(res.Done["id"])}/actions/{S(card["id"])}/confirm");
        Assert.True(confirm.Ok,confirm.ToString());
        Assert.Equal("RRULE:FREQ=DAILY;COUNT=10",Assert.Single(factory.WithDb(db=>db.ProjectMeetings.IgnoreQueryFilters().Where(m=>m.ProjectId==project).ToList())).RecurrenceRule);
    }
}
