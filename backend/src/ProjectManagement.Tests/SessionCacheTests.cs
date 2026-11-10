using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Persistence;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Who a session belongs to and what the person may do in the workspace are remembered for a few seconds, so most requests skip those lookups.
/// Access must never outlive a change: each test makes the cache warm with a request, changes something that matters, and expects the very next
/// request to be answered by the new state, not the remembered one.
/// </summary>
[Collection("api")]
public class SessionCacheTests(ApiFactory factory)
{
    private async Task<TestClient> Owner()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        await c.UpgradeAsync("PRO");
        return c;
    }

    [Fact]
    public async Task Signing_out_ends_the_session_on_the_very_next_request()
    {
        var c = await TestClient.RegisterAsync(factory, "Sam Signout");
        Assert.True((await c.Get("/api/v1/me")).Ok);
        Assert.True((await c.Get("/api/v1/me")).Ok);          // warm
        Assert.Equal(HttpStatusCode.NoContent, (await c.Post("/api/v1/auth/logout")).Status);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.Get("/api/v1/me")).Status);
    }

    [Fact]
    public async Task A_new_role_applies_on_the_very_next_request()
    {
        var owner = await Owner();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Role Change");
        Assert.False((await member.Get("/api/v1/workspace/idle-policy")).Data!["canManage"]!.GetValue<bool>());
        Assert.False((await member.Get("/api/v1/workspace/idle-policy")).Data!["canManage"]!.GetValue<bool>());   // warm
        Assert.True((await owner.Put($"/api/v1/workspace/members/{member.UserId}", new { role = "Admin" })).Ok);
        Assert.True((await member.Get("/api/v1/workspace/idle-policy")).Data!["canManage"]!.GetValue<bool>());
        Assert.True((await owner.Put($"/api/v1/workspace/members/{member.UserId}", new { role = "Member" })).Ok);
        Assert.False((await member.Get("/api/v1/workspace/idle-policy")).Data!["canManage"]!.GetValue<bool>());
    }

    [Fact]
    public async Task A_removed_member_is_refused_on_the_very_next_request()
    {
        var owner = await Owner();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Removed Rina");
        Assert.True((await member.Get("/api/v1/projects")).Ok);
        Assert.True((await member.Get("/api/v1/projects")).Ok);   // warm
        Assert.True((await owner.Delete($"/api/v1/workspace/members/{member.UserId}")).Ok);
        Assert.False((await member.Get("/api/v1/projects")).Ok);
    }

    [Fact]
    public async Task A_suspended_member_is_refused_on_the_very_next_request()
    {
        var owner = await Owner();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Suspended Sid");
        Assert.True((await member.Get("/api/v1/projects")).Ok);
        Assert.True((await member.Get("/api/v1/projects")).Ok);   // warm
        Assert.True((await owner.Post($"/api/v1/workspace/members/{member.UserId}/suspend")).Ok);
        Assert.False((await member.Get("/api/v1/projects")).Ok);
    }

    [Fact]
    public async Task A_shorter_idle_policy_locks_a_session_that_was_fine_a_moment_ago()
    {
        var owner = await Owner();
        // Away for 20 minutes: inside the default 30, outside a new 15.
        factory.WithDb(db => { foreach (var s in db.UserSessions.Where(s => s.UserId == owner.UserId)) s.LastActivityAt = DateTime.UtcNow.AddMinutes(-20); return db.SaveChanges(); });
        Assert.True((await owner.Get("/api/v1/me")).Ok);
        Assert.True((await owner.Get("/api/v1/me")).Ok);          // warm
        Assert.True((await owner.Put("/api/v1/workspace/idle-policy", new { minutes = 15 })).Ok);
        var locked = await owner.Get("/api/v1/me");
        Assert.Equal(HttpStatusCode.Unauthorized, locked.Status);
        Assert.Equal("SESSION_IDLE_LOCKED", locked.ErrorCode);
    }

    [Fact]
    public async Task Remembered_answers_are_served_until_something_that_matters_changes()
    {
        var c = await TestClient.RegisterAsync(factory, "Cora Cached");
        var cache = factory.Services.GetRequiredService<SessionCache>();
        var sessionId = factory.WithDb(db => db.UserSessions.Single(s => s.UserId == c.UserId).Id);

        async Task<CachedSession> Read()
        {
            using var scope = factory.Services.CreateScope();
            return (await cache.SessionAsync(scope.ServiceProvider.GetRequiredService<AppDbContext>(), sessionId, c.UserId, default))!;
        }
        async Task Change(Action<AppDbContext> edit)
        {
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            edit(db);
            await db.SaveChangesAsync();
        }

        var first = await Read();
        Assert.Null(first.RevokedAt);

        // Bookkeeping that happens all the time (last seen) must not empty the cache: the remembered copy is still served.
        await Change(db => db.UserSessions.Single(s => s.Id == sessionId).LastSeenAt = first.LastSeenAt.AddMinutes(5));
        Assert.Equal(first.LastSeenAt, (await Read()).LastSeenAt);

        // Ending the session empties it at once.
        await Change(db => db.UserSessions.Single(s => s.Id == sessionId).RevokedAt = DateTime.UtcNow);
        Assert.NotNull((await Read()).RevokedAt);

        // A deactivated person too.
        await Change(db => db.Users.Single(u => u.Id == c.UserId).IsActive = false);
        Assert.False((await Read()).IsActive);
    }
}
