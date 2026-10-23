using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using MimeKit;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Mailbox;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>A forwarded message: "Fwd:" subject, the note, the original's sender, date and text below it, and its attachments.</summary>
public class MailForwardMessageTests
{
    private static MimeMessage Original()
    {
        var m = new MimeMessage { Subject = "Invoice 4412 for October", MessageId = "abc@vendor.test", Date = new DateTimeOffset(2026, 10, 20, 9, 30, 0, TimeSpan.FromHours(5.5)) };
        m.From.Add(new MailboxAddress("Vendor Billing", "billing@vendor.test"));
        m.To.Add(new MailboxAddress("Olivia", "olivia@example.test"));
        var b = new BodyBuilder { TextBody = "Please find the invoice attached. Due in 15 days." };
        b.Attachments.Add("invoice-4412.pdf", "%PDF-1.4 fake"u8.ToArray(), new ContentType("application", "pdf"));
        m.Body = b.ToMessageBody();
        return m;
    }

    [Fact]
    public void The_forward_carries_the_note_the_original_and_its_attachments()
    {
        var to = new InternetAddressList { new MailboxAddress("", "finance@example.test") };
        var fwd = MailboxService.ForwardMessage(Original(), new MailboxAddress("Olivia", "olivia@example.test"), to, new InternetAddressList(), "For payment this week.");
        Assert.Equal("Fwd: Invoice 4412 for October", fwd.Subject);
        Assert.Equal("finance@example.test", fwd.To.Mailboxes.Single().Address);
        var text = fwd.TextBody!;
        Assert.StartsWith("For payment this week.", text);
        Assert.Contains("---------- Forwarded message ---------", text);
        Assert.Contains("billing@vendor.test", text);
        Assert.Contains("Please find the invoice attached.", text);
        var attachment = Assert.Single(fwd.Attachments.OfType<MimePart>());
        Assert.Equal("invoice-4412.pdf", attachment.FileName);
        Assert.Contains("abc@vendor.test", fwd.References);
    }

    [Fact]
    public void A_subject_that_is_already_a_forward_is_kept_and_no_note_is_fine()
    {
        var original = Original(); original.Subject = "Fwd: Invoice";
        var fwd = MailboxService.ForwardMessage(original, new MailboxAddress("", "o@example.test"), new InternetAddressList { new MailboxAddress("", "f@example.test") }, new InternetAddressList(), null);
        Assert.Equal("Fwd: Invoice", fwd.Subject);
        Assert.StartsWith("---------- Forwarded message", fwd.TextBody);
    }
}

/// <summary>Deleting work and forwarding mail from the assistant: always a card, checked against the person's own rights.</summary>
public partial class AiWorkspaceTests
{
    [Fact]
    public async Task Deleting_work_is_a_card_that_moves_it_to_the_bin_and_respects_who_may_delete()
    {
        var o = await Setup();
        var task = await o.Owner.CreateTaskAsync(o.Project, "Old spike notes");
        var key = S(task["key"]); var id = S(task["id"]);

        var card = await Card(o.Owner, AiToolbox.DeleteWork, new { key, reason = "duplicate" }, $"Delete {key}");
        Assert.Equal("delete_work", card.Kind);
        Assert.Contains(key, S(card.Action["title"]));
        Assert.Equal(HttpStatusCode.OK, (await o.Owner.Get($"/api/v1/tasks/{id}")).Status);   // nothing happens before Confirm
        var confirmed = await o.Owner.Post(card.Url);
        Assert.Equal("done", S(confirmed.Data!["status"]));
        Assert.NotNull(confirmed.Data["undoUntil"]);   // the card offers Undo for a few minutes
        Assert.Equal(HttpStatusCode.NotFound, (await o.Owner.Get($"/api/v1/tasks/{id}")).Status);

        // Undo brings it back from the bin; a second Undo is refused.
        var undo = await o.Owner.Post(card.Url.Replace("/confirm", "/undo"));
        Assert.True(undo.Ok, undo.ToString());
        Assert.Equal("undone", S(undo.Data!["status"]));
        Assert.Equal(HttpStatusCode.OK, (await o.Owner.Get($"/api/v1/tasks/{id}")).Status);
        Assert.Equal(HttpStatusCode.Conflict, (await o.Owner.Post(card.Url.Replace("/confirm", "/undo"))).Status);

        // A guest cannot delete tasks: no card is offered.
        var other = await o.Owner.CreateTaskAsync(o.Project, "Keep me");
        await NoCard(o.Guest, AiToolbox.DeleteWork, new { key = S(other["key"]) }, $"Delete {S(other["key"])}");
        // And a key that is not real is said so, without a card.
        await NoCard(o.Owner, AiToolbox.DeleteWork, new { key = "ATLAS-999" }, "Delete ATLAS-999");
        Assert.Contains("no task", ToolResult(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Starting_a_call_from_the_assistant_is_a_card_that_opens_our_own_call_for_the_project_people()
    {
        var o = await Setup();
        Assert.True((await o.Owner.Post($"/api/v1/projects/{o.Project}/members", new { userId = o.Manager.UserId })).Ok);

        var card = await Card(o.Owner, AiToolbox.StartCall, new { project = "Atlas", title = "Quick sync", with_agent = false }, "Start a call with the Atlas team");
        Assert.Equal("start_call", card.Kind);
        Assert.Contains("every project member notified", S(card.Action["summary"]));
        Assert.Empty((await o.Owner.Get("/api/v1/calls/live")).Data!.AsArray());   // nothing happens before Confirm

        var done = await o.Owner.Post(card.Url);
        Assert.Equal("done", S(done.Data!["status"]));
        var link = S(done.Data["link"]);
        Assert.StartsWith("/calls/", link);
        var call = (await o.Owner.Get($"/api/v1{link}")).Data!;
        Assert.Equal("Quick sync", S(call["title"]));
        Assert.Equal("project", S(call["kind"]));
        // Nobody was named, so the project's people are called; the manager sees it and can join.
        Assert.Contains(call["people"]!.AsArray(), p => S(p!["userId"]) == o.Manager.UserId.ToString());
        Assert.Contains((await o.Manager.Get("/api/v1/calls/live")).Data!.AsArray(), c => S(c!["id"]) == S(call["id"]));
        Assert.True((await o.Manager.Post($"/api/v1{link}/join")).Ok);
        Assert.Null(done.Data["undoUntil"]);   // a call that started cannot be taken back; it can be ended
    }

    [Fact]
    public async Task Forwarding_needs_a_connected_mailbox_and_a_real_recipient()
    {
        var o = await Setup();
        // A name that is not a member is asked about, never guessed.
        await NoCard(o.Owner, AiWorkdayTools.MailForward, new { account = "google", message_id = "abc123", to = "finance" }, "Forward the invoice mail to finance");
        Assert.Contains("could not find", ToolResult(), StringComparison.OrdinalIgnoreCase);
        // A real address but no Gmail connected: nothing to forward from.
        await NoCard(o.Owner, AiWorkdayTools.MailForward, new { account = "google", message_id = "abc123", to = "finance@example.test" }, "Forward the invoice mail to finance@example.test");
    }

    [Fact]
    public async Task Undo_takes_back_a_created_task_and_puts_back_earlier_values_but_not_after_the_window_or_for_sent_things()
    {
        var o = await Setup();
        // A task the assistant created goes away again.
        var create = await Card(o.Owner, "propose_create_task", new { project = "Atlas", title = "Draft the cut-over plan", assignee = "me" }, "Create a task in Atlas to draft the cut-over plan");
        var made = await o.Owner.Post(create.Url);
        Assert.Equal("done", S(made.Data!["status"]));
        var taskId = S(made.Data["resultId"]);
        Assert.True((await o.Owner.Post(create.Url.Replace("/confirm", "/undo"))).Ok);
        Assert.Equal(HttpStatusCode.NotFound, (await o.Owner.Get($"/api/v1/tasks/{taskId}")).Status);

        // A change gets its earlier values back.
        var task = await o.Owner.CreateTaskAsync(o.Project, "Renew the certificate");
        var update = await Card(o.Owner, "propose_update_work", new { key = S(task["key"]), priority = "Critical" }, $"Make {S(task["key"])} critical");
        Assert.Equal("done", await Confirmed(o.Owner, update));
        Assert.Equal("Critical", S((await o.Owner.Get($"/api/v1/tasks/{S(task["id"])}")).Data!["task"]!["priority"]));
        Assert.True((await o.Owner.Post(update.Url.Replace("/confirm", "/undo"))).Ok);
        Assert.Equal("Medium", S((await o.Owner.Get($"/api/v1/tasks/{S(task["id"])}")).Data!["task"]!["priority"]));

        // Somebody else cannot undo it; and once the window has passed, Undo is refused.
        var again = await Card(o.Owner, "propose_update_work", new { key = S(task["key"]), priority = "High" }, $"Make {S(task["key"])} high priority");
        Assert.Equal("done", await Confirmed(o.Owner, again));
        Assert.Equal(HttpStatusCode.NotFound, (await o.Manager.Post(again.Url.Replace("/confirm", "/undo"))).Status);
        factory.WithDb(db =>
        {
            var row = db.AiMessages.IgnoreQueryFilters().Single(m => m.Id == Guid.Parse(again.Message));
            row.ActionsJson = row.ActionsJson!.Replace(System.Text.RegularExpressions.Regex.Match(row.ActionsJson, "\"undoUntil\":\"[^\"]+\"").Value, "\"undoUntil\":\"2020-01-01T00:00:00Z\"");
            return db.SaveChanges();
        });
        Assert.Equal(HttpStatusCode.Conflict, (await o.Owner.Post(again.Url.Replace("/confirm", "/undo"))).Status);
    }

    [Fact]
    public async Task A_watch_is_a_card_then_fires_once_when_the_work_is_done_and_can_be_listed_and_stopped()
    {
        var o = await Setup();
        var task = await o.Owner.CreateTaskAsync(o.Project, "Ship the release notes");
        var key = S(task["key"]); var id = Guid.Parse(S(task["id"]));

        var card = await Card(o.Owner, AiToolbox.Watch, new { key, when = "done", note = "then email the client" }, $"Tell me when {key} is done");
        Assert.Equal("watch", card.Kind);
        Assert.Contains($"when {key} is done", S(card.Action["title"]));
        Assert.Equal("done", await Confirmed(o.Owner, card));
        var mine = (await o.Owner.Get("/api/v1/ai/watches")).Data!.AsArray();
        var watch = Assert.Single(mine)!;
        Assert.Equal("active", S(watch["state"]));
        Assert.Empty((await o.Manager.Get("/api/v1/ai/watches")).Data!.AsArray());   // private to the person

        async Task<int> Check() { using var scope = factory.Services.CreateScope(); return await scope.ServiceProvider.GetRequiredService<AiWatchService>().CheckAsync(force: true); }
        Assert.Equal(0, await Check());   // not done yet: nothing
        factory.WithDb(db =>
        {
            var t = db.Tasks.IgnoreQueryFilters().Single(x => x.Id == id);
            t.StatusId = db.WorkflowStatuses.IgnoreQueryFilters().First(s => s.ProjectId == t.ProjectId && s.Category == ProjectManagement.Domain.Enums.StatusCategory.Done).Id;
            return db.SaveChanges();
        });
        Assert.Equal(1, await Check());
        Assert.Equal(0, await Check());   // once only
        var fired = Assert.Single((await o.Owner.Get("/api/v1/ai/watches")).Data!.AsArray())!;
        Assert.Equal("fired", S(fired["state"]));
        Assert.Contains($"{key}", S(fired["outcome"]));
        Assert.True(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Any(n => n.UserId == o.Owner.UserId && n.Title.Contains(key) && n.Body!.Contains("then email the client"))));

        // A project that slips past a date; stopping a watch keeps it from firing.
        var slip = await Card(o.Owner, AiToolbox.Watch, new { project = "Atlas", when = "slips", date = Iso(30) }, "Warn me if Atlas slips past next month");
        Assert.Equal("done", await Confirmed(o.Owner, slip));
        var slipId = S((await o.Owner.Get("/api/v1/ai/watches")).Data!.AsArray().First(w => S(w!["state"]) == "active")!["id"]);
        Assert.Equal(HttpStatusCode.NoContent, (await o.Owner.Post($"/api/v1/ai/watches/{slipId}/stop")).Status);
        await o.Owner.CreateTaskAsync(o.Project, "Late extra work", new { title = "Late extra work", priority = "Medium", dueDate = Iso(60) });
        Assert.Equal(0, await Check());

        // Asking for a status the project does not have is answered, not guessed.
        var other = await o.Owner.CreateTaskAsync(o.Project, "Another");
        await NoCard(o.Owner, AiToolbox.Watch, new { key = S(other["key"]), when = "status", status = "Shipped to Mars" }, $"Tell me when {S(other["key"])} is shipped to Mars");
        Assert.Contains("has no status", ToolResult());
    }

    [Fact]
    public async Task Quality_counts_what_people_did_with_answers_by_area_and_keeps_scenario_gradings_numbers_only()
    {
        var o = await Setup();
        // An answer about work that missed (👎), then the same question asked again at once.
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool("find_work", new { overdue = true }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Nothing is late."));
        var first = await Ask(o.Owner, "Which tasks are late?");
        Assert.True((await o.Owner.Post($"/api/v1/ai/messages/{S(first.Done["id"])}/feedback", new { rating = "down", reason = "wrong" })).Ok);
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Let me look again."));
        await Ask(o.Owner, "Which tasks are overdue in Atlas?", conversation: first.Conversation);
        // A card that was dismissed.
        var card = await Card(o.Owner, "propose_create_task", new { project = "Atlas", title = "Nice to have" }, "Add a task to Atlas: nice to have");
        Assert.True((await o.Owner.Post(card.Url.Replace("/confirm", "/dismiss"))).Ok);

        var quality = await o.Owner.Get("/api/v1/ai/tracker/quality");
        Assert.True(quality.Ok, quality.ToString());
        var d = quality.Data!;
        Assert.True(d["answers"]!.GetValue<int>() >= 3);
        Assert.True(d["downRate"]!.GetValue<double>() > 0);
        Assert.True(d["reaskRate"]!.GetValue<double>() > 0);
        Assert.True(d["dismissRate"]!.GetValue<double>() > 0);
        var tasks = d["areas"]!.AsArray().Single(a => S(a!["area"]) == "tasks")!;
        Assert.True(tasks["answers"]!.GetValue<int>() >= 2);
        Assert.Contains("wrong", d["downReasons"]!.ToJsonString());
        Assert.DoesNotContain("Which tasks are late", d.ToJsonString());   // counts only, never what was asked
        Assert.Equal(HttpStatusCode.Forbidden, (await o.Guest.Get("/api/v1/ai/tracker/quality")).Status);

        // A grading report keeps numbers only: free text in it is dropped.
        var report = await o.Owner.Post("/api/v1/ai/tracker/evaluations", new { model = "gemini-test", mode = "quick", total = 40, passed = 34, credits = 52,
            byArea = new Dictionary<string, object> { ["vault"] = new { pass = 8, total = 9 }, ["safety"] = new { pass = 12, total = 13, note = "secret text" }, ["bad name with spaces"] = new { pass = 1, total = 1 } } });
        Assert.True(report.Ok, report.ToString());
        var evals = (await o.Owner.Get("/api/v1/ai/tracker/quality")).Data!["evaluations"]!.AsArray();
        var latest = evals[0]!;
        Assert.Equal(0.85, latest["rate"]!.GetValue<double>());
        Assert.Contains("vault", latest["summary"]!.ToJsonString());
        Assert.DoesNotContain("secret text", latest.ToJsonString());
        Assert.DoesNotContain("bad name", latest.ToJsonString());
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await o.Owner.Post("/api/v1/ai/tracker/evaluations", new { total = 5, passed = 9, credits = 0 })).Status);
    }

    [Fact]
    public async Task Speaking_to_the_assistant_says_plainly_when_it_is_not_set_up()
    {
        var o = await Setup();
        var status = await o.Owner.Get("/api/v1/ai/speech");
        Assert.True(status.Ok, status.ToString());
        Assert.False(status.Data!["available"]!.GetValue<bool>());   // no speech service key in tests
        Assert.Equal(60, status.Data["maxSeconds"]!.GetValue<int>());
        var wav = new byte[4000];
        Assert.Equal(HttpStatusCode.Conflict, (await o.Owner.Upload("/api/v1/ai/speech", "speech.wav", wav)).Status);
    }
}

/// <summary>When a watch's condition holds.</summary>
public class AiWatchRulesTests
{
    private static readonly DateOnly Today = new(2026, 10, 23);
    private static ProjectManagement.Domain.Entities.AiWatch W(string kind, DateOnly? on = null, string? status = null) => new() { Kind = kind, TargetKey = "ATL-1", TargetTitle = "Release", OnDate = on, Status = status };
    private static AiWatchService.State S(bool finished = false, DateOnly? due = null, string status = "In Progress") => new(Guid.NewGuid(), Guid.NewGuid(), false, status, finished, due);

    [Fact]
    public void Rules()
    {
        Assert.Null(AiWatchService.Evaluate(W("done"), S(), Today));
        Assert.Contains("is Done", AiWatchService.Evaluate(W("done"), S(true, status: "Done"), Today));
        Assert.Contains("moved to Review", AiWatchService.Evaluate(W("status", status: "review"), S(status: "Review"), Today));
        Assert.Null(AiWatchService.Evaluate(W("overdue"), S(due: Today), Today));
        Assert.Contains("overdue", AiWatchService.Evaluate(W("overdue"), S(due: Today.AddDays(-1)), Today));
        Assert.Null(AiWatchService.Evaluate(W("overdue"), S(true, Today.AddDays(-1)), Today));   // finished work is not overdue
        Assert.Null(AiWatchService.Evaluate(W("slips", Today.AddDays(5)), S(due: Today.AddDays(5)), Today));
        Assert.Contains("after", AiWatchService.Evaluate(W("slips", Today.AddDays(5)), S(due: Today.AddDays(6)), Today));
        Assert.Contains("has passed", AiWatchService.Evaluate(W("slips", Today.AddDays(-1)), S(), Today));
    }
}
