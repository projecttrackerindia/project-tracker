using System.Net;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The rules themselves: no database, no HTTP.</summary>
public class PasswordRulesTests
{
    private static readonly PasswordPolicyDto Default = PasswordPolicyDto.Default;

    [Theory]
    [InlineData("password")]
    [InlineData("Password123!")]
    [InlineData("P@ssw0rd")]
    [InlineData("p@ssw0rd123")]
    [InlineData("Welcome2026")]
    [InlineData("qwerty123")]
    [InlineData("12345678")]
    [InlineData("aaaaaaaa1")]
    [InlineData("Admin@12345")]
    public void Common_passwords_and_their_usual_disguises_are_refused(string password) =>
        Assert.True(PasswordRules.IsCommon(password), password);

    [Theory]
    [InlineData("Passw0rd!x")]
    [InlineData("Correct-Horse-9")]
    [InlineData("Str0ng&Unique#Pass")]
    public void Ordinary_strong_passwords_pass(string password) =>
        Assert.Empty(PasswordRules.Problems(Default, password, "someone@example.com", "Someone Else"));

    [Fact]
    public void A_password_built_from_the_persons_name_or_email_is_refused()
    {
        Assert.NotEmpty(PasswordRules.Problems(Default, "RaviRocks99", "ravi.kumar@example.com", "R K"));
        Assert.NotEmpty(PasswordRules.Problems(Default, "Kumar-2026-go", "someone@example.com", "Ravi Kumar"));
        Assert.Empty(PasswordRules.Problems(Default, "Kumar-2026-go", "someone@example.com", "Ravi Ram"));   // short name parts are not treated as personal
    }

    [Fact]
    public void Everything_missing_is_listed_in_one_sentence()
    {
        var strict = Default with { MinLength = 12, RequireUppercase = true, RequireSymbol = true };
        var problem = Assert.Single(PasswordRules.Problems(strict, "short1abc", null, null));
        Assert.Equal("Use at least 12 characters, an uppercase letter and a symbol (such as ! # or ?).", problem);
    }

    [Fact]
    public void A_stored_policy_that_is_broken_or_out_of_range_falls_back_safely()
    {
        Assert.Equal(Default, PasswordRules.Parse("not json"));
        Assert.Equal(Default, PasswordRules.Parse(null));
        var clamped = PasswordRules.Parse("""{"minLength":3,"historyCount":99,"requireDigit":true}""");
        Assert.Equal(8, clamped.MinLength);
        Assert.Equal(10, clamped.HistoryCount);
    }
}

/// <summary>The policy as the API applies it: sign-up, change, reset, reuse, and who may change it.</summary>
[Collection("api")]
public class PasswordPolicyTests(ApiFactory factory)
{
    private async Task<TestClient> Admin()
    {
        var admin = await TestClient.RegisterAsync(factory, "Platform Owner");
        factory.WithDb(db => { db.Users.Where(u => u.Id == admin.UserId).ExecuteUpdate(s => s.SetProperty(u => u.IsPlatformAdmin, true)); return 0; });
        await admin.LoginAsync();
        return admin;
    }

    private static object Policy(PasswordPolicyDto p) => new
    {
        p.MinLength, p.RequireLetter, p.RequireUppercase, p.RequireLowercase, p.RequireDigit, p.RequireSymbol, p.BlockCommon, p.BlockPersonalInfo, p.HistoryCount,
    };

    /// <summary>Runs <paramref name="body"/> under a different policy and always puts the default back for the other tests.</summary>
    private async Task WithPolicy(TestClient admin, PasswordPolicyDto policy, Func<Task> body)
    {
        var set = await admin.Put("/api/v1/admin/password-policy", Policy(policy));
        Assert.True(set.Ok, set.ToString());
        try { await body(); }
        finally { Assert.True((await admin.Put("/api/v1/admin/password-policy", Policy(PasswordPolicyDto.Default))).Ok); }
    }

    private Task<ApiResult> Register(string password, string? email = null, string name = "New Person") =>
        new TestClient(factory).Send(HttpMethod.Post, "/api/v1/auth/register",
            new { email = email ?? $"user-{Guid.NewGuid():N}@example.com", password, displayName = name, acceptedTerms = true }, anonymous: true);

    [Fact]
    public async Task By_default_sign_up_refuses_short_common_and_personal_passwords()
    {
        foreach (var (password, email) in new[] { ("short", (string?)null), ("Password123!", null), ("Welcome2026", null), ("Priyanka-2026!", "priyanka@example.com") })
        {
            var res = await Register(password, email);
            Assert.Equal(HttpStatusCode.UnprocessableEntity, res.Status);
            Assert.Equal("password", res.Json!["errors"]![0]!["field"]!.GetValue<string>());
        }
        Assert.Equal(HttpStatusCode.Created, (await Register("Passw0rd!x")).Status);
    }

    [Fact]
    public async Task Anyone_can_read_the_rules_and_a_stricter_policy_applies_at_once_without_locking_anyone_out()
    {
        var rules = (await new TestClient(factory).Send(HttpMethod.Get, "/api/v1/auth/password-policy", anonymous: true)).Data!;
        Assert.Equal(8, rules["minLength"]!.GetValue<int>());
        Assert.True(rules["requireDigit"]!.GetValue<bool>());

        var existing = await TestClient.RegisterAsync(factory);            // chose "Passw0rd!x" under the old rules
        var admin = await Admin();
        await WithPolicy(admin, PasswordPolicyDto.Default with { MinLength = 12, RequireUppercase = true, RequireSymbol = true }, async () =>
        {
            Assert.Equal(12, (await new TestClient(factory).Send(HttpMethod.Get, "/api/v1/auth/password-policy", anonymous: true)).Data!["minLength"]!.GetValue<int>());

            var tooShort = await Register("Passw0rd!x");
            Assert.Equal(HttpStatusCode.UnprocessableEntity, tooShort.Status);
            Assert.Contains("12 characters", tooShort.Json!["errors"]![0]!["message"]!.GetValue<string>());
            Assert.Equal(HttpStatusCode.Created, (await Register("Longer-Passw0rd!")).Status);

            Assert.True((await existing.LoginAsync()).Ok);                  // an old password keeps working until it is changed
            var change = await existing.Post("/api/v1/me/password", new { currentPassword = "Passw0rd!x", newPassword = "alllowercase-but-long1" });
            Assert.Equal(HttpStatusCode.UnprocessableEntity, change.Status);
            Assert.Equal("newPassword", change.Json!["errors"]![0]!["field"]!.GetValue<string>());
        });
    }

    [Fact]
    public async Task Recent_passwords_cannot_be_reused_when_the_policy_remembers_them()
    {
        var admin = await Admin();
        var user = await TestClient.RegisterAsync(factory);
        const string a = "Passw0rd!x", b = "Second-Pass-22", c = "Third-Pass-33", d = "Fourth-Pass-44";
        Task<ApiResult> Change(string from, string to) => user.Post("/api/v1/me/password", new { currentPassword = from, newPassword = to });

        await WithPolicy(admin, PasswordPolicyDto.Default with { HistoryCount = 3 }, async () =>
        {
            Assert.True((await Change(a, b)).Ok);
            var back = await Change(b, a);
            Assert.Equal(HttpStatusCode.UnprocessableEntity, back.Status);
            Assert.Contains("last 3 passwords", back.Json!["errors"]![0]!["message"]!.GetValue<string>());
            Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Change(b, b)).Status);   // the current one counts too
            Assert.True((await Change(b, c)).Ok);
            Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Change(c, a)).Status);   // a is still among the last three (c, b, a)
            Assert.True((await Change(c, d)).Ok);
            Assert.True((await Change(d, a)).Ok);                                            // now the last three are d, c, b
        });

        // Only the few most recent hashes are kept at all.
        var kept = factory.WithDb(db => db.PasswordHistories.Count(h => h.UserId == user.UserId));
        Assert.InRange(kept, 1, PasswordRules.MaxHistory);
    }

    [Fact]
    public async Task A_reset_by_email_must_meet_the_policy_too()
    {
        var user = await TestClient.RegisterAsync(factory);
        Assert.True((await user.Send(HttpMethod.Post, "/api/v1/auth/forgot-password", new { email = user.Email }, anonymous: true)).Ok);
        var token = await user.MailboxToken("reset-password");

        var weak = await user.Send(HttpMethod.Post, "/api/v1/auth/reset-password", new { token, password = "qwerty123" }, anonymous: true);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, weak.Status);
        Assert.Contains("too common", weak.Json!["errors"]![0]!["message"]!.GetValue<string>());

        Assert.Equal(HttpStatusCode.NoContent, (await user.Send(HttpMethod.Post, "/api/v1/auth/reset-password", new { token, password = "Brand-New-Pass-7" }, anonymous: true)).Status);
        Assert.True((await user.LoginAsync("Brand-New-Pass-7")).Ok);
    }

    [Fact]
    public async Task Only_platform_administrators_change_the_policy_and_only_within_sensible_limits()
    {
        var someone = await TestClient.RegisterAsync(factory);
        Assert.Equal(HttpStatusCode.Forbidden, (await someone.Put("/api/v1/admin/password-policy", Policy(PasswordPolicyDto.Default with { MinLength = 20 }))).Status);

        var admin = await Admin();
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await admin.Put("/api/v1/admin/password-policy", Policy(PasswordPolicyDto.Default with { MinLength = 4 }))).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await admin.Put("/api/v1/admin/password-policy", Policy(PasswordPolicyDto.Default with { HistoryCount = 50 }))).Status);

        await WithPolicy(admin, PasswordPolicyDto.Default with { MinLength = 10 }, () => Task.CompletedTask);
        var audit = factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Count(x => x.Action == "admin.password_policy" && x.UserId == admin.UserId));
        Assert.Equal(2, audit);   // the change and the restore
    }
}
