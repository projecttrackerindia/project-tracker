using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Common;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Copy-only by default: a vault value is shown on screen only with a reveal grant, which needs the account password AND a second factor
/// (a two-step code or a passkey). Enforced by the server; every reveal and every failed check is audited.
/// </summary>
[Collection("api")]
public class VaultRevealStepUpTests(ApiFactory factory)
{
    private const string Password = "Tq7#vLm2!pZx9@Rk";
    private const string Account = "Passw0rd!x";
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static Guid G(JsonNode? n) => Guid.Parse(S(n));

    private async Task<TestClient> Owner(string name = "Rhea Reveal")
    {
        var owner = await TestClient.RegisterAsync(factory, name);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS", 5);
        owner.Ip = "203.0.113.21";
        return owner;
    }

    private static async Task<Guid> Item(TestClient c)
    {
        var o = await c.Get("/api/v1/vault/overview");
        Assert.True(o.Ok, o.ToString());
        var mine = G(o.Data!["collections"]!.AsArray().First(x => S(x!["kind"]) == "Personal")!["id"]);
        var res = await c.Post("/api/v1/vault/items", new
        {
            collectionId = mine, kind = "Login", title = "Core banking", @class = "Secret",
            fields = new object[] { new { key = "username", value = "ops@fivestar.in", secret = false }, new { key = "password", value = Password, secret = true } },
        });
        Assert.True(res.Ok, res.ToString());
        return G(res.Data!["item"]!["id"]);
    }

    private List<AuditLog> Audit(Guid tenant, string action) =>
        factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Where(a => a.TenantId == tenant && a.Action == action).OrderBy(a => a.Seq).ToList());

    private static string CodeNow(string secret) => Totp.Compute(secret, Totp.StepOf(DateTime.UtcNow));

    private async Task<string> EnableMfa(TestClient c)
    {
        var setup = await c.Post("/api/v1/me/mfa/setup", new { password = Account });
        Assert.True(setup.Ok, setup.ToString());
        var secret = S(setup.Data!["secret"]).Replace(" ", "");
        Assert.True((await c.Post("/api/v1/me/mfa/enable", new { code = CodeNow(secret) })).Ok);
        factory.WithDb(db => db.Users.IgnoreQueryFilters().Where(u => u.Id == c.UserId).ExecuteUpdate(s => s.SetProperty(u => u.MfaLastStep, 0L)));
        return secret;
    }

    private static Task<ApiResult> Show(TestClient c, Guid item, string? grant = null) =>
        c.Post($"/api/v1/vault/items/{item}/reveal", new { field = "password", copy = false, stepUp = grant });

    private static Task<ApiResult> Verify(TestClient c, string? password, string? code = null) =>
        c.Post("/api/v1/vault/step-up/reveal", new { password, code });

    [Fact]
    public async Task Showing_a_value_without_a_reveal_grant_is_refused_and_recorded_but_copy_still_works()
    {
        var owner = await Owner();
        var id = await Item(owner);
        var none = await Show(owner, id);
        Assert.Equal(HttpStatusCode.Forbidden, none.Status);
        Assert.Equal("REVEAL_VERIFY_REQUIRED", none.ErrorCode);
        Assert.DoesNotContain(Password, none.ToString());
        Assert.Single(Audit(owner.WorkspaceId, "vault.reveal_denied"));
        Assert.Equal("REVEAL_VERIFY_REQUIRED", (await Show(owner, id, "made-up-token")).ErrorCode);

        var copied = await owner.Post($"/api/v1/vault/items/{id}/reveal", new { field = "password", copy = true });
        Assert.True(copied.Ok, copied.ToString());
        Assert.Empty(Audit(owner.WorkspaceId, "vault.revealed"));
    }

    [Fact]
    public async Task Without_two_step_or_a_passkey_there_is_no_way_to_reveal()
    {
        var owner = await Owner();
        var res = await Verify(owner, Account, "123456");
        Assert.Equal(HttpStatusCode.Conflict, res.Status);
        Assert.Equal("REVEAL_SECOND_FACTOR_MISSING", res.ErrorCode);
    }

    [Fact]
    public async Task The_password_alone_is_not_enough()
    {
        var owner = await Owner();
        var id = await Item(owner);
        await EnableMfa(owner);
        var res = await Verify(owner, Account);
        Assert.Equal(HttpStatusCode.Forbidden, res.Status);
        Assert.Equal("REVEAL_SECOND_FACTOR_REQUIRED", res.ErrorCode);
        Assert.Null(res.Data?["token"]);
        Assert.Single(Audit(owner.WorkspaceId, "vault.reveal_verify_failed"));
        // A normal two-step token (no password) does not show values either.
        Assert.Equal("REVEAL_VERIFY_REQUIRED", (await Show(owner, id)).ErrorCode);
    }

    [Fact]
    public async Task A_wrong_password_is_refused_audited_and_counts_towards_lockout()
    {
        var owner = await Owner();
        var secret = await EnableMfa(owner);
        var res = await Verify(owner, "Not-the-password-1", CodeNow(secret));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.Status);
        Assert.Contains("vault.reveal_verify_failed", Audit(owner.WorkspaceId, "vault.reveal_verify_failed").Select(a => a.Action));
        Assert.Contains("password", Audit(owner.WorkspaceId, "vault.reveal_verify_failed").Single().NewValue!);
        Assert.Equal(1, factory.WithDb(db => db.Users.IgnoreQueryFilters().Single(u => u.Id == owner.UserId).FailedLoginCount));
        Assert.Empty(Audit(owner.WorkspaceId, "vault.reveal_verified"));
    }

    [Fact]
    public async Task A_wrong_code_is_refused_and_audited()
    {
        var owner = await Owner();
        await EnableMfa(owner);
        var res = await Verify(owner, Account, "000000");
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.Status);
        Assert.Contains("code", Audit(owner.WorkspaceId, "vault.reveal_verify_failed").Single().NewValue!);
    }

    [Fact]
    public async Task Password_and_a_current_code_give_a_short_grant_that_shows_values_and_each_reveal_is_recorded()
    {
        var owner = await Owner();
        var id = await Item(owner);
        var secret = await EnableMfa(owner);
        var verified = await Verify(owner, Account, CodeNow(secret));
        Assert.True(verified.Ok, verified.ToString());
        var grant = S(verified.Data!["token"]);
        var expires = verified.Data["expiresAt"]!.GetValue<DateTime>();
        Assert.True(expires <= DateTime.UtcNow.AddMinutes(5.1) && expires > DateTime.UtcNow.AddMinutes(4));
        Assert.Single(Audit(owner.WorkspaceId, "vault.reveal_verified"));

        var shown = await Show(owner, id, grant);
        Assert.True(shown.Ok, shown.ToString());
        Assert.Equal(Password, S(shown.Data!["value"]));
        var row = Assert.Single(Audit(owner.WorkspaceId, "vault.revealed"));
        Assert.DoesNotContain(Password, row.NewValue);

        // The grant is stored only as a hash, and it ends by itself.
        Assert.False(factory.WithDb(db => db.StepUpGrants.Any(g => g.TokenHash.Contains(grant))));
        factory.WithDb(db => db.StepUpGrants.Where(g => g.UserId == owner.UserId).ExecuteUpdate(s => s.SetProperty(g => g.ExpiresAt, DateTime.UtcNow.AddMinutes(-1))));
        Assert.Equal("REVEAL_VERIFY_REQUIRED", (await Show(owner, id, grant)).ErrorCode);
    }

    [Fact]
    public async Task A_grant_belongs_to_one_person()
    {
        var owner = await Owner();
        var other = await owner.AddMemberAsync(factory, Domain.Enums.TenantRole.Member, "Omar Other");
        var id = await Item(owner);
        var secret = await EnableMfa(other);
        var grant = S((await Verify(other, Account, CodeNow(secret))).Data!["token"]);
        Assert.Equal("REVEAL_VERIFY_REQUIRED", (await Show(owner, id, grant)).ErrorCode);
    }
}
