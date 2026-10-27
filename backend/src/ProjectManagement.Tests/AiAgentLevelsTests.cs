using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Every agent obeys its level in Settings › AI: Off does nothing, Suggest only suggests, Ask first puts the work in the Home inbox (approving
/// applies it), Auto applies it - and every change lands in the AI action log, shown in the item's Activity and the project's activity.
/// </summary>
[Collection("api")]
public class AiAgentLevelsTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static string? PersonId(string prompt, string name) => Regex.Match(prompt, $@"(?m)^([0-9a-f-]{{36}}) \| {Regex.Escape(name)} \|") is { Success: true } m ? m.Groups[1].Value : null;
    private static DateOnly LastMonday => AppDay.Today.AddDays(-(((int)AppDay.Today.DayOfWeek + 6) % 7) - 7);

    private static async Task Level(TestClient owner, string agent, string level)
    {
        var r = await owner.Put($"/api/v1/ai/control/agents/{agent}", new { level });
        Assert.True(r.Ok, r.ToString());
    }

    private static async Task<JsonArray> Inbox(TestClient c) => (await c.Get("/api/v1/inbox?filter=decisions")).Data!["rows"]!.AsArray();

    private static async Task<JsonArray> Activity(TestClient c, Guid id)
    {
        var r = await c.Get($"/api/v1/work-items/{id}");
        Assert.True(r.Ok, r.ToString());
        return r.Data!["activity"]!.AsArray();
    }

    private List<AiAgentAction> Log(Guid tenant) => factory.WithDb(db => db.AiAgentActions.IgnoreQueryFilters().Where(a => a.TenantId == tenant).OrderBy(a => a.CreatedAt).ToList());

    private async Task<TestClient> OrgAsync(string name)
    {
        var owner = await TestClient.RegisterAsync(factory, $"{name} Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        return owner;
    }

    // ------------------------------------------------------------------ the project agent

    private async Task<(TestClient Owner, Guid Project)> ProjectAgentAsync(string name, string? level)
    {
        var owner = await OrgAsync(name);
        if (level is not null) await Level(owner, "project", level);
        var project = await owner.CreateProjectAsync(name);
        var ravi = await owner.AddMemberAsync(factory, TenantRole.Member, "Ravi");
        await owner.CreateTaskAsync(project, "Payment gateway integration", new { title = "Payment gateway integration", assigneeId = ravi.UserId });
        factory.Ai.Reset(); factory.Ai.Configured = true;   // the agent can be switched on only where AI is available
        // The lead allows the agent to carry out safe items alone (autonomy 4): the workspace's level still decides.
        var on = await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true, autonomyLevel = 4, autoApplyConfidence = 90, autoApplyKinds = new[] { "CreateTask", "Decision" } });
        Assert.True(on.Ok, on.ToString());
        factory.Ai.Answer = (system, prompt) => JsonSerializer.Serialize(new
        {
            summary = "A checklist is needed.",
            findings = new object?[]
            {
                new { kind = "create_task", title = "Prepare the go-live checklist", evidence = "can you send the go-live checklist", source = "S1", assigneeId = PersonId(prompt, "Ravi"),
                    dueDate = AppDay.Today.AddDays(3).ToString("yyyy-MM-dd"), confidence = 95 },
            },
        });
        var read = await owner.Post($"/api/v1/projects/{project}/agent/transcript", new { title = "Stand-up", text = "Client: can you send the go-live checklist by Thursday?\nRavi: yes." });
        Assert.Equal(HttpStatusCode.Created, read.Status);
        return (owner, project);
    }

    private static async Task<JsonArray> Findings(TestClient owner, Guid project) => (await owner.Get($"/api/v1/projects/{project}/agent/findings?status=all")).Data!["items"]!.AsArray();

    [Fact]
    public async Task Project_agent_off_reads_nothing_and_proposes_nothing()
    {
        try
        {
            var (owner, project) = await ProjectAgentAsync("Agent Off", "off");
            using (var scope = factory.Services.CreateScope()) await scope.ServiceProvider.GetRequiredService<AgentEngine>().TickAsync();
            Assert.Empty(await Findings(owner, project));
            Assert.Equal(0, factory.WithDb(db => db.AgentRuns.IgnoreQueryFilters().Count(r => r.ProjectId == project)));
            Assert.Equal(HttpStatusCode.Conflict, (await owner.Post($"/api/v1/projects/{project}/agent/run")).Status);
            Assert.DoesNotContain(await Inbox(owner), r => S(r!["kind"]) == "decision");
            Assert.Empty(Log(owner.WorkspaceId));
        }
        finally { factory.Ai.Reset(); }
    }

    [Fact]
    public async Task Project_agent_suggest_shows_proposals_on_the_project_only()
    {
        try
        {
            var (owner, project) = await ProjectAgentAsync("Agent Suggest", "suggest");
            var f = Assert.Single(await Findings(owner, project));
            Assert.Equal("Proposed", S(f!["status"]));          // never applied by the agent, even at autonomy 4
            Assert.Empty(await Inbox(owner));                     // no inbox interrupt
            Assert.Empty(Log(owner.WorkspaceId));
        }
        finally { factory.Ai.Reset(); }
    }

    [Fact]
    public async Task Project_agent_ask_first_waits_in_the_inbox_and_approving_applies_and_logs_it()
    {
        try
        {
            var (owner, project) = await ProjectAgentAsync("Agent Ask", null);   // the default
            Assert.Contains((await owner.Get("/api/v1/ai/control")).Data!["agents"]!.AsArray(), a => S(a!["id"]) == "project" && S(a["level"]) == "askFirst");
            var f = Assert.Single(await Findings(owner, project));
            Assert.Equal("Proposed", S(f!["status"]));          // autonomy 4 is capped by the workspace's Ask first
            var row = Assert.Single(await Inbox(owner), r => S(r!["kind"]) == "decision");
            Assert.Equal($"/api/v1/agent/findings/{S(f["id"])}/approve", S(row!["action"]!["endpoint"]));

            var approved = await owner.Post(S(row["action"]!["endpoint"]), new { });
            Assert.True(approved.Ok, approved.ToString());
            var log = Assert.Single(Log(owner.WorkspaceId));
            Assert.Equal(("project", "create_task", "applied", owner.UserId), (log.Agent, log.Action, log.Status, log.ApprovedBy!.Value));
            var taskId = log.TargetId!.Value;
            var ai = Assert.Single(await Activity(owner, taskId), a => S(a!["type"]) == "ai");
            Assert.Equal(owner.UserId.ToString(), S(ai!["actor"]!["id"]));
            Assert.False(ai["auto"]!.GetValue<bool>());
            // ... and in the project's activity.
            var activity = (await owner.Get($"/api/v1/projects/{project}/activity")).Data!["items"]!.AsArray();
            Assert.Contains(activity, a => S(a!["action"]) == "ai.project.create_task" && S(a["summary"]).Contains("approved"));
        }
        finally { factory.Ai.Reset(); }
    }

    [Fact]
    public async Task Project_agent_auto_applies_by_itself_and_logs_it()
    {
        try
        {
            var (owner, project) = await ProjectAgentAsync("Agent Auto", "auto");
            var f = Assert.Single(await Findings(owner, project));
            Assert.Equal("Applied", S(f!["status"]));
            Assert.True(f["autoApplied"]!.GetValue<bool>());
            var log = Assert.Single(Log(owner.WorkspaceId));
            Assert.Null(log.ApprovedBy);
            var ai = Assert.Single(await Activity(owner, log.TargetId!.Value), a => S(a!["type"]) == "ai");
            Assert.True(ai!["auto"]!.GetValue<bool>());
            Assert.Null(ai["actor"]);
            Assert.Contains((await owner.Get($"/api/v1/projects/{project}/activity")).Data!["items"]!.AsArray(),
                a => S(a!["action"]) == "ai.project.create_task" && S(a["summary"]).Contains("on its own"));
        }
        finally { factory.Ai.Reset(); }
    }

    // ------------------------------------------------------------------ ticket triage

    private static async Task<JsonNode> Ticket(TestClient owner, string title)
    {
        var types = (await owner.Get("/api/v1/work-types?includeInactive=true")).Data!.AsArray();
        var r = await owner.Post("/api/v1/work-tasks", new { title, workTypeId = S(types.First(t => S(t!["name"]) == "Bug Fix")!["id"]) });
        Assert.True(r.Ok, r.ToString());
        return r.Data!;
    }

    private const string Urgent = "Checkout failing for customers";

    [Fact]
    public async Task Triage_off_suggests_nothing_and_suggest_only_fills_the_form()
    {
        var off = await OrgAsync("Triage Off");
        await Level(off, "triage", "off");
        var none = await off.Post("/api/v1/operations/triage", new { title = Urgent });
        Assert.True(none.Ok, none.ToString());
        Assert.Null(none.Data!["priority"]);
        Assert.Equal("Medium", S((await Ticket(off, Urgent))["priority"]));
        Assert.Empty(Log(off.WorkspaceId));

        var suggest = await OrgAsync("Triage Suggest");   // the default
        Assert.Equal("High", S((await suggest.Post("/api/v1/operations/triage", new { title = Urgent })).Data!["priority"]));
        Assert.Equal("Medium", S((await Ticket(suggest, Urgent))["priority"]));
        Assert.Empty(await Inbox(suggest));
        Assert.Empty(Log(suggest.WorkspaceId));
    }

    [Fact]
    public async Task Triage_ask_first_puts_the_change_in_the_inbox_and_approving_applies_it()
    {
        var owner = await OrgAsync("Triage Ask");
        await Level(owner, "triage", "askFirst");
        var ticket = await Ticket(owner, Urgent);
        Assert.Equal("Medium", S(ticket["priority"]));
        var row = Assert.Single(await Inbox(owner), r => S(r!["id"]).StartsWith("ai:"));
        Assert.Equal("decision", S(row!["kind"]));
        Assert.Contains("priority High", S(row["title"]));
        Assert.Equal("Accept", S(row["action"]!["label"]));

        var approved = await owner.Post(S(row["action"]!["endpoint"]), new { });
        Assert.True(approved.Ok, approved.ToString());
        Assert.Equal("applied", S(approved.Data!["status"]));
        var id = Guid.Parse(S(ticket["id"]));
        Assert.Equal("High", S((await owner.Get($"/api/v1/work-tasks/{id}")).Data!["priority"]));
        Assert.DoesNotContain(await Inbox(owner), r => S(r!["id"]).StartsWith("ai:"));
        var ai = Assert.Single(await Activity(owner, id), a => S(a!["type"]) == "ai");
        Assert.Equal(owner.UserId.ToString(), S(ai!["actor"]!["id"]));
        Assert.Equal(HttpStatusCode.Conflict, (await owner.Post(S(row["action"]!["endpoint"]), new { })).Status);   // decided once
    }

    [Fact]
    public async Task Triage_auto_sets_the_priority_when_the_ticket_is_raised_and_logs_it()
    {
        var owner = await OrgAsync("Triage Auto");
        await Level(owner, "triage", "auto");
        var ticket = await Ticket(owner, Urgent);
        Assert.Equal("High", S(ticket["priority"]));
        var log = Assert.Single(Log(owner.WorkspaceId));
        Assert.Equal(("triage", (Guid?)null), (log.Agent, log.ApprovedBy));
        var ai = Assert.Single(await Activity(owner, Guid.Parse(S(ticket["id"]))), a => S(a!["type"]) == "ai");
        Assert.True(ai!["auto"]!.GetValue<bool>());
        Assert.Empty(await Inbox(owner));
    }

    // ------------------------------------------------------------------ the timesheet helper

    private async Task<(TestClient Owner, TestClient Dev)> TimesheetAsync(string name, string level)
    {
        var owner = await OrgAsync(name);
        await Level(owner, "timesheet", level);
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Developer");
        var project = await owner.CreateProjectAsync(name);
        var task = await owner.CreateTaskAsync(project, "Build the login page", new { title = "Build the login page", assigneeId = dev.UserId });
        var at = DateTime.SpecifyKind(LastMonday.ToDateTime(new TimeOnly(11, 0)).AddMinutes(-AppDay.OffsetMinutes), DateTimeKind.Utc);
        factory.WithDb(db =>
        {
            db.Activities.Add(new Activity { Id = Guid.NewGuid(), TenantId = owner.WorkspaceId, ActorId = dev.UserId, ProjectId = project, Action = "task.updated", EntityType = "Task",
                EntityId = Guid.Parse(S(task["id"])), Summary = "changed", CreatedAt = at });
            return db.SaveChanges();
        });
        return (owner, dev);
    }

    private async Task<string?> DraftAs(TestClient person, DateOnly day)
    {
        using var scope = factory.Services.CreateScope();
        var sp = scope.ServiceProvider;
        await WorkspaceExecutionPrincipal.ConfigureAsync(sp, person.UserId, person.WorkspaceId, null, default);
        return await sp.GetRequiredService<TimesheetHelper>().DraftDayAsync(day);
    }

    private static async Task<int> Logged(TestClient c) =>
        (await c.Get($"/api/v1/time/grid?weekStart={LastMonday:yyyy-MM-dd}")).Data!["totalMinutes"]!.GetValue<int>();

    [Fact]
    public async Task Timesheet_helper_off_does_not_draft_and_suggest_does_not_go_further()
    {
        var (owner, dev) = await TimesheetAsync("Time Off", "off");
        Assert.Equal(HttpStatusCode.Conflict, (await dev.Get($"/api/v1/time/grid/draft?weekStart={LastMonday:yyyy-MM-dd}")).Status);
        Assert.Null(await DraftAs(dev, LastMonday));
        Assert.Empty(Log(owner.WorkspaceId));

        var (owner2, dev2) = await TimesheetAsync("Time Suggest", "suggest");
        Assert.True((await dev2.Get($"/api/v1/time/grid/draft?weekStart={LastMonday:yyyy-MM-dd}")).Ok);
        Assert.Null(await DraftAs(dev2, LastMonday));
        Assert.Equal(0, await Logged(dev2));
        Assert.Empty(Log(owner2.WorkspaceId));
    }

    [Fact]
    public async Task Timesheet_helper_ask_first_drafts_into_the_inbox_and_approving_logs_the_day()
    {
        var (owner, dev) = await TimesheetAsync("Time Ask", "askFirst");
        Assert.Equal("inbox", await DraftAs(dev, LastMonday));
        Assert.Null(await DraftAs(dev, LastMonday));                         // once per day
        Assert.Equal(0, await Logged(dev));
        var row = Assert.Single(await Inbox(dev), r => S(r!["id"]).StartsWith("ai:"));
        Assert.Equal("approval", S(row!["kind"]));
        Assert.Equal("Approve", S(row["action"]!["label"]));
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.Post(S(row["action"]!["endpoint"]), new { })).Status);   // only the person it is for
        var approved = await dev.Post(S(row["action"]!["endpoint"]), new { });
        Assert.True(approved.Ok, approved.ToString());
        Assert.True(await Logged(dev) > 0);
        var log = Assert.Single(Log(owner.WorkspaceId));
        Assert.Equal(("timesheet", "applied", dev.UserId), (log.Agent, log.Status, log.ApprovedBy!.Value));
    }

    [Fact]
    public async Task Timesheet_helper_auto_logs_the_day_and_records_it()
    {
        var (owner, dev) = await TimesheetAsync("Time Auto", "auto");
        Assert.Equal("logged", await DraftAs(dev, LastMonday));
        Assert.True(await Logged(dev) > 0);
        var log = Assert.Single(Log(owner.WorkspaceId));
        Assert.Equal(("timesheet", "applied", (Guid?)null), (log.Agent, log.Status, log.ApprovedBy));
        Assert.Empty(await Inbox(dev));
    }

    // ------------------------------------------------------------------ the meeting notetaker

    private async Task<(TestClient Owner, Guid Project)> NotetakerAsync(string name, string? level)
    {
        var owner = await OrgAsync(name);
        if (level is not null) await Level(owner, "notetaker", level);
        var project = await owner.CreateProjectAsync(name);
        factory.Ai.Reset(); factory.Ai.Configured = true;
        var on = await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true });
        Assert.True(on.Ok, on.ToString());
        factory.Ai.Answer = (_, _) => JsonSerializer.Serialize(new
        {
            summary = "The release was discussed.", attendees = new[] { "Owner" }, discussion = new[] { "Release" }, decisions = Array.Empty<string>(),
            actionItems = new[] { new { task = "Send the release deck", owner = (string?)null, due = (string?)null } }, risks = Array.Empty<string>(), nextMeeting = (string?)null,
        });
        var protector = factory.Services.GetRequiredService<ISecretProtector>();
        var now = DateTime.UtcNow;
        factory.WithDb(db =>
        {
            db.NotetakerSettings.Add(new NotetakerSettings { TenantId = owner.WorkspaceId, UserId = owner.UserId, ProjectId = project, AutoMinutes = true, AutoTasks = true, AutoEmail = false,
                DeleteTranscript = false, CreatedAt = now });
            var bot = new AgentMeetingBot { TenantId = owner.WorkspaceId, ProjectId = project, MeetingId = Guid.NewGuid(), SessionStartUtc = now.AddHours(-1), SessionEndUtc = now.AddMinutes(-10),
                Kind = "bot", Status = "done", BotId = "b1", WebhookToken = Guid.NewGuid().ToString("N"), EndedAt = now.AddMinutes(-5), Title = "Release sync",
                TranscriptProtected = protector.Protect(string.Concat(Enumerable.Repeat("Owner: we need to send the release deck to the client this week.\n", 6))), CreatedAt = now };
            bot.TranscriptLength = 400;
            db.AgentMeetingBots.Add(bot);
            db.AgentDelegations.Add(new AgentDelegation { TenantId = owner.WorkspaceId, ProjectId = project, MeetingId = bot.MeetingId, SessionStartUtc = bot.SessionStartUtc,
                SessionEndUtc = bot.SessionEndUtc, UserId = owner.UserId, Status = "attending", BotRowId = bot.Id, CreatedAt = now });
            return db.SaveChanges();
        });
        using var scope = factory.Services.CreateScope();
        var sp = scope.ServiceProvider;
        await WorkspaceExecutionPrincipal.ConfigureAsync(sp, owner.UserId, owner.WorkspaceId, null, default);
        var s = await sp.GetRequiredService<IAppDbContext>().ProjectAgentSettings.FirstAsync(x => x.ProjectId == project);
        await sp.GetRequiredService<NotetakerService>().TickAsync(s, default);
        return (owner, project);
    }

    private int Tasks(Guid project, string title) => factory.WithDb(db => db.Tasks.IgnoreQueryFilters().Count(t => t.ProjectId == project && t.Title == title));

    [Fact]
    public async Task Notetaker_off_neither_joins_nor_writes()
    {
        try
        {
            var owner = await OrgAsync("Notes Off");
            await Level(owner, "notetaker", "off");
            var project = await owner.CreateProjectAsync("Notes Off");
            var join = await owner.Post("/api/v1/me/notetaker/join", new { url = "https://meet.google.com/abc-defg-hij", minutes = 60, projectId = project });
            Assert.Equal(HttpStatusCode.Conflict, join.Status);
            Assert.Equal("NOTETAKER_OFF", join.ErrorCode);
            var (o2, p2) = await NotetakerAsync("Notes Off Tick", "off");
            Assert.Equal(0, factory.WithDb(db => db.MeetingMinutes.IgnoreQueryFilters().Count(m => m.ProjectId == p2)));
            Assert.Equal(0, Tasks(p2, "Send the release deck"));
            Assert.Empty(Log(o2.WorkspaceId));
        }
        finally { factory.Ai.Reset(); }
    }

    [Fact]
    public async Task Notetaker_ask_first_asks_before_making_tasks_from_the_minutes()
    {
        try
        {
            var (owner, project) = await NotetakerAsync("Notes Ask", null);   // the default
            Assert.Equal(1, factory.WithDb(db => db.MeetingMinutes.IgnoreQueryFilters().Count(m => m.ProjectId == project)));
            Assert.Equal(0, Tasks(project, "Send the release deck"));
            var row = Assert.Single(await Inbox(owner), r => S(r!["id"]).StartsWith("ai:"));
            Assert.Contains("Create 1 task", S(row!["title"]));
            Assert.True((await owner.Post(S(row["action"]!["endpoint"]), new { })).Ok);
            Assert.Equal(1, Tasks(project, "Send the release deck"));
            var made = Log(owner.WorkspaceId).Single(a => a.Action == "create_task");
            Assert.Equal(("notetaker", owner.UserId), (made.Agent, made.ApprovedBy!.Value));
            Assert.Single(await Activity(owner, made.TargetId!.Value), a => S(a!["type"]) == "ai");
        }
        finally { factory.Ai.Reset(); }
    }

    [Fact]
    public async Task Notetaker_auto_makes_the_tasks_and_logs_them()
    {
        try
        {
            var (owner, project) = await NotetakerAsync("Notes Auto", "auto");
            Assert.Equal(1, Tasks(project, "Send the release deck"));
            var made = Assert.Single(Log(owner.WorkspaceId));
            Assert.Equal(("notetaker", "create_task", (Guid?)null), (made.Agent, made.Action, made.ApprovedBy));
            Assert.Empty(await Inbox(owner));
        }
        finally { factory.Ai.Reset(); }
    }

    // ------------------------------------------------------------------ the mail agent

    private GoogleCalendarOptions Google => factory.Services.GetRequiredService<IOptions<GoogleCalendarOptions>>().Value;

    private async Task ConnectGoogleAsync(TestClient owner, string email)
    {
        var start = await owner.Get("/api/v1/integrations/google/connect?inbox=true");
        Assert.True(start.Ok, start.ToString());
        using var browser = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        browser.DefaultRequestHeaders.Add("Cookie", start.Headers!["Set-Cookie"].Split(';')[0]);
        var state = new Uri(S(start.Data!["url"])).Query.TrimStart('?').Split('&').Select(p => p.Split('=', 2)).Where(p => p[0] == "state").Select(p => Uri.UnescapeDataString(p[1])).Single();
        var code = factory.GoogleCalendar.IssueCode(email, GoogleCalendarAuthService.InboxScope);
        using var response = await browser.GetAsync($"/api/v1/integrations/google/callback?state={state}&code={code}");
        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
    }

    private async Task<(TestClient Owner, JsonNode Assist)> MailAsync(string name, string level)
    {
        var owner = await OrgAsync(name);
        await Level(owner, "mail", level);
        Assert.True((await owner.Get("/api/v1/work-types")).Ok);   // the workspace's work types exist
        await ConnectGoogleAsync(owner, $"{level.ToLowerInvariant()}-mail-agent@example.test");
        factory.Ai.Answer = (_, _) => JsonSerializer.Serialize(new
        {
            summary = "The client asks for the revised quote.", intent = "action_required", urgency = "high", keyFacts = Array.Empty<string>(), actionItems = new[] { "Send the quote" },
            replies = Array.Empty<object>(),
            tasks = new[] { new { kind = "create", title = "Send the revised quote", detail = "The client wants it by Friday", priority = "High", reason = "asks for the revised quote", due = (string?)null } },
        });
        var assist = await owner.Post("/api/v1/me/mailbox/agent/assist", new { account = "google", messageId = "1001" });
        Assert.True(assist.Ok, assist.ToString());
        return (owner, assist.Data!);
    }

    private int Quotes(Guid tenant) => factory.WithDb(db => db.WorkTasks.IgnoreQueryFilters().Count(w => w.TenantId == tenant && w.Title == "Send the revised quote"));

    [Fact]
    public async Task Mail_agent_off_is_unavailable()
    {
        var owner = await OrgAsync("Mail Off");
        await Level(owner, "mail", "off");
        var options = await owner.Get("/api/v1/me/mailbox/agent/options");
        Assert.True(options.Ok, options.ToString());
        Assert.False(options.Data!["available"]!.GetValue<bool>());
        Assert.Equal("off", S(options.Data["level"]));
        var assist = await owner.Post("/api/v1/me/mailbox/agent/assist", new { account = "google", messageId = "1001" });
        Assert.Equal(HttpStatusCode.Forbidden, assist.Status);
        Assert.Equal("AI_AGENT_OFF", assist.ErrorCode);
    }

    [Fact]
    public async Task Mail_agent_ask_first_and_auto()
    {
        Google.InboxEnabled = true;
        factory.Ai.Reset(); factory.Ai.Configured = true;
        try
        {
            // Ask first: the suggestion waits in the inbox; approving creates the ticket (assigned to the person) and logs it.
            var (asker, asked) = await MailAsync("Mail Ask", "askFirst");
            Assert.Equal("inbox", S(asked["tasks"]![0]!["state"]));
            Assert.Equal(0, Quotes(asker.WorkspaceId));
            var row = Assert.Single(await Inbox(asker), r => S(r!["id"]).StartsWith("ai:"));
            Assert.True((await asker.Post(S(row!["action"]!["endpoint"]), new { })).Ok);
            Assert.Equal(1, Quotes(asker.WorkspaceId));
            var made = Log(asker.WorkspaceId).Single(a => a.Status == "applied" && a.TargetType == "ticket" && a.Action == "create_task" && a.TargetKey != null);
            Assert.Equal(asker.UserId, made.ApprovedBy);

            // Auto: created straight away.
            var (auto, done) = await MailAsync("Mail Auto", "auto");
            Assert.Equal("applied", S(done["tasks"]![0]!["state"]));
            Assert.Equal(1, Quotes(auto.WorkspaceId));
            var log = Assert.Single(Log(auto.WorkspaceId));
            Assert.Null(log.ApprovedBy);
            Assert.Empty(await Inbox(auto));
        }
        finally { factory.Ai.Reset(); Google.InboxEnabled = false; factory.GoogleCalendar.Inbox.Reset(); }
    }

    // ------------------------------------------------------------------ mentions and figures

    [Fact]
    public async Task Mentions_in_issue_and_action_item_comments_notify_like_task_comments()
    {
        var owner = await OrgAsync("Mentions");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Developer");
        var other = await owner.AddMemberAsync(factory, TenantRole.Member, "Olly Other");
        var project = await owner.CreateProjectAsync("Mentions");
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = dev.UserId })).Ok);
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = other.UserId })).Ok);
        var issue = await owner.Post("/api/v1/work-items", new { kind = "issue", projectId = project, title = "Refund total is off", assigneeId = other.UserId });
        var action = await owner.Post("/api/v1/work-items", new { kind = "action", projectId = project, title = "Get the bank's sign-off", assigneeId = other.UserId });
        Assert.Equal(HttpStatusCode.Created, issue.Status);
        Assert.Equal(HttpStatusCode.Created, action.Status);
        foreach (var item in new[] { issue, action })
        {
            var c = await owner.Post($"/api/v1/work-items/{S(item.Data!["id"])}/comments", new { body = "@Dev can you check this?", mentionUserIds = new[] { dev.UserId } });
            Assert.True(c.Ok, c.ToString());
        }
        var notes = factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.TenantId == owner.WorkspaceId).ToList());
        Assert.Equal(2, notes.Count(n => n.UserId == dev.UserId && n.Type == NotificationType.Mention && n.Title.StartsWith("You were mentioned on")));
        Assert.Contains(notes, n => n.UserId == dev.UserId && n.Type == NotificationType.Mention && n.Title.Contains("-I"));
        Assert.Contains(notes, n => n.UserId == dev.UserId && n.Type == NotificationType.Mention && n.Title.Contains("AI-"));
        Assert.Equal(2, notes.Count(n => n.UserId == other.UserId && n.Type == NotificationType.Comment));   // the assignee hears of the comment
        Assert.DoesNotContain(notes, n => n.UserId == owner.UserId && n.Type is NotificationType.Mention or NotificationType.Comment);
        // ... and the mention shows in the person's inbox.
        Assert.Equal(2, (await dev.Get("/api/v1/inbox?filter=mentions")).Data!["rows"]!.AsArray().Count);
    }

    [Fact]
    public async Task The_control_centre_serves_answer_success_and_credits()
    {
        var owner = await OrgAsync("Figures");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member);
        factory.WithDb(db =>
        {
            var conversation = new AiConversation { TenantId = owner.WorkspaceId, UserId = owner.UserId, Title = "Q", CreatedAt = DateTime.UtcNow };
            db.AiConversations.Add(conversation);
            for (var i = 0; i < 4; i++)
                db.AiMessages.Add(new AiMessage { TenantId = owner.WorkspaceId, UserId = owner.UserId, ConversationId = conversation.Id, Role = "assistant", Content = "a",
                    Status = i == 0 ? "failed" : "complete", Credits = 2, CreatedAt = DateTime.UtcNow });
            return db.SaveChanges();
        });
        var r = await member.Get("/api/v1/ai/control");   // anyone in the workspace may read them
        Assert.True(r.Ok, r.ToString());
        var f = r.Data!["figures"]!;
        Assert.Equal(4, f["answers"]!.GetValue<int>());
        Assert.Equal(1, f["failed"]!.GetValue<int>());
        Assert.Equal(75, f["successPercent"]!.GetValue<int>());
        Assert.True(f["creditsLimit"]!.GetValue<long>() is > 0 or -1);
        Assert.True(f["creditsUsed"]!.GetValue<long>() >= 0);
    }
}
