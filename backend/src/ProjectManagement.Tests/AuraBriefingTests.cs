using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Insights;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The rules behind Aura's morning briefing, without a database: the order of what needs you, and the one reason work is at risk.</summary>
public class AuraBriefingRulesTests
{
    private static readonly DateOnly Today = new(2026, 11, 5);

    [Fact]
    public void Approvals_come_before_unblocking_before_due_today_before_overdue()
    {
        var needs = new[]
        {
            new AuraBriefingRules.Need("c", "overdue", 9),
            new AuraBriefingRules.Need("b", "due", 0),
            new AuraBriefingRules.Need("d", "unblock", 0, 2),
            new AuraBriefingRules.Need("a", "approval", 1),
            new AuraBriefingRules.Need("e", "review", 0),
        };
        Assert.Equal(["a", "e", "d", "b", "c"], AuraBriefingRules.Rank(needs, n => n).Select(n => n.Id));
        Assert.Equal("3 things need you today", AuraBriefingRules.Headline(7));
        Assert.Equal("1 thing needs you today", AuraBriefingRules.Headline(1));
        Assert.Equal("Nothing needs you today", AuraBriefingRules.Headline(0));
    }

    [Fact]
    public void A_slipped_dependency_beats_an_overdue_owner_beats_a_moving_date()
    {
        var slipped = AuraBriefingRules.Assess(new(Today.AddDays(2), Today, false, "Nia Vale", 3,
            new AuraBriefingRules.Blocker("ORB-4", "Vendor API", Today.AddDays(6), false), new(Today, Today.AddDays(2), "Scope grew"), 1))!;
        Assert.Equal("dependency", slipped.Kind);
        Assert.Contains("ORB-4", slipped.Why);
        Assert.Contains("slipped to 11 Nov", slipped.Why);

        var owner = AuraBriefingRules.Assess(new(Today.AddDays(-3), Today, false, "Nia Vale", 4, null, null, 0))!;
        Assert.Equal("owner", owner.Kind);
        Assert.Equal("reassign", owner.Verb);
        Assert.Equal("3 days overdue · Nia has 4 overdue.", owner.Why);

        var moved = AuraBriefingRules.Assess(new(Today.AddDays(3), Today, true, "Me Self", 0, null, new(Today, Today.AddDays(3), "Waiting on legal"), 2))!;
        Assert.Equal("extension", moved.Kind);
        Assert.Contains("Moved 2 times: 5 Nov → 8 Nov — “Waiting on legal”", moved.Why);

        // A finished dependency, a date far away and nothing moved: no risk.
        Assert.Null(AuraBriefingRules.Assess(new(Today.AddDays(20), Today, true, "Me Self", 0, new("ORB-1", "Done thing", Today.AddDays(30), true), null, 0)));
    }
}

/// <summary>
/// Aura's briefing, meeting review, Friday report and "why is it late?" through the API: what needs the person (approvals addressed to them first,
/// each with one action), what is at risk with its reason, approving a meeting's drafted tasks with edits, the Friday draft and its notice, and an
/// answer that cites the date changes and dependencies it used. Fictional people and projects only.
/// </summary>
[Collection("api")]
public class AuraBriefingTests(ApiFactory factory)
{
    private DateOnly ServerToday()
    {
        using var scope = factory.Services.CreateScope();
        return scope.ServiceProvider.GetRequiredService<ProjectManagement.Application.Services.AppClock>().TodayIn((string?)null);
    }

    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<(TestClient Owner, TestClient Dev, Guid Project, string Key)> SetupAsync(string name)
    {
        var owner = await TestClient.RegisterAsync(factory, "Orla Finch");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Tamsin Reed");
        var project = await owner.CreateProjectAsync(name);
        var key = factory.WithDb(db => db.Projects.IgnoreQueryFilters().First(p => p.Id == project).Key);
        return (owner, dev, project, key);
    }

    private async Task<Guid> TaskAsync(TestClient c, Guid project, string title, Guid? assignee) =>
        Guid.Parse(S((await c.CreateTaskAsync(project, title, assignee is { } a ? new { title, priority = "Medium", assigneeId = a } : new { title, priority = "Medium" }))["id"]));

    [Fact]
    public async Task Briefing_puts_approvals_first_and_explains_risk_with_one_action_each()
    {
        var (owner, dev, project, key) = await SetupAsync("Orbit Launch");
        var mine = await TaskAsync(owner, project, "Sign off the launch copy", owner.UserId);
        var vendor = await TaskAsync(owner, project, "Vendor API ready", null);
        var wire = await TaskAsync(owner, project, "Wire the checkout", owner.UserId);
        var late = await TaskAsync(owner, project, "Migrate old orders", dev.UserId);
        var approval = await dev.Post("/api/v1/approvals", new { type = "Access", title = "Prod read access for Tamsin", chain = new object[] { new { role = "Admin", userId = owner.UserId } } });
        Assert.True(approval.Ok, approval.ToString());

        factory.WithDb(db =>
        {
            var today = ServerToday();   // the app's calendar day (its zone), not UTC: they differ for part of every day
            var tasks = db.Tasks.IgnoreQueryFilters().Where(t => t.ProjectId == project).ToList();
            tasks.First(t => t.Id == mine).DueDate = today;
            tasks.First(t => t.Id == wire).DueDate = today.AddDays(3);
            tasks.First(t => t.Id == vendor).DueDate = today.AddDays(9);
            tasks.First(t => t.Id == late).DueDate = today.AddDays(-4);
            db.TaskDependencies.Add(new TaskDependency { TenantId = owner.WorkspaceId, TaskId = wire, DependsOnTaskId = vendor, Type = DependencyType.FinishToStart });
            db.DueDateChanges.Add(new DueDateChange { TenantId = owner.WorkspaceId, ProjectId = project, TaskId = late, Previous = today.AddDays(-8), Revised = today.AddDays(-4),
                Reason = "Old export was corrupt", CreatedAt = DateTime.UtcNow.AddDays(-6), CreatedBy = dev.UserId, EntityType = "Task", EntityId = late, Field = "dueDate" });
            return db.SaveChanges();
        });

        var res = await owner.Get("/api/v1/aura/briefing");
        Assert.True(res.Ok, res.ToString());
        var b = res.Data!;
        var needs = b["needsYou"]!.AsArray();
        Assert.True(needs.Count is >= 2 and <= 3);
        Assert.Equal("approval", S(needs[0]!["kind"]));
        Assert.Equal("approve", S(needs[0]!["action"]!["verb"]));
        Assert.StartsWith("/api/v1/approvals/", S(needs[0]!["action"]!["endpoint"]));
        Assert.Contains(needs, n => S(n!["kind"]) == "due" && S(n["title"]).Contains("Sign off the launch copy"));
        Assert.Contains("need", S(b["headline"]));
        Assert.False(string.IsNullOrWhiteSpace(S(b["line"])));

        var risks = b["atRisk"]!.AsArray();
        var dep = risks.First(r => S(r!["kind"]) == "dependency")!;
        Assert.Contains("Wire the checkout", S(dep["title"]));
        Assert.Contains("Vendor API ready", S(dep["why"]));
        Assert.Contains("slipped", S(dep["why"]));
        var own = risks.First(r => S(r!["title"]).Contains("Migrate old orders"))!;
        Assert.Equal("owner", S(own["kind"]));
        Assert.Equal("reassign", S(own["action"]!["verb"]));
        Assert.Contains(own["evidence"]!.AsArray(), e => S(e!["kind"]) == "date" && S(e["detail"]).Contains("Old export was corrupt"));

        // One tap: the approval endpoint the item carries decides it, and it leaves the briefing.
        var decide = await owner.Post(S(needs[0]!["action"]!["endpoint"]), new { action = "approve" });
        Assert.True(decide.Ok, decide.ToString());
        var after = (await owner.Get("/api/v1/aura/briefing")).Data!;
        Assert.DoesNotContain(after["needsYou"]!.AsArray(), n => S(n!["kind"]) == "approval");
        Assert.Equal(S(b["generatedAt"]), S(after["generatedAt"]));   // written once per morning; the items are read again

        // Tamsin sees her own late work, not the owner's approvals.
        var hers = (await dev.Get("/api/v1/aura/briefing")).Data!;
        Assert.Contains(hers["needsYou"]!.AsArray(), n => S(n!["kind"]) == "overdue" && S(n["title"]).Contains("Migrate old orders"));
        Assert.DoesNotContain(hers["needsYou"]!.AsArray(), n => S(n!["kind"]) == "approval");
        _ = key;
    }

    [Fact]
    public async Task Meeting_review_approves_drafted_tasks_with_edits_and_leaves_out_the_rest()
    {
        var (owner, dev, project, _) = await SetupAsync("Harbor Sync");
        var runId = Guid.NewGuid();
        Guid taskFinding = Guid.NewGuid(), dropFinding = Guid.NewGuid();
        var due = DateOnly.FromDateTime(DateTime.UtcNow).AddDays(5);
        factory.WithDb(db =>
        {
            db.AgentRuns.Add(new AgentRun { Id = runId, TenantId = owner.WorkspaceId, ProjectId = project, Trigger = "meeting", Status = "done", MeetingId = Guid.NewGuid(),
                StartedAt = DateTime.UtcNow.AddHours(-1), FinishedAt = DateTime.UtcNow.AddMinutes(-5), FindingCount = 4, Summary = "Pilot scope agreed; data migration owner named." });
            db.AgentFindings.Add(new AgentFinding { Id = taskFinding, TenantId = owner.WorkspaceId, ProjectId = project, RunId = runId, Kind = AgentFindingKind.CreateTask,
                Title = "Draft pilot plan", AssigneeId = dev.UserId, DueDate = due, Confidence = 90, CreatedAt = DateTime.UtcNow.AddMinutes(-5), Evidence = "Tamsin will draft the pilot plan" });
            db.AgentFindings.Add(new AgentFinding { Id = dropFinding, TenantId = owner.WorkspaceId, ProjectId = project, RunId = runId, Kind = AgentFindingKind.CreateTask,
                Title = "Book a venue", Confidence = 40, CreatedAt = DateTime.UtcNow.AddMinutes(-4) });
            db.AgentFindings.Add(new AgentFinding { TenantId = owner.WorkspaceId, ProjectId = project, RunId = runId, Kind = AgentFindingKind.Decision,
                Title = "Pilot starts with two branches", Confidence = 90, CreatedAt = DateTime.UtcNow.AddMinutes(-4) });
            db.AgentFindings.Add(new AgentFinding { TenantId = owner.WorkspaceId, ProjectId = project, RunId = runId, Kind = AgentFindingKind.Missed,
                Title = "Who signs the data agreement?", Confidence = 70, CreatedAt = DateTime.UtcNow.AddMinutes(-3) });
            return db.SaveChanges();
        });

        // It shows up in the briefing with Review, and as the latest review.
        var brief = (await owner.Get("/api/v1/aura/briefing")).Data!;
        var item = brief["needsYou"]!.AsArray().First(n => S(n!["kind"]) == "review")!;
        Assert.Equal("review", S(item["action"]!["verb"]));
        Assert.Equal(runId.ToString(), S(item["action"]!["targetId"]));

        var sheet = await owner.Get("/api/v1/aura/meetings/review");
        Assert.True(sheet.Ok, sheet.ToString());
        var r = sheet.Data!;
        Assert.Equal(runId.ToString(), S(r["runId"]));
        Assert.Equal(2, r["items"]!.AsArray().Count);
        Assert.Equal("Pilot starts with two branches", S(r["decisions"]!.AsArray()[0]));
        Assert.Equal("Who signs the data agreement?", S(r["questions"]!.AsArray()[0]));
        Assert.Equal("Tamsin Reed", S(r["items"]!.AsArray().First(i => S(i!["title"]) == "Draft pilot plan")!["owner"]!["name"]));

        // Someone who may not edit the project cannot review it.
        var denied = await dev.Get($"/api/v1/aura/meetings/{runId}/review");
        Assert.True(denied.Status is HttpStatusCode.Forbidden or HttpStatusCode.NotFound, denied.ToString());

        // Approve all, with one edit and one left out.
        var res = await owner.Post($"/api/v1/aura/meetings/{runId}/review", new
        {
            items = new object[] { new { id = taskFinding, approve = true, title = "Draft the two-branch pilot plan" }, new { id = dropFinding, approve = false } },
            approveRest = true,
        });
        Assert.True(res.Ok, res.ToString());
        Assert.Equal(1, res.Data!["dismissed"]!.GetValue<int>());
        Assert.True(res.Data!["approved"]!.GetValue<int>() >= 2);   // the task, and the decision and open point recorded as notes
        Assert.NotEmpty(res.Data!["created"]!.AsArray());
        factory.WithDb(db =>
        {
            var t = db.Tasks.IgnoreQueryFilters().Single(x => x.ProjectId == project && x.Title == "Draft the two-branch pilot plan");
            Assert.Equal(dev.UserId, t.AssigneeId);
            Assert.Equal(due, t.DueDate);
            Assert.False(db.Tasks.IgnoreQueryFilters().Any(x => x.ProjectId == project && x.Title == "Book a venue"));
            Assert.False(db.AgentFindings.IgnoreQueryFilters().Any(f => f.RunId == runId && f.Status == AgentFindingStatus.Proposed));
            return 0;
        });
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Get("/api/v1/aura/meetings/review")).Status);
    }

    [Fact]
    public async Task Friday_report_is_drafted_per_project_sent_and_announced_once_on_friday_afternoon()
    {
        var (owner, _, project, _) = await SetupAsync("Lumen Portal");
        var shipped = await TaskAsync(owner, project, "Ship the login page", owner.UserId);
        var done = factory.WithDb(db => db.WorkflowStatuses.IgnoreQueryFilters().First(s => s.ProjectId == project && s.Category == StatusCategory.Done).Id);
        factory.WithDb(db =>
        {
            var t = db.Tasks.IgnoreQueryFilters().First(x => x.Id == shipped);
            t.StatusId = done; t.CompletedAt = DateTime.UtcNow.AddDays(-1);
            return db.SaveChanges();
        });

        var draft = await owner.Get("/api/v1/aura/friday");
        Assert.True(draft.Ok, draft.ToString());
        var p = draft.Data!["projects"]!.AsArray().Single()!;
        Assert.Equal("Lumen Portal", S(p["name"]));
        Assert.Contains("What moved", S(p["text"]));
        Assert.Contains("Ship the login page", S(p["text"]));
        Assert.Equal(1, p["done"]!.GetValue<int>());
        Assert.Contains("1 project", S(draft.Data!["headline"]));
        Assert.True(DateTime.Parse(S(draft.Data!["nextScheduledAt"])) > DateTime.UtcNow.AddMinutes(-1));

        // Sent to the project's chat, with the person's edit.
        Assert.True((await owner.Post($"/api/v1/chat/projects/{project}/open", new { })).Ok);
        var sent = await owner.Post("/api/v1/aura/friday/send", new { projects = new[] { new { projectId = project, text = "**Lumen Portal** — login shipped; all on track." } } });
        Assert.True(sent.Ok, sent.ToString());
        Assert.Equal(1, sent.Data!["sent"]!.GetValue<int>());

        // Someone else's project cannot be sent.
        var other = await TestClient.RegisterAsync(factory, "Pell Ardent");
        await other.CreateOrgAsync();
        Assert.False((await other.Post("/api/v1/aura/friday/send", new { projects = new[] { new { projectId = project, text = "x" } } })).Ok);

        // The notice: once, on Friday between 16:00 and 19:00 in the owner's own zone (here India: 16:00 IST is 10:30 UTC).
        factory.WithDb(db =>
        {
            db.Users.IgnoreQueryFilters().First(u => u.Id == owner.UserId).TimeZone = "Asia/Kolkata";
            db.Tenants.IgnoreQueryFilters().First(t => t.Id == owner.WorkspaceId).TimeZone = "Asia/Kolkata";
            return db.SaveChanges();
        });
        var friday = new DateTime(2026, 11, 6, 0, 0, 0, DateTimeKind.Utc);
        foreach (var utc in new[] { friday.AddHours(10), friday.AddHours(10.75), friday.AddHours(12), friday.AddHours(14) })   // 15:30, 16:15, 17:30, 19:30 IST
        {
            using var scope = factory.Services.CreateScope();
            await scope.ServiceProvider.GetRequiredService<AuraFridayJob>().RunAsync(utc);
        }
        factory.WithDb(db =>
        {
            var notes = db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == owner.UserId && n.TenantId == owner.WorkspaceId && n.DedupeKey!.StartsWith("aurafriday:")).ToList();
            var n = Assert.Single(notes);
            Assert.Equal("/?aura=friday", n.Link);
            Assert.Equal(NotificationType.ReportReady, n.Type);
            return 0;
        });
    }

    [Fact]
    public async Task Ask_why_late_walks_date_changes_and_dependencies_and_cites_them()
    {
        var (owner, dev, project, key) = await SetupAsync("Quarry Ledger");
        var feed = await TaskAsync(owner, project, "Bank feed sandbox", dev.UserId);
        var recon = await TaskAsync(owner, project, "Reconciliation screen", owner.UserId);
        var number = factory.WithDb(db =>
        {
            var today = ServerToday();   // the app's calendar day (its zone), not UTC: they differ for part of every day
            var tasks = db.Tasks.IgnoreQueryFilters().Where(t => t.ProjectId == project).ToList();
            tasks.First(t => t.Id == recon).DueDate = today.AddDays(-2);
            tasks.First(t => t.Id == feed).DueDate = today.AddDays(-5);
            db.TaskDependencies.Add(new TaskDependency { TenantId = owner.WorkspaceId, TaskId = recon, DependsOnTaskId = feed, Type = DependencyType.FinishToStart });
            db.DueDateChanges.Add(new DueDateChange { TenantId = owner.WorkspaceId, ProjectId = project, TaskId = recon, Previous = today.AddDays(-9), Revised = today.AddDays(-2),
                Reason = "Bank sandbox credentials arrived late", CreatedAt = DateTime.UtcNow.AddDays(-10), CreatedBy = owner.UserId, EntityType = "Task", EntityId = recon, Field = "dueDate" });
            db.SaveChanges();
            return tasks.First(t => t.Id == recon).Number;
        });
        Assert.True((await owner.Post($"/api/v1/tasks/{recon}/comments", new { body = "Blocked until the sandbox feed works." })).Ok);

        var res = await owner.Post("/api/v1/aura/ask", new { question = $"Why is {key}-{number} late?" });
        Assert.True(res.Ok, res.ToString());
        var a = res.Data!;
        Assert.Contains("Reconciliation screen", S(a["subject"]));
        Assert.Contains("2 days late", S(a["answer"]));
        Assert.Contains("Bank sandbox credentials arrived late", S(a["answer"]));
        Assert.Contains("Bank feed sandbox", S(a["answer"]));
        var ev = a["evidence"]!.AsArray();
        Assert.Contains(ev, e => S(e!["kind"]) == "date" && S(e["href"]) == $"/work?item={recon}");
        Assert.Contains(ev, e => S(e!["kind"]) == "dependency" && S(e["href"]) == $"/work?item={feed}");
        Assert.Contains(ev, e => S(e!["kind"]) == "comment");

        // By words instead of a key.
        var words = (await owner.Post("/api/v1/aura/ask", new { question = "why is the reconciliation screen behind?" })).Data!;
        Assert.Contains("Reconciliation screen", S(words["subject"]));

        // Nothing to go on: says so, and suggests what to ask.
        var none = (await owner.Post("/api/v1/aura/ask", new { question = "why?" })).Data!;
        Assert.Null(none["subject"]);
        Assert.NotEmpty(none["suggestions"]!.AsArray());

        // Another workspace's task is not found by its key.
        var other = await TestClient.RegisterAsync(factory, "Pell Ardent");
        await other.CreateOrgAsync();
        var outside = (await other.Post("/api/v1/aura/ask", new { question = $"Why is {key}-{number} late?" })).Data!;
        Assert.DoesNotContain("Reconciliation", outside["subject"]?.GetValue<string>() ?? "");
    }
}
