using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The agent as a project delegate: how much it may do by itself, commitments and check-ins, what a date change would move, sending it to a
/// meeting in someone's place (it answers in the chat, passes messages on and reports back), the brief before a meeting, and the Command Center.
/// </summary>
[Collection("api")]
public class ProjectAgentDelegateTests(ApiFactory factory)
{
    private static string? PersonId(string prompt, string name) => Regex.Match(prompt, $@"(?m)^([0-9a-f-]{{36}}) \| {Regex.Escape(name)} \|") is { Success: true } m ? m.Groups[1].Value : null;
    private static string? TaskKey(string prompt, string title) => Regex.Match(prompt, $@"(?m)^([A-Z0-9]+-\d+) \| {Regex.Escape(title)}") is { Success: true } m ? m.Groups[1].Value : null;
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<(TestClient Owner, Guid Project, TestClient Ravi, string Key)> SetupAsync(string name)
    {
        var owner = await TestClient.RegisterAsync(factory, $"{name} Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var project = await owner.CreateProjectAsync(name);
        var ravi = await owner.AddMemberAsync(factory, TenantRole.Member, "Ravi");
        var task = await owner.CreateTaskAsync(project, "Payment gateway integration", new { title = "Payment gateway integration", assigneeId = ravi.UserId });
        return (owner, project, ravi, S(task["key"]));
    }

    private async Task TickAsync()
    {
        using var scope = factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<AgentEngine>().TickAsync();
    }

    private static string Day(int days) => DateTime.UtcNow.AddDays(days).ToString("yyyy-MM-dd");

    [Fact]
    public async Task At_level_four_the_agent_carries_out_safe_items_itself_and_changes_to_existing_work_still_wait_for_a_person()
    {
        factory.Ai.Reset(); factory.Ai.Configured = true;
        factory.Ai.Answer = (system, prompt) => JsonSerializer.Serialize(new
        {
            summary = "The checklist is agreed; the gateway work moves to next week.",
            findings = new object?[]
            {
                new { kind = "create_task", title = "Prepare the go-live checklist", evidence = "can you send the go-live checklist", source = "S1", assigneeId = PersonId(prompt, "Ravi"), dueDate = Day(3), confidence = 92 },
                new { kind = "update_task", title = "Gateway moves to next week", evidence = "the gateway will slip a week", source = "S1", taskKey = TaskKey(prompt, "Payment gateway integration"), dueDate = Day(7), confidence = 95 },
                new { kind = "suggestion", title = "Add a retry queue", evidence = "we should retry failed payments", source = "S1", confidence = 60 },
                new { kind = "decision", title = "Launch in two phases", evidence = "we launch in two phases", source = "S1", confidence = 94 },
            },
        });
        try
        {
            var (owner, project, ravi, key) = await SetupAsync("Autonomy Desk");
            // Level 4 needs the workspace to let the project agent act alone too (Settings › AI, Auto).
            Assert.True((await owner.Put("/api/v1/ai/control/agents/project", new { level = "auto" })).Ok);
            Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true, autoApplyKinds = new[] { "UpdateTask" } })).Status);
            Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true, autonomyLevel = 7 })).Status);
            var on = await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true, autonomyLevel = 4, autoApplyConfidence = 90, autoApplyKinds = new[] { "CreateTask", "Decision", "Suggestion" } });
            Assert.True(on.Ok, on.ToString());
            Assert.Equal(4, on.Data!["autonomyLevel"]!.GetValue<int>());
            Assert.Equal(3, on.Data["autoApplyKinds"]!.AsArray().Count);

            var text = "Asha: Morning.\nClient: can you send the go-live checklist by Thursday?\nRavi: the gateway will slip a week, the bank keys are late.\n" +
                "Ravi: we should retry failed payments.\nAsha: agreed, we launch in two phases.";
            var read = await owner.Post($"/api/v1/projects/{project}/agent/transcript", new { title = "Stand-up", text });
            Assert.Equal(HttpStatusCode.Created, read.Status);

            var items = (await owner.Get($"/api/v1/projects/{project}/agent/findings?status=all")).Data!["items"]!.AsArray();
            JsonNode Of(string kind) => items.First(i => S(i!["kind"]) == kind)!;
            // Safe, grounded and sure enough: done by the agent itself.
            Assert.Equal("Applied", S(Of("CreateTask")["status"]));
            Assert.True(Of("CreateTask")["autoApplied"]!.GetValue<bool>());
            Assert.Equal("Applied", S(Of("Decision")["status"]));
            // Below the confidence the lead chose, and a change to existing work: they wait.
            Assert.Equal("Proposed", S(Of("Suggestion")["status"]));
            Assert.Equal("Proposed", S(Of("UpdateTask")["status"]));
            Assert.True(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Any(n => n.UserId == owner.UserId && n.Title.Contains("carried out 2 safe items"))));
            // Ravi was given the new task: he is asked whether it is his, and it is a commitment the agent will follow up.
            var mine = await ravi.Get("/api/v1/agent/commitments/mine");
            Assert.True(mine.Ok, mine.ToString());
            Assert.Contains(mine.Data!.AsArray(), c => S(c!["title"]) == "Prepare the go-live checklist" && S(c["status"]) == "open");

            // The lead approves the date change: the audit trail keeps what it was before.
            var approved = await owner.Post($"/api/v1/agent/findings/{S(Of("UpdateTask")["id"])}/approve", new { });
            Assert.True(approved.Ok, approved.ToString());
            var audit = await owner.Get($"/api/v1/agent/audit?projectId={project}");
            Assert.True(audit.Ok, audit.ToString());
            var trail = audit.Data!.AsArray();
            Assert.Contains(trail, a => S(a!["action"]) == "Carried out by the agent" && a["auto"]!.GetValue<bool>());
            var change = trail.First(a => S(a!["kind"]) == "UpdateTask")!;
            Assert.Equal("Approved", S(change["action"]));
            Assert.Contains("no due date", S(change["before"]));
            Assert.Contains($"due {Day(7)}", S(change["after"]));
            Assert.Equal(HttpStatusCode.Forbidden, (await ravi.Get($"/api/v1/agent/audit?projectId={project}")).Status);

            // The decision is in the registry, the quote only for people who decide.
            var decisions = (await owner.Get($"/api/v1/agent/decisions?projectId={project}&q=two phases")).Data!.AsArray();
            Assert.Single(decisions);
            Assert.Equal("we launch in two phases", S(decisions[0]!["evidence"]));
            var seenByRavi = (await ravi.Get($"/api/v1/agent/decisions?projectId={project}")).Data!.AsArray();
            Assert.Single(seenByRavi);
            Assert.Null(seenByRavi[0]!["evidence"]);
            Assert.NotNull(key);
        }
        finally { factory.Ai.Reset(); }
    }

    [Fact]
    public async Task A_commitment_is_checked_in_on_and_a_request_for_more_time_shows_the_lead_what_it_would_move()
    {
        factory.Ai.Reset(); factory.Ai.Configured = true;
        try
        {
            var (owner, project, ravi, keyA) = await SetupAsync("Commit Desk");
            var b = await owner.CreateTaskAsync(project, "Bank certification", new { title = "Bank certification", startDate = Day(3), dueDate = Day(4), assigneeId = owner.UserId });
            var c = await owner.CreateTaskAsync(project, "Go live", new { title = "Go live", startDate = Day(5), dueDate = Day(5) });
            var (aId, tenant) = factory.WithDb(db =>
            {
                var a = db.Tasks.IgnoreQueryFilters().Single(t => t.ProjectId == project && t.Title == "Payment gateway integration");
                db.TaskDependencies.Add(new TaskDependency { TenantId = a.TenantId, TaskId = Guid.Parse(S(b["id"])), DependsOnTaskId = a.Id, CreatedAt = DateTime.UtcNow });
                db.TaskDependencies.Add(new TaskDependency { TenantId = a.TenantId, TaskId = Guid.Parse(S(c["id"])), DependsOnTaskId = Guid.Parse(S(b["id"])), CreatedAt = DateTime.UtcNow });
                db.Projects.IgnoreQueryFilters().Single(p => p.Id == project).DueDate = DateOnly.FromDateTime(DateTime.UtcNow.AddDays(6));
                db.SaveChanges();
                return (a.Id, a.TenantId);
            });

            // What if the gateway slips three days? Certification and go-live move behind it, and the project finishes late.
            var whatIf = await ravi.Post("/api/v1/agent/what-if", new { taskId = aId, newDue = Day(5) });
            Assert.True(whatIf.Ok, whatIf.ToString());
            Assert.Equal(2, whatIf.Data!["moves"]!.AsArray().Count);
            Assert.Equal("high", S(whatIf.Data["level"]));
            Assert.NotNull(whatIf.Data["projectSlipDays"]);
            Assert.Contains("moves 2 dependent tasks", S(whatIf.Data["summary"]));
            var tasks = await owner.Get($"/api/v1/agent/what-if/projects/{project}/tasks");
            Assert.Equal(1, tasks.Data!.AsArray().Single(t => S(t!["key"]) == keyA)!["dependents"]!.GetValue<int>());

            // The meeting agreed a date for the gateway; once approved it is Ravi's commitment.
            Assert.True((await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true })).Ok);
            factory.Ai.Answer = (system, prompt) => JsonSerializer.Serialize(new
            {
                summary = "Gateway by the day after tomorrow.",
                findings = new[] { new { kind = "update_task", title = "Gateway done in two days", evidence = "I'll finish the gateway in two days", source = "S1",
                    taskKey = TaskKey(prompt, "Payment gateway integration"), dueDate = Day(2), confidence = 90 } },
            });
            Assert.Equal(HttpStatusCode.Created, (await owner.Post($"/api/v1/projects/{project}/agent/transcript", new { title = "Stand-up", text = "Ravi: I'll finish the gateway in two days." })).Status);
            var finding = (await owner.Get($"/api/v1/projects/{project}/agent/findings")).Data!["items"]![0]!;
            var impactOfFinding = await owner.Get($"/api/v1/agent/findings/{S(finding["id"])}/impact");
            Assert.True(impactOfFinding.Ok, impactOfFinding.ToString());
            Assert.True((await owner.Post($"/api/v1/agent/findings/{S(finding["id"])}/approve", new { })).Ok);
            var commitment = (await ravi.Get("/api/v1/agent/commitments/mine")).Data!.AsArray().Single(x => S(x!["entityKey"]) == keyA)!;
            Assert.Equal(Day(2), S(commitment["dueDate"]));

            // Ravi needs more time: he must say why and pick a later date; the lead gets a request, the date does not move yet.
            var id = S(commitment["id"]);
            Assert.Equal(HttpStatusCode.Forbidden, (await owner.Post($"/api/v1/agent/commitments/{id}/check-in", new { answer = "on_track" })).Status);
            Assert.Equal(HttpStatusCode.UnprocessableEntity, (await ravi.Post($"/api/v1/agent/commitments/{id}/check-in", new { answer = "more_time", newDate = Day(5) })).Status);
            Assert.Equal(HttpStatusCode.UnprocessableEntity, (await ravi.Post($"/api/v1/agent/commitments/{id}/check-in", new { answer = "more_time", newDate = Day(1), note = "x" })).Status);
            var asked = await ravi.Post($"/api/v1/agent/commitments/{id}/check-in", new { answer = "more_time", newDate = Day(5), note = "The bank sandbox keys arrive on Friday." });
            Assert.True(asked.Ok, asked.ToString());
            Assert.Equal("more_time", S(asked.Data!["checkInAnswer"]));
            Assert.Equal(HttpStatusCode.Conflict, (await ravi.Post($"/api/v1/agent/commitments/{id}/check-in", new { answer = "blocked", note = "still" })).Status);
            Assert.Equal(DateOnly.Parse(Day(2)), factory.WithDb(db => db.Tasks.IgnoreQueryFilters().Single(t => t.Id == aId).DueDate));

            var center = await owner.Get("/api/v1/agent/command-center");
            Assert.True(center.Ok, center.ToString());
            var request = center.Data!["attention"]!.AsArray().First(a => S(a!["kind"]) == "change_request")!;
            Assert.Contains("Move", S(request["title"]));
            Assert.Contains(request["why"]!.AsArray(), w => S(w).Contains("dependent task"));
            Assert.Contains(request["why"]!.AsArray(), w => S(w).Contains("bank sandbox keys"));
            Assert.True(center.Data["counts"]!["toDecide"]!.GetValue<int>() >= 1);
            Assert.False(string.IsNullOrWhiteSpace(S(center.Data["headline"])));

            // The lead approves: the date moves, the old commitment is marked moved, a new one starts, Ravi hears it.
            Assert.True((await owner.Post($"/api/v1/agent/findings/{S(request["entityId"])}/approve", new { })).Ok);
            Assert.Equal(DateOnly.Parse(Day(5)), factory.WithDb(db => db.Tasks.IgnoreQueryFilters().Single(t => t.Id == aId).DueDate));
            factory.WithDb(db =>
            {
                var rows = db.AgentCommitments.IgnoreQueryFilters().Where(x => x.TaskId == aId).OrderBy(x => x.CreatedAt).ToList();
                Assert.Equal(["moved", "open"], rows.Select(r => r.Status).ToArray());
                Assert.Equal(DateOnly.Parse(Day(5)), rows[1].DueDate);
                Assert.True(db.Notifications.IgnoreQueryFilters().Any(n => n.UserId == ravi.UserId && n.Title.Contains($"moved {keyA}")));
                return 0;
            });

            // Done: the task is finished and the commitment kept.
            var next = (await ravi.Get("/api/v1/agent/commitments/mine")).Data!.AsArray().Single(x => S(x!["entityKey"]) == keyA)!;
            var done = await ravi.Post($"/api/v1/agent/commitments/{S(next["id"])}/check-in", new { answer = "done" });
            Assert.True(done.Ok, done.ToString());
            Assert.Equal("kept", S(done.Data!["status"]));
            Assert.Equal(StatusCategory.Done, factory.WithDb(db => db.Tasks.IgnoreQueryFilters().Include(t => t.Status).Single(t => t.Id == aId).Status!.Category));
            Assert.Equal(tenant, factory.WithDb(db => db.AgentCommitments.IgnoreQueryFilters().First(x => x.TaskId == aId).TenantId));
        }
        finally { factory.Ai.Reset(); }
    }

    [Fact]
    public async Task Sent_in_someones_place_the_agent_says_so_answers_in_the_chat_passes_messages_on_and_reports_back()
    {
        factory.Ai.Reset(); factory.Ai.Configured = true;
        factory.Ai.Answer = (system, prompt) => JsonSerializer.Serialize(new
        {
            summary = "The team agreed to test refunds first.",
            findings = new[] { new { kind = "decision", title = "Test refunds first", evidence = "we test refunds first", source = "S1", confidence = 80 } },
        });
        Guid meeting = Guid.Empty;
        try
        {
            var (owner, project, ravi, key) = await SetupAsync("Delegate Desk");
            await TestGoogle.ConnectAsync(factory, owner);
            Assert.True((await owner.Put("/api/v1/agent/workspace", new { botName = "Tracker Bot" })).Ok);
            Assert.True((await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true, autonomyLevel = 1 })).Ok);   // observer: silent unless sent for someone
            var at = DateTimeOffset.UtcNow.AddMinutes(1);
            var scheduled = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", new { title = "Refunds review", startTime = at, endTime = at.AddMinutes(30), timeZone = "Asia/Kolkata" });
            Assert.True(scheduled.Ok, scheduled.ToString());
            meeting = Guid.Parse(S(scheduled.Data!["id"]));
            var start = factory.WithDb(db => db.ProjectMeetings.IgnoreQueryFilters().Single(m => m.Id == meeting).StartTimeUtc);

            // My meetings, with a call on my calendar at the same time: double-booked.
            factory.GoogleCalendar.UpcomingEvents.Add(new { id = "evt_dd_1", status = "confirmed", summary = "Client escalation",
                start = new { dateTime = start.ToString("o") }, end = new { dateTime = start.AddMinutes(30).ToString("o") }, hangoutLink = "https://meet.google.com/dd-client-esc" });
            var meetings = await owner.Get("/api/v1/agent/meetings?hours=2");
            Assert.True(meetings.Ok, meetings.ToString());
            var mine = meetings.Data!.AsArray().First(m => S(m!["title"]) == "Refunds review")!;
            Assert.Contains(mine["overlapsWith"]!.AsArray(), o => S(o).Contains("Client escalation"));
            Assert.True(mine["agentEnabled"]!.GetValue<bool>());

            // Only someone invited can send the agent; the person sends it with what to raise.
            Assert.Equal(HttpStatusCode.Forbidden, (await ravi.Post("/api/v1/agent/delegations", new { meetingId = meeting, sessionStartUtc = start, instructions = "x" })).Status);
            var sent = await owner.Post("/api/v1/agent/delegations", new { meetingId = meeting, sessionStartUtc = start, instructions = "Ask whether refunds can ship on Friday." });
            Assert.Equal(HttpStatusCode.Created, sent.Status);
            var delegation = S(sent.Data!["id"]);

            await TickAsync();
            var (jobId, token) = factory.WithDb(db => db.AgentMeetingBots.IgnoreQueryFilters().Where(x => x.MeetingId == meeting && x.Kind == "bot")
                .Select(x => new { x.Id, x.WebhookToken }).AsEnumerable().Select(x => (x.Id.ToString(), x.WebhookToken)).Single());
            var job = (await BotWorkerClient.PollAsync(factory, "worker-delegate-a", 2)).Job(jobId);
            Assert.NotNull(job);
            Assert.Equal("Tracker Bot for Delegate", S(job!["botName"]));
            Assert.Contains("Delegate's assistant", S(job["introMessage"]));
            Assert.Contains("Ask whether refunds can ship on Friday.", S(job["raiseMessage"]));
            Assert.True(job["readChat"]!.GetValue<bool>());
            Assert.Equal("attending", factory.WithDb(db => db.AgentDelegations.IgnoreQueryFilters().Single(d => d.Id == Guid.Parse(delegation)).Status));
            await BotWorkerClient.PollAsync(factory, "worker-delegate-a", 2, [(jobId, "in_call_recording")]);

            using var anon = factory.CreateClient();
            async Task Hook(object body) => Assert.Equal(HttpStatusCode.OK, (await anon.PostAsJsonAsync($"/api/v1/agent/bot/{token}", body)).StatusCode);
            // Captions arrive in batches: one write for several lines.
            await Hook(new { @event = "transcript.batch", data = new { lines = new[] { new { name = "Priya", text = "we test refunds first" }, new { name = "Priya", text = "then payouts" }, new { name = "Arun", text = "agreed" } } } });
            // Someone asks the agent; someone leaves a message for the person it attends for.
            await Hook(new { @event = "chat.message", data = new { name = "Priya", text = $"agent, where is {key}?" } });
            await Hook(new { @event = "chat.message", data = new { name = "Arun", text = "Delegate can you review the refund spec?" } });
            await Hook(new { @event = "chat.message", data = new { name = "Arun", text = "lunch anyone?" } });   // not for the agent: no answer
            var chat = (await BotWorkerClient.PollAsync(factory, "worker-delegate-a", 2, [(jobId, "in_call_recording")])).Bot(jobId)!["chat"]!.AsArray().Select(S).ToList();
            Assert.Equal(2, chat.Count);
            Assert.Contains(chat, m => m.StartsWith($"🤖 {key}:") && m.Contains("Ravi"));
            Assert.Contains(chat, m => m.Contains("pass that to Delegate"));
            factory.WithDb(db =>
            {
                Assert.True(db.AgentMeetingBots.IgnoreQueryFilters().Single(x => x.WebhookToken == token).TranscriptLength > 50);
                Assert.Contains("review the refund spec", db.AgentDelegations.IgnoreQueryFilters().Single(d => d.Id == Guid.Parse(delegation)).Note);
                return 0;
            });

            // The session ends; once the transcript is read the person gets the report.
            factory.WithDb(db =>
            {
                var past = DateTime.UtcNow.AddMinutes(-10);
                db.ProjectMeetings.IgnoreQueryFilters().Single(x => x.Id == meeting).EndTimeUtc = past;
                db.AgentMeetingBots.IgnoreQueryFilters().Single(x => x.WebhookToken == token).SessionEndUtc = past;
                db.AgentDelegations.IgnoreQueryFilters().Single(d => d.Id == Guid.Parse(delegation)).SessionEndUtc = past;
                db.SaveChanges();
                return 0;
            });
            await BotWorkerClient.PollAsync(factory, "worker-delegate-a", 2, [(jobId, "call_ended")]);
            await TickAsync();
            await TickAsync();
            var report = await owner.Get($"/api/v1/agent/delegations/{delegation}");
            Assert.True(report.Ok, report.ToString());
            Assert.Equal("reported", S(report.Data!["status"]));
            Assert.Equal("The team agreed to test refunds first.", S(report.Data["summary"]));
            Assert.Contains(report.Data["outcomes"]!.AsArray(), o => S(o).Contains("Test refunds first"));
            Assert.True(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Any(n => n.UserId == owner.UserId && n.Title == "Your agent attended Refunds review")));
            // The batch arrived as lines, and chat is part of what was read.
            Assert.Contains(factory.Ai.Prompts, p => p.User.Contains("Priya: we test refunds first then payouts") && p.User.Contains("Arun: agreed")
                && p.User.Contains("Arun (chat): Delegate can you review the refund spec?"));
            Assert.Equal(HttpStatusCode.NotFound, (await ravi.Get($"/api/v1/agent/delegations/{delegation}")).Status);
        }
        finally
        {
            factory.Ai.Reset(); factory.GoogleCalendar.UpcomingEvents.Clear();
            if (meeting != Guid.Empty)
                factory.WithDb(db => { var m = db.ProjectMeetings.IgnoreQueryFilters().Single(x => x.Id == meeting); m.StartTimeUtc = DateTime.UtcNow.AddDays(-3); m.EndTimeUtc = m.StartTimeUtc.AddMinutes(30); db.SaveChanges(); return 0; });
        }
    }

    [Fact]
    public async Task Before_a_meeting_the_people_in_it_get_a_brief_with_what_is_late_and_what_waits()
    {
        factory.Ai.Reset(); factory.Ai.Configured = true;
        Guid meeting = Guid.Empty;
        try
        {
            var (owner, project, _, key) = await SetupAsync("Brief Desk");
            await owner.CreateTaskAsync(project, "Bank certification", new { title = "Bank certification", dueDate = Day(-2) });
            await TestGoogle.ConnectAsync(factory, owner);
            Assert.True((await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true })).Ok);
            var settings = await owner.Put("/api/v1/agent/me/settings", new { briefMinutes = 45, autoDelegate = false });
            Assert.True(settings.Ok, settings.ToString());
            Assert.Equal(45, settings.Data!["briefMinutes"]!.GetValue<int>());
            Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put("/api/v1/agent/me/settings", new { briefMinutes = 2 })).Status);

            var at = DateTimeOffset.UtcNow.AddMinutes(30);
            var scheduled = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", new { title = "Weekly review", startTime = at, endTime = at.AddMinutes(30), timeZone = "Asia/Kolkata" });
            Assert.True(scheduled.Ok, scheduled.ToString());
            meeting = Guid.Parse(S(scheduled.Data!["id"]));

            var brief = await owner.Get($"/api/v1/agent/meetings/{meeting}/brief");
            Assert.True(brief.Ok, brief.ToString());
            Assert.Contains("late", S(brief.Data!["headline"]));
            Assert.Contains(brief.Data["agenda"]!.AsArray(), a => S(a).StartsWith("Late work:"));
            Assert.False(brief.Data["maybeUnnecessary"]!.GetValue<bool>());

            await TickAsync();
            await TickAsync();   // once per session
            Assert.Equal(1, factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Count(n => n.UserId == owner.UserId && n.Title.StartsWith("Brief: Weekly review in"))));

            var center = await owner.Get("/api/v1/agent/command-center");
            Assert.True(center.Ok, center.ToString());
            Assert.StartsWith("Good ", S(center.Data!["greeting"]));
            Assert.Contains(center.Data["today"]!.AsArray(), m => S(m!["title"]) == "Weekly review");
            Assert.NotNull(key);
        }
        finally
        {
            factory.Ai.Reset();
            if (meeting != Guid.Empty)
                factory.WithDb(db => { var m = db.ProjectMeetings.IgnoreQueryFilters().Single(x => x.Id == meeting); m.StartTimeUtc = DateTime.UtcNow.AddDays(-3); m.EndTimeUtc = m.StartTimeUtc.AddMinutes(30); db.SaveChanges(); return 0; });
        }
    }
}

/// <summary>Connects a test person's Google account (calendar and Meet) through the real OAuth callback against the fake Google.</summary>
public static class TestGoogle
{
    public static async Task ConnectAsync(ApiFactory factory, TestClient c)
    {
        var start = await c.Get("/api/v1/integrations/google/connect");
        Assert.True(start.Ok, start.ToString());
        var url = new Uri(S(start.Data!["url"]));
        var state = url.Query.TrimStart('?').Split('&').Select(p => p.Split('=', 2)).Where(kv => kv[0] == "state").Select(kv => Uri.UnescapeDataString(kv.ElementAtOrDefault(1) ?? "")).First();
        var code = factory.GoogleCalendar.IssueCode(c.Email, "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/meetings.space.created");
        using var noRedirect = factory.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        noRedirect.DefaultRequestHeaders.Add("Cookie", start.Headers!["Set-Cookie"].Split(';')[0]);
        using var cb = await noRedirect.GetAsync($"/api/v1/integrations/google/callback?code={code}&state={state}");
        Assert.Equal(HttpStatusCode.Redirect, cb.StatusCode);
    }

    private static string S(JsonNode? n) => n!.GetValue<string>();
}
