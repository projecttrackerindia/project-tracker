using System.Net;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public class WorkAndBillingTests(ApiFactory factory)
{
    // ------------------------------------------------------------------ entitlements & limits

    [Fact]
    public async Task Free_plan_project_limit_is_enforced_by_the_api()
    {
        var c = await TestClient.RegisterAsync(factory);
        for (var i = 0; i < 5; i++) await c.CreateProjectAsync($"Free project {i}");

        var sixth = await c.Post("/api/v1/projects", new { name = "One too many", priority = "Low" });
        Assert.Equal(HttpStatusCode.Forbidden, sixth.Status);
        Assert.Equal("PLAN_LIMIT_REACHED", sixth.ErrorCode);

        await c.UpgradeAsync("PRO");
        Assert.True((await c.Post("/api/v1/projects", new { name = "Now allowed", priority = "Low" })).Ok);
    }

    [Fact]
    public async Task Free_plan_task_limit_is_enforced()
    {
        var c = await TestClient.RegisterAsync(factory);
        var project = await c.CreateProjectAsync();
        // Lower the limit to keep the test fast (configurable per plan, spec section 30).
        factory.WithDb(db =>
        {
            db.PlanFeatures.Single(f => f.FeatureKey == "TASK_LIMIT" && db.Plans.Any(p => p.Id == f.PlanId && p.Code == "FREE")).Value = 3;
            db.SaveChanges();
            return 0;
        });
        try
        {
            for (var i = 0; i < 3; i++) await c.CreateTaskAsync(project, $"t{i}");
            var over = await c.Post($"/api/v1/projects/{project}/tasks", new { title = "t4", priority = "Low" });
            Assert.Equal("PLAN_LIMIT_REACHED", over.ErrorCode);
        }
        finally
        {
            factory.WithDb(db =>
            {
                db.PlanFeatures.Single(f => f.FeatureKey == "TASK_LIMIT" && db.Plans.Any(p => p.Id == f.PlanId && p.Code == "FREE")).Value = 500;
                db.SaveChanges();
                return 0;
            });
        }
    }

    [Fact]
    public async Task A_lapsed_subscription_falls_back_to_free_limits()
    {
        var c = await TestClient.RegisterAsync(factory);
        var orgId = await c.CreateOrgAsync();
        await c.UpgradeAsync("PRO");
        for (var i = 0; i < 6; i++) await c.CreateProjectAsync(); // > 5 is fine on Pro
        Assert.True((await c.Post("/api/v1/projects", new { name = "still fine", priority = "Low" })).Ok);

        factory.WithDb(db =>
        {
            var sub = db.Subscriptions.Single(s => s.TenantId == orgId);
            sub.Status = SubscriptionStatus.Expired;
            db.SaveChanges();
            return 0;
        });

        var blocked = await c.Post("/api/v1/projects", new { name = "over the free limit", priority = "Low" });
        Assert.Equal("PLAN_LIMIT_REACHED", blocked.ErrorCode);
        var ctx = (await c.Get("/api/v1/me")).Data!["current"]!;
        Assert.Equal("FREE", ctx["plan"]!["code"]!.GetValue<string>());
        Assert.True(ctx["plan"]!["downgraded"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Feature_gated_endpoints_reject_plans_without_the_feature()
    {
        var c = await TestClient.RegisterAsync(factory);
        var orgId = await c.CreateOrgAsync();
        var project = await c.CreateProjectAsync();

        var audit = await c.Get("/api/v1/audit-logs");
        Assert.Equal("FEATURE_NOT_AVAILABLE", audit.ErrorCode);
        var status = await c.Post($"/api/v1/projects/{project}/statuses", new { name = "QA", category = "Active" });
        Assert.Equal("FEATURE_NOT_AVAILABLE", status.ErrorCode);
        var perm = await c.Put("/api/v1/workspace/permissions", new { role = "Member", permission = "projects.create", allowed = false });
        Assert.Equal("FEATURE_NOT_AVAILABLE", perm.ErrorCode);

        await c.UpgradeAsync("BUSINESS");
        Assert.True((await c.Get("/api/v1/audit-logs")).Ok);
        Assert.True((await c.Post($"/api/v1/projects/{project}/statuses", new { name = "QA", category = "Active" })).Ok);
        Assert.True((await c.Put("/api/v1/workspace/permissions", new { role = "Member", permission = "projects.create", allowed = false })).Ok);
    }

    [Fact]
    public async Task There_is_no_Blocked_status_or_category_or_count_anywhere()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        await c.UpgradeAsync("BUSINESS");
        var project = await c.CreateProjectAsync();

        // Not in a new project's workflow, and not something a workflow can be given.
        var statuses = (await c.Get($"/api/v1/projects/{project}/statuses")).Data!.AsArray();
        Assert.DoesNotContain(statuses, s => s!["name"]!.GetValue<string>() == "Blocked" || s["category"]!.GetValue<string>() == "Blocked");
        Assert.False((await c.Post($"/api/v1/projects/{project}/statuses", new { name = "On hold", category = "Blocked" })).Ok);

        // Not a count on the project or in the reports summary.
        var detail = (await c.Get($"/api/v1/projects/{project}")).Data!;
        Assert.Null(detail["project"]!["stats"]!["blocked"]);
        Assert.Null(detail["stages"]![0]!["blockedReason"]);
        var summary = await c.Get("/api/v1/reports/summary");
        Assert.True(summary.Ok, summary.ToString());
        Assert.Null(summary.Data!["totals"]!["blocked"]);
    }

    [Fact]
    public async Task The_workflow_can_be_reordered_in_one_call_and_the_board_follows()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        var project = await c.CreateProjectAsync();
        var url = $"/api/v1/projects/{project}/statuses";
        var ids = (await c.Get(url)).Data!.AsArray().Select(s => s!["id"]!.GetValue<string>()).ToList();

        // Plan without custom workflows: refused, like every other workflow edit.
        Assert.Equal("FEATURE_NOT_AVAILABLE", (await c.Put($"{url}/order", new { statusIds = ids })).ErrorCode);
        await c.UpgradeAsync("BUSINESS");

        var flipped = Enumerable.Reverse(ids).ToList();
        var res = await c.Put($"{url}/order", new { statusIds = flipped });
        Assert.True(res.Ok, res.ToString());
        Assert.Equal(flipped, res.Data!.AsArray().Select(s => s!["id"]!.GetValue<string>()).ToList());
        Assert.Equal(flipped, (await c.Get(url)).Data!.AsArray().Select(s => s!["id"]!.GetValue<string>()).ToList());
        Assert.Contains("Reordered the workflow", (await c.Get($"/api/v1/projects/{project}/activity")).Data!.ToJsonString());

        // Every status exactly once: missing, repeated and foreign ids are refused and nothing changes.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Put($"{url}/order", new { statusIds = ids.Skip(1) })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Put($"{url}/order", new { statusIds = ids.Append(ids[0]) })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Put($"{url}/order", new { statusIds = ids.Skip(1).Append(Guid.NewGuid().ToString()) })).Status);
        Assert.Equal(flipped, (await c.Get(url)).Data!.AsArray().Select(s => s!["id"]!.GetValue<string>()).ToList());
    }

    [Fact]
    public async Task Member_limit_counts_pending_invitations()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        // Free plan: 1 member (the owner) -> no invitations possible until upgrade.
        var blocked = await c.Post("/api/v1/workspace/invitations", new { email = "a@example.com", role = "Member" });
        Assert.Equal("PLAN_LIMIT_REACHED", blocked.ErrorCode);
        await c.UpgradeAsync("PRO");
        Assert.True((await c.Post("/api/v1/workspace/invitations", new { email = "a@example.com", role = "Member" })).Ok);
        var dup = await c.Post("/api/v1/workspace/invitations", new { email = "A@example.com", role = "Member" });
        Assert.Equal("INVITATION_PENDING", dup.ErrorCode);
    }

    [Fact]
    public async Task Cancelled_subscriptions_keep_access_until_the_period_ends()
    {
        var c = await TestClient.RegisterAsync(factory);
        var orgId = await c.CreateOrgAsync();
        await c.UpgradeAsync("PRO");
        var cancel = await c.Post("/api/v1/billing/cancel");
        Assert.True(cancel.Ok, cancel.ToString());
        Assert.Equal("Cancelled", cancel.Data!["plan"]!["status"]!.GetValue<string>());
        Assert.Equal("PRO", cancel.Data["plan"]!["code"]!.GetValue<string>()); // still on Pro until period end

        Assert.True((await c.Post("/api/v1/billing/resume")).Ok);
        Assert.Equal("Active", (await c.Get("/api/v1/billing")).Data!["plan"]!["status"]!.GetValue<string>());
    }

    // ------------------------------------------------------------------ work items

    [Fact]
    public async Task Tasks_move_between_statuses_and_completion_is_tracked()
    {
        var c = await TestClient.RegisterAsync(factory);
        var project = await c.CreateProjectAsync();
        var statuses = (await c.Get($"/api/v1/projects/{project}/statuses")).Data!.AsArray();
        var todo = statuses.First(s => s!["category"]!.GetValue<string>() == "Todo")!["id"]!.GetValue<string>();
        var done = statuses.First(s => s!["category"]!.GetValue<string>() == "Done")!["id"]!.GetValue<string>();

        var task = await c.CreateTaskAsync(project, "Ship it");
        Assert.Equal(todo, task["statusId"]!.GetValue<string>());
        Assert.Null(task["completedAt"]);
        Assert.Matches(@"^[A-Z0-9]+-1$", task["key"]!.GetValue<string>());

        var moved = await c.Send(HttpMethod.Patch, $"/api/v1/tasks/{task["id"]!.GetValue<string>()}/move", new { statusId = done });
        Assert.True(moved.Ok, moved.ToString());
        Assert.NotNull(moved.Data!["completedAt"]);

        var progress = (await c.Get($"/api/v1/projects/{project}")).Data!["project"]!["progress"]!.GetValue<int>();
        Assert.Equal(100, progress);

        // A status from another project is rejected.
        var otherProject = await c.CreateProjectAsync();
        var foreign = (await c.Get($"/api/v1/projects/{otherProject}/statuses")).Data!.AsArray()[0]!["id"]!.GetValue<string>();
        var bad = await c.Send(HttpMethod.Patch, $"/api/v1/tasks/{task["id"]!.GetValue<string>()}/move", new { statusId = foreign });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, bad.Status);
    }

    [Fact]
    public async Task Stale_versions_are_rejected_with_409()
    {
        var c = await TestClient.RegisterAsync(factory);
        var project = await c.CreateProjectAsync();
        var task = await c.CreateTaskAsync(project, "Racy");
        var id = task["id"]!.GetValue<string>();
        object Update(string title, int version) => new { title, description = (string?)null, statusId = task["statusId"]!.GetValue<string>(), priority = "High", assigneeId = (string?)null, version };

        var first = await c.Put($"/api/v1/tasks/{id}", Update("Edited by A", task["version"]!.GetValue<int>()));
        Assert.True(first.Ok, first.ToString());
        var stale = await c.Put($"/api/v1/tasks/{id}", Update("Edited by B", task["version"]!.GetValue<int>()));
        Assert.Equal(HttpStatusCode.Conflict, stale.Status);
        Assert.Equal("VERSION_CONFLICT", stale.ErrorCode);

        var detail = (await c.Get($"/api/v1/projects/{project}")).Data!["project"]!;
        var staleProject = await c.Put($"/api/v1/projects/{project}", new
        {
            name = "Renamed", priority = "Low", status = "Active", version = detail["version"]!.GetValue<int>() - 1,
        });
        Assert.Equal(HttpStatusCode.Conflict, staleProject.Status);
    }

    [Fact]
    public async Task Subtasks_comments_mentions_and_notifications_work_together()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olive");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mo");
        var project = await owner.CreateProjectAsync();

        var parent = await owner.CreateTaskAsync(project, "Parent", new { title = "Parent", priority = "High", assigneeId = member.UserId });
        var parentId = parent["id"]!.GetValue<string>();
        // Assigning notifies the assignee.
        Assert.Equal(1, (await member.Get("/api/v1/notifications/unread-count")).Data!["count"]!.GetValue<int>());

        var sub = await owner.CreateTaskAsync(project, "Child", new { title = "Child", priority = "Low", parentTaskId = parentId });
        Assert.Equal(parentId, sub["parentTaskId"]!.GetValue<string>());
        var nested = await owner.Post($"/api/v1/projects/{project}/tasks", new { title = "Grandchild", priority = "Low", parentTaskId = sub["id"]!.GetValue<string>() });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, nested.Status); // one level of nesting only

        var detail = (await owner.Get($"/api/v1/tasks/{parentId}")).Data!;
        Assert.Single(detail["subtasks"]!.AsArray());

        var comment = await owner.Post($"/api/v1/tasks/{parentId}/comments", new { body = "@Mo please review", mentionUserIds = new[] { member.UserId } });
        Assert.Equal(HttpStatusCode.Created, comment.Status);
        var notes = (await member.Get("/api/v1/notifications")).Data!["items"]!.AsArray();
        Assert.Contains(notes, n => n!["type"]!.GetValue<string>() == "Mention");

        var mark = await member.Post("/api/v1/notifications/read-all");
        Assert.Equal(HttpStatusCode.NoContent, mark.Status);
        Assert.Equal(0, (await member.Get("/api/v1/notifications/unread-count")).Data!["count"]!.GetValue<int>());

        // Only the author can edit a comment.
        var commentId = comment.Data!["id"]!.GetValue<string>();
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Put($"/api/v1/comments/{commentId}", new { body = "hijack" })).Status);
        Assert.True((await owner.Put($"/api/v1/comments/{commentId}", new { body = "edited" })).Ok);
    }

    [Fact]
    public async Task Assignees_must_belong_to_the_workspace()
    {
        var a = await TestClient.RegisterAsync(factory);
        var outsider = await TestClient.RegisterAsync(factory);
        await a.CreateOrgAsync();
        var project = await a.CreateProjectAsync();

        var res = await a.Post($"/api/v1/projects/{project}/tasks", new { title = "x", priority = "Low", assigneeId = outsider.UserId });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.Status);
        Assert.Equal("assigneeId", res.Json!["errors"]![0]!["field"]!.GetValue<string>());
    }

    [Fact]
    public async Task Deleting_a_project_hides_it_and_its_tasks()
    {
        var c = await TestClient.RegisterAsync(factory);
        var project = await c.CreateProjectAsync();
        var task = await c.CreateTaskAsync(project, "Doomed");

        Assert.Equal(HttpStatusCode.NoContent, (await c.Delete($"/api/v1/projects/{project}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await c.Get($"/api/v1/projects/{project}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await c.Get($"/api/v1/tasks/{task["id"]!.GetValue<string>()}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await c.Get($"/api/v1/projects/{project}/tasks?includeSubtasks=true")).Status);
    }

    [Fact]
    public async Task Timeline_stages_are_data_driven_and_report_delays()
    {
        var c = await TestClient.RegisterAsync(factory);
        var start = DateTime.UtcNow.AddDays(-60).ToString("yyyy-MM-dd");
        var due = DateTime.UtcNow.AddDays(-20).ToString("yyyy-MM-dd");
        var res = await c.Post("/api/v1/projects", new { name = "Late project", priority = "High", status = "Active", startDate = start, dueDate = due });
        Assert.True(res.Ok, res.ToString());
        var stages = res.Data!["stages"]!.AsArray();
        Assert.Equal(8, stages.Count);
        Assert.Equal("Completed", stages[0]!["status"]!.GetValue<string>());
        // Overdue planned stages that are still open surface as Delayed without changing stored data.
        Assert.Contains(stages, s => s!["effectiveStatus"]!.GetValue<string>() == "Delayed");
        Assert.Equal("Delayed", res.Data["project"]!["health"]!.GetValue<string>());

        var projectId = res.Data["project"]!["id"]!.GetValue<string>();
        var stageId = stages[3]!["id"]!.GetValue<string>();
        Assert.False((await c.Put($"/api/v1/projects/{projectId}/stages/{stageId}", new { name = "Code Review", status = "Blocked" })).Ok); // no such stage status any more
        // Code Review sits behind Development, which is not finished, so it cannot be started yet; the stage that is up next can.
        var early = await c.Put($"/api/v1/projects/{projectId}/stages/{stageId}", new { name = "Code Review", status = "InProgress" });
        Assert.Equal("STAGE_PREVIOUS_INCOMPLETE", early.ErrorCode);
        var ok = await c.Put($"/api/v1/projects/{projectId}/stages/{stages[1]!["id"]!.GetValue<string>()}", new { name = "Requirements & Planning", status = "InProgress" });
        Assert.True(ok.Ok, ok.ToString());
    }

    /// <summary>Every export goes through the one report writer (the old instant tasks.csv endpoint is gone), which neutralises formulas.</summary>
    [Fact]
    public async Task Csv_export_neutralises_formula_injection()
    {
        var c = await TestClient.RegisterAsync(factory);
        var project = await c.CreateProjectAsync();
        await c.CreateTaskAsync(project, "=HYPERLINK(\"http://evil\",\"x\")");
        Assert.Equal(HttpStatusCode.NotFound, (await c.Raw("/api/v1/reports/tasks.csv")).StatusCode);

        var requested = await c.Post("/api/v1/reports/exports", new { kind = "Project", format = "Csv" });
        Assert.Equal(HttpStatusCode.Accepted, requested.Status);
        await factory.Services.GetRequiredService<ProjectManagement.Application.Features.Reports.ReportExportProcessor>().ProcessPendingAsync();
        var res = await c.Raw($"/api/v1/reports/exports/{requested.Data!["id"]!.GetValue<string>()}/file");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var csv = await res.Content.ReadAsStringAsync();
        Assert.DoesNotContain(",=HYPERLINK", csv);
        Assert.Contains("'=HYPERLINK", csv);
    }

    [Fact]
    public async Task Validation_errors_use_the_standard_envelope()
    {
        var c = await TestClient.RegisterAsync(factory);
        var res = await c.Post("/api/v1/projects", new { name = "", priority = "Low" });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.Status);
        Assert.False(res.Json!["success"]!.GetValue<bool>());
        Assert.Equal("name", res.Json["errors"]![0]!["field"]!.GetValue<string>());
        Assert.NotNull(res.Json["traceId"]);

        var notFound = await c.Get($"/api/v1/projects/{Guid.NewGuid()}");
        Assert.Equal(HttpStatusCode.NotFound, notFound.Status);
        var health = await c.Http.GetAsync("/health/ready");
        Assert.Equal(HttpStatusCode.OK, health.StatusCode);
    }
}
