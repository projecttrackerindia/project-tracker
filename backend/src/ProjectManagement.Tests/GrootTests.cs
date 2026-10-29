using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;
using ProjectManagement.Api.Middleware;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Aura, the app's assistant: it introduces itself as the organization's assistant (never as a model), and the long-paragraph bug in + New:
/// a title longer than its column is a clear 422 from every work item path, and a database "value too long" is a 422, not a 409 conflict.
/// </summary>
[Collection("api")]
public class GrootTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private const string Paragraph = "Hi Team, We will carry out planned security remediation on the network firewall cluster this weekend. ";

    // ------------------------------------------------------------------ identity

    [Theory]
    [InlineData("who are you?")]
    [InlineData("Who are you")]
    [InlineData("what's your name?")]
    [InlineData("hi, who r u")]
    [InlineData("are you ChatGPT?")]
    [InlineData("Introduce yourself")]
    public void Identity_questions_are_recognised(string text) => Assert.True(GrootIdentity.IsIdentityQuestion(text));

    [Theory]
    [InlineData("who are you assigning WT-12 to?")]
    [InlineData("what is overdue on Atlas")]
    [InlineData("")]
    public void Ordinary_questions_are_not_identity_questions(string text) => Assert.False(GrootIdentity.IsIdentityQuestion(text));

    [Fact]
    public void The_identity_names_the_organization_and_no_model()
    {
        Assert.Equal("I'm Aura, Orbitline Co's assistant in ProjectTracker.", GrootIdentity.Answer("Orbitline Co"));
        Assert.Equal("I'm Aura, Acme Labs' assistant in ProjectTracker.", GrootIdentity.Answer("Acme Labs"));
        Assert.Equal("I'm Aura, your organization's assistant in ProjectTracker.", GrootIdentity.Answer("  "));
        var line = GrootIdentity.PromptLine("Orbitline Co");
        Assert.Contains("Your name is Aura", line);
        Assert.Contains("Orbitline Co's assistant in ProjectTracker", line);
        Assert.Contains("Never claim to be", line);
        Assert.Contains("Never claim to be", GrootIdentity.Generic);
    }

    private static async Task<(string Text, List<(string Name, JsonNode Data)> Events)> Ask(TestClient c, string text)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/ai/ask") { Content = JsonContent.Create(new { text, mode = "auto", attachmentIds = Array.Empty<string>(), timeZone = "Asia/Kolkata" }) };
        req.Headers.Add("X-Token-Delivery", "body");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", c.Token);
        using var res = await c.Http.SendAsync(req);
        var body = await res.Content.ReadAsStringAsync();
        Assert.True(res.StatusCode == HttpStatusCode.OK, body);
        var events = body.Split("\n\n", StringSplitOptions.RemoveEmptyEntries).Select(block =>
        {
            var lines = block.Split('\n');
            return (lines[0]["event: ".Length..], JsonNode.Parse(lines[1]["data: ".Length..])!);
        }).ToList();
        return (string.Concat(events.Where(e => e.Item1 == "text").Select(e => S(e.Item2["delta"]))), events);
    }

    private async Task<(TestClient Owner, string Org)> Org()
    {
        factory.Chat.Reset();
        factory.Chat.Configured = true;
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        var org = $"Orbitline {Guid.NewGuid():N}"[..14] + " Co";
        await owner.CreateOrgAsync(org);
        await owner.UpgradeAsync("BUSINESS");
        return (owner, org);
    }

    [Fact]
    public async Task Asked_who_it_is_Groot_answers_with_the_workspace_name_without_asking_a_model()
    {
        var (owner, org) = await Org();
        factory.Chat.Requests.Clear();
        var (text, _) = await Ask(owner, "Who are you?");
        Assert.StartsWith($"I'm Aura, {org}'s assistant in ProjectTracker.", text);
        Assert.DoesNotContain("Claude", text);
        Assert.Empty(factory.Chat.Requests);   // the application answers; no model can claim another identity
    }

    [Fact]
    public async Task Every_model_conversation_is_told_it_is_Groot_of_this_organization()
    {
        var (owner, org) = await Org();
        factory.Chat.Requests.Clear();
        factory.Chat.Script.Enqueue(_ => FakeAiChat.Say("Nothing is overdue."));
        await Ask(owner, "What is overdue on my team this week?");
        var sent = factory.Chat.Requests.Last();
        Assert.Contains($"You are {org}'s assistant in ProjectTracker", sent.Context);
        Assert.Contains("are Aura", sent.System, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Project Tracker's assistant", sent.System);
    }

    // ------------------------------------------------------------------ titles too long

    [Fact]
    public async Task A_pasted_paragraph_as_a_title_is_a_clear_422_for_every_kind()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var project = await owner.CreateProjectAsync("Firewall");
        var types = (await owner.Get("/api/v1/work-types?includeInactive=true")).Data!.AsArray();
        var type = S(types.First()!["id"]);
        var longTitle = string.Concat(Enumerable.Repeat(Paragraph, 4));   // ~400 characters
        foreach (var body in new object[]
                 {
                     new { kind = "task", projectId = project, title = longTitle, priority = "Critical" },
                     new { kind = "issue", projectId = project, title = longTitle },
                     new { kind = "action", projectId = project, title = longTitle },
                     new { kind = "ticket", workTypeId = type, title = longTitle },
                 })
        {
            var r = await owner.Post("/api/v1/work-items", body);
            Assert.True(r.Status == HttpStatusCode.UnprocessableEntity, r.ToString());
            Assert.Equal("VALIDATION_FAILED", r.ErrorCode);
            Assert.Equal("title", S(r.Json!["errors"]![0]!["field"]));
            Assert.Contains("too long", S(r.Json["message"]));
            Assert.Contains("Keep it to 200 characters", S(r.Json["message"]));
        }
        // The legacy task route goes through the same service rule.
        var legacy = await owner.Post($"/api/v1/projects/{project}/tasks", new { title = longTitle, priority = "Medium" });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, legacy.Status);

        // A short title with the whole paragraph as its description is what + New now sends, and it is created.
        var made = await owner.Post("/api/v1/work-items", new { kind = "task", projectId = project, title = "Planned security remediation on the network firewall", description = longTitle });
        Assert.True(made.Status == HttpStatusCode.Created, made.ToString());
        Assert.Equal(longTitle.Trim(), S(made.Data!["description"]).Trim());

        // Renaming to a paragraph is refused the same way.
        var id = S(made.Data["id"]);
        var version = made.Data["version"]!.GetValue<int>();
        var renamed = await owner.Patch($"/api/v1/work-items/{id}", new { version, title = longTitle });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, renamed.Status);
        Assert.Contains("too long", S(renamed.Json!["message"]));
    }

    [Fact]
    public void A_paragraph_becomes_its_first_sentence_without_the_greeting()
    {
        Assert.Equal("We will carry out planned security remediation on the network firewall cluster this weekend", GrootTitleService.FirstSentence(Paragraph + "More detail follows."));
        var longOne = GrootTitleService.FirstSentence(string.Concat(Enumerable.Repeat("word ", 80)));
        Assert.True(longOne.Length <= GrootTitleService.MaxTitle + 1);
        Assert.EndsWith("…", longOne);
    }

    [Fact]
    public async Task The_title_endpoint_falls_back_to_the_first_sentence_without_AI()
    {
        factory.Ai.Reset();   // the AI client is off: no model, the first sentence
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var r = await owner.Post("/api/v1/ai/title", new { text = Paragraph + Paragraph, kind = "task" });
        Assert.True(r.Ok, r.ToString());
        Assert.Equal("We will carry out planned security remediation on the network firewall cluster this weekend", S(r.Data!["title"]));
        Assert.False(r.Data["ai"]!.GetValue<bool>());
    }

    [Fact]
    public void Postgres_reports_value_too_long_as_22001_and_it_is_recognised()
    {
        // Only PostgreSQL enforces column lengths (SQLite stores any length), so the check runs where the tests use it.
        if (!factory.WithDb(db => db.Database.IsNpgsql())) return;
        var caught = factory.WithDb(db =>
        {
            db.PlatformSettings.Add(new PlatformSetting { Key = "groot-" + new string('k', 300), Value = "x" });
            try { db.SaveChanges(); return (DbUpdateException?)null; }
            catch (DbUpdateException ex) { return ex; }
        });
        Assert.NotNull(caught);
        Assert.True(DbErrors.IsStringTooLong(caught!));
    }

    [Fact]
    public async Task The_exception_middleware_maps_22001_to_422_not_a_409_conflict()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var http = new DefaultHttpContext { RequestServices = scope.ServiceProvider };
        http.Request.Method = "POST"; http.Request.Path = "/api/v1/work-items";
        http.Response.Body = new MemoryStream();
        var pg = new PostgresException("value too long for type character varying(200)", "ERROR", "ERROR", "22001");
        await new ApiExceptionMiddleware(_ => throw new DbUpdateException("An error occurred while saving the entity changes.", pg),
            NullLogger<ApiExceptionMiddleware>.Instance).InvokeAsync(http);
        Assert.Equal(422, http.Response.StatusCode);
        var json = JsonNode.Parse(Encoding.UTF8.GetString(((MemoryStream)http.Response.Body).ToArray()))!;
        Assert.StartsWith("Some text is too long", S(json["message"]));
        Assert.Equal(TextLimits.TooLongCode, S(json["errors"]![0]!["code"]));

        // Any other database failure is still a conflict.
        var other = new DefaultHttpContext { RequestServices = scope.ServiceProvider };
        other.Response.Body = new MemoryStream();
        await new ApiExceptionMiddleware(_ => throw new DbUpdateException("dup", new PostgresException("duplicate key", "ERROR", "ERROR", "23505")),
            NullLogger<ApiExceptionMiddleware>.Instance).InvokeAsync(other);
        Assert.Equal(409, other.Response.StatusCode);
    }
}
