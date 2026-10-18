using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The project agent: it reads transcripts, the project mailbox, chat, Meet transcripts and a live meeting; what it finds waits for a person
/// who may edit the project to approve; the morning update tells each person what is theirs.
/// </summary>
[Collection("api")]
public class ProjectAgentTests(ApiFactory factory)
{
    private static string? FirstTaskKey(string prompt) => Regex.Match(prompt, @"(?m)^([A-Z0-9]+-\d+) \|") is { Success: true } m ? m.Groups[1].Value : null;
    private static string? PersonId(string prompt, string name) => Regex.Match(prompt, $@"(?m)^([0-9a-f-]{{36}}) \| {Regex.Escape(name)} \|") is { Success: true } m ? m.Groups[1].Value : null;

    /// <summary>The fake model: a reading returns these findings (about the first open task and the named person); a live check returns one reminder.</summary>
    private void AnswerAsAgent(string assignee = "Ravi")
    {
        factory.Ai.Reset(); factory.Ai.Configured = true;
        factory.Ai.Answer = (system, prompt) =>
        {
            if (system.Contains("live stand-up")) return """{"nudges":["Nobody has mentioned the overdue gateway work yet - who owns it?"]}""";
            var key = FirstTaskKey(prompt);
            var who = PersonId(prompt, assignee);
            return JsonSerializer.Serialize(new
            {
                summary = "The gateway work is moving; the client wants the go-live checklist.",
                findings = new object?[]
                {
                    new { kind = "create_task", title = "Prepare the go-live checklist", detail = "The client asked for it by Friday.", evidence = "can you send the go-live checklist", source = "S1", assigneeId = who, dueDate = DateTime.UtcNow.AddDays(5).ToString("yyyy-MM-dd"), priority = "High", confidence = 90 },
                    key is null ? null : new { kind = "update_task", title = "Gateway integration is in progress", evidence = "I started the gateway integration", source = "S1", taskKey = key, status = "in_progress", comment = "Integration started; sandbox keys received.", confidence = 85 },
                    new { kind = "suggestion", title = "Add a retry queue for failed payments", evidence = "we should retry failed payments", source = "S1", confidence = 70 },
                    new { kind = "missed", title = "Nobody owns the refund flow", detail = "Raised twice, no owner or date.", evidence = "who is doing refunds?", source = "S1", confidence = 75 },
                    new { kind = "nonsense", title = "ignored" },
                },
            });
        };
    }

    private async Task<(TestClient Owner, Guid Project, TestClient Ravi, string TaskKey, Guid TaskId)> SetupAsync(string name)
    {
        var owner = await TestClient.RegisterAsync(factory, $"{name} Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var project = await owner.CreateProjectAsync(name);
        var ravi = await owner.AddMemberAsync(factory, TenantRole.Member, "Ravi");
        var task = await owner.CreateTaskAsync(project, "Payment gateway integration");
        return (owner, project, ravi, task["key"]!.GetValue<string>(), Guid.Parse(task["id"]!.GetValue<string>()));
    }

    private async Task<AgentEngine.TickResult> TickAsync()
    {
        using var scope = factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<AgentEngine>().TickAsync();
    }

    [Fact]
    public async Task A_transcript_becomes_proposals_that_only_project_editors_approve()
    {
        AnswerAsAgent();
        try
        {
            var (owner, project, ravi, key, taskId) = await SetupAsync("Payments Core");

            var off = await owner.Get($"/api/v1/projects/{project}/agent");
            Assert.True(off.Ok, off.ToString());
            Assert.False(off.Data!["enabled"]!.GetValue<bool>());
            Assert.True(off.Data["canManage"]!.GetValue<bool>());
            Assert.Equal(HttpStatusCode.Forbidden, (await ravi.Put($"/api/v1/projects/{project}/agent", new { enabled = true })).Status);

            var on = await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true });
            Assert.True(on.Ok, on.ToString());
            Assert.Matches("^agent\\+[0-9a-f]{24}@inbound\\.test$", on.Data!["mailboxAddress"]!.GetValue<string>());
            Assert.Null((await ravi.Get($"/api/v1/projects/{project}/agent")).Data!["mailboxAddress"]);   // only editors see the address

            var text = "Prasanna: Morning all.\nRavi: I started the gateway integration yesterday, sandbox keys are in.\nClient: can you send the go-live checklist by Friday?\n" +
                "Ravi: we should retry failed payments.\nPrasanna: who is doing refunds?";
            Assert.Equal(HttpStatusCode.Forbidden, (await ravi.Post($"/api/v1/projects/{project}/agent/transcript", new { title = "Stand-up", text })).Status);
            var read = await owner.Post($"/api/v1/projects/{project}/agent/transcript", new { title = "Stand-up 18 Oct", text });
            Assert.Equal(HttpStatusCode.Created, read.Status);
            var run = read.Data!["run"]!;
            Assert.Equal("done", run["status"]!.GetValue<string>());
            Assert.Equal(4, run["findingCount"]!.GetValue<int>());
            Assert.Contains(factory.Ai.Prompts, p => p.User.Contains("who is doing refunds?") && p.User.Contains(key));
            Assert.Equal(HttpStatusCode.Conflict, (await owner.Post($"/api/v1/projects/{project}/agent/transcript", new { title = "Again", text })).Status);

            var page = (await owner.Get($"/api/v1/projects/{project}/agent/findings")).Data!;
            Assert.Equal(4, page["pending"]!.GetValue<int>());
            Assert.True(page["canDecide"]!.GetValue<bool>());
            var hidden = (await ravi.Get($"/api/v1/projects/{project}/agent/findings")).Data!;
            Assert.False(hidden["canDecide"]!.GetValue<bool>());
            Assert.Empty(hidden["items"]!.AsArray());   // quotes from what the agent read are for the people who decide
            Assert.Null((await ravi.Get($"/api/v1/projects/{project}/agent")).Data!["runs"]![0]!["summary"]);
            var items = page["items"]!.AsArray();
            string Id(string kind) => items.First(i => i!["kind"]!.GetValue<string>() == kind)!["id"]!.GetValue<string>();
            Assert.Equal("Stand-up 18 Oct", items.First(i => i!["kind"]!.GetValue<string>() == "CreateTask")!["sourceLabel"]!.GetValue<string>());
            Assert.Equal(HttpStatusCode.Forbidden, (await ravi.Post($"/api/v1/agent/findings/{Id("CreateTask")}/approve", new { })).Status);

            // Approving a new task (with the title edited) creates it, assigned to Ravi.
            var created = await owner.Post($"/api/v1/agent/findings/{Id("CreateTask")}/approve", new { title = "Send the go-live checklist" });
            Assert.True(created.Ok, created.ToString());
            Assert.Equal("Applied", created.Data!["status"]!.GetValue<string>());
            var newKey = created.Data["appliedKey"]!.GetValue<string>();
            factory.WithDb(db =>
            {
                var t = db.Tasks.IgnoreQueryFilters().Single(x => x.Id == Guid.Parse(created.Data["appliedEntityId"]!.GetValue<string>()));
                Assert.Equal("Send the go-live checklist", t.Title);
                Assert.Equal(ravi.UserId, t.AssigneeId);
                Assert.Contains("From the project agent", t.Description);
                Assert.True(db.Notifications.IgnoreQueryFilters().Any(n => n.UserId == ravi.UserId && n.Type == NotificationType.TaskAssigned && n.Title.Contains(newKey)));
                return 0;
            });

            // Approving the update moves the existing task and adds the agent's note as a comment.
            var updated = await owner.Post($"/api/v1/agent/findings/{Id("UpdateTask")}/approve", new { });
            Assert.True(updated.Ok, updated.ToString());
            Assert.Equal(key, updated.Data!["appliedKey"]!.GetValue<string>());
            factory.WithDb(db =>
            {
                var t = db.Tasks.IgnoreQueryFilters().Include(x => x.Status).Single(x => x.Id == taskId);
                Assert.Equal(StatusCategory.Active, t.Status!.Category);
                Assert.Contains(db.TaskComments.IgnoreQueryFilters().Where(c => c.TaskId == taskId).Select(c => c.Body).ToList(), b => b.Contains("sandbox keys"));
                return 0;
            });

            Assert.Equal("Dismissed", (await owner.Post($"/api/v1/agent/findings/{Id("Suggestion")}/dismiss", new { })).Data!["status"]!.GetValue<string>());
            Assert.Equal(HttpStatusCode.Conflict, (await owner.Post($"/api/v1/agent/findings/{Id("Suggestion")}/approve", new { })).Status);

            var inbox = await owner.Get("/api/v1/agent/inbox");
            Assert.Contains(inbox.Data!["items"]!.AsArray(), i => i!["kind"]!.GetValue<string>() == "Missed" && i["projectId"]!.GetValue<string>() == project.ToString());
            var all = await owner.Post($"/api/v1/projects/{project}/agent/findings/approve-all", new { });
            Assert.True(all.Ok, all.ToString());
            Assert.Equal(1, all.Data!["applied"]!.GetValue<int>());
            Assert.Equal(0, (await owner.Get($"/api/v1/projects/{project}/agent/findings")).Data!["pending"]!.GetValue<int>());

            Assert.True((await owner.Get("/api/v1/ai/credits/balance")).Data!["spent"]!.GetValue<long>() >= 4);
        }
        finally { factory.Ai.Reset(); }
    }

    [Fact]
    public async Task Mail_to_the_project_address_and_quiet_project_chat_are_read_in_the_background()
    {
        AnswerAsAgent();
        try
        {
            var (owner, project, _, _, _) = await SetupAsync("Loan Desk");
            var on = await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true });
            var address = on.Data!["mailboxAddress"]!.GetValue<string>();

            using var anon = factory.CreateClient();
            var mail = await anon.PostAsJsonAsync("/api/v1/inbound/email", new { from = "client@bank.example", to = $"Team <team@x.in>, {address}",
                subject = "Go-live", text = "Hi team, can you send the go-live checklist? Also who is doing refunds?" });
            Assert.Equal(HttpStatusCode.OK, mail.StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await anon.PostAsJsonAsync("/api/v1/inbound/agent/000000000000000000000000", new { from = "a@b.c", subject = "x", text = "hello there friends" })).StatusCode);

            // The chat is read once it has been quiet for a while.
            var chat = await owner.Post($"/api/v1/chat/projects/{project}/open", new { });
            var conversation = chat.Data!["id"]!.GetValue<string>();
            Assert.True((await owner.Post($"/api/v1/chat/conversations/{conversation}/messages", new { body = "Gateway sandbox works, moving to UAT next week." })).Ok);
            factory.WithDb(db =>
            {
                var cid = Guid.Parse(conversation);
                foreach (var m in db.ChatMessages.IgnoreQueryFilters().Where(x => x.ConversationId == cid)) m.CreatedAt = DateTime.UtcNow.AddMinutes(-20);
                db.ProjectAgentSettings.IgnoreQueryFilters().Single(x => x.ProjectId == project).ChatReadUntil = DateTime.UtcNow.AddHours(-1);
                db.SaveChanges();
                return 0;
            });

            await TickAsync();
            factory.WithDb(db =>
            {
                var signals = db.AgentSignals.IgnoreQueryFilters().Where(s => s.ProjectId == project).ToList();
                Assert.Contains(signals, s => s.Source == AgentSourceKind.ProjectMailbox && s.ProcessedAt != null && s.FromName == "client@bank.example");
                Assert.Contains(signals, s => s.Source == AgentSourceKind.Chat && s.ProcessedAt != null);
                Assert.DoesNotContain(signals, s => s.ContentProtected.Contains("refunds"));   // stored encrypted
                var run = db.AgentRuns.IgnoreQueryFilters().Single(r => r.ProjectId == project);
                Assert.Equal("mail", run.Trigger); Assert.Equal("done", run.Status); Assert.Equal(2, run.SignalCount);
                Assert.True(db.Notifications.IgnoreQueryFilters().Any(n => n.UserId == owner.UserId && n.Type == NotificationType.ProjectUpdated && n.Link!.Contains("tab=agent")));
                return 0;
            });
            Assert.Contains(factory.Ai.Prompts, p => p.User.Contains("outside the workspace") && p.User.Contains("moving to UAT"));
        }
        finally { factory.Ai.Reset(); }
    }

    [Fact]
    public async Task Everyone_with_work_gets_their_own_morning_update()
    {
        var (owner, project, ravi, _, _) = await SetupAsync("Morning Desk");
        factory.Ai.Reset(); factory.Ai.Configured = true;
        try
        {
            await owner.CreateTaskAsync(project, "Reconcile settlements", new { title = "Reconcile settlements", priority = "High", assigneeId = ravi.UserId,
                dueDate = DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-3)) });
            Assert.True((await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true, dailyUpdates = true })).Ok);
            using (var scope = factory.Services.CreateScope())
            {
                var sp = scope.ServiceProvider;
                await ProjectManagement.Application.Services.WorkspaceExecutionPrincipal.ConfigureAsync(sp, owner.UserId, owner.WorkspaceId, null, default);
                var db = sp.GetRequiredService<ProjectManagement.Application.Abstractions.IAppDbContext>();
                var settings = await db.ProjectAgentSettings.FirstAsync(s => s.ProjectId == project);
                var daily = sp.GetRequiredService<AgentDailyUpdateService>();
                Assert.True(await daily.SendAsync(settings, "20991231", default) >= 1);
                Assert.Equal(0, await daily.SendAsync(settings, "20991231", default));   // once a day
            }
            factory.WithDb(db =>
            {
                var note = db.Notifications.IgnoreQueryFilters().Single(n => n.UserId == ravi.UserId && n.Type == NotificationType.Briefing && n.DedupeKey!.StartsWith("agent-daily:"));
                Assert.Contains("Slipping", note.Body);
                Assert.Contains("d late", note.Body);
                return 0;
            });
        }
        finally { factory.Ai.Reset(); }
    }

    private static string QueryValue(Uri u, string name) =>
        u.Query.TrimStart('?').Split('&').Select(p => p.Split('=', 2)).Where(kv => kv[0] == name).Select(kv => Uri.UnescapeDataString(kv.ElementAtOrDefault(1) ?? "")).First();

    private async Task ConnectGoogleAsync(TestClient c, bool transcripts)
    {
        var start = await c.Get($"/api/v1/integrations/google/connect{(transcripts ? "?transcripts=true" : "")}");
        Assert.True(start.Ok, start.ToString());
        var state = QueryValue(new Uri(start.Data!["url"]!.GetValue<string>()), "state");
        var scope = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/meetings.space.created" + (transcripts ? " https://www.googleapis.com/auth/meetings.space.readonly" : "");
        var code = factory.GoogleCalendar.IssueCode(c.Email, scope);
        using var noRedirect = factory.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        noRedirect.DefaultRequestHeaders.Add("Cookie", start.Headers!["Set-Cookie"].Split(';')[0]);
        using var cb = await noRedirect.GetAsync($"/api/v1/integrations/google/callback?code={code}&state={state}");
        Assert.Equal(HttpStatusCode.Redirect, cb.StatusCode);
    }

    private async Task<Guid> MeetingAsync(TestClient owner, Guid project, DateTime start, DateTime end)
    {
        var at = DateTimeOffset.UtcNow.AddDays(1);
        var res = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", new { title = "Daily stand-up", startTime = at, endTime = at.AddMinutes(15), timeZone = "Asia/Kolkata", scrum = true });
        Assert.True(res.Ok, res.ToString());
        var id = Guid.Parse(res.Data!["id"]!.GetValue<string>());
        factory.WithDb(db =>
        {
            var m = db.ProjectMeetings.IgnoreQueryFilters().Single(x => x.Id == id);
            m.StartTimeUtc = start; m.EndTimeUtc = end;
            db.SaveChanges();
            return 0;
        });
        return id;
    }

    [Fact]
    public async Task A_finished_meeting_is_read_from_its_Google_Meet_transcript()
    {
        AnswerAsAgent();
        try
        {
            var (owner, project, _, _, _) = await SetupAsync("Meet Reader");
            await ConnectGoogleAsync(owner, transcripts: true);
            var start = DateTime.UtcNow.AddMinutes(-60); var end = DateTime.UtcNow.AddMinutes(-30);
            var meeting = await MeetingAsync(owner, project, start, end);
            Assert.True((await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true })).Ok);
            Assert.True((await owner.Get($"/api/v1/projects/{project}/agent")).Data!["transcriptAccess"]!.GetValue<bool>());

            factory.GoogleCalendar.MeetRecord = (start, end);
            factory.GoogleCalendar.MeetTranscript.Clear();
            factory.GoogleCalendar.MeetTranscript.Add(("Ravi", "I started the gateway integration, sandbox keys are in."));
            factory.GoogleCalendar.MeetTranscript.Add(("Client", "Can you send the go-live checklist? And who is doing refunds?"));
            await TickAsync();
            factory.WithDb(db =>
            {
                var signal = db.AgentSignals.IgnoreQueryFilters().Single(s => s.ProjectId == project && s.Source == AgentSourceKind.MeetingTranscript);
                Assert.Equal(meeting, signal.MeetingId);
                Assert.NotNull(signal.ProcessedAt);
                Assert.Equal("meeting", db.AgentRuns.IgnoreQueryFilters().Single(r => r.ProjectId == project).Trigger);
                Assert.Equal("done", db.AgentMeetingBots.IgnoreQueryFilters().Single(b => b.MeetingId == meeting && b.Kind == "meet").Status);
                Assert.True(db.AgentFindings.IgnoreQueryFilters().Count(f => f.ProjectId == project) >= 3);
                return 0;
            });
            Assert.Contains(factory.Ai.Prompts, p => p.User.Contains("Client: Can you send the go-live checklist?"));
            await TickAsync();   // read once
            Assert.Equal(1, factory.WithDb(db => db.AgentSignals.IgnoreQueryFilters().Count(s => s.ProjectId == project && s.Source == AgentSourceKind.MeetingTranscript)));
        }
        finally { factory.Ai.Reset(); factory.GoogleCalendar.MeetRecord = null; factory.GoogleCalendar.MeetTranscript.Clear(); }
    }

    [Fact]
    public async Task The_live_bot_joins_listens_reminds_the_team_and_hands_over_the_transcript()
    {
        AnswerAsAgent();
        factory.MeetingBot.Reset();
        try
        {
            var (owner, project, ravi, _, _) = await SetupAsync("Live Desk");
            await owner.CreateTaskAsync(project, "Gateway certification", new { title = "Gateway certification", priority = "High", dueDate = DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-2)) });
            // The bot is the installation's own: nothing to buy or set up per workspace. Admins only name it and choose whether it reminds people.
            Assert.True((await owner.Get("/api/v1/agent/workspace")).Data!["botAvailable"]!.GetValue<bool>());
            Assert.Equal(HttpStatusCode.Forbidden, (await ravi.Put("/api/v1/agent/workspace", new { botName = "Ravi Bot" })).Status);
            var w = await owner.Put("/api/v1/agent/workspace", new { botName = "Tracker Bot", inCallReminders = true });
            Assert.True(w.Ok, w.ToString());
            Assert.Equal("Tracker Bot", w.Data!["botName"]!.GetValue<string>());
            Assert.True((await owner.Get($"/api/v1/projects/{project}/agent")).Data!["liveBotAvailable"]!.GetValue<bool>());

            await ConnectGoogleAsync(owner, transcripts: false);
            var start = DateTime.UtcNow.AddMinutes(3); var end = DateTime.UtcNow.AddMinutes(18);
            var meeting = await MeetingAsync(owner, project, start, end);
            Assert.True((await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true, liveBot = true })).Ok);

            await TickAsync();
            var create = Assert.Single(factory.MeetingBot.Requests, r => r.Path == "/bots" && r.Body.Contains("meet.google.com"));
            Assert.Contains("Tracker Bot", create.Body);
            Assert.Contains("/api/v1/agent/bot/", create.Body);
            Assert.Contains("leaveAt", create.Body);
            var token = factory.WithDb(db => db.AgentMeetingBots.IgnoreQueryFilters().Single(b => b.MeetingId == meeting && b.Kind == "bot").WebhookToken);

            using var anon = factory.CreateClient();
            async Task Say(string who, string words) =>
                Assert.Equal(HttpStatusCode.OK, (await anon.PostAsJsonAsync($"/api/v1/agent/bot/{token}", new
                {
                    @event = "transcript.data",
                    data = new { data = new { words = words.Split(' ').Select(w => new { text = w }).ToArray(), participant = new { id = 1, name = who } }, bot = new { id = "bot" } },
                })).StatusCode);
            for (var i = 0; i < 6; i++)
            {
                await Say("Ravi", "Yesterday I worked on the settlement report and the merchant onboarding screens, today I continue with the onboarding flow and reviews.");
                await Say("Priya", "I am testing the refund screens and found two layout problems on small phones which I will log as tickets after this call today.");
            }
            Assert.Equal(HttpStatusCode.NotFound, (await anon.PostAsJsonAsync("/api/v1/agent/bot/00000000000000000000000000000000", new { @event = "transcript.data" })).StatusCode);
            // Odd deliveries are ignored, never an error.
            Assert.Equal(HttpStatusCode.OK, (await anon.PostAsJsonAsync($"/api/v1/agent/bot/{token}", new[] { 1, 2 })).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await anon.PostAsJsonAsync($"/api/v1/agent/bot/{token}", new { @event = 5, data = "text" })).StatusCode);

            // Ten minutes in: the bot points out what is being missed, in the meeting chat.
            var began = DateTime.UtcNow.AddMinutes(-10); var finish = DateTime.UtcNow.AddMinutes(5);
            factory.WithDb(db =>
            {
                var m = db.ProjectMeetings.IgnoreQueryFilters().Single(x => x.Id == meeting); m.StartTimeUtc = began; m.EndTimeUtc = finish;
                var b = db.AgentMeetingBots.IgnoreQueryFilters().Single(x => x.WebhookToken == token); b.SessionStartUtc = began; b.SessionEndUtc = finish;
                Assert.Equal("in_call", b.Status);
                Assert.True(b.TranscriptLength > 800);
                db.SaveChanges();
                return 0;
            });
            await TickAsync();
            Assert.Contains(factory.MeetingBot.Chat, m => m.Contains("overdue gateway work"));
            Assert.Contains(factory.Ai.Prompts, p => p.System.Contains("live stand-up") && p.User.Contains("Gateway certification") && p.User.Contains("Priya: I am testing"));

            // The session ends: the transcript is read like any other meeting.
            factory.WithDb(db =>
            {
                var m = db.ProjectMeetings.IgnoreQueryFilters().Single(x => x.Id == meeting); m.EndTimeUtc = DateTime.UtcNow.AddMinutes(-10);
                var b = db.AgentMeetingBots.IgnoreQueryFilters().Single(x => x.WebhookToken == token); b.SessionEndUtc = m.EndTimeUtc; b.LastAttemptAt = null;
                db.SaveChanges();
                return 0;
            });
            factory.MeetingBot.Status = "done";
            await TickAsync();
            factory.WithDb(db =>
            {
                Assert.Equal("done", db.AgentMeetingBots.IgnoreQueryFilters().Single(x => x.WebhookToken == token).Status);
                Assert.Contains(db.AgentSignals.IgnoreQueryFilters().Where(s => s.ProjectId == project).ToList(), s => s.Source == AgentSourceKind.LiveMeeting && s.ProcessedAt != null);
                Assert.Contains(db.AgentRuns.IgnoreQueryFilters().Where(r => r.ProjectId == project).ToList(), r => r.Trigger == "meeting" && r.Status == "done");
                return 0;
            });
            Assert.Single(factory.MeetingBot.Requests, r => r.Path == "/bots");   // one bot for the session
        }
        finally { factory.Ai.Reset(); factory.MeetingBot.Reset(); }
    }

    [Fact]
    public void Transcripts_in_WebVTT_become_speaker_lines()
    {
        var vtt = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\n<v Ravi>I started the gateway work.</v>\n\n2\n00:00:05.000 --> 00:00:07.000\n<v Priya>Refunds are blocked.</v>\n";
        Assert.Equal("Ravi: I started the gateway work.\nPriya: Refunds are blocked.", Transcripts.Normalize(vtt));
        Assert.Equal("plain text stays", Transcripts.Normalize("plain text stays"));
    }
}
