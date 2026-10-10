using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Api.Middleware;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Infrastructure.Persistence;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public class IdempotencyTransactionTests(ApiFactory factory)
{
    private async Task<DefaultHttpContext> Invoke(Guid user, string key, RequestDelegate action, TimeProvider? clock = null,
        SaveChangesInterceptor? interceptor = null, Guid? tenant = null, string body = "{}", string contentType = "application/json")
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var context = scope.ServiceProvider.GetRequiredService<CurrentContext>();
        context.UserId = user; context.TenantId = tenant;
        var original = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        await using var custom = interceptor is null ? null : new AppDbContext(
            new DbContextOptionsBuilder<AppDbContext>(scope.ServiceProvider.GetRequiredService<DbContextOptions<AppDbContext>>())
                .AddInterceptors(interceptor).Options, context, TimeProvider.System);
        var db = custom ?? original;
        var http = new DefaultHttpContext { RequestServices = scope.ServiceProvider };
        http.Items["db"] = db;
        http.Request.Method = "POST"; http.Request.Path = "/test/atomic";
        http.Request.Headers[IdempotencyMiddleware.Header] = key;
        http.Request.ContentType = contentType;
        http.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(body));
        http.Response.Body = new MemoryStream();
        await new IdempotencyMiddleware(action).InvokeAsync(http, context, db, clock ?? TimeProvider.System);
        return http;
    }

    private static AppDbContext Db(HttpContext http) => (AppDbContext)http.Items["db"]!;
    private static string Body(DefaultHttpContext http) => Encoding.UTF8.GetString(((MemoryStream)http.Response.Body).ToArray());

    [Fact]
    public async Task A_failure_after_saving_business_data_rolls_back_both_the_write_and_receipt()
    {
        var user = (await TestClient.RegisterAsync(factory)).UserId;
        var key = $"rollback-{Guid.NewGuid():N}";
        await Assert.ThrowsAsync<InvalidOperationException>(() => Invoke(user, key, async http =>
        {
            Db(http).PlatformSettings.Add(new PlatformSetting { Key = key, Value = "uncommitted" });
            await Db(http).SaveChangesAsync();
            // A different connection cannot observe either half of an unfinished request.
            Assert.False(factory.WithDb(db => db.PlatformSettings.Any(s => s.Key == key)));
            Assert.False(factory.WithDb(db => db.IdempotencyRecords.Any(r => r.Key == key)));
            throw new InvalidOperationException("Simulated process failure after a business save");
        }));
        Assert.False(factory.WithDb(db => db.PlatformSettings.Any(s => s.Key == key)));
        Assert.False(factory.WithDb(db => db.IdempotencyRecords.Any(r => r.Key == key)));
        var executions = 0;
        RequestDelegate retry = async http =>
        {
            executions++;
            // A service must join the request transaction rather than begin a nested one.
            await using var owned = await Db(http).Database.BeginOwnedTransactionAsync();
            Assert.Null(owned);
            Db(http).PlatformSettings.Add(new PlatformSetting { Key = key, Value = "committed" });
            await Db(http).SaveChangesAsync();
            await owned.CommitIfOwnedAsync();
            await http.Response.WriteAsync("Saved ✓");
        };
        var first = await Invoke(user, key, retry);
        var replay = await Invoke(user, key, retry);
        Assert.Equal(1, executions);
        Assert.Equal(Body(first), Body(replay));
        Assert.Equal("true", replay.Response.Headers["Idempotent-Replayed"].ToString());
        Assert.True(factory.WithDb(db => db.IdempotencyRecords.Single(r => r.Key == key).Completed));
    }

    private sealed class FailReceipt : SaveChangesInterceptor
    {
        public override ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData eventData,
            InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (eventData.Context!.ChangeTracker.Entries<IdempotencyRecord>().Any(e => e.Entity.Completed))
                throw new InvalidOperationException("Receipt persistence failed");
            return ValueTask.FromResult(result);
        }
    }

    [Fact]
    public async Task Failure_to_persist_the_response_cannot_leave_a_committed_write()
    {
        var user = (await TestClient.RegisterAsync(factory)).UserId;
        var key = $"receipt-{Guid.NewGuid():N}";
        await Assert.ThrowsAsync<InvalidOperationException>(() => Invoke(user, key, async http =>
        {
            Db(http).PlatformSettings.Add(new PlatformSetting { Key = key, Value = "saved before response" });
            await Db(http).SaveChangesAsync();
            await http.Response.WriteAsync("Success");
        }, interceptor: new FailReceipt()));
        Assert.False(factory.WithDb(db => db.PlatformSettings.Any(s => s.Key == key)));
        Assert.False(factory.WithDb(db => db.IdempotencyRecords.Any(r => r.Key == key)));
    }

    [Fact]
    public async Task An_error_response_rolls_back_earlier_saves_and_allows_a_corrected_retry()
    {
        var user = (await TestClient.RegisterAsync(factory)).UserId;
        var key = $"refused-{Guid.NewGuid():N}";
        var response = await Invoke(user, key, async http =>
        {
            Db(http).PlatformSettings.Add(new PlatformSetting { Key = key, Value = "partial" });
            await Db(http).SaveChangesAsync();
            http.Response.StatusCode = 422;
            await http.Response.WriteAsync("Refused");
        });
        Assert.Equal(422, response.Response.StatusCode);
        Assert.False(factory.WithDb(db => db.PlatformSettings.Any(s => s.Key == key)));
        Assert.False(factory.WithDb(db => db.IdempotencyRecords.Any(r => r.Key == key)));
        Assert.Equal(200, (await Invoke(user, key, http => http.Response.WriteAsync("Corrected"), body: "{\"corrected\":true}")).Response.StatusCode);
    }

    private sealed class FixedClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Live_changes_are_announced_only_after_commit(bool succeeds)
    {
        var client = await TestClient.RegisterAsync(factory);
        await client.CreateOrgAsync();
        var activity = Guid.NewGuid();
        var key = $"effects-{Guid.NewGuid():N}";
        var response = await Invoke(client.UserId, key, async http =>
        {
            Db(http).Activities.Add(new Activity { Id = activity, TenantId = client.WorkspaceId,
                ActorId = client.UserId, Action = "atomic_test", EntityType = "Test", EntityId = activity });
            await Db(http).SaveChangesAsync();
            Assert.DoesNotContain(factory.Changes.Published, e => e.EntityId == activity);
            http.Response.StatusCode = succeeds ? 200 : 422;
            await http.Response.WriteAsync("Result");
        }, tenant: client.WorkspaceId);
        Assert.Equal(succeeds ? 200 : 422, response.Response.StatusCode);
        Assert.Equal(succeeds, factory.Changes.Published.Any(e => e.EntityId == activity));
        Assert.Equal(succeeds, factory.WithDb(db => db.Activities.IgnoreQueryFilters().Any(a => a.Id == activity)));
    }

    [Fact]
    public async Task A_concurrent_retry_cannot_take_over_a_request_older_than_sixty_seconds()
    {
        var user = (await TestClient.RegisterAsync(factory)).UserId;
        var key = $"concurrent-{Guid.NewGuid():N}";
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var retried = 0;
        var first = Task.Run(() => Invoke(user, key, async http =>
        {
            Db(http).PlatformSettings.Add(new PlatformSetting { Key = key, Value = "once" });
            await Db(http).SaveChangesAsync();
            started.SetResult();
            await release.Task.WaitAsync(TimeSpan.FromSeconds(15));
            await http.Response.WriteAsync("Once");
        }, new FixedClock(DateTimeOffset.UtcNow.AddMinutes(-2))));
        await started.Task.WaitAsync(TimeSpan.FromSeconds(15));
        var duplicate = Task.Run(() => Invoke(user, key, http =>
        {
            Interlocked.Increment(ref retried);
            return http.Response.WriteAsync("Duplicate");
        }));
        try
        {
            var result = await duplicate.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(409, result.Response.StatusCode);
            Assert.Contains("IDEMPOTENCY_IN_PROGRESS", Body(result));
            Assert.Equal(0, Volatile.Read(ref retried));
        }
        finally { release.TrySetResult(); }
        await first.WaitAsync(TimeSpan.FromSeconds(15));
        Assert.Equal(0, retried);
        Assert.Equal(1, factory.WithDb(db => db.PlatformSettings.Count(s => s.Key == key)));
    }

    [Fact]
    public async Task A_large_response_keeps_a_receipt_so_a_retry_cannot_repeat_the_write()
    {
        var user = (await TestClient.RegisterAsync(factory)).UserId;
        var key = $"large-{Guid.NewGuid():N}";
        var executions = 0;
        RequestDelegate action = http => { executions++; return http.Response.WriteAsync(new string('x', 300_000)); };
        Assert.Equal(200, (await Invoke(user, key, action)).Response.StatusCode);
        var retry = await Invoke(user, key, action);
        Assert.Equal(409, retry.Response.StatusCode);
        Assert.Contains("IDEMPOTENCY_RESPONSE_UNAVAILABLE", Body(retry));
        Assert.Equal(1, executions);
    }

    [Fact]
    public async Task Old_unfinished_receipts_are_not_discarded_and_workspace_changes_are_not_replayed()
    {
        var user = (await TestClient.RegisterAsync(factory)).UserId;
        var key = $"legacy-{Guid.NewGuid():N}";
        await Invoke(user, key, http => http.Response.WriteAsync("Original"));
        factory.WithDb(db => db.IdempotencyRecords.Where(r => r.Key == key).ExecuteUpdate(s =>
            s.SetProperty(r => r.Completed, false).SetProperty(r => r.CreatedAt, DateTime.UtcNow.AddDays(-2))));
        var legacy = await Invoke(user, key, _ => throw new InvalidOperationException("Must not execute"));
        Assert.Equal(409, legacy.Response.StatusCode);
        var otherWorkspace = await Invoke(user, key, _ => throw new InvalidOperationException("Must not execute"), tenant: Guid.NewGuid());
        Assert.Equal(422, otherWorkspace.Response.StatusCode);
    }

    [Theory]
    [InlineData("multipart/form-data", "small", 422)]
    [InlineData("application/json", "large", 413)]
    public async Task Unsupported_requests_are_refused_before_the_operation_runs(string contentType, string size, int status)
    {
        var response = await Invoke(Guid.NewGuid(), $"unsupported-{Guid.NewGuid():N}", _ => throw new InvalidOperationException("Must not execute"),
            body: size == "large" ? new string('x', 1_000_001) : "{}", contentType: contentType);
        Assert.Equal(status, response.Response.StatusCode);
    }
}
