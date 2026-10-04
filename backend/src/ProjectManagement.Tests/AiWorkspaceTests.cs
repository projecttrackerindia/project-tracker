using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using ClosedXML.Excel;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The AI workspace end to end, with a scripted model: the live stream, which model level answers, plan ceilings and monthly credits, what the
/// assistant can read (only what the asker can), changes it proposes and the person confirms, attached files, privacy and failures.
/// </summary>
[Collection("api")]
public class AiWorkspaceTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static string Iso(int days) => DateOnly.FromDateTime(DateTime.UtcNow).AddDays(days).ToString("yyyy-MM-dd");
    private FakeAiChat Chat => factory.Chat;

    private sealed record Org(TestClient Owner, TestClient Manager, TestClient Guest, Guid Project);

    private async Task<Org> Setup(string plan = "BUSINESS")
    {
        Chat.Reset();
        Chat.Configured = true;
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        if (plan == "FREE") return new Org(owner, owner, owner, await owner.CreateProjectAsync("Atlas"));   // the Free plan has room for one person only
        await owner.UpgradeAsync(plan);
        var manager = await owner.AddMemberAsync(factory, TenantRole.Manager, "Max Manager");
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gus Guest");
        return new Org(owner, manager, guest, await owner.CreateProjectAsync("Atlas"));
    }

    private void Override(TestClient who, string key, long value) => factory.WithDb(db =>
    {
        var row = db.TenantFeatureOverrides.FirstOrDefault(o => o.TenantId == who.WorkspaceId && o.FeatureKey == key);
        if (row is null) db.TenantFeatureOverrides.Add(row = new TenantFeatureOverride { TenantId = who.WorkspaceId, FeatureKey = key });
        row.Value = value; row.Reason = "test";
        db.SaveChanges();
        return 0;
    });

    // ---- reading the server-sent stream

    private sealed record Stream(HttpStatusCode Status, List<(string Name, JsonNode Data)> Events, ApiResult? Error)
    {
        public JsonNode Last(string name) => Events.Last(e => e.Name == name).Data;
        public bool Has(string name) => Events.Any(e => e.Name == name);
        public IEnumerable<JsonNode> All(string name) => Events.Where(e => e.Name == name).Select(e => e.Data);
        public string Text => string.Concat(All("text").Select(e => S(e["delta"])));
        public Guid Conversation => Guid.Parse(S(Last("started")["conversationId"]));
        public JsonNode Done => Last("done")["message"]!;
    }

    private static async Task<Stream> Ask(TestClient c, string text, string? mode = null, Guid? conversation = null, IEnumerable<string>? files = null, string? timeZone = null)
    {
        var url = conversation is { } id ? $"/api/v1/ai/conversations/{id}/ask" : "/api/v1/ai/ask";
        using var req = new HttpRequestMessage(HttpMethod.Post, url) { Content = JsonContent.Create(new { text, mode, attachmentIds = files?.ToArray(), timeZone }) };
        req.Headers.Add("X-Token-Delivery", "body");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", c.Token);
        using var res = await c.Http.SendAsync(req);
        var body = await res.Content.ReadAsStringAsync();
        if (res.StatusCode != HttpStatusCode.OK) return new Stream(res.StatusCode, [], new ApiResult(res.StatusCode, JsonNode.Parse(body)));
        Assert.StartsWith("text/event-stream", res.Content.Headers.ContentType!.ToString());
        Assert.Equal("no", res.Headers.GetValues("X-Accel-Buffering").Single());
        var events = body.Split("\n\n", StringSplitOptions.RemoveEmptyEntries).Select(block =>
        {
            var lines = block.Split('\n');
            return (lines[0]["event: ".Length..], JsonNode.Parse(lines[1]["data: ".Length..])!);
        }).ToList();
        return new Stream(res.StatusCode, events, null);
    }

    private async Task<long> CreditsUsed(TestClient c) => (await c.Get("/api/v1/ai/usage")).Data!["creditsUsed"]!.GetValue<long>();

    // ------------------------------------------------------------------ switches and plans

    [Fact]
    public async Task The_workspace_is_off_without_a_model_connection_and_on_a_plan_without_the_assistant()
    {
        var o = await Setup("FREE");
        Chat.Configured = false;
        Assert.Equal("AI_NOT_CONFIGURED", (await Ask(o.Owner, "hello there")).Error!.ErrorCode);

        Chat.Configured = true;
        var free = await Ask(o.Owner, "hello there");
        Assert.Equal(HttpStatusCode.Forbidden, free.Status);
        Assert.Equal("FEATURE_NOT_AVAILABLE", free.Error!.ErrorCode);
        Assert.Empty(Chat.Requests);   // nothing was sent anywhere

        var up = await Setup();
        var usage = (await up.Owner.Get("/api/v1/ai/usage")).Data!;
        Assert.Equal("deep", S(usage["maxTier"]));
        Assert.True(usage["attachments"]!.GetValue<bool>());
        Assert.Equal(3, usage["tiers"]!.AsArray().Count);
        Assert.All(usage["tiers"]!.AsArray(), t => Assert.True(t!["allowed"]!.GetValue<bool>()));
    }

    [Fact]
    public async Task A_workspace_can_switch_the_assistant_off_for_everyone()
    {
        var o = await Setup();
        Assert.True((await o.Owner.Put("/api/v1/ai/status", new { allowed = false })).Ok);
        var res = await Ask(o.Owner, "hello there");
        Assert.Equal("AI_DISABLED", res.Error!.ErrorCode);
        Assert.Empty(Chat.Requests);
    }

    // ------------------------------------------------------------------ the right amount of model

    [Fact]
    public async Task A_simple_question_is_answered_fast_by_the_quick_level_and_streamed()
    {
        var o = await Setup();
        Chat.Script.Enqueue(_ => FakeAiChat.Say("You have no overdue work."));
        var res = await Ask(o.Owner, "Which tasks are overdue?");

        // started -> route -> text ... -> done, in that order
        Assert.Equal(["started", "route", "text", "done"], res.Events.Select(e => e.Name).Distinct().ToArray());
        var route = res.Last("route");
        Assert.Equal("quick", S(route["tier"]));
        Assert.Equal("claude-haiku-4-5", S(route["model"]));
        Assert.Equal(1, route["credits"]!.GetValue<int>());
        Assert.Equal("You have no overdue work.", res.Text);

        var request = Assert.Single(Chat.Requests);
        Assert.Equal("claude-haiku-4-5", request.Model);
        Assert.Null(request.Effort);
        Assert.False(request.ShowReasoning);
        Assert.Empty(Chat.Classified);   // clear-cut: the small classifier was not even asked

        Assert.Equal("assistant", S(res.Done["role"]));
        Assert.Equal(1, res.Done["credits"]!.GetValue<int>());
        Assert.Equal(1, await CreditsUsed(o.Owner));
    }

    [Fact]
    public async Task A_hard_question_gets_deep_thinking_with_its_reasoning_shown()
    {
        var o = await Setup();
        Chat.Script.Enqueue(_ => FakeAiChat.Say("The delay comes from two blocked tasks.", thinking: "Compare the dates first."));
        var res = await Ask(o.Owner, "Analyze why the Atlas project is late and recommend how to fix it");

        Assert.Equal("deep", S(res.Last("route")["tier"]));
        Assert.False(res.Last("route")["limited"]!.GetValue<bool>());
        Assert.Equal("Compare the dates first.", string.Concat(res.All("reasoning").Select(e => S(e["delta"]))));
        var request = Chat.Requests.Single();
        Assert.Equal("claude-opus-5-5", request.Model);
        Assert.Equal("high", request.Effort);
        Assert.True(request.ShowReasoning);
        Assert.Equal("Compare the dates first.", S(res.Done["reasoning"]));
        Assert.Equal(15, res.Done["credits"]!.GetValue<int>());
    }

    [Fact]
    public async Task A_person_can_choose_the_level_but_the_plan_is_the_ceiling()
    {
        var o = await Setup();
        Chat.Script.Enqueue(_ => FakeAiChat.Say("ok"));
        Assert.Equal("quick", S((await Ask(o.Owner, "Analyze why the Atlas project is late and recommend a fix", "quick")).Last("route")["tier"]));

        Override(o.Owner, "AI_MODEL_TIER", 2);
        Chat.Script.Enqueue(_ => FakeAiChat.Say("ok"));
        var capped = await Ask(o.Owner, "hello", "deep");
        var route = capped.Last("route");
        Assert.Equal("standard", S(route["tier"]));
        Assert.Equal("deep", S(route["wanted"]));
        Assert.True(route["limited"]!.GetValue<bool>());   // the page tells the person this needed a higher plan
        Assert.Equal("claude-sonnet-5-5", Chat.Requests.Last().Model);
    }

    [Fact]
    public async Task An_undecided_question_is_sized_up_by_the_small_classifier()
    {
        var o = await Setup();
        Chat.Classifier = _ => "deep";
        Chat.Script.Enqueue(_ => FakeAiChat.Say("ok"));
        var res = await Ask(o.Owner, "Summarise our portfolio");
        Assert.Equal("deep", S(res.Last("route")["tier"]));
        Assert.Equal("Summarise our portfolio", Assert.Single(Chat.Classified));
    }

    // ------------------------------------------------------------------ credits

    [Fact]
    public async Task Each_answer_costs_credits_by_level_and_the_month_runs_out()
    {
        var o = await Setup();
        Override(o.Owner, "AI_MONTHLY_CREDITS", 6);

        // A deep question costs 15, which is more than is left, so it is answered one level down (Standard, 4) and says so.
        Chat.Script.Enqueue(_ => FakeAiChat.Say("ok"));
        var first = await Ask(o.Owner, "Analyze why the Atlas project is late and recommend how to fix it");
        Assert.Equal("standard", S(first.Last("route")["tier"]));
        Assert.True(first.Last("route")["limited"]!.GetValue<bool>());
        Assert.Equal(2, first.Last("done")["creditsLeft"]!.GetValue<long>());

        // 2 left: only Quick (1) is affordable.
        Chat.Script.Enqueue(_ => FakeAiChat.Say("ok"));
        Assert.Equal("quick", S((await Ask(o.Owner, "Analyze why the Atlas project is late and recommend how to fix it")).Last("route")["tier"]));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("ok"));
        await Ask(o.Owner, "hi");

        var spent = await Ask(o.Owner, "hi");
        Assert.Equal(HttpStatusCode.Conflict, spent.Status);
        Assert.Equal("AI_CREDITS_EXHAUSTED", spent.Error!.ErrorCode);
        Assert.Equal(6, await CreditsUsed(o.Owner));
        var usage = (await o.Owner.Get("/api/v1/ai/usage")).Data!;
        Assert.Equal(0, usage["creditsLeft"]!.GetValue<long>());
    }

    [Fact]
    public async Task Unlimited_credits_never_run_out()
    {
        var o = await Setup();
        Override(o.Owner, "AI_MONTHLY_CREDITS", -1);
        Chat.Script.Enqueue(_ => FakeAiChat.Say("ok"));
        var res = await Ask(o.Owner, "Analyze why the Atlas project is late and recommend how to fix it");
        Assert.True(res.Last("done")["unlimited"]!.GetValue<bool>());
        Assert.True((await o.Owner.Get("/api/v1/ai/usage")).Data!["unlimited"]!.GetValue<bool>());
    }

    [Fact]
    public async Task A_failed_answer_costs_nothing_and_says_why()
    {
        var o = await Setup();
        Chat.Fail = new AiProviderException(503, "AI_NO_CREDIT", "Claude", "has run out of credit");
        var res = await Ask(o.Owner, "Which tasks are overdue?");
        var error = res.Last("error");
        Assert.Equal("AI_NO_CREDIT", S(error["code"]));
        Assert.Contains("Claude has run out of credit", S(error["message"]));
        Assert.False(res.Has("done"));
        Assert.Equal(0, await CreditsUsed(o.Owner));

        // The question and the failed answer are in the history, so the page can show what happened.
        var history = (await o.Owner.Get($"/api/v1/ai/conversations/{res.Conversation}")).Data!["messages"]!.AsArray();
        Assert.Equal(["user", "assistant"], history.Select(m => S(m!["role"])).ToArray());
        Assert.Equal("failed", S(history[1]!["status"]));
    }

    // ------------------------------------------------------------------ what it can read

    [Fact]
    public async Task The_assistant_reads_through_tools_and_only_what_the_asker_may_see()
    {
        var o = await Setup();
        await o.Owner.CreateTaskAsync(o.Project, "Renew the SSL certificate", new { title = "Renew the SSL certificate", priority = "High", assigneeId = o.Owner.UserId, dueDate = Iso(-3) });

        string ToolResult(int request) => Assert.IsType<AiToolResult>(Chat.Requests.ToArray()[request].Turns[^1].Blocks.Single()).Content;

        // The owner sees the task.
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool("find_work", new { overdue = true }, "Let me look."));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("You have 1 overdue item."));
        var res = await Ask(o.Owner, "Which of my work is overdue?");
        Assert.Contains("Renew the SSL certificate", ToolResult(1));
        Assert.Equal("Let me look.\n\nYou have 1 overdue item.", S(res.Done["content"]));
        var tool = res.All("tool").ToList();
        Assert.Equal(["running", "done"], tool.Select(t => S(t["state"])).ToArray());
        Assert.Equal("Looked through 1 work item", S(tool[1]["label"]));
        Assert.Equal("Looked through 1 work item", S(res.Done["tools"]![0]!["label"]));

        // A guest who is not on the project gets none of it, through exactly the same tool.
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool("find_work", new { overdue = true }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Nothing."));
        await Ask(o.Guest, "Which of my work is overdue?");
        var guestResult = ToolResult(3);
        Assert.DoesNotContain("SSL", guestResult);
        Assert.Contains("No work items match", guestResult);
    }

    [Fact]
    public async Task A_tool_that_fails_tells_the_model_instead_of_breaking_the_answer()
    {
        var o = await Setup();
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool("project_report", new { project = "No Such Project" }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("I could not find that project."));
        var res = await Ask(o.Owner, "How is the Phantom project doing?");
        Assert.Contains("No project matches", Assert.IsType<AiToolResult>(Chat.Requests.Last().Turns[^1].Blocks.Single()).Content);
        Assert.Equal("I could not find that project.", S(res.Done["content"]).Split("\n\n").Last());
        Assert.Equal("failed", S(res.All("tool").Last()["state"]));
    }

    [Fact]
    public async Task The_model_is_told_who_is_asking_and_what_the_organization_says_about_itself()
    {
        var o = await Setup();
        Assert.Equal(HttpStatusCode.Forbidden, (await o.Manager.Put("/api/v1/ai/instructions", new { text = "We are a bank." })).Status);
        var set = await o.Owner.Put("/api/v1/ai/instructions", new { text = "We are a regional bank. Releases freeze on the last Friday of each month." });
        Assert.True(set.Ok, set.ToString());
        Assert.True((await o.Manager.Get("/api/v1/ai/instructions")).Data!["text"]!.GetValue<string>().Contains("regional bank"));
        Assert.False((await o.Manager.Get("/api/v1/ai/instructions")).Data!["canEdit"]!.GetValue<bool>());

        Chat.Script.Enqueue(_ => FakeAiChat.Say("ok"));
        await Ask(o.Manager, "hi", timeZone: "Asia/Kolkata");
        var request = Chat.Requests.Single();
        Assert.Contains("Max Manager", request.Context);
        Assert.Contains("Manager", request.Context);
        Assert.Contains("<organization_instructions>", request.Context);
        Assert.Contains("Releases freeze on the last Friday", request.Context);
        Assert.Contains("Asia/Kolkata", request.Context);
        // The fixed instructions never carry anything person-specific (so the provider can cache them).
        Assert.DoesNotContain("Max Manager", request.System);
        Assert.Contains("You never change anything yourself", request.System);
    }

    // ------------------------------------------------------------------ changes it proposes

    [Fact]
    public async Task A_suggested_change_waits_for_confirmation_and_then_happens_as_the_person()
    {
        var o = await Setup();
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool("propose_create_action_item", new { project = "Atlas", title = "Get the client's sign-off", assignee = "me", due_date = Iso(7) }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("I have prepared that for you to confirm."));
        var res = await Ask(o.Owner, "Add an action item to Atlas to get the client's sign-off");

        var card = res.Last("action")["action"]!;
        Assert.Equal("proposed", S(card["status"]));
        Assert.Contains("Get the client's sign-off", S(card["title"]));
        // The model was told it has not been done.
        Assert.Contains("has NOT been done", Assert.IsType<AiToolResult>(Chat.Requests.Last().Turns[^1].Blocks.Single()).Content);
        Assert.Empty(factory.WithDb(db => db.WorkTasks.IgnoreQueryFilters().Where(a => a.Kind == WorkTaskKind.ActionItem && a.RelatedProjectId == o.Project && a.Title == "Get the client's sign-off").ToList()));   // nothing yet

        var messageId = S(res.Done["id"]);
        var confirm = await o.Owner.Post($"/api/v1/ai/messages/{messageId}/actions/{S(card["id"])}/confirm");
        Assert.True(confirm.Ok, confirm.ToString());
        Assert.Equal("done", S(confirm.Data!["status"]));
        Assert.Equal($"/projects/{o.Project}", S(confirm.Data["link"]));
        var created = Assert.Single(factory.WithDb(db => db.WorkTasks.IgnoreQueryFilters().Where(a => a.Kind == WorkTaskKind.ActionItem && a.RelatedProjectId == o.Project && a.Title == "Get the client's sign-off").ToList()));
        Assert.Equal(o.Owner.UserId, created.AssigneeId);

        // Once handled it cannot be run again, and the history remembers the outcome.
        Assert.Equal("AI_ACTION_HANDLED", (await o.Owner.Post($"/api/v1/ai/messages/{messageId}/actions/{S(card["id"])}/confirm")).ErrorCode);
        var history = (await o.Owner.Get($"/api/v1/ai/conversations/{res.Conversation}")).Data!["messages"]!.AsArray();
        Assert.Equal("done", S(history[1]!["actions"]![0]!["status"]));
        // Somebody else cannot confirm it.
        Assert.Equal(HttpStatusCode.NotFound, (await o.Manager.Post($"/api/v1/ai/messages/{messageId}/actions/{S(card["id"])}/confirm")).Status);
    }

    [Fact]
    public async Task A_suggestion_can_be_dismissed_and_then_never_runs()
    {
        var o = await Setup();
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool("propose_reminder", new { text = "Call the vendor", at = DateTime.UtcNow.AddDays(2).ToString("yyyy-MM-dd'T'HH:mm") }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Prepared."));
        var res = await Ask(o.Owner, "Remind me to call the vendor in two days", timeZone: "UTC");
        var card = res.Last("action")["action"]!;
        var messageId = S(res.Done["id"]);
        Assert.Equal("dismissed", S((await o.Owner.Post($"/api/v1/ai/messages/{messageId}/actions/{S(card["id"])}/dismiss")).Data!["status"]));
        Assert.Equal("AI_ACTION_HANDLED", (await o.Owner.Post($"/api/v1/ai/messages/{messageId}/actions/{S(card["id"])}/confirm")).ErrorCode);
        Assert.Empty(factory.WithDb(db => db.Reminders.IgnoreQueryFilters().Where(r => r.Title == "Call the vendor" && r.UserId == o.Owner.UserId).ToList()));
    }

    [Fact]
    public async Task A_confirmed_reminder_is_created_for_the_person()
    {
        var o = await Setup();
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool("propose_reminder", new { text = "Call the vendor", at = DateTime.UtcNow.AddDays(2).ToString("yyyy-MM-dd'T'HH:mm") }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Prepared."));
        var res = await Ask(o.Owner, "Remind me to call the vendor in two days", timeZone: "UTC");
        var card = res.Last("action")["action"]!;
        var confirm = await o.Owner.Post($"/api/v1/ai/messages/{S(res.Done["id"])}/actions/{S(card["id"])}/confirm");
        Assert.Equal("done", S(confirm.Data!["status"]));
        Assert.Single(factory.WithDb(db => db.Reminders.IgnoreQueryFilters().Where(r => r.Title == "Call the vendor" && r.UserId == o.Owner.UserId).ToList()));
    }

    [Fact]
    public async Task Without_the_actions_feature_the_assistant_only_advises()
    {
        var o = await Setup();
        Override(o.Owner, "AI_ACTIONS", 0);
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool("propose_create_action_item", new { project = "Atlas", title = "Something to do" }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("I cannot create that here."));
        var res = await Ask(o.Owner, "Add an action item to Atlas: something to do");

        Assert.DoesNotContain(Chat.Requests.First().Tools, t => t.Name.StartsWith("propose_"));   // it was never even offered
        Assert.Contains("does not let the assistant propose changes", Assert.IsType<AiToolResult>(Chat.Requests.Last().Turns[^1].Blocks.Single()).Content);
        Assert.False(res.Has("action"));
    }

    [Fact]
    public async Task A_report_can_be_emailed_to_the_person_after_they_confirm()
    {
        var o = await Setup();
        const string body = "## Summary\nAtlas is on track.\n\n- **Overdue:** none\n- Next: sign-off <script>alert(1)</script>";
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool("propose_send_report", new { title = "Weekly status", body, recipients = new[] { "me" } }));
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Prepared the report."));
        var res = await Ask(o.Owner, "Email me a weekly status report");
        var card = res.Last("action")["action"]!;
        Assert.Contains("Weekly status", S(card["title"]));
        Assert.Contains("Atlas is on track.", S(card["preview"]));   // the person can read exactly what would be sent before confirming
        Assert.DoesNotContain((await o.Owner.Send(HttpMethod.Get, "/api/v1/dev/emails", null, true)).Data!.AsArray(), m => S(m!["subject"]).Contains("Weekly status"));   // not before confirming

        var confirm = await o.Owner.Post($"/api/v1/ai/messages/{S(res.Done["id"])}/actions/{S(card["id"])}/confirm");
        Assert.Equal("done", S(confirm.Data!["status"]));
        var mail = (await o.Owner.Send(HttpMethod.Get, "/api/v1/dev/emails", null, true)).Data!.AsArray().First(m => S(m!["subject"]).Contains("Weekly status") && S(m["to"]) == o.Owner.Email)!;
        var html = S(mail["html"]);
        Assert.Contains("<b>Overdue:</b>", html);
        Assert.DoesNotContain("<script>", html);            // what the model wrote is encoded, never trusted as markup
        Assert.Contains("&lt;script&gt;", html);
    }

    // ------------------------------------------------------------------ files

    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52];

    [Fact]
    public async Task An_attached_picture_is_read_by_the_model_and_stays_private_to_its_owner()
    {
        var o = await Setup();
        var up = await o.Owner.Upload("/api/v1/ai/files", "burndown.png", Png);
        Assert.Equal(HttpStatusCode.Created, up.Status);
        var id = S(up.Data!["id"]);
        Assert.True(up.Data["isImage"]!.GetValue<bool>());

        Chat.Script.Enqueue(_ => FakeAiChat.Say("The burndown is flat."));
        var res = await Ask(o.Owner, "What does this chart tell us?", files: [id]);
        var sent = Chat.Requests.Single().Turns[^1].Blocks;
        var image = Assert.IsType<AiImage>(sent[0]);   // the file first, then the words
        Assert.Equal("image/png", image.MediaType);
        Assert.Equal(Png, image.Data);
        Assert.Equal("What does this chart tell us?", Assert.IsType<AiText>(sent[1]).Text);
        Assert.Equal("standard", S(res.Last("route")["tier"]));   // reading a picture is more than a quick lookup
        var question = (await o.Owner.Get($"/api/v1/ai/conversations/{res.Conversation}")).Data!["messages"]![0]!;
        Assert.Equal("burndown.png", S(question["attachments"]![0]!["name"]));   // the file is shown with the question that carried it

        // The owner can show it again; nobody else can open it.
        Assert.Equal(HttpStatusCode.OK, (await o.Owner.Raw($"/api/v1/ai/files/{id}?inline=true")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await o.Manager.Raw($"/api/v1/ai/files/{id}")).StatusCode);
        // A file that has been sent cannot be attached to another question.
        Assert.Equal("VALIDATION_FAILED", (await Ask(o.Owner, "again", files: [id])).Error!.ErrorCode);

        // A follow-up still has the picture in front of it.
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Still flat."));
        await Ask(o.Owner, "And the trend?", conversation: res.Conversation);
        var followUp = Chat.Requests.Last().Turns;
        Assert.Equal(["user", "assistant", "user"], followUp.Select(t => t.Role).ToArray());
        Assert.Contains(followUp[0].Blocks, b => b is AiImage);
    }

    [Fact]
    public async Task Files_are_checked_for_type_content_and_size()
    {
        var o = await Setup();
        Assert.Equal("VALIDATION_FAILED", (await o.Owner.Upload("/api/v1/ai/files", "run.exe", [1, 2, 3, 4])).ErrorCode);
        Assert.Equal("VALIDATION_FAILED", (await o.Owner.Upload("/api/v1/ai/files", "fake.png", "just text, not a picture"u8.ToArray())).ErrorCode);
        Assert.Equal("VALIDATION_FAILED", (await o.Owner.Upload("/api/v1/ai/files", "huge.png", [.. Png, .. new byte[6 * 1024 * 1024]])).ErrorCode);   // over the 5 MB picture limit
        Assert.Equal("VALIDATION_FAILED", (await o.Owner.Upload("/api/v1/ai/files", "empty.txt", [])).ErrorCode);

        Override(o.Owner, "AI_ATTACHMENTS", 0);
        var blocked = await o.Owner.Upload("/api/v1/ai/files", "ok.png", Png);
        Assert.Equal("FEATURE_NOT_AVAILABLE", blocked.ErrorCode);
    }

    [Fact]
    public async Task Spreadsheets_and_documents_are_turned_into_text_for_the_model()
    {
        var o = await Setup();
        using var ms = new MemoryStream();
        using (var wb = new XLWorkbook())
        {
            var ws = wb.AddWorksheet("Budget");
            ws.Cell(1, 1).Value = "Item"; ws.Cell(1, 2).Value = "Cost";
            ws.Cell(2, 1).Value = "Licences"; ws.Cell(2, 2).Value = 4200;
            wb.SaveAs(ms);
        }
        var xlsx = await o.Owner.Upload("/api/v1/ai/files", "budget.xlsx", ms.ToArray());
        Assert.Equal(HttpStatusCode.Created, xlsx.Status);
        var csv = await o.Owner.Upload("/api/v1/ai/files", "notes.csv", "name,owner\nMigration,Priya\n"u8.ToArray());
        Assert.Equal(HttpStatusCode.Created, csv.Status);

        Chat.Script.Enqueue(_ => FakeAiChat.Say("Looks fine."));
        await Ask(o.Owner, "Is the budget on track?", files: [S(xlsx.Data!["id"]), S(csv.Data!["id"])]);
        var blocks = Chat.Requests.Single().Turns[^1].Blocks.OfType<AiText>().Select(t => t.Text).ToList();
        Assert.Contains(blocks, b => b.Contains("<document name=\"budget.xlsx\">") && b.Contains("Licences | 4200"));
        Assert.Contains(blocks, b => b.Contains("Migration,Priya"));
    }

    // ------------------------------------------------------------------ conversations

    [Fact]
    public async Task Conversations_are_private_and_deleting_one_erases_what_was_said_but_not_the_credits()
    {
        var o = await Setup();
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Secret plan: acquire the competitor."));
        var res = await Ask(o.Owner, "What should our confidential strategy be next quarter?");
        var id = res.Conversation;
        var credits = await CreditsUsed(o.Owner);
        Assert.True(credits > 0);

        Assert.Single((await o.Owner.Get("/api/v1/ai/conversations")).Data!.AsArray());
        Assert.Empty((await o.Manager.Get("/api/v1/ai/conversations")).Data!.AsArray());                // not even an administrator-level colleague sees it
        Assert.Equal(HttpStatusCode.NotFound, (await o.Manager.Get($"/api/v1/ai/conversations/{id}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await o.Manager.Delete($"/api/v1/ai/conversations/{id}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await o.Manager.Send(HttpMethod.Patch, $"/api/v1/ai/conversations/{id}", new { title = "mine now" })).Status);

        var rename = await o.Owner.Send(HttpMethod.Patch, $"/api/v1/ai/conversations/{id}", new { title = "Strategy", pinned = true });
        Assert.Equal("Strategy", S(rename.Data!["title"]));
        Assert.True(rename.Data["isPinned"]!.GetValue<bool>());

        Assert.Equal(HttpStatusCode.NoContent, (await o.Owner.Delete($"/api/v1/ai/conversations/{id}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await o.Owner.Get($"/api/v1/ai/conversations/{id}")).Status);
        Assert.Empty((await o.Owner.Get("/api/v1/ai/conversations")).Data!.AsArray());
        // The words are gone from the database; the credits they used still count for the month.
        Assert.DoesNotContain(factory.WithDb(db => db.AiMessages.IgnoreQueryFilters().Where(m => m.ConversationId == id).Select(m => m.Content).ToList()), c => c.Length > 0);
        Assert.Equal(credits, await CreditsUsed(o.Owner));
    }

    [Fact]
    public async Task A_follow_up_carries_the_conversation_so_far()
    {
        var o = await Setup();
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Atlas has 3 open tasks."));
        var first = await Ask(o.Owner, "How is Atlas doing?");
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Two of them are due Friday."));
        await Ask(o.Owner, "Which are due soon?", conversation: first.Conversation);

        var turns = Chat.Requests.Last().Turns;
        Assert.Equal(["user", "assistant", "user"], turns.Select(t => t.Role).ToArray());
        Assert.Equal("Atlas has 3 open tasks.", Assert.IsType<AiText>(turns[1].Blocks.Single()).Text);
        var detail = (await o.Owner.Get($"/api/v1/ai/conversations/{first.Conversation}")).Data!;
        Assert.Equal(4, detail["messages"]!.AsArray().Count);
        Assert.Equal("How is Atlas doing?", S(detail["conversation"]!["title"]));
    }

    // ------------------------------------------------------------------ a model that declines

    [Fact]
    public async Task A_declined_request_is_retried_once_on_the_backup_model_without_the_first_models_reasoning()
    {
        var o = await Setup();
        Chat.Script.Enqueue(_ => FakeAiChat.UseTool("find_work", new { overdue = true }, thinking: "Look at the overdue work first."));
        Chat.Script.Enqueue(_ => FakeAiChat.Refuse());
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Here is the answer."));
        var res = await Ask(o.Owner, "Analyze why the Atlas project is late and recommend how to fix it");

        var requests = Chat.Requests.ToArray();
        Assert.Equal(3, requests.Length);
        Assert.Equal("claude-opus-5-5", requests[1].Model);                         // the tool round trip stays on the first model, thinking and all
        Assert.Contains(requests[1].Turns.SelectMany(t => t.Blocks), b => b is AiThinking);
        Assert.Equal("claude-opus-4-8", requests[2].Model);                         // the retry
        Assert.DoesNotContain(requests[2].Turns.SelectMany(t => t.Blocks), b => b is AiThinking or AiRedactedThinking);   // reasoning is bound to the model that wrote it
        Assert.Equal("claude-opus-4-8", S(res.Done["model"]));
        Assert.Contains("backup model", S(res.Done["routeReason"]));
        Assert.EndsWith("Here is the answer.", S(res.Done["content"]));
        Assert.Equal(15, res.Done["credits"]!.GetValue<int>());                     // one answer, one price
    }

    [Fact]
    public async Task A_request_that_is_declined_twice_or_after_writing_has_started_is_not_retried_again()
    {
        var o = await Setup();
        Chat.Script.Enqueue(_ => FakeAiChat.Refuse());
        Chat.Script.Enqueue(_ => FakeAiChat.Refuse());
        var twice = await Ask(o.Owner, "Which tasks are overdue?");
        Assert.Equal(2, Chat.Requests.Count);
        Assert.Contains("can't help with that request", S(twice.Done["content"]));

        Chat.Requests.Clear();
        Chat.Script.Enqueue(_ => FakeAiChat.Refuse("Here is the start of"));
        var started = await Ask(o.Owner, "Which tasks are overdue?");
        Assert.Single(Chat.Requests);                                               // part of an answer was already shown: no second try
        Assert.StartsWith("Here is the start of", S(started.Done["content"]));
        Assert.Contains("can't help with that request", S(started.Done["content"]));
    }

    // ------------------------------------------------------------------ usage reports

    [Fact]
    public async Task Owners_see_the_months_use_per_person_and_level_but_never_what_was_said()
    {
        var o = await Setup();
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Hello!"));
        await Ask(o.Owner, "hi");
        Chat.Script.Enqueue(_ => FakeAiChat.Say("The delay is the vendor."));
        await Ask(o.Owner, "Analyze why the Atlas project is late and recommend how to fix it");
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Hi again."));
        await Ask(o.Manager, "hello");
        Chat.Fail = new AiProviderException(503, "AI_BUSY", "Claude", "is busy");
        await Ask(o.Manager, "this one fails");
        Chat.Fail = null;

        var report = await o.Owner.Get("/api/v1/ai/usage/report");
        Assert.True(report.Ok, report.ToString());
        var d = report.Data!;
        Assert.Equal(DateTime.UtcNow.ToString("yyyy-MM"), S(d["month"]));
        Assert.Equal(17, d["creditsUsed"]!.GetValue<long>());                       // 1 + 15 + 1; the failed answer was free
        Assert.Equal(2000, d["creditsLimit"]!.GetValue<long>());
        Assert.Equal(4, d["answers"]!.GetValue<int>());
        Assert.Equal(1, d["failed"]!.GetValue<int>());
        var tiers = d["byTier"]!.AsArray().ToDictionary(t => S(t!["tier"]), t => t!["answers"]!.GetValue<int>());
        Assert.Equal((3, 0, 1), (tiers["quick"], tiers["standard"], tiers["deep"]));   // the failed answer still counts under its level, at no credits
        var people = d["people"]!.AsArray();
        Assert.Equal("Olivia Owner", S(people[0]!["name"]));                        // most credits first
        Assert.Equal(16, people[0]!["credits"]!.GetValue<long>());
        Assert.Equal("Max Manager", S(people[1]!["name"]));
        // Counts only: nothing anyone typed or was answered appears.
        var raw = report.Json!.ToJsonString();
        Assert.DoesNotContain("vendor", raw);
        Assert.DoesNotContain("Analyze", raw);

        Assert.Equal(HttpStatusCode.Forbidden, (await o.Manager.Get("/api/v1/ai/usage/report")).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await o.Owner.Get("/api/v1/ai/usage/report?month=banana")).Status);
        var last = DateTime.UtcNow.AddMonths(-1).ToString("yyyy-MM");
        Assert.Equal(0, (await o.Owner.Get($"/api/v1/ai/usage/report?month={last}")).Data!["answers"]!.GetValue<int>());
    }

    [Fact]
    public async Task The_platform_sees_each_organizations_use_with_a_cost_estimate_and_only_administrators_may()
    {
        var o = await Setup();
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Looks fine."));
        await Ask(o.Owner, "Analyze why the Atlas project is late and recommend how to fix it");

        Assert.Equal(HttpStatusCode.Forbidden, (await o.Owner.Get("/api/v1/admin/ai-usage")).Status);

        var admin = await TestClient.RegisterAsync(factory, "Platform Admin");
        factory.WithDb(db => { db.Users.IgnoreQueryFilters().Where(u => u.Id == admin.UserId).ExecuteUpdate(s => s.SetProperty(u => u.IsPlatformAdmin, true)); return 0; });
        await admin.LoginAsync();
        var res = await admin.Get("/api/v1/admin/ai-usage");
        Assert.True(res.Ok, res.ToString());
        var row = res.Data!["rows"]!.AsArray().Single(r => Guid.Parse(S(r!["tenantId"])) == o.Owner.WorkspaceId)!;
        Assert.Equal("BUSINESS", S(row["planCode"]));
        Assert.Equal(15, row["creditsUsed"]!.GetValue<long>());
        Assert.Equal(2000, row["creditsLimit"]!.GetValue<long>());
        Assert.Equal(1, row["deep"]!.GetValue<int>());
        Assert.Equal(200, row["tokensIn"]!.GetValue<long>());
        Assert.Equal(40, row["tokensOut"]!.GetValue<long>());
        Assert.Equal("USD", S(res.Data["currency"]));
        Assert.True(res.Data["estimatedCost"]!.GetValue<decimal>() >= 0);
        Assert.DoesNotContain("Analyze", res.Json!.ToJsonString());                 // counts only
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await admin.Get("/api/v1/admin/ai-usage?month=2026-13")).Status);
    }

    // ------------------------------------------------------------------ spending fewer tokens

    [Fact]
    public async Task Cached_input_is_counted_apart_and_priced_at_a_fraction_in_the_platform_report()
    {
        var o = await Setup();
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Looks fine.", cacheRead: 1_000_000, cacheWrite: 0));
        await Ask(o.Owner, "Analyze why the Atlas project is late and recommend how to fix it");

        var stored = factory.WithDb(db => db.AiMessages.IgnoreQueryFilters().Where(m => m.TenantId == o.Owner.WorkspaceId && m.Role == "assistant").Select(m => new { m.InputTokens, m.CacheReadTokens }).Single());
        Assert.Equal((200, 1_000_000), (stored.InputTokens, stored.CacheReadTokens));

        var admin = await TestClient.RegisterAsync(factory, "Platform Admin");
        factory.WithDb(db => { db.Users.IgnoreQueryFilters().Where(u => u.Id == admin.UserId).ExecuteUpdate(s => s.SetProperty(u => u.IsPlatformAdmin, true)); return 0; });
        await admin.LoginAsync();
        var data = (await admin.Get("/api/v1/admin/ai-usage")).Data!;
        var row = data["rows"]!.AsArray().Single(r => Guid.Parse(S(r!["tenantId"])) == o.Owner.WorkspaceId)!;
        Assert.Equal(100, row["cacheHitPercent"]!.GetValue<int>());
        Assert.Equal(1_000_200, row["tokensIn"]!.GetValue<long>());                 // everything the model read, cached or not
        // Deep: (200 x $4 + 1,000,000 cached x $4 x 0.05 + 40 x $20) / 1M = about $0.20, against about $4 had nothing been cached.
        Assert.InRange(row["estimatedCost"]!.GetValue<decimal>(), 0.19m, 0.21m);
        Assert.InRange(data["estimatedSavedByCache"]!.GetValue<decimal>(), 3.7m, 3.9m);
    }

    [Fact]
    public async Task A_long_conversation_keeps_its_context_in_a_summary_and_sends_only_the_recent_messages()
    {
        var o = await Setup();
        Guid? conv = null;
        for (var i = 1; i <= 5; i++)
        {
            Chat.Script.Enqueue(_ => FakeAiChat.Say($"Answer {i}."));
            var r = await Ask(o.Owner, $"Question number {i} about Atlas", conversation: conv);
            conv = r.Conversation;
        }
        // After the fifth answer there were ten messages (more than eight): the oldest six were folded into a summary by the small model.
        var summarized = Assert.Single(Chat.Summarized);
        Assert.Contains("Question number 1 about Atlas", summarized);
        Assert.Contains("Answer 3.", summarized);
        Assert.DoesNotContain("Question number 5 about Atlas", summarized);          // the recent ones stay word for word
        Assert.Equal(0, factory.WithDb(db => db.AiMessages.IgnoreQueryFilters().Where(m => m.ConversationId == conv).Sum(m => m.Credits)) - 5 * 1);   // summarizing cost nothing: five Quick answers, five credits

        Chat.Requests.Clear();
        Chat.Script.Enqueue(_ => FakeAiChat.Say("Answer 6."));
        await Ask(o.Owner, "Question number 6 about Atlas", conversation: conv);
        var turns = Chat.Requests.Single().Turns;
        Assert.Equal(["user", "assistant", "user", "assistant", "user"], turns.Select(t => t.Role).ToArray());   // 5 turns instead of 11
        var first = turns[0].Blocks.OfType<AiText>().Select(t => t.Text).ToList();
        Assert.Contains(first, t => t.Contains("<earlier_in_this_conversation>") && t.Contains("SUMMARY: they were looking at the Atlas project."));
        Assert.Contains(first, t => t == "Question number 4 about Atlas");             // the kept messages start with a question
        Assert.DoesNotContain(turns.SelectMany(t => t.Blocks).OfType<AiText>(), t => t.Text.Contains("Question number 1 about"));

        // Deleting the conversation erases the summary with everything else.
        await o.Owner.Delete($"/api/v1/ai/conversations/{conv}");
        Assert.Null(factory.WithDb(db => db.AiConversations.IgnoreQueryFilters().Where(c => c.Id == conv).Select(c => c.Summary).Single()));
    }

    [Fact]
    public async Task Follow_up_suggestions_are_taken_off_the_answer_and_an_invented_work_item_key_is_flagged()
    {
        var o = await Setup();
        var key = factory.WithDb(db => db.Projects.IgnoreQueryFilters().Where(p => p.TenantId == o.Owner.WorkspaceId).Select(p => p.Key).First());
        Chat.Script.Enqueue(_ => FakeAiChat.Say($"Atlas is on track. {key}-9999 is the one to watch, and UTF-8 is fine.\n\n<followups>Who is overloaded? | Draft a status report | Show overdue work</followups>"));
        var res = await Ask(o.Owner, "How is Atlas doing?");
        var done = res.Done;
        var msg = factory.WithDb(db => db.AiMessages.IgnoreQueryFilters().Where(m => m.TenantId == o.Owner.WorkspaceId && m.Role == "assistant").OrderByDescending(m => m.CreatedAt).First());
        Assert.DoesNotContain("followups", msg.Content);
        Assert.StartsWith("Atlas is on track.", msg.Content);
        Assert.Contains("Draft a status report", msg.FollowUpsJson);
        Assert.Contains($"{key}-9999", msg.UnverifiedJson);          // never seen in any data
        Assert.DoesNotContain("UTF-8", msg.UnverifiedJson);          // not one of the workspace's project keys
        Assert.NotNull(done);

        // A trailer that was cut off (the answer ran out) is dropped rather than shown.
        var (body, items) = ProjectManagement.Application.Features.Ai.AiAgent.SplitFollowUps("Done.\n<followups>One | Tw");
        Assert.Equal("Done.", body); Assert.Empty(items);
    }

    [Fact]
    public async Task The_assistant_learns_from_feedback_and_the_person_can_see_edit_and_erase_it()
    {
        var o = await Setup();
        Chat.Script.Enqueue(_ => FakeAiChat.Say("A very long answer."));
        var res = await Ask(o.Owner, "How is Atlas doing?");
        var id = S(res.Done["id"]);
        async Task<System.Text.Json.Nodes.JsonNode> Profile(TestClient who) => (await who.Get("/api/v1/ai/profile")).Data!;

        // "Too long" teaches a shorter style, which then reaches the model as one plain line.
        Assert.True((await o.Owner.Post($"/api/v1/ai/messages/{id}/feedback", new { rating = "down", reason = "too_long" })).Ok);
        var profile = await Profile(o.Owner);
        Assert.Equal(-1, (int)profile["detailLevel"]!);
        Assert.Contains("short answers", profile["learned"]!.ToJsonString());
        Chat.Requests.Clear(); Chat.Script.Enqueue(_ => FakeAiChat.Say("Short."));
        await Ask(o.Owner, "And what about Orion?", conversation: res.Conversation);
        Assert.Contains("prefer short answers", Chat.Requests.Single().Context);

        // Changing their mind does not count twice.
        Assert.True((await o.Owner.Post($"/api/v1/ai/messages/{id}/feedback", new { rating = "up" })).Ok);
        Assert.Equal(0, (int)(await Profile(o.Owner))["detailLevel"]!);

        // Their own notes are kept in their words and are private to them.
        Assert.True((await o.Owner.Put("/api/v1/ai/profile", new { notes = "Always include the risks" })).Ok);
        Chat.Requests.Clear(); Chat.Script.Enqueue(_ => FakeAiChat.Say("Ok."));
        await Ask(o.Owner, "Anything else to add?", conversation: res.Conversation);
        Assert.Contains("Always include the risks", Chat.Requests.Single().Context);
        Assert.DoesNotContain("Always include the risks", (await Profile(o.Manager)).ToJsonString());
        Assert.Equal(HttpStatusCode.NotFound, (await o.Manager.Post($"/api/v1/ai/messages/{id}/feedback", new { rating = "up" })).Status);   // somebody else's answer

        // Erasing brings the defaults back.
        Assert.True((await o.Owner.Delete("/api/v1/ai/profile")).Ok);
        Assert.Empty((await Profile(o.Owner))["learned"]!.AsArray());
    }

    [Fact]
    public async Task Three_declined_suggestions_of_one_kind_stop_the_assistant_offering_it_unasked()
    {
        var o = await Setup();
        for (var i = 0; i < 3; i++)
        {
            Chat.Script.Enqueue(_ => FakeAiChat.UseTool("propose_create_task", new { project = "Atlas", title = $"Idea {Guid.NewGuid():N}" }));
            Chat.Script.Enqueue(_ => FakeAiChat.Say("Prepared."));
            var r = await Ask(o.Owner, "Add a task to Atlas for an idea");
            var card = r.Done["actions"]![0]!;
            Assert.True((await o.Owner.Post($"/api/v1/ai/messages/{S(r.Done["id"])}/actions/{S(card["id"])}/dismiss")).Ok);
        }
        Chat.Requests.Clear(); Chat.Script.Enqueue(_ => FakeAiChat.Say("Fine."));
        await Ask(o.Owner, "How is Atlas doing today?");
        Assert.Contains("turned down 3", Chat.Requests.Single().Context);
    }

    [Fact]
    public async Task Starters_come_from_the_persons_live_work_without_calling_the_model()
    {
        var o = await Setup();
        var before = Chat.Requests.Count; var classified = Chat.Classified.Count;
        var s = (await o.Owner.Get("/api/v1/ai/starters")).Data!;
        Assert.StartsWith("Good", S(s["greeting"]));
        var prompts = s["starters"]!.AsArray().Select(x => S(x!["prompt"])).ToList();
        Assert.Contains(prompts, p => p.Contains("briefing"));
        Assert.Contains(prompts, p => p.Contains("too much on their plate"));          // a manager-level view for the owner
        var guest = (await o.Guest.Get("/api/v1/ai/starters")).Data!["starters"]!.AsArray().Select(x => S(x!["prompt"])).ToList();
        Assert.DoesNotContain(guest, p => p.Contains("too much on their plate"));
        Assert.Equal(before, Chat.Requests.Count); Assert.Equal(classified, Chat.Classified.Count);
    }
}
