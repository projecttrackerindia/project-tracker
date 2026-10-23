using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The Markdown an AI model writes becomes the page editor's blocks (and back), safely.</summary>
public class MarkdownDocTests
{
    [Fact]
    public void Model_markdown_becomes_editor_blocks()
    {
        var doc = MarkdownDoc.ToDoc("""
            # Ignored title level
            A **bold** start with a [link](https://example.com) and `code`.

            ## Steps
            - [ ] Call the bank
            - [x] Write the letter
            1. First
            2. Second
               - nested
            > Note this

            | Step | Owner |
            |---|---|
            | Check | TBD |

            ```sql
            select 1;
            ```
            ---
            [bad](javascript:alert(1))
            """);
        var blocks = doc["content"]!.AsArray().Select(b => b!["type"]!.GetValue<string>()).ToList();
        Assert.Equal(["heading", "paragraph", "heading", "taskList", "orderedList", "blockquote", "table", "codeBlock", "horizontalRule", "paragraph"], blocks);
        var json = doc.ToJsonString();
        Assert.Contains("\"bold\"", json);
        Assert.Contains("https://example.com", json);
        Assert.DoesNotContain("javascript:", json);
        Assert.Contains("\"checked\":true", json);
        Assert.Contains("bulletList", json);   // the nested list
        // The page sanitizer keeps all of it.
        var clean = SectionContent.NormalizeRichText(json);
        Assert.Contains("taskList", clean);
        Assert.Contains("tableHeader", clean);
        // And back to Markdown for prompts.
        var md = MarkdownDoc.ToMarkdown(clean);
        Assert.Contains("## Steps", md);
        Assert.Contains("- [x] Write the letter", md);
        Assert.Contains("| Step | Owner |", md);
    }

    [Fact]
    public void Toggles_live_task_lists_and_comment_marks_are_kept_as_data()
    {
        var json = """{"type":"doc","content":[{"type":"details","attrs":{"open":true,"onclick":"x"},"content":[{"type":"detailsSummary","content":[{"type":"text","text":"More"}]},{"type":"detailsContent","content":[{"type":"paragraph","content":[{"type":"text","text":"Hidden","marks":[{"type":"comment","attrs":{"id":"c-1"}},{"type":"comment","attrs":{"id":"<script>"}}]}]}]}]},{"type":"liveTasks","attrs":{"projectId":"not-a-guid","filter":"evil","limit":999}}]}""";
        var clean = SectionContent.NormalizeRichText(json);
        Assert.Contains("\"type\":\"details\",\"attrs\":{\"open\":true}", clean);
        Assert.DoesNotContain("onclick", clean);
        Assert.Contains("\"id\":\"c-1\"", clean);
        Assert.DoesNotContain("script", clean);
        Assert.Contains("\"filter\":\"open\"", clean);
        Assert.Contains("\"limit\":50", clean);
        Assert.Contains("\"projectId\":\"\"", clean);
    }
}

/// <summary>
/// Documents release 2: AI writes a page (from a line, files or a project's tasks), edits selected text and translates it, answers questions
/// from the pages with citations; ranked search with the matching line; pages that go out of date and get verified; comment threads on
/// selected text; and drafts that write themselves (release notes from a sprint, a decision log from meetings) waiting for approval.
/// </summary>
[Collection("api")]
public class DocumentsRelease2Tests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<(TestClient Owner, Guid PageType, Guid Project)> Setup(string name = "Rhea Writer")
    {
        factory.Ai.Reset();
        var owner = await TestClient.RegisterAsync(factory, name);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var types = (await owner.Get("/api/v1/document-types")).Data!.AsArray();
        var page = Guid.Parse(S(types.First(t => S(t!["code"]) == "PAGE")!["id"]));
        var project = await owner.CreateProjectAsync("Refunds");
        return (owner, page, project);
    }

    private static async Task<Guid> NewPage(TestClient c, Guid type, string title, Guid project, string body)
    {
        var res = await c.Post("/api/v1/documents", new { title, typeId = type, projectId = project, sections = new[] { new { key = "body", content = body } } });
        Assert.Equal(HttpStatusCode.Created, res.Status);
        return Guid.Parse(S(res.Data!["item"]!["id"]));
    }

    private static string Para(string text) => new JsonObject { ["type"] = "doc", ["content"] = new JsonArray(new JsonObject { ["type"] = "paragraph", ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = text }) }) }.ToJsonString();

    [Fact]
    public async Task Ai_writes_a_page_edits_and_translates_text_and_answers_from_the_pages_with_citations()
    {
        var (c, pageType, project) = await Setup();
        // Off on the server: a clear refusal, not an error.
        Assert.Equal(HttpStatusCode.Conflict, (await c.Upload("/api/v1/documents/ai/draft", "none.txt", [1], new Dictionary<string, string> { ["source"] = "prompt", ["prompt"] = "A refund policy" })).Status);

        factory.Ai.Configured = true;
        factory.Ai.Answer = (system, user) =>
            system.Contains("You write pages") ? "# Refund policy\n\nRefunds take five working days.\n\n## Steps\n- [ ] Call the bank\n\n| Step | Owner |\n|---|---|\n| Check | TBD |"
            : system.Contains("You edit text") ? "రీఫండ్‌లకు ఐదు పని దినాలు పడుతుంది."
            : system.Contains("You continue writing") ? "Next, the bank confirms the transfer."
            : system.Contains("You answer questions") ? "Refunds take five working days [1]."
            : "{}";

        var draft = await c.Upload("/api/v1/documents/ai/draft", "none.txt", [1], new Dictionary<string, string> { ["source"] = "prompt", ["prompt"] = "A refund policy for the support team", ["language"] = "en" });
        Assert.True(draft.Ok, draft.ToString());
        Assert.Equal("Refund policy", S(draft.Data!["title"]));
        var body = S(draft.Data["body"]);
        Assert.Contains("taskList", body);
        Assert.Contains("table", body);
        Assert.Contains("English", factory.Ai.Prompts.Last().System);
        Assert.Contains("TBD", factory.Ai.Prompts.Last().System);

        // From files: what is in them is what the model reads.
        var fromFile = await c.Upload("/api/v1/documents/ai/draft", "notes.txt", Encoding.UTF8.GetBytes("Refunds are paid back within five working days of approval."),
            new Dictionary<string, string> { ["source"] = "files", ["language"] = "te" });
        Assert.True(fromFile.Ok, fromFile.ToString());
        Assert.Contains("within five working days", factory.Ai.Prompts.Last().User);
        Assert.Contains("Telugu", factory.Ai.Prompts.Last().System);
        Assert.Contains("File notes.txt", fromFile.Data!["sources"]!.ToJsonString());

        // From the project's work.
        await c.CreateTaskAsync(project, "Bank certification for refunds");
        var fromTasks = await c.Upload("/api/v1/documents/ai/draft", "none.txt", [1], new Dictionary<string, string> { ["source"] = "tasks", ["projectId"] = project.ToString() });
        Assert.True(fromTasks.Ok, fromTasks.ToString());
        Assert.Contains("Bank certification for refunds", factory.Ai.Prompts.Last().User);
        Assert.Equal(422, (int)(await c.Upload("/api/v1/documents/ai/draft", "none.txt", [1], new Dictionary<string, string> { ["source"] = "tasks" })).Status);

        // Selected text: translate (needs a language), then continue writing.
        var tr = await c.Post("/api/v1/documents/ai/transform", new { text = "Refunds take five working days.", action = "translate", language = "te" });
        Assert.True(tr.Ok, tr.ToString());
        Assert.Contains("Telugu", factory.Ai.Prompts.Last().System);
        Assert.True(tr.Data!["inline"]!.GetValue<bool>());   // one plain paragraph: it replaces the words inside their line
        Assert.Contains("paragraph", S(tr.Data["blocks"]));
        Assert.Equal(422, (int)(await c.Post("/api/v1/documents/ai/transform", new { text = "x", action = "translate" })).Status);
        Assert.Equal(422, (int)(await c.Post("/api/v1/documents/ai/transform", new { text = "x", action = "summon" })).Status);

        var pageId = await NewPage(c, pageType, "Refund policy", project, body);
        var more = await c.Post("/api/v1/documents/ai/continue", new { documentId = pageId, before = "Refunds take five working days." });
        Assert.True(more.Ok, more.ToString());
        Assert.Contains("bank confirms", S(more.Data!["text"]));

        // Ranked search with the matching line, here and from the search bar.
        var found = (await c.Get("/api/v1/documents/search?q=refunds%20working")).Data!;
        var hit = found["hits"]!.AsArray().First(h => S(h!["id"]) == pageId.ToString())!;
        Assert.Contains("five working days", S(hit["line"]));
        Assert.Contains((await c.Get("/api/v1/search?q=refunds")).Data!["hits"]!.AsArray(), h => S(h!["type"]) == "page" && S(h["id"]) == pageId.ToString());

        // Ask the space: the answer cites the page and the block it came from.
        var ask = await c.Post("/api/v1/documents/ai/ask", new { question = "How long do refunds take?" });
        Assert.True(ask.Ok, ask.ToString());
        Assert.True(ask.Data!["found"]!.GetValue<bool>());
        var cite = ask.Data["citations"]!.AsArray()[0]!;
        Assert.Equal(pageId.ToString(), S(cite["documentId"]));
        Assert.True(cite["block"]!.GetValue<int>() >= 0);
        Assert.Contains("five working days", factory.Ai.Prompts.Last().User);
        factory.Ai.Reset();
    }

    [Fact]
    public async Task A_page_goes_out_of_date_when_its_work_changes_and_a_verified_badge_clears_it()
    {
        var (c, pageType, project) = await Setup("Vera Verify");
        var task = await c.CreateTaskAsync(project, "Refund export");
        var mention = new JsonObject
        {
            ["type"] = "doc",
            ["content"] = new JsonArray(new JsonObject
            {
                ["type"] = "paragraph",
                ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = "Depends on " },
                    new JsonObject { ["type"] = "mention", ["attrs"] = new JsonObject { ["kind"] = "task", ["id"] = S(task["id"]), ["label"] = "Refund export" } }),
            }),
        }.ToJsonString();
        var page = await NewPage(c, pageType, "Export design", project, mention);
        Assert.False((await c.Get($"/api/v1/documents/{page}/freshness")).Data!["stale"]!.GetValue<bool>());

        await Task.Delay(30);
        var done = S((await c.Get($"/api/v1/projects/{project}/statuses")).Data!.AsArray().First(s => S(s!["name"]) == "Done")!["id"]);
        Assert.True((await c.Send(HttpMethod.Patch, $"/api/v1/tasks/{task["id"]}/move", new { statusId = done })).Ok);
        var fresh = (await c.Get($"/api/v1/documents/{page}/freshness")).Data!;
        Assert.True(fresh["stale"]!.GetValue<bool>(), fresh.ToJsonString());
        Assert.Equal("task", S(fresh["reasons"]![0]!["kind"]));
        Assert.Contains("now Done", S(fresh["summary"]));
        Assert.True(fresh["canVerify"]!.GetValue<bool>());

        // The nightly check marks it and tells the owner once.
        using (var scope = factory.Services.CreateScope())
            Assert.True(await scope.ServiceProvider.GetRequiredService<DocumentFreshnessService>().SweepAsync(scope.ServiceProvider) >= 1);
        Assert.Contains("may be out of date", (await c.Get("/api/v1/notifications")).Data!.ToJsonString());
        var listed = (await c.Get($"/api/v1/documents?projectId={project}")).Data!["items"]!.AsArray().First(d => S(d!["id"]) == page.ToString())!;
        Assert.NotNull(listed["staleSince"]);

        // Saving the very same text (an editor opening the page for co-editing does) is not a review: the warning stays.
        var detail = (await c.Get($"/api/v1/documents/{page}")).Data!;
        var same = await c.Send(HttpMethod.Put, $"/api/v1/documents/{page}/sections", new { revision = detail["revision"]!.GetValue<int>(), sections = new[] { new { key = "body", content = mention } } });
        Assert.True(same.Ok, same.ToString());
        Assert.True((await c.Get($"/api/v1/documents/{page}/freshness")).Data!["stale"]!.GetValue<bool>());

        var verified = await c.Post($"/api/v1/documents/{page}/verify", new { note = "Checked with the team" });
        Assert.True(verified.Ok, verified.ToString());
        Assert.False(verified.Data!["stale"]!.GetValue<bool>());
        Assert.Equal("Vera Verify", S(verified.Data["verifiedBy"]));
        listed = (await c.Get($"/api/v1/documents?projectId={project}")).Data!["items"]!.AsArray().First(d => S(d!["id"]) == page.ToString())!;
        Assert.NotNull(listed["verifiedAt"]);
        Assert.Null(listed["staleSince"]);
    }

    [Fact]
    public async Task Comments_on_selected_text_are_threads_that_can_be_resolved_and_a_reply_reopens_them()
    {
        var (c, pageType, project) = await Setup("Cora Comment");
        var page = await NewPage(c, pageType, "Refund letter", project, Para("Refunds take five working days."));
        var thread = await c.Post($"/api/v1/documents/{page}/comments", new { body = "Is five right?", anchorId = "c-1a2b", quote = "five working days" });
        Assert.Equal(HttpStatusCode.Created, thread.Status);
        Assert.Equal("c-1a2b", S(thread.Data!["anchorId"]));
        Assert.Equal("five working days", S(thread.Data["quote"]));
        var root = S(thread.Data["id"]);
        var reply = await c.Post($"/api/v1/documents/{page}/comments", new { body = "Yes, finance confirmed.", parentId = root, anchorId = "ignored" });
        Assert.Equal(root, S(reply.Data!["parentId"]));
        Assert.Null(reply.Data["anchorId"]);

        var resolved = await c.Post($"/api/v1/documents/{page}/comments/{root}/resolve", new { resolved = true });
        Assert.True(resolved.Ok, resolved.ToString());
        Assert.NotNull(resolved.Data!["resolvedAt"]);
        Assert.Equal("Cora Comment", S(resolved.Data["resolvedBy"]));
        Assert.Equal(422, (int)(await c.Post($"/api/v1/documents/{page}/comments/{S(reply.Data["id"])}/resolve", new { resolved = true })).Status);

        Assert.Equal(HttpStatusCode.Created, (await c.Post($"/api/v1/documents/{page}/comments", new { body = "Actually, seven.", parentId = root })).Status);
        var list = (await c.Get($"/api/v1/documents/{page}/comments")).Data!.AsArray();
        Assert.Null(list.First(x => S(x!["id"]) == root)!["resolvedAt"]);
        Assert.Equal(2, list.Count(x => x!["parentId"] is not null));
        Assert.Equal(422, (int)(await c.Post($"/api/v1/documents/{page}/comments", new { body = "x", anchorId = "<bad>" })).Status);
    }

    [Fact]
    public async Task A_finished_sprint_and_a_meetings_decisions_become_drafts_that_are_added_only_when_accepted()
    {
        var (c, _, project) = await Setup("Petra Proposal");
        var t1 = Guid.Parse(S((await c.CreateTaskAsync(project, "Refund export to CSV"))["id"]));
        var t2 = Guid.Parse(S((await c.CreateTaskAsync(project, "Fix rounding bug in refunds"))["id"]));
        var t3 = Guid.Parse(S((await c.CreateTaskAsync(project, "Dark theme"))["id"]));
        var day = (int d) => DateTime.UtcNow.AddDays(d).ToString("yyyy-MM-dd");
        var sprint = Guid.Parse(S((await c.Post($"/api/v1/projects/{project}/sprints", new { name = "Sprint 7", goal = "Refunds", startDate = day(0), endDate = day(13) })).Data!["id"]));
        Assert.True((await c.Post($"/api/v1/projects/{project}/sprints/{sprint}/tasks", new { taskIds = new[] { t1, t2, t3 } })).Ok);
        Assert.True((await c.Post($"/api/v1/projects/{project}/sprints/{sprint}/start")).Ok);
        var done = S((await c.Get($"/api/v1/projects/{project}/statuses")).Data!.AsArray().First(s => S(s!["name"]) == "Done")!["id"]);
        foreach (var t in new[] { t1, t2 }) Assert.True((await c.Send(HttpMethod.Patch, $"/api/v1/tasks/{t}/move", new { statusId = done })).Ok);
        Assert.True((await c.Post($"/api/v1/projects/{project}/sprints/{sprint}/complete", new { moveUnfinishedTo = (Guid?)null })).Ok);

        var drafts = (await c.Get($"/api/v1/documents/proposals?projectId={project}")).Data!.AsArray();
        var notes = drafts.Single(d => S(d!["kind"]) == "release-notes")!;
        Assert.Equal("Release notes – Sprint 7", S(notes["title"]));
        Assert.Equal("create", S(notes["action"]));
        Assert.Contains("Refund export to CSV", S(notes["body"]));
        Assert.Contains("Fixes", S(notes["body"]));
        Assert.DoesNotContain("Dark theme", S(notes["body"]));
        var accepted = await c.Post($"/api/v1/documents/proposals/{S(notes["id"])}/accept");
        Assert.True(accepted.Ok, accepted.ToString());
        var page = S(accepted.Data!["documentId"]);
        Assert.Contains("Refund export to CSV", (await c.Get($"/api/v1/documents/{page}")).Data!.ToJsonString());
        Assert.Equal(HttpStatusCode.NotFound, (await c.Post($"/api/v1/documents/proposals/{S(notes["id"])}/accept")).Status);   // once

        // Two meetings with decisions: one decision log, the newest entry on top.
        Guid Meeting(string title, int daysAgo, string decision) => factory.WithDb(db =>
        {
            var m = new ProjectMeeting { TenantId = c.WorkspaceId, ProjectId = project, OrganizerUserId = c.UserId, Title = title, StartTimeUtc = DateTime.UtcNow.AddDays(-daysAgo), EndTimeUtc = DateTime.UtcNow.AddDays(-daysAgo).AddHours(1), CreatedAt = DateTime.UtcNow };
            var run = new AgentRun { TenantId = c.WorkspaceId, ProjectId = project, Trigger = "meeting", Status = "done", StartedAt = DateTime.UtcNow, MeetingId = m.Id, CreatedAt = DateTime.UtcNow };
            db.ProjectMeetings.Add(m); db.AgentRuns.Add(run);
            db.AgentFindings.Add(new AgentFinding { TenantId = c.WorkspaceId, ProjectId = project, RunId = run.Id, Kind = AgentFindingKind.Decision, Status = AgentFindingStatus.Applied, Title = decision, CreatedAt = DateTime.UtcNow });
            db.SaveChanges();
            return m.Id;
        });
        var first = Meeting("Refund review", 3, "Refunds are paid within five working days");
        var log1 = await c.Post("/api/v1/documents/proposals/generate", new { kind = "decision-log", projectId = project, sourceId = first });
        Assert.True(log1.Ok, log1.ToString());
        Assert.Equal("Decision log", S(log1.Data!["title"]));
        var logPage = S((await c.Post($"/api/v1/documents/proposals/{S(log1.Data["id"])}/accept")).Data!["documentId"]);

        var second = Meeting("Refund follow-up", 0, "Partial refunds need a manager's approval");
        var log2 = (await c.Post("/api/v1/documents/proposals/generate", new { kind = "decision-log", projectId = project, sourceId = second })).Data!;
        Assert.Equal(logPage, S(log2["targetDocumentId"]));
        Assert.Equal("add", S(log2["action"]));
        Assert.True((await c.Post($"/api/v1/documents/proposals/{S(log2["id"])}/accept")).Ok);
        var text = (await c.Get($"/api/v1/documents/{logPage}")).Data!.ToJsonString();
        Assert.True(text.IndexOf("Partial refunds", StringComparison.Ordinal) < text.IndexOf("five working days", StringComparison.Ordinal), "the newest decision comes first");

        // Dismissed stays dismissed when the same meeting is read again.
        var third = Meeting("Refund retro", 0, "Retire the old refund form");
        var log3 = (await c.Post("/api/v1/documents/proposals/generate", new { kind = "decision-log", projectId = project, sourceId = third })).Data!;
        Assert.Equal(HttpStatusCode.NoContent, (await c.Post($"/api/v1/documents/proposals/{S(log3["id"])}/dismiss")).Status);
        using (var scope = factory.Services.CreateScope())
        {
            var cc = scope.ServiceProvider.GetRequiredService<ProjectManagement.Application.Abstractions.CurrentContext>();
            cc.TenantId = c.WorkspaceId; cc.UserId = c.UserId; cc.Role = ProjectManagement.Domain.Enums.TenantRole.Owner; cc.WorkspaceType = ProjectManagement.Domain.Enums.WorkspaceType.Organization;
            await scope.ServiceProvider.GetRequiredService<DocumentProposalService>().SuggestAsync("decision-log", third);
        }
        Assert.DoesNotContain((await c.Get($"/api/v1/documents/proposals?projectId={project}")).Data!.AsArray(), d => S(d!["id"]) == S(log3["id"]));
        var empty = await c.CreateProjectAsync("Empty");
        Assert.Equal(HttpStatusCode.Conflict, (await c.Post("/api/v1/documents/proposals/generate", new { kind = "release-notes", projectId = empty })).Status);
    }

    [Fact]
    public async Task A_team_has_its_own_space_and_its_pages_stay_in_it()
    {
        var (c, pageType, _) = await Setup("Tara Team");
        var team = Guid.Parse(S((await c.Post("/api/v1/teams", new { name = "Collections desk" })).Data!["team"]!["id"]));
        var teamPage = await c.Post("/api/v1/documents", new { title = "Desk handbook", typeId = pageType, teamId = team });
        Assert.Equal(HttpStatusCode.Created, teamPage.Status);
        var teamPageId = Guid.Parse(S(teamPage.Data!["item"]!["id"]));
        var inside = await c.Post("/api/v1/documents", new { title = "Call scripts", typeId = pageType, parentId = teamPageId });
        Assert.Equal(HttpStatusCode.Created, inside.Status);
        var company = await c.Post("/api/v1/documents", new { title = "Company holidays", typeId = pageType });
        var companyId = Guid.Parse(S(company.Data!["item"]!["id"]));

        var catalog = (await c.Get("/api/v1/doctracker/catalog")).Data!;
        var space = catalog["teams"]!.AsArray().Single(t => S(t!["id"]) == team.ToString())!;
        Assert.Equal("Collections desk", S(space["name"]));
        Assert.Equal(2, space["pages"]!.GetValue<int>());
        var general = catalog["projects"]!.AsArray().Single(p => p!["id"] is null)!["documents"]!.AsArray();
        Assert.Equal(team.ToString(), S(general.Single(d => S(d!["id"]) == teamPageId.ToString())!["teamId"]));
        Assert.Null(general.Single(d => S(d!["id"]) == companyId.ToString())!["teamId"]);

        // A team page does not move into the company's pages (it would leave its space).
        var move = await c.Send(HttpMethod.Put, $"/api/v1/documents/{teamPageId}/place", new { parentId = companyId, pageOrder = 0 });
        Assert.Equal(422, (int)move.Status);
    }

    // ------------------------------------------------------------------ live co-editing (the server only relays and remembers)

    private async Task<(HubConnection Hub, List<(string Name, JsonElement Payload)> Events)> Live(TestClient who)
    {
        var events = new List<(string, JsonElement)>();
        var hub = new HubConnectionBuilder()
            .WithUrl(new Uri(factory.Server.BaseAddress, "/hubs/chat"), o =>
            {
                o.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler();
                o.Transports = HttpTransportType.LongPolling;
                o.AccessTokenProvider = () => Task.FromResult<string?>(who.Token);
            }).Build();
        foreach (var name in new[] { "docPeers", "docUpdate", "docSaved", "docAwareness", "docCompact" })
            hub.On<JsonElement>(name, payload => { lock (events) events.Add((name, payload.Clone())); });
        await hub.StartAsync();
        return (hub, events);
    }

    private static async Task<JsonElement> Arrives(List<(string Name, JsonElement Payload)> events, string name, Func<JsonElement, bool>? match = null)
    {
        for (var i = 0; i < 100; i++)
        {
            lock (events) { var hit = events.FirstOrDefault(e => e.Name == name && (match is null || match(e.Payload))); if (hit.Name is not null) return hit.Payload; }
            await Task.Delay(50);
        }
        throw new Xunit.Sdk.XunitException($"No {name} event arrived.");
    }

    [Fact]
    public async Task Editors_of_a_page_edit_it_together_and_others_cannot_join()
    {
        var (c, pageType, project) = await Setup("Lata Live");
        var page = await NewPage(c, pageType, "Live page", project, Para("Shared text"));
        var (a, aEvents) = await Live(c);
        var (b, bEvents) = await Live(c);
        try
        {
            var first = await a.InvokeAsync<JsonElement>("DocJoin", page);
            Assert.True(first.GetProperty("canEdit").GetBoolean());
            Assert.True(first.GetProperty("init").GetBoolean());                 // the first editor starts the shared text from the saved one
            Assert.Equal(0, first.GetProperty("updates").GetArrayLength());
            Assert.Equal(a.ConnectionId, first.GetProperty("room").GetProperty("leader").GetString());

            await a.InvokeAsync("DocUpdate", page, "AAEC");
            var second = await b.InvokeAsync<JsonElement>("DocJoin", page);
            Assert.False(second.GetProperty("init").GetBoolean());
            Assert.Equal("AAEC", second.GetProperty("updates")[0].GetString());   // the newcomer catches up from the history
            Assert.Equal(2, (await Arrives(aEvents, "docPeers")).GetProperty("room").GetProperty("peers").GetArrayLength());

            await b.InvokeAsync("DocUpdate", page, "BBEC");
            Assert.Equal("BBEC", (await Arrives(aEvents, "docUpdate")).GetProperty("update").GetString());
            await a.InvokeAsync("DocAwareness", page, "CURSOR");
            Assert.Equal("CURSOR", (await Arrives(bEvents, "docAwareness")).GetProperty("update").GetString());
            await a.InvokeAsync("DocSaved", page, 9);
            Assert.Equal(9, (await Arrives(bEvents, "docSaved")).GetProperty("revision").GetInt32());

            // The leader leaves: the next editor saves from now on.
            await a.InvokeAsync("DocLeave", page);
            var left = await Arrives(bEvents, "docPeers", e => e.TryGetProperty("left", out _));
            Assert.Equal(b.ConnectionId, left.GetProperty("room").GetProperty("leader").GetString());

            // Someone who may not edit the page is not let in (and hears nothing of it).
            var reader = await c.AddMemberAsync(factory, TenantRole.Member, "Rita Reader");
            var (r, rEvents) = await Live(reader);
            try
            {
                var denied = await r.InvokeAsync<JsonElement?>("DocJoin", page);
                Assert.True(denied is null || denied.Value.ValueKind == JsonValueKind.Null || !denied.Value.GetProperty("canEdit").GetBoolean());
                await r.InvokeAsync("DocUpdate", page, "EVIL");
                await Task.Delay(400);
                lock (rEvents) Assert.Empty(rEvents);
                lock (bEvents) Assert.DoesNotContain(bEvents, e => e.Name == "docUpdate" && e.Payload.GetProperty("update").GetString() == "EVIL");
            }
            finally { await r.DisposeAsync(); }
        }
        finally { await a.DisposeAsync(); await b.DisposeAsync(); }
    }
}
