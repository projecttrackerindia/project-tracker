using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Retried writes, compressed answers, the published API description, and passkey ceremonies' guards.</summary>
[Collection("api")]
public class ApiHardeningTests(ApiFactory factory)
{
    private static async Task<int> ProjectCount(TestClient c)
    {
        var list = await c.Get("/api/v1/projects?pageSize=100");
        return list.Data!["items"]!.AsArray().Count;
    }

    [Fact]
    public async Task A_retried_write_with_the_same_key_is_answered_again_and_done_once()
    {
        var c = await TestClient.RegisterAsync(factory, "Ida Idem");
        await c.CreateOrgAsync();
        c.Extra["Idempotency-Key"] = $"create-{Guid.NewGuid():N}";
        var first = await c.Post("/api/v1/projects", new { name = "Once only", description = "x" });
        Assert.True(first.Ok, first.ToString());
        Assert.Null(first.Header("Idempotent-Replayed"));
        var second = await c.Post("/api/v1/projects", new { name = "Once only", description = "x" });
        Assert.True(second.Ok, second.ToString());
        Assert.Equal("true", second.Header("Idempotent-Replayed"));
        Assert.True(second.Data is not null, second.ToString());
        Assert.Equal(first.Data!["project"]!["id"]!.GetValue<string>(), second.Data!["project"]!["id"]!.GetValue<string>());
        Assert.Equal(1, await ProjectCount(c));
    }

    [Fact]
    public async Task The_same_key_for_a_different_request_is_refused_and_a_bad_key_is_rejected()
    {
        var c = await TestClient.RegisterAsync(factory, "Ida Idem");
        await c.CreateOrgAsync();
        var key = $"reuse-{Guid.NewGuid():N}";
        c.Extra["Idempotency-Key"] = key;
        Assert.True((await c.Post("/api/v1/projects", new { name = "First" })).Ok);
        var other = await c.Post("/api/v1/projects", new { name = "Second" });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, other.Status);
        Assert.Equal("IDEMPOTENCY_KEY_REUSED", other.ErrorCode);
        Assert.Equal(1, await ProjectCount(c));

        c.Extra["Idempotency-Key"] = "short";
        var bad = await c.Post("/api/v1/projects", new { name = "Third" });
        Assert.Equal(HttpStatusCode.BadRequest, bad.Status);
        Assert.Equal("INVALID_IDEMPOTENCY_KEY", bad.ErrorCode);
    }

    [Fact]
    public async Task A_failed_request_does_not_use_up_its_key_and_keys_belong_to_the_person()
    {
        var a = await TestClient.RegisterAsync(factory, "Ann A");
        await a.CreateOrgAsync();
        var b = await TestClient.RegisterAsync(factory, "Bob B");
        await b.CreateOrgAsync();
        var key = $"shared-{Guid.NewGuid():N}";
        a.Extra["Idempotency-Key"] = key; b.Extra["Idempotency-Key"] = key;
        var invalid = await a.Post("/api/v1/projects", new { name = "" });          // refused: nothing is remembered
        Assert.False(invalid.Ok);
        var fixedUp = await a.Post("/api/v1/projects", new { name = "Fixed" });
        Assert.True(fixedUp.Ok, fixedUp.ToString());
        Assert.Null(fixedUp.Header("Idempotent-Replayed"));
        Assert.True((await b.Post("/api/v1/projects", new { name = "Bob's own" })).Ok);   // someone else's key is a different key
        Assert.Equal(1, await ProjectCount(b));
    }

    [Fact]
    public async Task Answers_are_compressed_when_the_client_accepts_it()
    {
        var c = await TestClient.RegisterAsync(factory, "Cora Compress");
        await c.CreateOrgAsync();
        for (var i = 0; i < 6; i++) await c.Post("/api/v1/projects", new { name = $"Project number {i} with a reasonably long name for compression", description = new string('d', 300) });
        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/v1/projects?pageSize=100");
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", c.Token);
        req.Headers.AcceptEncoding.ParseAdd("gzip");
        using var res = await c.Http.SendAsync(req);
        Assert.Contains("gzip", res.Content.Headers.ContentEncoding);
    }

    [Fact]
    public async Task The_api_description_is_published_with_the_idempotency_header()
    {
        var c = await TestClient.RegisterAsync(factory, "Dora Docs");
        var doc = await c.Http.GetStringAsync("/api/openapi/v1.json");
        Assert.Contains("\"openapi\"", doc);
        Assert.Contains("Idempotency-Key", doc);
        Assert.Contains("/api/v1/projects", doc);
        var ui = await c.Http.GetAsync("/api/docs/index.html");
        Assert.Equal(HttpStatusCode.OK, ui.StatusCode);
    }

    // ------------------------------------------------------------------ passkeys: the guards (the device ceremony itself is covered in the browser check)

    [Fact]
    public async Task Passkey_options_need_a_signed_in_person_and_sign_in_options_reveal_nothing_about_accounts()
    {
        Assert.Equal(HttpStatusCode.Unauthorized, (await new TestClient(factory).Post("/api/v1/me/passkeys/options")).Status);

        var c = await TestClient.RegisterAsync(factory, "Pia Passkey");
        var reg = await c.Post("/api/v1/me/passkeys/options");
        Assert.True(reg.Ok, reg.ToString());
        Assert.True(reg.Data!["options"]!["challenge"] is not null);
        Assert.Equal("required", reg.Data["options"]!["authenticatorSelection"]!["userVerification"]!.GetValue<string>());

        var known = await new TestClient(factory).Send(HttpMethod.Post, "/api/v1/auth/passkey/options", new { email = c.Email }, true);
        var unknown = await new TestClient(factory).Send(HttpMethod.Post, "/api/v1/auth/passkey/options", new { email = "nobody-here@example.test" }, true);
        Assert.True(known.Ok && unknown.Ok);
        Assert.Equal(known.Data!["options"]!.AsObject().Select(p => p.Key).OrderBy(x => x), unknown.Data!["options"]!.AsObject().Select(p => p.Key).OrderBy(x => x));
        Assert.Equal(0, (await c.Get("/api/v1/me/passkeys")).Data!.AsArray().Count);
    }

    [Fact]
    public async Task A_made_up_or_reused_passkey_answer_is_refused_and_challenges_are_single_use()
    {
        var anon = new TestClient(factory);
        var opts = await anon.Send(HttpMethod.Post, "/api/v1/auth/passkey/options", new { email = "" }, true);
        var id = opts.Data!["challengeId"]!.GetValue<string>();
        var fake = new { challengeId = id, response = new { id = "AAAA", rawId = "AAAA", type = "public-key", response = new { authenticatorData = "AAAA", clientDataJSON = "AAAA", signature = "AAAA" } } };
        var first = await anon.Send(HttpMethod.Post, "/api/v1/auth/passkey/verify", fake, true);
        Assert.False(first.Ok);
        var again = await anon.Send(HttpMethod.Post, "/api/v1/auth/passkey/verify", fake, true);   // the challenge was used up by the first attempt
        Assert.False(again.Ok);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, again.Status);
    }

    [Fact]
    public async Task One_person_cannot_touch_anothers_passkey()
    {
        var a = await TestClient.RegisterAsync(factory, "Ann A");
        var b = await TestClient.RegisterAsync(factory, "Bob B");
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ProjectManagement.Infrastructure.Persistence.AppDbContext>();
        var key = new PasskeyCredential { UserId = a.UserId, CredentialId = $"cred-{Guid.NewGuid():N}", PublicKey = [1], UserHandle = [1], Name = "Ann's phone", CreatedAt = DateTime.UtcNow };
        db.PasskeyCredentials.Add(key);
        await db.SaveChangesAsync();
        Assert.Single((await a.Get("/api/v1/me/passkeys")).Data!.AsArray());
        Assert.Empty((await b.Get("/api/v1/me/passkeys")).Data!.AsArray());
        Assert.Equal(HttpStatusCode.NotFound, (await b.Delete($"/api/v1/me/passkeys/{key.Id}")).Status);
        Assert.True((await a.Put($"/api/v1/me/passkeys/{key.Id}", new { name = "Work laptop" })).Ok);
        Assert.Equal("Work laptop", (await a.Get("/api/v1/me/passkeys")).Data![0]!["name"]!.GetValue<string>());
        Assert.True((await a.Delete($"/api/v1/me/passkeys/{key.Id}")).Ok);
        Assert.Empty((await a.Get("/api/v1/me/passkeys")).Data!.AsArray());
    }

    [Theory]
    [InlineData("passkey", true)]
    [InlineData("device", true)]
    [InlineData("password", false)]
    public async Task A_passkey_or_phone_approved_session_counts_as_the_second_factor_a_workspace_requires(string method, bool allowed)
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        factory.WithDb(db => db.Users.Where(u => u.Id == owner.UserId).ExecuteUpdate(s => s.SetProperty(u => u.MfaEnabled, true)));
        var member = await owner.AddMemberAsync(factory, ProjectManagement.Domain.Enums.TenantRole.Member, "Member");
        Assert.True((await owner.Put("/api/v1/workspace/security", new { requireMfa = true, ipAllowlistEnabled = false, ipRanges = Array.Empty<string>() })).Ok);
        factory.WithDb(db => db.UserSessions.Where(s => s.UserId == member.UserId).ExecuteUpdate(s => s.SetProperty(x => x.AuthMethod, method)));
        var me = await member.Get("/api/v1/me");
        Assert.True(me.Ok);
        Assert.Equal(allowed, me.Data!["current"] is not null);
    }
}
