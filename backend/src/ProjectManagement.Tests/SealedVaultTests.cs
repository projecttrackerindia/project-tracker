using System.Net;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Common;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The sealed (zero-knowledge) vault. The cryptography happens in the browser (covered by the web tests); here: the server keeps only what it
/// is given, hands it only to people with access now, drops the keys of anyone who loses access and asks for a new key, takes a new key only
/// with everything re-encrypted at once, moves a guarded collection to sealed without keeping a readable copy, and links a device once.
/// </summary>
[Collection("api")]
public class SealedVaultTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static Guid G(JsonNode? n) => Guid.Parse(S(n));
    private static string Rand(int bytes) => Convert.ToBase64String(RandomNumberGenerator.GetBytes(bytes));
    private static string Fp() => string.Join(' ', Enumerable.Range(0, 12).Select(_ => RandomNumberGenerator.GetInt32(0, 100000).ToString("D5")));

    private static object Keys(bool withRecovery = true) => new
    {
        x25519Public = Rand(32), mlKemPublic = Rand(1184), ed25519Public = Rand(32), selfSignature = Rand(64), fingerprint = Fp(),
        unlocks = withRecovery
            ? new object[] { new { kind = "RecoveryKey", label = "Printed recovery key", salt = Rand(16), @params = "argon2id;m=19456;t=2;p=1", wrappedSeed = Rand(60) },
                             new { kind = "Passkey", label = "Laptop fingerprint", credentialId = Rand(32), salt = Rand(32), @params = "prf", wrappedSeed = Rand(60) } }
            : new object[] { new { kind = "Passkey", label = "Laptop", credentialId = Rand(32), salt = Rand(32), @params = "prf", wrappedSeed = Rand(60) } },
    };

    private async Task<TestClient> Owner(string name = "Sana Sealed")
    {
        var owner = await TestClient.RegisterAsync(factory, name);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS", 20);
        return owner;
    }

    private static async Task<int> SetupKeys(TestClient c)
    {
        var res = await c.Post("/api/v1/vault/keys/setup", Keys());
        Assert.True(res.Ok, res.ToString());
        return res.Data!["identity"]!["generation"]!.GetValue<int>();
    }

    private static object Env(Guid who, int version, int generation) => new { recipientUserId = who, keyVersion = version, recipientGeneration = generation, envelope = Rand(1180), signature = Rand(64) };

    private async Task<Guid> SealedCollection(TestClient owner, int gen, params (TestClient Who, string Access)[] people)
    {
        var made = await owner.Post("/api/v1/vault/collections", new { name = "Prod keys", kind = "Shared", @sealed = true });
        Assert.True(made.Ok, made.ToString());
        var id = G(made.Data!["id"]);
        Assert.True(made.Data["sealed"]!.GetValue<bool>());
        Assert.True((await owner.Post($"/api/v1/vault/collections/{id}/keys", new { envelopes = new[] { Env(owner.UserId, 1, gen) } })).Ok);
        if (people.Length > 0)
        {
            var shares = new List<object> { new { principalType = "User", principalId = owner.UserId, access = "Manage" } };
            shares.AddRange(people.Select(p => (object)new { principalType = "User", principalId = p.Who.UserId, access = p.Access }));
            var saved = await owner.Put($"/api/v1/vault/collections/{id}/shares", new { shares });
            Assert.True(saved.Ok, saved.ToString());
        }
        return id;
    }

    private static async Task<Guid> AddSealedItem(TestClient c, Guid collection, int version, string blob)
    {
        var res = await c.Post("/api/v1/vault/sealed-items", new { id = Guid.NewGuid(), collectionId = collection, kind = "Login", keyVersion = version, blob });
        Assert.True(res.Ok, res.ToString());
        return G(res.Data!["id"]);
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

    [Fact]
    public async Task Keys_are_public_halves_and_wrapped_secrets_only_and_a_recovery_key_is_required()
    {
        var owner = await Owner();
        Assert.Null((await owner.Get("/api/v1/vault/keys/me")).Data!["identity"]);
        var noRecovery = await owner.Post("/api/v1/vault/keys/setup", Keys(withRecovery: false));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, noRecovery.Status);
        Assert.Equal(1, await SetupKeys(owner));
        Assert.Equal("VAULT_KEYS_EXIST", (await owner.Post("/api/v1/vault/keys/setup", Keys())).ErrorCode);
        var me = (await owner.Get("/api/v1/vault/keys/me")).Data!;
        Assert.Equal(2, me["unlocks"]!.AsArray().Count);
        Assert.NotNull((await owner.Get("/api/v1/vault/overview")).Data!["identity"]);

        // The last recovery key cannot be removed; using it is recorded and the person told.
        var recovery = G(me["unlocks"]!.AsArray().First(u => S(u!["kind"]) == "RecoveryKey")!["id"]);
        Assert.Equal("VAULT_LAST_RECOVERY", (await owner.Delete($"/api/v1/vault/keys/unlocks/{recovery}")).ErrorCode);
        Assert.True((await owner.Post($"/api/v1/vault/keys/unlocks/{recovery}/used")).Ok);
        Assert.True(factory.WithDb(db => db.AuditLogs.Any(a => a.TenantId == owner.WorkspaceId && a.Action == "vault.unlocked")));
        Assert.True(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Any(n => n.UserId == owner.UserId && n.Title.Contains("recovery key"))));

        // A reset needs a fresh two-step check and moves to a new generation.
        Assert.Equal("STEP_UP_REQUIRED", (await owner.Post("/api/v1/vault/keys/setup", new { x25519Public = Rand(32), mlKemPublic = Rand(1184), ed25519Public = Rand(32), selfSignature = Rand(64), fingerprint = Fp(),
            unlocks = new[] { new { kind = "RecoveryKey", salt = Rand(16), wrappedSeed = Rand(60) } }, reset = true })).ErrorCode);
        var token = await StepUp(owner);
        var reset = await owner.Post("/api/v1/vault/keys/setup", new { x25519Public = Rand(32), mlKemPublic = Rand(1184), ed25519Public = Rand(32), selfSignature = Rand(64), fingerprint = Fp(),
            unlocks = new[] { new { kind = "RecoveryKey", salt = Rand(16), wrappedSeed = Rand(60) } }, reset = true, stepUp = token });
        Assert.True(reset.Ok, reset.ToString());
        Assert.Equal(2, reset.Data!["identity"]!["generation"]!.GetValue<int>());
    }

    [Fact]
    public async Task A_sealed_collection_hands_ciphertext_and_keys_only_to_people_with_access_now()
    {
        var owner = await Owner();
        var ownerGen = await SetupKeys(owner);
        var viewer = await owner.AddMemberAsync(factory, TenantRole.Member, "Vani Viewer");
        var outsider = await owner.AddMemberAsync(factory, TenantRole.Admin, "Omar Outsider");
        var id = await SealedCollection(owner, ownerGen, (viewer, "View"));
        var blob = Rand(300);
        var item = await AddSealedItem(owner, id, 1, blob);
        Assert.Equal("", factory.WithDb(db => db.VaultItems.IgnoreQueryFilters().Single(i => i.Id == item).Title));   // nothing readable is kept

        // The viewer has no keys yet: listed as waiting, with no public keys.
        var keys = (await owner.Get($"/api/v1/vault/collections/{id}/keys")).Data!;
        var waiting = keys["pending"]!.AsArray().Single(p => G(p!["userId"]) == viewer.UserId)!;
        Assert.Null(waiting["identity"]);
        var viewerGen = await SetupKeys(viewer);
        keys = (await owner.Get($"/api/v1/vault/collections/{id}/keys")).Data!;
        Assert.NotNull(keys["pending"]!.AsArray().Single(p => G(p!["userId"]) == viewer.UserId)!["identity"]);
        Assert.True((await owner.Post($"/api/v1/vault/collections/{id}/keys", new { envelopes = new[] { Env(viewer.UserId, 1, viewerGen) } })).Ok);
        Assert.Empty((await owner.Get($"/api/v1/vault/collections/{id}/keys")).Data!["pending"]!.AsArray());

        var mine = (await viewer.Get($"/api/v1/vault/collections/{id}/keys")).Data!;
        Assert.Equal(owner.UserId, G(Assert.Single(mine["mine"]!.AsArray())!["senderUserId"]));
        Assert.Null(mine["pending"]);   // only managers see who is waiting
        var list = (await viewer.Get($"/api/v1/vault/collections/{id}/sealed-items")).Data!.AsArray();
        Assert.Equal(blob, S(Assert.Single(list)!["blob"]));
        Assert.True(factory.WithDb(db => db.AuditLogs.Any(a => a.UserId == viewer.UserId && a.Action == "vault.sealed_listed" && a.EntityId == id)));

        // View is not manage; use-only cannot exist here; a key only goes to someone with access; guarded calls refuse sealed items.
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.Post("/api/v1/vault/sealed-items", new { id = Guid.NewGuid(), collectionId = id, kind = "Login", keyVersion = 1, blob = Rand(200) })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put($"/api/v1/vault/collections/{id}/shares", new { shares = new object[]
            { new { principalType = "User", principalId = owner.UserId, access = "Manage" }, new { principalType = "User", principalId = viewer.UserId, access = "UseOnly" } } })).Status);
        var outsiderGen = await SetupKeys(outsider);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"/api/v1/vault/collections/{id}/keys", new { envelopes = new[] { Env(outsider.UserId, 1, outsiderGen) } })).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Get($"/api/v1/vault/collections/{id}/sealed-items")).Status);
        Assert.Equal("VAULT_SEALED", (await owner.Post($"/api/v1/vault/items/{item}/reveal", new { field = "password" })).ErrorCode);
        Assert.Equal("VAULT_SEALED", (await owner.Get($"/api/v1/vault/items/{item}")).ErrorCode);
        Assert.Equal("VAULT_SEALED", (await owner.Post("/api/v1/vault/items", new { collectionId = id, kind = "Login", title = "x", @class = "Secret", fields = Array.Empty<object>() })).ErrorCode);
        Assert.DoesNotContain(item.ToString(), (await owner.Get("/api/v1/vault/items")).ToString());   // sealed items are not in the guarded list

        // What the browser did is recorded.
        Assert.True((await viewer.Post($"/api/v1/vault/sealed-items/{item}/events", new { action = "copied", field = "Password" })).Ok);
        Assert.True(factory.WithDb(db => db.AuditLogs.Any(a => a.UserId == viewer.UserId && a.Action == "vault.copied" && a.EntityId == item)));
    }

    [Fact]
    public async Task Losing_access_drops_the_key_at_once_and_a_new_key_must_re_encrypt_everything()
    {
        var owner = await Owner();
        var ownerGen = await SetupKeys(owner);
        var leaver = await owner.AddMemberAsync(factory, TenantRole.Member, "Lata Leaves");
        var leaverGen = await SetupKeys(leaver);
        var id = await SealedCollection(owner, ownerGen, (leaver, "View"));
        Assert.True((await owner.Post($"/api/v1/vault/collections/{id}/keys", new { envelopes = new[] { Env(leaver.UserId, 1, leaverGen) } })).Ok);
        var a = await AddSealedItem(owner, id, 1, Rand(200));
        var b = await AddSealedItem(owner, id, 1, Rand(200));
        Assert.True((await owner.Put($"/api/v1/vault/sealed-items/{a}", new { collectionId = id, kind = "Login", keyVersion = 1, blob = Rand(220), valueChanged = true })).Ok);

        // Taken off the list: their copy of the key is gone and the collection needs a new key before anything is added.
        Assert.True((await owner.Put($"/api/v1/vault/collections/{id}/shares", new { shares = new[] { new { principalType = "User", principalId = owner.UserId, access = "Manage" } } })).Ok);
        Assert.False(factory.WithDb(db => db.VaultKeyEnvelopes.IgnoreQueryFilters().Any(v => v.CollectionId == id && v.RecipientUserId == leaver.UserId)));
        Assert.True((await owner.Get($"/api/v1/vault/collections/{id}/keys")).Data!["rekeyNeeded"]!.GetValue<bool>());
        Assert.Equal("VAULT_REKEY_NEEDED", (await owner.Post("/api/v1/vault/sealed-items", new { id = Guid.NewGuid(), collectionId = id, kind = "Login", keyVersion = 1, blob = Rand(200) })).ErrorCode);
        Assert.Equal(HttpStatusCode.NotFound, (await leaver.Get($"/api/v1/vault/collections/{id}/sealed-items")).Status);

        var version = factory.WithDb(db => db.VaultItemVersions.IgnoreQueryFilters().Single(v => v.ItemId == a).Id);
        var partial = await owner.Post($"/api/v1/vault/collections/{id}/rekey", new { newVersion = 2, envelopes = new[] { Env(owner.UserId, 2, ownerGen) }, items = new[] { new { id = a, blob = Rand(200) } }, versions = Array.Empty<object>(), files = Array.Empty<object>() });
        Assert.Equal("VAULT_REKEY_INCOMPLETE", partial.ErrorCode);
        Assert.Equal("VAULT_KEY_VERSION", (await owner.Post($"/api/v1/vault/collections/{id}/rekey", new { newVersion = 3, envelopes = new[] { Env(owner.UserId, 3, ownerGen) } })).ErrorCode);
        var na = Rand(210); var nb = Rand(210); var nv = Rand(210);
        var done = await owner.Post($"/api/v1/vault/collections/{id}/rekey", new
        {
            newVersion = 2, envelopes = new[] { Env(owner.UserId, 2, ownerGen) },
            items = new[] { new { id = a, blob = na }, new { id = b, blob = nb } }, versions = new[] { new { id = version, blob = nv } }, files = Array.Empty<object>(),
        });
        Assert.True(done.Ok, done.ToString());
        Assert.False(done.Data!["rekeyNeeded"]!.GetValue<bool>());
        Assert.Equal(2, done.Data["keyVersion"]!.GetValue<int>());
        var rows = factory.WithDb(db => db.VaultItems.IgnoreQueryFilters().Where(i => i.CollectionId == id).ToDictionary(i => i.Id, i => (i.Cipher, i.KeyVersion)));
        Assert.Equal((na, 2), rows[a]); Assert.Equal((nb, 2), rows[b]);
        Assert.Equal(nv, factory.WithDb(db => db.VaultItemVersions.IgnoreQueryFilters().Single(v => v.Id == version).Cipher));
        Assert.Equal(new[] { 2 }, factory.WithDb(db => db.VaultKeyEnvelopes.IgnoreQueryFilters().Where(v => v.CollectionId == id).Select(v => v.KeyVersion).Distinct().ToList()));
    }

    [Fact]
    public async Task A_guarded_collection_is_sealed_without_keeping_a_readable_copy()
    {
        var owner = await Owner();
        var gen = await SetupKeys(owner);
        var mine = G((await owner.Get("/api/v1/vault/overview")).Data!["collections"]!.AsArray().First(c => S(c!["kind"]) == "Personal")!["id"]);
        var added = await owner.Post("/api/v1/vault/items", new { collectionId = mine, kind = "Login", title = "Old bank", @class = "Secret",
            fields = new object[] { new { key = "username", value = "asha", secret = false }, new { key = "password", value = "Gu4rded!Value#1x", secret = true } } });
        Assert.True(added.Ok, added.ToString());
        var item = G(added.Data!["item"]!["id"]);
        Assert.True((await owner.Put($"/api/v1/vault/items/{item}", new { collectionId = mine, kind = "Login", title = "Old bank", @class = "Secret",
            fields = new object[] { new { key = "username", value = "asha", secret = false }, new { key = "password", value = "Gu4rded!Value#2x", secret = true } } })).Ok);
        var file = await owner.Upload($"/api/v1/vault/items/{item}/attachments", "codes.txt", "backup codes"u8.ToArray());
        Assert.True(file.Ok, file.ToString());

        Assert.Equal("STEP_UP_REQUIRED", (await owner.Post($"/api/v1/vault/collections/{mine}/export-for-sealing", new { })).ErrorCode);
        var token = await StepUp(owner);
        var export = await owner.Post($"/api/v1/vault/collections/{mine}/export-for-sealing", new { stepUp = token });
        Assert.True(export.Ok, export.ToString());
        var x = Assert.Single(export.Data!.AsArray())!;
        Assert.Equal("Gu4rded!Value#2x", S(x["fields"]!.AsArray().First(f => S(f!["key"]) == "password")!["value"]));
        Assert.Equal("backup codes", System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(S(x["files"]![0]!["data"]))));

        var blob = Rand(400);
        var sealedRes = await owner.Post($"/api/v1/vault/collections/{mine}/seal", new
        {
            stepUp = token, envelope = Env(owner.UserId, 1, gen), items = new[] { new { id = item, blob } },
            files = new[] { new { id = G(file.Data!["id"]), wrapped = Rand(60), cipher = Rand(40) } },
        });
        Assert.True(sealedRes.Ok, sealedRes.ToString());
        var row = factory.WithDb(db => db.VaultItems.IgnoreQueryFilters().Single(i => i.Id == item));
        Assert.True(row.Sealed); Assert.Equal(blob, row.Cipher); Assert.Equal("", row.Title); Assert.Equal("", row.WrappedItemKey); Assert.Null(row.UsernameHint);
        Assert.False(factory.WithDb(db => db.VaultItemVersions.IgnoreQueryFilters().Any(v => v.ItemId == item)));   // the readable history is gone
        Assert.True(factory.WithDb(db => db.VaultAttachments.IgnoreQueryFilters().Single(a => a.ItemId == item).Sealed));
        Assert.True(factory.WithDb(db => db.VaultCollections.IgnoreQueryFilters().Single(c => c.Id == mine).Sealed));
        Assert.Equal("VAULT_SEALED", (await owner.Post($"/api/v1/vault/collections/{mine}/export-for-sealing", new { stepUp = token })).ErrorCode);
    }

    [Fact]
    public async Task A_new_device_gets_the_secret_only_after_approval_and_only_once()
    {
        var owner = await Owner();
        await SetupKeys(owner);
        var req = await owner.Post("/api/v1/vault/devices", new { label = "Chrome on the office PC", x25519Public = Rand(32), mlKemPublic = Rand(1184) });
        Assert.True(req.Ok, req.ToString());
        var id = G(req.Data!["id"]);
        Assert.Null((await owner.Get($"/api/v1/vault/devices/{id}")).Data!["envelope"]);
        Assert.Single((await owner.Get("/api/v1/vault/devices/pending")).Data!.AsArray());
        var envelope = Rand(1180);
        Assert.True((await owner.Post($"/api/v1/vault/devices/{id}/approve", new { envelope, signature = Rand(64) })).Ok);
        Assert.Equal(envelope, S((await owner.Get($"/api/v1/vault/devices/{id}")).Data!["envelope"]));
        Assert.Null((await owner.Get($"/api/v1/vault/devices/{id}")).Data!["envelope"]);   // handed over once
        Assert.Null(factory.WithDb(db => db.VaultDeviceLinks.IgnoreQueryFilters().Single(l => l.Id == id).Envelope));
        Assert.Equal("VAULT_LINK_ENDED", (await owner.Post($"/api/v1/vault/devices/{id}/approve", new { envelope, signature = Rand(64) })).ErrorCode);

        var other = await TestClient.RegisterAsync(factory, "Not Them");
        await other.CreateOrgAsync();
        Assert.Equal(HttpStatusCode.NotFound, (await other.Get($"/api/v1/vault/devices/{id}")).Status);
    }

    [Fact]
    public async Task The_breach_check_for_sealed_items_sends_only_a_hash_prefix()
    {
        factory.Pwned.Breached["Sealed@2024"] = 77;
        var owner = await Owner();
        var hash = Convert.ToHexString(SHA1.HashData("Sealed@2024"u8.ToArray()));
        var res = await owner.Get($"/api/v1/vault/breach-range/{hash[..5]}");
        Assert.True(res.Ok, res.ToString());
        Assert.Contains($"{hash[5..]}:77", S(res.Data!["body"]));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Get("/api/v1/vault/breach-range/xyz")).Status);
    }

    [Fact]
    public async Task Someone_who_leaves_loses_every_sealed_key_and_what_they_could_read_is_marked_to_change()
    {
        var owner = await Owner();
        var ownerGen = await SetupKeys(owner);
        var leaver = await owner.AddMemberAsync(factory, TenantRole.Member, "Lalith Leaver");
        var leaverGen = await SetupKeys(leaver);
        var id = await SealedCollection(owner, ownerGen, (leaver, "View"));
        Assert.True((await owner.Post($"/api/v1/vault/collections/{id}/keys", new { envelopes = new[] { Env(leaver.UserId, 1, leaverGen) } })).Ok);
        var one = await AddSealedItem(owner, id, 1, Rand(200));
        var two = await AddSealedItem(owner, id, 1, Rand(200));
        Assert.True((await leaver.Get($"/api/v1/vault/collections/{id}/sealed-items")).Ok);

        Assert.True((await owner.Delete($"/api/v1/workspace/members/{leaver.UserId}")).Ok);
        Assert.False(factory.WithDb(db => db.VaultKeyEnvelopes.IgnoreQueryFilters().Any(v => v.RecipientUserId == leaver.UserId)));
        Assert.False(factory.WithDb(db => db.VaultUnlocks.IgnoreQueryFilters().Any(u => u.UserId == leaver.UserId && u.TenantId == owner.WorkspaceId)));
        Assert.True(factory.WithDb(db => db.VaultCollections.IgnoreQueryFilters().Single(c => c.Id == id).RekeyNeeded));
        var flagged = factory.WithDb(db => db.VaultItems.IgnoreQueryFilters().Where(i => i.Id == one || i.Id == two).Select(i => i.RotationReason).ToList());
        Assert.All(flagged, r => Assert.Contains("Lalith Leaver", r));
        Assert.Single(factory.WithDb(db => db.WorkTasks.IgnoreQueryFilters().Where(t => t.TenantId == owner.WorkspaceId && t.Title.Contains("sealed collection Prod keys")).ToList()));
    }
}
