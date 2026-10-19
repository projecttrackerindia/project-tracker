using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Admin;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The project agent, more accurate and more useful: the lead's notes and speaker names reach the model, quotes are checked against their
/// source, a second look drops what the source does not support, the team's decisions teach the next reading, the assignee confirms work,
/// minutes go out, and Slack, WhatsApp and calendar calls are read. Plus retention of what was read and the hosting failure alert.
/// </summary>
[Collection("api")]
public class ProjectAgentAccuracyTests(ApiFactory factory)
{
    private static string? PersonId(string prompt, string name) => Regex.Match(prompt, $@"(?m)^([0-9a-f-]{{36}}) \| {Regex.Escape(name)} \|") is { Success: true } m ? m.Groups[1].Value : null;

    private async Task<(TestClient Owner, Guid Project, TestClient Ravi, string Key)> SetupAsync(string name)
    {
        var owner = await TestClient.RegisterAsync(factory, $"{name} Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var project = await owner.CreateProjectAsync(name);
        var ravi = await owner.AddMemberAsync(factory, TenantRole.Member, "Ravi Kumar");
        var key = factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == project).Key);
        return (owner, project, ravi, key);
    }

    private async Task TickAsync()
    {
        using var scope = factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<AgentEngine>().TickAsync();
    }

    [Fact]
    public void Quotes_are_matched_word_for_word_or_nearly()
    {
        var source = "Ravi: I started the gateway integration yesterday, sandbox keys are in.\nClient: can you send the go-live checklist by Friday?";
        Assert.True(AgentAnalysisService.Grounded("Can you send the go-live checklist", source));
        Assert.True(AgentAnalysisService.Grounded("started the gateway integration, sandbox keys in", source));
        Assert.False(AgentAnalysisService.Grounded("the vendor promised a ten percent discount", source));
        Assert.False(AgentAnalysisService.Grounded("ok", source));
        Assert.Equal(new (string, string)[] { ("RK", "ravi@x.in"), ("Priya S", "Priya Sharma") }, AgentSettingsService.Aliases("RK = ravi@x.in\nnot a line\nPriya S = Priya Sharma"));
        Assert.True(AgentSignalService.AddressedToProject("PAY: refunds are blocked"));
        Assert.False(AgentSignalService.AddressedToProject("hello there"));
        Assert.Equal("@ravi see Report", AgentSlackReader.Plain("<@U1|ravi> see <https://x.example/r|Report>"));
    }

    [Fact]
    public async Task Notes_names_and_a_second_look_make_the_proposals_accurate_and_the_team_teaches_the_next_reading()
    {
        var (owner, project, ravi, key) = await SetupAsync("Accuracy Desk");
        factory.Ai.Reset(); factory.Ai.Configured = true;
        factory.Ai.Answer = (system, prompt) =>
        {
            if (system.Contains("You check")) return """{"checks":[{"n":3,"supported":false},{"n":1,"supported":true,"ownerClear":false,"dateClear":true,"confidence":80}]}""";
            var who = PersonId(prompt, "Ravi Kumar");
            return JsonSerializer.Serialize(new
            {
                summary = "Go-live preparation; refunds have no owner.",
                findings = new object[]
                {
                    new { kind = "create_task", title = "Prepare the go-live checklist", evidence = "can you send the go-live checklist", source = "S1", assigneeId = who, confidence = 90 },
                    new { kind = "decision", title = "Refunds ship next sprint", evidence = "the vendor promised a ten percent discount", source = "S1", confidence = 90 },
                    new { kind = "suggestion", title = "Add a retry queue for failed payments", evidence = "we should retry failed payments", source = "S1", confidence = 70 },
                    new { kind = "missed", title = "Nobody owns the refund flow", evidence = "who is doing refunds?", source = "S1", confidence = 75 },
                },
            });
        };
        try
        {
            Assert.False((await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true, captionLanguage = "xx" })).Ok);
            Assert.False((await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true, speakerAliases = "no equals sign here" })).Ok);
            var on = await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true, captionLanguage = "hi", sendMinutes = true,
                instructions = "UAT means the bank's test environment. Ignore small talk about cricket.", speakerAliases = $"RK = {ravi.Email}" });
            Assert.True(on.Ok, on.ToString());
            Assert.Equal("hi", on.Data!["captionLanguage"]!.GetValue<string>());
            Assert.Contains("bank's test", on.Data["instructions"]!.GetValue<string>());
            Assert.Null((await ravi.Get($"/api/v1/projects/{project}/agent")).Data!["instructions"]);   // the lead's notes are for the people who set it up

            var text = "Prasanna: Morning.\nRK: I started the gateway integration.\nClient: can you send the go-live checklist by Friday?\nRK: we should retry failed payments.\nPrasanna: who is doing refunds?";
            var read = await owner.Post($"/api/v1/projects/{project}/agent/transcript", new { title = "Stand-up 19 Oct", text });
            Assert.Equal(HttpStatusCode.Created, read.Status);
            Assert.Contains(factory.Ai.Prompts, p => p.User.Contains("TEAM NOTES") && p.User.Contains("bank's test environment") && p.User.Contains("\"RK\" = Ravi Kumar"));
            Assert.Contains(factory.Ai.Prompts, p => p.System.Contains("You check") && p.User.Contains("Prepare the go-live checklist"));

            var items = (await owner.Get($"/api/v1/projects/{project}/agent/findings")).Data!["items"]!.AsArray();
            Assert.Equal(3, items.Count);   // the checker dropped the suggestion the source did not support
            Assert.DoesNotContain(items, i => i!["kind"]!.GetValue<string>() == "Suggestion");
            var task = items.Single(i => i!["kind"]!.GetValue<string>() == "CreateTask")!;
            Assert.Null(task["assignee"]);   // the source did not make the owner clear
            Assert.Equal(80, task["confidence"]!.GetValue<int>());
            Assert.True(task["grounded"]!.GetValue<bool>());
            var decision = items.Single(i => i!["kind"]!.GetValue<string>() == "Decision")!;
            Assert.False(decision["grounded"]!.GetValue<bool>());   // its quote is not in the transcript
            Assert.True(decision["confidence"]!.GetValue<int>() <= 35);
            string Id(string kind) => items.Single(i => i!["kind"]!.GetValue<string>() == kind)!["id"]!.GetValue<string>();

            // The lead changes the title and gives it to Ravi; Ravi is asked to confirm, and says it is not his.
            var approved = await owner.Post($"/api/v1/agent/findings/{Id("CreateTask")}/approve", new { title = "Send the go-live checklist", assigneeId = ravi.UserId });
            Assert.True(approved.Ok, approved.ToString());
            Assert.Equal("title, owner", approved.Data!["edits"]!.GetValue<string>());
            Assert.True((await owner.Post($"/api/v1/agent/findings/{Id("Decision")}/dismiss", new { })).Ok);
            Assert.True((await owner.Post($"/api/v1/agent/findings/{Id("Missed")}/approve", new { })).Ok);

            var mine = await ravi.Get("/api/v1/agent/assigned");
            Assert.True(mine.Ok, mine.ToString());
            Assert.Equal(1, mine.Data!["pending"]!.GetValue<int>());
            var given = mine.Data["items"]![0]!["id"]!.GetValue<string>();
            Assert.Equal(HttpStatusCode.Forbidden, (await owner.Post($"/api/v1/agent/findings/{given}/respond", new { response = "accepted" })).Status);
            Assert.Equal(HttpStatusCode.UnprocessableEntity, (await ravi.Post($"/api/v1/agent/findings/{given}/respond", new { response = "declined" })).Status);
            var no = await ravi.Post($"/api/v1/agent/findings/{given}/respond", new { response = "declined", note = "Priya owns go-live" });
            Assert.True(no.Ok, no.ToString());
            Assert.Equal("declined", no.Data!["ownerResponse"]!.GetValue<string>());
            factory.WithDb(db =>
            {
                Assert.True(db.Notifications.IgnoreQueryFilters().Any(n => n.UserId == ravi.UserId && n.Link == "/project-agent/assigned"));
                Assert.True(db.Notifications.IgnoreQueryFilters().Any(n => n.UserId == owner.UserId && n.Title.Contains("is not theirs")));
                Assert.Single(db.AgentRuns.IgnoreQueryFilters().Where(r => r.ProjectId == project && r.MinutesSentAt != null).ToList());
                return 0;
            });
            // Everything from the meeting is decided: the MOM, with the transcript, was e-mailed once to the people in it - in the lead's
            // name, replies to the lead's own address (no mailbox for the bot).
            var mom = (await owner.Get("/api/v1/dev/emails")).Data!.AsArray().Where(m => m!["subject"]!.GetValue<string>().StartsWith("MOM: Stand-up 19 Oct")).ToList();
            var toOwner = Assert.Single(mom, m => string.Equals(m!["to"]!.GetValue<string>(), owner.Email, StringComparison.OrdinalIgnoreCase))!;
            Assert.Contains("Send the go-live checklist", toOwner["text"]!.GetValue<string>());
            Assert.Contains("Prasanna: who is doing refunds?", toOwner["text"]!.GetValue<string>());   // the transcript
            Assert.Equal(owner.Email, toOwner["replyTo"]!.GetValue<string>(), ignoreCase: true);
            Assert.Equal("Accuracy Desk Owner via Project Tracker", toOwner["fromName"]!.GetValue<string>());
            Assert.Contains(mom, m => string.Equals(m!["to"]!.GetValue<string>(), ravi.Email, StringComparison.OrdinalIgnoreCase));

            // The next reading is told how the team decided.
            var again = await owner.Post($"/api/v1/projects/{project}/agent/transcript", new { title = "Stand-up 20 Oct", text = text + "\nPrasanna: and the settlement report is late." });
            Assert.Equal(HttpStatusCode.Created, again.Status);
            Assert.Contains(factory.Ai.Prompts, p => p.User.Contains("HOW THE TEAM DECIDED BEFORE") && p.User.Contains("dismissed Decision: Refunds ship next sprint")
                && p.User.Contains("\"Prepare the go-live checklist\" became \"Send the go-live checklist\"") && p.User.Contains("said it was not theirs")
                && p.User.Contains("LAST MEETING"));
        }
        finally { factory.Ai.Reset(); }
    }

    private static string QueryValue(Uri u, string name) =>
        u.Query.TrimStart('?').Split('&').Select(p => p.Split('=', 2)).Where(kv => kv[0] == name).Select(kv => Uri.UnescapeDataString(kv.ElementAtOrDefault(1) ?? "")).First();

    private async Task ConnectGoogleAsync(TestClient c)
    {
        var start = await c.Get("/api/v1/integrations/google/connect");
        Assert.True(start.Ok, start.ToString());
        var state = QueryValue(new Uri(start.Data!["url"]!.GetValue<string>()), "state");
        var code = factory.GoogleCalendar.IssueCode(c.Email);
        using var noRedirect = factory.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        noRedirect.DefaultRequestHeaders.Add("Cookie", start.Headers!["Set-Cookie"].Split(';')[0]);
        using var cb = await noRedirect.GetAsync($"/api/v1/integrations/google/callback?code={code}&state={state}");
        Assert.Equal(HttpStatusCode.Redirect, cb.StatusCode);
    }

    [Fact]
    public async Task Meet_transcribes_with_the_organizers_own_account_and_the_MOM_can_be_sent_now()
    {
        factory.Ai.Reset(); factory.Ai.Configured = true;
        factory.Ai.Answer = (_, _) => """{"summary":"Release slips a week.","findings":[{"kind":"decision","title":"Release moves to Friday","evidence":"we move the release to Friday","source":"S1","confidence":90}]}""";
        try
        {
            var (owner, project, ravi, _) = await SetupAsync("Auto Desk");
            // One consent with the organizer's own Google account: read Meet transcripts and switch them on. No account or mailbox for a bot.
            var start = await owner.Get("/api/v1/integrations/google/connect?autoTranscripts=true");
            Assert.True(start.Ok, start.ToString());
            Assert.Contains("meetings.space.settings", Uri.UnescapeDataString(start.Data!["url"]!.GetValue<string>()));
            var state = QueryValue(new Uri(start.Data["url"]!.GetValue<string>()), "state");
            var code = factory.GoogleCalendar.IssueCode(owner.Email, "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/meetings.space.created " +
                "https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/meetings.space.settings");
            using (var noRedirect = factory.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { AllowAutoRedirect = false }))
            {
                noRedirect.DefaultRequestHeaders.Add("Cookie", start.Headers!["Set-Cookie"].Split(';')[0]);
                using var cb = await noRedirect.GetAsync($"/api/v1/integrations/google/callback?code={code}&state={state}");
                Assert.Equal(HttpStatusCode.Redirect, cb.StatusCode);
            }
            var at = DateTimeOffset.UtcNow.AddDays(1);
            var scheduled = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", new { title = "Daily stand-up", startTime = at, endTime = at.AddMinutes(15), timeZone = "Asia/Kolkata", scrum = true });
            Assert.True(scheduled.Ok, scheduled.ToString());
            var meeting = Guid.Parse(scheduled.Data!["id"]!.GetValue<string>());
            Assert.True((await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true })).Ok);
            Assert.True((await owner.Get($"/api/v1/projects/{project}/agent")).Data!["autoTranscriptAccess"]!.GetValue<bool>());

            await TickAsync();
            await TickAsync();
            factory.WithDb(db =>
            {
                var row = Assert.Single(db.AgentMeetingBots.IgnoreQueryFilters().Where(b => b.MeetingId == meeting && b.Kind == "auto").ToList());
                Assert.Equal("done", row.Status);
                var uri = db.ProjectMeetings.IgnoreQueryFilters().Single(m => m.Id == meeting).GoogleMeetUri;
                Assert.Contains("spaces/sp-" + uri.Split('/').Last(), factory.GoogleCalendar.AutoTranscripts);
                return 0;
            });
            Assert.Single(factory.GoogleCalendar.AutoTranscripts.Where(x => x.EndsWith(factory.WithDb(db => db.ProjectMeetings.IgnoreQueryFilters().Single(m => m.Id == meeting).GoogleMeetUri).Split('/').Last())));

            // The MOM can be sent at any time by someone who may edit the project, in their name.
            var read = await owner.Post($"/api/v1/projects/{project}/agent/transcript", new { title = "Release call", text = "Asha: we move the release to Friday.\nRavi: fine, I will update the plan today." });
            var runId = read.Data!["run"]!["id"]!.GetValue<string>();
            Assert.True((await owner.Get($"/api/v1/projects/{project}/agent")).Data!["runs"]![0]!["meeting"]!.GetValue<bool>());
            Assert.Equal(HttpStatusCode.Forbidden, (await ravi.Post($"/api/v1/projects/{project}/agent/runs/{runId}/minutes", new { })).Status);
            var sent = await owner.Post($"/api/v1/projects/{project}/agent/runs/{runId}/minutes", new { });
            Assert.True(sent.Ok, sent.ToString());
            Assert.True(sent.Data!["sent"]!.GetValue<int>() >= 1);
            Assert.Equal(HttpStatusCode.Conflict, (await owner.Post($"/api/v1/projects/{project}/agent/runs/{runId}/minutes", new { })).Status);   // not twice in a row
            var mail = (await owner.Get("/api/v1/dev/emails")).Data!.AsArray()
                .First(m => m!["subject"]!.GetValue<string>().StartsWith("MOM: Release call") && string.Equals(m["to"]!.GetValue<string>(), owner.Email, StringComparison.OrdinalIgnoreCase))!;
            Assert.Contains("Release moves to Friday - awaiting approval", mail["text"]!.GetValue<string>());
            Assert.Contains("Ravi: fine, I will update the plan today.", mail["text"]!.GetValue<string>());
        }
        finally { factory.Ai.Reset(); }
    }

    [Fact]
    public async Task The_bot_also_joins_calendar_calls_that_name_the_project_and_posts_the_agenda_in_the_meeting_language()
    {
        factory.Ai.Reset(); factory.Ai.Configured = true;
        factory.MeetingBot.Reset();
        try
        {
            var (owner, project, _, key) = await SetupAsync("Calendar Desk");
            await owner.CreateTaskAsync(project, "Bank certification", new { title = "Bank certification", priority = "High", dueDate = DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-2)) });
            await ConnectGoogleAsync(owner);
            Assert.True((await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true, liveBot = true, autoJoinCalendar = true, captionLanguage = "ta" })).Ok);
            var start = DateTime.UtcNow.AddMinutes(4);
            factory.GoogleCalendar.UpcomingEvents.Add(new { id = "evt_cal_1", status = "confirmed", summary = "Calendar Desk sync with the client",
                start = new { dateTime = start.ToString("o") }, end = new { dateTime = start.AddMinutes(30).ToString("o") }, hangoutLink = "https://meet.google.com/cal-desk-abc" });
            factory.GoogleCalendar.UpcomingEvents.Add(new { id = "evt_cal_2", status = "confirmed", summary = "Lunch",
                start = new { dateTime = start.ToString("o") }, end = new { dateTime = start.AddMinutes(30).ToString("o") }, hangoutLink = "https://meet.google.com/lunch-xyz-abc" });

            await TickAsync();
            var create = Assert.Single(factory.MeetingBot.Requests, r => r.Path == "/bots");
            Assert.Contains("cal-desk-abc", create.Body);
            Assert.Contains("Tamil", create.Body);
            Assert.Contains("agendaMessage", create.Body);
            Assert.Contains($"overdue {key}-", create.Body);
            factory.WithDb(db =>
            {
                var bot = db.AgentMeetingBots.IgnoreQueryFilters().Single(b => b.ProjectId == project);
                Assert.Equal("evt_cal_1", bot.CalendarEventId);
                Assert.Equal("Calendar Desk sync with the client", bot.Title);
                return 0;
            });
            await TickAsync();
            Assert.Single(factory.MeetingBot.Requests, r => r.Path == "/bots");   // once per call
        }
        finally { factory.Ai.Reset(); factory.MeetingBot.Reset(); factory.GoogleCalendar.UpcomingEvents.Clear(); }
    }

    [Fact]
    public async Task A_linked_Slack_channel_is_read_from_the_moment_it_is_linked()
    {
        factory.Ai.Reset(); factory.Ai.Configured = true;
        factory.Ai.Answer = (_, _) => """{"summary":"Settlement is blocked.","findings":[]}""";
        try
        {
            var (owner, project, _, _) = await SetupAsync("Slack Desk");
            Assert.True((await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true })).Ok);
            Assert.Equal(HttpStatusCode.Conflict, (await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true, slackChannelId = "C0PAYMENTS1" })).Status);
            using (var scope = factory.Services.CreateScope())
            {
                var token = scope.ServiceProvider.GetRequiredService<ISecretProtector>().Protect("xoxb-test-slack-desk");
                factory.WithDb(db =>
                {
                    db.SlackConnections.Add(new SlackConnection { TenantId = owner.WorkspaceId, TeamId = "T" + Guid.NewGuid().ToString("N")[..10].ToUpperInvariant(), TeamName = "Desk",
                        AppId = "A_TEST", BotUserId = "B_TEST", BotTokenProtected = token, Scopes = SlackConnectionService.Scopes + ",channels:history", InstalledBy = owner.UserId,
                        ConnectedAt = DateTime.UtcNow, Active = true });
                    db.SaveChanges();
                    return 0;
                });
            }
            Assert.True((await owner.Get($"/api/v1/projects/{project}/agent")).Data!["slackAvailable"]!.GetValue<bool>());
            Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true, slackChannelId = "#general" })).Status);
            Assert.True((await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true, slackChannelId = "c0payments1" })).Ok);

            await TickAsync();   // linked: from now on
            var linkedAt = factory.WithDb(db => db.ProjectAgentSettings.IgnoreQueryFilters().Single(s => s.ProjectId == project).SlackReadUntil);
            Assert.NotNull(linkedAt);
            var at = decimal.Parse(linkedAt!, System.Globalization.CultureInfo.InvariantCulture);
            string Ts(int s) => (at + s).ToString("0.000000", System.Globalization.CultureInfo.InvariantCulture);
            factory.Slack.History.Clear();
            factory.Slack.History.Enqueue((Ts(-60), "U1", "an old message from before the link"));
            factory.Slack.History.Enqueue((Ts(30), "U1", "The settlement report is blocked on the <https://bank.example/f|bank files>"));
            factory.Slack.History.Enqueue((Ts(40), "U2", "I will chase the bank today"));
            await TickAsync();
            factory.WithDb(db =>
            {
                var signal = db.AgentSignals.IgnoreQueryFilters().Single(s => s.ProjectId == project && s.Source == AgentSourceKind.Slack);
                Assert.StartsWith("Slack ·", signal.Title);
                Assert.Equal(Ts(40), db.ProjectAgentSettings.IgnoreQueryFilters().Single(s => s.ProjectId == project).SlackReadUntil);
                return 0;
            });
            Assert.True((await owner.Post($"/api/v1/projects/{project}/agent/run", new { })).Ok);
            Assert.Contains(factory.Ai.Prompts, p => p.User.Contains("SLACK CHANNEL") && p.User.Contains("Ravi Kumar: The settlement report is blocked on the bank files")
                && p.User.Contains("Priya: I will chase the bank today") && !p.User.Contains("an old message"));
        }
        finally { factory.Ai.Reset(); factory.Slack.History.Clear(); }
    }

    private const string WaSecret = "fake-whatsapp-agent-app-secret-01";
    private WhatsAppOptions Wa => factory.Services.GetRequiredService<IOptions<WhatsAppOptions>>().Value;

    private async Task<HttpResponseMessage> WhatsAppAsync(WhatsAppConnection c, string text, string sender = "919876543210")
    {
        var items = new[] { new { id = "wamid." + Guid.NewGuid(), type = "text", timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(), from = sender, text = new { body = text } } };
        var body = JsonSerializer.Serialize(new { @object = "whatsapp_business_account", entry = new[] { new { id = c.BusinessAccountId, changes = new[] { new { field = "messages",
            value = new { messaging_product = "whatsapp", metadata = new { phone_number_id = c.PhoneNumberId }, messages = items } } } } } });
        using var client = factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/integrations/whatsapp/webhook") { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        request.Headers.Add("X-Hub-Signature-256", "sha256=" + Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(WaSecret), Encoding.UTF8.GetBytes(body))));
        return await client.SendAsync(request);
    }

    [Fact]
    public async Task A_WhatsApp_text_to_a_project_key_from_a_verified_member_reaches_the_agent_only_when_allowed()
    {
        Wa.AppId = "123456789"; Wa.AppSecret = WaSecret; Wa.VerifyToken = "fake-agent-verify-token-0123"; Wa.WebhookReceptionEnabled = true; Wa.ContactLinkingEnabled = true;
        factory.Ai.Reset(); factory.Ai.Configured = true;
        try
        {
            var owner = await TestClient.RegisterAsync(factory, "Wa Owner");
            await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
            var project = await owner.CreateProjectAsync("Wa Desk");
            var key = factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == project).Key);
            Assert.True((await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true })).Ok);
            string token;
            using (var scope = factory.Services.CreateScope()) token = scope.ServiceProvider.GetRequiredService<ISecretProtector>().Protect("fake-token");
            var c = factory.WithDb(db =>
            {
                db.TenantFeatureOverrides.Add(new() { TenantId = owner.WorkspaceId, FeatureKey = FeatureKeys.WhatsAppIntegration, Value = 1 });
                var conn = new WhatsAppConnection { TenantId = owner.WorkspaceId, AppId = "123456789", BusinessAccountId = Random.Shared.NextInt64(1000000000, 9999999999).ToString(),
                    PhoneNumberId = Random.Shared.NextInt64(1000000000, 9999999999).ToString(), DisplayName = "Fixture business", InstalledBy = owner.UserId,
                    ConnectedAt = DateTime.UtcNow.AddMinutes(-2), Active = true, AccessTokenProtected = token };
                db.WhatsAppConnections.Add(conn); db.SaveChanges(); return conn;
            });
            var link = await owner.Post("/api/v1/me/whatsapp-contact", new { phone = "+919876543210", acknowledged = true });
            Assert.True(link.Ok, link.ToString());
            using (var proof = await WhatsAppAsync(c, link.Data!["message"]!.GetValue<string>())) Assert.Equal(HttpStatusCode.OK, proof.StatusCode);

            // Off by default: the text is discarded like any other.
            using (var off = await WhatsAppAsync(c, $"{key}: refunds are blocked since Monday")) Assert.Equal(HttpStatusCode.OK, off.StatusCode);
            Assert.Equal(0, factory.WithDb(db => db.AgentSignals.IgnoreQueryFilters().Count(s => s.ProjectId == project && s.Source == AgentSourceKind.WhatsApp)));

            Wa.AgentMessagesEnabled = true;
            Assert.True((await owner.Get($"/api/v1/projects/{project}/agent")).Data!["whatsAppAvailable"]!.GetValue<bool>());
            using (var on = await WhatsAppAsync(c, $"{key}: refunds are blocked since Monday, need the bank file")) Assert.Equal(HttpStatusCode.OK, on.StatusCode);
            using (var other = await WhatsAppAsync(c, $"{key}: from a number nobody verified", "919999999999")) Assert.Equal(HttpStatusCode.OK, other.StatusCode);
            using (var plain = await WhatsAppAsync(c, "good morning everyone")) Assert.Equal(HttpStatusCode.OK, plain.StatusCode);
            factory.WithDb(db =>
            {
                var signal = db.AgentSignals.IgnoreQueryFilters().Single(s => s.ProjectId == project && s.Source == AgentSourceKind.WhatsApp);
                Assert.Equal("Wa Owner", signal.FromName);
                Assert.DoesNotContain("refunds", signal.ContentProtected);   // encrypted
                return 0;
            });
        }
        finally
        {
            Wa.AppId = null; Wa.AppSecret = null; Wa.VerifyToken = null; Wa.WebhookReceptionEnabled = false; Wa.ContactLinkingEnabled = false; Wa.AgentMessagesEnabled = false;
            factory.Ai.Reset();
        }
    }

    [Fact]
    public async Task What_was_read_is_erased_after_the_retention_period()
    {
        factory.Ai.Reset(); factory.Ai.Configured = true;
        factory.Ai.Answer = (_, _) => """{"summary":"ok","findings":[]}""";
        try
        {
            var (owner, project, _, _) = await SetupAsync("Retention Desk");
            Assert.True((await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true })).Ok);
            Assert.Equal(HttpStatusCode.Created, (await owner.Post($"/api/v1/projects/{project}/agent/transcript", new { title = "Old stand-up", text = "Ravi: the settlement report is late again, the bank has not sent the files." })).Status);
            factory.WithDb(db =>
            {
                var s = db.AgentSignals.IgnoreQueryFilters().Single(x => x.ProjectId == project);
                Assert.NotNull(s.ProcessedAt);
                s.ProcessedAt = DateTime.UtcNow.AddDays(-40);
                db.SaveChanges();
                return 0;
            });
            using (var scope = factory.Services.CreateScope())
                Assert.True(await AgentSignalService.PurgeAsync(scope.ServiceProvider.GetRequiredService<IAppDbContext>(), DateTime.UtcNow, 30, default) >= 1);
            factory.WithDb(db =>
            {
                var s = db.AgentSignals.IgnoreQueryFilters().Single(x => x.ProjectId == project);
                Assert.Equal("", s.ContentProtected);
                Assert.Equal("Old stand-up", s.Title);
                return 0;
            });
        }
        finally { factory.Ai.Reset(); }
    }

    [Fact]
    public async Task A_failed_deploy_alerts_the_platform_administrators_once()
    {
        Assert.Null(DeployAlertService.Parse("""{"type":"DEPLOY","status":"SUCCESS","service":{"name":"API"}}"""));
        var crashed = DeployAlertService.Parse("""{"type":"Deployment.crashed","resource":{"service":{"name":"MeetBot"},"environment":{"name":"production"}}}""");
        Assert.Equal("MeetBot", crashed!.Service);
        Assert.Equal("CRASHED", crashed.Status);

        using var anon = factory.CreateClient();
        Assert.Equal(HttpStatusCode.NotFound, (await anon.PostAsync("/api/v1/inbound/deploy/wrong-token-wrong-token-0000", new StringContent("{}"))).StatusCode);
        const string url = "/api/v1/inbound/deploy/test-deploy-webhook-token-0123456789";
        var ok = await anon.PostAsync(url, new StringContent("""{"type":"DEPLOY","status":"SUCCESS","service":{"name":"API"}}"""));
        Assert.False((await ok.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("data").GetProperty("alerted").GetBoolean());
        var name = "Svc" + Guid.NewGuid().ToString("N")[..6];
        var failed = await anon.PostAsync(url, new StringContent(JsonSerializer.Serialize(new { type = "DEPLOY", status = "FAILED", service = new { name }, environment = new { name = "production" } })));
        Assert.Equal(HttpStatusCode.OK, failed.StatusCode);
        Assert.True((await failed.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("data").GetProperty("alerted").GetBoolean());
        var again = await anon.PostAsync(url, new StringContent(JsonSerializer.Serialize(new { type = "DEPLOY", status = "FAILED", service = new { name } })));
        Assert.False((await again.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("data").GetProperty("alerted").GetBoolean());
    }
}
