using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The assistant doing what the person could do by hand: a multi-step answer is a plan the person confirms, carried out in order through the
/// app's own services, stopping at the first failure, audited as the person via the assistant, and undone together within the window.
/// Comments, bugs, time entries, attendance, meetings and quality are each a card; nobody acts beyond their own rights through it.
/// </summary>
public partial class AiWorkspaceTests
{
    private async Task<(string Message, List<JsonNode> Cards)> Plan(TestClient who, string question, params (string Tool, object Input)[] steps)
    {
        var n = 0;
        foreach (var (tool, input) in steps) { var id = $"toolu_p{++n}"; Chat.Script.Enqueue(_ => FakeAiChat.UseTool(tool, input, id: id)); }
        Chat.Script.Enqueue(_ => FakeAiChat.Say("The plan is ready for you to confirm."));
        var s = await Ask(who, question);
        var cards = s.Done["actions"]!.AsArray().Select(x => x!).ToList();
        Assert.True(cards.Count == steps.Length, $"Expected {steps.Length} cards, got {cards.Count}: {ToolResult()}");
        return (S(s.Done["id"]), cards);
    }

    [Fact]
    public async Task A_multi_step_request_is_a_plan_confirmed_and_run_in_order_audited_and_undone_together()
    {
        var o = await Setup();
        var task = await o.Owner.CreateTaskAsync(o.Project, "Renew the gateway certificate", new { title = "Renew the gateway certificate", priority = "Medium", dueDate = Iso(5) });
        var key = S(task["key"]); var id = Guid.Parse(S(task["id"]));

        var (message, cards) = await Plan(o.Owner, "Push the certificate task out a week, comment on it and check me in from home",
            (AiToolbox.UpdateWork, new { key, due_date = Iso(12), reason = "Vendor is late" }),
            (AiPowerTools.AddComment, new { key, body = "Moved a week: the vendor is late." }),
            (AiPowerTools.CheckIn, new { mode = "Home" }));
        Assert.Equal(["update_work", "add_comment", "check_in"], cards.Select(c => S(c["kind"])).ToArray());

        // The plan: every step in order with a summary and whether it can be undone. Nothing has happened yet.
        var plan = await o.Owner.Get($"/api/v1/ai/messages/{message}/plan");
        Assert.True(plan.Ok, plan.ToString());
        Assert.Equal("awaiting_confirmation", S(plan.Data!["outcome"]));
        var steps = plan.Data["steps"]!.AsArray();
        Assert.Equal([1, 2, 3], steps.Select(x => x!["index"]!.GetValue<int>()).ToArray());
        Assert.Equal([true, true, false], steps.Select(x => x!["undoable"]!.GetValue<bool>()).ToArray());
        Assert.All(steps, x => Assert.False(string.IsNullOrWhiteSpace(S(x!["summary"]))));
        Assert.Equal(DateOnly.Parse(Iso(5)), factory.WithDb(db => db.Tasks.IgnoreQueryFilters().First(t => t.Id == id).DueDate));
        Assert.False(cards[2]["undoable"]!.GetValue<bool>());   // the card itself says check-in cannot be undone

        // Confirm: all three run in order, as the person.
        var run = await o.Owner.Post($"/api/v1/ai/messages/{message}/actions/run");
        Assert.True(run.Ok, run.ToString());
        Assert.Equal("succeeded", S(run.Data!["outcome"]));
        Assert.Equal(3, run.Data["completed"]!.AsArray().Count);
        Assert.NotNull(run.Data["undoUntil"]);
        Assert.Equal(DateOnly.Parse(Iso(12)), factory.WithDb(db => db.Tasks.IgnoreQueryFilters().First(t => t.Id == id).DueDate));
        Assert.Contains(factory.WithDb(db => db.TaskComments.IgnoreQueryFilters().Where(c => c.TaskId == id && !c.IsDeleted).Select(c => c.Body).ToList()), b => b.StartsWith("Moved a week"));
        Assert.True(factory.WithDb(db => db.AttendanceDays.IgnoreQueryFilters().Any(a => a.UserId == o.Owner.UserId && a.Mode == "Home")));

        // Every executed step is in the audit log as the person, via the assistant.
        var audit = factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Where(l => l.TenantId == o.Owner.WorkspaceId && l.Action == "ai.action_confirmed").ToList());
        Assert.Equal(3, audit.Count);
        Assert.All(audit, l => { Assert.Equal(o.Owner.UserId, l.UserId); Assert.Contains("assistant", l.NewValue); });

        // Undo the whole run: the due date and the comment go back; the check-in cannot be undone and is kept (and said so).
        var undo = await o.Owner.Post($"/api/v1/ai/messages/{message}/actions/undo-all");
        Assert.True(undo.Ok, undo.ToString());
        Assert.Equal("undone", S(undo.Data!["outcome"]));
        Assert.Contains("kept", S(undo.Data["message"]));
        Assert.Equal(DateOnly.Parse(Iso(5)), factory.WithDb(db => db.Tasks.IgnoreQueryFilters().First(t => t.Id == id).DueDate));
        Assert.DoesNotContain(factory.WithDb(db => db.TaskComments.IgnoreQueryFilters().Where(c => c.TaskId == id && !c.IsDeleted).Select(c => c.Body).ToList()), b => b.StartsWith("Moved a week"));
        Assert.True(factory.WithDb(db => db.AttendanceDays.IgnoreQueryFilters().Any(a => a.UserId == o.Owner.UserId)));
        Assert.Equal(2, factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Count(l => l.TenantId == o.Owner.WorkspaceId && l.Action == "ai.action_undone")));
        Assert.Equal(HttpStatusCode.Conflict, (await o.Owner.Post($"/api/v1/ai/messages/{message}/actions/undo-all")).Status);   // nothing left to undo

        // Someone else cannot see, run or undo this person's plan.
        Assert.Equal(HttpStatusCode.NotFound, (await o.Manager.Get($"/api/v1/ai/messages/{message}/plan")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await o.Manager.Post($"/api/v1/ai/messages/{message}/actions/undo-all")).Status);
    }

    [Fact]
    public async Task A_run_stops_at_the_first_failed_step_and_reports_which_steps_completed()
    {
        var o = await Setup();
        var task = await o.Owner.CreateTaskAsync(o.Project, "Draft the runbook");
        var key = S(task["key"]);
        var (message, cards) = await Plan(o.Owner, "Comment on the runbook task, check me in at the office and add another comment",
            (AiPowerTools.AddComment, new { key, body = "First note" }),
            (AiPowerTools.CheckIn, new { mode = "Office" }),
            (AiPowerTools.AddComment, new { key, body = "Second note" }));
        Assert.True((await o.Owner.Post("/api/v1/me/attendance/check-in", new { mode = "Office" })).Ok);   // done by hand meanwhile: step 2 can no longer work

        var run = await o.Owner.Post($"/api/v1/ai/messages/{message}/actions/run");
        Assert.True(run.Ok, run.ToString());
        Assert.Equal("partial", S(run.Data!["outcome"]));
        Assert.Equal([S(cards[0]["id"])], run.Data["completed"]!.AsArray().Select(x => S(x)).ToArray());
        Assert.Equal(S(cards[1]["id"]), S(run.Data["failedStepId"]));
        Assert.Contains("step 2", S(run.Data["message"]));
        Assert.Equal(["done", "failed", "proposed"], run.Data["steps"]!.AsArray().Select(x => S(x!["status"])).ToArray());
        Assert.False(string.IsNullOrWhiteSpace(S(run.Data["steps"]![1]!["error"])));
        Assert.DoesNotContain(factory.WithDb(db => db.TaskComments.IgnoreQueryFilters().Select(c => c.Body).ToList()), b => b == "Second note");   // never attempted
    }

    [Fact]
    public async Task Nobody_acts_through_the_assistant_beyond_their_own_rights_and_suspended_members_cannot_be_given_work()
    {
        var o = await Setup();
        var task = await o.Owner.CreateTaskAsync(o.Project, "Private planning");
        var key = S(task["key"]);

        // A guest who was never added to the project cannot comment on its work, report bugs in it or write test cases.
        await NoCard(o.Guest, AiPowerTools.AddComment, new { key, body = "hello" });
        await NoCard(o.Guest, AiPowerTools.ReportIssue, new { project = "Atlas", title = "Login fails on Safari" });
        await NoCard(o.Guest, AiPowerTools.CreateTestCase, new { title = "Login works on Safari" });

        // A card made while someone was active is refused at confirmation once they are suspended; afterwards they are not offered at all.
        var sam = await o.Owner.AddMemberAsync(factory, TenantRole.Member, "Sam Suspended");
        var card = await Card(o.Owner, AiToolbox.CreateTask, new { project = "Atlas", title = "Rotate the logs", assignee = "Sam Suspended" });
        Assert.True((await o.Owner.Post($"/api/v1/workspace/members/{sam.UserId}/suspend")).Ok);
        var res = await o.Owner.Post(card.Url);
        Assert.True(res.Ok, res.ToString());
        Assert.Equal("failed", S(res.Data!["status"]));
        Assert.Contains("suspended", S(res.Data["error"]));
        Assert.DoesNotContain(factory.WithDb(db => db.Tasks.IgnoreQueryFilters().Where(t => t.ProjectId == o.Project).Select(t => t.Title).ToList()), t => t == "Rotate the logs");
        await NoCard(o.Owner, AiToolbox.UpdateWork, new { key, assignee = "Sam Suspended" });
    }

    [Fact]
    public async Task Bugs_are_reported_moved_assigned_and_undone_through_the_issue_rules()
    {
        var o = await Setup();
        var projectKey = factory.WithDb(db => db.Projects.IgnoreQueryFilters().First(p => p.Id == o.Project).Key);
        var report = await Card(o.Owner, AiPowerTools.ReportIssue, new { project = projectKey, title = "Checkout total is wrong", severity = "High" });
        Assert.Equal("create_issue", report.Kind);
        Assert.Equal("done", await Confirmed(o.Owner, report));
        var issue = factory.WithDb(db => db.StageIssues.IgnoreQueryFilters().Single(i => i.ProjectId == o.Project && i.Title == "Checkout total is wrong"));
        Assert.Equal(Priority.High, issue.Severity);

        var move = await Card(o.Owner, AiPowerTools.UpdateIssue, new { key = $"{projectKey}-I{issue.Number}", status = "InProgress", assignee = "Max Manager" });
        Assert.Equal("done", await Confirmed(o.Owner, move));
        var moved = factory.WithDb(db => db.StageIssues.IgnoreQueryFilters().Single(i => i.Id == issue.Id));
        Assert.Equal(IssueStatus.InProgress, moved.Status); Assert.Equal(o.Manager.UserId, moved.AssigneeId);

        Assert.True((await o.Owner.Post(move.Url.Replace("/confirm", "/undo"))).Ok);
        var back = factory.WithDb(db => db.StageIssues.IgnoreQueryFilters().Single(i => i.Id == issue.Id));
        Assert.Equal(IssueStatus.Observed, back.Status); Assert.Null(back.AssigneeId);

        Assert.True((await o.Owner.Post(report.Url.Replace("/confirm", "/undo"))).Ok);
        Assert.False(factory.WithDb(db => db.StageIssues.IgnoreQueryFilters().Any(i => i.Id == issue.Id)));
    }

    [Fact]
    public async Task Own_time_entries_are_listed_with_ids_edited_and_undone()
    {
        var o = await Setup();
        var task = await o.Owner.CreateTaskAsync(o.Project, "Write the migration");
        Assert.True((await o.Owner.Post($"/api/v1/tasks/{S(task["id"])}/time", new { minutes = 60, workDate = Iso(0), note = "first pass" })).Ok);
        var entry = factory.WithDb(db => db.TimeEntries.IgnoreQueryFilters().Single(e => e.UserId == o.Owner.UserId && e.TaskId == Guid.Parse(S(task["id"]))));

        Assert.Contains(entry.Id.ToString(), await RunTool(o.Owner, AiPowerTools.ListMyTimeEntries, new { }, "Show my time entries this week"));
        var card = await Card(o.Owner, AiPowerTools.EditTimeEntry, new { entry_id = entry.Id, minutes = 90, note = "first pass and review" });
        Assert.Equal("done", await Confirmed(o.Owner, card));
        Assert.Equal(90, factory.WithDb(db => db.TimeEntries.IgnoreQueryFilters().Single(e => e.Id == entry.Id).Minutes));
        Assert.True((await o.Owner.Post(card.Url.Replace("/confirm", "/undo"))).Ok);
        var back = factory.WithDb(db => db.TimeEntries.IgnoreQueryFilters().Single(e => e.Id == entry.Id));
        Assert.Equal(60, back.Minutes); Assert.Equal("first pass", back.Note);

        // Someone else's entry is not theirs to change.
        await NoCard(o.Manager, AiPowerTools.EditTimeEntry, new { entry_id = entry.Id, minutes = 30 });
    }

    [Fact]
    public async Task Check_out_is_a_card_that_cannot_be_undone()
    {
        var o = await Setup();
        await NoCard(o.Owner, AiPowerTools.CheckOut, new { });   // not checked in yet
        Assert.True((await o.Owner.Post("/api/v1/me/attendance/check-in", new { mode = "Office" })).Ok);
        var card = await Card(o.Owner, AiPowerTools.CheckOut, new { note = "Done for today" });
        Assert.False(card.Action["undoable"]!.GetValue<bool>());
        var res = await o.Owner.Post(card.Url);
        Assert.Equal("done", S(res.Data!["status"]));
        Assert.Null(res.Data["undoUntil"]);
        Assert.NotNull(factory.WithDb(db => db.AttendanceDays.IgnoreQueryFilters().Single(a => a.UserId == o.Owner.UserId).CheckOutAt));
    }

    [Fact]
    public async Task Meetings_are_rescheduled_and_renamed_and_put_back_by_undo()
    {
        var o = await Setup();
        var start = DateTimeOffset.UtcNow.AddDays(2).Date.AddHours(9);
        var made = await o.Owner.Post($"/api/v1/projects/{o.Project}/meetings/schedule", new { title = "Sprint review", startTime = new DateTimeOffset(start, TimeSpan.Zero), endTime = new DateTimeOffset(start.AddMinutes(30), TimeSpan.Zero), timeZone = "UTC" });
        Assert.True(made.Ok, made.ToString());
        var id = Guid.Parse(S(made.Data!["id"]));
        Assert.Contains(id.ToString(), await RunTool(o.Owner, AiToolbox.ListMeetings, new { project = "Atlas" }, "What meetings are on Atlas?"));

        var at = start.AddDays(1).AddHours(2);
        var move = await Card(o.Owner, AiPowerTools.RescheduleMeeting, new { meeting_id = id, at = at.ToString("yyyy-MM-ddTHH:mm") }, "Reschedule the sprint review");
        Assert.Equal("done", await Confirmed(o.Owner, move));
        var saved = factory.WithDb(db => db.ProjectMeetings.IgnoreQueryFilters().Single(m => m.Id == id));
        Assert.Equal(30, (saved.EndTimeUtc - saved.StartTimeUtc).TotalMinutes);   // keeps its length
        Assert.NotEqual(start, saved.StartTimeUtc);
        Assert.True((await o.Owner.Post(move.Url.Replace("/confirm", "/undo"))).Ok);
        Assert.Equal(start, factory.WithDb(db => db.ProjectMeetings.IgnoreQueryFilters().Single(m => m.Id == id).StartTimeUtc));

        var rename = await Card(o.Owner, AiPowerTools.UpdateMeeting, new { meeting_id = id, title = "Sprint 14 review" });
        Assert.Equal("done", await Confirmed(o.Owner, rename));
        Assert.Equal("Sprint 14 review", factory.WithDb(db => db.ProjectMeetings.IgnoreQueryFilters().Single(m => m.Id == id).Title));
        Assert.True((await o.Owner.Post(rename.Url.Replace("/confirm", "/undo"))).Ok);
        Assert.Equal("Sprint review", factory.WithDb(db => db.ProjectMeetings.IgnoreQueryFilters().Single(m => m.Id == id).Title));
    }

    [Fact]
    public async Task Test_cases_and_results_are_recorded_through_quality()
    {
        var o = await Setup();
        var card = await Card(o.Owner, AiPowerTools.CreateTestCase, new { title = "Refund is credited within a day", steps = "1. Refund an order", expected = "Credited", priority = "High" });
        Assert.Equal("done", await Confirmed(o.Owner, card));
        var tc = factory.WithDb(db => db.TestCases.IgnoreQueryFilters().Single(c => c.TenantId == o.Owner.WorkspaceId && c.Title == "Refund is credited within a day"));
        var run = await o.Owner.Post("/api/v1/quality/runs", new { name = "Release 3 regression" });
        Assert.True(run.Ok, run.ToString());
        var result = await Card(o.Owner, AiPowerTools.RecordTestResult, new { run_id = S(run.Data!["id"]), case_id = tc.Id, status = "Pass" });
        Assert.Equal("done", await Confirmed(o.Owner, result));
        Assert.Equal("Pass", factory.WithDb(db => db.TestResults.IgnoreQueryFilters().Single(r => r.CaseId == tc.Id).Status));
    }

    [Fact]
    public async Task Destructive_and_sensitive_requests_get_a_link_to_do_them_by_hand_and_never_a_card()
    {
        var o = await Setup();
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiPowerTools.ManualOnly, new { topic = "delete_project" }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Deleting a project is done by hand on the Projects page."));
        var s = await Ask(o.Owner, "Delete the project Atlas");
        Assert.Contains("/projects", ToolResult());
        Assert.Contains("never does this itself", ToolResult());
        Assert.Empty(s.Done["actions"]!.AsArray());
        Assert.True(factory.WithDb(db => db.Projects.IgnoreQueryFilters().Any(p => p.Id == o.Project && !p.IsDeleted)));
    }
}
