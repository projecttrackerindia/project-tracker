using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Automation;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Services;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The AI assistant, live change events, smarter automation (several actions, workspace rules, schedules) and Web Push.</summary>
[Collection("api")]
public class AssistantAutomationPushTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static string Iso(int days) => DateOnly.FromDateTime(DateTime.UtcNow).AddDays(days).ToString("yyyy-MM-dd");

    private sealed record Org(TestClient Owner, TestClient Dev, TestClient Member, Guid Project);

    private async Task<Org> Setup(string plan = "BUSINESS")
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        if (plan != "FREE") await owner.UpgradeAsync(plan);
        var dev = await owner.AddMemberAsync(factory, TenantRole.Manager, "Dev Developer");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mo Member");
        return new Org(owner, dev, member, await owner.CreateProjectAsync("Atlas"));
    }

    // ------------------------------------------------------------------ AI assistant

    [Fact]
    public async Task The_assistant_is_off_without_a_key_and_answers_only_from_what_the_caller_can_see()
    {
        var o = await Setup();
        try
        {
            factory.Ai.Reset();
            Assert.False((await o.Owner.Get("/api/v1/ai/status")).Data!["enabled"]!.GetValue<bool>());
            Assert.Equal("AI_NOT_CONFIGURED", (await o.Owner.Post("/api/v1/ai/search", new { query = "overdue work" })).ErrorCode);

            factory.Ai.Configured = true;
            var status = (await o.Owner.Get("/api/v1/ai/status")).Data!;
            Assert.True(status["enabled"]!.GetValue<bool>());
            Assert.Equal("Claude (Anthropic)", S(status["provider"]));   // named in the privacy notes

            // Plain-language search: the model only turns words into a filter; the app runs it with the caller's access.
            await o.Owner.CreateTaskAsync(o.Project, "Renew the SSL certificate", new { title = "Renew the SSL certificate", priority = "High", assigneeId = o.Owner.UserId, dueDate = Iso(-2) });
            await o.Owner.CreateTaskAsync(o.Project, "Not overdue", new { title = "Not overdue", priority = "High", assigneeId = o.Owner.UserId, dueDate = Iso(5) });
            factory.Ai.Answer = (_, user) => """{"interpretation":"Your overdue work","kinds":[],"assigneeId":"me","projectId":null,"openOnly":true,"overdue":true,"dueFrom":null,"dueTo":null,"priority":"High","text":null}""";
            var found = (await o.Owner.Post("/api/v1/ai/search", new { query = "my overdue high priority work" })).Data!;
            Assert.Equal("Your overdue work", S(found["interpretation"]));
            Assert.Equal(["Renew the SSL certificate"], found["items"]!.AsArray().Select(i => S(i!["title"])));
            Assert.Contains("Olivia Owner", factory.Ai.Prompts.Last().User);   // people are named so "assigned to X" can be resolved

            // Delay risk: JSON is read defensively (score clamped, unknown risk words replaced).
            factory.Ai.Answer = (_, _) => "Sure! ```json\n{\"risk\":\"high\",\"score\":140,\"headline\":\"Two tasks slipped\",\"reasons\":[\"ATL-1 is overdue\"],\"actions\":[\"Re-plan\"]}\n```";
            var risk = (await o.Owner.Post($"/api/v1/ai/projects/{o.Project}/risk")).Data!;
            Assert.Equal("high", S(risk["risk"]));
            Assert.Equal(100, risk["score"]!.GetValue<int>());
            Assert.Equal("Two tasks slipped", S(risk["headline"]));

            // Meeting notes: people the model names must be members; anything else is dropped.
            factory.Ai.Answer = (_, _) => JsonSerializer.Serialize(new { items = new object[]
            {
                new { title = "Send the signed contract", assigneeId = o.Dev.UserId.ToString(), dueDate = Iso(3) },
                new { title = "Book the venue", assigneeId = Guid.NewGuid().ToString(), dueDate = (string?)null },
            } });
            var items = (await o.Owner.Post($"/api/v1/ai/projects/{o.Project}/action-items", new { notes = "Dev will send the signed contract by Friday. Someone books the venue." })).Data!["items"]!.AsArray();
            Assert.Equal(2, items.Count);
            Assert.Equal(o.Dev.UserId.ToString(), S(items[0]!["assigneeId"]));
            Assert.Null(items[1]!["assigneeId"]);

            // Each use is audited by feature, never by content.
            var audit = factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Where(a => a.TenantId == o.Owner.WorkspaceId && a.Action == "ai.used").Select(a => a.NewValue).ToList());
            Assert.Equal(3, audit.Count);
            Assert.DoesNotContain(audit, v => v!.Contains("contract"));
            Assert.All(audit, v => Assert.Contains("claude-test", v));   // the model that answered

            // A failed request is recorded too: what was gathered may have reached a provider.
            factory.Ai.Answer = (_, _) => throw new AppException(503, "AI_BUSY", "The AI assistant is busy. Try again in a moment.");
            Assert.Equal("AI_BUSY", (await o.Owner.Post("/api/v1/ai/search", new { query = "overdue work" })).ErrorCode);
            var failed = factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Where(a => a.TenantId == o.Owner.WorkspaceId && a.Action == "ai.used").Select(a => a.NewValue).ToList());
            Assert.Equal(4, failed.Count);
            Assert.Single(failed, v => v!.Contains("failed"));

            // A workspace can switch it off; members cannot.
            Assert.Equal(HttpStatusCode.Forbidden, (await o.Member.Put("/api/v1/ai/status", new { allowed = false })).Status);
            Assert.False((await o.Owner.Put("/api/v1/ai/status", new { allowed = false })).Data!["enabled"]!.GetValue<bool>());
            Assert.Equal("AI_DISABLED", (await o.Owner.Post("/api/v1/ai/search", new { query = "anything at all" })).ErrorCode);
        }
        finally { factory.Ai.Reset(); }
    }

    [Fact]
    public async Task The_assistant_needs_a_plan_that_includes_it()
    {
        var o = await Setup("PRO");
        try
        {
            factory.Ai.Configured = true;
            var status = (await o.Owner.Get("/api/v1/ai/status")).Data!;
            Assert.False(status["enabled"]!.GetValue<bool>());
            Assert.False(status["entitled"]!.GetValue<bool>());
            Assert.Equal(HttpStatusCode.Forbidden, (await o.Owner.Post("/api/v1/ai/search", new { query = "overdue work" })).Status);
        }
        finally { factory.Ai.Reset(); }
    }

    private sealed class OneClient(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private sealed class AnthropicStub : HttpMessageHandler
    {
        public HttpRequestMessage? Request; public string? Body;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Request = request; Body = await request.Content!.ReadAsStringAsync(ct);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("""{"content":[{"type":"text","text":"Hello from Claude"}],"stop_reason":"end_turn"}""") };
        }
    }

    [Fact]
    public async Task The_Anthropic_client_sends_the_documented_request()
    {
        var stub = new AnthropicStub();
        var client = new AnthropicClient(new OneClient(stub), Options.Create(new AiOptions { AnthropicApiKey = "sk-test", Model = "claude-sonnet-5" }), NullLogger<AnthropicClient>.Instance);
        Assert.Equal("Hello from Claude", await client.CompleteAsync("Be brief.", "Hi", 300, default));
        Assert.Equal("https://api.anthropic.com/v1/messages", stub.Request!.RequestUri!.ToString());
        Assert.Equal("sk-test", stub.Request.Headers.GetValues("x-api-key").Single());
        Assert.Equal("2023-06-01", stub.Request.Headers.GetValues("anthropic-version").Single());
        var body = JsonNode.Parse(stub.Body!)!;
        Assert.Equal("claude-sonnet-5", S(body["model"]));
        Assert.Equal(300, body["max_tokens"]!.GetValue<int>());
        Assert.Equal("Be brief.", S(body["system"]));
        Assert.Equal("user", S(body["messages"]![0]!["role"]));
    }

    /// <summary>Answers every request with one status and body, and counts them.</summary>
    private sealed class FixedStub(HttpStatusCode status, string body) : HttpMessageHandler
    {
        public int Calls; public HttpRequestMessage? Request; public string? Body;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls++; Request = request; Body = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
            return new HttpResponseMessage(status) { Content = new StringContent(body) };
        }
    }

    private const string NoCredit = """{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}""";
    private const string BackupSays = """{"choices":[{"index":0,"message":{"role":"assistant","content":"Hello from the backup"},"finish_reason":"stop"}]}""";

    private static AiOptions WithGemini(string? anthropicKey) => new()
    {
        AnthropicApiKey = anthropicKey, Model = "claude-sonnet-5",
        Fallback = new AiFallbackOptions { BaseUrl = "https://generativelanguage.googleapis.com/v1beta/openai/", ApiKey = "gm-test", Model = "gemini-flash-test", ReasoningEffort = "low" },
    };

    [Fact]
    public async Task The_backup_client_sends_an_OpenAI_style_request()
    {
        var stub = new FixedStub(HttpStatusCode.OK, BackupSays);
        var client = new OpenAiCompatibleClient(new OneClient(stub), Options.Create(WithGemini(null)), NullLogger<OpenAiCompatibleClient>.Instance);
        Assert.Equal("Google Gemini", client.Name);
        Assert.Equal("Hello from the backup", await client.CompleteAsync("Be brief.", "Hi", 300, default));
        Assert.Equal("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", stub.Request!.RequestUri!.ToString());
        Assert.Equal("Bearer gm-test", stub.Request.Headers.Authorization!.ToString());
        var body = JsonNode.Parse(stub.Body!)!;
        Assert.Equal("gemini-flash-test", S(body["model"]));
        Assert.Equal(300 + 2048, body["max_tokens"]!.GetValue<int>());   // room for thinking on top of the answer
        Assert.Equal("low", S(body["reasoning_effort"]));
        Assert.Equal(["system", "user"], body["messages"]!.AsArray().Select(m => S(m!["role"])));
        Assert.Equal("Be brief.", S(body["messages"]![0]!["content"]));

        Assert.Equal("Groq", OpenAiCompatibleClient.NameFor("https://api.groq.com/openai/v1"));
        Assert.Equal("a model on your own server", OpenAiCompatibleClient.NameFor("http://ollama:11434/v1"));
    }

    [Fact]
    public async Task When_Claude_runs_out_of_credit_the_backup_answers()
    {
        var anthropic = new FixedStub(HttpStatusCode.BadRequest, NoCredit);
        var openai = new FixedStub(HttpStatusCode.OK, BackupSays);
        AiRouter Router(AiOptions o)
        {
            var opt = Options.Create(o);
            return new AiRouter(new AnthropicClient(new OneClient(anthropic), opt, NullLogger<AnthropicClient>.Instance),
                new OpenAiCompatibleClient(new OneClient(openai), opt, NullLogger<OpenAiCompatibleClient>.Instance), NullLogger<AiRouter>.Instance);
        }

        var router = Router(WithGemini("sk-test"));
        Assert.Equal("Claude (Anthropic)", router.Provider);
        Assert.Equal("Google Gemini", router.Backup);
        Assert.Equal(new AiAnswer("Hello from the backup", "gemini-flash-test"), await router.CompleteAsync("Be brief.", "Hi", 300, default));
        Assert.Equal(1, anthropic.Calls);
        // Running out of credit does not mend itself in seconds: the backup answers straight away for a while.
        await router.CompleteAsync("Be brief.", "Again", 300, default);
        Assert.Equal(1, anthropic.Calls);
        Assert.Equal(2, openai.Calls);

        // Without a backup the person is told plainly what is wrong.
        var alone = Router(new AiOptions { AnthropicApiKey = "sk-test" });
        Assert.Null(alone.Backup);
        Assert.Equal("AI_NO_CREDIT", (await Assert.ThrowsAsync<AppException>(() => alone.CompleteAsync("Be brief.", "Hi", 300, default))).Code);

        // The backup on its own (no Anthropic key) runs the assistant by itself.
        var backupOnly = Router(WithGemini(null));
        Assert.True(backupOnly.Configured);
        Assert.Equal("Google Gemini", backupOnly.Provider);
        Assert.Null(backupOnly.Backup);
        Assert.Equal("gemini-flash-test", (await backupOnly.CompleteAsync("Be brief.", "Hi", 300, default)).Model);
        Assert.Equal(2, anthropic.Calls);   // only the call made without a backup
    }

    // ------------------------------------------------------------------ live changes

    [Fact]
    public async Task Saved_changes_are_published_for_open_screens()
    {
        var o = await Setup();
        var task = await o.Owner.CreateTaskAsync(o.Project, "Live one");
        var events = factory.Changes.Published.Where(c => c.TenantId == o.Owner.WorkspaceId).ToList();
        Assert.Contains(events, c => c.Action == "task.created" && c.EntityType == "Task" && c.EntityId == Guid.Parse(S(task["id"])) && c.ProjectId == o.Project && c.ActorId == o.Owner.UserId);
    }

    // ------------------------------------------------------------------ automation

    [Fact]
    public async Task Workspace_rules_do_several_things_in_every_project()
    {
        var o = await Setup();
        var rule = await o.Owner.Post("/api/v1/automations", new
        {
            name = "Triage everything", isEnabled = true, trigger = "TaskCreated", action = "SetPriority", actionPriority = "High",
            moreActions = new object[] { new { action = "AddComment", actionText = "Please triage" }, new { action = "MoveToStatus", actionStatusCategory = "Active" } },
        });
        Assert.Equal(HttpStatusCode.Created, rule.Status);
        Assert.Contains("in any project", S(rule.Data!["summary"]));
        Assert.Equal(2, rule.Data!["moreActions"]!.AsArray().Count);
        Assert.Equal(HttpStatusCode.Forbidden, (await o.Member.Post("/api/v1/automations", new { name = "x", isEnabled = true, trigger = "TaskCreated", action = "SetPriority", actionPriority = "Low" })).Status);
        Assert.Equal(422, (int)(await o.Owner.Post("/api/v1/automations", new { name = "x", isEnabled = true, trigger = "Stale", triggerDays = 0, action = "SetPriority", actionPriority = "Low" })).Status);
        Assert.Equal(422, (int)(await o.Owner.Post("/api/v1/automations", new
        {
            name = "Too much", isEnabled = true, trigger = "TaskCreated", action = "SetPriority", actionPriority = "Low",
            moreActions = Enumerable.Range(0, 5).Select(_ => new { action = "AddComment", actionText = "x" }).ToArray(),
        })).Status);

        var other = await o.Owner.CreateProjectAsync("Zephyr");
        var task = await o.Owner.CreateTaskAsync(other, "Fresh", new { title = "Fresh", priority = "Low" });
        var detail = (await o.Owner.Get($"/api/v1/tasks/{S(task["id"])}")).Data!["task"]!;
        Assert.Equal("High", S(detail["priority"]));
        Assert.Equal("Active", S(detail["statusCategory"]));
        var comments = (await o.Owner.Get($"/api/v1/tasks/{S(task["id"])}/comments")).Data!.AsArray();
        Assert.Contains(comments, c => S(c!["body"]).Contains("Please triage"));
    }

    [Fact]
    public async Task Scheduled_rules_run_once_per_due_date()
    {
        var o = await Setup();
        var made = await o.Owner.Post($"/api/v1/projects/{o.Project}/automations", new
        {
            name = "Nudge", isEnabled = true, trigger = "DueSoon", triggerDays = 2, action = "Notify", actionTarget = "Assignee", actionText = "Due very soon",
        });
        Assert.Equal(HttpStatusCode.Created, made.Status);
        Assert.Contains("due within 2 days", S(made.Data!["summary"]));
        var task = await o.Owner.CreateTaskAsync(o.Project, "Ship it", new { title = "Ship it", priority = "Medium", assigneeId = o.Dev.UserId, dueDate = Iso(1) });
        await o.Owner.CreateTaskAsync(o.Project, "Later", new { title = "Later", priority = "Medium", assigneeId = o.Dev.UserId, dueDate = Iso(10) });

        async Task Run() { using var scope = factory.Services.CreateScope(); await scope.ServiceProvider.GetRequiredService<AutomationScheduler>().RunAsync(); }
        int Nudges() => factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Count(n => n.UserId == o.Dev.UserId && n.Title.Contains("Nudge")));
        await Run();
        Assert.Equal(1, Nudges());
        await Run();
        Assert.Equal(1, Nudges());   // once per period

        // A new due date is a new period.
        var id = Guid.Parse(S(task["id"]));
        factory.WithDb(db => { db.Tasks.IgnoreQueryFilters().Single(t => t.Id == id).DueDate = DateOnly.FromDateTime(DateTime.UtcNow).AddDays(2); return db.SaveChanges(); });
        await Run();
        Assert.Equal(2, Nudges());
    }

    // ------------------------------------------------------------------ Web Push

    private static byte[] B64(string s) => Base64Url.Decode(s);

    [Fact]
    public async Task Notifications_are_pushed_encrypted_to_the_persons_devices()
    {
        var o = await Setup();
        using var device = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        var dp = device.ExportParameters(false);
        byte[] uaPublic = [0x04, .. dp.Q.X!, .. dp.Q.Y!];
        var auth = RandomNumberGenerator.GetBytes(16);
        var endpoint = $"https://push.example.test/send/{Guid.NewGuid():N}";
        Assert.Equal(422, (int)(await o.Dev.Post("/api/v1/push/subscriptions", new { endpoint = "http://insecure.test/x", keys = new { p256dh = Base64Url.Encode(uaPublic), auth = Base64Url.Encode(auth) } })).Status);
        var sub = await o.Dev.Post("/api/v1/push/subscriptions", new { endpoint, keys = new { p256dh = Base64Url.Encode(uaPublic), auth = Base64Url.Encode(auth) } });
        Assert.True(sub.Ok, sub.ToString());
        Assert.Equal(1, sub.Data!["devices"]!.GetValue<int>());
        var vapid = S(sub.Data!["publicKey"]);
        Assert.Equal(65, B64(vapid).Length);

        // Dev wants "task assigned" on their devices.
        Assert.True((await o.Dev.Put("/api/v1/me/notification-preferences", new { items = new[] { new { type = "TaskAssigned", inApp = true, email = false, browser = true } } })).Ok);
        await o.Owner.CreateTaskAsync(o.Project, "Prepare the demo", new { title = "Prepare the demo", priority = "High", assigneeId = o.Dev.UserId });
        await factory.Services.GetRequiredService<PushDispatcher>().RunAsync();

        var sent = factory.Push.Sent.Single(s => s.Url.ToString() == endpoint);
        Assert.Equal("aes128gcm", sent.Headers["Content-Encoding"]);
        Assert.Equal("86400", sent.Headers["TTL"]);

        // The VAPID token is ES256-signed by the server's key, for the push service's origin.
        var authz = sent.Headers["Authorization"];
        Assert.StartsWith("vapid t=", authz);
        var jwt = authz["vapid t=".Length..authz.IndexOf(',')];
        Assert.EndsWith($"k={vapid}", authz);
        var parts = jwt.Split('.');
        var claims = JsonNode.Parse(B64(parts[1]))!;
        Assert.Equal("https://push.example.test", S(claims["aud"]));
        var vp = B64(vapid);
        using (var verify = ECDsa.Create(new ECParameters { Curve = ECCurve.NamedCurves.nistP256, Q = new ECPoint { X = vp[1..33], Y = vp[33..65] } }))
            Assert.True(verify.VerifyData(Encoding.ASCII.GetBytes($"{parts[0]}.{parts[1]}"), B64(parts[2]), HashAlgorithmName.SHA256));

        // Decrypt exactly as a browser does (RFC 8291).
        var body = sent.Body;
        var salt = body[..16];
        Assert.Equal(65, body[20]);
        var asPublic = body[21..86];
        using var server = ECDiffieHellman.Create(new ECParameters { Curve = ECCurve.NamedCurves.nistP256, Q = new ECPoint { X = asPublic[1..33], Y = asPublic[33..65] } });
        var shared = device.DeriveRawSecretAgreement(server.PublicKey);
        var ikm = HMACSHA256.HashData(HMACSHA256.HashData(auth, shared), (byte[])[.. "WebPush: info\0"u8, .. uaPublic, .. asPublic, 0x01]);
        var prk = HMACSHA256.HashData(salt, ikm);
        var cek = HMACSHA256.HashData(prk, (byte[])[.. "Content-Encoding: aes128gcm\0"u8, 0x01])[..16];
        var nonce = HMACSHA256.HashData(prk, (byte[])[.. "Content-Encoding: nonce\0"u8, 0x01])[..12];
        var cipher = body[86..^16]; var tag = body[^16..];
        var plain = new byte[cipher.Length];
        using (var aes = new AesGcm(cek, 16)) aes.Decrypt(nonce, cipher, tag, plain);
        Assert.Equal(0x02, plain[^1]);
        var payload = JsonNode.Parse(Encoding.UTF8.GetString(plain[..^1]))!;
        Assert.Contains("Prepare the demo", S(payload["body"]));
        Assert.Equal("TaskAssigned", S(payload["type"]));
        Assert.StartsWith($"/projects/{o.Project}", S(payload["link"]));

        // A device the push service no longer knows is forgotten.
        factory.Push.Status = HttpStatusCode.Gone;
        try
        {
            await o.Owner.CreateTaskAsync(o.Project, "Another", new { title = "Another", priority = "Low", assigneeId = o.Dev.UserId });
            await factory.Services.GetRequiredService<PushDispatcher>().RunAsync();
            Assert.Equal(0, (await o.Dev.Get("/api/v1/push")).Data!["devices"]!.GetValue<int>());
        }
        finally { factory.Push.Status = HttpStatusCode.Created; }
    }
}
