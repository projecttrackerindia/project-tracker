using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

public sealed partial class AiMessageSendingTests
{
    [Fact]
    public Task Leave_is_proposed_then_confirmed_for_two_people_without_logging_worked_hours() => Run(async (sender, colleague) =>
    {
        var from = DateOnly.FromDateTime(DateTime.UtcNow).AddDays(8);
        var to = from.AddDays(1);
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.PlanLeave, new { people = new[] { "me", "Sivareddy" }, from_date = from.ToString("yyyy-MM-dd"), to_date = to.ToString("yyyy-MM-dd"), note = "Handover prepared; approval requested separately." }));
        var reply = await Ask(sender, "Plan leave in timesheets for me and Sivareddy for the same two dates");
        Assert.Equal("planned_leave", reply["actions"]![0]!["kind"]!.GetValue<string>());
        Assert.Equal(0, factory.WithDb(db => db.PlannedLeaves.IgnoreQueryFilters().Count(l => l.TenantId == sender.WorkspaceId)));
        var confirmed = await sender.Post(ConfirmUrl(reply)); Assert.True(confirmed.Ok, confirmed.ToString());
        Assert.Equal(HttpStatusCode.Conflict, (await sender.Post(ConfirmUrl(reply))).Status);
        Assert.Equal(4, factory.WithDb(db => db.PlannedLeaves.IgnoreQueryFilters().Count(l => l.TenantId == sender.WorkspaceId)));
        foreach (var person in new[] { sender, colleague })
        {
            var leaves = await person.Get($"/api/v1/time/leave?from={from:yyyy-MM-dd}&to={to:yyyy-MM-dd}");
            Assert.True(leaves.Ok, leaves.ToString()); Assert.Equal(2, leaves.Data!.AsArray().Count);
            Assert.All(leaves.Data.AsArray(), l => Assert.Equal("Planned", l!["status"]!.GetValue<string>()));
            var sheet = await person.Get($"/api/v1/time?from={from:yyyy-MM-dd}&to={to:yyyy-MM-dd}");
            Assert.Equal(0, sheet.Data!["totalMinutes"]!.GetValue<int>()); Assert.Equal(0, sheet.Data!["billableMinutes"]!.GetValue<int>());
        }
    });

    [Fact]
    public Task Leave_permission_is_rechecked_when_the_card_is_confirmed() => Run(async (owner, member) =>
    {
        var date = DateOnly.FromDateTime(DateTime.UtcNow).AddDays(8).ToString("yyyy-MM-dd");
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.PlanLeave, new { people = new[] { "me", "Sivareddy" }, from_date = date, to_date = date }));
        var reply = await Ask(owner, "Add planned leave for me and Sivareddy");
        Assert.Single(reply["actions"]!.AsArray());
        factory.WithDb(db => { var m = db.TenantMembers.IgnoreQueryFilters().Single(m => m.TenantId == owner.WorkspaceId && m.UserId == owner.UserId); m.Role = ProjectManagement.Domain.Enums.TenantRole.Member; db.SaveChanges(); return 0; });
        var result = await owner.Post(ConfirmUrl(reply));
        Assert.True(result.Ok, result.ToString());
        Assert.Equal("failed", result.Data!["status"]!.GetValue<string>());
        Assert.Equal(0, factory.WithDb(db => db.PlannedLeaves.IgnoreQueryFilters().Count(l => l.TenantId == owner.WorkspaceId)));
    });

    [Fact]
    public Task A_member_cannot_plan_or_read_another_members_leave() => Run(async (owner, member) =>
    {
        var day = DateOnly.FromDateTime(DateTime.UtcNow).AddDays(8).ToString("yyyy-MM-dd");
        var denied = await member.Post("/api/v1/time/leave", new { userIds = new[] { owner.UserId }, from = day, to = day, requestId = Guid.NewGuid() });
        Assert.Equal(HttpStatusCode.Forbidden, denied.Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get($"/api/v1/time/leave?from={day}&to={day}&userId={owner.UserId}")).Status);
    });

    [Fact]
    public Task Leave_retries_are_idempotent_overlaps_rejected_and_cancelled_requests_cannot_replay() => Run(async (owner, _) =>
    {
        var day = DateOnly.FromDateTime(DateTime.UtcNow).AddDays(8).ToString("yyyy-MM-dd");
        var request = new { userIds = new[] { owner.UserId }, from = day, to = day, note = "Personal leave", requestId = Guid.NewGuid() };
        var first = await owner.Post("/api/v1/time/leave", request); Assert.True(first.Ok, first.ToString());
        var again = await owner.Post("/api/v1/time/leave", request); Assert.True(again.Ok, again.ToString());
        Assert.Equal(first.Data![0]!["id"]!.ToString(), again.Data![0]!["id"]!.ToString());
        Assert.Equal(HttpStatusCode.Conflict, (await owner.Post("/api/v1/time/leave", new { request.userIds, request.from, request.to, request.note, requestId = Guid.NewGuid() })).Status);
        Assert.True((await owner.Send(HttpMethod.Delete, $"/api/v1/time/leave/{first.Data[0]!["id"]}")).Ok);
        Assert.Equal(HttpStatusCode.Conflict, (await owner.Post("/api/v1/time/leave", request)).Status);
        Assert.Empty((await owner.Get($"/api/v1/time/leave?from={day}&to={day}")).Data!.AsArray());
    });

    [Fact]
    public Task Leave_is_tenant_isolated_and_retired_support_endpoints_are_absent() => Run(async (owner, _) =>
    {
        var outsider = await TestClient.RegisterAsync(factory, "Other organization"); await outsider.CreateOrgAsync(); await outsider.UpgradeAsync("BUSINESS");
        var day = DateOnly.FromDateTime(DateTime.UtcNow).AddDays(8).ToString("yyyy-MM-dd");
        var saved = await owner.Post("/api/v1/time/leave", new { userIds = new[] { owner.UserId }, from = day, to = day, requestId = Guid.NewGuid() }); Assert.True(saved.Ok, saved.ToString());
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Get($"/api/v1/time/leave?from={day}&to={day}&userId={owner.UserId}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Send(HttpMethod.Delete, $"/api/v1/time/leave/{saved.Data![0]!["id"]}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Get("/api/v1/support/tickets")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Get("/api/v1/support/workflows")).Status);
    });

    [Fact]
    public Task Submitted_timesheet_weeks_cannot_receive_planned_leave() => Run(async (owner, _) =>
    {
        // Use the same workspace date as the API; UTC can still be yesterday in India.
        var from = factory.Services.GetRequiredService<ProjectManagement.Application.Services.AppClock>().Today;
        var week = ProjectManagement.Application.Features.Time.TimesheetApprovalService.WeekOf(from);
        var submitted = await owner.Post("/api/v1/time/week/submit", new { weekStart = week.ToString("yyyy-MM-dd"), note = "Ready" }); Assert.True(submitted.Ok, submitted.ToString());
        var leave = await owner.Post("/api/v1/time/leave", new { userIds = new[] { owner.UserId }, from = from.ToString("yyyy-MM-dd"), to = from.ToString("yyyy-MM-dd"), requestId = Guid.NewGuid() });
        Assert.Equal(HttpStatusCode.Conflict, leave.Status);
        Assert.Equal("TIMESHEET_LOCKED", leave.ErrorCode);
    });
}
