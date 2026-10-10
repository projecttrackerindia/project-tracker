using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public class AiOperationsTests(ApiFactory factory)
{
    private Task<int> Process() => factory.Services.GetRequiredService<AiOperationsProcessor>().ProcessAsync();

    [Fact]
    public async Task Durable_review_is_idempotent_private_and_has_verified_sources()
    {
        var owner = await TestClient.RegisterAsync(factory, "Workflow Owner"); await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
        var project = await owner.CreateProjectAsync("Delivery review source");
        var other = await owner.AddMemberAsync(factory, ProjectManagement.Domain.Enums.TenantRole.Admin, "Other administrator");
        var request = new { kind = "portfolio", title = "Morning delivery review", idempotencyKey = Guid.NewGuid().ToString() };
        var submitted = await owner.Post("/api/v1/ai/operations/jobs", request); Assert.True(submitted.Ok, submitted.ToString());
        var id = submitted.Data!["id"]!.GetValue<string>();
        var duplicate = await owner.Post("/api/v1/ai/operations/jobs", request); Assert.Equal(id, duplicate.Data!["id"]!.GetValue<string>());
        Assert.Equal(HttpStatusCode.NotFound, (await other.Get($"/api/v1/ai/operations/jobs/{id}")).Status);
        Assert.Equal(HttpStatusCode.Conflict, (await owner.Post("/api/v1/ai/operations/jobs", new { kind = "history", request.title, request.idempotencyKey })).Status);
        await Process();
        var completed = await owner.Get($"/api/v1/ai/operations/jobs/{id}"); Assert.True(completed.Ok, completed.ToString());
        Assert.Equal("succeeded", completed.Data!["status"]!.GetValue<string>());
        Assert.Contains(project.ToString(), completed.Data["result"]!["sources"]!.ToJsonString());
        Assert.Contains("heuristic", completed.Data["result"]!["methodology"]!.GetValue<string>());
        var anotherTenant = await TestClient.RegisterAsync(factory, "Different owner"); await anotherTenant.CreateOrgAsync();
        Assert.Equal(HttpStatusCode.NotFound, (await anotherTenant.Get($"/api/v1/ai/operations/jobs/{id}")).Status);
    }

    [Fact]
    public async Task Cancelled_work_is_not_executed_and_expired_lease_recovers_after_restart()
    {
        var owner = await TestClient.RegisterAsync(factory, "Recovery owner"); await owner.CreateOrgAsync();
        var one = await owner.Post("/api/v1/ai/operations/jobs", new { kind = "history", title = "Cancelled review", idempotencyKey = Guid.NewGuid().ToString() });
        var id = one.Data!["id"]!.GetValue<string>(); await owner.Post($"/api/v1/ai/operations/jobs/{id}/cancel", new { });
        await Process(); Assert.Equal("cancelled", (await owner.Get($"/api/v1/ai/operations/jobs/{id}")).Data!["status"]!.GetValue<string>());
        var two = await owner.Post("/api/v1/ai/operations/jobs", new { kind = "portfolio", title = "Interrupted review", idempotencyKey = Guid.NewGuid().ToString() });
        var interrupted = Guid.Parse(two.Data!["id"]!.GetValue<string>());
        var leaseOwner = Guid.NewGuid();
        var leaseExpiredAt = DateTime.UtcNow.AddMinutes(-3);
        factory.WithDb(db => db.AiJobs.IgnoreQueryFilters().Where(j => j.Id == interrupted).ExecuteUpdate(s => s
            .SetProperty(j => j.Status, "running").SetProperty(j => j.Attempts, 1).SetProperty(j => j.LeaseOwner, leaseOwner)
            .SetProperty(j => j.LeaseExpiresAt, leaseExpiredAt)));
        await Process();
        var result = (await owner.Get($"/api/v1/ai/operations/jobs/{interrupted}")).Data!;
        Assert.Equal("succeeded", result["status"]!.GetValue<string>()); Assert.Equal(2, result["attempts"]!.GetValue<int>());
    }

    [Fact]
    public async Task Worker_rechecks_membership_and_saved_evidence_is_hidden_when_access_changes()
    {
        var owner = await TestClient.RegisterAsync(factory, "Access owner"); await owner.CreateOrgAsync();
        var project = await owner.CreateProjectAsync("Revoked evidence");
        var submitted = await owner.Post("/api/v1/ai/operations/jobs", new { kind = "portfolio", title = "Access review", idempotencyKey = Guid.NewGuid().ToString() });
        var id = submitted.Data!["id"]!.GetValue<string>();
        await Process();
        Assert.NotNull((await owner.Get($"/api/v1/ai/operations/jobs/{id}")).Data!["result"]);
        factory.WithDb(db => db.Projects.IgnoreQueryFilters().Where(p => p.Id == project).ExecuteUpdate(s => s.SetProperty(p => p.IsDeleted, true)));
        var hidden = (await owner.Get($"/api/v1/ai/operations/jobs/{id}")).Data!;
        Assert.Null(hidden["result"]); Assert.Equal("AI_EVIDENCE_ACCESS_CHANGED", hidden["errorCode"]!.GetValue<string>());
        var pending = await owner.Post("/api/v1/ai/operations/jobs", new { kind = "history", title = "Inactive requester", idempotencyKey = Guid.NewGuid().ToString() });
        var pendingId = Guid.Parse(pending.Data!["id"]!.GetValue<string>());
        factory.WithDb(db => db.Users.Where(u => u.Id == owner.UserId).ExecuteUpdate(s => s.SetProperty(u => u.IsActive, false)));
        await Process();
        var rejected = factory.WithDb(db => db.AiJobs.IgnoreQueryFilters().AsNoTracking().Single(j => j.Id == pendingId));
        Assert.Equal("failed", rejected.Status); Assert.Equal("ACCOUNT_INACTIVE", rejected.ErrorCode); Assert.Null(rejected.ResultJson);
    }

    [Fact]
    public async Task Team_review_remains_readable_without_requiring_a_team_header()
    {
        var owner = await TestClient.RegisterAsync(factory, "Scoped review owner"); await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
        var projectId = await owner.CreateProjectAsync("Scoped evidence");
        var team = await owner.Post("/api/v1/teams", new { name = "Scoped review team" }); Assert.True(team.Ok, team.ToString());
        var teamId = Guid.Parse(team.Data!["team"]!["id"]!.GetValue<string>());
        factory.WithDb(db => db.Projects.IgnoreQueryFilters().Where(p => p.Id == projectId).ExecuteUpdate(s => s.SetProperty(p => p.TeamId, teamId)));
        var created = await owner.Post("/api/v1/ai/operations/jobs", new { kind = "portfolio", title = "Team evidence review", teamId, idempotencyKey = Guid.NewGuid().ToString() });
        Assert.True(created.Ok, created.ToString());
        var id = created.Data!["id"]!.GetValue<string>();
        await Process();
        var result = await owner.Get($"/api/v1/ai/operations/jobs/{id}"); Assert.True(result.Ok, result.ToString());
        Assert.Equal("succeeded", result.Data!["status"]!.GetValue<string>()); Assert.NotNull(result.Data["result"]);
    }

    [Fact]
    public async Task Recurring_review_is_saved_and_cannot_queue_duplicate_pending_work()
    {
        var owner = await TestClient.RegisterAsync(factory, "Schedule owner"); await owner.CreateOrgAsync();
        var created = await owner.Post("/api/v1/ai/operations/schedules", new { kind = "portfolio", title = "Daily review", intervalMinutes = 1440 }); Assert.True(created.Ok, created.ToString());
        await Process(); await Process();
        var jobs = await owner.Get("/api/v1/ai/operations/jobs"); Assert.Single(jobs.Data!.AsArray());
        var schedules = await owner.Get("/api/v1/ai/operations/schedules"); Assert.Single(schedules.Data!.AsArray());
        var notices = factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.TenantId == owner.WorkspaceId && n.DedupeKey != null && n.DedupeKey.StartsWith("ai-review:")).ToList());
        Assert.Single(notices); Assert.False(notices[0].EmailPending); Assert.False(notices[0].PushPending);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post("/api/v1/ai/operations/schedules", new { kind = "portfolio", title = "Runaway", intervalMinutes = 1 })).Status);
    }
}
