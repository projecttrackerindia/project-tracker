using System.Net;
using System.Reflection;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Api.Controllers.Documents;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Review and approval, access requests, notices and the audit trail of documents (release D3).</summary>
[Collection("api")]
public class DocumentWorkflowTests(ApiFactory factory) : IAsyncLifetime
{
    public Task InitializeAsync() => Task.CompletedTask;

    /// <summary>The notices these tests create are not meant to be e-mailed; leaving them queued would crowd the batch that the notification tests count on.</summary>
    public Task DisposeAsync()
    {
        factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.Type == NotificationType.Document && (n.EmailPending || n.PushPending)).ExecuteUpdate(s => s.SetProperty(n => n.EmailPending, false).SetProperty(n => n.PushPending, false)));
        return Task.CompletedTask;
    }

    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<(TestClient Owner, Guid Brd)> Org(string plan = "PRO", int seats = 20)
    {
        var owner = await TestClient.RegisterAsync(factory, "Olive Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync(plan, seats);
        var brd = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "BRD")!["id"]));
        return (owner, brd);
    }

    private static async Task<Guid> Make(TestClient c, Guid type, string title, Guid? project = null, string? visibility = null, Guid? team = null)
    {
        var res = await c.Post("/api/v1/documents", new { title, typeId = type, projectId = project, visibility, teamId = team });
        Assert.True(res.Ok, res.ToString());
        return Guid.Parse(S(res.Data!["item"]!["id"]));
    }

    private static string Text(string t) => $$"""{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"{{t}}"}]}]}""";

    private static async Task<ApiResult> Write(TestClient c, Guid doc, string text, string section = "scope")
    {
        var rev = (await c.Get($"/api/v1/documents/{doc}")).Data!["revision"]!.GetValue<int>();
        return await c.Put($"/api/v1/documents/{doc}/sections", new { revision = rev, sections = new[] { new { key = section, content = Text(text) } } });
    }

    private static async Task<int> Revision(TestClient c, Guid doc) => (await c.Get($"/api/v1/documents/{doc}")).Data!["revision"]!.GetValue<int>();
    private static async Task<string> Status(TestClient c, Guid doc) => S((await c.Get($"/api/v1/documents/{doc}")).Data!["item"]!["status"]);

    private static object Step(string name, string kind, Guid? principal, string rule = "Any", int? dueDays = null) => new { name, kind, principalId = principal, rule, dueDays };

    private static async Task<Guid> Workflow(TestClient owner, string name, object[] steps, Guid? type = null, bool remind = false)
    {
        var res = await owner.Post("/api/v1/document-workflows", new { typeId = type, name, isActive = true, remind, steps });
        Assert.True(res.Ok, res.ToString());
        return Guid.Parse(S(res.Data!["id"]));
    }

    private static Task<ApiResult> Submit(TestClient c, Guid doc, int revision, string summary = "Ready for review") =>
        c.Post($"/api/v1/documents/{doc}/submit", new { changeSummary = summary, changeReason = (string?)null, major = false, revision });

    private static async Task<List<JsonNode>> Notes(TestClient c, string? contains = null) =>
        (await c.Get("/api/v1/notifications")).Data!["items"]!.AsArray().Select(n => n!).Where(n => S(n["type"]) == "Document" && (contains is null || S(n["title"]).Contains(contains))).ToList();

    // ------------------------------------------------------------------ the state machine

    [Fact]
    public void The_state_machine_allows_exactly_the_listed_transitions_and_rejects_every_other_pair()
    {
        // The specification, written out independently of the code: (status, action, has a published version, workflow) -> status.
        var allowed = new Dictionary<(DocumentStatus, DocAction, bool, bool), DocumentStatus>();
        foreach (var published in new[] { false, true })
        {
            var back = published ? DocumentStatus.Published : DocumentStatus.Draft;
            foreach (var from in new[] { DocumentStatus.Draft, DocumentStatus.ChangesRequested, DocumentStatus.Published })
                allowed[(from, DocAction.Submit, published, true)] = DocumentStatus.InReview;
            foreach (var from in new[] { DocumentStatus.InReview, DocumentStatus.Approved }) allowed[(from, DocAction.Withdraw, published, true)] = back;
            foreach (var wf in new[] { false, true })
            {
                allowed[(DocumentStatus.InReview, DocAction.Withdraw, published, wf)] = back;
                allowed[(DocumentStatus.Approved, DocAction.Withdraw, published, wf)] = back;
                allowed[(DocumentStatus.InReview, DocAction.ApproveFinal, published, wf)] = DocumentStatus.Approved;
                allowed[(DocumentStatus.InReview, DocAction.RequestChanges, published, wf)] = DocumentStatus.ChangesRequested;
                foreach (var from in new[] { DocumentStatus.Draft, DocumentStatus.Published, DocumentStatus.ChangesRequested, DocumentStatus.Approved }) allowed[(from, DocAction.Archive, published, wf)] = DocumentStatus.Archived;
                allowed[(DocumentStatus.Archived, DocAction.Reopen, published, wf)] = back;
                allowed[(DocumentStatus.InReview, DocAction.Edit, published, wf)] = back;
                allowed[(DocumentStatus.Approved, DocAction.Edit, published, wf)] = back;
                foreach (var from in new[] { DocumentStatus.Draft, DocumentStatus.ChangesRequested, DocumentStatus.Published }) allowed[(from, DocAction.Edit, published, wf)] = from;
            }
            allowed[(DocumentStatus.Approved, DocAction.Publish, published, true)] = DocumentStatus.Published;
            allowed[(DocumentStatus.Draft, DocAction.Publish, published, false)] = DocumentStatus.Published;
            allowed[(DocumentStatus.Published, DocAction.Publish, published, false)] = DocumentStatus.Published;
        }
        // Submit exists only with a workflow; the no-workflow Withdraw rows above are harmless duplicates of the same destination.
        foreach (var k in allowed.Keys.Where(k => k.Item2 == DocAction.Submit).ToList()) Assert.True(k.Item4);

        var checkedPairs = 0;
        foreach (var status in Enum.GetValues<DocumentStatus>())
            foreach (var action in Enum.GetValues<DocAction>())
                foreach (var published in new[] { false, true })
                    foreach (var workflow in new[] { false, true })
                    {
                        var expected = allowed.TryGetValue((status, action, published, workflow), out var to) ? to : (DocumentStatus?)null;
                        Assert.Equal(expected, DocumentStateMachine.Next(status, action, published, workflow));
                        checkedPairs++;
                    }
        Assert.Equal(6 * 8 * 2 * 2, checkedPairs);
    }

    // ------------------------------------------------------------------ approvals

    [Fact]
    public async Task A_submitter_can_never_approve_their_own_submission_and_nobody_outside_the_step_can_either()
    {
        var (owner, brd) = await Org();
        var author = await owner.AddMemberAsync(factory, TenantRole.Member, "Alex Author");
        var reviewer = await owner.AddMemberAsync(factory, TenantRole.Member, "Rita Reviewer");
        var outsider = await owner.AddMemberAsync(factory, TenantRole.Member, "Omar Outsider");
        await Workflow(owner, "Review", [Step("Business owner", "User", reviewer.UserId)]);

        var doc = await Make(author, brd, "Payroll BRD", null, "Private");
        Assert.True((await Write(author, doc, "Payslips online")).Ok);
        var sent = await Submit(author, doc, await Revision(author, doc));
        Assert.True(sent.Ok, sent.ToString());
        Assert.Equal("InReview", await Status(author, doc));
        Assert.Equal(HttpStatusCode.Forbidden, (await author.Post($"/api/v1/documents/{doc}/approve", new { comment = "me" })).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Post($"/api/v1/documents/{doc}/approve", new { })).Status);   // a private document is not even visible to them
        Assert.Equal("InReview", await Status(author, doc));

        // The reviewer can open the private document just because they are asked to review it, and can approve.
        Assert.True((await reviewer.Get($"/api/v1/documents/{doc}")).Ok);
        var done = await reviewer.Post($"/api/v1/documents/{doc}/approve", new { comment = "Looks right" });
        Assert.True(done.Ok, done.ToString());
        Assert.Equal("Approved", await Status(author, doc));
        Assert.Equal(HttpStatusCode.Conflict, (await reviewer.Post($"/api/v1/documents/{doc}/approve", new { })).Status);     // nothing left to decide

        // A workflow whose only approver is the person submitting cannot be started.
        var solo = await Make(reviewer, brd, "Reviewer's own", null, "Private");
        Assert.True((await Write(reviewer, solo, "x")).Ok);
        var self = await Submit(reviewer, solo, await Revision(reviewer, solo));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, self.Status);
        Assert.Equal("Draft", await Status(reviewer, solo));
    }

    [Fact]
    public async Task A_workflow_edited_after_submission_does_not_change_the_approval_that_is_running()
    {
        var (owner, brd) = await Org();
        var author = await owner.AddMemberAsync(factory, TenantRole.Member, "Alex Author");
        var first = await owner.AddMemberAsync(factory, TenantRole.Member, "Fiona First");
        var second = await owner.AddMemberAsync(factory, TenantRole.Member, "Sam Second");
        var replacement = await owner.AddMemberAsync(factory, TenantRole.Member, "Rex Replacement");
        var wf = await Workflow(owner, "Two steps", [Step("Business", "User", first.UserId), Step("Technical", "User", second.UserId)]);

        var doc = await Make(author, brd, "Billing BRD", null, "Organization");
        Assert.True((await Write(author, doc, "Invoices")).Ok);
        Assert.True((await Submit(author, doc, await Revision(author, doc))).Ok);

        // The administrator now rewrites the workflow completely.
        var edited = await owner.Put($"/api/v1/document-workflows/{wf}", new { typeId = (Guid?)null, name = "One step", isActive = true, remind = false, steps = new[] { Step("Only", "User", replacement.UserId) } });
        Assert.True(edited.Ok, edited.ToString());

        var review = (await author.Get($"/api/v1/documents/{doc}/review")).Data!;
        Assert.Equal("Two steps", S(review["current"]!["workflowName"]));
        Assert.Equal(2, review["current"]!["steps"]!.AsArray().Count);
        Assert.Equal(HttpStatusCode.Forbidden, (await replacement.Post($"/api/v1/documents/{doc}/approve", new { })).Status);   // not in the running approval
        Assert.Equal(HttpStatusCode.Forbidden, (await second.Post($"/api/v1/documents/{doc}/approve", new { })).Status);        // second step is not up yet
        Assert.True((await first.Post($"/api/v1/documents/{doc}/approve", new { })).Ok);
        Assert.Equal("InReview", await Status(author, doc));                                                                      // one step to go
        Assert.True((await second.Post($"/api/v1/documents/{doc}/approve", new { })).Ok);
        Assert.Equal("Approved", await Status(author, doc));

        // The next submission uses the new workflow.
        Assert.True((await author.Post($"/api/v1/documents/{doc}/publish", new { changeSummary = "x", major = false, revision = await Revision(author, doc) })).Ok);
        Assert.True((await Write(author, doc, "Invoices and credit notes")).Ok);
        Assert.True((await Submit(author, doc, await Revision(author, doc), "Credit notes")).Ok);
        Assert.Equal(1, (await author.Get($"/api/v1/documents/{doc}/review")).Data!["stepCount"]!.GetValue<int>());
    }

    [Fact]
    public async Task With_a_workflow_a_document_is_published_only_after_approval_and_editing_in_review_cancels_it()
    {
        var (owner, brd) = await Org();
        var author = await owner.AddMemberAsync(factory, TenantRole.Member, "Alex Author");
        var reviewer = await owner.AddMemberAsync(factory, TenantRole.Member, "Rita Reviewer");
        await Workflow(owner, "Review", [Step("Business", "User", reviewer.UserId)]);
        var doc = await Make(author, brd, "Orders BRD", null, "Organization");
        Assert.True((await Write(author, doc, "Orders")).Ok);

        var direct = await author.Post($"/api/v1/documents/{doc}/publish", new { changeSummary = "go", major = false, revision = await Revision(author, doc) });
        Assert.Equal(HttpStatusCode.Conflict, direct.Status);
        Assert.Equal("APPROVAL_REQUIRED", direct.ErrorCode);

        Assert.True((await Submit(author, doc, await Revision(author, doc), "First version")).Ok);
        Assert.Equal(HttpStatusCode.Conflict, (await Submit(author, doc, await Revision(author, doc))).Status);            // already waiting

        // Editing a document under review voids the review and tells the reviewer.
        Assert.True((await Write(author, doc, "Orders and returns")).Ok);
        Assert.Equal("Draft", await Status(author, doc));
        Assert.Equal("Cancelled", S((await author.Get($"/api/v1/documents/{doc}/review")).Data!["current"]!["state"]));
        Assert.Single(await Notes(reviewer, "was cancelled"));
        Assert.Equal(HttpStatusCode.Conflict, (await reviewer.Post($"/api/v1/documents/{doc}/approve", new { })).Status);

        // Submit again, ask for changes, fix, submit, approve, publish.
        Assert.True((await Submit(author, doc, await Revision(author, doc), "First version")).Ok);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await reviewer.Post($"/api/v1/documents/{doc}/request-changes", new { comment = " " })).Status);   // say what to change
        Assert.True((await reviewer.Post($"/api/v1/documents/{doc}/request-changes", new { comment = "Add the refund rules" })).Ok);
        Assert.Equal("ChangesRequested", await Status(author, doc));
        Assert.Single(await Notes(author, "asked for changes"));
        Assert.True((await Write(author, doc, "Orders, returns and refund rules")).Ok);
        Assert.Equal("ChangesRequested", await Status(author, doc));
        Assert.True((await Submit(author, doc, await Revision(author, doc), "With refund rules")).Ok);
        Assert.True((await reviewer.Post($"/api/v1/documents/{doc}/approve", new { })).Ok);
        Assert.Single(await Notes(author, "was approved"));

        var published = await author.Post($"/api/v1/documents/{doc}/publish", new { changeSummary = "ignored", major = false, revision = await Revision(author, doc) });
        Assert.True(published.Ok, published.ToString());
        Assert.Equal("1.0", S(published.Data!["publishedLabel"]));
        Assert.Equal("With refund rules", S(published.Data["items"]!.AsArray().First(v => v!["isCurrent"]!.GetValue<bool>())!["changeSummary"]));    // the summary it was submitted with
        Assert.Equal("Published", await Status(author, doc));
        Assert.Equal("Published", S((await author.Get($"/api/v1/documents/{doc}/review")).Data!["current"]!["state"]));
        Assert.Single(await Notes(reviewer, "was published"));

        // A published document goes through review again; withdrawing returns it to Published, not Draft.
        Assert.True((await Write(author, doc, "Orders, returns, refund rules and exchanges")).Ok);
        Assert.True((await Submit(author, doc, await Revision(author, doc), "Exchanges")).Ok);
        Assert.True((await author.Post($"/api/v1/documents/{doc}/withdraw", new { comment = "not yet" })).Ok);
        Assert.Equal("Published", await Status(author, doc));

        // Restoring an old version does not skip the review: it only loads the words into the draft.
        var versions = (await author.Get($"/api/v1/documents/{doc}/versions")).Data!["items"]!.AsArray();
        var v10 = versions.First(v => S(v!["label"]) == "1.0");
        var restored = await author.Post($"/api/v1/documents/{doc}/versions/{S(v10!["id"])}/restore", new { reason = "back", discardChanges = true, revision = await Revision(author, doc) });
        Assert.True(restored.Ok, restored.ToString());
        Assert.Equal("1.0", S(restored.Data!["publishedLabel"]));                                                                      // no 1.1 was published
        Assert.Contains("refund rules", (await author.Get($"/api/v1/documents/{doc}")).Data!["sections"]!.ToJsonString());
    }

    [Fact]
    public async Task Workflows_need_the_plan_and_the_permission_and_per_kind_workflows_and_reminders_are_a_business_feature()
    {
        var (free, brdFree) = await Org("FREE", 1);
        var res = await free.Post("/api/v1/document-workflows", new { name = "x", isActive = true, remind = false, steps = new[] { Step("a", "ProjectOwner", null) } });
        Assert.False(res.Ok);
        Assert.False((await free.Get("/api/v1/document-workflows")).Data!["allowed"]!.GetValue<bool>());
        var solo = await Make(free, brdFree, "Free doc");
        Assert.True((await Write(free, solo, "mine")).Ok);
        Assert.True((await free.Post($"/api/v1/documents/{solo}/publish", new { changeSummary = "mine", major = false, revision = await Revision(free, solo) })).Ok);   // the owner publishes
        Assert.Equal(HttpStatusCode.Conflict, (await Submit(free, solo, await Revision(free, solo))).Status);                                                       // nothing to submit to

        var (pro, brdPro) = await Org("PRO");
        var member = await pro.AddMemberAsync(factory, TenantRole.Member, "Mia Member");
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Post("/api/v1/document-workflows", new { name = "x", isActive = true, remind = false, steps = new[] { Step("a", "User", member.UserId) } })).Status);
        Assert.False((await pro.Post("/api/v1/document-workflows", new { typeId = brdPro, name = "BRD only", isActive = true, remind = false, steps = new[] { Step("a", "User", member.UserId) } })).Ok);
        Assert.False((await pro.Post("/api/v1/document-workflows", new { name = "x", isActive = true, remind = true, steps = new[] { Step("a", "User", member.UserId, "Any", 2) } })).Ok);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await pro.Post("/api/v1/document-workflows", new { name = "", isActive = true, remind = false, steps = new[] { Step("a", "User", member.UserId) } })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await pro.Post("/api/v1/document-workflows", new { name = "none", isActive = true, remind = false, steps = Array.Empty<object>() })).Status);
        await Workflow(pro, "Default", [Step("a", "User", member.UserId)]);
        Assert.Equal(HttpStatusCode.Conflict, (await pro.Post("/api/v1/document-workflows", new { name = "Second default", isActive = true, remind = false, steps = new[] { Step("a", "User", member.UserId) } })).Status);

        var (biz, brdBiz) = await Org("BUSINESS");
        var a = await biz.AddMemberAsync(factory, TenantRole.Member, "Ann");
        var b = await biz.AddMemberAsync(factory, TenantRole.Member, "Bob");
        await Workflow(biz, "Default", [Step("Default step", "User", a.UserId)]);
        await Workflow(biz, "BRD path", [Step("BRD step", "User", b.UserId, "Any", 2)], brdBiz, remind: true);
        var author = await biz.AddMemberAsync(factory, TenantRole.Member, "Alex");
        var doc = await Make(author, brdBiz, "Typed", null, "Organization");
        Assert.True((await Write(author, doc, "t")).Ok);
        Assert.True((await Submit(author, doc, await Revision(author, doc))).Ok);
        Assert.Equal("BRD path", S((await author.Get($"/api/v1/documents/{doc}/review")).Data!["current"]!["workflowName"]));      // the kind's own workflow wins
    }

    [Fact]
    public async Task A_step_with_the_all_rule_waits_for_everyone_and_a_team_or_project_owner_can_approve()
    {
        var (owner, brd) = await Org();
        var author = await owner.AddMemberAsync(factory, TenantRole.Member, "Alex Author");
        var t1 = await owner.AddMemberAsync(factory, TenantRole.Member, "Tina One");
        var t2 = await owner.AddMemberAsync(factory, TenantRole.Member, "Tom Two");
        var team = Guid.Parse(S((await owner.Post("/api/v1/teams", new { name = "Architects" })).Data!["team"]!["id"]));
        foreach (var m in new[] { t1, t2 }) Assert.True((await owner.Post($"/api/v1/teams/{team}/members", new { userId = m.UserId, isLead = false })).Ok);
        var project = await owner.CreateProjectAsync("Portal");
        await Workflow(owner, "Team then owner", [Step("Architects", "Team", team, "All"), Step("Project owner", "ProjectOwner", null)]);

        var doc = await Make(author, brd, "Portal BRD", project);
        Assert.True((await Write(author, doc, "Portal")).Ok);
        var sent = await Submit(author, doc, await Revision(author, doc));
        Assert.True(sent.Ok, sent.ToString());
        Assert.Single(await Notes(t1, "asks you to review"));
        Assert.Single(await Notes(t2, "asks you to review"));
        Assert.Empty(await Notes(owner, "asks you to review"));                                // the project owner's step is not up yet

        Assert.True((await t1.Post($"/api/v1/documents/{doc}/approve", new { })).Ok);
        Assert.Equal(HttpStatusCode.Conflict, (await t1.Post($"/api/v1/documents/{doc}/approve", new { })).Status);   // once each
        Assert.Empty(await Notes(owner, "waiting for your review"));                           // still on the first step: Tom has not decided
        Assert.True((await t2.Post($"/api/v1/documents/{doc}/approve", new { })).Ok);
        Assert.Single(await Notes(owner, "waiting for your review"));
        Assert.True((await owner.Post($"/api/v1/documents/{doc}/approve", new { })).Ok);
        Assert.Equal("Approved", await Status(author, doc));
    }

    [Fact]
    public async Task Every_event_notifies_each_person_once_and_the_inbox_shows_what_is_waiting()
    {
        var (owner, brd) = await Org();
        var author = await owner.AddMemberAsync(factory, TenantRole.Member, "Alex Author");
        var r1 = await owner.AddMemberAsync(factory, TenantRole.Member, "Rita One");
        var r2 = await owner.AddMemberAsync(factory, TenantRole.Member, "Raj Two");
        var team = Guid.Parse(S((await owner.Post("/api/v1/teams", new { name = "Reviewers" })).Data!["team"]!["id"]));
        foreach (var m in new[] { r1, r2 }) Assert.True((await owner.Post($"/api/v1/teams/{team}/members", new { userId = m.UserId, isLead = false })).Ok);
        await Workflow(owner, "Team review", [Step("Reviewers", "Team", team)]);
        var doc = await Make(author, brd, "Notices BRD", null, "Organization");
        Assert.True((await Write(author, doc, "Notices")).Ok);
        Assert.True((await Submit(author, doc, await Revision(author, doc))).Ok);

        Assert.Single(await Notes(r1)); Assert.Single(await Notes(r2));
        var inbox = (await r1.Get("/api/v1/documents/inbox")).Data!;
        Assert.Single(inbox["toReview"]!.AsArray());
        Assert.Equal(1, inbox["waiting"]!.GetValue<int>());
        Assert.Single((await author.Get("/api/v1/documents/inbox")).Data!["submitted"]!.AsArray());
        Assert.Empty((await author.Get("/api/v1/documents/inbox")).Data!["toReview"]!.AsArray());

        Assert.True((await r1.Post($"/api/v1/documents/{doc}/approve", new { })).Ok);
        Assert.Empty((await r2.Get("/api/v1/documents/inbox")).Data!["toReview"]!.AsArray());           // the step is done, so Raj has nothing to do
        Assert.Single(await Notes(author)); Assert.Single(await Notes(r2));                              // exactly one each, however many times the screens are reloaded
        _ = await author.Get("/api/v1/notifications"); _ = await r2.Get("/api/v1/notifications");
        Assert.Single(await Notes(author));

        Assert.True((await author.Post($"/api/v1/documents/{doc}/publish", new { changeSummary = "x", major = false, revision = await Revision(author, doc) })).Ok);
        Assert.Equal(2, (await Notes(r1)).Count);                                                         // asked to review, then published
        Assert.Empty(await Notes(owner));                                                                 // the workspace owner was never involved
    }

    [Fact]
    public async Task Reminders_go_to_the_people_who_have_not_decided_once_and_only_on_plans_that_allow_them()
    {
        var (owner, brd) = await Org("BUSINESS");
        var author = await owner.AddMemberAsync(factory, TenantRole.Member, "Alex Author");
        var lazy = await owner.AddMemberAsync(factory, TenantRole.Member, "Lou Lazy");
        await Workflow(owner, "Quick", [Step("Review", "User", lazy.UserId, "Any", 1)], remind: true);
        var doc = await Make(author, brd, "Late BRD", null, "Organization");
        Assert.True((await Write(author, doc, "late")).Ok);
        Assert.True((await Submit(author, doc, await Revision(author, doc))).Ok);

        await using (var scope = factory.Services.CreateAsyncScope())
            Assert.Equal(0, await scope.ServiceProvider.GetRequiredService<DocumentWorkflowService>().SendRemindersAsync());      // not due yet
        factory.WithDb(db => db.DocumentApprovals.IgnoreQueryFilters().ExecuteUpdate(s => s.SetProperty(a => a.StepStartedAt, DateTime.UtcNow.AddDays(-2))));
        await using (var scope = factory.Services.CreateAsyncScope())
            Assert.Equal(1, await scope.ServiceProvider.GetRequiredService<DocumentWorkflowService>().SendRemindersAsync());
        await using (var scope = factory.Services.CreateAsyncScope())
            Assert.Equal(0, await scope.ServiceProvider.GetRequiredService<DocumentWorkflowService>().SendRemindersAsync());      // once only
        Assert.Single(await Notes(lazy, "waiting for your review"));
        var due = (await lazy.Get("/api/v1/documents/inbox")).Data!["toReview"]![0]!;
        Assert.True(due["overdue"]!.GetValue<bool>());
    }

    // ------------------------------------------------------------------ access requests

    [Fact]
    public async Task A_blocked_person_sees_the_title_and_the_owner_asks_for_access_and_after_approval_opens_it_until_the_end_date()
    {
        var (owner, brd) = await Org();
        var author = await owner.AddMemberAsync(factory, TenantRole.Member, "Alex Author");
        var asker = await owner.AddMemberAsync(factory, TenantRole.Member, "Ari Asker");
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gus Guest");
        var team = Guid.Parse(S((await owner.Post("/api/v1/teams", new { name = "Payments" })).Data!["team"]!["id"]));
        Assert.True((await owner.Post($"/api/v1/teams/{team}/members", new { userId = author.UserId, isLead = true })).Ok);
        var doc = await Make(author, brd, "Payments plan", null, "Team", team);
        var secret = await Make(author, brd, "Salary bands", null, "Private");

        Assert.Equal(HttpStatusCode.NotFound, (await asker.Get($"/api/v1/documents/{doc}")).Status);
        var gate = await asker.Get($"/api/v1/documents/{doc}/gate");
        Assert.True(gate.Ok, gate.ToString());
        Assert.Equal("Payments plan", S(gate.Data!["title"]));
        Assert.Equal("Alex Author", S(gate.Data["ownerName"]));
        Assert.Equal("Payments", S(gate.Data["teamName"]));
        Assert.DoesNotContain("scope", gate.Data.ToJsonString());                                                                   // no content
        Assert.Null((await asker.Get($"/api/v1/documents/{secret}/gate")).Data!["title"]);   // a private document's title stays hidden
        Assert.Equal(HttpStatusCode.NotFound, (await guest.Get($"/api/v1/documents/{doc}/gate")).Status);                           // guests never get the door
        Assert.Equal(HttpStatusCode.NotFound, (await asker.Get($"/api/v1/documents/{Guid.NewGuid()}/gate")).Status);
        Assert.Equal(HttpStatusCode.Conflict, (await author.Get($"/api/v1/documents/{doc}/gate")).Status);                          // already allowed

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await asker.Post($"/api/v1/documents/{doc}/access-requests", new { level = "Viewer", reason = "", durationDays = 7 })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await asker.Post($"/api/v1/documents/{doc}/access-requests", new { level = "Manager", reason = "please", durationDays = 7 })).Status);
        var sent = await asker.Post($"/api/v1/documents/{doc}/access-requests", new { level = "Viewer", reason = "I join the payments project next week", durationDays = 7 });
        Assert.True(sent.Ok, sent.ToString());
        Assert.Equal(HttpStatusCode.Conflict, (await asker.Post($"/api/v1/documents/{doc}/access-requests", new { level = "Viewer", reason = "again please", durationDays = 7 })).Status);
        Assert.Single(await Notes(author, "asks for access"));
        Assert.Empty(await Notes(owner, "asks for access"));                                                                         // the owner of the document is told, not every admin
        Assert.Equal(HttpStatusCode.NotFound, (await asker.Post($"/api/v1/access-requests/{S(sent.Data!["id"])}/decide", new { approve = true })).Status);   // you cannot approve yourself (and cannot see the document to try)

        Assert.Single((await author.Get("/api/v1/documents/inbox")).Data!["accessToDecide"]!.AsArray());
        var yes = await author.Post($"/api/v1/access-requests/{S(sent.Data["id"])}/decide", new { approve = true, note = "welcome" });
        Assert.True(yes.Ok, yes.ToString());
        Assert.Equal("Approved", S(yes.Data!["status"]));
        Assert.Equal(HttpStatusCode.Conflict, (await author.Post($"/api/v1/access-requests/{S(sent.Data["id"])}/decide", new { approve = false })).Status);
        Assert.Single(await Notes(asker, "now have access"));

        // No sign-in again: the very next request opens it. It is a read grant, so it does not allow edits.
        var opened = await asker.Get($"/api/v1/documents/{doc}");
        Assert.True(opened.Ok, opened.ToString());
        Assert.False(opened.Data!["can"]!["edit"]!.GetValue<bool>());
        Assert.Contains((await asker.Get("/api/v1/documents/inbox")).Data!["myAccessRequests"]!.AsArray(), r => S(r!["status"]) == "Approved");

        // Time passes: on the day it ends the door closes by itself.
        factory.WithDb(db => db.DocumentGrants.IgnoreQueryFilters().Where(g => g.DocumentId == doc && g.PrincipalId == asker.UserId).ExecuteUpdate(s => s.SetProperty(g => g.ExpiresAt, DateTime.UtcNow.AddMinutes(-1))));
        Assert.Equal(HttpStatusCode.NotFound, (await asker.Get($"/api/v1/documents/{doc}")).Status);
        Assert.Equal(HttpStatusCode.OK, (await asker.Get($"/api/v1/documents/{doc}/gate")).Status);                                  // and they may ask again
        var again = await asker.Post($"/api/v1/documents/{doc}/access-requests", new { level = "Editor", reason = "Need to fix a typo", durationDays = (int?)null });
        Assert.True(again.Ok, again.ToString());
        var no = await author.Post($"/api/v1/access-requests/{S(again.Data!["id"])}/decide", new { approve = false, note = "Ask the team lead" });
        Assert.Equal("Rejected", S(no.Data!["status"]));
        Assert.Equal(HttpStatusCode.NotFound, (await asker.Get($"/api/v1/documents/{doc}")).Status);
        Assert.Single(await Notes(asker, "was declined"));
    }

    [Fact]
    public async Task A_person_who_is_blocked_on_purpose_or_in_another_workspace_gets_no_door()
    {
        var (owner, brd) = await Org("BUSINESS");
        var author = await owner.AddMemberAsync(factory, TenantRole.Member, "Alex Author");
        var blocked = await owner.AddMemberAsync(factory, TenantRole.Member, "Bea Blocked");
        var doc = await Make(author, brd, "Closed", null, "Private");
        Assert.True((await author.Post($"/api/v1/documents/{doc}/grants", new { principalType = "User", principalId = blocked.UserId, level = "Viewer", deny = true })).Ok);
        Assert.Equal(HttpStatusCode.NotFound, (await blocked.Get($"/api/v1/documents/{doc}/gate")).Status);

        var (other, _) = await Org();
        Assert.Equal(HttpStatusCode.NotFound, (await other.Get($"/api/v1/documents/{doc}/gate")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await other.Post($"/api/v1/documents/{doc}/access-requests", new { level = "Viewer", reason = "just curious", durationDays = 3 })).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await other.Get($"/api/v1/documents/{doc}/review")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await other.Get($"/api/v1/documents/{doc}/requirements")).Status);
    }

    // ------------------------------------------------------------------ requirements and traceability

    [Fact]
    public async Task Coverage_counts_requirements_without_work_work_without_tests_and_failing_tests_exactly_as_the_links_say()
    {
        var (owner, brd) = await Org();
        var dev1 = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev One");
        var dev2 = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Two");
        var dev3 = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Three");
        var bystander = await owner.AddMemberAsync(factory, TenantRole.Member, "By Stander");
        var project = await owner.CreateProjectAsync("Coverage project");
        var doc = await Make(owner, brd, "Coverage BRD", project);

        var added = await owner.Post($"/api/v1/documents/{doc}/requirements", new { titles = Enumerable.Range(1, 40).Select(i => $"The system shall do thing {i}").ToArray() });
        Assert.True(added.Ok, added.ToString());
        var reqs = (await owner.Get($"/api/v1/documents/{doc}/requirements")).Data!.AsArray().Select(r => (Id: Guid.Parse(S(r!["id"])), Key: S(r["key"]))).ToList();
        Assert.Equal(40, reqs.Count);
        Assert.Equal("REQ-1", reqs[0].Key); Assert.Equal("REQ-40", reqs[39].Key);

        async Task<Guid> Task(string title, Guid assignee) => Guid.Parse(S((await owner.CreateTaskAsync(project, title, new { title, priority = "Medium", assigneeId = assignee }))["id"]));
        async Task Link(Guid target, string type, string relation, Guid? req) { var r = await owner.Post($"/api/v1/documents/{doc}/links", new { targetType = type, targetId = target, relation, requirementId = req }); Assert.True(r.Ok, r.ToString()); }

        var impl = new List<Guid>();
        for (var i = 0; i < 30; i++) impl.Add(await Task($"Build {i}", new[] { dev1, dev2, dev3 }[i % 3].UserId));
        for (var i = 0; i < 30; i++) await Link(impl[i], "Task", "Implements", reqs[i].Id);                 // requirements 1..30 have work; 31..40 have none
        await Link(impl[0], "Task", "Implements", reqs[30].Id);                                            // one task implements two requirements, so 31 is covered by work too
        // Tests: requirements 1..10 are verified by a passing test task; 11..13 by a test issue that is still open (failing); 14 by a fixed issue.
        for (var i = 0; i < 10; i++) await Link(await Task($"Test {i}", dev1.UserId), "Task", "Verifies", reqs[i].Id);
        var stage = Guid.Parse(S((await owner.Get($"/api/v1/projects/{project}/stages")).Data!.AsArray()[1]!["id"]));
        async Task<Guid> Issue(string t) => Guid.Parse(S((await owner.Post($"/api/v1/projects/{project}/issues", new { stageId = stage, title = t, severity = "High" })).Data!["issue"]!["id"]));
        for (var i = 10; i < 13; i++) await Link(await Issue($"Failing {i}"), "Issue", "Verifies", reqs[i].Id);
        var fixedIssue = await Issue("Fixed one");
        Assert.True((await owner.Put($"/api/v1/projects/{project}/issues/{fixedIssue}/status", new { status = "Fixed", note = "done" })).Ok);
        await Link(fixedIssue, "Issue", "Verifies", reqs[13].Id);

        var cov = (await owner.Get($"/api/v1/documents/{doc}/coverage")).Data!;
        // Direct database truth.
        var (withTask, withTest, noTask, noTest, failing, untestedWork, covered) = factory.WithDb(db =>
        {
            var links = db.DocumentLinks.IgnoreQueryFilters().Where(l => l.DocumentId == doc && l.RequirementId != null).ToList();
            var req = db.DocumentRequirements.IgnoreQueryFilters().Where(r => r.DocumentId == doc).Select(r => r.Id).ToList();
            var hasTask = req.Where(r => links.Any(l => l.RequirementId == r && l.Relation == LinkRelation.Implements)).ToList();
            var hasTest = req.Where(r => links.Any(l => l.RequirementId == r && l.Relation == LinkRelation.Verifies)).ToList();
            var openIssues = db.StageIssues.IgnoreQueryFilters().Where(i => i.Status != IssueStatus.Fixed && i.Status != IssueStatus.Resolved).Select(i => i.Id).ToList();
            var failingTests = links.Where(l => l.Relation == LinkRelation.Verifies && l.TargetType == LinkTarget.Issue && openIssues.Contains(l.TargetId)).Select(l => l.TargetId).Distinct().Count();
            var untested = req.Where(r => hasTask.Contains(r) && !hasTest.Contains(r)).SelectMany(r => links.Where(l => l.RequirementId == r && l.Relation == LinkRelation.Implements).Select(l => l.TargetId)).Distinct().Count();
            var failingReqs = links.Where(l => l.Relation == LinkRelation.Verifies && l.TargetType == LinkTarget.Issue && openIssues.Contains(l.TargetId)).Select(l => l.RequirementId).Distinct().ToList();
            return (hasTask.Count, hasTest.Count, req.Count - hasTask.Count, hasTask.Count(r => !hasTest.Contains(r)), failingTests, untested, hasTask.Count(r => hasTest.Contains(r) && !failingReqs.Contains(r)));
        });
        Assert.Equal(40, cov["requirements"]!.GetValue<int>());
        Assert.Equal(noTask, cov["withoutTask"]!.GetValue<int>());
        Assert.Equal(9, noTask);
        Assert.Equal(noTest, cov["withoutTest"]!.GetValue<int>());
        Assert.Equal(failing, cov["failingTests"]!.GetValue<int>());
        Assert.Equal(3, failing);
        Assert.Equal(untestedWork, cov["workWithoutTest"]!.GetValue<int>());
        Assert.Equal(covered, cov["covered"]!.GetValue<int>());
        Assert.Equal(31, withTask); Assert.Equal(14, withTest);

        // A task whose project the reader cannot open is counted but not named.
        var rows = cov["rows"]!.AsArray();
        Assert.Equal("Failing", S(rows[10]!["state"])); Assert.Equal("Covered", S(rows[0]!["state"])); Assert.Equal("NoTest", S(rows[20]!["state"])); Assert.Equal("NoTask", S(rows[35]!["state"]));

        // Deleting a requirement keeps its links, as links of the whole document.
        var before = (await owner.Get($"/api/v1/documents/{doc}/links")).Data!["items"]!.AsArray().Count;
        Assert.True((await owner.Delete($"/api/v1/documents/{doc}/requirements/{reqs[0].Id}")).Ok);
        Assert.Equal(before, (await owner.Get($"/api/v1/documents/{doc}/links")).Data!["items"]!.AsArray().Count);
        Assert.Equal(39, (await owner.Get($"/api/v1/documents/{doc}/coverage")).Data!["requirements"]!.GetValue<int>());

        // Publishing tells the people who build or verify what the document asks for, once each, however many links they have.
        Assert.True((await owner.Post($"/api/v1/documents/{doc}/publish", new { changeSummary = "First release", major = false, revision = await Revision(owner, doc) })).Ok);
        foreach (var dev in new[] { dev1, dev2, dev3 }) Assert.Single(await Notes(dev, "changed"));
        Assert.Empty(await Notes(bystander));
    }

    [Fact]
    public async Task Requirements_follow_the_document_rights_and_links_check_the_requirement_belongs_to_the_document()
    {
        var (owner, brd) = await Org();
        var reader = await owner.AddMemberAsync(factory, TenantRole.Member, "Rae Reader");
        var project = await owner.CreateProjectAsync("Reqs");
        var doc = await Make(owner, brd, "Doc one", project);
        var other = await Make(owner, brd, "Doc two", project);
        var task = Guid.Parse(S((await owner.CreateTaskAsync(project, "Work"))["id"]));
        var req = Guid.Parse(S((await owner.Post($"/api/v1/documents/{doc}/requirements", new { titles = new[] { "First" } })).Data!.AsArray()[0]!["id"]));

        Assert.Equal(HttpStatusCode.Forbidden, (await reader.Post($"/api/v1/documents/{doc}/requirements", new { titles = new[] { "Sneaky" } })).Status);
        Assert.True((await reader.Get($"/api/v1/documents/{doc}/requirements")).Ok);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"/api/v1/documents/{doc}/requirements", new { titles = new[] { new string('x', 301) } })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"/api/v1/documents/{other}/links", new { targetType = "Task", targetId = task, relation = "Implements", requirementId = req })).Status);   // not this document's requirement
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"/api/v1/documents/{doc}/links", new { targetType = "Task", targetId = task, relation = "References", requirementId = req })).Status);
        Assert.True((await owner.Post($"/api/v1/documents/{doc}/links", new { targetType = "Task", targetId = task, relation = "Implements", requirementId = req })).Ok);
        Assert.Equal(HttpStatusCode.Conflict, (await owner.Post($"/api/v1/documents/{doc}/links", new { targetType = "Task", targetId = task, relation = "Implements", requirementId = req })).Status);
        var changed = await owner.Put($"/api/v1/documents/{doc}/requirements/{req}", new { title = "First, clearer", detail = "More words", priority = "High" });
        Assert.True(changed.Ok, changed.ToString());
        Assert.Equal("High", S(changed.Data!.AsArray()[0]!["priority"]));
    }

    // ------------------------------------------------------------------ activity and audit

    [Fact]
    public async Task The_audit_trail_is_for_plans_with_an_audit_log_and_people_who_may_read_it_and_reading_it_is_recorded()
    {
        var (biz, brd) = await Org("BUSINESS");
        var member = await biz.AddMemberAsync(factory, TenantRole.Member, "Mia Member");
        var doc = await Make(biz, brd, "Audited", null, "Organization");
        Assert.True((await Write(biz, doc, "secret=1234")).Ok);

        Assert.Contains((await member.Get($"/api/v1/documents/{doc}/activity")).Data!.AsArray(), a => S(a!["action"]) == "document.created");   // the document's own activity is open to readers
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get($"/api/v1/documents/{doc}/audit")).Status);                                      // the trail needs the audit permission
        var trail = await biz.Get($"/api/v1/documents/{doc}/audit");
        Assert.True(trail.Ok, trail.ToString());
        var actions = trail.Data!["items"]!.AsArray().Select(i => S(i!["action"])).ToList();
        Assert.Contains("document.created", actions); Assert.Contains("document.edited", actions);
        Assert.DoesNotContain("1234", trail.Data.ToJsonString());                                                                                // content never goes into the trail
        Assert.Contains("document.audit_viewed", (await biz.Get($"/api/v1/documents/{doc}/audit")).Data!["items"]!.AsArray().Select(i => S(i!["action"])));

        var csv = await biz.Raw($"/api/v1/documents/{doc}/audit/export");
        Assert.True(csv.IsSuccessStatusCode);
        Assert.Contains("document.created", await csv.Content.ReadAsStringAsync());
        Assert.Contains("document.audit_exported", (await biz.Get($"/api/v1/documents/{doc}/audit")).Data!["items"]!.AsArray().Select(i => S(i!["action"])));

        var (pro, brdPro) = await Org("PRO");
        var proDoc = await Make(pro, brdPro, "Pro doc", null, "Organization");
        Assert.True((await pro.Get($"/api/v1/documents/{proDoc}/activity")).Ok);
        Assert.False((await pro.Get($"/api/v1/documents/{proDoc}/audit")).Ok);                                                                    // the full trail is a Business feature
    }

    [Fact]
    public async Task Every_state_changing_document_endpoint_writes_an_audit_row()
    {
        var (owner, brd) = await Org("BUSINESS");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mia Member");
        var asker = await owner.AddMemberAsync(factory, TenantRole.Member, "Ari Asker");
        var reviewer = await owner.AddMemberAsync(factory, TenantRole.Member, "Rita Reviewer");
        var project = await owner.CreateProjectAsync("Audit project");
        var task = Guid.Parse(S((await owner.CreateTaskAsync(project, "Audited work"))["id"]));
        var wf = Guid.Parse(S((await owner.Post("/api/v1/document-workflows", new { name = "Audit review", isActive = false, remind = false, steps = new[] { Step("Only step", "User", reviewer.UserId) } })).Data!["id"]));
        var doc = await Make(owner, brd, "Everything doc", null, "Team", Guid.Parse(S((await owner.Post("/api/v1/teams", new { name = "Audit team" })).Data!["team"]!["id"])));
        var spare = await Make(owner, brd, "Spare doc", project);
        Assert.True((await Write(owner, doc, "first")).Ok);

        long Rows() => factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().LongCount(a => a.TenantId == owner.WorkspaceId));
        Guid grant = Guid.Empty, link = Guid.Empty, requirement = Guid.Empty, access = Guid.Empty, file = Guid.Empty, version = Guid.Empty;

        // One scenario per write endpoint, keyed "VERB template". Each runs the call and the test checks that the audit table grew.
        var scenarios = new Dictionary<string, Func<Task<ApiResult>>>
        {
            ["POST documents"] = () => owner.Post("/api/v1/documents", new { title = "Created here", typeId = brd, projectId = project }),
            ["PUT documents/{id:guid}"] = async () => owner.Put($"/api/v1/documents/{doc}", new { title = "Everything doc 2", visibility = "Team", tags = new[] { "x" }, ownerId = (Guid?)null, revision = await Revision(owner, doc) }).Result,
            ["PUT documents/{id:guid}/sections"] = () => Write(owner, doc, "second"),
            ["POST documents/{id:guid}/archive"] = () => owner.Post($"/api/v1/documents/{spare}/archive"),
            ["POST documents/{id:guid}/reopen"] = () => owner.Post($"/api/v1/documents/{spare}/reopen"),
            ["POST documents/{id:guid}/restore"] = async () => { var gone = await Make(owner, brd, "Deleted one"); await owner.Delete($"/api/v1/documents/{gone}"); return await owner.Post($"/api/v1/documents/{gone}/restore"); },
            ["DELETE documents/{id:guid}"] = async () => owner.Delete($"/api/v1/documents/{await Make(owner, brd, "Will go")}").Result,
            ["POST documents/{id:guid}/links"] = async () => { var r = await owner.Post($"/api/v1/documents/{doc}/links", new { targetType = "Task", targetId = task, relation = "Describes" }); link = Guid.Parse(S(r.Data!["items"]![0]!["linkId"])); return r; },
            ["DELETE documents/{id:guid}/links/{linkId:guid}"] = () => owner.Delete($"/api/v1/documents/{doc}/links/{link}"),
            ["POST documents/{id:guid}/publish"] = async () => await owner.Post($"/api/v1/documents/{spare}/publish", new { changeSummary = "Spare v1", major = false, revision = await Revision(owner, spare) }),
            ["POST documents/{id:guid}/versions/{versionId:guid}/restore"] = async () =>
            {
                version = Guid.Parse(S((await owner.Get($"/api/v1/documents/{spare}/versions")).Data!["items"]!.AsArray().First(v => !v!["isDraft"]!.GetValue<bool>())!["id"]));
                return await owner.Post($"/api/v1/documents/{spare}/versions/{version}/restore", new { reason = "test", discardChanges = true, revision = await Revision(owner, spare) });
            },
            ["POST documents/{id:guid}/grants"] = async () => { var r = await owner.Post($"/api/v1/documents/{doc}/grants", new { principalType = "User", principalId = member.UserId, level = "Viewer" }); grant = Guid.Parse(S(r.Data!["grants"]![0]!["id"])); return r; },
            ["DELETE documents/{id:guid}/grants/{grantId:guid}"] = () => owner.Delete($"/api/v1/documents/{doc}/grants/{grant}"),
            ["POST documents/{id:guid}/files"] = async () => { var r = await owner.Upload($"/api/v1/documents/{doc}/files", "note.txt", System.Text.Encoding.UTF8.GetBytes("hello")); file = Guid.Parse(S(r.Data!["id"])); return r; },
            ["DELETE documents/{id:guid}/files/{fileId:guid}"] = () => owner.Delete($"/api/v1/documents/{doc}/files/{file}"),
            ["POST document-workflows"] = () => owner.Post("/api/v1/document-workflows", new { typeId = brd, name = "BRD path", isActive = true, remind = false, steps = new[] { Step("s", "User", reviewer.UserId) } }),
            ["PUT document-workflows/{id:guid}"] = () => owner.Put($"/api/v1/document-workflows/{wf}", new { typeId = (Guid?)null, name = "Audit review 2", isActive = true, remind = false, steps = new[] { Step("Only step", "User", reviewer.UserId) } }),
            ["DELETE document-workflows/{id:guid}"] = async () => { var tmp = await Workflow(owner, "Temp", [Step("t", "User", reviewer.UserId)], (await owner.Get("/api/v1/document-types")).Data!.AsArray().Where(t => S(t!["code"]) != "BRD").Select(t => Guid.Parse(S(t!["id"]))).First()); return await owner.Delete($"/api/v1/document-workflows/{tmp}"); },
            ["POST documents/{id:guid}/submit"] = async () => await Submit(owner, doc, await Revision(owner, doc)),
            ["POST documents/{id:guid}/request-changes"] = () => reviewer.Post($"/api/v1/documents/{doc}/request-changes", new { comment = "Fix it" }),
            ["POST documents/{id:guid}/withdraw"] = async () => { await Write(owner, doc, "third"); await Submit(owner, doc, await Revision(owner, doc)); return await owner.Post($"/api/v1/documents/{doc}/withdraw", new { comment = "oops" }); },
            ["POST documents/{id:guid}/approve"] = async () => { await Submit(owner, doc, await Revision(owner, doc)); return await reviewer.Post($"/api/v1/documents/{doc}/approve", new { comment = "ok" }); },
            ["POST documents/{id:guid}/access-requests"] = async () => { var r = await asker.Post($"/api/v1/documents/{doc}/access-requests", new { level = "Viewer", reason = "I need it", durationDays = 5 }); access = Guid.Parse(S(r.Data!["id"])); return r; },
            ["POST access-requests/{requestId:guid}/decide"] = () => owner.Post($"/api/v1/access-requests/{access}/decide", new { approve = true }),
            ["POST access-requests/{requestId:guid}/cancel"] = async () =>
            {
                var again = await asker.Post($"/api/v1/documents/{(await Make(owner, brd, "Another team doc", null, "Private"))}/access-requests", new { level = "Viewer", reason = "me too", durationDays = 5 });
                return again.Ok ? await asker.Post($"/api/v1/access-requests/{S(again.Data!["id"])}/cancel") : again;
            },
            ["POST documents/{id:guid}/requirements"] = async () => { var r = await owner.Post($"/api/v1/documents/{doc}/requirements", new { titles = new[] { "One" } }); requirement = Guid.Parse(S(r.Data!.AsArray()[0]!["id"])); return r; },
            ["PUT documents/{id:guid}/requirements/{requirementId:guid}"] = () => owner.Put($"/api/v1/documents/{doc}/requirements/{requirement}", new { title = "One, better", priority = "High" }),
            ["DELETE documents/{id:guid}/requirements/{requirementId:guid}"] = () => owner.Delete($"/api/v1/documents/{doc}/requirements/{requirement}"),
        };

        // 1. Every write endpoint of the controller must have a scenario (a new endpoint without one fails here, until it is covered).
        var written = typeof(DocumentsController).GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
            .SelectMany(m => m.GetCustomAttributes<HttpMethodAttribute>(true))
            .Where(a => a.HttpMethods.Any(h => h is "POST" or "PUT" or "DELETE" or "PATCH"))
            .Select(a => $"{a.HttpMethods.First()} {a.Template}").ToHashSet();
        Assert.Empty(written.Except(scenarios.Keys));
        Assert.Empty(scenarios.Keys.Except(written));

        // 2. Each scenario changes state and so must add at least one audit row. Order matters: later ones use what earlier ones made.
        foreach (var (name, run) in scenarios)
        {
            var before = Rows();
            var res = await run();
            Assert.True(res.Ok, $"{name}: {res}");
            Assert.True(Rows() > before, $"{name} wrote no audit row");
        }
    }
}
