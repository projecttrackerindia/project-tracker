using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Test issues ("Observed / Failed") found in a project's stages: reported with details and files, worked through In progress and Fixed,
/// confirmed by the tester. A stage cannot be completed while any of its issues is open, so the project only moves on once testing passed.
/// </summary>
[Collection("api")]
public class IssueTests(ApiFactory factory)
{
    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52];

    private sealed record World(TestClient Owner, TestClient Manager, TestClient Tester, TestClient Dev, TestClient Outsider, Guid Project, Dictionary<string, Guid> Stages);

    /// <summary>A project whose timeline has been worked up to Testing / QA (Requirements, Development and Code Review are completed).</summary>
    private async Task<World> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var manager = await owner.AddMemberAsync(factory, TenantRole.Manager, "Maya Manager");
        var tester = await owner.AddMemberAsync(factory, TenantRole.Member, "Tara Tester");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Developer");
        var outsider = await owner.AddMemberAsync(factory, TenantRole.Member, "Olly Outsider");

        var create = await owner.Post("/api/v1/projects", new { name = "Atlas", priority = "Medium", memberIds = new[] { tester.UserId, dev.UserId, manager.UserId } });
        Assert.True(create.Ok, create.ToString());
        var project = Guid.Parse(create.Data!["project"]!["id"]!.GetValue<string>());
        var stages = (await owner.Get($"/api/v1/projects/{project}/stages")).Data!.AsArray()
            .ToDictionary(s => s!["name"]!.GetValue<string>(), s => Guid.Parse(s!["id"]!.GetValue<string>()));
        foreach (var name in new[] { "Requirements & Planning", "Development", "Code Review" })
        {
            var done = await owner.Put($"/api/v1/projects/{project}/stages/{stages[name]}", new { name, status = "Completed" });
            Assert.True(done.Ok, done.ToString());
        }
        return new World(owner, manager, tester, dev, outsider, project, stages);
    }

    private static string Issues(Guid project) => $"/api/v1/projects/{project}/issues";
    private static Guid IssueId(ApiResult r) => Guid.Parse(r.Data!["issue"]!["id"]!.GetValue<string>());
    private static string StatusOf(ApiResult r) => r.Data!["issue"]!["status"]!.GetValue<string>();

    private async Task<Guid> Report(World w, TestClient by, string title = "Login button does nothing", Guid? assignee = null, Guid? stage = null)
    {
        var res = await by.Post(Issues(w.Project), new { stageId = stage ?? w.Stages["Testing / QA"], title, details = "Steps: open login, click. Expected: signs in. Actual: nothing.", severity = "High", assigneeId = assignee });
        Assert.True(res.Ok, res.ToString());
        return IssueId(res);
    }

    private Task<ApiResult> Move(TestClient by, World w, Guid issue, string status, string? note = null) =>
        by.Put($"{Issues(w.Project)}/{issue}/status", new { status, note });

    private static async Task<JsonNode> StageOf(TestClient c, Guid project, Guid stage) =>
        (await c.Get($"/api/v1/projects/{project}/stages")).Data!.AsArray().First(s => s!["id"]!.GetValue<string>() == stage.ToString())!;

    // ------------------------------------------------------------------ reporting

    [Fact]
    public async Task A_tester_reports_an_issue_as_observed_with_its_details()
    {
        var w = await Setup();
        var res = await w.Tester.Post(Issues(w.Project), new { stageId = w.Stages["Testing / QA"], title = "  Total is wrong  ", details = "Cart shows 10, expected 12", severity = "Critical" });
        Assert.True(res.Ok, res.ToString());
        var issue = res.Data!["issue"]!;
        Assert.Equal("Observed", issue["status"]!.GetValue<string>());
        Assert.Equal("Total is wrong", issue["title"]!.GetValue<string>());
        Assert.Equal("Critical", issue["severity"]!.GetValue<string>());
        Assert.Equal("Testing / QA", issue["stageName"]!.GetValue<string>());
        Assert.Equal("Tara Tester", issue["reporter"]!["name"]!.GetValue<string>());
        Assert.EndsWith("-I1", issue["key"]!.GetValue<string>());
        Assert.Equal("reported", res.Data["history"]![0]!["kind"]!.GetValue<string>());

        // The next one is numbered on, the list shows both, and a title is required.
        await Report(w, w.Tester, "Second problem");
        Assert.Equal(2, (await w.Owner.Get(Issues(w.Project))).Data!.AsArray().Count);
        var noTitle = await w.Tester.Post(Issues(w.Project), new { stageId = w.Stages["Testing / QA"], title = "  " });
        Assert.Equal(422, (int)noTitle.Status);
    }

    [Fact]
    public async Task With_no_stage_named_the_issue_goes_to_the_stage_being_worked_on()
    {
        var w = await Setup();
        // Testing / QA is the first stage that is not completed and not locked.
        var res = await w.Tester.Post(Issues(w.Project), new { title = "Something is off" });
        Assert.True(res.Ok, res.ToString());
        Assert.Equal("Testing / QA", res.Data!["issue"]!["stageName"]!.GetValue<string>());
    }

    [Fact]
    public async Task An_issue_cannot_be_reported_on_a_stage_that_is_still_locked()
    {
        var w = await Setup();
        var res = await w.Tester.Post(Issues(w.Project), new { stageId = w.Stages["UAT"], title = "Too early" });
        Assert.Equal(409, (int)res.Status);
        Assert.Equal("STAGE_PREVIOUS_INCOMPLETE", res.ErrorCode);
    }

    // ------------------------------------------------------------------ the stage waits for its issues

    [Fact]
    public async Task A_stage_cannot_be_completed_while_an_issue_is_open_and_completes_once_it_is_resolved()
    {
        var w = await Setup();
        var qa = w.Stages["Testing / QA"];
        var task = Guid.Parse((await w.Owner.CreateTaskAsync(w.Project, "Run regression", new { title = "Run regression", priority = "Medium", stageId = qa }))["id"]!.GetValue<string>());
        var statuses = (await w.Owner.Get($"/api/v1/projects/{w.Project}/statuses")).Data!.AsArray();
        var done = Guid.Parse(statuses.First(s => s!["category"]!.GetValue<string>() == "Done")!["id"]!.GetValue<string>());

        var issue = await Report(w, w.Tester, assignee: w.Dev.UserId);
        Assert.Equal(1, (await StageOf(w.Owner, w.Project, qa))["openIssues"]!.GetValue<int>());

        // Finishing every task does not complete the stage: the open issue holds it back...
        var finish = await w.Owner.Send(HttpMethod.Patch, $"/api/v1/tasks/{task}/move", new { statusId = done });
        Assert.True(finish.Ok, finish.ToString());
        Assert.NotEqual("Completed", (await StageOf(w.Owner, w.Project, qa))["status"]!.GetValue<string>());
        Assert.True((await StageOf(w.Owner, w.Project, w.Stages["UAT"]))["locked"]!.GetValue<bool>());

        // ...and completing it by hand is refused with the reason.
        var manual = await w.Owner.Put($"/api/v1/projects/{w.Project}/stages/{qa}", new { name = "Testing / QA", status = "Completed" });
        Assert.Equal(409, (int)manual.Status);
        Assert.Equal("STAGE_HAS_OPEN_ISSUES", manual.ErrorCode);

        // The developer picks it up and marks it fixed; the tester confirms - and only then does the stage complete and UAT open up.
        Assert.True((await Move(w.Dev, w, issue, "InProgress")).Ok);
        Assert.True((await Move(w.Dev, w, issue, "Fixed")).Ok);
        Assert.NotEqual("Completed", (await StageOf(w.Owner, w.Project, qa))["status"]!.GetValue<string>());
        var resolved = await Move(w.Tester, w, issue, "Resolved");
        Assert.True(resolved.Ok, resolved.ToString());
        Assert.Equal("Resolved", StatusOf(resolved));
        var stage = await StageOf(w.Owner, w.Project, qa);
        Assert.Equal("Completed", stage["status"]!.GetValue<string>());
        Assert.Equal(0, stage["openIssues"]!.GetValue<int>());
        Assert.Equal(1, stage["totalIssues"]!.GetValue<int>());
        Assert.False((await StageOf(w.Owner, w.Project, w.Stages["UAT"]))["locked"]!.GetValue<bool>());
    }

    [Fact]
    public async Task A_new_issue_puts_a_completed_stage_back_in_progress_and_a_fix_that_fails_reopens_it()
    {
        var w = await Setup();
        var qa = w.Stages["Testing / QA"];
        // A stage without tasks is completed by hand.
        Assert.True((await w.Owner.Put($"/api/v1/projects/{w.Project}/stages/{qa}", new { name = "Testing / QA", status = "Completed" })).Ok);

        var issue = await Report(w, w.Tester, assignee: w.Dev.UserId);
        Assert.Equal("InProgress", (await StageOf(w.Owner, w.Project, qa))["status"]!.GetValue<string>());

        // Retest fails after the fix: it goes back to Observed and needs a note saying what still fails.
        Assert.True((await Move(w.Dev, w, issue, "Fixed")).Ok);
        var noNote = await Move(w.Tester, w, issue, "Observed");
        Assert.Equal(422, (int)noNote.Status);
        var back = await Move(w.Tester, w, issue, "Observed", "Still fails on Safari");
        Assert.True(back.Ok, back.ToString());
        var last = back.Data!["history"]!.AsArray().Last()!;
        Assert.Equal("Still fails on Safari", last["note"]!.GetValue<string>());
        Assert.Equal("Fixed", last["from"]!.GetValue<string>());
        Assert.Equal("Observed", last["to"]!.GetValue<string>());

        // Deleting the issue (the last thing holding the stage open) lets a stage with all its work done complete again on the next check;
        // here it simply stays In progress because a stage without tasks is only ever completed by hand.
        Assert.Equal(204, (int)(await w.Tester.Delete($"{Issues(w.Project)}/{issue}")).Status);
        Assert.Equal(0, (await StageOf(w.Owner, w.Project, qa))["openIssues"]!.GetValue<int>());
        Assert.True((await w.Owner.Put($"/api/v1/projects/{w.Project}/stages/{qa}", new { name = "Testing / QA", status = "Completed" })).Ok);
    }

    // ------------------------------------------------------------------ who may do what

    [Fact]
    public async Task Each_person_can_only_make_the_changes_that_are_theirs_to_make()
    {
        var w = await Setup();
        var issue = await Report(w, w.Tester, assignee: w.Dev.UserId);
        var url = $"{Issues(w.Project)}/{issue}";

        // Somebody who neither found nor fixes it can look, but not change it.
        var view = await w.Outsider.Get(url);
        Assert.True(view.Ok, view.ToString());
        Assert.Empty(view.Data!["issue"]!["can"]!["moveTo"]!.AsArray());
        var denied = await Move(w.Outsider, w, issue, "InProgress");
        Assert.Equal(403, (int)denied.Status);
        Assert.Equal("ISSUE_STATUS_DENIED", denied.ErrorCode);
        Assert.Equal(403, (int)(await w.Outsider.Put(url, new { title = "Renamed" })).Status);
        Assert.Equal(403, (int)(await w.Outsider.Delete(url)).Status);

        // The developer moves it along but cannot mark their own fix as verified, nor edit or reassign it.
        var dev = await w.Dev.Get(url);
        Assert.Equal(new[] { "InProgress", "Fixed" }, dev.Data!["issue"]!["can"]!["moveTo"]!.AsArray().Select(s => s!.GetValue<string>()));
        Assert.True((await Move(w.Dev, w, issue, "Fixed")).Ok);
        Assert.Equal(403, (int)(await Move(w.Dev, w, issue, "Resolved")).Status);
        Assert.Equal(403, (int)(await w.Dev.Put($"{url}/assignee", new { assigneeId = w.Dev.UserId })).Status);

        // The tester (reporter) confirms it; a manager could have too.
        Assert.True((await Move(w.Tester, w, issue, "Resolved")).Ok);
        var second = await Report(w, w.Tester, "Another one");
        Assert.True((await Move(w.Manager, w, second, "Resolved")).Ok);

        // The reporter may edit and assign their issue.
        var third = await Report(w, w.Tester, "Third");
        var edited = await w.Tester.Put($"{Issues(w.Project)}/{third}", new { title = "Third, renamed", severity = "Low" });
        Assert.True(edited.Ok, edited.ToString());
        Assert.Equal("Third, renamed", edited.Data!["issue"]!["title"]!.GetValue<string>());
        var assigned = await w.Tester.Put($"{Issues(w.Project)}/{third}/assignee", new { assigneeId = w.Dev.UserId });
        Assert.Equal("Dev Developer", assigned.Data!["issue"]!["assignee"]!["name"]!.GetValue<string>());
    }

    [Fact]
    public async Task People_outside_the_project_do_not_see_its_issues()
    {
        var w = await Setup();
        var issue = await Report(w, w.Tester);
        // A guest who was never added to the project gets "not found", as for everything else in it.
        var guest = await w.Owner.AddMemberAsync(factory, TenantRole.Guest, "Gus Guest");
        Assert.Equal(404, (int)(await guest.Get(Issues(w.Project))).Status);
        Assert.Equal(404, (int)(await guest.Get($"{Issues(w.Project)}/{issue}")).Status);

        // Added to it, a guest (a business user testing) can see and report issues.
        Assert.True((await w.Owner.Post($"/api/v1/projects/{w.Project}/members", new { userId = guest.UserId })).Ok);
        Assert.Single((await guest.Get(Issues(w.Project))).Data!.AsArray());
        Assert.True((await guest.Post(Issues(w.Project), new { stageId = w.Stages["Testing / QA"], title = "Found by a business user" })).Ok);
    }

    // ------------------------------------------------------------------ supporting documents

    [Fact]
    public async Task Supporting_files_belong_to_the_issue_and_stay_out_of_the_projects_own_files()
    {
        var w = await Setup();
        var issue = await Report(w, w.Tester, assignee: w.Dev.UserId);
        var files = $"{Issues(w.Project)}/{issue}/attachments";

        var up = await w.Tester.Upload(files, "screenshot.png", Png);
        Assert.Equal(201, (int)up.Status);
        Assert.Equal(issue.ToString(), up.Data!["issueId"]!.GetValue<string>());
        var fileId = Guid.Parse(up.Data["id"]!.GetValue<string>());
        Assert.True((await w.Dev.Upload(files, "log.txt", "stack trace"u8.ToArray())).Ok);       // the person fixing it can add evidence too

        Assert.Equal(2, (await w.Manager.Get(files)).Data!.AsArray().Count);
        Assert.Empty((await w.Owner.Get($"/api/v1/projects/{w.Project}/attachments")).Data!.AsArray());   // not mixed into the project's files
        Assert.Equal(2, (await w.Owner.Get($"{Issues(w.Project)}/{issue}")).Data!["issue"]!["fileCount"]!.GetValue<int>());

        using var download = await w.Dev.Raw($"/api/v1/attachments/{fileId}/download");
        Assert.True(download.IsSuccessStatusCode);
        Assert.Equal(Png, await download.Content.ReadAsByteArrayAsync());

        // Somebody unrelated cannot add files, and a file of the wrong type is refused like anywhere else.
        Assert.Equal(403, (int)(await w.Outsider.Upload(files, "x.png", Png)).Status);
        Assert.Equal(422, (int)(await w.Tester.Upload(files, "virus.exe", [1, 2, 3])).Status);

        // Deleting the issue removes its files.
        Assert.Equal(204, (int)(await w.Tester.Delete($"{Issues(w.Project)}/{issue}")).Status);
        Assert.Equal(404, (int)(await w.Owner.Raw($"/api/v1/attachments/{fileId}/download")).StatusCode);
    }

    // ------------------------------------------------------------------ people are told

    [Fact]
    public async Task The_people_involved_are_notified_as_the_issue_moves()
    {
        var w = await Setup();
        var issue = await Report(w, w.Tester, "Crash on save", assignee: w.Dev.UserId);

        async Task<string[]> Titles(TestClient c) =>
            (await c.Get("/api/v1/notifications?unreadOnly=true")).Data!["items"]!.AsArray().Select(n => n!["title"]!.GetValue<string>()).ToArray();

        Assert.Contains(await Titles(w.Dev), t => t.Contains("Crash on save"));       // the assignee hears about it at once
        Assert.Contains(await Titles(w.Owner), t => t.Contains("Crash on save"));     // and so does the project owner
        Assert.DoesNotContain(await Titles(w.Tester), t => t.Contains("Crash on save")); // but not the person who just reported it

        Assert.True((await Move(w.Dev, w, issue, "Fixed")).Ok);
        Assert.Contains(await Titles(w.Tester), t => t.Contains("fixed") && t.Contains("retest"));
    }

    // ------------------------------------------------------------------ deleting a stage

    [Fact]
    public async Task Deleting_a_stage_keeps_its_issues_as_history()
    {
        var w = await Setup();
        var issue = await Report(w, w.Tester);
        var del = await w.Owner.Delete($"/api/v1/projects/{w.Project}/stages/{w.Stages["Testing / QA"]}");
        Assert.True(del.Ok, del.ToString());
        var kept = await w.Owner.Get($"{Issues(w.Project)}/{issue}");
        Assert.True(kept.Ok, kept.ToString());
        Assert.Null(kept.Data!["issue"]!["stageId"]);
    }
}
