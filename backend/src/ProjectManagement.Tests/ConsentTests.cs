using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Terms of Service / Privacy Policy: publishing a version, who is asked to accept it, and what accepting unlocks.</summary>
[Collection("api")]
public class ConsentTests(ApiFactory factory)
{
    private async Task<TestClient> AdminWith(string password = "Passw0rd!x")
    {
        var c = await TestClient.RegisterAsync(factory, "Admin");
        var hash = factory.Services.GetRequiredService<ProjectManagement.Application.Abstractions.IPasswordHasher>().Hash(password);
        factory.WithDb(db => { db.Users.IgnoreQueryFilters().Where(u => u.Id == c.UserId).ExecuteUpdate(s => s.SetProperty(u => u.IsPlatformAdmin, true).SetProperty(u => u.PasswordHash, hash)); return 0; });
        await c.LoginAsync(password);
        return c;
    }

    [Fact]
    public async Task Anyone_can_read_the_current_documents_without_signing_in()
    {
        var res = await new TestClient(factory).Get("/api/v1/consent/documents");
        Assert.Equal(HttpStatusCode.OK, res.Status);
        var docs = res.Data!.AsArray();
        Assert.Equal(2, docs.Count);
        Assert.Contains(docs, d => d!["type"]!.GetValue<string>() == "tos");
        Assert.Contains(docs, d => d!["type"]!.GetValue<string>() == "privacy");
    }

    [Fact]
    public async Task Registering_without_accepting_the_terms_is_refused()
    {
        var c = new TestClient(factory);
        c.Email = $"user-{Guid.NewGuid():N}@example.com";
        var res = await c.Send(HttpMethod.Post, "/api/v1/auth/register", new { email = c.Email, password = "Passw0rd!x", displayName = "No Accept", acceptedTerms = false }, true);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.Status);
    }

    [Fact]
    public async Task Before_anything_is_published_a_new_member_is_already_up_to_date()
    {
        var c = await TestClient.RegisterAsync(factory);
        var status = await c.Get("/api/v1/consent/status");
        Assert.True(status.Data!["upToDate"]!.GetValue<bool>());
        Assert.Empty(status.Data!["pending"]!.AsArray());
    }

    [Fact]
    public async Task Only_a_platform_administrator_can_publish_a_document()
    {
        var c = await TestClient.RegisterAsync(factory);
        var res = await c.Put("/api/v1/admin/consent", new { type = "tos", title = "Terms", body = new string('x', 30) });
        Assert.Equal(HttpStatusCode.Forbidden, res.Status);
    }

    [Fact]
    public async Task Publishing_moves_the_version_from_0_to_1_and_is_readable_by_anyone()
    {
        // Other tests in this shared-database collection may have published "tos" before this one runs, so this
        // asserts the version moved forward by one rather than assuming it starts at a specific number.
        var before = (await new TestClient(factory).Get("/api/v1/consent/documents")).Data!.AsArray().Single(d => d!["type"]!.GetValue<string>() == "tos")!["version"]!.GetValue<int>();
        var admin = await AdminWith();
        var pub = await admin.Put("/api/v1/admin/consent", new { type = "tos", title = "Our Terms", body = new string('x', 30) });
        Assert.Equal(HttpStatusCode.OK, pub.Status);
        Assert.Equal(before + 1, pub.Data!["version"]!.GetValue<int>());

        var docs = await new TestClient(factory).Get("/api/v1/consent/documents");
        var tos = docs.Data!.AsArray().Single(d => d!["type"]!.GetValue<string>() == "tos");
        Assert.Equal("Our Terms", tos!["title"]!.GetValue<string>());
        Assert.Equal(before + 1, tos["version"]!.GetValue<int>());
    }

    [Fact]
    public async Task An_existing_member_is_asked_to_accept_a_newly_published_document_and_changes_are_paused_until_they_do()
    {
        var admin = await AdminWith();
        var member = await TestClient.RegisterAsync(factory, "Member");

        await admin.Put("/api/v1/admin/consent", new { type = "tos", title = "Our Terms", body = new string('x', 30) });

        var status = await member.Get("/api/v1/consent/status");
        Assert.False(status.Data!["upToDate"]!.GetValue<bool>());
        Assert.Contains(status.Data!["pending"]!.AsArray(), d => d!["type"]!.GetValue<string>() == "tos");

        // Reading still works …
        var me = await member.Get("/api/v1/me");
        Assert.Equal(HttpStatusCode.OK, me.Status);

        // … but changing something is paused with a clear, specific reason.
        var blocked = await member.Post("/api/v1/workspaces", new { name = "Acme" });
        Assert.Equal(HttpStatusCode.Forbidden, blocked.Status);
        Assert.Equal("CONSENT_REQUIRED", blocked.ErrorCode);

        // Accepting unblocks them immediately, without needing to sign in again.
        var accept = await member.Post("/api/v1/consent/accept", new { types = new[] { "tos" } });
        Assert.True(accept.Data!["upToDate"]!.GetValue<bool>());
        var allowed = await member.Post("/api/v1/workspaces", new { name = "Acme" });
        Assert.Equal(HttpStatusCode.Created, allowed.Status);
    }

    [Fact]
    public async Task Someone_who_registers_after_a_document_was_published_accepts_it_at_sign_up_and_is_never_blocked()
    {
        var admin = await AdminWith();
        await admin.Put("/api/v1/admin/consent", new { type = "privacy", title = "Our Privacy Policy", body = new string('x', 30) });

        var newcomer = await TestClient.RegisterAsync(factory, "Newcomer");
        var status = await newcomer.Get("/api/v1/consent/status");
        Assert.True(status.Data!["upToDate"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Publishing_again_asks_even_someone_who_already_accepted_the_previous_version()
    {
        var admin = await AdminWith();
        var member = await TestClient.RegisterAsync(factory, "Member");
        await admin.Put("/api/v1/admin/consent", new { type = "tos", title = "v1", body = new string('x', 30) });
        await member.Post("/api/v1/consent/accept", new { types = new[] { "tos" } });
        Assert.True((await member.Get("/api/v1/consent/status")).Data!["upToDate"]!.GetValue<bool>());

        await admin.Put("/api/v1/admin/consent", new { type = "tos", title = "v2", body = new string('y', 30) });
        Assert.False((await member.Get("/api/v1/consent/status")).Data!["upToDate"]!.GetValue<bool>());
    }
}
