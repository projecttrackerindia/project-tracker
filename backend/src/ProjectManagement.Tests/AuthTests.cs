using System.Net;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public class AuthTests(ApiFactory factory)
{
    [Fact]
    public async Task Login_is_blocked_until_email_is_verified()
    {
        var c = new TestClient(factory) { Email = $"u-{Guid.NewGuid():N}@example.com" };
        var reg = await c.Send(HttpMethod.Post, "/api/v1/auth/register", new { email = c.Email, password = "Passw0rd!x", displayName = "Al", acceptedTerms = true }, true);
        Assert.Equal(HttpStatusCode.Created, reg.Status);

        var blocked = await c.LoginAsync();
        Assert.Equal(HttpStatusCode.Forbidden, blocked.Status);
        Assert.Equal("EMAIL_NOT_VERIFIED", blocked.ErrorCode);

        await c.VerifyEmailAsync();
        Assert.True((await c.LoginAsync()).Ok);
    }

    [Fact]
    public async Task Register_rejects_weak_passwords_and_duplicate_emails()
    {
        var c = new TestClient(factory);
        var weak = await c.Send(HttpMethod.Post, "/api/v1/auth/register", new { email = "weak@example.com", password = "short", displayName = "W", acceptedTerms = true }, true);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, weak.Status);
        Assert.Equal("password", weak.Json!["errors"]![0]!["field"]!.GetValue<string>());

        var first = await TestClient.RegisterAsync(factory);
        var dup = await c.Send(HttpMethod.Post, "/api/v1/auth/register", new { email = first.Email.ToUpperInvariant(), password = "Passw0rd!x", displayName = "Dup", acceptedTerms = true }, true);
        Assert.Equal(HttpStatusCode.Conflict, dup.Status);
        Assert.Equal("EMAIL_TAKEN", dup.ErrorCode);
    }

    [Fact]
    public async Task Wrong_password_is_rejected_and_repeated_failures_lock_the_account()
    {
        var c = await TestClient.RegisterAsync(factory);
        for (var i = 0; i < 5; i++)
        {
            var bad = await c.LoginAsync("wrong-password-1");
            Assert.Equal(HttpStatusCode.Unauthorized, bad.Status);
        }
        // While locked, a wrong guess gets the same answer as any wrong password: a stranger learns nothing and cannot extend the lock.
        var guess = await c.LoginAsync("wrong-password-1");
        Assert.Equal(HttpStatusCode.Unauthorized, guess.Status);
        Assert.Equal("INVALID_CREDENTIALS", guess.ErrorCode);
        var locked = await c.LoginAsync(); // correct password, but the account is now locked
        Assert.Equal(HttpStatusCode.TooManyRequests, locked.Status);
        Assert.Equal("ACCOUNT_LOCKED", locked.ErrorCode);
    }

    [Fact]
    public async Task Wrong_current_passwords_when_changing_it_count_towards_the_lockout()
    {
        var c = await TestClient.RegisterAsync(factory);
        for (var i = 0; i < 5; i++)
            Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post("/api/v1/me/password", new { currentPassword = "wrong-password-1", newPassword = "N3w#Passw0rd!x" })).Status);
        var locked = await c.Post("/api/v1/me/password", new { currentPassword = "Passw0rd!x", newPassword = "N3w#Passw0rd!x" });
        Assert.Equal(HttpStatusCode.TooManyRequests, locked.Status);
        Assert.Equal("ACCOUNT_LOCKED", locked.ErrorCode);
    }

    [Fact]
    public async Task Unauthenticated_requests_get_a_401_envelope()
    {
        var c = new TestClient(factory);
        var res = await c.Get("/api/v1/me");
        Assert.Equal(HttpStatusCode.Unauthorized, res.Status);
        Assert.False(res.Json!["success"]!.GetValue<bool>());
        Assert.NotNull(res.Json["traceId"]);
    }

    [Fact]
    public async Task Refresh_rotates_tokens_and_a_reused_token_revokes_the_session()
    {
        var c = await TestClient.RegisterAsync(factory);
        var first = c.RefreshToken!;

        var rotated = await c.Send(HttpMethod.Post, "/api/v1/auth/refresh", new { refreshToken = first }, true);
        Assert.True(rotated.Ok, rotated.ToString());
        var second = rotated.Data!["refreshToken"]!.GetValue<string>();
        Assert.NotEqual(first, second);

        // Present the OLD token again after the reuse grace window -> theft signal -> whole session revoked.
        factory.WithDb(db =>
        {
            foreach (var t in db.RefreshTokens.Where(t => t.UsedAt != null && t.UserId == c.UserId)) t.UsedAt = DateTime.UtcNow.AddMinutes(-5);
            db.SaveChanges();
            return 0;
        });
        var reuse = await c.Send(HttpMethod.Post, "/api/v1/auth/refresh", new { refreshToken = first }, true);
        Assert.Equal(HttpStatusCode.Unauthorized, reuse.Status);

        var afterwards = await c.Send(HttpMethod.Post, "/api/v1/auth/refresh", new { refreshToken = second }, true);
        Assert.Equal(HttpStatusCode.Unauthorized, afterwards.Status); // the legitimate token died with the session
    }

    [Fact]
    public async Task A_second_tab_refreshing_with_the_same_token_within_the_grace_window_gets_an_access_token_and_a_token_of_its_own()
    {
        var c = await TestClient.RegisterAsync(factory);
        var first = c.RefreshToken!;
        var rotated = await c.Send(HttpMethod.Post, "/api/v1/auth/refresh", new { refreshToken = first }, true);
        Assert.True(rotated.Ok, rotated.ToString());
        var second = rotated.Data!["refreshToken"]!.GetValue<string>();

        var otherTab = await c.Send(HttpMethod.Post, "/api/v1/auth/refresh", new { refreshToken = first }, true);
        Assert.True(otherTab.Ok, otherTab.ToString());
        var sibling = otherTab.Data!["refreshToken"]!.GetValue<string>();
        Assert.NotEqual(second, sibling);
        var tab = new TestClient(factory) { Token = otherTab.Data["accessToken"]!.GetValue<string>() };
        Assert.True((await tab.Get("/api/v1/me")).Ok);

        // the session is intact: the rotated token and the sibling both still work
        Assert.True((await c.Send(HttpMethod.Post, "/api/v1/auth/refresh", new { refreshToken = second }, true)).Ok);
        Assert.True((await c.Send(HttpMethod.Post, "/api/v1/auth/refresh", new { refreshToken = sibling }, true)).Ok);
    }

    [Fact]
    public async Task A_refresh_whose_response_was_lost_does_not_end_the_session_on_the_next_navigation()
    {
        var c = await TestClient.RegisterAsync(factory);
        var first = c.RefreshToken!;
        // The page navigated away while its refresh was on the way: the server rotated, the browser never got the new cookie.
        Assert.True((await c.Send(HttpMethod.Post, "/api/v1/auth/refresh", new { refreshToken = first }, true)).Ok);
        // The next page load presents the old cookie within the grace window and is handed a fresh one.
        var reload = await c.Send(HttpMethod.Post, "/api/v1/auth/refresh", new { refreshToken = first }, true);
        Assert.True(reload.Ok, reload.ToString());
        var fresh = reload.Data!["refreshToken"]!.GetValue<string>();
        // Minutes later (opening the Calendar): the browser's cookie is the fresh one, and it still works.
        factory.WithDb(db =>
        {
            foreach (var t in db.RefreshTokens.Where(t => t.UsedAt != null && t.UserId == c.UserId)) t.UsedAt = DateTime.UtcNow.AddMinutes(-5);
            db.SaveChanges();
            return 0;
        });
        var later = await c.Send(HttpMethod.Post, "/api/v1/auth/refresh", new { refreshToken = fresh }, true);
        Assert.True(later.Ok, later.ToString());
        Assert.True((await new TestClient(factory) { Token = later.Data!["accessToken"]!.GetValue<string>() }.Get("/api/v1/me")).Ok);
    }

    [Fact]
    public async Task Refresh_issues_the_token_for_the_tabs_own_workspace_when_still_a_member()
    {
        var c = await TestClient.RegisterAsync(factory);
        var personal = Guid.Parse((await c.Get("/api/v1/me")).Data!["current"]!["id"]!.GetValue<string>());
        var org = await c.CreateOrgAsync();   // the session now points at the organization
        c.Extra["X-Workspace-Id"] = personal.ToString();
        var res = await c.Send(HttpMethod.Post, "/api/v1/auth/refresh", new { refreshToken = c.RefreshToken }, true);
        Assert.True(res.Ok, res.ToString());
        var tab = new TestClient(factory) { Token = res.Data!["accessToken"]!.GetValue<string>() };
        Assert.Equal(personal.ToString(), (await tab.Get("/api/v1/me")).Data!["current"]!["id"]!.GetValue<string>());

        // a workspace the person is not in is ignored: the session's own workspace is used instead
        c.Extra["X-Workspace-Id"] = Guid.NewGuid().ToString();
        var other = await c.Send(HttpMethod.Post, "/api/v1/auth/refresh", new { refreshToken = res.Data["refreshToken"]!.GetValue<string>() }, true);
        Assert.True(other.Ok, other.ToString());
        var tab2 = new TestClient(factory) { Token = other.Data!["accessToken"]!.GetValue<string>() };
        Assert.Equal(personal.ToString(), (await tab2.Get("/api/v1/me")).Data!["current"]!["id"]!.GetValue<string>());
        _ = org;
    }

    [Fact]
    public async Task Cookie_refresh_requires_the_csrf_header()
    {
        var c = new TestClient(factory);
        var res = await c.Send(HttpMethod.Post, "/api/v1/auth/refresh", null, true);
        Assert.Equal(HttpStatusCode.Forbidden, res.Status);
        Assert.Equal("CSRF_CHECK_FAILED", res.ErrorCode);
    }

    [Fact]
    public async Task Logout_revokes_the_session_so_the_access_token_stops_working()
    {
        var c = await TestClient.RegisterAsync(factory);
        Assert.True((await c.Get("/api/v1/me")).Ok);

        Assert.Equal(HttpStatusCode.NoContent, (await c.Post("/api/v1/auth/logout")).Status);

        var after = await c.Get("/api/v1/me");
        Assert.Equal(HttpStatusCode.Unauthorized, after.Status);
        Assert.Equal("SESSION_REVOKED", after.ErrorCode);
    }

    [Fact]
    public async Task Password_reset_works_and_signs_out_other_sessions()
    {
        var c = await TestClient.RegisterAsync(factory);
        var forgot = await c.Send(HttpMethod.Post, "/api/v1/auth/forgot-password", new { email = c.Email }, true);
        Assert.Equal(HttpStatusCode.Accepted, forgot.Status);

        var unknown = await c.Send(HttpMethod.Post, "/api/v1/auth/forgot-password", new { email = "nobody@example.com" }, true);
        Assert.Equal(HttpStatusCode.Accepted, unknown.Status); // identical response: no account enumeration

        var token = await c.MailboxToken("reset-password");
        var reset = await c.Send(HttpMethod.Post, "/api/v1/auth/reset-password", new { token, password = "NewPassw0rd!y" }, true);
        Assert.Equal(HttpStatusCode.NoContent, reset.Status);

        Assert.Equal(HttpStatusCode.Unauthorized, (await c.Get("/api/v1/me")).Status); // old session revoked
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.LoginAsync("Passw0rd!x")).Status);
        Assert.True((await c.LoginAsync("NewPassw0rd!y")).Ok);

        var again = await c.Send(HttpMethod.Post, "/api/v1/auth/reset-password", new { token, password = "Another1Pass!" }, true);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, again.Status); // reset links are single-use
    }

    [Fact]
    public async Task New_users_get_a_personal_workspace_on_the_free_plan()
    {
        var c = await TestClient.RegisterAsync(factory);
        var ctx = (await c.Get("/api/v1/me")).Data!;
        Assert.Equal("Personal", ctx["current"]!["type"]!.GetValue<string>());
        Assert.Equal("Owner", ctx["current"]!["role"]!.GetValue<string>());
        Assert.Equal("FREE", ctx["current"]!["plan"]!["code"]!.GetValue<string>());
        Assert.Equal(5, ctx["current"]!["entitlements"]!["PROJECT_LIMIT"]!.GetValue<int>());
    }
}
