using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Persistence;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Sensitive values, reveal, step-up, key rotation and the tamper-evident audit trail (release D5).</summary>
[Collection("api")]
public class DocumentSecretTests(ApiFactory factory)
{
    private const string Secret = "sk_live_Zx9-UNIQUE-4f7a1c2e";
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private bool OnPostgres => factory.WithDb(db => db.Database.ProviderName!.Contains("Npgsql"));

    private async Task<(TestClient Owner, Guid Doc, Guid Secret)> Setup(string plan = "BUSINESS", string @class = "Secret", string label = "Production key")
    {
        var owner = await TestClient.RegisterAsync(factory, "Olive Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync(plan, 20);
        owner.Ip = "203.0.113.7";
        var brd = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "BRD")!["id"]));
        var made = await owner.Post("/api/v1/documents", new { title = "Integration plan", typeId = brd });
        Assert.True(made.Ok, made.ToString());
        var doc = Guid.Parse(S(made.Data!["item"]!["id"]));
        var add = await owner.Post($"/api/v1/documents/{doc}/secrets", new { label, value = Secret, note = "payments gateway", @class });
        Assert.True(add.Ok, add.ToString());
        return (owner, doc, Guid.Parse(S(add.Data!["items"]![0]!["id"])));
    }

    private static string CodeNow(string secret) => Totp.Compute(secret, Totp.StepOf(DateTime.UtcNow));

    private static async Task<string> EnableMfa(TestClient c)
    {
        var setup = await c.Post("/api/v1/me/mfa/setup", new { password = "Passw0rd!x" });
        var secret = setup.Data!["secret"]!.GetValue<string>().Replace(" ", "");
        Assert.True((await c.Post("/api/v1/me/mfa/enable", new { code = CodeNow(secret) })).Ok);
        return secret;
    }

    private List<AuditLog> Audit(Guid tenant, string action) => factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Where(a => a.TenantId == tenant && a.Action == action).OrderBy(a => a.Seq).ToList());

    [Fact]
    public async Task The_value_is_stored_encrypted_and_no_list_or_document_response_contains_it()
    {
        var (owner, doc, id) = await Setup();
        var list = await owner.Get($"/api/v1/documents/{doc}/secrets");
        Assert.DoesNotContain(Secret, list.ToString());
        Assert.Equal("Production key", S(list.Data!["items"]![0]!["label"]));
        foreach (var url in new[] { $"/api/v1/documents/{doc}", $"/api/v1/documents/{doc}/versions", $"/api/v1/documents/{doc}/activity", $"/api/v1/documents/{doc}/audit", "/api/v1/documents" })
            Assert.DoesNotContain(Secret, (await owner.Get(url)).ToString());

        var row = factory.WithDb(db => db.SensitiveValues.IgnoreQueryFilters().Single(v => v.Id == id));
        Assert.DoesNotContain(Secret, row.Cipher);
        Assert.Equal(1, row.KeyVersion);
        Assert.Equal(row.Cipher.Length > 40, true);
    }

    [Fact]
    public async Task A_reveal_returns_the_value_and_is_audited_with_who_which_field_and_where_from()
    {
        var (owner, doc, id) = await Setup();
        var res = await owner.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { });
        Assert.True(res.Ok, res.ToString());
        Assert.Equal(Secret, S(res.Data!["value"]));
        Assert.Equal(15, res.Data["revealSeconds"]!.GetValue<int>());
        Assert.Contains("no-store", res.Header("Cache-Control") ?? "");

        var tenant = owner.WorkspaceId;
        var row = Assert.Single(Audit(tenant, "document.secret_revealed"));
        Assert.Equal(owner.UserId, row.UserId);
        Assert.Equal("203.0.113.7", row.IpAddress);
        Assert.Contains("Production key", row.NewValue);
        Assert.DoesNotContain(Secret, row.NewValue);
    }

    [Fact]
    public async Task Someone_without_the_permission_gets_403_and_the_attempt_is_audited()
    {
        var (owner, doc, id) = await Setup();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member);
        await owner.Post($"/api/v1/documents/{doc}/grants", new { principalType = "User", principalId = member.UserId, level = "Editor" });
        Assert.True((await member.Get($"/api/v1/documents/{doc}/secrets")).Ok);   // may see the names

        var res = await member.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { });
        Assert.Equal(HttpStatusCode.Forbidden, res.Status);
        Assert.Equal("SECRET_REVEAL_DENIED", res.ErrorCode);
        Assert.DoesNotContain(Secret, res.ToString());
        var denied = Assert.Single(Audit(owner.WorkspaceId, "document.secret_reveal_denied"));
        Assert.Equal(member.UserId, denied.UserId);
        Assert.Empty(Audit(owner.WorkspaceId, "document.secret_revealed"));
    }

    [Fact]
    public async Task Every_reveal_and_every_denied_reveal_leaves_exactly_one_audit_row()
    {
        var (owner, doc, id) = await Setup();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member);
        await owner.Post($"/api/v1/documents/{doc}/grants", new { principalType = "User", principalId = member.UserId, level = "Viewer" });
        for (var i = 0; i < 7; i++) Assert.True((await owner.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { })).Ok);
        for (var i = 0; i < 4; i++) Assert.False((await member.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { })).Ok);
        Assert.Equal(7, Audit(owner.WorkspaceId, "document.secret_revealed").Count);
        Assert.Equal(4, Audit(owner.WorkspaceId, "document.secret_reveal_denied").Count);
        Assert.All(Audit(owner.WorkspaceId, "document.secret_revealed"), a => { Assert.NotNull(a.UserId); Assert.Equal("203.0.113.7", a.IpAddress); });
    }

    [Fact]
    public async Task Reveals_are_limited_per_minute()
    {
        var (owner, doc, id) = await Setup();
        for (var i = 0; i < SecretService.ReleasesPerMinute; i++) Assert.True((await owner.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { })).Ok);
        var res = await owner.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { });
        Assert.Equal((HttpStatusCode)429, res.Status);
        Assert.Equal("SECRET_REVEAL_LIMITED", res.ErrorCode);
    }

    [Fact]
    public async Task A_reader_cannot_add_change_or_delete_secrets_and_other_workspaces_see_nothing()
    {
        var (owner, doc, id) = await Setup();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member);
        await owner.Post($"/api/v1/documents/{doc}/grants", new { principalType = "User", principalId = member.UserId, level = "Viewer" });
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Post($"/api/v1/documents/{doc}/secrets", new { label = "x", value = "y" })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Delete($"/api/v1/documents/{doc}/secrets/{id}")).Status);

        var other = await TestClient.RegisterAsync(factory, "Other Org");
        await other.CreateOrgAsync(); await other.UpgradeAsync("BUSINESS", 5);
        Assert.Equal(HttpStatusCode.NotFound, (await other.Get($"/api/v1/documents/{doc}/secrets")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await other.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { })).Status);
    }

    [Fact]
    public async Task Ciphertext_copied_to_another_row_does_not_open()
    {
        var (owner, doc, id) = await Setup();
        var second = await owner.Post($"/api/v1/documents/{doc}/secrets", new { label = "Other", value = "different-value" });
        var id2 = Guid.Parse(S(second.Data!["items"]!.AsArray().First(i => S(i!["label"]) == "Other")!["id"]));
        factory.WithDb(db =>
        {
            var a = db.SensitiveValues.IgnoreQueryFilters().Single(v => v.Id == id).Cipher;
            db.SensitiveValues.IgnoreQueryFilters().Where(v => v.Id == id2).ExecuteUpdate(s => s.SetProperty(v => v.Cipher, a));
            return 0;
        });
        var res = await owner.Post($"/api/v1/documents/{doc}/secrets/{id2}/reveal", new { });
        Assert.Equal(HttpStatusCode.Conflict, res.Status);
        Assert.Equal("SECRET_UNREADABLE", res.ErrorCode);
        Assert.DoesNotContain(Secret, res.ToString());
    }

    // ------------------------------------------------------------------ confidential values need a fresh two-step check

    [Fact]
    public async Task A_confidential_value_is_refused_without_a_fresh_two_step_check_and_opens_with_one()
    {
        var (owner, doc, id) = await Setup(@class: "Confidential");
        var none = await owner.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { });
        Assert.Equal(HttpStatusCode.Forbidden, none.Status);
        Assert.Equal("STEP_UP_REQUIRED", none.ErrorCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { stepUp = "made-up-token" })).Status);
        Assert.Equal(2, Audit(owner.WorkspaceId, "document.secret_reveal_denied").Count);

        // Without two-step verification on the account there is nothing to check with.
        var noMfa = await owner.Post("/api/v1/documents/step-up", new { code = "123456" });
        Assert.Equal("MFA_NOT_ENABLED", noMfa.ErrorCode);

        var secret = await EnableMfa(owner);
        Assert.False((await owner.Post("/api/v1/documents/step-up", new { code = "000000" })).Ok);
        factory.WithDb(db => { db.Users.IgnoreQueryFilters().Where(u => u.Id == owner.UserId).ExecuteUpdate(s => s.SetProperty(u => u.MfaLastStep, 0L)); return 0; });
        var step = await owner.Post("/api/v1/documents/step-up", new { code = CodeNow(secret) });
        Assert.True(step.Ok, step.ToString());
        var token = S(step.Data!["token"]);

        var ok = await owner.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { stepUp = token });
        Assert.True(ok.Ok, ok.ToString());
        Assert.Equal(Secret, S(ok.Data!["value"]));

        // Another person cannot use it, and it stops working when it expires.
        var member = await owner.AddMemberAsync(factory, TenantRole.Admin);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { stepUp = token })).Status);
        factory.WithDb(db => { db.StepUpGrants.Where(g => g.UserId == owner.UserId).ExecuteUpdate(s => s.SetProperty(g => g.ExpiresAt, DateTime.UtcNow.AddMinutes(-1))); return 0; });
        Assert.Equal("STEP_UP_REQUIRED", (await owner.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { stepUp = token })).ErrorCode);
        Assert.DoesNotContain(token, string.Join(' ', factory.WithDb(db => db.StepUpGrants.Select(g => g.TokenHash).ToList())));   // only a hash is kept
    }

    [Fact]
    public async Task The_confidential_class_is_a_business_feature()
    {
        var (owner, doc, _) = await Setup("PRO");
        var res = await owner.Post($"/api/v1/documents/{doc}/secrets", new { label = "Vault", value = "v", @class = "Confidential" });
        Assert.Equal(HttpStatusCode.Forbidden, res.Status);
        Assert.Equal("FEATURE_NOT_AVAILABLE", res.ErrorCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.Put("/api/v1/document-security/reveal-duration", new { seconds = 30 })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.Post("/api/v1/document-security/rotate-key")).Status);
    }

    // ------------------------------------------------------------------ the reveal time the administrator sets

    [Fact]
    public async Task Administrators_set_how_long_a_revealed_value_stays_visible()
    {
        var (owner, doc, id) = await Setup();
        foreach (var seconds in new[] { 10, 15, 30, 60, 45 })
        {
            Assert.True((await owner.Put("/api/v1/document-security/reveal-duration", new { seconds })).Ok);
            Assert.Equal(seconds, (await owner.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { })).Data!["revealSeconds"]!.GetValue<int>());
            Assert.Equal(seconds, (await owner.Get($"/api/v1/documents/{doc}/secrets")).Data!["revealSeconds"]!.GetValue<int>());
        }
        Assert.False((await owner.Put("/api/v1/document-security/reveal-duration", new { seconds = 4 })).Ok);
        Assert.False((await owner.Put("/api/v1/document-security/reveal-duration", new { seconds = 301 })).Ok);
        var member = await owner.AddMemberAsync(factory, TenantRole.Member);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Put("/api/v1/document-security/reveal-duration", new { seconds = 10 })).Status);
        Assert.Equal(5, Audit(owner.WorkspaceId, "org.reveal_duration_changed").Count);
    }

    // ------------------------------------------------------------------ key rotation

    [Fact]
    public async Task Rotation_moves_ten_thousand_values_to_the_new_key_with_no_failed_read()
    {
        var (owner, doc, id) = await Setup();
        var tenant = owner.WorkspaceId;
        var expected = new Dictionary<Guid, string>();
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var crypto = scope.ServiceProvider.GetRequiredService<EnvelopeCrypto>();
            var key = await crypto.ActiveKeyAsync(tenant);
            for (var i = 0; i < 10_000; i++)
            {
                var v = new SensitiveValue { TenantId = tenant, DocumentId = doc, Label = $"bulk-{i}", KeyVersion = key.Version, ValueChangedAt = DateTime.UtcNow };
                v.Cipher = crypto.Encrypt(key, $"value-{i}", $"{tenant:N}|{doc:N}|{v.Id:N}");
                expected[v.Id] = $"value-{i}";
                db.SensitiveValues.Add(v);
                if (i % 1000 == 999) { await db.SaveChangesAsync(); db.ChangeTracker.Clear(); }
            }
        }

        var rotate = await owner.Post("/api/v1/document-security/rotate-key");
        Assert.True(rotate.Ok, rotate.ToString());
        Assert.Equal(2, rotate.Data!["keyVersion"]!.GetValue<int>());
        Assert.Equal(0, rotate.Data["valuesOnOldKeys"]!.GetValue<int>());
        Assert.Equal(10_001, rotate.Data["valuesTotal"]!.GetValue<int>());

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var crypto = scope.ServiceProvider.GetRequiredService<EnvelopeCrypto>();
            var rows = db.SensitiveValues.IgnoreQueryFilters().AsNoTracking().Where(v => v.TenantId == tenant).ToList();
            Assert.All(rows, r => Assert.Equal(2, r.KeyVersion));
            var failed = 0;
            foreach (var r in rows)
            {
                try
                {
                    var plain = crypto.Decrypt(await crypto.KeyAsync(tenant, r.KeyVersion), r.Cipher, $"{tenant:N}|{r.DocumentId:N}|{r.Id:N}");
                    if (r.Id == id ? plain != Secret : plain != expected[r.Id]) failed++;
                }
                catch { failed++; }
            }
            Assert.Equal(0, failed);
        }
        Assert.Equal(Secret, S((await owner.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { })).Data!["value"]));
    }

    [Fact]
    public async Task Values_still_on_the_old_key_stay_readable_and_the_nightly_job_finishes_the_move()
    {
        var (owner, doc, id) = await Setup();
        var tenant = owner.WorkspaceId;
        using var scope = factory.Services.CreateScope();
        var crypto = scope.ServiceProvider.GetRequiredService<EnvelopeCrypto>();
        await crypto.RotateAsync(tenant);   // a new key exists, but nothing was moved (as if the request was cut short)
        await scope.ServiceProvider.GetRequiredService<AppDbContext>().SaveChangesAsync();
        Assert.Equal(Secret, S((await owner.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { })).Data!["value"]));   // read on the old key

        var moved = await scope.ServiceProvider.GetRequiredService<KeyRotationService>().ContinueAllAsync();
        Assert.True(moved >= 1);
        Assert.Equal(2, factory.WithDb(db => db.SensitiveValues.IgnoreQueryFilters().Single(v => v.Id == id).KeyVersion));
        Assert.Equal(Secret, S((await owner.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { })).Data!["value"]));
    }

    // ------------------------------------------------------------------ nothing leaks

    [Fact]
    public async Task The_value_appears_nowhere_outside_a_successful_reveal()
    {
        var (owner, doc, id) = await Setup(@class: "Confidential");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member);
        await owner.Post($"/api/v1/documents/{doc}/grants", new { principalType = "User", principalId = member.UserId, level = "Editor" });
        await member.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { });                  // denied
        await owner.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { });                   // refused: no step-up
        await owner.Put($"/api/v1/documents/{doc}/secrets/{id}", new { label = "Production key", value = Secret + "-2", note = "rotated", @class = "Confidential" });
        await owner.Post("/api/v1/document-security/rotate-key");
        await owner.Post("/api/v1/document-security/verify-audit");
        await owner.Delete($"/api/v1/documents/{doc}/secrets/{id}");

        var sweep = factory.WithDb(db => new[]
        {
            string.Join('\n', db.AuditLogs.IgnoreQueryFilters().Select(a => a.OldValue + "|" + a.NewValue + "|" + a.Action)),
            string.Join('\n', db.Activities.IgnoreQueryFilters().Select(a => a.Summary + "|" + a.OldValue + "|" + a.NewValue)),
            string.Join('\n', db.Notifications.IgnoreQueryFilters().Select(n => n.Title + "|" + n.Body)),
            string.Join('\n', db.DocumentSections.IgnoreQueryFilters().Select(s => s.ContentJson)),
        });
        foreach (var s in sweep) { Assert.DoesNotContain(Secret, s); }
        Assert.DoesNotContain(factory.Logs.Lines, l => l.Contains("sk_live_Zx9"));
        foreach (var url in new[] { $"/api/v1/documents/{doc}", $"/api/v1/documents/{doc}/secrets", $"/api/v1/documents/{doc}/activity", "/api/v1/document-security" })
            Assert.DoesNotContain("sk_live_Zx9", (await owner.Get(url)).ToString());
    }

    // ------------------------------------------------------------------ the audit trail

    [Fact]
    public async Task The_trail_verifies_and_any_change_to_a_row_is_found_and_named()
    {
        if (OnPostgres) return;   // PostgreSQL refuses the change itself; see the next test
        var (owner, doc, id) = await Setup();
        for (var i = 0; i < 4; i++) await owner.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { });
        var ok = await owner.Post("/api/v1/document-security/verify-audit");
        Assert.True(ok.Ok, ok.ToString());
        Assert.True(ok.Data!["intact"]!.GetValue<bool>());
        Assert.True(ok.Data["records"]!.GetValue<long>() >= 5);

        var target = Audit(owner.WorkspaceId, "document.secret_revealed")[1];
        factory.WithDb(db => { db.AuditLogs.IgnoreQueryFilters().Where(a => a.Id == target.Id).ExecuteUpdate(s => s.SetProperty(a => a.UserId, (Guid?)null)); return 0; });
        var bad = await owner.Post("/api/v1/document-security/verify-audit");
        Assert.False(bad.Data!["intact"]!.GetValue<bool>());
        Assert.Equal(target.Seq, bad.Data["brokenSeq"]!.GetValue<long>());
        Assert.Equal(target.Id, Guid.Parse(S(bad.Data["brokenId"])));
        Assert.Equal("its content was changed", S(bad.Data["reason"]));
    }

    [Fact]
    public async Task A_deleted_row_is_found_as_a_gap()
    {
        if (OnPostgres) return;
        var (owner, doc, id) = await Setup();
        for (var i = 0; i < 4; i++) await owner.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { });
        var target = Audit(owner.WorkspaceId, "document.secret_revealed")[1];
        factory.WithDb(db => { db.AuditLogs.IgnoreQueryFilters().Where(a => a.Id == target.Id).ExecuteDelete(); return 0; });
        var bad = await owner.Post("/api/v1/document-security/verify-audit");
        Assert.False(bad.Data!["intact"]!.GetValue<bool>());
        Assert.Equal(target.Seq, bad.Data["brokenSeq"]!.GetValue<long>());
        Assert.Equal("a record is missing before this one", S(bad.Data["reason"]));
    }

    [Fact]
    public async Task PostgreSQL_refuses_to_change_or_delete_an_audit_row()
    {
        if (!OnPostgres) return;
        var (owner, doc, id) = await Setup();
        await owner.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { });
        var row = Audit(owner.WorkspaceId, "document.secret_revealed")[0];
        Assert.ThrowsAny<Exception>(() => factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Where(a => a.Id == row.Id).ExecuteUpdate(s => s.SetProperty(a => a.Action, "x"))));
        Assert.ThrowsAny<Exception>(() => factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Where(a => a.Id == row.Id).ExecuteDelete()));
        Assert.True((await owner.Post("/api/v1/document-security/verify-audit")).Data!["intact"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Writers_at_the_same_moment_get_distinct_positions_and_the_chain_stays_whole()
    {
        var (owner, doc, _) = await Setup();
        var results = await Task.WhenAll(Enumerable.Range(0, 24).Select(i => owner.Post($"/api/v1/documents/{doc}/secrets", new { label = $"parallel-{i}", value = $"v{i}" })));
        Assert.All(results, r => Assert.True(r.Ok, r.ToString()));
        var seqs = factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Where(a => a.TenantId == owner.WorkspaceId && a.Seq != null).Select(a => a.Seq!.Value).OrderBy(x => x).ToList());
        Assert.Equal(seqs.Count, seqs.Distinct().Count());
        Assert.Equal(Enumerable.Range(1, seqs.Count).Select(x => (long)x), seqs);
        Assert.True((await owner.Post("/api/v1/document-security/verify-audit")).Data!["intact"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Retention_removes_old_rows_keeps_the_chain_verifiable_and_new_rows_continue_it()
    {
        var (owner, doc, id) = await Setup();
        for (var i = 0; i < 3; i++) await owner.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { });
        var tenant = owner.WorkspaceId;
        var before = factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Count(a => a.TenantId == tenant && a.Seq != null));
        int removed;
        using (var scope = factory.Services.CreateScope())
            removed = await scope.ServiceProvider.GetRequiredService<AuditChainService>().PurgeAsync(tenant, DateTime.UtcNow.AddMinutes(1));
        Assert.True(removed >= before - 1);
        Assert.True(factory.WithDb(db => db.TenantSecuritySettings.IgnoreQueryFilters().Single(t => t.TenantId == tenant).ChainAnchorSeq) >= removed);

        await owner.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { });   // a new row continues from the anchor
        var res = await owner.Post("/api/v1/document-security/verify-audit");
        Assert.True(res.Data!["intact"]!.GetValue<bool>(), res.ToString());
        var first = factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Where(a => a.TenantId == tenant && a.Seq != null).OrderBy(a => a.Seq).First());
        Assert.True(first.Seq > removed - 1);
    }

    [Fact]
    public async Task Retention_never_discards_evidence_of_tampering()
    {
        if (OnPostgres) return;
        var (owner, doc, id) = await Setup();
        await owner.Post($"/api/v1/documents/{doc}/secrets/{id}/reveal", new { });
        var target = Audit(owner.WorkspaceId, "document.secret_revealed")[0];
        factory.WithDb(db => { db.AuditLogs.IgnoreQueryFilters().Where(a => a.Id == target.Id).ExecuteUpdate(s => s.SetProperty(a => a.IpAddress, "6.6.6.6")); return 0; });
        using var scope = factory.Services.CreateScope();
        Assert.Equal(0, await scope.ServiceProvider.GetRequiredService<AuditChainService>().PurgeAsync(owner.WorkspaceId, DateTime.UtcNow.AddMinutes(1)));
        Assert.True(factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Any(a => a.Id == target.Id)));
    }

    [Fact]
    public void The_hash_covers_every_field_of_a_row()
    {
        var a = new AuditLog { TenantId = Guid.NewGuid(), Seq = 5, UserId = Guid.NewGuid(), Action = "x", EntityType = "T", EntityId = Guid.NewGuid(), OldValue = "o", NewValue = "n", IpAddress = "1.1.1.1", UserAgent = "ua", CreatedAt = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc).AddTicks(1230) };
        var h = AuditChain.Compute(a, "prev");
        Assert.Equal(h, AuditChain.Compute(a, "prev"));
        Assert.NotEqual(h, AuditChain.Compute(a, "other"));
        foreach (var change in new Action<AuditLog>[] { r => r.Seq = 6, r => r.UserId = Guid.NewGuid(), r => r.Action = "y", r => r.EntityType = "U", r => r.EntityId = Guid.NewGuid(), r => r.OldValue = "p", r => r.NewValue = "m", r => r.IpAddress = "2.2.2.2", r => r.UserAgent = "ub", r => r.CreatedAt = r.CreatedAt.AddSeconds(1), r => r.TenantId = Guid.NewGuid() })
        {
            var copy = new AuditLog { TenantId = a.TenantId, Seq = a.Seq, UserId = a.UserId, Action = a.Action, EntityType = a.EntityType, EntityId = a.EntityId, OldValue = a.OldValue, NewValue = a.NewValue, IpAddress = a.IpAddress, UserAgent = a.UserAgent, CreatedAt = a.CreatedAt };
            change(copy);
            Assert.NotEqual(h, AuditChain.Compute(copy, "prev"));
        }
    }
}
