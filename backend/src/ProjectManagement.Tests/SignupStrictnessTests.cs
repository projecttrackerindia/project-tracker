using System.Net;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Features.Organization;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The sign-up field rules, the form token and the lockout backoff on their own: no database, no HTTP.</summary>
public class SignupRulesTests
{
    [Theory]
    [InlineData("Asha Rao")]
    [InlineData("Sinéad O'Brien")]
    [InlineData("Jean-Luc Picard")]
    [InlineData("Al")]
    [InlineData("अनन्या शर्मा")]
    [InlineData("  Ravi   Kumar ")]
    public void Real_names_pass(string name) => Assert.Null(SignupRules.NameProblem(name));

    [Theory]
    [InlineData("", "Enter your name.")]
    [InlineData("A", "Enter your name (2 to 60 characters).")]
    [InlineData("Agent 007", "A name cannot contain numbers.")]
    [InlineData("Visit www.cheap-deals.example", "A name cannot contain a web or email address.")]
    [InlineData("Ravi 😀😀", "Use letters, spaces, apostrophes and hyphens only.")]
    [InlineData("<script>", "Use letters, spaces, apostrophes and hyphens only.")]
    [InlineData("-Ravi", "Use letters, spaces, apostrophes and hyphens only.")]
    [InlineData("Aaaaa Bbbb", "That does not look like a real name.")]
    public void Junk_names_are_refused_with_a_clear_reason(string name, string message) => Assert.Equal(message, SignupRules.NameProblem(name));

    [Fact]
    public void A_name_longer_than_sixty_characters_is_refused() => Assert.NotNull(SignupRules.NameProblem(new string('x', 61)));

    [Theory]
    [InlineData("asha@fivestar.in")]
    [InlineData("first.last+tag@mail.example.co.in")]
    [InlineData("user-0f3a@example.com")]
    public void Valid_addresses_pass(string email) => Assert.Null(SignupRules.EmailProblem(email));

    [Theory]
    [InlineData("plain")]
    [InlineData("a@b")]
    [InlineData("a@@b.com")]
    [InlineData("a@b.c")]
    [InlineData(".a@b.com")]
    [InlineData("a..b@b.com")]
    [InlineData("a@[127.0.0.1]")]
    [InlineData("a@-b.com")]
    public void Malformed_addresses_are_refused(string email) => Assert.Equal("Enter a valid email address.", SignupRules.EmailProblem(email));

    [Fact]
    public void Disposable_inboxes_are_refused_including_their_subdomains()
    {
        Assert.Contains("disposable", SignupRules.EmailProblem("someone@mailinator.com"));
        Assert.True(DisposableEmailDomains.Contains("inbox.yopmail.com"));
        Assert.False(DisposableEmailDomains.Contains("fivestar.in"));
    }

    [Theory]
    [InlineData("Five Star Business Finance Ltd.", true)]
    [InlineData("R&D (India) Pvt Ltd", true)]
    [InlineData("Studio 9", true)]
    [InlineData("best-loans.com", false)]
    [InlineData("Acme <b>", false)]
    [InlineData("12345", false)]
    [InlineData("Zzzzzz Corp", false)]
    [InlineData(" ", false)]
    public void Organisation_names_must_look_like_one(string name, bool ok) => Assert.Equal(ok, SignupRules.OrganizationProblem(name) is null);

    [Theory]
    [InlineData("+91 98765 43210", true)]
    [InlineData("+1 (415) 555-0100", true)]
    [InlineData("+44 20 7946 0958", true)]
    [InlineData("9876543210", false)]
    [InlineData("+91 12345 67890", false)]
    [InlineData("+91 98765", false)]
    [InlineData("+0 1234567", false)]
    public void Phone_numbers_are_e164_with_national_lengths(string phone, bool ok) => Assert.Equal(ok, SignupRules.PhoneProblem(phone) is null);

    [Fact]
    public void The_form_token_proves_when_the_form_was_loaded_and_cannot_be_forged()
    {
        var key = new byte[32]; key[0] = 7;
        var loaded = new DateTime(2026, 11, 3, 9, 0, 0, DateTimeKind.Utc);
        var token = SignupRules.CreateFormToken(key, loaded);
        TimeSpan min = TimeSpan.FromSeconds(3), max = TimeSpan.FromMinutes(120);
        Assert.Equal(SignupRules.FormVerdict.TooFast, SignupRules.CheckFormToken(key, token, loaded.AddSeconds(1), min, max));
        Assert.Equal(SignupRules.FormVerdict.Ok, SignupRules.CheckFormToken(key, token, loaded.AddSeconds(20), min, max));
        Assert.Equal(SignupRules.FormVerdict.Expired, SignupRules.CheckFormToken(key, token, loaded.AddHours(3), min, max));
        Assert.Equal(SignupRules.FormVerdict.Missing, SignupRules.CheckFormToken(key, null, loaded, min, max));
        var parts = token.Split('.');
        var backdated = $"{loaded.AddMinutes(-5).Ticks}.{parts[1]}.{parts[2]}";
        Assert.Equal(SignupRules.FormVerdict.Invalid, SignupRules.CheckFormToken(key, backdated, loaded.AddSeconds(1), min, max));
        var other = new byte[32];
        Assert.Equal(SignupRules.FormVerdict.Invalid, SignupRules.CheckFormToken(other, token, loaded.AddSeconds(20), min, max));
    }

    [Fact]
    public void Each_lockout_in_a_row_doubles_up_to_a_day()
    {
        var user = new User();
        var now = new DateTime(2026, 11, 3, 9, 0, 0, DateTimeKind.Utc);
        Assert.Equal(now.AddMinutes(15), LockoutPolicy.Next(user, now, 15));
        Assert.Equal(now.AddMinutes(30), LockoutPolicy.Next(user, now, 15));
        Assert.Equal(now.AddMinutes(60), LockoutPolicy.Next(user, now, 15));
        for (var i = 0; i < 20; i++) LockoutPolicy.Next(user, now, 15);
        Assert.Equal(now.AddMinutes(LockoutPolicy.MaxMinutes), LockoutPolicy.Next(user, now, 15));
    }

    [Fact]
    public void An_invitation_allowlist_matches_exact_domains()
    {
        Assert.True(EmailDomains.Allows("", "anyone@anywhere.example"));
        Assert.True(EmailDomains.Allows("fivestar.in,fivestar.co.in", "Ravi@FiveStar.in"));
        Assert.False(EmailDomains.Allows("fivestar.in", "ravi@evil-fivestar.in"));
        Assert.False(EmailDomains.Allows("fivestar.in", "ravi@mail.fivestar.in"));
        Assert.True(EmailDomains.IsValid("fivestar.co.in"));
        Assert.False(EmailDomains.IsValid("not a domain"));
    }
}

/// <summary>Strict self-service sign-up through the API: junk details, bots and dead domains never become accounts.</summary>
[Collection("api")]
public class SignupStrictnessTests(ApiFactory factory)
{
    private Task<ApiResult> Register(object body) => new TestClient(factory).Send(HttpMethod.Post, "/api/v1/auth/register", body, anonymous: true);

    private static Dictionary<string, object?> Body(string? email = null, string name = "Meera Iyer") => new()
    {
        ["email"] = email ?? $"user-{Guid.NewGuid():N}@example.com", ["password"] = "Passw0rd!xKey", ["displayName"] = name, ["acceptedTerms"] = true,
    };

    private static string? Field(ApiResult r) => r.Json?["errors"]?[0]?["field"]?.GetValue<string>();

    [Theory]
    [InlineData("Agent 007")]
    [InlineData("http://win-prizes.example")]
    [InlineData("😀😀😀")]
    [InlineData("x")]
    public async Task Random_names_are_refused_on_the_server(string name)
    {
        var res = await Register(Body(name: name));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.Status);
        Assert.Equal("displayName", Field(res));
    }

    [Fact]
    public async Task Disposable_malformed_and_dead_email_domains_are_refused()
    {
        var disposable = await Register(Body("someone@mailinator.com"));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, disposable.Status);
        Assert.Equal("email", Field(disposable));

        var malformed = await Register(Body("someone@localhost"));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, malformed.Status);

        var dead = await Register(Body($"someone-{Guid.NewGuid():N}@nowhere.invalid"));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, dead.Status);
        Assert.Equal("EMAIL_DOMAIN_NO_MAIL", dead.ErrorCode);
    }

    [Fact]
    public async Task A_filled_honeypot_is_a_bot()
    {
        var body = Body();
        body["website"] = "https://spam.example";
        var res = await Register(body);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.Status);
        Assert.Equal("SIGNUP_BOT_CHECK", res.ErrorCode);
    }

    [Fact]
    public async Task A_form_submitted_the_instant_it_loaded_is_a_bot_and_a_forged_token_is_refused()
    {
        var form = await new TestClient(factory).Send(HttpMethod.Get, "/api/v1/auth/signup-form", null, true);
        Assert.True(form.Ok, form.ToString());
        var token = form.Data!["formToken"]!.GetValue<string>();
        Assert.True(form.Data["minSubmitSeconds"]!.GetValue<int>() >= 1);

        var fast = Body(); fast["formToken"] = token;
        Assert.Equal("SIGNUP_TOO_FAST", (await Register(fast)).ErrorCode);

        var forged = Body(); forged["formToken"] = "638000000000000000.00.deadbeef";
        Assert.Equal("SIGNUP_BOT_CHECK", (await Register(forged)).ErrorCode);
    }

    [Fact]
    public async Task An_organisation_name_that_is_a_link_is_refused()
    {
        var body = Body();
        body["workspaceType"] = "organization";
        body["organizationName"] = "www.best-loans.example";
        var res = await Register(body);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.Status);
        Assert.Equal("organizationName", Field(res));
    }

    [Fact]
    public async Task Passwords_shorter_than_twelve_characters_are_refused()
    {
        var body = Body();
        body["password"] = "Sh0rt!pass";
        var res = await Register(body);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.Status);
        Assert.Equal("password", Field(res));
        Assert.Contains("12 characters", res.ToString());
    }

    [Fact]
    public async Task An_organisation_can_limit_invitations_to_its_own_email_domains()
    {
        var owner = await TestClient.RegisterAsync(factory, "Domain Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var set = await owner.Put("/api/v1/workspace/security", new { requireMfa = false, ipAllowlistEnabled = false, ipRanges = Array.Empty<string>(), allowedEmailDomains = new[] { "@FiveStar.example", "fivestar.example" } });
        Assert.True(set.Ok, set.ToString());
        Assert.Equal("fivestar.example", Assert.Single(set.Data!["allowedEmailDomains"]!.AsArray())!.GetValue<string>());

        var outside = await owner.Post("/api/v1/workspace/invitations", new { email = "stranger@elsewhere.example", role = "Member" });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, outside.Status);
        Assert.Equal("email", Field(outside));
        Assert.True((await owner.Post("/api/v1/workspace/invitations", new { email = "ravi@fivestar.example", role = "Member" })).Ok);

        var bad = await owner.Put("/api/v1/workspace/security", new { requireMfa = false, ipAllowlistEnabled = false, ipRanges = Array.Empty<string>(), allowedEmailDomains = new[] { "not a domain" } });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, bad.Status);
    }
}
