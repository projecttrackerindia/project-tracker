using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Persistence;

namespace ProjectManagement.Tests.Infrastructure;

/// <summary>Boots the real API (SQLite, no rate limiting, no background jobs) against a throw-away database file.</summary>
public sealed class ApiFactory : WebApplicationFactory<Program>
{
    private readonly string _dbPath = Path.Combine(Path.GetTempPath(), $"pm-test-{Guid.NewGuid():N}.db");
    /// <summary>
    /// Set PM_TEST_POSTGRES to a PostgreSQL connection string without a database (for example "Host=127.0.0.1;Port=5433;Username=postgres") and the
    /// whole suite runs against a fresh PostgreSQL database instead of SQLite: the same tests, the real production engine.
    /// </summary>
    private static readonly string? PostgresAdmin = Environment.GetEnvironmentVariable("PM_TEST_POSTGRES");
    private readonly string _pgName = $"pm_test_{Guid.NewGuid():N}";
    public string BackupsPath { get; } = Path.Combine(Path.GetTempPath(), $"pm-backups-{Guid.NewGuid():N}");
    public string FilesPath { get; } = Path.Combine(Path.GetTempPath(), $"pm-files-{Guid.NewGuid():N}");

    public ApiFactory()
    {
        // Environment variables are the one configuration source Program.cs reads reliably before the host is built.
        if (PostgresAdmin is not null)
        {
            using (var admin = new Npgsql.NpgsqlConnection($"{PostgresAdmin};Database=postgres")) { admin.Open(); using var cmd = admin.CreateCommand(); cmd.CommandText = $"create database \"{_pgName}\""; cmd.ExecuteNonQuery(); }
            Environment.SetEnvironmentVariable("Database__Provider", "Postgres");
            Environment.SetEnvironmentVariable("ConnectionStrings__Default", $"{PostgresAdmin};Database={_pgName};Maximum Pool Size=60");
        }
        else
        {
            Environment.SetEnvironmentVariable("Database__Provider", "Sqlite");
            Environment.SetEnvironmentVariable("ConnectionStrings__Default", $"Data Source={_dbPath}");
        }
        Environment.SetEnvironmentVariable("Jwt__SigningKey", "test-signing-key-0123456789-0123456789-abcdef");
        Environment.SetEnvironmentVariable("RateLimiting__Enabled", "false");
        Environment.SetEnvironmentVariable("Storage__LocalPath", FilesPath);
        Directory.CreateDirectory(BackupsPath);
        Environment.SetEnvironmentVariable("Backups__Path", BackupsPath);
        Environment.SetEnvironmentVariable("Maintenance__Enabled", "false");
        Environment.SetEnvironmentVariable("Notifications__EmailWorkerEnabled", "false"); // tests drive the dispatcher explicitly
        Environment.SetEnvironmentVariable("Reports__WorkerEnabled", "false"); // tests run the report processor explicitly
        Environment.SetEnvironmentVariable("Cache__EntitlementSeconds", "0"); // most tests change plans directly in the database; cache tests switch it on themselves
        Environment.SetEnvironmentVariable("Webhooks__WorkerEnabled", "false"); // tests run the webhook processor explicitly
        Environment.SetEnvironmentVariable("Sla__WorkerEnabled", "false"); // tests run the service-level monitor explicitly
        Environment.SetEnvironmentVariable("GoogleMeetSync__WorkerEnabled", "false"); // tests run the RSVP sync engine explicitly
        Environment.SetEnvironmentVariable("Automation__WorkerEnabled", "false"); // tests run the automation scheduler explicitly
        Environment.SetEnvironmentVariable("Push__WorkerEnabled", "false"); // tests run the push dispatcher explicitly
        Environment.SetEnvironmentVariable("Ai__Chat__CompactAfterMessages", "8"); // small, so a test can reach the point where an AI conversation is summarized
        Environment.SetEnvironmentVariable("Ai__Chat__KeepRecentMessages", "4");
        Environment.SetEnvironmentVariable("Ai__PrimaryProvider", "anthropic");
        Environment.SetEnvironmentVariable("Ai__AllowAnthropic", "true");
        Environment.SetEnvironmentVariable("Ai__Chat__RefusalFallbackModel", "claude-opus-4-8");
        Environment.SetEnvironmentVariable("Ai__Chat__UseClassifier", "true"); // classifier tests opt in explicitly
        Environment.SetEnvironmentVariable("Reminders__WorkerEnabled", "false"); // tests run the reminder engine explicitly
        Environment.SetEnvironmentVariable("Webhooks__AllowPrivateTargets", "true");
        Environment.SetEnvironmentVariable("Webhooks__SettleSeconds", "0");
        Environment.SetEnvironmentVariable("Dev__Mailbox", "true");
        Environment.SetEnvironmentVariable("Seed__Demo", "false");
        Environment.SetEnvironmentVariable("Proxy__Trust", "true"); // lets tests simulate a caller address via X-Forwarded-For (org IP-allowlist tests)
        Environment.SetEnvironmentVariable("Auth__Google__ClientId", "google-client");   // social sign-in tests (the fake provider answers for Google)
        Environment.SetEnvironmentVariable("Auth__Google__ClientSecret", "google-secret");
        Environment.SetEnvironmentVariable("GoogleCalendar__ClientId", "google-cal-client");   // a separate client from sign-in: Calendar/Meet scopes, not identity
        Environment.SetEnvironmentVariable("GoogleCalendar__ClientSecret", "google-cal-secret");
        Environment.SetEnvironmentVariable("GoogleCalendar__RedirectUri", "https://testhost/api/v1/integrations/google/callback");
    }

    /// <summary>Stands in for OpenID Connect providers (single sign-on and Google): every "oidc" HTTP call lands here.</summary>
    public FakeIdentityProvider Idp { get; } = new();
    /// <summary>Stands in for Google's OAuth token endpoint and the Calendar API: every "google-calendar" HTTP call lands here.</summary>
    public FakeGoogleCalendar GoogleCalendar { get; } = new();
    /// <summary>Stands in for DNS: domain-ownership TXT records a test has published.</summary>
    public FakeDns Dns { get; } = new();
    /// <summary>Stands in for Claude (off until a test switches it on).</summary>
    public FakeAiClient Ai { get; } = new();
    /// <summary>Stands in for Claude in the AI workspace (streamed, with tools and files).</summary>
    public FakeAiChat Chat { get; } = new();
    /// <summary>Stands in for the Web Push services.</summary>
    public RecordingPushHandler Push { get; } = new();
    /// <summary>What would be broadcast to open screens.</summary>
    public RecordingChangeFeed Changes { get; } = new();

    /// <summary>Stands in for the internet: records every webhook request and answers with whatever the test asks for.</summary>
    public RecordingWebhookTransport Webhooks { get; } = new();
    /// <summary>Everything the application logged, so a test can prove a secret never reaches a log line.</summary>
    public LogSink Logs { get; } = new();
    public FakePayments Payments { get; } = new();

    protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.ConfigureLogging(l => l.AddProvider(Logs));
        builder.ConfigureTestServices(services =>
        {
            // Admission windows stay deterministic even when an HTTP test happens to cross a minute boundary.
            // The standalone Redis tests exercise the real distributed implementation separately.
            services.RemoveAll<ProjectManagement.Application.Features.Ai.IAiRequestLimiter>();
            services.AddSingleton<ProjectManagement.Application.Features.Ai.IAiRequestLimiter>(
                new ProjectManagement.Infrastructure.Services.MemoryAiRequestLimiter(new AiLimitClock()));
            services.RemoveAll<ProjectManagement.Application.Features.Integrations.IWebhookTransport>();
            services.AddSingleton<ProjectManagement.Application.Features.Integrations.IWebhookTransport>(Webhooks);
            services.AddHttpClient("oidc").ConfigurePrimaryHttpMessageHandler(() => Idp);
            services.AddHttpClient("google-calendar").ConfigurePrimaryHttpMessageHandler(() => GoogleCalendar);
            services.RemoveAll<ProjectManagement.Application.Features.Sso.IDomainVerifier>();
            services.AddSingleton<ProjectManagement.Application.Features.Sso.IDomainVerifier>(Dns);
            services.RemoveAll<ProjectManagement.Application.Features.Ai.IAiClient>();
            services.AddSingleton<ProjectManagement.Application.Features.Ai.IAiClient>(Ai);
            services.RemoveAll<ProjectManagement.Application.Features.Ai.IAiChat>();
            services.AddSingleton<ProjectManagement.Application.Features.Ai.IAiChat>(Chat);
            services.RemoveAll<ProjectManagement.Application.Abstractions.IPaymentProvider>();
            services.AddSingleton<ProjectManagement.Application.Abstractions.IPaymentProvider>(Payments);
            services.AddHttpClient("push").ConfigurePrimaryHttpMessageHandler(() => Push);
            services.RemoveAll<ProjectManagement.Application.Abstractions.IChangeFeed>();
            services.AddSingleton<ProjectManagement.Application.Abstractions.IChangeFeed>(Changes);
        });
    }

    public T WithDb<T>(Func<AppDbContext, T> action)
    {
        using var scope = Services.CreateScope();
        return action(scope.ServiceProvider.GetRequiredService<AppDbContext>());
    }

    private sealed class AiLimitClock : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.FromUnixTimeSeconds(1_800_000_000);
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        foreach (var f in new[] { _dbPath, _dbPath + "-wal", _dbPath + "-shm" })
            try { File.Delete(f); } catch { /* best effort */ }
        if (PostgresAdmin is not null)
            try { Npgsql.NpgsqlConnection.ClearAllPools(); using var admin = new Npgsql.NpgsqlConnection($"{PostgresAdmin};Database=postgres"); admin.Open(); using var cmd = admin.CreateCommand(); cmd.CommandText = $"drop database if exists \"{_pgName}\" with (force)"; cmd.ExecuteNonQuery(); } catch { /* best effort */ }
        try { if (Directory.Exists(FilesPath)) Directory.Delete(FilesPath, recursive: true); } catch { /* best effort */ }
        try { if (Directory.Exists(BackupsPath)) Directory.Delete(BackupsPath, recursive: true); } catch { /* best effort */ }
    }
}

[CollectionDefinition("api")]
public class ApiCollection : ICollectionFixture<ApiFactory>;

public record ApiResult(HttpStatusCode Status, JsonNode? Json, IReadOnlyDictionary<string, string>? Headers = null)
{
    public string? Header(string name) => Headers is not null && Headers.TryGetValue(name, out var v) ? v : null;
    public JsonNode? Data => Json?["data"];
    public string? ErrorCode => Json?["errors"]?[0]?["code"]?.GetValue<string>();
    public bool Ok => (int)Status < 400;
    public override string ToString() => $"{(int)Status} {Json?.ToJsonString()}";
}

public sealed class TestClient(ApiFactory factory)
{
    public readonly HttpClient Http = factory.CreateClient();
    public string? Token { get; set; }
    public string? RefreshToken { get; set; }
    public Guid UserId { get; set; }
    public string Email { get; set; } = "";
    /// <summary>When set, every request carries the team being looked at (X-Team-Lens), as the app does.</summary>
    public Guid? TeamLens { get; set; }
    public Guid WorkspaceId { get; set; }

    /// <summary>When set, sent as X-Forwarded-For (the app trusts it in tests: Proxy__Trust=true) to simulate this client's network address.</summary>
    public string? Ip { get; set; }

    /// <summary>Extra headers sent with every request (an Idempotency-Key, say).</summary>
    public Dictionary<string, string> Extra { get; } = new();

    /// <summary>
    /// Creating a project needs a project group. Most tests are about something else, so when a test creates a project without naming a group this client
    /// puts it in the workspace's first active one. Set to false to send the request exactly as written.
    /// </summary>
    public bool AutoProjectGroup { get; set; } = true;

    /// <summary>Creating a project also needs a project type. Same idea: a test that does not name one gets "NewProject". Set to false to send the request as written.</summary>
    public bool AutoProjectType { get; set; } = true;

    private async Task<object?> WithProjectGroupAsync(HttpMethod method, string url, object? body, bool anonymous)
    {
        if (anonymous || body is null || method != HttpMethod.Post || url.Split('?')[0] != "/api/v1/projects") return body;
        if (!AutoProjectGroup && !AutoProjectType) return body;
        var node = JsonSerializer.SerializeToNode(body, new JsonSerializerOptions(JsonSerializerDefaults.Web)) as JsonObject;
        if (node is null) return body;
        if (AutoProjectType && !node.ContainsKey("projectType")) node["projectType"] = "NewProject";
        if (AutoProjectGroup && !node.ContainsKey("projectGroupId"))
        {
            var groups = await Send(HttpMethod.Get, "/api/v1/project-groups?activeOnly=true");
            if (groups.Data is JsonArray { Count: > 0 } list) node["projectGroupId"] = list[0]!["id"]!.GetValue<string>();
        }
        return node;
    }

    public async Task<ApiResult> Send(HttpMethod method, string url, object? body = null, bool anonymous = false)
    {
        body = await WithProjectGroupAsync(method, url, body, anonymous);
        using var req = new HttpRequestMessage(method, url);
        req.Headers.Add("X-Token-Delivery", "body");
        if (Ip is not null) req.Headers.Add("X-Forwarded-For", Ip);
        foreach (var (k, v) in Extra) req.Headers.TryAddWithoutValidation(k, v);
        if (TeamLens is not null) req.Headers.Add("X-Team-Lens", TeamLens.ToString());
        if (Token is not null && !anonymous) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        if (body is not null) req.Content = JsonContent.Create(body);
        using var res = await Http.SendAsync(req);
        var text = await res.Content.ReadAsStringAsync();
        JsonNode? json = null;
        try { json = string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text); } catch (JsonException) { /* non-JSON */ }
        return new ApiResult(res.StatusCode, json, res.Headers.ToDictionary(h => h.Key, h => string.Join(",", h.Value), StringComparer.OrdinalIgnoreCase));
    }

    /// <summary>Uploads one file as multipart/form-data, like the browser does.</summary>
    public async Task<ApiResult> Upload(string url, string fileName, byte[] content, IDictionary<string, string>? fields = null)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, url);
        req.Headers.Add("X-Token-Delivery", "body");
        if (Token is not null) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        var form = new MultipartFormDataContent();
        var part = new ByteArrayContent(content);
        part.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        form.Add(part, "file", fileName);
        foreach (var (name, value) in fields ?? new Dictionary<string, string>()) form.Add(new StringContent(value), name);
        req.Content = form;
        using var res = await Http.SendAsync(req);
        var text = await res.Content.ReadAsStringAsync();
        JsonNode? json = null;
        try { json = string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text); } catch (JsonException) { /* non-JSON */ }
        return new ApiResult(res.StatusCode, json);
    }

    /// <summary>Raw response of an authenticated GET (for file downloads).</summary>
    public async Task<HttpResponseMessage> Raw(string url)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        if (Token is not null) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        return await Http.SendAsync(req);
    }

    public Task<ApiResult> Get(string url) => Send(HttpMethod.Get, url);
    public Task<ApiResult> Post(string url, object? body = null) => Send(HttpMethod.Post, url, body ?? new { });
    public Task<ApiResult> Put(string url, object body) => Send(HttpMethod.Put, url, body);
    public Task<ApiResult> Delete(string url) => Send(HttpMethod.Delete, url);
    public Task<ApiResult> Patch(string url, object body) => Send(HttpMethod.Patch, url, body);

    /// <summary>Registers, verifies (via the dev mailbox), signs in. Lands in the user's personal workspace.</summary>
    public static async Task<TestClient> RegisterAsync(ApiFactory factory, string? name = null, string password = "Passw0rd!x")
    {
        var c = new TestClient(factory);
        c.Email = $"user-{Guid.NewGuid():N}@example.com";
        var reg = await c.Send(HttpMethod.Post, "/api/v1/auth/register", new { email = c.Email, password, displayName = name ?? "Test User", acceptedTerms = true }, true);
        Assert.Equal(HttpStatusCode.Created, reg.Status);
        c.UserId = Guid.Parse(reg.Data!["userId"]!.GetValue<string>());
        await c.VerifyEmailAsync();
        await c.LoginAsync(password);
        return c;
    }

    public async Task VerifyEmailAsync()
    {
        var token = await MailboxToken("verify-email");
        var res = await Send(HttpMethod.Post, "/api/v1/auth/verify-email", new { token }, true);
        Assert.Equal(HttpStatusCode.NoContent, res.Status);
    }

    public async Task<ApiResult> LoginAsync(string password = "Passw0rd!x")
    {
        var res = await Send(HttpMethod.Post, "/api/v1/auth/login", new { email = Email, password }, true);
        if (res.Ok && res.Data?["accessToken"] is not null) ApplyAuth(res);
        return res;
    }

    public void ApplyAuth(ApiResult res)
    {
        Token = res.Data!["accessToken"]!.GetValue<string>();
        RefreshToken = res.Data["refreshToken"]?.GetValue<string>();
        UserId = Guid.Parse(res.Data["user"]!["id"]!.GetValue<string>());
    }

    /// <summary>Extracts the newest ?token=... link of the given kind that was emailed to this user.</summary>
    public async Task<string> MailboxToken(string linkKind)
    {
        var res = await Send(HttpMethod.Get, "/api/v1/dev/emails", null, true);
        foreach (var mail in res.Data!.AsArray())
        {
            if (!string.Equals(mail!["to"]!.GetValue<string>(), Email, StringComparison.OrdinalIgnoreCase)) continue;
            var m = Regex.Match(mail["text"]?.GetValue<string>() ?? "", $@"{linkKind}\?token=([^&\s]+)");
            if (m.Success) return Uri.UnescapeDataString(m.Groups[1].Value);
        }
        throw new InvalidOperationException($"No {linkKind} email found for {Email}");
    }

    public async Task SwitchToAsync(Guid workspaceId)
    {
        var res = await Post($"/api/v1/workspaces/{workspaceId}/switch");
        Assert.True(res.Ok, res.ToString());
        Token = res.Data!["accessToken"]!.GetValue<string>();
        WorkspaceId = workspaceId;
    }

    /// <summary>Creates an organization owned by this user and switches into it.</summary>
    public async Task<Guid> CreateOrgAsync(string? name = null)
    {
        var res = await Post("/api/v1/workspaces", new { name = name ?? $"Org {Guid.NewGuid():N}"[..14] });
        Assert.Equal(HttpStatusCode.Created, res.Status);
        var id = Guid.Parse(res.Data!["id"]!.GetValue<string>());
        await SwitchToAsync(id);
        return id;
    }

    public async Task<Guid> CreateProjectAsync(string? name = null)
    {
        var res = await Post("/api/v1/projects", new { name = name ?? $"Project {Guid.NewGuid():N}"[..16], priority = "Medium" });
        Assert.True(res.Ok, res.ToString());
        return Guid.Parse(res.Data!["project"]!["id"]!.GetValue<string>());
    }

    public async Task<JsonNode> CreateTaskAsync(Guid projectId, string title = "A task", object? extra = null)
    {
        var res = await Post($"/api/v1/projects/{projectId}/tasks", extra ?? new { title, priority = "Medium" });
        Assert.True(res.Ok, res.ToString());
        return res.Data!;
    }

    /// <summary>Pays for a plan (simulated payment). Per-person plans: <paramref name="seats"/> people (10 by default, room for the tests' invitations) billed monthly unless <paramref name="period"/> says otherwise.</summary>
    public async Task<ApiResult> UpgradeAsync(string plan, int seats = 10, string? period = null)
    {
        var res = await Post("/api/v1/billing/checkout", new { planCode = plan, startTrial = false, seats, period });
        Assert.True(res.Ok, res.ToString());
        return res;
    }

    /// <summary>Invites an email, registers that user (verified), and has them accept. Returns the new member's client.</summary>
    public async Task<TestClient> AddMemberAsync(ApiFactory factory, TenantRole role, string name = "Member")
    {
        var invitee = new TestClient(factory) { Email = $"user-{Guid.NewGuid():N}@example.com" };
        var invite = await Post("/api/v1/workspace/invitations", new { email = invitee.Email, role = role.ToString() });
        Assert.True(invite.Ok, invite.ToString());

        var reg = await invitee.Send(HttpMethod.Post, "/api/v1/auth/register", new { email = invitee.Email, password = "Passw0rd!x", displayName = name, acceptedTerms = true }, true);
        Assert.Equal(HttpStatusCode.Created, reg.Status);
        await invitee.VerifyEmailAsync();
        await invitee.LoginAsync();

        var token = await invitee.MailboxToken("invite");
        var accept = await invitee.Post("/api/v1/invitations/accept", new { token });
        Assert.True(accept.Ok, accept.ToString());
        await invitee.SwitchToAsync(WorkspaceId);
        return invitee;
    }
}

public sealed record SentWebhook(string Url, IReadOnlyDictionary<string, string> Headers, string Body);

public sealed class RecordingWebhookTransport : ProjectManagement.Application.Features.Integrations.IWebhookTransport
{
    private readonly object _lock = new();
    private readonly List<SentWebhook> _sent = [];
    /// <summary>The HTTP status to answer with, by URL (200 unless a test says otherwise; 0 means "could not connect").</summary>
    public Func<string, int> Status { get; set; } = _ => 200;

    public IReadOnlyList<SentWebhook> Sent { get { lock (_lock) return _sent.ToList(); } }
    public IReadOnlyList<SentWebhook> To(string urlPart) => Sent.Where(s => s.Url.Contains(urlPart)).ToList();

    public Task<ProjectManagement.Application.Features.Integrations.WebhookSendResult> SendAsync(string url, IReadOnlyDictionary<string, string> headers, string body, CancellationToken ct)
    {
        lock (_lock) _sent.Add(new SentWebhook(url, headers, body));
        var status = Status(url);
        return Task.FromResult(status == 0
            ? new ProjectManagement.Application.Features.Integrations.WebhookSendResult(null, "Could not connect to the receiver.", null)
            : new ProjectManagement.Application.Features.Integrations.WebhookSendResult(status, null, status >= 400 ? "error" : "ok"));
    }
}

public sealed class LogSink : ILoggerProvider
{
    private readonly System.Collections.Concurrent.ConcurrentQueue<string> _lines = new();
    public IReadOnlyCollection<string> Lines => _lines.ToArray();
    public ILogger CreateLogger(string categoryName) => new Sink(_lines, categoryName);
    public void Dispose() { }

    private sealed class Sink(System.Collections.Concurrent.ConcurrentQueue<string> lines, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            lines.Enqueue($"{category}: {formatter(state, exception)} {exception}");
    }
}
