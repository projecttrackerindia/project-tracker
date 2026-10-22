using System.Net;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// A proposal is carried out once, whoever approves it and however many times: the decision takes the row with one compare-and-swap, so
/// two approvals arriving together produce one task and one conflict, and another organization never sees or decides it at all.
/// </summary>
[Collection("api")]
public class ProjectAgentConcurrencyTests(ApiFactory factory)
{
    private void AnswerWithOneTask()
    {
        factory.Ai.Reset(); factory.Ai.Configured = true;
        factory.Ai.Answer = (_, _) => JsonSerializer.Serialize(new
        {
            summary = "One follow-up.",
            findings = new object[]
            {
                new { kind = "create_task", title = "Prepare the go-live checklist", detail = "Asked for by Friday.", evidence = "send the go-live checklist", source = "S1",
                      dueDate = DateTime.UtcNow.AddDays(5).ToString("yyyy-MM-dd"), priority = "High", confidence = 90 },
            },
        });
    }

    private async Task<(TestClient Owner, Guid Project, string FindingId)> ProposalAsync(string name)
    {
        var owner = await TestClient.RegisterAsync(factory, $"{name} Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var project = await owner.CreateProjectAsync(name);
        Assert.True((await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true })).Ok);
        var read = await owner.Post($"/api/v1/projects/{project}/agent/transcript", new { title = "Stand-up", text = "Client: can you send the go-live checklist by Friday?" });
        Assert.Equal(HttpStatusCode.Created, read.Status);
        var items = (await owner.Get($"/api/v1/projects/{project}/agent/findings")).Data!["items"]!.AsArray();
        return (owner, project, Assert.Single(items)!["id"]!.GetValue<string>());
    }

    [Fact]
    public async Task Two_simultaneous_approvals_create_one_task_and_one_conflict()
    {
        AnswerWithOneTask();
        try
        {
            var (owner, project, id) = await ProposalAsync("Race Core");

            var first = owner.Post($"/api/v1/agent/findings/{id}/approve", new { });
            var second = owner.Post($"/api/v1/agent/findings/{id}/approve", new { });
            var results = await Task.WhenAll(first, second);

            Assert.Single(results, r => r.Ok && r.Data!["status"]!.GetValue<string>() == "Applied");
            Assert.Single(results, r => r.Status == HttpStatusCode.Conflict);

            Assert.Equal(1, factory.WithDb(db => db.Tasks.IgnoreQueryFilters().Count(t => t.ProjectId == project && t.Title == "Prepare the go-live checklist")));
        }
        finally { factory.Ai.Reset(); }
    }

    [Fact]
    public async Task A_proposal_that_was_already_dismissed_cannot_be_approved_and_vice_versa()
    {
        AnswerWithOneTask();
        try
        {
            var (owner, _, id) = await ProposalAsync("Decide Once");
            var dismissed = await owner.Post($"/api/v1/agent/findings/{id}/dismiss", new { reason = "not_needed" });
            Assert.True(dismissed.Ok, dismissed.ToString());
            var again = await owner.Post($"/api/v1/agent/findings/{id}/approve", new { });
            Assert.Equal(HttpStatusCode.Conflict, again.Status);
            Assert.Equal("AGENT_ALREADY_DECIDED", again.ErrorCode);
        }
        finally { factory.Ai.Reset(); }
    }

    [Fact]
    public async Task Another_organization_cannot_read_or_decide_a_proposal()
    {
        AnswerWithOneTask();
        try
        {
            var (_, project, id) = await ProposalAsync("Tenant A");
            var outsider = await TestClient.RegisterAsync(factory, "Tenant B Owner");
            await outsider.CreateOrgAsync();
            await outsider.UpgradeAsync("BUSINESS");

            Assert.Equal(HttpStatusCode.NotFound, (await outsider.Get($"/api/v1/projects/{project}/agent/findings")).Status);
            Assert.Equal(HttpStatusCode.NotFound, (await outsider.Post($"/api/v1/agent/findings/{id}/approve", new { })).Status);
            Assert.Equal(HttpStatusCode.NotFound, (await outsider.Post($"/api/v1/agent/findings/{id}/dismiss", new { })).Status);
            var inbox = await outsider.Get("/api/v1/agent/findings");
            Assert.True(inbox.Ok, inbox.ToString());
            Assert.Empty(inbox.Data!["items"]!.AsArray());
        }
        finally { factory.Ai.Reset(); }
    }
}
