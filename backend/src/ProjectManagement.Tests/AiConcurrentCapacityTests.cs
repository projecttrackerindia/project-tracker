using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

public sealed partial class AiMessageSendingTests
{
    [Fact]
    public Task Lean_project_status_preserves_task_progress_and_workspace_isolation() => Run(async (owner, _) =>
    {
        var project = await owner.CreateProjectAsync("Lean Status Project");
        await owner.CreateTaskAsync(project, "Finished task");
        await owner.CreateTaskAsync(project, "Open task");
        factory.WithDb(db =>
        {
            var done = db.WorkflowStatuses.IgnoreQueryFilters().First(s => s.ProjectId == project && s.Category == StatusCategory.Done);
            db.Tasks.IgnoreQueryFilters().Single(t => t.ProjectId == project && t.Title == "Finished task").StatusId = done.Id;
            db.SaveChanges(); return 0;
        });
        var detail = (await owner.Get($"/api/v1/projects/{project}")).Data!["project"]!;
        Assert.Equal(50, detail["progress"]!.GetValue<int>());
        var answer = await Ask(owner, $"What is the status of project {project}?");
        Assert.Contains("Progress: 50%", answer["content"]!.GetValue<string>());
        var outsider = await TestClient.RegisterAsync(factory); await outsider.CreateOrgAsync(); await outsider.UpgradeAsync("BUSINESS");
        var denied = await Ask(outsider, $"What is the status of project {project}?");
        Assert.DoesNotContain("Lean Status Project", denied["content"]!.GetValue<string>());
        Assert.DoesNotContain("Progress:", denied["content"]!.GetValue<string>());
        Assert.Empty(factory.Chat.Requests);
    });

    [Fact]
    public Task Hundred_distinct_users_can_complete_simultaneous_application_agent_requests() => Run(async (owner, member) =>
    {
        var project = await owner.CreateProjectAsync("Capacity Project");
        var clients = new List<TestClient> { owner, member };
        using var scope = factory.Services.CreateScope();
        var tokens = scope.ServiceProvider.GetRequiredService<ITokenService>();
        // Only fixture setup is seeded. Requests use real JWT/session/membership validation and application persistence.
        factory.WithDb(db =>
        {
            for (var i = 2; i < 100; i++)
            {
                var user = new User { Email = $"capacity-{Guid.NewGuid():N}@example.com", DisplayName = $"Capacity user {i}", EmailVerified = true };
                user.NormalizedEmail = user.Email.ToUpperInvariant();
                var session = new UserSession { UserId = user.Id, WorkspaceId = owner.WorkspaceId, CreatedAt = DateTime.UtcNow, ExpiresAt = DateTime.UtcNow.AddHours(1) };
                db.Users.Add(user); db.UserSessions.Add(session);
                db.TenantMembers.Add(new TenantMember { TenantId = owner.WorkspaceId, UserId = user.Id, Role = TenantRole.Member });
                clients.Add(new TestClient(factory) { UserId = user.Id, WorkspaceId = owner.WorkspaceId, Token = tokens.CreateAccessToken(user, session.Id, owner.WorkspaceId).Token });
            }
            db.SaveChanges(); return 0;
        });
        factory.Chat.Fail = new InvalidOperationException("Application requests must not occupy inference capacity");
        var reports = new List<object>();
        foreach (var prompt in new[] { "Hello", $"What is the status of project {project}?" })
        {
            var start = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            using var process = Process.GetCurrentProcess();
            var cpu = process.TotalProcessorTime;
            long peakMemory = process.WorkingSet64;
            using var monitoring = new CancellationTokenSource();
            var sampler = Task.Run(async () =>
            {
                while (!monitoring.IsCancellationRequested)
                {
                    process.Refresh(); peakMemory = Math.Max(peakMemory, process.WorkingSet64);
                    try { await Task.Delay(10, monitoring.Token); } catch (OperationCanceledException) { break; }
                }
            });
            var pending = clients.Select(async client =>
            {
                await start.Task;
                var timer = Stopwatch.StartNew();
                using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/ai/ask")
                { Content = JsonContent.Create(new { text = prompt, timeZone = "Asia/Kolkata" }) };
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", client.Token);
                using var response = await client.Http.SendAsync(request);
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
                var body = await response.Content.ReadAsStringAsync();
                var blocks = body.Split("\n\n").Where(b => b.StartsWith("event: done\n")).ToArray();
                Assert.True(blocks.Length == 1, "Incomplete synthetic load-test stream: " + body + "\nServer failures: "
                    + string.Join("\n", factory.Logs.Lines.Where(l => l.Contains("Exception") || l.Contains("failed", StringComparison.OrdinalIgnoreCase)).TakeLast(3)));
                var answer = JsonNode.Parse(blocks[0].Split('\n')[1][6..])!["message"]!;
                return (client.UserId, Answer: answer, DurationMs: timer.Elapsed.TotalMilliseconds);
            }).ToArray();
            var elapsed = Stopwatch.StartNew(); start.SetResult();
            (Guid UserId, JsonNode Answer, double DurationMs)[] results;
            try { results = await Task.WhenAll(pending); }
            finally { elapsed.Stop(); monitoring.Cancel(); await sampler; }
            var durations = results.Select(r => r.DurationMs).Order().ToArray();
            var ids = results.Select(r => Guid.Parse(r.Answer["id"]!.GetValue<string>())).ToArray();
            var saved = factory.WithDb(db => db.AiMessages.IgnoreQueryFilters().AsNoTracking().Where(m => ids.Contains(m.Id)).ToList());
            Assert.Equal(100, saved.Count);
            foreach (var result in results)
            {
                Assert.Equal("complete", result.Answer["status"]!.GetValue<string>());
                Assert.Equal(0, result.Answer["credits"]!.GetValue<int>());
                Assert.Empty(result.Answer["actions"]!.AsArray());
                Assert.Equal(result.UserId, saved.Single(m => m.Id.ToString() == result.Answer["id"]!.GetValue<string>()).UserId);
                if (prompt != "Hello") Assert.Contains("Capacity Project", result.Answer["content"]!.GetValue<string>());
            }
            var traces = saved.Select(m => JsonSerializer.Deserialize<AiExecutionTrace>(m.ExecutionJson!, new JsonSerializerOptions(JsonSerializerDefaults.Web))!).ToArray();
            reports.Add(new { path = prompt == "Hello" ? "greeting" : "project_status", users = 100, succeeded = 100, elapsedMs = elapsed.Elapsed.TotalMilliseconds,
                p50Ms = durations[49], p95Ms = durations[94], p99Ms = durations[98], cpuSeconds = (process.TotalProcessorTime - cpu).TotalSeconds,
                peakProcessMemoryMb = peakMemory / 1024d / 1024, averageDatabaseCommands = traces.Average(t => t.Database!.Commands), modelCalls = traces.Sum(t => t.Models.Count) });
        }
        Assert.Empty(factory.Chat.Requests);
        var report = JsonSerializer.Serialize(new { scope = "100 distinct users; in-process API; fixture database; no real inference; host process CPU/RAM includes test infrastructure", reports });
        Console.WriteLine("AGENT_LOAD " + report);
        if (Environment.GetEnvironmentVariable("PM_AGENT_LOAD_REPORT") is { Length: > 0 } path) await File.WriteAllTextAsync(path, report);
        foreach (var client in clients.Skip(2)) client.Http.Dispose();
    });
}
