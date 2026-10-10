using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

public sealed partial class AiMessageSendingTests
{
    [Fact]
    public Task Planner_assigns_and_renames_only_after_approval_and_verifies_real_records() => Run(async (sender, recipient) =>
    {
        factory.Chat.Fail = new InvalidOperationException("Known CRUD commands must not call a model");
        var project = await sender.CreateProjectAsync("Atlas"); var task = await sender.CreateTaskAsync(project, "Ship release");
        var key = task["key"]!.GetValue<string>(); var id = Guid.Parse(task["id"]!.GetValue<string>());
        var assignment = await Ask(sender, $"Assign {key} to Sivareddy");
        Assert.Null(factory.WithDb(db => db.Tasks.IgnoreQueryFilters().Single(t => t.Id == id).AssigneeId));
        Assert.NotNull(assignment["actions"]![0]!["lifecycle"]); Assert.Equal(1, assignment["actions"]![0]!["lifecycle"]!["version"]!.GetValue<int>());
        var approval = await Ask(sender, "Yes", Conversation(assignment));
        Assert.Contains("Completed:", approval["content"]!.GetValue<string>());
        Assert.Equal(recipient.UserId, factory.WithDb(db => db.Tasks.IgnoreQueryFilters().Single(t => t.Id == id).AssigneeId));
        var rename = await Ask(sender, "Rename project Atlas to Atlas Launch");
        Assert.Equal("Atlas", factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == project).Name));
        (await sender.Post(ConfirmUrl(rename))).CheckStatus(HttpStatusCode.OK);
        Assert.Equal("Atlas Launch", factory.WithDb(db => db.Projects.IgnoreQueryFilters().Single(p => p.Id == project).Name));
        var status = await Ask(sender, $"Mark {key} as Done");
        (await sender.Post(ConfirmUrl(status))).CheckStatus(HttpStatusCode.OK);
        Assert.Equal("Done", factory.WithDb(db => db.Tasks.IgnoreQueryFilters().Where(t => t.Id == id).Select(t => t.Status!.Name).Single()));
        Assert.Empty(factory.Chat.Requests);
    }, "Siva Reddy");

    [Theory]
    [InlineData("list people", "Siva Reddy")]
    [InlineData("show projects", "projects")]
    [InlineData("my work", "Open")]
    public Task Common_reads_do_not_use_a_model(string text, string expected) => Run(async (sender, recipient) =>
    {
        factory.Chat.Fail = new InvalidOperationException("Common reads must call application services");
        await sender.CreateProjectAsync("Current project");
        var reply = await Ask(sender, text); Assert.Contains(expected, reply["content"]!.GetValue<string>());
        Assert.Empty(reply["actions"]!.AsArray()); Assert.Empty(factory.Chat.Requests);
        var trace = factory.WithDb(db => db.AiMessages.IgnoreQueryFilters().Single(m => m.Id == Guid.Parse(reply["id"]!.GetValue<string>())).ExecutionJson);
        var json = JsonNode.Parse(trace!)!; Assert.True(json["database"]!["commands"]!.GetValue<int>() > 0);
        Assert.Empty(json["models"]!.AsArray()); Assert.Equal(0, json["promptChars"]!.GetValue<int>());
    }, "Siva Reddy");

    [Fact]
    public Task Typed_cancellation_marks_the_exact_card_cancelled_without_sending() => Run(async (sender, recipient) =>
    {
        var proposal = await Ask(sender, "Send Hi message to Siva Reddy");
        var reply = await Ask(sender, "cancel it", Conversation(proposal));
        Assert.Contains("Cancelled the exact pending", reply["content"]!.GetValue<string>()); Assert.Equal(0, Sent(sender));
        var persisted = factory.WithDb(db => db.AiMessages.IgnoreQueryFilters().Single(m => m.Id == Guid.Parse(proposal["id"]!.GetValue<string>())));
        Assert.Contains("dismissed", persisted.ActionsJson); Assert.Equal("cancelled", JsonNode.Parse(persisted.ExecutionJson!)!["outcome"]!.GetValue<string>());
        (await sender.Post(ConfirmUrl(proposal))).CheckStatus(HttpStatusCode.Conflict); Assert.Equal(0, Sent(sender));
        Assert.Empty(factory.Chat.Requests);
    }, "Siva Reddy");

    [Fact]
    public Task Tampered_action_payload_cannot_execute_a_previously_reviewed_plan() => Run(async (sender, recipient) =>
    {
        var proposal = await Ask(sender, "Send Hi message to Siva Reddy");
        factory.WithDb(db =>
        {
            var message = db.AiMessages.IgnoreQueryFilters().Single(m => m.Id == Guid.Parse(proposal["id"]!.GetValue<string>()));
            var actions = JsonSerializer.Deserialize<List<AiProposal>>(message.ActionsJson!, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
            var payload = JsonNode.Parse(actions[0].PayloadJson)!; payload["body"] = "Changed after approval preview";
            actions[0] = actions[0] with { PayloadJson = payload.ToJsonString() };
            message.ActionsJson = JsonSerializer.Serialize(actions, new JsonSerializerOptions(JsonSerializerDefaults.Web)); db.SaveChanges(); return 0;
        });
        var result = await sender.Post(ConfirmUrl(proposal)); Assert.Equal("AI_PLAN_MISMATCH", result.ErrorCode); Assert.Equal(0, Sent(sender));
    }, "Siva Reddy");

    [Fact]
    public Task Interrupted_message_recovers_only_from_a_verified_receipt_without_a_second_send() => Run(async (sender, recipient) =>
    {
        var proposal = await Ask(sender, "Send Hi message to Siva Reddy");
        var sent = await sender.Post(ConfirmUrl(proposal)); Assert.True(sent.Ok); var receipt = sent.Data!["resultId"]!.GetValue<string>();
        var messageId = Guid.Parse(proposal["id"]!.GetValue<string>());
        factory.WithDb(db =>
        {
            var message = db.AiMessages.IgnoreQueryFilters().Single(m => m.Id == messageId);
            var actions = JsonSerializer.Deserialize<List<AiProposal>>(message.ActionsJson!, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
            actions[0] = actions[0] with { Status = "running", ResultId = null, Execution = actions[0].Execution! with { StartedAt = DateTime.UtcNow.AddHours(-1), CompletedAt = null } };
            message.ActionsJson = JsonSerializer.Serialize(actions, new JsonSerializerOptions(JsonSerializerDefaults.Web)); db.SaveChanges(); return 0;
        });
        var url = $"/api/v1/ai/messages/{messageId}/actions/{proposal["actions"]![0]!["id"]}/reconcile";
        (await recipient.Post(url)).CheckStatus(HttpStatusCode.NotFound);
        var recovered = await sender.Post(url); Assert.True(recovered.Ok, recovered.ToString());
        Assert.Equal("done", recovered.Data!["status"]!.GetValue<string>()); Assert.Equal(receipt, recovered.Data["resultId"]!.GetValue<string>());
        Assert.Equal(1, Sent(sender)); (await sender.Post(url)).CheckStatus(HttpStatusCode.Conflict); Assert.Equal(1, Sent(sender));
    }, "Siva Reddy");

    [Fact]
    public Task Recovery_without_a_saved_receipt_never_simulates_or_retries_delivery() => Run(async (sender, recipient) =>
    {
        var proposal = await Ask(sender, "Send Hi message to Siva Reddy"); var messageId = Guid.Parse(proposal["id"]!.GetValue<string>());
        factory.WithDb(db =>
        {
            var message = db.AiMessages.IgnoreQueryFilters().Single(m => m.Id == messageId);
            var actions = JsonSerializer.Deserialize<List<AiProposal>>(message.ActionsJson!, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
            actions[0] = actions[0] with { Status = "running", Execution = actions[0].Execution! with { ApprovedAt = DateTime.UtcNow.AddHours(-1), StartedAt = DateTime.UtcNow.AddHours(-1) } };
            message.ActionsJson = JsonSerializer.Serialize(actions, new JsonSerializerOptions(JsonSerializerDefaults.Web)); db.SaveChanges(); return 0;
        });
        var result = await sender.Post($"/api/v1/ai/messages/{messageId}/actions/{proposal["actions"]![0]!["id"]}/reconcile");
        Assert.Equal("AI_RECOVERY_UNVERIFIED", result.ErrorCode); Assert.Equal(0, Sent(sender));
    }, "Siva Reddy");

    [Fact]
    public Task Dependent_task_requires_the_actual_created_project_result() => Run(async (sender, recipient) =>
    {
        // Only the model transport is mocked: both project and task creation use actual services and persistence.
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.CreateProject, new { name = "Launch" }));
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.CreateTask, new { project = "Launch", title = "Build release" }));
        factory.Chat.Script.Enqueue(_ => FakeAiChat.Say("Review the two proposals."));
        var proposal = await Ask(sender, "Create project Launch and create task Build release in it");
        Assert.Equal(2, proposal["actions"]!.AsArray().Count);
        var message = proposal["id"]!.GetValue<string>(); var taskAction = proposal["actions"]![1]!["id"]!.GetValue<string>();
        var blocked = await sender.Post($"/api/v1/ai/messages/{message}/actions/{taskAction}/confirm"); Assert.Equal("AI_ACTION_DEPENDENCY", blocked.ErrorCode);
        var created = await sender.Post(ConfirmUrl(proposal)); Assert.True(created.Ok, created.ToString());
        var projectId = Guid.Parse(created.Data!["resultId"]!.GetValue<string>());
        factory.WithDb(db => { db.Projects.IgnoreQueryFilters().Single(p => p.Id == projectId).Name = "Renamed after proposal"; db.SaveChanges(); return 0; });
        var completed = await sender.Post($"/api/v1/ai/messages/{message}/actions/{taskAction}/confirm"); Assert.True(completed.Ok, completed.ToString());
        var taskId = Guid.Parse(completed.Data!["resultId"]!.GetValue<string>());
        Assert.Equal(projectId, factory.WithDb(db => db.Tasks.IgnoreQueryFilters().Single(t => t.Id == taskId).ProjectId));
        Assert.NotNull(completed.Data["lifecycle"]!["completedAt"]); Assert.Equal(1, completed.Data["lifecycle"]!["attempts"]!.GetValue<int>());
    }, "Siva Reddy");
    [Fact]
    public Task Relative_reminder_dates_are_computed_in_the_user_zone_and_require_confirmation() => Run(async (sender, recipient) =>
    {
        factory.Chat.Fail = new InvalidOperationException("Known relative dates must not call a model");
        var reply = await Ask(sender, "Create reminder for tomorrow at 09:00 called Check release");
        var action = reply["actions"]![0]!; Assert.Equal("reminder", action["kind"]!.GetValue<string>());
        Assert.Equal("proposed", action["status"]!.GetValue<string>());
        var json = factory.WithDb(db => db.AiMessages.IgnoreQueryFilters().Single(m => m.Id == Guid.Parse(reply["id"]!.GetValue<string>())).ActionsJson);
        var payload = JsonNode.Parse(JsonNode.Parse(json!)![0]!["payloadJson"]!.GetValue<string>())!;
        var tomorrow = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, TimeZoneInfo.FindSystemTimeZoneById("Asia/Kolkata")).Date.AddDays(1);
        Assert.Equal(tomorrow.ToString("yyyy-MM-dd") + "T09:00", payload["at"]!.GetValue<string>());
        var saved = await sender.Post(ConfirmUrl(reply)); Assert.True(saved.Ok, saved.ToString()); Assert.NotNull(saved.Data!["resultId"]);
        Assert.Empty(factory.Chat.Requests);
    }, "Siva Reddy");

    [Fact]
    public Task Tracker_filters_intent_and_shows_sanitized_action_database_metrics() => Run(async (sender, recipient) =>
    {
        var proposal = await Ask(sender, "Send Hi message to Siva Reddy"); (await sender.Post(ConfirmUrl(proposal))).CheckStatus(HttpStatusCode.OK);
        await Ask(sender, "Hi");
        var report = await sender.Get("/api/v1/ai/tracker?intent=send_message"); Assert.True(report.Ok);
        var run = Assert.Single(report.Data!["runs"]!.AsArray()); var trace = run!["trace"]!;
        Assert.Equal("succeeded", trace["outcome"]!.GetValue<string>()); Assert.Single(trace["actions"]!.AsArray());
        Assert.True(trace["actions"]![0]!["database"]!["commands"]!.GetValue<int>() > 0);
        Assert.NotNull(trace["actions"]![0]!["confirmationWaitMs"]); Assert.Equal(1, trace["actions"]![0]!["attempts"]!.GetValue<int>());
        Assert.NotNull(report.Data["p50Ms"]); Assert.Equal(0, report.Data["modelCalls"]!.GetValue<int>());
        Assert.DoesNotContain("Siva Reddy", report.Data.ToJsonString()); Assert.DoesNotContain("payloadHash", report.Data.ToJsonString());
        (await recipient.Get("/api/v1/ai/tracker?intent=send_message")).CheckStatus(HttpStatusCode.Forbidden);
    }, "Siva Reddy");

}
