using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Common;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Two-step verification: authenticator-app codes, recovery codes, lockout, replay protection and admin reset.</summary>
[Collection("api")]
public class MfaTests(ApiFactory factory)
{
    private const string Password = "Passw0rd!x";

    private static string CodeNow(string secret, int stepOffset = 0) =>
        Totp.Compute(secret, Totp.StepOf(DateTime.UtcNow) + stepOffset);

    /// <summary>Registers a user, turns two-step verification on, and returns the secret and recovery codes.</summary>
    private async Task<(TestClient C, string Secret, List<string> Recovery)> EnabledUserAsync()
    {
        var c = await TestClient.RegisterAsync(factory);
        var setup = await c.Post("/api/v1/me/mfa/setup", new { password = Password });
        Assert.True(setup.Ok, setup.ToString());
        var secret = setup.Data!["secret"]!.GetValue<string>().Replace(" ", "");
        Assert.StartsWith("otpauth://totp/", setup.Data["otpAuthUri"]!.GetValue<string>());

        var enable = await c.Post("/api/v1/me/mfa/enable", new { code = CodeNow(secret) });
        Assert.True(enable.Ok, enable.ToString());
        var recovery = enable.Data!["codes"]!.AsArray().Select(x => x!.GetValue<string>()).ToList();
        return (c, secret, recovery);
    }

    /// <summary>Codes can only be used once per 30 s step, so tests that sign in repeatedly rewind the replay guard first.</summary>
    private void RewindReplayGuard(Guid userId) => factory.WithDb(db =>
    {
        db.Users.IgnoreQueryFilters().Where(u => u.Id == userId).ExecuteUpdate(s => s.SetProperty(u => u.MfaLastStep, 0L));
        return 0;
    });

    private static Task<ApiResult> Challenge(TestClient c) =>
        c.Send(HttpMethod.Post, "/api/v1/auth/login", new { email = c.Email, password = Password }, true);

    private static async Task<string> NewChallenge(TestClient c) => (await Challenge(c)).Data!["challenge"]!.GetValue<string>();

    private static Task<ApiResult> CompleteLogin(TestClient c, string challenge, string code) =>
        c.Send(HttpMethod.Post, "/api/v1/auth/login/mfa", new { challenge, code }, true);

    [Fact]
    public async Task Setup_requires_the_password_and_a_correct_first_code()
    {
        var c = await TestClient.RegisterAsync(factory);
        Assert.False((await c.Post("/api/v1/me/mfa/setup", new { password = "wrong-password" })).Ok);

        var setup = await c.Post("/api/v1/me/mfa/setup", new { password = Password });
        var secret = setup.Data!["secret"]!.GetValue<string>().Replace(" ", "");

        // Not on until a real code proves the app has the secret.
        Assert.False((await c.Get("/api/v1/me/mfa")).Data!["enabled"]!.GetValue<bool>());
        Assert.False((await c.Post("/api/v1/me/mfa/enable", new { code = "000000" })).Ok);
        Assert.False((await c.Get("/api/v1/me/mfa")).Data!["enabled"]!.GetValue<bool>());

        var enable = await c.Post("/api/v1/me/mfa/enable", new { code = CodeNow(secret) });
        Assert.True(enable.Ok, enable.ToString());
        Assert.Equal(10, enable.Data!["codes"]!.AsArray().Count);
        var status = (await c.Get("/api/v1/me/mfa")).Data!;
        Assert.True(status["enabled"]!.GetValue<bool>());
        Assert.Equal(10, status["recoveryCodesLeft"]!.GetValue<int>());

        // Cannot be set up twice.
        Assert.Equal(HttpStatusCode.Conflict, (await c.Post("/api/v1/me/mfa/setup", new { password = Password })).Status);
    }

    [Fact]
    public async Task Secrets_and_recovery_codes_are_not_stored_in_clear()
    {
        var (c, secret, recovery) = await EnabledUserAsync();
        var (stored, hashes) = factory.WithDb(db =>
        {
            var u = db.Users.IgnoreQueryFilters().First(x => x.Id == c.UserId);
            return (u.MfaSecret, db.MfaRecoveryCodes.Where(r => r.UserId == c.UserId).Select(r => r.CodeHash).ToList());
        });
        Assert.NotNull(stored);
        Assert.DoesNotContain(secret, stored);
        Assert.Equal(10, hashes.Count);
        Assert.All(recovery, code => Assert.DoesNotContain(code.Replace("-", ""), hashes));
    }

    [Fact]
    public async Task Login_with_mfa_returns_a_challenge_and_no_tokens_until_the_code_is_right()
    {
        var (c, secret, _) = await EnabledUserAsync();
        RewindReplayGuard(c.UserId);

        var first = await Challenge(c);
        Assert.True(first.Ok, first.ToString());
        Assert.True(first.Data!["mfaRequired"]!.GetValue<bool>());
        Assert.Null(first.Data["accessToken"]);
        var challenge = first.Data["challenge"]!.GetValue<string>();

        var wrong = await CompleteLogin(c, challenge, "000000");
        Assert.Equal(HttpStatusCode.Unauthorized, wrong.Status);
        Assert.Equal("INVALID_MFA_CODE", wrong.ErrorCode);

        var ok = await CompleteLogin(c, challenge, CodeNow(secret));
        Assert.True(ok.Ok, ok.ToString());
        Assert.NotNull(ok.Data!["accessToken"]);
        Assert.True(ok.Data["user"]!["mfaEnabled"]!.GetValue<bool>());
    }

    [Fact]
    public async Task A_code_cannot_be_used_twice()
    {
        var (c, secret, _) = await EnabledUserAsync();
        RewindReplayGuard(c.UserId);
        var code = CodeNow(secret);

        var one = await CompleteLogin(c, await NewChallenge(c), code);
        Assert.True(one.Ok, one.ToString());
        var two = await CompleteLogin(c, await NewChallenge(c), code);
        Assert.Equal(HttpStatusCode.Unauthorized, two.Status);
    }

    [Fact]
    public async Task Recovery_code_works_once_and_is_case_and_dash_insensitive()
    {
        var (c, _, recovery) = await EnabledUserAsync();
        var code = recovery[0];

        var ok = await CompleteLogin(c, await NewChallenge(c), code.ToLowerInvariant().Replace("-", " "));
        Assert.True(ok.Ok, ok.ToString());
        c.ApplyAuth(ok);
        var again = await CompleteLogin(c, await NewChallenge(c), code);
        Assert.Equal(HttpStatusCode.Unauthorized, again.Status);
        Assert.Equal(9, (await c.Get("/api/v1/me/mfa")).Data!["recoveryCodesLeft"]!.GetValue<int>());
    }

    [Fact]
    public async Task Tampered_or_foreign_challenges_are_refused()
    {
        var (c, secret, _) = await EnabledUserAsync();
        RewindReplayGuard(c.UserId);
        var challenge = await NewChallenge(c);

        var tampered = challenge[..^2] + (challenge.EndsWith("AA") ? "BB" : "AA");
        var bad = await CompleteLogin(c, tampered, CodeNow(secret));
        Assert.Equal(HttpStatusCode.Unauthorized, bad.Status);
        Assert.Equal("MFA_CHALLENGE_INVALID", bad.ErrorCode);
        Assert.Equal("MFA_CHALLENGE_INVALID", (await CompleteLogin(c, "garbage", "123456")).ErrorCode);
    }

    [Fact]
    public async Task Wrong_codes_lock_the_account_like_wrong_passwords()
    {
        var (c, secret, _) = await EnabledUserAsync();
        RewindReplayGuard(c.UserId);
        var challenge = await NewChallenge(c);

        for (var i = 0; i < 5; i++) Assert.Equal(HttpStatusCode.Unauthorized, (await CompleteLogin(c, challenge, "000000")).Status);

        // Locked: even the right code is refused now.
        var locked = await CompleteLogin(c, challenge, CodeNow(secret));
        Assert.Equal(HttpStatusCode.TooManyRequests, locked.Status);
        Assert.Equal("ACCOUNT_LOCKED", locked.ErrorCode);
    }

    [Fact]
    public async Task Turning_off_or_regenerating_needs_password_and_a_code()
    {
        var (c, secret, recovery) = await EnabledUserAsync();
        RewindReplayGuard(c.UserId);

        Assert.False((await c.Post("/api/v1/me/mfa/disable", new { password = "nope-nope", code = CodeNow(secret) })).Ok);
        Assert.False((await c.Post("/api/v1/me/mfa/disable", new { password = Password, code = "000000" })).Ok);
        Assert.True((await c.Get("/api/v1/me/mfa")).Data!["enabled"]!.GetValue<bool>());

        var regen = await c.Post("/api/v1/me/mfa/recovery-codes", new { password = Password, code = CodeNow(secret) });
        Assert.True(regen.Ok, regen.ToString());
        var fresh = regen.Data!["codes"]!.AsArray().Select(x => x!.GetValue<string>()).ToList();
        Assert.Empty(fresh.Intersect(recovery));
        // Old recovery codes are dead.
        Assert.Equal(HttpStatusCode.Unauthorized, (await CompleteLogin(c, await NewChallenge(c), recovery[0])).Status);

        var off = await c.Post("/api/v1/me/mfa/disable", new { password = Password, code = fresh[0] });
        Assert.Equal(HttpStatusCode.NoContent, off.Status);
        var plain = await Challenge(c);
        Assert.NotNull(plain.Data!["accessToken"]);
    }

    [Fact]
    public async Task Enabling_and_disabling_leave_an_audit_trail_and_a_security_notification()
    {
        var (c, _, recovery) = await EnabledUserAsync();
        await c.Post("/api/v1/me/mfa/disable", new { password = Password, code = recovery[0] });

        var actions = factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Where(a => a.UserId == c.UserId).Select(a => a.Action).ToList());
        Assert.Contains("user.mfa_enabled", actions);
        Assert.Contains("user.mfa_disabled", actions);
        Assert.Contains("user.mfa_recovery_code_used", actions);

        var notifications = (await c.Get("/api/v1/notifications?pageSize=50")).Data!.ToJsonString();
        Assert.Contains("Two-step verification was turned off", notifications);
    }

    [Fact]
    public async Task Platform_admin_can_reset_mfa_and_ordinary_users_cannot()
    {
        var (c, _, _) = await EnabledUserAsync();
        var stranger = await TestClient.RegisterAsync(factory);
        Assert.Equal(HttpStatusCode.Forbidden, (await stranger.Post($"/api/v1/admin/users/{c.UserId}/mfa-reset")).Status);

        var admin = await TestClient.RegisterAsync(factory, "Admin");
        factory.WithDb(db =>
        {
            db.Users.IgnoreQueryFilters().Where(u => u.Id == admin.UserId).ExecuteUpdate(s => s.SetProperty(u => u.IsPlatformAdmin, true));
            return 0;
        });
        await admin.LoginAsync();

        var reset = await admin.Post($"/api/v1/admin/users/{c.UserId}/mfa-reset");
        Assert.Equal(HttpStatusCode.NoContent, reset.Status);
        var login = await Challenge(c);
        Assert.NotNull(login.Data!["accessToken"]);
        Assert.Equal(HttpStatusCode.Conflict, (await admin.Post($"/api/v1/admin/users/{c.UserId}/mfa-reset")).Status);
    }
}
