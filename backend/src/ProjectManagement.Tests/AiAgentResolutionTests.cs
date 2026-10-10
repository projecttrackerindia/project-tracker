using System.Text.Json.Nodes;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

public sealed partial class AiMessageSendingTests
{
    [Theory]
    [InlineData("releasetracker")]
    [InlineData("Release  Tracker")]
    [InlineData("Release Trakcer")]
    public Task Project_names_resolve_spacing_and_minor_typos_without_creating_projects(string name) => Run(async (sender, _) =>
    {
        var id = await sender.CreateProjectAsync("Release Tracker");
        var reply = await Ask(sender, $"rename project {name} to Delivery Tracker");
        Assert.Single(reply["actions"]!.AsArray());
        var result = await sender.Post(ConfirmUrl(reply));
        Assert.True(result.Ok, result.ToString());
        Assert.Equal(id.ToString(), result.Data!["resultId"]!.GetValue<string>());
        Assert.Empty(factory.Chat.Requests);
    });

    [Fact]
    public Task Project_status_lookup_is_authoritative_and_uses_no_inference() => Run(async (sender, _) =>
    {
        await sender.CreateProjectAsync("Release Tracker");
        factory.Chat.Fail = new InvalidOperationException("Structured lookups must not call a model");
        var reply = await Ask(sender, "What is the status of project releasetracker?");
        Assert.Equal("builtin-project_status", reply["model"]!.GetValue<string>());
        Assert.Contains("Release Tracker", reply["content"]!.GetValue<string>());
        Assert.Contains("Status:", reply["content"]!.GetValue<string>());
        Assert.DoesNotContain("\"project\":", reply["content"]!.GetValue<string>());
        Assert.Empty(reply["actions"]!.AsArray());
        Assert.Empty(factory.Chat.Requests);
    });

    [Theory]
    [InlineData("03/04/2027")]
    [InlineData("tomorrow")]
    [InlineData("2027-02-30")]
    [InlineData("")]
    public Task Invalid_or_ambiguous_task_dates_require_clarification_instead_of_being_dropped(string date) => Run(async (sender, _) =>
    {
        await sender.CreateProjectAsync("Release Tracker");
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.CreateTask, new { project = "Release Tracker", title = "Verify release", due_date = date }));
        var reply = await Ask(sender, "Create a task to verify release with a due date");
        Assert.Empty(reply["actions"]!.AsArray());
        var result = factory.Chat.Requests.SelectMany(r => r.Turns).SelectMany(t => t.Blocks).OfType<AiToolResult>().Last();
        Assert.Contains("yyyy-MM-dd", result.Content);
    });

    [Fact]
    public Task Normalized_existing_project_name_cannot_be_proposed_as_a_duplicate() => Run(async (sender, _) =>
    {
        await sender.CreateProjectAsync("Release Tracker");
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.CreateProject, new { name = "ReleaseTracker" }));
        var reply = await Ask(sender, "Create project ReleaseTracker");
        Assert.Empty(reply["actions"]!.AsArray());
    });

    [Fact]
    public Task Failed_lookup_cannot_turn_a_task_request_into_project_creation() => Run(async (sender, _) =>
    {
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.ProjectReport, new { project = "Unknown Release" }));
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.CreateProject, new { name = "Unknown Release" }));
        factory.Chat.Script.Enqueue(_ => FakeAiChat.Say("I created the missing project."));
        var reply = await Ask(sender, "Add a task to Unknown Release");
        Assert.Empty(reply["actions"]!.AsArray());
        Assert.Contains("previous project lookup was incomplete", reply["content"]!.GetValue<string>());
        Assert.False(factory.WithDb(db => db.Projects.IgnoreQueryFilters().Any(p => p.TenantId == sender.WorkspaceId && p.Name == "Unknown Release")));
    });

    [Fact]
    public Task Unverified_project_completion_text_is_replaced_with_the_actual_pending_state() => Run(async (sender, _) =>
    {
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.CreateProject, new { name = "New Release" }, text: "I created your project."));
        factory.Chat.Script.Enqueue(_ => FakeAiChat.Say("Your project has been saved."));
        var reply = await Ask(sender, "Create project New Release");
        Assert.Single(reply["actions"]!.AsArray());
        Assert.Contains("Awaiting confirmation", reply["content"]!.GetValue<string>());
        Assert.DoesNotContain("has been saved", reply["content"]!.GetValue<string>());
        Assert.DoesNotContain("I created", reply["content"]!.GetValue<string>());
        Assert.False(factory.WithDb(db => db.Projects.IgnoreQueryFilters().Any(p => p.TenantId == sender.WorkspaceId && p.Name == "New Release")));
    });

    [Fact]
    public Task Project_completion_without_a_tool_is_never_reported_as_saved() => Run(async (sender, _) =>
    {
        factory.Chat.Script.Enqueue(_ => FakeAiChat.Say("I created your project."));
        var reply = await Ask(sender, "Create project New Release");
        Assert.Empty(reply["actions"]!.AsArray());
        Assert.Contains("No action was completed", reply["content"]!.GetValue<string>());
        Assert.DoesNotContain("I created", reply["content"]!.GetValue<string>());
    });

    [Fact]
    public Task Ambiguous_project_names_do_not_select_a_mutation_target() => Run(async (sender, _) =>
    {
        await sender.CreateProjectAsync("Release East"); await sender.CreateProjectAsync("Release West");
        var reply = await Ask(sender, "rename project Release to Delivery");
        Assert.Empty(reply["actions"]!.AsArray());
        Assert.Contains("exact project key", reply["content"]!.GetValue<string>());
        Assert.Empty(factory.Chat.Requests);
    });

    [Fact]
    public Task Ambiguous_teams_require_clarification_instead_of_using_the_first_match() => Run(async (sender, _) =>
    {
        factory.WithDb(db =>
        {
            db.Teams.AddRange(new Team { TenantId = sender.WorkspaceId, Name = "Engineering East" }, new Team { TenantId = sender.WorkspaceId, Name = "Engineering West" });
            db.SaveChanges(); return 0;
        });
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.CreateProject, new { name = "New Release", team = "Engineering" }));
        var reply = await Ask(sender, "Create project New Release in Engineering");
        Assert.Empty(reply["actions"]!.AsArray());
        Assert.Contains(factory.Chat.Requests.SelectMany(r => r.Turns).SelectMany(t => t.Blocks).OfType<AiToolResult>(), r => r.Content.Contains("matches several teams"));
    });

    [Fact]
    public Task Exact_project_ids_and_keys_work_beyond_the_name_search_limit() => Run(async (sender, _) =>
    {
        var target = await sender.CreateProjectAsync("Last Project");
        var key = factory.WithDb(db =>
        {
            var project = db.Projects.IgnoreQueryFilters().Single(p => p.Id == target);
            for (var i = 1; i <= 501; i++)
                db.Projects.Add(new Project { Id = Guid.Parse($"00000000-0000-0000-0000-{i:D12}"), TenantId = sender.WorkspaceId,
                    OwnerId = sender.UserId, Key = $"BULK{i}", Name = $"Bulk Project {i}", ProjectGroupId = project.ProjectGroupId });
            db.SaveChanges(); return project.Key;
        });
        var ambiguous = await Ask(sender, "rename project Last Project to Delivery");
        Assert.Empty(ambiguous["actions"]!.AsArray());
        Assert.Contains("too many visible projects", ambiguous["content"]!.GetValue<string>());
        foreach (var identity in new[] { target.ToString(), key.ToLowerInvariant() })
        {
            var reply = await Ask(sender, $"rename project {identity} to Delivery");
            Assert.Single(reply["actions"]!.AsArray());
        }
        Assert.Empty(factory.Chat.Requests);
    });

    [Fact]
    public Task Task_start_and_due_dates_persist_as_distinct_reviewed_fields() => Run(async (sender, _) =>
    {
        var project = await sender.CreateProjectAsync("Release Tracker");
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.CreateTask, new { project = "Release Tracker", title = "Verify release", start_date = "2027-03-01", due_date = "2027-03-04" }));
        var reply = await Ask(sender, "Create a task to verify release from March 1 to March 4 in 2027");
        var confirmed = await sender.Post(ConfirmUrl(reply));
        Assert.True(confirmed.Ok, confirmed.ToString());
        var task = factory.WithDb(db => db.Tasks.IgnoreQueryFilters().Single(t => t.Id == Guid.Parse(confirmed.Data!["resultId"]!.GetValue<string>())));
        Assert.Equal(project, task.ProjectId);
        Assert.Equal(new DateOnly(2027, 3, 1), task.StartDate);
        Assert.Equal(new DateOnly(2027, 3, 4), task.DueDate);
    });

    [Fact]
    public void Unsupported_end_date_is_not_silently_treated_as_due_date()
    {
        var tool = new AiToolDef("create_task", "", """{"type":"object","properties":{"due_date":{"type":"string"}},"required":[]}""");
        using var input = JsonDocument.Parse("""{"end_date":"2027-03-04"}""");
        Assert.Contains("not supported", AiToolInputValidator.Validate(tool, input.RootElement));
    }

    [Fact]
    public Task Explicit_confirmation_survives_intervening_answers_but_unbound_yes_cannot_select_stale_actions() => Run(async (sender, _) =>
    {
        var proposal = await Ask(sender, "Send Hi message to Sivareddy");
        var conversation = Conversation(proposal);
        await Ask(sender, "thanks", conversation);
        var unbound = await Ask(sender, "yes", conversation);
        Assert.Contains("No single matching", unbound["content"]!.GetValue<string>());
        Assert.Equal(0, Sent(sender));
        var binding = new AiConfirmationBinding(Guid.Parse(proposal["id"]!.GetValue<string>()), proposal["actions"]![0]!["id"]!.GetValue<string>(), "send_message");
        var confirmed = await Ask(sender, "yes", conversation, confirmation: binding);
        Assert.Contains("Verified saved message ID", confirmed["content"]!.GetValue<string>());
        await Ask(sender, "yes", conversation, confirmation: binding);
        Assert.Equal(1, Sent(sender));
        Assert.Empty(factory.Chat.Requests);
    });
}
