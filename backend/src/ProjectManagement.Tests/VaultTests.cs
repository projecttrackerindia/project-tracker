using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Vault;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The one-time codes, the strength meter and the user-name hint, without a server.</summary>
public class VaultPrimitivesTests
{
    private const string Rfc1 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";                                   // "12345678901234567890"
    private const string Rfc256 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA";             // "12345678901234567890123456789012"

    [Fact]
    public void One_time_codes_match_the_RFC_6238_test_vectors()
    {
        var sha1 = VaultTotp.Parse($"otpauth://totp/Test:me?secret={Rfc1}&digits=8")!;
        Assert.Equal(("94287082", 1), VaultTotp.Now(sha1, DateTimeOffset.FromUnixTimeSeconds(59)));
        Assert.Equal("07081804", VaultTotp.Now(sha1, DateTimeOffset.FromUnixTimeSeconds(1111111109)).Code);
        var sha256 = VaultTotp.Parse($"otpauth://totp/Test:me?secret={Rfc256}&digits=8&algorithm=SHA256")!;
        Assert.Equal("46119246", VaultTotp.Now(sha256, DateTimeOffset.FromUnixTimeSeconds(59)).Code);
        // A bare setup key, typed with spaces and in lower case, is six digits every 30 seconds.
        var plain = VaultTotp.Parse("gezd gnbv gy3t qojq gezd gnbv gy3t qojq")!;
        Assert.Equal((6, 30), (plain.Digits, plain.Period));
        Assert.Equal("768147", VaultTotp.Now(plain, DateTimeOffset.FromUnixTimeSeconds(1_800_000_000)).Code);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not base32 at all!")]
    [InlineData("ABC")]                                              // too short to be a real seed
    [InlineData("otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQ")]          // counter-based codes are not supported
    [InlineData("otpauth://totp/x?issuer=nobody")]                    // no secret
    public void Anything_that_is_not_a_usable_seed_is_refused(string text) => Assert.Null(VaultTotp.Parse(text));

    [Fact]
    public void The_strength_meter_ranks_what_attackers_try_first_lowest()
    {
        Assert.Equal(0, PasswordStrength.Score("password"));
        Assert.Equal(0, PasswordStrength.Score("Password@123"));
        Assert.True(PasswordStrength.Score("qwerty1234") <= 1);
        Assert.True(PasswordStrength.Score("aaaaaaaaaaaa") <= 1);
        Assert.True(PasswordStrength.Score("Fivestar2024") <= 1);
        Assert.Equal(0, PasswordStrength.Score("Summer@2024"));
        Assert.True(PasswordStrength.Score("Sunshine") <= 1);
        Assert.Equal(4, PasswordStrength.Score("k8#Vq!2mZ@t9Lw$e"));
        Assert.Equal(4, PasswordStrength.Score("orbit lantern mango river"));
    }

    [Theory]
    [InlineData("ravi@fivestar.in", "r***@fivestar.in")]
    [InlineData("administrator", "a***r")]
    [InlineData("ab", "a*")]
    [InlineData("  ", null)]
    public void A_user_name_is_shown_only_as_a_hint(string name, string? hint) => Assert.Equal(hint, VaultService.Hint(name));
}

/// <summary>
/// The team password vault end to end: what is stored, who can open what, the extra checks before a value leaves the server, what is recorded,
/// and what happens when someone leaves or the workspace key is rotated.
/// </summary>
[Collection("api")]
public class VaultTests(ApiFactory factory)
{
    private const string Password = "Tq7#vLm2!pZx9@Rk";
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static Guid G(JsonNode? n) => Guid.Parse(S(n));

    private async Task<TestClient> Owner(string name = "Vera Vault")
    {
        var owner = await TestClient.RegisterAsync(factory, name);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS", 20);   // seats for the people each test adds
        owner.Ip = "203.0.113.9";
        return owner;
    }

    private static async Task<Guid> MyVault(TestClient c)
    {
        var o = await c.Get("/api/v1/vault/overview");
        Assert.True(o.Ok, o.ToString());
        return G(o.Data!["collections"]!.AsArray().First(x => S(x!["kind"]) == "Personal")!["id"]);
    }

    private static object Login(Guid collection, string title = "Bank portal", string password = Password, string? cls = "Secret", bool useOnly = false, string? totp = null, string? expiresAt = null) => new
    {
        collectionId = collection, kind = "Login", title, url = "https://netbanking.example.in", tags = new[] { "finance" }, @class = cls, useOnly,
        expiresAt,
        fields = new object?[]
        {
            new { key = "username", value = "ravi@fivestar.in", secret = false },
            new { key = "password", value = password, secret = true },
            totp is null ? null : new { key = "totp", value = totp, secret = true },
        }.Where(f => f is not null).ToArray(),
    };

    private static async Task<Guid> AddItem(TestClient c, object body)
    {
        var res = await c.Post("/api/v1/vault/items", body);
        Assert.True(res.Ok, res.ToString());
        return G(res.Data!["item"]!["id"]);
    }

    private async Task<Guid> SharedWith(TestClient owner, params (TestClient Who, string Access)[] people)
    {
        var made = await owner.Post("/api/v1/vault/collections", new { name = "Payments servers", kind = "Shared" });
        Assert.True(made.Ok, made.ToString());
        var id = G(made.Data!["id"]);
        var shares = new List<object> { new { principalType = "User", principalId = owner.UserId, access = "Manage" } };
        shares.AddRange(people.Select(p => (object)new { principalType = "User", principalId = p.Who.UserId, access = p.Access }));
        var saved = await owner.Put($"/api/v1/vault/collections/{id}/shares", new { shares });
        Assert.True(saved.Ok, saved.ToString());
        return id;
    }

    private static Task<ApiResult> Reveal(TestClient c, Guid item, string field = "password", bool copy = false, string? stepUp = null) =>
        c.Post($"/api/v1/vault/items/{item}/reveal", new { field, copy, stepUp });

    private List<AuditLog> Audit(Guid tenant, string action) =>
        factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Where(a => a.TenantId == tenant && a.Action == action).OrderBy(a => a.Seq).ToList());

    private static string CodeNow(string secret) => Totp.Compute(secret, Totp.StepOf(DateTime.UtcNow));

    private async Task<string> EnableMfa(TestClient c)
    {
        var setup = await c.Post("/api/v1/me/mfa/setup", new { password = "Passw0rd!x" });
        Assert.True(setup.Ok, setup.ToString());
        var secret = S(setup.Data!["secret"]).Replace(" ", "");
        Assert.True((await c.Post("/api/v1/me/mfa/enable", new { code = CodeNow(secret) })).Ok);
        return secret;
    }

    private async Task<string> StepUp(TestClient c, string secret)
    {
        // A code is accepted once; the test may need a second check within the same 30 seconds.
        factory.WithDb(db => db.Users.IgnoreQueryFilters().Where(u => u.Id == c.UserId).ExecuteUpdate(s => s.SetProperty(u => u.MfaLastStep, 0L)));
        var res = await c.Post("/api/v1/vault/step-up", new { code = CodeNow(secret) });
        Assert.True(res.Ok, res.ToString());
        return S(res.Data!["token"]);
    }

    /// <summary>The check before a value is shown: the password and a fresh authenticator code, giving a reveal grant.</summary>
    private async Task<string> RevealGrant(TestClient c, string secret)
    {
        factory.WithDb(db => db.Users.IgnoreQueryFilters().Where(u => u.Id == c.UserId).ExecuteUpdate(s => s.SetProperty(u => u.MfaLastStep, 0L)));
        var res = await c.Post("/api/v1/vault/step-up/reveal", new { password = "Passw0rd!x", code = CodeNow(secret) });
        Assert.True(res.Ok, res.ToString());
        return S(res.Data!["token"]);
    }

    // ------------------------------------------------------------------ storage

    [Fact]
    public async Task Secrets_are_stored_encrypted_under_their_own_key_and_no_list_or_item_response_carries_them()
    {
        var owner = await Owner();
        var mine = await MyVault(owner);
        var id = await AddItem(owner, Login(mine, totp: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"));

        var row = factory.WithDb(db => db.VaultItems.IgnoreQueryFilters().Single(i => i.Id == id));
        Assert.DoesNotContain(Password, row.Cipher);
        Assert.DoesNotContain("GEZDGNBV", row.Cipher);
        Assert.DoesNotContain(Password, row.FieldsJson);
        Assert.DoesNotContain("ravi@fivestar.in", row.Cipher + row.FieldsJson + row.UsernameHint);
        Assert.Equal("r***@fivestar.in", row.UsernameHint);
        Assert.True(row.WrappedItemKey.Length > 40);
        Assert.Equal(1, row.KeyVersion);
        Assert.True(row.HasTotp);
        Assert.NotNull(row.PasswordFingerprint);
        Assert.DoesNotContain(Password, row.PasswordFingerprint!);
        Assert.Equal(4, row.Strength);

        foreach (var url in new[] { "/api/v1/vault/overview", "/api/v1/vault/items", $"/api/v1/vault/items/{id}", $"/api/v1/vault/collections/{mine}", $"/api/v1/vault/items/{id}/activity" })
        {
            var res = await owner.Get(url);
            Assert.True(res.Ok, url + " " + res);
            Assert.DoesNotContain(Password, res.ToString());
            Assert.DoesNotContain("GEZDGNBV", res.ToString());
            Assert.Contains("no-store", res.Header("Cache-Control") ?? "");
        }
        // The item page lays out its fields and carries the user name (not secret), never the password.
        var item = (await owner.Get($"/api/v1/vault/items/{id}")).Data!;
        var fields = item["fields"]!.AsArray();
        Assert.Equal("ravi@fivestar.in", S(fields.First(f => S(f!["key"]) == "username")!["value"]));
        Assert.Null(fields.First(f => S(f!["key"]) == "password")!["value"]);
        Assert.True(item["canReveal"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Two_items_with_the_same_password_get_the_same_fingerprint_only_inside_one_workspace()
    {
        var a = await Owner("Asha A");
        var b = await Owner("Bala B");
        var one = await AddItem(a, Login(await MyVault(a), "One"));
        var two = await AddItem(a, Login(await MyVault(a), "Two"));
        var other = await AddItem(b, Login(await MyVault(b), "Elsewhere"));
        var prints = factory.WithDb(db => db.VaultItems.IgnoreQueryFilters().Where(i => i.Id == one || i.Id == two || i.Id == other).ToDictionary(i => i.Id, i => i.PasswordFingerprint));
        Assert.Equal(prints[one], prints[two]);
        Assert.NotEqual(prints[one], prints[other]);
        Assert.Contains("reused", (await a.Get($"/api/v1/vault/items/{one}")).Data!["item"]!["health"]!.AsArray().Select(x => S(x)));
    }

    // ------------------------------------------------------------------ revealing

    [Fact]
    public async Task A_reveal_releases_one_field_and_is_recorded_with_who_which_field_and_from_where_never_the_value()
    {
        var owner = await Owner();
        var id = await AddItem(owner, Login(await MyVault(owner)));
        var grant = await RevealGrant(owner, await EnableMfa(owner));
        var res = await Reveal(owner, id, stepUp: grant);
        Assert.True(res.Ok, res.ToString());
        Assert.Equal(Password, S(res.Data!["value"]));
        Assert.Equal(30, res.Data["clipboardSeconds"]!.GetValue<int>());
        Assert.Contains("no-store", res.Header("Cache-Control") ?? "");

        var row = Assert.Single(Audit(owner.WorkspaceId, "vault.revealed"));
        Assert.Equal(owner.UserId, row.UserId);
        Assert.Equal(id, row.EntityId);
        Assert.Equal("203.0.113.9", row.IpAddress);
        Assert.Contains("Password", row.NewValue);
        Assert.DoesNotContain(Password, row.NewValue);
        var used = factory.WithDb(db => db.VaultItems.IgnoreQueryFilters().Single(i => i.Id == id));
        Assert.Equal(owner.UserId, used.LastUsedBy);

        Assert.Equal("VAULT_NOT_FOUND", (await Reveal(owner, id, "nosuchfield", stepUp: grant)).ErrorCode);
    }

    [Fact]
    public async Task A_retried_reveal_with_an_idempotency_key_is_not_stored_or_replayed()
    {
        var owner = await Owner();
        var id = await AddItem(owner, Login(await MyVault(owner)));
        var grant = await RevealGrant(owner, await EnableMfa(owner));
        owner.Extra["Idempotency-Key"] = "vault-reveal-0001";
        try
        {
            Assert.True((await Reveal(owner, id, stepUp: grant)).Ok);
            Assert.True((await Reveal(owner, id, stepUp: grant)).Ok);
        }
        finally { owner.Extra.Remove("Idempotency-Key"); }
        Assert.Equal(2, Audit(owner.WorkspaceId, "vault.revealed").Count);   // each one checked and recorded
        Assert.False(factory.WithDb(db => db.IdempotencyRecords.Any(r => r.UserId == owner.UserId && r.Key == "vault-reveal-0001")));
        Assert.False(factory.WithDb(db => db.IdempotencyRecords.Where(r => r.ResponseBody != null).AsEnumerable().Any(r => r.ResponseBody!.Contains(Password))));
    }

    [Fact]
    public async Task A_use_only_item_can_be_copied_into_a_form_but_never_shown()
    {
        var owner = await Owner();
        var id = await AddItem(owner, Login(await MyVault(owner), useOnly: true));
        var shown = await Reveal(owner, id);
        Assert.Equal(HttpStatusCode.Forbidden, shown.Status);
        Assert.Equal("VAULT_USE_ONLY", shown.ErrorCode);
        Assert.DoesNotContain(Password, shown.ToString());
        Assert.Single(Audit(owner.WorkspaceId, "vault.reveal_denied"));

        var copied = await Reveal(owner, id, copy: true);
        Assert.True(copied.Ok, copied.ToString());
        Assert.Equal(Password, S(copied.Data!["value"]));
        Assert.Single(Audit(owner.WorkspaceId, "vault.copied"));
        Assert.False((await owner.Get($"/api/v1/vault/items/{id}")).Data!["canReveal"]!.GetValue<bool>());
    }

    [Fact]
    public async Task One_time_codes_are_computed_on_the_server_and_the_seed_is_not_sent()
    {
        const string seed = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
        var owner = await Owner();
        var id = await AddItem(owner, Login(await MyVault(owner), totp: seed));
        var res = await owner.Post($"/api/v1/vault/items/{id}/totp", new { });
        Assert.True(res.Ok, res.ToString());
        var code = S(res.Data!["code"]);
        var now = Totp.StepOf(DateTime.UtcNow);
        Assert.Contains(code, new[] { Totp.Compute(seed, now - 1), Totp.Compute(seed, now), Totp.Compute(seed, now + 1) });
        Assert.InRange(res.Data["secondsLeft"]!.GetValue<int>(), 1, 30);
        Assert.DoesNotContain(seed, res.ToString());
        Assert.Single(Audit(owner.WorkspaceId, "vault.totp_used"));

        var bad = await owner.Post("/api/v1/vault/items", Login(await MyVault(owner), "Bad seed", totp: "not-a-seed!"));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, bad.Status);
    }

    // ------------------------------------------------------------------ who can open what

    [Fact]
    public async Task A_personal_vault_is_its_owners_alone_and_no_admin_can_open_it()
    {
        var owner = await Owner();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mira Member");
        var theirs = await AddItem(member, Login(await MyVault(member), "Mira's email"));
        var theirVault = factory.WithDb(db => db.VaultCollections.IgnoreQueryFilters().Single(c => c.OwnerUserId == member.UserId && c.Kind == VaultCollectionKind.Personal).Id);

        Assert.Equal(HttpStatusCode.NotFound, (await owner.Get($"/api/v1/vault/items/{theirs}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await Reveal(owner, theirs)).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Get($"/api/v1/vault/collections/{theirVault}")).Status);
        Assert.DoesNotContain("Mira's email", (await owner.Get("/api/v1/vault/items")).ToString());
        Assert.DoesNotContain(theirVault.ToString(), (await owner.Get("/api/v1/vault/overview")).ToString());
        var breakGlass = await owner.Post($"/api/v1/vault/collections/{theirVault}/admin-access", new { reason = "I need to look at this vault now please", stepUp = "x" });
        Assert.Equal("VAULT_PERSONAL", breakGlass.ErrorCode);
        Assert.Equal("VAULT_PERSONAL", (await member.Put($"/api/v1/vault/collections/{theirVault}/shares", new { shares = new[] { new { principalType = "User", principalId = owner.UserId, access = "View" } } })).ErrorCode);
    }

    [Fact]
    public async Task A_shared_collection_follows_its_access_list_view_use_only_and_nothing()
    {
        var owner = await Owner();
        var viewer = await owner.AddMemberAsync(factory, TenantRole.Member, "Vikram Viewer");
        var user = await owner.AddMemberAsync(factory, TenantRole.Member, "Uma UseOnly");
        var outsider = await owner.AddMemberAsync(factory, TenantRole.Admin, "Arjun Admin");
        var shared = await SharedWith(owner, (viewer, "View"), (user, "UseOnly"));
        var id = await AddItem(owner, Login(shared, "Payments DB"));

        Assert.Equal(Password, S((await Reveal(viewer, id, copy: true)).Data!["value"]));
        Assert.Equal("VAULT_DENIED", (await viewer.Put($"/api/v1/vault/items/{id}", Login(shared, "Renamed"))).ErrorCode);   // view is not manage

        var shown = await Reveal(user, id);
        Assert.Equal("VAULT_USE_ONLY", shown.ErrorCode);
        Assert.True((await Reveal(user, id, copy: true)).Ok);
        Assert.False((await user.Get($"/api/v1/vault/items/{id}")).Data!["canReveal"]!.GetValue<bool>());

        // Not on the list: not even the item's existence is confirmed, admin or not.
        Assert.Equal(HttpStatusCode.NotFound, (await Reveal(outsider, id)).Status);
        Assert.Empty((await outsider.Get($"/api/v1/vault/items?collectionId={shared}")).Data!.AsArray());

        // A share can end by itself.
        factory.WithDb(db => db.VaultShares.IgnoreQueryFilters().Where(s => s.PrincipalId == viewer.UserId).ExecuteUpdate(s => s.SetProperty(x => x.ExpiresAt, DateTime.UtcNow.AddMinutes(-1))));
        Assert.Equal(HttpStatusCode.NotFound, (await Reveal(viewer, id)).Status);

        // The list can never be left without a manager.
        var noManager = await owner.Put($"/api/v1/vault/collections/{shared}/shares", new { shares = new[] { new { principalType = "User", principalId = viewer.UserId, access = "View" } } });
        Assert.Equal("VAULT_NO_MANAGER", noManager.ErrorCode);
    }

    [Fact]
    public async Task Teams_and_roles_can_be_given_access_and_guests_never_use_the_vault()
    {
        var owner = await Owner();
        var manager = await owner.AddMemberAsync(factory, TenantRole.Manager, "Meena Manager");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mohan Member");
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gita Guest");
        var made = await owner.Post("/api/v1/vault/collections", new { name = "Leads only", kind = "Shared" });
        var id = G(made.Data!["id"]);
        var saved = await owner.Put($"/api/v1/vault/collections/{id}/shares", new { shares = new object[]
        {
            new { principalType = "User", principalId = owner.UserId, access = "Manage" },
            new { principalType = "Role", role = "Manager", access = "View" },
        } });
        Assert.True(saved.Ok, saved.ToString());
        var item = await AddItem(owner, Login(id, "Release signing key"));
        Assert.True((await Reveal(manager, item, copy: true)).Ok);
        Assert.Equal(HttpStatusCode.NotFound, (await Reveal(member, item)).Status);

        Assert.Equal(HttpStatusCode.Forbidden, (await guest.Get("/api/v1/vault/overview")).Status);
        var toGuest = await owner.Put($"/api/v1/vault/collections/{id}/shares", new { shares = new object[]
        {
            new { principalType = "User", principalId = owner.UserId, access = "Manage" },
            new { principalType = "User", principalId = guest.UserId, access = "View" },
        } });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, toGuest.Status);
    }

    // ------------------------------------------------------------------ the extra checks

    [Fact]
    public async Task Confidential_items_need_a_fresh_two_step_check_made_for_the_vault()
    {
        var owner = await Owner();
        var id = await AddItem(owner, Login(await MyVault(owner), "Root account", cls: "Confidential"));
        Assert.True((await owner.Get($"/api/v1/vault/items/{id}")).Data!["needsStepUp"]!.GetValue<bool>());
        var none = await Reveal(owner, id);
        Assert.Equal("STEP_UP_REQUIRED", none.ErrorCode);
        Assert.Equal("STEP_UP_REQUIRED", (await Reveal(owner, id, stepUp: "made-up")).ErrorCode);
        Assert.Equal(2, Audit(owner.WorkspaceId, "vault.reveal_denied").Count);

        var secret = await EnableMfa(owner);
        var token = await StepUp(owner, secret);
        var ok = await Reveal(owner, id, copy: true, stepUp: token);
        Assert.True(ok.Ok, ok.ToString());
        Assert.Equal(Password, S(ok.Data!["value"]));

        // The workspace can ask for it on everything.
        var plain = await AddItem(owner, Login(await MyVault(owner), "Ordinary"));
        Assert.True((await owner.Put("/api/v1/vault/policy", new { stepUpAlways = true, clipboardSeconds = 20, sharedAdminsOnly = false })).Ok);
        Assert.Equal("STEP_UP_REQUIRED", (await Reveal(owner, plain)).ErrorCode);
        var again = await Reveal(owner, plain, copy: true, stepUp: token);
        Assert.Equal(20, again.Data!["clipboardSeconds"]!.GetValue<int>());
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put("/api/v1/vault/policy", new { stepUpAlways = true, clipboardSeconds = 2, sharedAdminsOnly = false })).Status);
    }

    [Fact]
    public async Task Opening_many_different_items_quickly_pauses_the_person_and_tells_the_admins()
    {
        var owner = await Owner();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Quick Quinn");
        var shared = await SharedWith(owner, (member, "View"));
        var items = new List<Guid>();
        for (var i = 0; i < VaultService.UnusualDistinctItems; i++) items.Add(await AddItem(owner, Login(shared, $"Server {i}")));

        for (var i = 0; i < VaultService.UnusualDistinctItems - 1; i++) Assert.True((await Reveal(member, items[i], copy: true)).Ok, $"item {i}");
        Assert.True((await Reveal(member, items[0], copy: true)).Ok);   // the same item again is not "another item"
        var paused = await Reveal(member, items[^1], copy: true);
        Assert.Equal(HttpStatusCode.Forbidden, paused.Status);
        Assert.Equal("STEP_UP_REQUIRED", paused.ErrorCode);
        Assert.NotEmpty(Audit(owner.WorkspaceId, "vault.unusual_activity"));
        Assert.True(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Any(n => n.UserId == owner.UserId && n.Title.StartsWith("Unusual vault use: Quick Quinn"))));

        var secret = await EnableMfa(member);
        Assert.True((await Reveal(member, items[^1], copy: true, stepUp: await StepUp(member, secret))).Ok);
    }

    [Fact]
    public async Task Changing_a_secret_keeps_the_earlier_value_encrypted_and_reading_it_always_needs_a_two_step_check()
    {
        var owner = await Owner();
        var mine = await MyVault(owner);
        var id = await AddItem(owner, Login(mine));
        var changed = await owner.Put($"/api/v1/vault/items/{id}", Login(mine, password: "N3w!Passw0rd#Ax7q"));
        Assert.True(changed.Ok, changed.ToString());
        Assert.Equal("N3w!Passw0rd#Ax7q", S((await Reveal(owner, id, copy: true)).Data!["value"]));

        var versions = changed.Data!["versions"]!.AsArray();
        var v = G(Assert.Single(versions)!["id"]);
        var stored = factory.WithDb(db => db.VaultItemVersions.IgnoreQueryFilters().Single(x => x.Id == v));
        Assert.DoesNotContain(Password, stored.Cipher);

        Assert.Equal("STEP_UP_REQUIRED", (await owner.Post($"/api/v1/vault/items/{id}/versions/{v}/reveal", new { field = "password" })).ErrorCode);
        var secret = await EnableMfa(owner);
        var old = await owner.Post($"/api/v1/vault/items/{id}/versions/{v}/reveal", new { field = "password", stepUp = await StepUp(owner, secret) });
        Assert.True(old.Ok, old.ToString());
        Assert.Equal(Password, S(old.Data!["value"]));

        // Changing only the title keeps the value and makes no new version.
        var renamed = await owner.Put($"/api/v1/vault/items/{id}", new
        {
            collectionId = mine, kind = "Login", title = "Bank portal (main)", @class = "Secret",
            fields = new object[] { new { key = "username", keep = true }, new { key = "password", keep = true } },
        });
        Assert.True(renamed.Ok, renamed.ToString());
        Assert.Single(renamed.Data!["versions"]!.AsArray());
    }

    [Fact]
    public async Task Breached_and_weak_passwords_are_flagged_without_the_password_leaving_the_server()
    {
        factory.Pwned.Breached["Summer@2024"] = 4321;
        var owner = await Owner();
        var id = await AddItem(owner, Login(await MyVault(owner), "Old router", password: "Summer@2024"));
        var item = (await owner.Get($"/api/v1/vault/items/{id}")).Data!["item"]!;
        Assert.True(item["breached"]!.GetValue<bool>());
        Assert.Contains("breached", item["health"]!.AsArray().Select(x => S(x)));
        Assert.Contains("weak", item["health"]!.AsArray().Select(x => S(x)));
        Assert.All(factory.Pwned.Asked, url => Assert.DoesNotContain("Summer", url));   // only a five-character hash prefix is sent

        var check = await owner.Post("/api/v1/vault/check", new { password = "Summer@2024" });
        Assert.Equal(4321, check.Data!["breachCount"]!.GetValue<int>());
        Assert.True((await owner.Get("/api/v1/vault/items?health=breached")).Data!.AsArray().Any(x => G(x!["id"]) == id));
    }

    // ------------------------------------------------------------------ files, import, bin

    [Fact]
    public async Task Files_are_kept_encrypted_and_come_back_only_as_a_checked_download()
    {
        var owner = await Owner();
        var id = await AddItem(owner, Login(await MyVault(owner)));
        var content = Encoding.UTF8.GetBytes("-----BEGIN OPENSSH PRIVATE KEY----- secret-key-material");
        var up = await owner.Upload($"/api/v1/vault/items/{id}/attachments", "deploy.pem", content);
        Assert.True(up.Ok, up.ToString());
        var file = G(up.Data!["id"]);
        var stored = factory.WithDb(db => db.VaultAttachments.IgnoreQueryFilters().Single(a => a.Id == file));
        Assert.DoesNotContain("secret-key-material", Encoding.UTF8.GetString(stored.Cipher));

        using var req = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/vault/attachments/{file}/download") { Content = JsonContent.Create(new { }) };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", owner.Token);
        using var res = await owner.Http.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(content, await res.Content.ReadAsByteArrayAsync());
        Assert.Equal("application/octet-stream", res.Content.Headers.ContentType?.MediaType);
        Assert.Contains("no-store", res.Headers.CacheControl?.ToString() ?? "");
        Assert.Contains(Audit(owner.WorkspaceId, "vault.revealed"), a => a.NewValue!.Contains("deploy.pem"));

        var big = await owner.Upload($"/api/v1/vault/items/{id}/attachments", "big.bin", new byte[VaultService.MaxAttachmentBytes + 1]);
        Assert.False(big.Ok);
    }

    [Fact]
    public async Task An_export_from_another_password_manager_is_imported_encrypted()
    {
        var owner = await Owner();
        var mine = await MyVault(owner);
        var res = await owner.Post("/api/v1/vault/import", new
        {
            collectionId = mine,
            rows = new object[]
            {
                new { title = "GitHub", url = "https://github.com", username = "ravi", password = "Gh!7xQ2#kLm9pR4z" },
                new { title = (string?)null, url = "https://mail.example.in", username = "ravi", password = "password1" },
                new { title = "Nothing here", url = "https://x.example", username = "ravi", password = "" },
            },
        });
        Assert.True(res.Ok, res.ToString());
        Assert.Equal(2, res.Data!["imported"]!.GetValue<int>());
        Assert.Equal(1, res.Data["skipped"]!.GetValue<int>());
        Assert.Equal(1, res.Data["weak"]!.GetValue<int>());
        var titles = (await owner.Get($"/api/v1/vault/items?collectionId={mine}")).Data!.AsArray().Select(x => S(x!["title"])).ToList();
        Assert.Contains("GitHub", titles);
        Assert.Contains("mail.example.in", titles);
        Assert.DoesNotContain(factory.WithDb(db => db.VaultItems.IgnoreQueryFilters().Where(i => i.CollectionId == mine).Select(i => i.Cipher).ToList()), c => c.Contains("Gh!7xQ2"));
    }

    [Fact]
    public async Task A_deleted_item_waits_in_the_bin_and_is_destroyed_with_its_history_after_thirty_days()
    {
        var owner = await Owner();
        var mine = await MyVault(owner);
        var id = await AddItem(owner, Login(mine));
        Assert.True((await owner.Put($"/api/v1/vault/items/{id}", Login(mine, password: "An0ther!Value#9z"))).Ok);
        Assert.True((await owner.Delete($"/api/v1/vault/items/{id}")).Ok);
        Assert.Equal(HttpStatusCode.NotFound, (await Reveal(owner, id)).Status);
        Assert.Contains((await owner.Get("/api/v1/vault/items?bin=true")).Data!.AsArray(), x => G(x!["id"]) == id);
        Assert.True((await owner.Post($"/api/v1/vault/items/{id}/restore")).Ok);
        Assert.True((await Reveal(owner, id, copy: true)).Ok);

        Assert.True((await owner.Delete($"/api/v1/vault/items/{id}")).Ok);
        factory.WithDb(db => db.VaultItems.IgnoreQueryFilters().Where(i => i.Id == id).ExecuteUpdate(s => s.SetProperty(i => i.DeletedAt, DateTime.UtcNow.AddDays(-31))));
        using (var scope = factory.Services.CreateScope())
            await scope.ServiceProvider.GetRequiredService<VaultJobs>().PurgeAsync();
        Assert.False(factory.WithDb(db => db.VaultItems.IgnoreQueryFilters().Any(i => i.Id == id)));
        Assert.False(factory.WithDb(db => db.VaultItemVersions.IgnoreQueryFilters().Any(v => v.ItemId == id)));
    }

    // ------------------------------------------------------------------ people leaving, reminders, key rotation

    [Fact]
    public async Task When_someone_leaves_their_vault_locks_and_what_they_used_is_marked_to_be_changed_with_an_action_item()
    {
        var owner = await Owner();
        var leaver = await owner.AddMemberAsync(factory, TenantRole.Member, "Lalit Leaver");
        var shared = await SharedWith(owner, (leaver, "View"));
        var used = await AddItem(owner, Login(shared, "Production DB"));
        var untouched = await AddItem(owner, Login(shared, "Staging DB"));
        var personal = await AddItem(leaver, Login(await MyVault(leaver), "Lalit's own"));
        Assert.True((await Reveal(leaver, used, copy: true)).Ok);

        Assert.True((await owner.Delete($"/api/v1/workspace/members/{leaver.UserId}")).Ok);

        var items = factory.WithDb(db => db.VaultItems.IgnoreQueryFilters().Where(i => i.Id == used || i.Id == untouched).ToDictionary(i => i.Id));
        Assert.Contains("Lalit Leaver", items[used].RotationReason);
        Assert.Null(items[untouched].RotationReason);
        Assert.True(factory.WithDb(db => db.WorkTasks.IgnoreQueryFilters().Any(t => t.TenantId == owner.WorkspaceId && t.Title.Contains("Production DB") && t.AssigneeId == owner.UserId)));
        Assert.True(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Any(n => n.UserId == owner.UserId && n.Title.Contains("Production DB"))));
        Assert.False(factory.WithDb(db => db.VaultShares.IgnoreQueryFilters().Any(s => s.PrincipalId == leaver.UserId)));
        var theirVault = factory.WithDb(db => db.VaultCollections.IgnoreQueryFilters().Single(c => c.OwnerUserId == leaver.UserId && c.TenantId == owner.WorkspaceId));
        Assert.NotNull(theirVault.LockedAt);
        Assert.Contains("rotate", (await owner.Get($"/api/v1/vault/items/{used}")).Data!["item"]!["health"]!.AsArray().Select(x => S(x)));

        // Changing it clears the flag.
        Assert.True((await owner.Put($"/api/v1/vault/items/{used}", Login(shared, "Production DB", password: "Fr3sh!Value#2026x"))).Ok);
        Assert.Null(factory.WithDb(db => db.VaultItems.IgnoreQueryFilters().Single(i => i.Id == used).RotationReason));

        // The locked vault is destroyed after the grace period, with its items.
        factory.WithDb(db => db.VaultCollections.IgnoreQueryFilters().Where(c => c.Id == theirVault.Id).ExecuteUpdate(s => s.SetProperty(c => c.LockedAt, DateTime.UtcNow.AddDays(-31))));
        using (var scope = factory.Services.CreateScope())
            await scope.ServiceProvider.GetRequiredService<VaultJobs>().PurgeAsync();
        Assert.False(factory.WithDb(db => db.VaultItems.IgnoreQueryFilters().Any(i => i.Id == personal)));
        Assert.False(factory.WithDb(db => db.VaultCollections.IgnoreQueryFilters().Any(c => c.Id == theirVault.Id)));
    }

    [Fact]
    public async Task Owners_are_told_before_a_credential_expires_and_a_webhook_event_says_which_never_its_value()
    {
        var owner = await Owner();
        var id = await AddItem(owner, Login(await MyVault(owner), "Domain registrar", expiresAt: DateTime.UtcNow.AddDays(3).ToString("O")));
        using (var scope = factory.Services.CreateScope())
            await scope.ServiceProvider.GetRequiredService<VaultJobs>().RemindAsync(factory.Services);
        var notice = factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == owner.UserId && n.Link == $"/vault?item={id}").ToList());
        Assert.Contains(notice, n => n.Title.Contains("Domain registrar") && n.Title.Contains("should be changed"));
        var activity = factory.WithDb(db => db.Activities.IgnoreQueryFilters().Single(a => a.EntityId == id && a.Action == "vault.rotation_due"));
        Assert.DoesNotContain(Password, activity.Summary);
        // Told once, not every night.
        using (var scope = factory.Services.CreateScope())
            await scope.ServiceProvider.GetRequiredService<VaultJobs>().RemindAsync(factory.Services);
        Assert.Single(factory.WithDb(db => db.Activities.IgnoreQueryFilters().Where(a => a.EntityId == id && a.Action == "vault.rotation_due").ToList()));
    }

    [Fact]
    public async Task Rotating_the_workspace_key_rewraps_every_item_key_and_values_still_open()
    {
        var owner = await Owner();
        var mine = await MyVault(owner);
        var id = await AddItem(owner, Login(mine));
        Assert.True((await owner.Put($"/api/v1/vault/items/{id}", Login(mine, password: "Sec0nd!Value#77q"))).Ok);
        var up = await owner.Upload($"/api/v1/vault/items/{id}/attachments", "note.txt", Encoding.UTF8.GetBytes("file body"));
        Assert.True(up.Ok, up.ToString());
        var before = factory.WithDb(db => db.VaultItems.IgnoreQueryFilters().Single(i => i.Id == id));

        var rotate = await owner.Post("/api/v1/document-security/rotate-key");
        Assert.True(rotate.Ok, rotate.ToString());

        var after = factory.WithDb(db => db.VaultItems.IgnoreQueryFilters().Single(i => i.Id == id));
        Assert.Equal(2, after.KeyVersion);
        Assert.NotEqual(before.WrappedItemKey, after.WrappedItemKey);
        Assert.Equal(before.Cipher, after.Cipher);   // only the item key is re-wrapped
        Assert.All(factory.WithDb(db => db.VaultItemVersions.IgnoreQueryFilters().Where(v => v.ItemId == id).ToList()), v => Assert.Equal(2, v.KeyVersion));
        Assert.All(factory.WithDb(db => db.VaultAttachments.IgnoreQueryFilters().Where(a => a.ItemId == id).ToList()), a => Assert.Equal(2, a.KeyVersion));
        Assert.Equal("Sec0nd!Value#77q", S((await Reveal(owner, id, copy: true)).Data!["value"]));
    }

    [Fact]
    public async Task A_vault_admin_can_take_announced_time_boxed_access_to_a_shared_collection_with_a_reason()
    {
        var owner = await Owner();
        var keeper = await owner.AddMemberAsync(factory, TenantRole.Manager, "Kavya Keeper");
        var admin = await owner.AddMemberAsync(factory, TenantRole.Admin, "Anil Admin");
        var made = await keeper.Post("/api/v1/vault/collections", new { name = "Ops break-glass", kind = "Shared" });
        Assert.True(made.Ok, made.ToString());
        var id = G(made.Data!["id"]);
        var item = await AddItem(keeper, Login(id, "Firewall admin"));
        Assert.Equal(HttpStatusCode.NotFound, (await Reveal(admin, item)).Status);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await admin.Post($"/api/v1/vault/collections/{id}/admin-access", new { reason = "short" })).Status);
        Assert.Equal("STEP_UP_REQUIRED", (await admin.Post($"/api/v1/vault/collections/{id}/admin-access", new { reason = "Kavya is on leave and the firewall is down" })).ErrorCode);
        var secret = await EnableMfa(admin);
        var took = await admin.Post($"/api/v1/vault/collections/{id}/admin-access", new { reason = "Kavya is on leave and the firewall is down", stepUp = await StepUp(admin, secret) });
        Assert.True(took.Ok, took.ToString());
        Assert.True((await Reveal(admin, item, copy: true)).Ok);
        Assert.True(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Any(n => n.UserId == keeper.UserId && n.Title.Contains("took admin access to Ops break-glass"))));
        var share = factory.WithDb(db => db.VaultShares.IgnoreQueryFilters().Single(s => s.CollectionId == id && s.PrincipalId == admin.UserId));
        Assert.NotNull(share.ExpiresAt);
        Assert.InRange(share.ExpiresAt!.Value, DateTime.UtcNow.AddHours(23), DateTime.UtcNow.AddHours(25));
        Assert.Single(Audit(owner.WorkspaceId, "vault.admin_access"));

        // A plain member is not a vault admin.
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Manoj Member");
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Post($"/api/v1/vault/collections/{id}/admin-access", new { reason = "Kavya is on leave and the firewall is down" })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get($"/api/v1/vault/access-review/{keeper.UserId}")).Status);
        var review = await owner.Get($"/api/v1/vault/access-review/{admin.UserId}");
        Assert.True(review.Ok, review.ToString());
        Assert.Contains(review.Data!["used"]!.AsArray(), u => S(u!["title"]) == "Firewall admin");
    }
}
