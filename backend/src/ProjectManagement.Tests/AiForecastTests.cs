using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public class AiForecastTests(ApiFactory factory)
{
    [Fact]
    public async Task Forecasts_are_private_and_evaluated_against_audited_completions_not_model_dates()
    {
        var owner = await TestClient.RegisterAsync(factory, "Forecast owner"); await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
        var project = await owner.CreateProjectAsync("Observed forecast project");
        var other = await owner.AddMemberAsync(factory, ProjectManagement.Domain.Enums.TenantRole.Admin, "Other forecast reader");
        var submitted = await owner.Post("/api/v1/ai/operations/jobs", new { kind = "portfolio", title = "Baseline forecast", idempotencyKey = Guid.NewGuid().ToString() }); Assert.True(submitted.Ok, submitted.ToString());
        await factory.Services.GetRequiredService<AiOperationsProcessor>().ProcessAsync();
        Assert.Equal(1, factory.WithDb(db => db.AiForecastSnapshots.IgnoreQueryFilters().Count(f => f.ProjectId == project)));
        // A historical prediction is seeded; the actual outcome must still come through the application's audited status change.
        var yesterday = DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-1));
        factory.WithDb(db => db.AiForecastSnapshots.IgnoreQueryFilters().Where(f => f.ProjectId == project)
            .ExecuteUpdate(s => s.SetProperty(f => f.ProjectedFinish, yesterday).SetProperty(f => f.InputComplete, true)));
        Assert.Equal(0, (await owner.Get("/api/v1/ai/operations/forecasts")).Data!["verifiedCompletions"]!.GetValue<int>());
        var complete = await owner.Patch($"/api/v1/projects/{project}/move", new { status = "Completed" }); Assert.True(complete.Ok, complete.ToString());
        var evaluated = await owner.Get("/api/v1/ai/operations/forecasts"); Assert.True(evaluated.Ok, evaluated.ToString());
        Assert.Equal(1, evaluated.Data!["verifiedCompletions"]!.GetValue<int>());
        Assert.Equal(1, evaluated.Data["comparableProjects"]!.GetValue<int>());
        Assert.False(evaluated.Data["calibrated"]!.GetValue<bool>());
        var auditId = Guid.Parse(evaluated.Data["items"]![0]!["completionAuditId"]!.GetValue<string>());
        Assert.Equal("Completed", factory.WithDb(db => db.AuditLogs.Single(a => a.Id == auditId).NewValue));
        Assert.Empty((await other.Get("/api/v1/ai/operations/forecasts")).Data!["items"]!.AsArray());
        var reopen = await owner.Patch($"/api/v1/projects/{project}/move", new { status = "Active" }); Assert.True(reopen.Ok, reopen.ToString());
        var reopened = (await owner.Get("/api/v1/ai/operations/forecasts")).Data!;
        Assert.True(reopened["items"]![0]!["reopened"]!.GetValue<bool>()); Assert.Equal(0, reopened["comparableProjects"]!.GetValue<int>());
    }
}
