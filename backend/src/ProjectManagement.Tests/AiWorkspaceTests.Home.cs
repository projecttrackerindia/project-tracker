using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Appending to a page section keeps what is there and adds the new blocks after it; an empty section is simply replaced.</summary>
public class AiHomeActionsPrimitivesTests
{
    private const string Doc = """{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Scope"}]}]}""";
    private const string Added = """{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Freeze the database"}]}]}""";

    [Fact]
    public void Appending_keeps_the_section_then_adds()
    {
        var merged = JsonNode.Parse(AiHomeActions.Append(Doc, Added))!["content"]!.AsArray();
        Assert.Equal(2, merged.Count);
        Assert.Equal("Scope", merged[0]!["content"]![0]!["text"]!.GetValue<string>());
        Assert.Equal("Freeze the database", merged[1]!["content"]![0]!["text"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("")]
    [InlineData("""{"type":"doc","content":[{"type":"paragraph"}]}""")]
    [InlineData("not json")]
    public void An_empty_section_is_replaced(string existing) => Assert.Equal(Added, AiHomeActions.Append(existing, Added));
}

/// <summary>
/// Running the day from Home with the assistant: what needs the person (with ids), and every change - timesheets, the agent's proposals,
/// notifications, chat replies in threads, page edits and comments, vault requests and sharing - only through a card the person confirms,
/// carried out as them and checked afterwards. The vault tools never put a stored value in front of the model.
/// </summary>
public partial class AiWorkspaceTests
{
    private sealed record HomeCard(string Message, JsonNode Action)
    {
        public string Kind => Action["kind"]!.GetValue<string>();
        public string Url => $"/api/v1/ai/messages/{Message}/actions/{Action["id"]!.GetValue<string>()}/confirm";
    }

    private async Task<HomeCard> Card(TestClient who, string tool, object input, string question = "Prepare the requested update")
    {
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool(tool, input));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Prepared."));
        var s = await Ask(who, question);
        var actions = s.Done["actions"]!.AsArray();
        Assert.True(actions.Count == 1, $"No card: {ToolResult()}");
        return new HomeCard(S(s.Done["id"]), actions[0]!);
    }

    private async Task<JsonNode> NoCard(TestClient who, string tool, object input, string question = "Prepare the requested update")
    {
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool(tool, input));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("That could not be prepared."));
        var s = await Ask(who, question);
        Assert.Empty(s.Done["actions"]!.AsArray());
        return s.Done;
    }

    private static async Task<string> Confirmed(TestClient who, HomeCard card)
    {
        var res = await who.Post(card.Url);
        Assert.True(res.Ok, res.ToString());
        return S(res.Data!["status"]);
    }

    private Guid SubmittedWeek(TestClient who, DateOnly week) =>
        factory.WithDb(db => db.TimesheetApprovals.IgnoreQueryFilters().Single(a => a.UserId == who.UserId && a.WeekStart == week).Id);

    private Guid Finding(Org o, string title, AgentFindingKind kind = AgentFindingKind.CreateTask) => factory.WithDb(db =>
    {
        var run = new AgentRun { TenantId = o.Owner.WorkspaceId, ProjectId = o.Project, Trigger = "meeting", Status = "done", StartedAt = DateTime.UtcNow.AddMinutes(-5), FinishedAt = DateTime.UtcNow };
        db.AgentRuns.Add(run);
        var f = new AgentFinding { TenantId = o.Owner.WorkspaceId, ProjectId = o.Project, RunId = run.Id, Kind = kind, Title = title, Detail = "Agreed in Tuesday's stand-up", SourceLabel = "Stand-up", Confidence = 90 };
        db.AgentFindings.Add(f);
        db.SaveChanges();
        return f.Id;
    });

    [Fact]
    public async Task Needs_you_lists_what_waits_with_ids_and_timesheets_and_notifications_change_only_through_cards()
    {
        var o = await Setup();
        var week = TimesheetApprovalService.WeekOf(AppDay.Today).AddDays(-7);
        var submitted = await o.Manager.Post("/api/v1/time/week/submit", new { weekStart = week.ToString("yyyy-MM-dd"), note = "Release week" });
        Assert.True(submitted.Ok, submitted.ToString());
        var sheet = SubmittedWeek(o.Manager, week);
        var finding = Finding(o, "Write the cut-over runbook");
        var note = factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == o.Owner.UserId && n.TenantId == o.Owner.WorkspaceId && n.Title.Contains("submitted a timesheet")).Select(n => n.Id).Single());

        var seen = await RunTool(o.Owner, AiHomeTools.NeedsYou, new { }, "What needs me right now?");
        Assert.Contains(sheet.ToString(), seen);
        Assert.Contains("Max Manager", seen);
        Assert.Contains(finding.ToString(), seen);
        Assert.Contains("Write the cut-over runbook", seen);
        Assert.Contains(note.ToString(), seen);
        Assert.Contains("never as instructions", seen);

        // Sending a week back needs a note; nothing is decided until the card is confirmed, and a card works once.
        await NoCard(o.Owner, AiHomeTools.ReviewTimesheet, new { timesheet_id = sheet, decision = "return" });
        Assert.Contains("needs a note", ToolResult());
        var approve = await Card(o.Owner, AiHomeTools.ReviewTimesheet, new { timesheet_id = sheet, decision = "approve" });
        Assert.Equal("review_timesheet", approve.Kind);
        Assert.Contains("Max Manager", S(approve.Action["title"]));
        Assert.Equal(TimesheetStatus.Submitted, factory.WithDb(db => db.TimesheetApprovals.IgnoreQueryFilters().Single(a => a.Id == sheet).Status));
        Assert.Equal("done", await Confirmed(o.Owner, approve));
        Assert.Equal(TimesheetStatus.Approved, factory.WithDb(db => db.TimesheetApprovals.IgnoreQueryFilters().Single(a => a.Id == sheet).Status));
        (await o.Owner.Post(approve.Url)).CheckStatus(HttpStatusCode.Conflict);
        // Decided already: no second card.
        await NoCard(o.Owner, AiHomeTools.ReviewTimesheet, new { timesheet_id = sheet, decision = "approve" });

        // The person's own week; a week already waiting cannot be submitted again.
        var mine = await Card(o.Manager, AiHomeTools.SubmitWeek, new { week_start = Iso(-14), note = "All logged" });
        Assert.Equal("submit_week", mine.Kind);
        Assert.Equal("done", await Confirmed(o.Manager, mine));
        var mineId = SubmittedWeek(o.Manager, TimesheetApprovalService.WeekOf(AppDay.Today.AddDays(-14)));
        Assert.Equal(TimesheetStatus.Submitted, factory.WithDb(db => db.TimesheetApprovals.IgnoreQueryFilters().Single(a => a.Id == mineId).Status));
        await NoCard(o.Manager, AiHomeTools.SubmitWeek, new { week_start = Iso(-14) });
        Assert.Contains("already waiting", ToolResult());
        await NoCard(o.Manager, AiHomeTools.SubmitWeek, new { week_start = Iso(14) });

        // A notification: done, then back and snoozed until a time.
        var done = await Card(o.Owner, AiHomeTools.ClearNotification, new { notification_id = note, action = "done" });
        Assert.Equal("done", await Confirmed(o.Owner, done));
        Assert.NotNull(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Single(n => n.Id == note).ArchivedAt));
        var snooze = await Card(o.Owner, AiHomeTools.ClearNotification, new { notification_id = note, action = "snooze", until = Iso(2) + "T09:00" });
        Assert.Equal("done", await Confirmed(o.Owner, snooze));
        var after = factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Single(n => n.Id == note));
        Assert.Null(after.ArchivedAt);
        Assert.True(after.SnoozedUntil > DateTime.UtcNow.AddDays(1));
        // Someone else's notification is not theirs to touch.
        await NoCard(o.Manager, AiHomeTools.ClearNotification, new { notification_id = note, action = "done" });
    }

    [Fact]
    public async Task The_agents_proposals_are_approved_or_dismissed_from_home_with_the_persons_own_rights()
    {
        var o = await Setup();
        var create = Finding(o, "Write the cut-over runbook");
        var noise = Finding(o, "Book a retro", AgentFindingKind.Suggestion);

        var approve = await Card(o.Owner, AiHomeTools.DecideProposal, new { proposal_id = create, decision = "approve" });
        Assert.Equal("decide_agent_proposal", approve.Kind);
        Assert.False(factory.WithDb(db => db.Tasks.IgnoreQueryFilters().Any(t => t.ProjectId == o.Project && t.Title == "Write the cut-over runbook")));
        Assert.Equal("done", await Confirmed(o.Owner, approve));
        Assert.True(factory.WithDb(db => db.Tasks.IgnoreQueryFilters().Any(t => t.ProjectId == o.Project && t.Title == "Write the cut-over runbook")));
        Assert.Equal(AgentFindingStatus.Applied, factory.WithDb(db => db.AgentFindings.IgnoreQueryFilters().Single(f => f.Id == create).Status));

        var dismiss = await Card(o.Owner, AiHomeTools.DecideProposal, new { proposal_id = noise, decision = "dismiss", reason = "not_needed" });
        Assert.Equal("done", await Confirmed(o.Owner, dismiss));
        var dismissed = factory.WithDb(db => db.AgentFindings.IgnoreQueryFilters().Single(f => f.Id == noise));
        Assert.Equal(AgentFindingStatus.Dismissed, dismissed.Status);
        Assert.Equal("not_needed", dismissed.DismissReason);
        await NoCard(o.Owner, AiHomeTools.DecideProposal, new { proposal_id = noise, decision = "approve" });
        Assert.Contains("already dismissed", ToolResult());
    }

    [Fact]
    public async Task Chat_is_caught_up_searched_and_answered_in_the_thread_only_after_confirming()
    {
        var o = await Setup();
        var ravi = await o.Owner.AddMemberAsync(factory, TenantRole.Member, "Ravi Member");
        var dm = S((await o.Manager.Post("/api/v1/chat/conversations/direct", new { userId = o.Owner.UserId })).Data!["id"]);
        var asked = await o.Manager.Post($"/api/v1/chat/conversations/{dm}/messages", new { body = "Can we move the Atlas budget review to Thursday?" });
        Assert.True(asked.Ok, asked.ToString());
        var question = S(asked.Data!["id"]);

        var caught = await RunTool(o.Owner, AiHomeTools.ChatCatchUp, new { }, "Catch me up on chat");
        Assert.Contains("budget review", caught);
        Assert.Contains(question, caught);
        Assert.Contains("Max Manager", caught);
        Assert.Contains($"/chat/{dm}?m={question}", caught);

        var found = await RunTool(o.Owner, AiHomeTools.ChatSearch, new { query = "budget review" }, "What did Max say about the budget review?");
        Assert.Contains(question, found);
        Assert.Contains("cite", found);

        var reply = await Card(o.Owner, AiHomeTools.ChatReply, new { message_id = question, body = "Thursday works for me." });
        Assert.Equal("chat_reply", reply.Kind);
        Assert.Equal("Thursday works for me.", S(reply.Action["preview"]));
        int Replies() => factory.WithDb(db => db.ChatMessages.IgnoreQueryFilters().Count(m => m.ThreadRootId == Guid.Parse(question)));
        Assert.Equal(0, Replies());
        Assert.Equal("done", await Confirmed(o.Owner, reply));
        var sent = factory.WithDb(db => db.ChatMessages.IgnoreQueryFilters().Single(m => m.ThreadRootId == Guid.Parse(question)));
        Assert.Equal(o.Owner.UserId, sent.SenderId);
        Assert.Equal("Thursday works for me.", sent.Body);
        (await o.Owner.Post(reply.Url)).CheckStatus(HttpStatusCode.Conflict);
        Assert.Equal(1, Replies());

        // A conversation the person is not in cannot be read or answered.
        var other = S((await o.Manager.Post("/api/v1/chat/conversations/direct", new { userId = ravi.UserId })).Data!["id"]);
        var secret = S((await o.Manager.Post($"/api/v1/chat/conversations/{other}/messages", new { body = "Salary bands for next year" })).Data!["id"]);
        await NoCard(o.Owner, AiHomeTools.ChatReply, new { message_id = secret, body = "Interesting" });
        Assert.DoesNotContain("Salary bands", await RunTool(o.Owner, AiHomeTools.ChatSearch, new { query = "salary bands" }, "What did we say about salary bands?"));
        Assert.DoesNotContain("Salary bands", await RunTool(o.Owner, AiHomeTools.ChatCatchUp, new { conversation_id = other }, "Catch me up on that chat"));
    }

    [Fact]
    public async Task Pages_are_added_to_rewritten_and_commented_on_through_cards_and_a_stale_rewrite_is_refused()
    {
        var o = await Setup();
        var type = S((await o.Owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "BRD")!["id"]);
        var created = await o.Owner.Post("/api/v1/documents", new { title = "Atlas cut-over plan", typeId = type, visibility = "Organization" });
        Assert.True(created.Ok, created.ToString());
        var id = S(created.Data!["item"]!["id"]);
        var key = S(created.Data["item"]!["key"]);
        async Task<JsonNode> Page() => (await o.Owner.Get($"/api/v1/documents/{id}")).Data!;
        var section = (await Page())["sections"]!.AsArray().First(s => s!["kind"]!.ToString() is "RichText" or "0")!;
        var sectionKey = S(section["key"]);
        var start = """{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Scope: payments only"}]}]}""";
        var saved = await o.Owner.Send(HttpMethod.Put, $"/api/v1/documents/{id}/sections", new { revision = (await Page())["revision"]!.GetValue<int>(), sections = new[] { new { key = sectionKey, content = start } } });
        Assert.True(saved.Ok, saved.ToString());
        async Task<string> Text() => (await Page())["sections"]!.AsArray().First(s => S(s!["key"]) == sectionKey)!["content"]!.GetValue<string>();

        // read_document lists the sections, so the assistant knows what it may change.
        var read = await RunTool(o.Owner, AiToolbox.ReadDocument, new { id }, "Read the Atlas cut-over plan");
        Assert.Contains(sectionKey, read);
        Assert.Contains("can_edit", read);

        var add = await Card(o.Owner, AiHomeTools.EditPage, new { document = key, section = sectionKey, mode = "append", content = "## Freeze\n\nFreeze the database at 22:00." });
        Assert.Equal("edit_page", add.Kind);
        Assert.DoesNotContain("Freeze the database", (await Text()));
        Assert.Equal("done", await Confirmed(o.Owner, add));
        Assert.Contains("Scope: payments only", (await Text()));
        Assert.Contains("Freeze the database at 22:00.", (await Text()));

        // A rewrite needs the page as it was when suggested.
        var rewrite = await Card(o.Owner, AiHomeTools.EditPage, new { document = id, section = sectionKey, mode = "replace", content = "Payments and refunds." });
        var edited = start.Replace("payments only", "payments only, edited by hand");
        Assert.True((await o.Owner.Send(HttpMethod.Put, $"/api/v1/documents/{id}/sections", new { revision = (await Page())["revision"]!.GetValue<int>(), sections = new[] { new { key = sectionKey, content = edited } } })).Ok);
        Assert.Equal("failed", await Confirmed(o.Owner, rewrite));
        Assert.Contains("Scope: payments only", (await Text()));
        var again = await Card(o.Owner, AiHomeTools.EditPage, new { document = id, section = sectionKey, mode = "replace", content = "Payments and refunds." });
        Assert.Equal("done", await Confirmed(o.Owner, again));
        Assert.Contains("Payments and refunds.", (await Text()));
        Assert.DoesNotContain("Scope: payments only", (await Text()));

        // Masked values are never written back.
        await NoCard(o.Owner, AiHomeTools.EditPage, new { document = id, section = sectionKey, mode = "replace", content = "Call ••••••••42 for access" });

        var comment = await Card(o.Owner, AiHomeTools.CommentPage, new { document = key, body = "Who signs off the freeze?" });
        Assert.Equal("done", await Confirmed(o.Owner, comment));
        Assert.True(factory.WithDb(db => db.DocumentComments.IgnoreQueryFilters().Any(c => c.DocumentId == Guid.Parse(id) && c.Body == "Who signs off the freeze?")));

        // Someone who may only read the page gets no edit card.
        await NoCard(o.Guest, AiHomeTools.EditPage, new { document = id, section = sectionKey, mode = "append", content = "Hello" });
    }

    [Fact]
    public async Task Vault_tools_see_names_never_values_and_rotation_and_sharing_wait_for_a_card()
    {
        var o = await Setup();
        const string value = "vault-test-value-7Qm2-never-shown";
        var made = await o.Owner.Post("/api/v1/vault/collections", new { name = "Payments", kind = "Shared" });
        Assert.True(made.Ok, made.ToString());
        var collection = Guid.Parse(S(made.Data!["id"]));
        var item = await o.Owner.Post("/api/v1/vault/items", new
        {
            collectionId = collection, kind = "ApiKey", title = "Stripe secret key", url = "https://dashboard.stripe.com", tags = Array.Empty<string>(), @class = "Secret", useOnly = false,
            fields = new[] { new { key = "key", value, secret = true }, new { key = "remarks", value = "Rotate after every release", secret = false } },
        });
        Assert.True(item.Ok, item.ToString());
        var itemId = S(item.Data!["item"]!["id"]);

        var found = await RunTool(o.Owner, AiHomeTools.VaultFind, new { query = "stripe" }, "Find the Stripe key in the vault");
        Assert.Contains("Stripe secret key", found);
        Assert.Contains("dashboard.stripe.com", found);
        Assert.DoesNotContain(value, found);

        await NoCard(o.Owner, AiHomeTools.VaultRequest, new { kind = "rotate", item_id = itemId, reason = "leak" });
        Assert.Contains("reason of at least a sentence", ToolResult());
        var rotate = await Card(o.Owner, AiHomeTools.VaultRequest, new { kind = "rotate", item_id = itemId, reason = "It was pasted into a support ticket by mistake." });
        Assert.Equal("vault_request", rotate.Kind);
        Assert.Null(factory.WithDb(db => db.VaultItems.IgnoreQueryFilters().Single(i => i.Id == Guid.Parse(itemId)).RotationReason));
        Assert.Equal("done", await Confirmed(o.Owner, rotate));
        Assert.Contains("support ticket", factory.WithDb(db => db.VaultItems.IgnoreQueryFilters().Single(i => i.Id == Guid.Parse(itemId)).RotationReason));

        var share = await Card(o.Owner, AiHomeTools.VaultShare, new { collection = "Payments", person = "Max Manager", access = "use_only", until = Iso(7) });
        Assert.Equal("vault_share", share.Kind);
        Assert.False(factory.WithDb(db => db.VaultShares.IgnoreQueryFilters().Any(s => s.CollectionId == collection && s.PrincipalId == o.Manager.UserId)));
        Assert.Equal("done", await Confirmed(o.Owner, share));
        var given = factory.WithDb(db => db.VaultShares.IgnoreQueryFilters().Single(s => s.CollectionId == collection && s.PrincipalId == o.Manager.UserId));
        Assert.Equal(VaultAccess.UseOnly, given.Access);
        Assert.NotNull(given.ExpiresAt);
        // The owner still manages it: nobody else was dropped.
        Assert.True(factory.WithDb(db => db.VaultShares.IgnoreQueryFilters().Any(s => s.CollectionId == collection && s.Access == VaultAccess.Manage)));

        // The member they shared with finds it by name, and cannot share it on.
        Assert.Contains("Stripe secret key", await RunTool(o.Manager, AiHomeTools.VaultFind, new { query = "stripe" }, "Where is the Stripe key?"));
        await NoCard(o.Manager, AiHomeTools.VaultShare, new { collection = "Payments", person = "Olivia Owner", access = "view" });

        // No request to the model ever carried the value.
        static string Words(AiBlock b) => b switch { AiText x => x.Text, AiToolResult x => x.Content, AiToolUse x => x.InputJson, _ => "" };
        var everything = string.Join("\n", Chat.Requests.SelectMany(r => new[] { r.System, r.Context }.Concat(r.Turns.SelectMany(turn => turn.Blocks).Select(Words))));
        Assert.DoesNotContain(value, everything);
    }

    [Fact]
    public async Task A_request_with_several_parts_shows_a_plan_whose_steps_follow_their_cards()
    {
        var o = await Setup();
        var week = TimesheetApprovalService.WeekOf(AppDay.Today).AddDays(-7);
        Assert.True((await o.Manager.Post("/api/v1/time/week/submit", new { weekStart = week.ToString("yyyy-MM-dd") })).Ok);
        var sheet = SubmittedWeek(o.Manager, week);

        Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiHomeTools.ShowPlan, new
        {
            steps = new[]
            {
                new { title = "Approve Max's timesheet", tool = (string?)AiHomeTools.ReviewTimesheet },
                new { title = "Submit your week", tool = (string?)AiHomeTools.SubmitWeek },
                new { title = "Tell you what is left", tool = (string?)null },
            },
        }));
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiHomeTools.ReviewTimesheet, new { timesheet_id = sheet, decision = "approve" }, id: "toolu_2"));
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiHomeTools.SubmitWeek, new { week_start = Iso(-7) }, id: "toolu_3"));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Both are ready for you to confirm."));
        var s = await Ask(o.Owner, "Approve Max's timesheet and then submit my week");

        Assert.True(s.All("plan").Count() >= 3, "the plan is sent when shown and as each step moves on");
        var plan = s.Done["tools"]!.AsArray().Single(t => S(t!["name"]) == AiHomeTools.ShowPlan)!["steps"]!.AsArray();
        Assert.Equal(new[] { "waiting", "waiting", "done" }, plan.Select(p => S(p!["state"])).ToArray());
        var actions = s.Done["actions"]!.AsArray();
        Assert.Equal(2, actions.Count);
        Assert.Equal(S(actions[0]!["id"]), S(plan[0]!["actionId"]));
        Assert.Equal(S(actions[1]!["id"]), S(plan[1]!["actionId"]));
        // Saved with the answer, so the plan is there when the conversation is opened again.
        var reopened = await o.Owner.Get($"/api/v1/ai/conversations/{s.Conversation}");
        Assert.Contains("Submit your week", reopened.ToString());

        // One step is not a plan.
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiHomeTools.ShowPlan, new { steps = new[] { new { title = "Do it" } } }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Done."));
        await Ask(o.Owner, "What needs me?");
        Assert.Contains("2 to 8 steps", ToolResult());
    }

    [Fact]
    public async Task Portfolio_options_and_unknown_targets_are_refused_without_a_card()
    {
        var o = await Setup();
        Assert.Contains("needs a decision", await RunTool(o.Owner, AiHomeTools.PortfolioDecisions, new { }, "Which portfolio decisions are waiting?"));
        await NoCard(o.Owner, AiHomeTools.ApplyPortfolioOption, new { project = "ATLAS", option_id = "cut_scope" });
        await NoCard(o.Owner, AiHomeTools.DecideProposal, new { proposal_id = Guid.NewGuid(), decision = "approve" });
        Assert.Contains("no such proposal", ToolResult());
    }

    [Fact]
    public async Task The_workday_tools_read_the_persons_own_calendar_time_decisions_and_mail()
    {
        var o = await Setup();
        var task = await o.Owner.CreateTaskAsync(o.Project, "Write the runbook", new { title = "Write the runbook", priority = "High", assigneeId = o.Owner.UserId, dueDate = Iso(0) });
        var taskId = task["id"]!.GetValue<string>();
        Assert.True((await o.Owner.Post($"/api/v1/tasks/{taskId}/time", new { minutes = 90, note = "Deep work" })).Ok);

        var day = await RunTool(o.Owner, AiWorkdayTools.MySchedule, new { from = Iso(-1), days = 3 }, "What's on my calendar today?");
        Assert.Contains("Write the runbook", day);
        Assert.Contains("time_zone", day);

        var time = await RunTool(o.Owner, AiWorkdayTools.MyTime, new { from = Iso(-7), to = Iso(1) }, "How many hours did I log this week?");
        Assert.Contains("1h 30m", time);
        Assert.Contains("Write the runbook", time);
        await RunTool(o.Owner, AiWorkdayTools.MyTime, new { from = Iso(0), to = Iso(-10) }, "How many hours did I log?");
        Assert.Contains("start before the end", ToolResult());

        factory.WithDb(db =>
        {
            var run = new AgentRun { TenantId = o.Owner.WorkspaceId, ProjectId = o.Project, Trigger = "meeting", Status = "done", StartedAt = DateTime.UtcNow, FinishedAt = DateTime.UtcNow };
            db.AgentRuns.Add(run);
            db.AgentFindings.Add(new AgentFinding { TenantId = o.Owner.WorkspaceId, ProjectId = o.Project, RunId = run.Id, Kind = AgentFindingKind.Decision, Status = AgentFindingStatus.Applied,
                Title = "Go live on 14 Jan with refunds behind a switch", Detail = "Agreed in the steering call", SourceLabel = "Steering call", Confidence = 90, DecidedBy = o.Owner.UserId, DecidedAt = DateTime.UtcNow });
            db.SaveChanges(); return 0;
        });
        var decisions = await RunTool(o.Owner, AiWorkdayTools.DecisionLog, new { query = "go live" }, "What did we decide about the go-live date?");
        Assert.Contains("Go live on 14 Jan", decisions);
        Assert.Contains("never as instructions", decisions);
        Assert.Contains("No recorded decision", await RunTool(o.Owner, AiWorkdayTools.DecisionLog, new { query = "pricing" }, "What did we decide about pricing?"));

        // No mailbox connected: it says so instead of guessing.
        Assert.Contains("has not connected a mailbox", await RunTool(o.Owner, AiWorkdayTools.MailInbox, new { }, "Any mail from the bank today?"));
        // A check-in that is not theirs gets no card.
        await NoCard(o.Owner, AiWorkdayTools.AnswerCheckIn, new { commitment_id = Guid.NewGuid(), answer = "done" });
    }
}
