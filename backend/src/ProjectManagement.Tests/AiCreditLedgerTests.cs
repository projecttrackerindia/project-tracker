using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public class AiCreditLedgerTests(ApiFactory factory)
{
    private IServiceScope Scope(TestClient user)
    {
        var scope = factory.Services.CreateScope();
        var ctx = scope.ServiceProvider.GetRequiredService<CurrentContext>();
        ctx.UserId = user.UserId; ctx.TenantId = user.WorkspaceId; ctx.Role = TenantRole.Owner;
        return scope;
    }

    [Fact]
    public async Task Two_simultaneous_requests_cannot_spend_the_last_credit()
    {
        var owner = await TestClient.RegisterAsync(factory, "Concurrent credit owner"); await owner.CreateOrgAsync();
        factory.WithDb(db => { db.TenantFeatureOverrides.Add(new TenantFeatureOverride { TenantId = owner.WorkspaceId,
            FeatureKey = FeatureKeys.AiMonthlyCredits, Value = 1, Reason = "Atomic credit regression" }); return db.SaveChanges(); });
        using var one = Scope(owner); using var two = Scope(owner);
        var services = new[] { one.ServiceProvider.GetRequiredService<AiCreditService>(), two.ServiceProvider.GetRequiredService<AiCreditService>() };
        var start = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var requests = services.Select(service => Task.Run(async () =>
        {
            await start.Task;
            try { return await service.ReserveAsync(Guid.NewGuid(), 1, "workspace"); }
            catch (ConflictException ex) { Assert.Equal("AI_CREDITS_EXHAUSTED", ex.Code); return null; }
        })).ToArray();
        start.SetResult();
        var results = await Task.WhenAll(requests);
        await using var accepted = Assert.Single(results.Where(r => r is not null))!;
        await accepted.SettleAsync(1);
        Assert.Equal(1, (await services[0].BalanceAsync()).Spent); Assert.Equal(0, (await services[1].BalanceAsync()).Reserved);
    }

    [Fact]
    public async Task In_flight_reservations_prevent_double_spending_and_settlement_is_atomic()
    {
        var owner = await TestClient.RegisterAsync(factory, "Ledger owner"); await owner.CreateOrgAsync();
        factory.WithDb(db => { db.TenantFeatureOverrides.Add(new TenantFeatureOverride { TenantId = owner.WorkspaceId,
            FeatureKey = FeatureKeys.AiMonthlyCredits, Value = 3, Reason = "ledger regression" }); return db.SaveChanges(); });
        using var firstScope = Scope(owner); using var secondScope = Scope(owner);
        var first = firstScope.ServiceProvider.GetRequiredService<AiCreditService>();
        var second = secondScope.ServiceProvider.GetRequiredService<AiCreditService>();
        var operation = Guid.NewGuid();
        await using var lease = await first.ReserveAsync(operation, 2, "workspace");
        var exhausted = await Assert.ThrowsAsync<ConflictException>(() => second.ReserveAsync(Guid.NewGuid(), 2, "workspace"));
        Assert.Equal("AI_CREDITS_EXHAUSTED", exhausted.Code);
        var held = await second.BalanceAsync(); Assert.Equal(2, held.Reserved); Assert.Equal(1, held.Available);
        await lease.SettleAsync(1);
        await lease.SettleAsync(1); // same lease cannot write a second movement
        await using var retry = await second.ReserveAsync(Guid.NewGuid(), 2, "workspace");
        Assert.Equal(0, (await first.BalanceAsync()).Available);
        await retry.SettleAsync(0);
        var final = await first.BalanceAsync(); Assert.Equal(1, final.Spent); Assert.Equal(0, final.Reserved); Assert.Equal(2, final.Available);
        var replay = await Assert.ThrowsAsync<ConflictException>(() => second.ReserveAsync(operation, 2, "workspace"));
        Assert.Equal("AI_OPERATION_ALREADY_ADMITTED", replay.Code);
        var entries = factory.WithDb(db => db.AiCreditEntries.IgnoreQueryFilters().Where(e => e.TenantId == owner.WorkspaceId).AsNoTracking().ToList());
        Assert.Equal(final.Spent, entries.Sum(e => e.SpentDelta)); Assert.Equal(final.Reserved, entries.Sum(e => e.ReservedDelta));
    }

    [Fact]
    public async Task User_budget_blocks_new_usage_and_retains_admission_attribution_when_disabled()
    {
        var owner = await TestClient.RegisterAsync(factory, "Budget owner"); await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Budget member");
        var denied = await member.Get("/api/v1/ai/credits/budgets"); Assert.Equal(System.Net.HttpStatusCode.Forbidden, denied.Status);
        var configured = await owner.Put("/api/v1/ai/credits/budgets", new { scope = "user", subjectId = owner.UserId, monthlyLimit = 1 });
        Assert.True(configured.Ok, configured.ToString());
        using var scope = Scope(owner); var credits = scope.ServiceProvider.GetRequiredService<AiCreditService>();
        await using var first = await credits.ReserveAsync(Guid.NewGuid(), 1, "workspace");
        using (var deniedScope = Scope(owner))
        {
            var rejected = await Assert.ThrowsAsync<ConflictException>(() => deniedScope.ServiceProvider.GetRequiredService<AiCreditService>().ReserveAsync(Guid.NewGuid(), 1, "workspace"));
            Assert.Equal("AI_BUDGET_EXHAUSTED", rejected.Code);
        }
        Assert.True((await owner.Put("/api/v1/ai/credits/budgets", new { scope = "user", subjectId = owner.UserId, monthlyLimit = 1, enabled = false })).Ok);
        await first.SettleAsync(1);
        var response = await owner.Get("/api/v1/ai/credits/budgets"); Assert.True(response.Ok, response.ToString());
        var budget = response.Data!.AsArray().Single()!;
        Assert.Equal(1, budget["spent"]!.GetValue<long>()); Assert.Equal(0, budget["reserved"]!.GetValue<long>());
        Assert.Equal(2, budget["version"]!.GetValue<int>());
        var foreign = await TestClient.RegisterAsync(factory, "Foreign budget subject"); await foreign.CreateOrgAsync();
        Assert.Equal(System.Net.HttpStatusCode.NotFound, (await owner.Put("/api/v1/ai/credits/budgets", new { scope = "user", subjectId = foreign.UserId, monthlyLimit = 1 })).Status);
    }

    [Fact]
    public async Task Team_budget_is_shared_and_restart_recovery_releases_expired_holds()
    {
        var owner = await TestClient.RegisterAsync(factory, "Team budget owner"); await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Team budget member");
        var teamResponse = await owner.Post("/api/v1/teams", new { name = "Delivery budget team" }); Assert.True(teamResponse.Ok, teamResponse.ToString());
        var teamId = teamResponse.Data!["team"]!["id"]!.GetValue<string>();
        Assert.True((await owner.Post($"/api/v1/teams/{teamId}/members", new { userId = owner.UserId, isLead = true })).Ok);
        Assert.True((await owner.Post($"/api/v1/teams/{teamId}/members", new { userId = member.UserId, isLead = false })).Ok);
        Assert.True((await owner.Put("/api/v1/ai/credits/budgets", new { scope = "team", subjectId = teamId, monthlyLimit = 1 })).Ok);
        using var firstScope = Scope(owner); using var secondScope = Scope(member);
        var operation = Guid.NewGuid();
        await using var held = await firstScope.ServiceProvider.GetRequiredService<AiCreditService>().ReserveAsync(operation, 1, "workspace");
        var blocked = await Assert.ThrowsAsync<ConflictException>(() => secondScope.ServiceProvider.GetRequiredService<AiCreditService>().ReserveAsync(Guid.NewGuid(), 1, "workspace"));
        Assert.Equal("AI_BUDGET_EXHAUSTED", blocked.Code);
        var expiredAt = firstScope.ServiceProvider.GetRequiredService<ProjectManagement.Application.Services.AppClock>().Now.AddMinutes(-1);
        factory.WithDb(db => db.AiCreditReservations.IgnoreQueryFilters().Where(r => r.OperationId == operation).ExecuteUpdate(s => s.SetProperty(r => r.ExpiresAt, expiredAt)));
        await factory.Services.GetRequiredService<AiOperationsProcessor>().ProcessAsync();
        using var recoveredScope = Scope(member);
        await using var resumed = await recoveredScope.ServiceProvider.GetRequiredService<AiCreditService>().ReserveAsync(Guid.NewGuid(), 1, "workspace");
        await resumed.SettleAsync(1);
        var report = await owner.Get("/api/v1/ai/credits/budgets"); Assert.True(report.Ok, report.ToString());
        var budget = report.Data!.AsArray().Single()!;
        Assert.Equal(1, budget["spent"]!.GetValue<long>()); Assert.Equal(0, budget["reserved"]!.GetValue<long>());
    }

    [Fact]
    public async Task Inference_cannot_hold_the_request_receipt_transaction_across_a_model_call()
    {
        var owner = await TestClient.RegisterAsync(factory, "Inference transaction owner"); await owner.CreateOrgAsync();
        using var request = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Post, "/api/v1/ai/portfolio-summary")
        { Content = System.Net.Http.Json.JsonContent.Create(new { }) };
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", owner.Token);
        request.Headers.Add("Idempotency-Key", Guid.NewGuid().ToString());
        using var response = await owner.Http.SendAsync(request);
        Assert.Equal(System.Net.HttpStatusCode.UnprocessableEntity, response.StatusCode);
        Assert.Contains("IDEMPOTENCY_UNSUPPORTED", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task One_shot_features_share_the_ledger_and_malformed_answers_are_not_charged()
    {
        var owner = await TestClient.RegisterAsync(factory, "Feature ledger owner"); await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
        var project = await owner.CreateProjectAsync("Feature accounting");
        factory.Ai.Reset(); factory.Ai.Configured = true; factory.Ai.Answer = (_, _) => "A summary of current authorized projects.";
        try
        {
            var summary = await owner.Post("/api/v1/ai/portfolio-summary", new { }); Assert.True(summary.Ok, summary.ToString());
            var balance = (await owner.Get("/api/v1/ai/credits/balance")).Data!;
            Assert.Equal(1, balance["spent"]!.GetValue<long>()); Assert.Equal(0, balance["reserved"]!.GetValue<long>());
            factory.Ai.Answer = (_, _) => "invalid structured response";
            Assert.Equal(System.Net.HttpStatusCode.BadGateway, (await owner.Post($"/api/v1/ai/projects/{project}/risk", new { })).Status);
            Assert.Equal(1, (await owner.Get("/api/v1/ai/credits/balance")).Data!["spent"]!.GetValue<long>());
            var report = await owner.Get("/api/v1/ai/usage/report"); Assert.True(report.Ok, report.ToString());
            Assert.Equal(1, report.Data!["creditsUsed"]!.GetValue<long>());
            Assert.Contains("portfolio_summary", report.Data["features"]!.ToJsonString());
        }
        finally { factory.Ai.Reset(); }
    }

    [Fact]
    public async Task Abandoned_work_releases_credits_and_ledger_is_append_only()
    {
        var owner = await TestClient.RegisterAsync(factory, "Abandoned usage"); await owner.CreateOrgAsync();
        using var scope = Scope(owner); var credits = scope.ServiceProvider.GetRequiredService<AiCreditService>();
        await using (var lease = await credits.ReserveAsync(Guid.NewGuid(), 1, "workspace"))
            Assert.Equal(1, (await credits.BalanceAsync()).Reserved);
        Assert.Equal(0, (await credits.BalanceAsync()).Reserved);
        factory.WithDb(db =>
        {
            var entry = db.AiCreditEntries.IgnoreQueryFilters().First(e => e.TenantId == owner.WorkspaceId);
            entry.SpentDelta = 900;
            Assert.Throws<InvalidOperationException>(() => db.SaveChanges());
            return 0;
        });
    }
}
