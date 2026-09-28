using System.Net;
using System.Net.Http.Headers;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>API keys: secrets for scripts that act as the person who made them, inside one workspace.</summary>
[Collection("api")]
public class ApiKeyTests(ApiFactory factory)
{
    private async Task<(TestClient Owner, Guid Project)> Setup(string plan = "BUSINESS")
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        if (plan != "FREE") await c.UpgradeAsync(plan);
        return (c, await c.CreateProjectAsync("Atlas"));
    }

    private static async Task<(string Secret, Guid Id)> NewKey(TestClient c, string scope = "ReadWrite", int? days = null, string name = "CI")
    {
        var res = await c.Post("/api/v1/api-keys", new { name, scope, expiresInDays = days });
        Assert.Equal(HttpStatusCode.Created, res.Status);
        return (res.Data!["secret"]!.GetValue<string>(), Guid.Parse(res.Data["key"]!["id"]!.GetValue<string>()));
    }

    /// <summary>A client that authenticates with the key instead of a login token.</summary>
    private TestClient As(string secret) => new(factory) { Token = secret };

    [Fact]
    public async Task A_key_is_shown_once_and_never_stored_or_listed_in_clear()
    {
        var (c, _) = await Setup();
        var (secret, id) = await NewKey(c);
        Assert.StartsWith("pmk_", secret);

        var listed = (await c.Get("/api/v1/api-keys")).Data!;
        Assert.Contains(listed.AsArray(), k => k!["id"]!.GetValue<string>() == id.ToString());
        Assert.DoesNotContain(secret, listed.ToJsonString());
        Assert.DoesNotContain(secret[(secret.LastIndexOf('_') + 1)..], listed.ToJsonString());
        Assert.StartsWith(listed[0]!["prefix"]!.GetValue<string>(), secret);

        var stored = factory.WithDb(db => db.ApiKeys.IgnoreQueryFilters().Single(k => k.Id == id).SecretHash);
        Assert.Equal(64, stored.Length);
        Assert.DoesNotContain(secret, stored);
    }

    [Fact]
    public async Task A_key_acts_as_its_owner_in_its_workspace_and_updates_last_used()
    {
        var (c, project) = await Setup();
        var (secret, id) = await NewKey(c);
        var api = As(secret);

        var projects = await api.Get("/api/v1/projects");
        Assert.True(projects.Ok, projects.ToString());
        Assert.Contains(project.ToString(), projects.Data!.ToJsonString());
        Assert.True((await api.Get($"/api/v1/projects/{project}/tasks")).Ok);
        Assert.True((await api.Get("/api/v1/me")).Ok);

        var created = await api.Post($"/api/v1/projects/{project}/tasks", new { title = "From a script", priority = "Low" });
        Assert.Equal(HttpStatusCode.Created, created.Status);
        Assert.Equal(c.UserId.ToString(), created.Data!["reporter"]!["id"]!.GetValue<string>()); // acts as the person who made the key

        var key = (await c.Get("/api/v1/api-keys")).Data!.AsArray().Single(k => k!["id"]!.GetValue<string>() == id.ToString())!;
        Assert.NotNull(key["lastUsedAt"]);
    }

    [Fact]
    public async Task The_x_api_key_header_works_too()
    {
        var (c, _) = await Setup();
        var (secret, _) = await NewKey(c);
        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/v1/projects");
        req.Headers.Add("X-Api-Key", secret);
        using var res = await c.Http.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    [Fact]
    public async Task Read_only_keys_cannot_change_anything()
    {
        var (c, project) = await Setup();
        var (secret, _) = await NewKey(c, "ReadOnly");
        var api = As(secret);
        Assert.True((await api.Get($"/api/v1/projects/{project}/tasks")).Ok);
        var write = await api.Post($"/api/v1/projects/{project}/tasks", new { title = "Nope", priority = "Low" });
        Assert.Equal(HttpStatusCode.Forbidden, write.Status);
        Assert.Equal("API_KEY_READ_ONLY", write.ErrorCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await api.Delete($"/api/v1/projects/{project}")).Status);
    }

    [Fact]
    public async Task Keys_can_never_reach_account_billing_admin_or_key_management()
    {
        var (c, _) = await Setup();
        var (secret, _) = await NewKey(c);
        var api = As(secret);
        foreach (var path in new[] { "/api/v1/api-keys", "/api/v1/billing", "/api/v1/workspaces", "/api/v1/admin/stats", "/api/v1/me/sessions", "/api/v1/me/mfa" })
        {
            var res = await api.Get(path);
            Assert.Equal(HttpStatusCode.Forbidden, res.Status);
            Assert.Equal("API_KEY_NOT_ALLOWED", res.ErrorCode);
        }
        Assert.Equal("API_KEY_NOT_ALLOWED", (await api.Post("/api/v1/api-keys", new { name = "x", scope = "ReadWrite" })).ErrorCode);
        Assert.Equal("API_KEY_NOT_ALLOWED", (await api.Post("/api/v1/me/password", new { currentPassword = "a", newPassword = "b" })).ErrorCode);
    }

    [Fact]
    public async Task Revoked_expired_tampered_and_unknown_keys_are_refused()
    {
        var (c, _) = await Setup();
        var (secret, id) = await NewKey(c);
        var (short_, shortId) = await NewKey(c, "ReadOnly", 30, "short lived");
        Assert.True((await As(secret).Get("/api/v1/projects")).Ok);

        Assert.Equal(HttpStatusCode.NoContent, (await c.Delete($"/api/v1/api-keys/{id}")).Status);
        var revoked = await As(secret).Get("/api/v1/projects");
        Assert.Equal(HttpStatusCode.Unauthorized, revoked.Status);
        Assert.Equal("INVALID_API_KEY", revoked.ErrorCode);
        Assert.Equal("Revoked", (await c.Get("/api/v1/api-keys")).Data!.AsArray().Single(k => k!["id"]!.GetValue<string>() == id.ToString())!["status"]!.GetValue<string>());

        factory.WithDb(db => { db.ApiKeys.IgnoreQueryFilters().Where(k => k.Id == shortId).ExecuteUpdate(s => s.SetProperty(k => k.ExpiresAt, DateTime.UtcNow.AddMinutes(-1))); return 0; });
        Assert.Equal(HttpStatusCode.Unauthorized, (await As(short_).Get("/api/v1/projects")).Status);

        var (live, _) = await NewKey(c);
        Assert.Equal(HttpStatusCode.Unauthorized, (await As(live[..^3] + "abc").Get("/api/v1/projects")).Status);
        Assert.Equal(HttpStatusCode.Unauthorized, (await As("pmk_deadbeef_" + new string('a', 43)).Get("/api/v1/projects")).Status);
        Assert.Equal(HttpStatusCode.Unauthorized, (await As("pmk_nonsense").Get("/api/v1/projects")).Status);
    }

    [Fact]
    public async Task A_key_only_sees_its_own_workspace_and_stops_when_its_owner_leaves()
    {
        var (a, projectA) = await Setup();
        var (b, projectB) = await Setup();
        var (secret, _) = await NewKey(a);
        var api = As(secret);
        var seen = (await api.Get("/api/v1/projects")).Data!.ToJsonString();
        Assert.Contains(projectA.ToString(), seen);
        Assert.DoesNotContain(projectB.ToString(), seen);
        Assert.Equal(HttpStatusCode.NotFound, (await api.Get($"/api/v1/projects/{projectB}")).Status);

        // An admin's key stops working when they leave the workspace.
        var admin = await a.AddMemberAsync(factory, TenantRole.Admin, "Adm");
        var (adminKey, _) = await NewKey(admin);
        Assert.True((await As(adminKey).Get("/api/v1/projects")).Ok);
        factory.WithDb(db => { db.TenantMembers.IgnoreQueryFilters().Where(m => m.UserId == admin.UserId && m.TenantId == a.WorkspaceId).ExecuteDelete(); return 0; });
        Assert.False((await As(adminKey).Get("/api/v1/projects")).Ok);
        _ = b;
    }

    [Fact]
    public async Task A_key_never_has_more_rights_than_its_owner_has_now()
    {
        var (owner, project) = await Setup();
        var admin = await owner.AddMemberAsync(factory, TenantRole.Admin, "Adm");
        var (secret, _) = await NewKey(admin);
        Assert.Equal(HttpStatusCode.Created, (await As(secret).Post($"/api/v1/projects/{project}/tasks", new { title = "As admin", priority = "Low" })).Status);

        // Demote the owner of the key to Guest: the same key can no longer write.
        factory.WithDb(db => { db.TenantMembers.IgnoreQueryFilters().Where(m => m.UserId == admin.UserId && m.TenantId == owner.WorkspaceId).ExecuteUpdate(s => s.SetProperty(m => m.Role, TenantRole.Guest)); return 0; });
        Assert.False((await As(secret).Post($"/api/v1/projects/{project}/tasks", new { title = "As guest", priority = "Low" })).Ok);
    }

    [Fact]
    public async Task Managing_keys_needs_an_admin_a_plan_with_api_access_and_respects_limits()
    {
        var (free, _) = await Setup("FREE");
        Assert.Equal(HttpStatusCode.Forbidden, (await free.Post("/api/v1/api-keys", new { name = "x", scope = "ReadOnly" })).Status);

        var (c, _) = await Setup();
        var member = await c.AddMemberAsync(factory, TenantRole.Member, "Mem");
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Post("/api/v1/api-keys", new { name = "x", scope = "ReadOnly" })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get("/api/v1/api-keys")).Status);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post("/api/v1/api-keys", new { name = "", scope = "ReadOnly" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Post("/api/v1/api-keys", new { name = "x", scope = "ReadOnly", expiresInDays = 7 })).Status);

        for (var i = 0; i < 20; i++) await NewKey(c, "ReadOnly", null, $"k{i}");
        var over = await c.Post("/api/v1/api-keys", new { name = "one more", scope = "ReadOnly" });
        Assert.Equal(HttpStatusCode.Conflict, over.Status);
        Assert.Equal("LIMIT_REACHED", over.ErrorCode);
    }

    [Fact]
    public async Task Creating_and_revoking_keys_is_audited()
    {
        var (c, _) = await Setup();
        var (_, id) = await NewKey(c);
        await c.Delete($"/api/v1/api-keys/{id}");
        var actions = factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Where(a => a.UserId == c.UserId).Select(a => a.Action).ToList());
        Assert.Contains("apikey.created", actions);
        Assert.Contains("apikey.revoked", actions);
    }

    [Fact]
    public async Task Keys_stop_working_when_the_plan_loses_api_access_and_resume_when_it_returns()
    {
        var (c, _) = await Setup();
        var (secret, _) = await NewKey(c);
        var api = As(secret);
        Assert.True((await api.Get("/api/v1/projects")).Ok);

        var admin = await TestClient.RegisterAsync(factory, "Admin");
        factory.WithDb(db => { db.Users.Where(u => u.Id == admin.UserId).ExecuteUpdate(s => s.SetProperty(u => u.IsPlatformAdmin, true)); return 0; });
        await admin.LoginAsync();
        Assert.True((await admin.Put($"/api/v1/admin/tenants/{c.WorkspaceId}/overrides/API_ACCESS", new { value = 0, reason = "downgrade" })).Ok);

        var blocked = await api.Get("/api/v1/projects");
        Assert.Equal(HttpStatusCode.Forbidden, blocked.Status);
        Assert.Equal("API_ACCESS_NOT_IN_PLAN", blocked.ErrorCode);

        Assert.True((await admin.Put($"/api/v1/admin/tenants/{c.WorkspaceId}/overrides/API_ACCESS", new { value = 1, reason = "restored" })).Ok);
        Assert.True((await api.Get("/api/v1/projects")).Ok);
    }
}
