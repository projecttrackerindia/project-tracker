using System.Net;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// "Sign out after inactivity": a session nobody really used for longer than its workspace allows is locked (refresh and every API answer
/// SESSION_IDLE_LOCKED) until the person unlocks it with their password or a passkey; the app's activity ping keeps it open; five wrong tries
/// sign it out; owners and admins choose the time per workspace, and "Never" turns it off. Fictional people only.
/// </summary>
[Collection("api")]
public class IdleLockTests(ApiFactory factory)
{
    private const string Password = "Passw0rd!xKey";

    /// <summary>Pretends the person last used the app <paramref name="minutes"/> ago (every session of theirs).</summary>
    private void AwayFor(TestClient c, int minutes) => factory.WithDb(db =>
    {
        foreach (var s in db.UserSessions.Where(s => s.UserId == c.UserId)) s.LastActivityAt = DateTime.UtcNow.AddMinutes(-minutes);
        return db.SaveChanges();
    });

    private static Task<ApiResult> Refresh(TestClient c) => c.Send(HttpMethod.Post, "/api/v1/auth/refresh", new { refreshToken = c.RefreshToken }, true);
    private static Task<ApiResult> Unlock(TestClient c, object body) => c.Send(HttpMethod.Post, "/api/v1/auth/unlock", body, true);

    [Fact]
    public async Task Idle_beyond_the_default_policy_locks_refresh_and_every_api_until_the_password_unlocks_it()
    {
        var c = await TestClient.RegisterAsync(factory, "Ida Idle");
        Assert.True((await c.Get("/api/v1/me")).Ok);
        Assert.Equal(30, (await c.Get("/api/v1/workspace/idle-policy")).Data!["minutes"]!.GetValue<int>());

        AwayFor(c, 31);
        var api = await c.Get("/api/v1/me");
        Assert.Equal(HttpStatusCode.Unauthorized, api.Status);
        Assert.Equal("SESSION_IDLE_LOCKED", api.ErrorCode);
        var refresh = await Refresh(c);
        Assert.Equal(HttpStatusCode.Unauthorized, refresh.Status);
        Assert.Equal("SESSION_IDLE_LOCKED", refresh.ErrorCode);
        Assert.True(factory.WithDb(db => db.UserSessions.Single(s => s.UserId == c.UserId).LockedAt) is not null);
        Assert.True(factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Any(a => a.Action == "session.auto_locked" && a.UserId == c.UserId)));
        // The activity ping cannot reopen it: only unlocking can.
        Assert.Equal("SESSION_IDLE_LOCKED", (await c.Post("/api/v1/auth/activity")).ErrorCode);
        Assert.Equal("SESSION_IDLE_LOCKED", (await Refresh(c)).ErrorCode);

        var state = await c.Send(HttpMethod.Post, "/api/v1/auth/unlock/state", new { refreshToken = c.RefreshToken }, true);
        Assert.True(state.Ok, state.ToString());
        Assert.True(state.Data!["locked"]!.GetValue<bool>());
        Assert.True(state.Data["hasPassword"]!.GetValue<bool>());
        Assert.False(state.Data["hasPasskey"]!.GetValue<bool>());
        Assert.Equal(5, state.Data["attemptsLeft"]!.GetValue<int>());

        var wrong = await Unlock(c, new { password = "not-the-password", refreshToken = c.RefreshToken });
        Assert.Equal(HttpStatusCode.Unauthorized, wrong.Status);
        Assert.Equal("UNLOCK_FAILED", wrong.ErrorCode);

        var unlocked = await Unlock(c, new { password = Password, refreshToken = c.RefreshToken });
        Assert.True(unlocked.Ok, unlocked.ToString());
        c.ApplyAuth(unlocked);
        Assert.NotNull(c.RefreshToken);
        Assert.True((await c.Get("/api/v1/me")).Ok);
        var again = await Refresh(c);
        Assert.True(again.Ok, again.ToString());
        Assert.True(factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Any(a => a.Action == "session.unlocked" && a.UserId == c.UserId)));
    }

    [Fact]
    public async Task The_activity_ping_keeps_the_session_open()
    {
        var c = await TestClient.RegisterAsync(factory, "Pim Ping");
        AwayFor(c, 25);
        var ping = await c.Post("/api/v1/auth/activity");
        Assert.True(ping.Ok, ping.ToString());
        Assert.Equal(30, ping.Data!["minutes"]!.GetValue<int>());
        var last = factory.WithDb(db => db.UserSessions.Single(s => s.UserId == c.UserId).LastActivityAt);
        Assert.True(last > DateTime.UtcNow.AddMinutes(-1));
        // Ten more minutes later (35 since the time before the ping) it is still open: the ping moved the clock.
        factory.WithDb(db => { foreach (var s in db.UserSessions.Where(s => s.UserId == c.UserId)) s.LastActivityAt = s.LastActivityAt!.Value.AddMinutes(-10); return db.SaveChanges(); });
        Assert.True((await Refresh(c)).Ok);
    }

    [Fact]
    public async Task Locking_now_refuses_apis_and_five_wrong_unlocks_sign_the_session_out()
    {
        var c = await TestClient.RegisterAsync(factory, "Lou Lock");
        Assert.Equal(HttpStatusCode.NoContent, (await c.Post("/api/v1/auth/lock")).Status);
        Assert.Equal("SESSION_IDLE_LOCKED", (await c.Get("/api/v1/me")).ErrorCode);

        for (var i = 1; i <= 4; i++)
        {
            var wrong = await Unlock(c, new { password = $"wrong-{i}", refreshToken = c.RefreshToken });
            Assert.Equal("UNLOCK_FAILED", wrong.ErrorCode);
        }
        var fifth = await Unlock(c, new { password = "wrong-5", refreshToken = c.RefreshToken });
        Assert.Equal(HttpStatusCode.Unauthorized, fifth.Status);
        Assert.Equal("SESSION_UNLOCK_SIGNED_OUT", fifth.ErrorCode);
        // Now even the right password is too late: the session is over.
        Assert.False((await Unlock(c, new { password = Password, refreshToken = c.RefreshToken })).Ok);
        Assert.False((await Refresh(c)).Ok);
        Assert.True(factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Any(a => a.Action == "session.unlock_signed_out" && a.UserId == c.UserId)));
    }

    [Fact]
    public async Task A_passkey_unlock_needs_a_passkey_of_ones_own_and_a_bad_answer_counts_as_a_wrong_try()
    {
        var c = await TestClient.RegisterAsync(factory, "Pat Passkey");
        await c.Post("/api/v1/auth/lock");
        var options = await c.Send(HttpMethod.Post, "/api/v1/auth/unlock/passkey-options", new { refreshToken = c.RefreshToken }, true);
        Assert.Equal(HttpStatusCode.Conflict, options.Status);
        Assert.Equal("NO_PASSKEY", options.ErrorCode);
        // A made-up challenge is refused without unlocking anything.
        var bogus = await Unlock(c, new { challengeId = Guid.NewGuid(), response = new { id = "x", rawId = "eA", type = "public-key", response = new { } }, refreshToken = c.RefreshToken });
        Assert.False(bogus.Ok);
        Assert.Equal("SESSION_IDLE_LOCKED", (await c.Get("/api/v1/me")).ErrorCode);
    }

    [Fact]
    public async Task Owners_choose_the_time_per_workspace_members_cannot_and_never_turns_it_off()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olga Owner");
        var orgA = await owner.CreateOrgAsync();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mo Member");

        var denied = await member.Put("/api/v1/workspace/idle-policy", new { minutes = 0 });
        Assert.Equal(HttpStatusCode.Forbidden, denied.Status);
        Assert.False((await member.Get("/api/v1/workspace/idle-policy")).Data!["canManage"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put("/api/v1/workspace/idle-policy", new { minutes = 45 })).Status);

        var set = await owner.Put("/api/v1/workspace/idle-policy", new { minutes = 15 });
        Assert.True(set.Ok, set.ToString());
        Assert.Equal(15, set.Data!["minutes"]!.GetValue<int>());
        Assert.True(factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Any(a => a.Action == "org.idle_timeout_changed" && a.TenantId == orgA)));

        // Tenant isolation: the member's other workspace (their personal one) keeps its own 30 minutes.
        var other = await TestClient.RegisterAsync(factory, "Nia Neighbour");
        AwayFor(member, 20); AwayFor(other, 20);
        Assert.Equal("SESSION_IDLE_LOCKED", (await Refresh(member)).ErrorCode);   // 20 > 15 in org A
        Assert.True((await Refresh(other)).Ok);                                   // 20 < 30 in a workspace of its own
        Assert.Equal(30, (await other.Get("/api/v1/workspace/idle-policy")).Data!["minutes"]!.GetValue<int>());

        // Never: hours away and still signed in.
        Assert.True((await owner.Put("/api/v1/workspace/idle-policy", new { minutes = 0 })).Ok);
        AwayFor(owner, 600);
        Assert.True((await owner.Get("/api/v1/me")).Ok);
        Assert.True((await Refresh(owner)).Ok);
    }

    [Fact]
    public async Task Sign_out_everywhere_spends_every_refresh_token()
    {
        var c = await TestClient.RegisterAsync(factory, "Eve Everywhere");
        var laptop = c.RefreshToken;
        var phone = new TestClient(factory) { Email = c.Email };
        await phone.LoginAsync(Password);
        Assert.Equal(HttpStatusCode.NoContent, (await c.Post("/api/v1/auth/logout-all")).Status);
        Assert.False((await c.Send(HttpMethod.Post, "/api/v1/auth/refresh", new { refreshToken = laptop }, true)).Ok);
        Assert.False((await Refresh(phone)).Ok);
        Assert.Equal(0, factory.WithDb(db => db.RefreshTokens.Count(t => t.UserId == c.UserId && t.UsedAt == null)));
    }
}
