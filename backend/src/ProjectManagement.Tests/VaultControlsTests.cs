using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Common;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The controls around guarded values: decoys that raise the alarm, the two-person rule, just-in-time access to a collection, the risk check
/// that asks for a fresh two-step code, copy-only use outside the edit screen, and the passkey step-up's guard.
/// </summary>
[Collection("api")]
public class VaultControlsTests(ApiFactory factory)
{
    private const string Password = "Tq7#vLm2!pZx9@Rk";
    private const string Reason = "Rotating the payment gateway keys tonight";
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static Guid G(JsonNode? n) => Guid.Parse(S(n));

    private async Task<TestClient> Owner(string name = "Ola Owner")
    {
        var owner = await TestClient.RegisterAsync(factory, name);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS", 20);
        owner.Ip = "203.0.113.9";
        return owner;
    }

    private static async Task<Guid> MyVault(TestClient c)
    {
        var o = await c.Get("/api/v1/vault/overview");
        Assert.True(o.Ok, o.ToString());
        return G(o.Data!["collections"]!.AsArray().First(x => S(x!["kind"]) == "Personal")!["id"]);
    }

    private static object Login(Guid collection, string title = "Gateway console", string password = Password) => new
    {
        collectionId = collection, kind = "Login", title, url = "https://gateway.example.in", tags = Array.Empty<string>(), @class = "Secret", useOnly = false,
        fields = new object[] { new { key = "username", value = "ops@fivestar.in", secret = false }, new { key = "password", value = password, secret = true } },
    };

    private static async Task<Guid> AddItem(TestClient c, object body)
    {
        var res = await c.Post("/api/v1/vault/items", body);
        Assert.True(res.Ok, res.ToString());
        return G(res.Data!["item"]!["id"]);
    }

    private static async Task<Guid> Collection(TestClient owner, string name, bool requireApproval = false, bool requestable = false, params (TestClient Who, string Access)[] people)
    {
        var made = await owner.Post("/api/v1/vault/collections", new { name, kind = "Shared", requireApproval, requestable });
        Assert.True(made.Ok, made.ToString());
        var id = G(made.Data!["id"]);
        if (people.Length > 0)
        {
            var shares = new List<object> { new { principalType = "User", principalId = owner.UserId, access = "Manage" } };
            shares.AddRange(people.Select(p => (object)new { principalType = "User", principalId = p.Who.UserId, access = p.Access }));
            var saved = await owner.Put($"/api/v1/vault/collections/{id}/shares", new { shares });
            Assert.True(saved.Ok, saved.ToString());
        }
        return id;
    }

    private static Task<ApiResult> Copy(TestClient c, Guid item, string? stepUp = null) => c.Post($"/api/v1/vault/items/{item}/reveal", new { field = "password", copy = true, stepUp });

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

    private async Task<string> RevealGrant(TestClient c, string secret)
    {
        factory.WithDb(db => db.Users.IgnoreQueryFilters().Where(u => u.Id == c.UserId).ExecuteUpdate(s => s.SetProperty(u => u.MfaLastStep, 0L)));
        var res = await c.Post("/api/v1/vault/step-up/reveal", new { password = "Passw0rd!x", code = CodeNow(secret) });
        Assert.True(res.Ok, res.ToString());
        return S(res.Data!["token"]);
    }

    private async Task<string> StepUp(TestClient c, string secret)
    {
        factory.WithDb(db => db.Users.IgnoreQueryFilters().Where(u => u.Id == c.UserId).ExecuteUpdate(s => s.SetProperty(u => u.MfaLastStep, 0L)));
        var res = await c.Post("/api/v1/vault/step-up", new { code = CodeNow(secret) });
        Assert.True(res.Ok, res.ToString());
        return S(res.Data!["token"]);
    }

    // ------------------------------------------------------------------ decoys

    [Fact]
    public async Task A_decoy_works_like_a_real_item_but_raises_the_alarm_and_only_vault_admins_can_tell()
    {
        var owner = await Owner();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Decoy");
        var shared = await Collection(owner, "Ops break-glass", people: (member, "View"));
        var id = await AddItem(owner, Login(shared, "Root of production"));

        var set = await owner.Put($"/api/v1/vault/items/{id}/decoy", new { decoy = true });
        Assert.True(set.Ok, set.ToString());
        Assert.Single(Audit(owner.WorkspaceId, "vault.decoy_set"));
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Put($"/api/v1/vault/items/{id}/decoy", new { decoy = false })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get("/api/v1/vault/decoys")).Status);

        // Nothing the member sees gives it away.
        var seen = (await member.Get($"/api/v1/vault/items/{id}")).ToString() + (await member.Get("/api/v1/vault/items")).ToString();
        Assert.DoesNotContain("decoy", seen, StringComparison.OrdinalIgnoreCase);

        // Using it works (so an intruder does not learn it was a trap) and is reported at once, once per hour per person.
        var used = await Copy(member, id);
        Assert.True(used.Ok, used.ToString());
        Assert.Equal(Password, S(used.Data!["value"]));
        Assert.True((await Copy(member, id)).Ok);
        var tripped = Audit(owner.WorkspaceId, "vault.decoy_triggered");
        Assert.Equal(2, tripped.Count);
        Assert.All(tripped, a => Assert.Equal(member.UserId, a.UserId));
        Assert.Single(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == owner.UserId && n.Title.StartsWith("Decoy credential used")).ToList()));
        Assert.True(factory.WithDb(db => db.Activities.IgnoreQueryFilters().Any(a => a.TenantId == owner.WorkspaceId && a.Action == "vault.decoy_triggered" && a.EntityId == id)));

        var decoys = await owner.Get("/api/v1/vault/decoys");
        Assert.True(decoys.Ok, decoys.ToString());
        var row = Assert.Single(decoys.Data!.AsArray())!;
        Assert.Equal(id, G(row["itemId"]));
        Assert.Equal(2, row["triggered"]!.GetValue<int>());

        Assert.True((await owner.Put($"/api/v1/vault/items/{id}/decoy", new { decoy = false })).Ok);
        Assert.Empty((await owner.Get("/api/v1/vault/decoys")).Data!.AsArray());
    }

    // ------------------------------------------------------------------ the two-person rule

    [Fact]
    public async Task Under_the_two_person_rule_nobody_uses_a_value_until_someone_else_approves_and_the_approval_ends_by_itself()
    {
        var owner = await Owner();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Tara Twoperson");
        var shared = await Collection(owner, "Payments gateway", requireApproval: true, people: (member, "View"));
        var id = await AddItem(owner, Login(shared));
        Assert.True((await owner.Get($"/api/v1/vault/collections/{shared}")).Data!["requireApproval"]!.GetValue<bool>());

        var refused = await Copy(member, id);
        Assert.Equal("VAULT_APPROVAL_REQUIRED", refused.ErrorCode);
        Assert.DoesNotContain(Password, refused.ToString());
        Assert.Single(Audit(owner.WorkspaceId, "vault.reveal_denied"));

        // Asking: a reason and a set window; asking again returns the same open request.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await member.Post($"/api/v1/vault/items/{id}/requests", new { reason = "need it", minutes = 15 })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await member.Post($"/api/v1/vault/items/{id}/requests", new { reason = Reason, minutes = 999 })).Status);
        var asked = await member.Post($"/api/v1/vault/items/{id}/requests", new { reason = Reason, minutes = 15 });
        Assert.True(asked.Ok, asked.ToString());
        var rid = G(asked.Data!["id"]);
        Assert.Equal(rid, G((await member.Post($"/api/v1/vault/items/{id}/requests", new { reason = Reason, minutes = 15 })).Data!["id"]));
        Assert.True(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Any(n => n.UserId == owner.UserId && n.Title.StartsWith("Tara Twoperson asks for"))));

        // Never one's own; the manager sees it to decide.
        Assert.Equal("VAULT_SELF_APPROVAL", (await member.Post($"/api/v1/vault/requests/{rid}/approve", new { note = (string?)null })).ErrorCode);
        var list = await owner.Get("/api/v1/vault/requests");
        Assert.True(list.Ok, list.ToString());
        var toDecide = Assert.Single(list.Data!["toDecide"]!.AsArray())!;
        Assert.True(toDecide["canDecide"]!.GetValue<bool>());
        Assert.Equal("Gateway console", S(toDecide["itemTitle"]));
        Assert.Empty((await member.Get("/api/v1/vault/requests")).Data!["toDecide"]!.AsArray());

        var approved = await owner.Post($"/api/v1/vault/requests/{rid}/approve", new { note = "Go ahead" });
        Assert.True(approved.Ok, approved.ToString());
        Assert.Equal("Approved", S(approved.Data!["status"]));
        Assert.Equal("VAULT_DECIDED", (await owner.Post($"/api/v1/vault/requests/{rid}/deny", new { note = (string?)null })).ErrorCode);
        Assert.True((await Copy(member, id)).Ok);
        Assert.Single(Audit(owner.WorkspaceId, "vault.access_approved"));

        // The window closes by itself.
        factory.WithDb(db => db.VaultAccessRequests.IgnoreQueryFilters().Where(r => r.Id == rid).ExecuteUpdate(s => s.SetProperty(r => r.GrantedUntil, DateTime.UtcNow.AddMinutes(-1))));
        Assert.Equal("VAULT_APPROVAL_REQUIRED", (await Copy(member, id)).ErrorCode);

        // A refusal says so to the requester.
        var again = G((await member.Post($"/api/v1/vault/items/{id}/requests", new { reason = Reason, minutes = 30 })).Data!["id"]);
        Assert.True((await owner.Post($"/api/v1/vault/requests/{again}/deny", new { note = "Not tonight" })).Ok);
        Assert.Equal("VAULT_APPROVAL_REQUIRED", (await Copy(member, id)).ErrorCode);
        Assert.True(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Any(n => n.UserId == member.UserId && n.Title.Contains("refused"))));

        // A sealed collection cannot have the rule: whoever holds its key reads without asking.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post("/api/v1/vault/collections", new { name = "Sealed rule", kind = "Shared", @sealed = true, requireApproval = true })).Status);
        // A collection without the rule has nothing to approve.
        var plain = await AddItem(owner, Login(await MyVault(owner), "Mine"));
        Assert.Equal("VAULT_NO_APPROVAL", (await owner.Post($"/api/v1/vault/items/{plain}/requests", new { reason = Reason, minutes = 15 })).ErrorCode);
    }

    // ------------------------------------------------------------------ just-in-time access

    [Fact]
    public async Task A_requestable_collection_can_be_joined_for_a_while_once_approved_and_given_back_early()
    {
        var owner = await Owner();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Jit Joshi");
        var hidden = await Collection(owner, "Not requestable");
        var open = await Collection(owner, "Firewall admin", requestable: true);
        var id = await AddItem(owner, Login(open, "Firewall"));

        var requestable = await member.Get("/api/v1/vault/requestable");
        Assert.True(requestable.Ok, requestable.ToString());
        var names = requestable.Data!.AsArray().Select(x => S(x!["name"])).ToList();
        Assert.Contains("Firewall admin", names);
        Assert.DoesNotContain("Not requestable", names);
        Assert.Equal(HttpStatusCode.NotFound, (await member.Post($"/api/v1/vault/collections/{hidden}/requests", new { reason = Reason, minutes = 60, access = "View" })).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await Copy(member, id)).Status);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await member.Post($"/api/v1/vault/collections/{open}/requests", new { reason = Reason, minutes = 60, access = "Manage" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await member.Post($"/api/v1/vault/collections/{open}/requests", new { reason = Reason, minutes = 45, access = "View" })).Status);
        var asked = await member.Post($"/api/v1/vault/collections/{open}/requests", new { reason = Reason, minutes = 60, access = "View" });
        Assert.True(asked.Ok, asked.ToString());
        var rid = G(asked.Data!["id"]);
        Assert.True((await owner.Post($"/api/v1/vault/requests/{rid}/approve", new { note = (string?)null })).Ok);

        // A share that ends by itself.
        var share = factory.WithDb(db => db.VaultShares.IgnoreQueryFilters().Single(s => s.CollectionId == open && s.PrincipalId == member.UserId));
        Assert.Equal(VaultAccess.View, share.Access);
        Assert.InRange(share.ExpiresAt!.Value, DateTime.UtcNow.AddMinutes(55), DateTime.UtcNow.AddMinutes(65));
        Assert.True((await Copy(member, id)).Ok);
        Assert.DoesNotContain("Firewall admin", (await member.Get("/api/v1/vault/requestable")).Data!.AsArray().Select(x => S(x!["name"])));

        // Done early: given back, and the access goes with it.
        Assert.Equal(HttpStatusCode.NoContent, (await member.Post($"/api/v1/vault/requests/{rid}/cancel")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await Copy(member, id)).Status);
        Assert.Single(Audit(owner.WorkspaceId, "vault.access_returned"));
    }

    // ------------------------------------------------------------------ risk

    [Fact]
    public async Task Use_from_a_network_never_seen_for_that_person_asks_for_a_fresh_two_step_check_and_a_refusal_does_not_make_it_familiar()
    {
        var owner = await Owner();
        var mine = await MyVault(owner);
        var known = await AddItem(owner, Login(mine, "Known"));
        await AddItem(owner, Login(mine, "Second"));
        var fresh = await AddItem(owner, Login(mine, "Fresh"));
        var secret = await EnableMfa(owner);
        Assert.True((await Copy(owner, known)).Ok);   // the usual network: fine

        owner.Ip = "198.51.100.77";
        var odd = await Copy(owner, fresh);
        Assert.Equal("STEP_UP_REQUIRED", odd.ErrorCode);
        Assert.Contains("network", odd.ToString());
        Assert.Contains(Audit(owner.WorkspaceId, "vault.reveal_denied"), a => a.NewValue!.Contains("unusual"));
        Assert.Equal("STEP_UP_REQUIRED", (await Copy(owner, fresh)).ErrorCode);   // still unfamiliar after being refused

        var ok = await Copy(owner, fresh, await StepUp(owner, secret));
        Assert.True(ok.Ok, ok.ToString());
        Assert.Contains("\"risk\":", Audit(owner.WorkspaceId, "vault.copied").Last().NewValue!);
    }

    // ------------------------------------------------------------------ copy-only outside the edit screen

    [Fact]
    public async Task Values_are_shown_only_for_the_edit_screen_and_earlier_values_can_be_copied_with_the_use_recorded()
    {
        var owner = await Owner();
        var viewer = await owner.AddMemberAsync(factory, TenantRole.Member, "Vik Viewer");
        var shared = await Collection(owner, "Shared logins", people: (viewer, "View"));
        var id = await AddItem(owner, Login(shared));

        // Even the edit screen shows a value only after the password and a second factor (a reveal grant).
        var secret = await EnableMfa(owner);
        Assert.Equal("REVEAL_VERIFY_REQUIRED", (await owner.Post($"/api/v1/vault/items/{id}/reveal", new { field = "password", copy = false, forEdit = true })).ErrorCode);
        var forEdit = await owner.Post($"/api/v1/vault/items/{id}/reveal", new { field = "password", copy = false, forEdit = true, stepUp = await RevealGrant(owner, secret) });
        Assert.True(forEdit.Ok, forEdit.ToString());
        Assert.Contains("\"inEditor\":true", Audit(owner.WorkspaceId, "vault.revealed").Last().NewValue!);
        // Someone who cannot edit is never recorded as having used the edit screen.
        var viewerGrant = await RevealGrant(viewer, await EnableMfa(viewer));
        Assert.True((await viewer.Post($"/api/v1/vault/items/{id}/reveal", new { field = "password", copy = false, forEdit = true, stepUp = viewerGrant })).Ok);
        Assert.Contains("\"inEditor\":false", Audit(owner.WorkspaceId, "vault.revealed").Last().NewValue!);

        var changed = await owner.Put($"/api/v1/vault/items/{id}", Login(shared, password: "N3w!Passw0rd#Ax7q"));
        Assert.True(changed.Ok, changed.ToString());
        var v = G(Assert.Single(changed.Data!["versions"]!.AsArray())!["id"]);
        var copied = await owner.Post($"/api/v1/vault/items/{id}/versions/{v}/reveal", new { field = "password", copy = true, stepUp = await StepUp(owner, secret) });
        Assert.True(copied.Ok, copied.ToString());
        Assert.Equal(Password, S(copied.Data!["value"]));
        Assert.Single(Audit(owner.WorkspaceId, "vault.version_copied"));
        Assert.Empty(Audit(owner.WorkspaceId, "vault.version_revealed"));
        var activity = await owner.Get($"/api/v1/vault/items/{id}/activity");
        Assert.Contains("vault.version_copied", activity.ToString());
    }

    // ------------------------------------------------------------------ passkey step-up

    [Fact]
    public async Task A_passkey_step_up_needs_a_passkey_on_the_account_and_the_overview_says_whether_there_is_one()
    {
        var owner = await Owner();
        var o = await owner.Get("/api/v1/vault/overview");
        Assert.False(o.Data!["hasPasskeys"]!.GetValue<bool>());
        Assert.Equal("NO_PASSKEY", (await owner.Post("/api/v1/vault/step-up/passkey/options")).ErrorCode);
        var bogus = await owner.Post("/api/v1/vault/step-up/passkey", new { response = new { id = "AAAA" } });
        Assert.False(bogus.Ok);
        Assert.Equal(HttpStatusCode.Unauthorized, (await new TestClient(factory).Post("/api/v1/vault/step-up/passkey/options")).Status);
    }

    // ------------------------------------------------------------------ self-destructing links

    private static (string Token, string Hash) NewToken()
    {
        var token = Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return (token, Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(token))).ToLowerInvariant());
    }
    private static string Cipher() => Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(300));

    [Fact]
    public async Task A_one_time_link_keeps_only_ciphertext_opens_the_allowed_number_of_times_without_sign_in_and_then_destroys_it()
    {
        var owner = await Owner("Lina Linker");
        var mine = await MyVault(owner);
        var id = await AddItem(owner, Login(mine, "Office Wi-Fi"));
        var (token, hash) = NewToken();
        var cipher = Cipher();
        object Body(string h, int views = 1, int hours = 24, Guid? item = null, string? c = null) => new { tokenHash = h, itemId = item, note = "For the auditor", cipher = c ?? cipher, maxViews = views, hours, hasPassphrase = false };

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post("/api/v1/vault/links", Body("not-a-hash", item: id))).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post("/api/v1/vault/links", Body(hash, hours: 5, item: id))).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post("/api/v1/vault/links", Body(hash, views: 9, item: id))).Status);
        var made = await owner.Post("/api/v1/vault/links", Body(hash, item: id));
        Assert.True(made.Ok, made.ToString());
        Assert.Equal("open", S(made.Data!["state"]));
        Assert.Equal("VAULT_LINK_EXISTS", (await owner.Post("/api/v1/vault/links", Body(hash, item: id))).ErrorCode);
        var row = factory.WithDb(db => db.VaultSecretLinks.IgnoreQueryFilters().Single(l => l.TokenHash == hash));
        Assert.Equal(cipher, row.Cipher);
        Assert.DoesNotContain(token, row.TokenHash);
        Assert.Single(factory.WithDb(db => db.AuditLogs.Where(a => a.TenantId == owner.WorkspaceId && a.Action == "vault.link_created" && a.EntityId == id).ToList()));

        // Without signing in: describing it does not use it up.
        var stranger = new TestClient(factory);
        for (var i = 0; i < 2; i++)
        {
            var info = await stranger.Get($"/api/v1/secret-links/{token}");
            Assert.True(info.Ok, info.ToString());
            Assert.Equal("ready", S(info.Data!["state"]));
            Assert.Equal("Lina Linker", S(info.Data["from"]));
            Assert.Equal("For the auditor", S(info.Data["note"]));
            Assert.Equal(1, info.Data["viewsLeft"]!.GetValue<int>());
            Assert.DoesNotContain(cipher, info.ToString());
            Assert.Contains("no-store", info.Header("Cache-Control") ?? "");
        }
        var opened = await stranger.Post($"/api/v1/secret-links/{token}/open");
        Assert.True(opened.Ok, opened.ToString());
        Assert.Equal(cipher, S(opened.Data!["cipher"]));
        Assert.Equal(0, opened.Data["viewsLeft"]!.GetValue<int>());
        Assert.Equal("LINK_GONE", (await stranger.Post($"/api/v1/secret-links/{token}/open")).ErrorCode);
        Assert.Equal("gone", S((await stranger.Get($"/api/v1/secret-links/{token}")).Data!["state"]));
        var burned = factory.WithDb(db => db.VaultSecretLinks.IgnoreQueryFilters().Single(l => l.TokenHash == hash));
        Assert.Equal("", burned.Cipher);
        Assert.NotNull(burned.BurnedAt);
        Assert.True(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Any(n => n.UserId == owner.UserId && n.Title == "Your one-time link was opened and destroyed")));
        Assert.Single(factory.WithDb(db => db.AuditLogs.Where(a => a.TenantId == owner.WorkspaceId && a.Action == "vault.link_opened").ToList()));
        Assert.Equal("used", S((await owner.Get("/api/v1/vault/links")).Data!.AsArray().Single(l => G(l!["id"]) == G(made.Data["id"]))!["state"]));

        // Several openings, then gone; a revoked link and an expired one never open; nonsense tokens look the same as gone ones.
        var (t2, h2) = NewToken();
        Assert.True((await owner.Post("/api/v1/vault/links", Body(h2, views: 2))).Ok);
        Assert.True((await stranger.Post($"/api/v1/secret-links/{t2}/open")).Ok);
        Assert.Equal(1, (await stranger.Get($"/api/v1/secret-links/{t2}")).Data!["viewsLeft"]!.GetValue<int>());
        Assert.True((await stranger.Post($"/api/v1/secret-links/{t2}/open")).Ok);
        Assert.Equal("LINK_GONE", (await stranger.Post($"/api/v1/secret-links/{t2}/open")).ErrorCode);
        var (t3, h3) = NewToken();
        var third = await owner.Post("/api/v1/vault/links", Body(h3));
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Delete($"/api/v1/vault/links/{G(third.Data!["id"])}")).Status);
        Assert.Equal("gone", S((await stranger.Get($"/api/v1/secret-links/{t3}")).Data!["state"]));
        Assert.Equal("", factory.WithDb(db => db.VaultSecretLinks.IgnoreQueryFilters().Single(l => l.TokenHash == h3)).Cipher);
        var (t4, h4) = NewToken();
        Assert.True((await owner.Post("/api/v1/vault/links", Body(h4))).Ok);
        factory.WithDb(db => db.VaultSecretLinks.IgnoreQueryFilters().Where(l => l.TokenHash == h4).ExecuteUpdate(u => u.SetProperty(l => l.ExpiresAt, DateTime.UtcNow.AddMinutes(-1))));
        Assert.Equal("LINK_GONE", (await stranger.Post($"/api/v1/secret-links/{t4}/open")).ErrorCode);
        Assert.Equal("gone", S((await stranger.Get("/api/v1/secret-links/nonsense-token-that-is-long-enough")).Data!["state"]));
        Assert.Equal("gone", S((await stranger.Get("/api/v1/secret-links/x")).Data!["state"]));
    }

    [Fact]
    public async Task A_link_follows_the_items_rules_and_a_passphrase_link_carries_only_its_salt()
    {
        var owner = await Owner("Pia Passphrase");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Uma User");
        var mine = await MyVault(owner);
        var useOnly = await AddItem(owner, new
        {
            collectionId = mine, kind = "Login", title = "Use only", url = (string?)null, tags = Array.Empty<string>(), @class = "Secret", useOnly = true,
            fields = new object[] { new { key = "password", value = Password, secret = true } },
        });
        var (_, h1) = NewToken();
        Assert.Equal("VAULT_USE_ONLY", (await owner.Post("/api/v1/vault/links", new { tokenHash = h1, itemId = useOnly, cipher = Cipher(), maxViews = 1, hours = 1, hasPassphrase = false })).ErrorCode);
        var gated = await Collection(owner, "Two-person", requireApproval: true, people: (member, "View"));
        var gatedItem = await AddItem(owner, Login(gated, "Gated"));
        Assert.Equal("VAULT_APPROVAL_REQUIRED", (await member.Post("/api/v1/vault/links", new { tokenHash = h1, itemId = gatedItem, cipher = Cipher(), maxViews = 1, hours = 1, hasPassphrase = false })).ErrorCode);
        var other = await AddItem(owner, Login(mine, "Not theirs"));
        Assert.Equal(HttpStatusCode.NotFound, (await member.Post("/api/v1/vault/links", new { tokenHash = h1, itemId = other, cipher = Cipher(), maxViews = 1, hours = 1, hasPassphrase = false })).Status);

        var (token, hash) = NewToken();
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post("/api/v1/vault/links", new { tokenHash = hash, cipher = Cipher(), maxViews = 1, hours = 1, hasPassphrase = true, salt = "c2FsdHNhbHRzYWx0c2FsdA==", @params = "pbkdf2;i=1" })).Status);
        var made = await owner.Post("/api/v1/vault/links", new { tokenHash = hash, cipher = Cipher(), maxViews = 1, hours = 168, hasPassphrase = true, salt = "c2FsdHNhbHRzYWx0c2FsdA==", @params = "argon2id;m=19456;t=2;p=1" });
        Assert.True(made.Ok, made.ToString());
        var info = await new TestClient(factory).Get($"/api/v1/secret-links/{token}");
        Assert.True(info.Data!["hasPassphrase"]!.GetValue<bool>());
        Assert.Equal("c2FsdHNhbHRzYWx0c2FsdA==", S(info.Data["salt"]));
        Assert.Equal("argon2id;m=19456;t=2;p=1", S(info.Data["params"]));
        Assert.Empty((await member.Get("/api/v1/vault/links")).Data!.AsArray());   // each person sees only their own
        Assert.Equal(HttpStatusCode.NotFound, (await member.Delete($"/api/v1/vault/links/{G(made.Data!["id"])}")).Status);
    }
}
