using System.Net;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Vault;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Names a pipeline gets, and the branch and tag patterns, without a server.</summary>
public class VaultMachinePrimitivesTests
{
    [Theory]
    [InlineData("Stripe secret key", VaultItemKind.ApiKey, "key", "STRIPE_SECRET_KEY")]
    [InlineData("Stripe secret key", VaultItemKind.ApiKey, "secret", "STRIPE_SECRET_KEY_SECRET")]
    [InlineData("Payments DB", VaultItemKind.Database, "password", "PAYMENTS_DB_PASSWORD")]
    [InlineData("Payments DB", VaultItemKind.Database, "connectionString", "PAYMENTS_DB_CONNECTION_STRING")]
    [InlineData("Résumé — store (prod)", VaultItemKind.Login, "password", "RESUME_STORE_PROD_PASSWORD")]
    [InlineData("2FA backup", VaultItemKind.Note, "note", "SECRET_2FA_BACKUP_NOTE")]
    public void Each_value_gets_a_predictable_variable_name(string title, VaultItemKind kind, string field, string name) => Assert.Equal(name, VaultService.EnvName(title, kind, field));

    [Theory]
    [InlineData("refs/heads/main", "refs/heads/main", true)]
    [InlineData("refs/heads/main", "refs/heads/main-old", false)]
    [InlineData("refs/heads/release/*", "refs/heads/release/1.4", true)]
    [InlineData("refs/heads/release/*", "refs/heads/release/1/4", false)]
    [InlineData("refs/heads/release/**", "refs/heads/release/1/4", true)]
    [InlineData("refs/tags/v*", "refs/tags/v2.0.1", true)]
    [InlineData("refs/tags/v*", "refs/heads/v2", false)]
    [InlineData("*", "refs/pull/7/merge", true)]
    public void Branch_and_tag_patterns_match_as_written(string pattern, string gitRef, bool ok) => Assert.Equal(ok, MachineAccess.RefMatches(pattern, gitRef));
}

/// <summary>
/// GitHub Actions reading a guarded collection with the run's own OpenID Connect token: only for the repository, branch and environment
/// allowed, only with a token GitHub signed for this workspace, each token once — and the repository is pinned by id on first use.
/// </summary>
[Collection("api")]
public class VaultMachineTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static Guid G(JsonNode? n) => Guid.Parse(S(n));
    private const string Repo = "fivestar/payments-api";

    private async Task<TestClient> Owner()
    {
        var owner = await TestClient.RegisterAsync(factory, "Mona Machine");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS", 20);
        owner.Ip = "203.0.113.9";
        return owner;
    }

    private static string CodeNow(string secret) => Totp.Compute(secret, Totp.StepOf(DateTime.UtcNow));
    private async Task<string> StepUp(TestClient c)
    {
        var setup = await c.Post("/api/v1/me/mfa/setup", new { password = "Passw0rd!x" });
        var secret = S(setup.Data!["secret"]).Replace(" ", "");
        Assert.True((await c.Post("/api/v1/me/mfa/enable", new { code = CodeNow(secret) })).Ok);
        factory.WithDb(db => db.Users.IgnoreQueryFilters().Where(u => u.Id == c.UserId).ExecuteUpdate(s => s.SetProperty(u => u.MfaLastStep, 0L)));
        var res = await c.Post("/api/v1/vault/step-up", new { code = CodeNow(secret) });
        Assert.True(res.Ok, res.ToString());
        return S(res.Data!["token"]);
    }

    private static async Task Item(TestClient c, Guid collection, string kind, string title, params (string Key, string Value, bool Secret)[] fields)
    {
        var res = await c.Post("/api/v1/vault/items", new
        {
            collectionId = collection, kind, title, url = (string?)null, tags = Array.Empty<string>(), @class = "Secret", useOnly = false,
            fields = fields.Select(f => new { key = f.Key, value = f.Value, secret = f.Secret }).ToArray(),
        });
        Assert.True(res.Ok, res.ToString());
    }

    private static async Task<ApiResult> WithBearer(TestClient anon, Guid binding, string token)
    {
        anon.Extra["Authorization"] = $"Bearer {token}";
        try { return await anon.Send(HttpMethod.Post, $"/api/v1/machine/github/{binding}/secrets", new { }, true); }
        finally { anon.Extra.Remove("Authorization"); }
    }

    [Fact]
    public async Task A_pipeline_reads_a_guarded_collection_only_with_a_matching_signed_token_used_once()
    {
        var owner = await Owner();
        var made = await owner.Post("/api/v1/vault/collections", new { name = "CI secrets", kind = "Shared" });
        var col = G(made.Data!["id"]);
        await Item(owner, col, "ApiKey", "Stripe secret key", ("key", "sk_live_51Hq", true));
        await Item(owner, col, "Database", "Payments DB", ("host", "db.internal", false), ("username", "payuser", false), ("password", "Db!Pass#2026", true));

        var body = new { repository = Repo, refPattern = "main", environment = "production", label = "Deploy" };
        Assert.Equal("STEP_UP_REQUIRED", (await owner.Post($"/api/v1/vault/collections/{col}/machines", body)).ErrorCode);
        var token = await StepUp(owner);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"/api/v1/vault/collections/{col}/machines", new { repository = "not a repo", stepUp = token })).Status);
        var personal = G((await owner.Get("/api/v1/vault/overview")).Data!["collections"]!.AsArray().First(c => S(c!["kind"]) == "Personal")!["id"]);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"/api/v1/vault/collections/{personal}/machines", new { repository = Repo, stepUp = token })).Status);
        var added = await owner.Post($"/api/v1/vault/collections/{col}/machines", new { repository = "https://github.com/" + Repo, refPattern = "main", environment = "production", label = "Deploy", stepUp = token });
        Assert.True(added.Ok, added.ToString());
        var binding = G(added.Data!["id"]);
        Assert.Equal(Repo, S(added.Data["repository"]));
        Assert.Equal("refs/heads/main", S(added.Data["refPattern"]));
        var audience = S(added.Data["audience"]);
        Assert.Equal($"projecttracker-vault:{owner.WorkspaceId}", audience);
        Assert.Equal(new[] { "PAYMENTS_DB_HOST", "PAYMENTS_DB_PASSWORD", "PAYMENTS_DB_USERNAME", "STRIPE_SECRET_KEY" }, added.Data["variables"]!.AsArray().Select(v => S(v)).ToArray());
        Assert.DoesNotContain("sk_live_51Hq", added.ToString());
        Assert.Single((await owner.Get($"/api/v1/vault/collections/{col}/machines")).Data!.AsArray());

        var anon = new TestClient(factory);
        var oidc = factory.GitHubOidc;
        Assert.Equal("MACHINE_DENIED", (await WithBearer(anon, binding, "not.a.token")).ErrorCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.Send(HttpMethod.Post, $"/api/v1/machine/github/{binding}/secrets", new { }, true)).Status);

        // A matching run: every value, by name; recorded; the repository's id is pinned.
        var run = oidc.Mint(Repo, audience, environment: "production");
        var ok = await WithBearer(anon, binding, run);
        Assert.True(ok.Ok, ok.ToString());
        var vars = ok.Data!["variables"]!.AsArray().ToDictionary(v => S(v!["name"]), v => S(v!["value"]));
        Assert.Equal("sk_live_51Hq", vars["STRIPE_SECRET_KEY"]);
        Assert.Equal("Db!Pass#2026", vars["PAYMENTS_DB_PASSWORD"]);
        Assert.Equal("payuser", vars["PAYMENTS_DB_USERNAME"]);
        Assert.Contains("no-store", ok.Header("Cache-Control") ?? "");
        Assert.Equal("123456", factory.WithDb(db => db.VaultMachineBindings.IgnoreQueryFilters().Single(m => m.Id == binding).RepositoryId));
        Assert.Single(factory.WithDb(db => db.AuditLogs.Where(a => a.TenantId == owner.WorkspaceId && a.Action == "vault.machine_read").ToList()));
        Assert.DoesNotContain("sk_live_51Hq", string.Join("\n", factory.WithDb(db => db.AuditLogs.Where(a => a.TenantId == owner.WorkspaceId).Select(a => a.NewValue ?? "").ToList())));

        // The same token again; and every way a token can be wrong.
        Assert.Contains("already used", (await WithBearer(anon, binding, run)).ToString());
        Assert.Equal("MACHINE_DENIED", (await WithBearer(anon, binding, oidc.Mint(Repo, "projecttracker-vault:someone-else", environment: "production"))).ErrorCode);
        Assert.Equal("MACHINE_DENIED", (await WithBearer(anon, binding, oidc.Mint("fivestar/other", audience, environment: "production"))).ErrorCode);
        Assert.Equal("MACHINE_DENIED", (await WithBearer(anon, binding, oidc.Mint(Repo, audience, gitRef: "refs/heads/feature-x", environment: "production"))).ErrorCode);
        Assert.Equal("MACHINE_DENIED", (await WithBearer(anon, binding, oidc.Mint(Repo, audience, environment: "staging"))).ErrorCode);
        Assert.Equal("MACHINE_DENIED", (await WithBearer(anon, binding, oidc.Mint(Repo, audience))).ErrorCode);   // no environment
        Assert.Contains("replaced", (await WithBearer(anon, binding, oidc.Mint(Repo, audience, environment: "production", repositoryId: "999"))).ToString());
        Assert.Contains("expired", (await WithBearer(anon, binding, oidc.Mint(Repo, audience, environment: "production", age: TimeSpan.FromMinutes(30)))).ToString());
        using var forger = RSA.Create(2048);
        Assert.Contains("signature", (await WithBearer(anon, binding, oidc.Mint(Repo, audience, environment: "production", signer: forger))).ToString());
        Assert.Equal("MACHINE_DENIED", (await WithBearer(anon, binding, oidc.Mint(Repo, audience, environment: "production", alg: "HS256"))).ErrorCode);
        Assert.Equal("MACHINE_DENIED", (await WithBearer(anon, binding, oidc.Mint(Repo, audience, environment: "production", change: c => c["iss"] = "https://evil.example"))).ErrorCode);
        Assert.Single(factory.WithDb(db => db.AuditLogs.Where(a => a.TenantId == owner.WorkspaceId && a.Action == "vault.machine_read").ToList()));

        // Removed: nothing more.
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Delete($"/api/v1/vault/machines/{binding}")).Status);
        Assert.Contains("removed", (await WithBearer(anon, binding, oidc.Mint(Repo, audience, environment: "production"))).ToString());
        Assert.Empty((await owner.Get($"/api/v1/vault/collections/{col}/machines")).Data!.AsArray());
    }
}
