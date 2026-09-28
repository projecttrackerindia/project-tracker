using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The go-live checklist and the e-mail test that platform administrators use before opening the system to real people.</summary>
[Collection("api")]
public class GoLiveTests(ApiFactory factory)
{
    private async Task<TestClient> AdminWith(string password = "Passw0rd!x")
    {
        // A default password such as Admin@12345 can't be chosen through the API (the password policy refuses it); it only exists
        // because the seeder created the account. Recreate that state directly.
        var c = await TestClient.RegisterAsync(factory, "Admin");
        var hash = factory.Services.GetRequiredService<ProjectManagement.Application.Abstractions.IPasswordHasher>().Hash(password);
        factory.WithDb(db => { db.Users.IgnoreQueryFilters().Where(u => u.Id == c.UserId).ExecuteUpdate(s => s.SetProperty(u => u.IsPlatformAdmin, true).SetProperty(u => u.PasswordHash, hash)); return 0; });
        await c.LoginAsync(password);
        return c;
    }

    private static JsonNode Check(JsonNode report, string id) => report["checks"]!.AsArray().Single(c => c!["id"]!.GetValue<string>() == id)!;
    private static string Status(JsonNode report, string id) => Check(report, id)["status"]!.GetValue<string>();

    private string WriteBackup(string name, TimeSpan age, int bytes = 2048)
    {
        var file = Path.Combine(factory.BackupsPath, name);
        File.WriteAllBytes(file, new byte[bytes]);
        File.SetLastWriteTimeUtc(file, DateTime.UtcNow - age);
        return file;
    }

    private void ClearBackups() { foreach (var f in Directory.GetFiles(factory.BackupsPath)) File.Delete(f); }

    [Fact]
    public async Task Only_platform_administrators_can_see_the_checklist_or_send_the_test_mail()
    {
        var user = await TestClient.RegisterAsync(factory);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.Get("/api/v1/admin/go-live")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.Post("/api/v1/admin/test-email")).Status);
    }

    [Fact]
    public async Task The_checklist_flags_a_development_setup_and_never_reveals_a_secret()
    {
        var admin = await AdminWith();
        var report = (await admin.Get("/api/v1/admin/go-live")).Data!;
        Assert.Equal("not-ready", report["verdict"]!.GetValue<string>());
        Assert.True(report["failing"]!.GetValue<int>() >= 2);

        Assert.Equal("fail", Status(report, "email"));       // messages only go to the server log
        Assert.Equal("fail", Status(report, "https"));       // the public address is plain http
        Assert.Equal("fail", Status(report, "ssrf"));        // tests allow private webhook targets
        Assert.All(report["checks"]!.AsArray(), c => Assert.Contains(c!["status"]!.GetValue<string>(), new[] { "ok", "warn", "fail" }));
        Assert.All(report["checks"]!.AsArray().Where(c => c!["status"]!.GetValue<string>() != "ok"), c => Assert.False(string.IsNullOrWhiteSpace(c!["fix"]?.GetValue<string>())));

        // Nothing sensitive: not the signing key, not the database password.
        var text = report.ToJsonString();
        Assert.DoesNotContain("test-signing-key", text);
        Assert.DoesNotContain("Password=", text);
    }

    [Fact]
    public async Task An_administrator_still_using_a_default_password_is_called_out_by_address()
    {
        var weak = await AdminWith("Admin@12345");
        var report = (await weak.Get("/api/v1/admin/go-live")).Data!;
        Assert.Equal("fail", Status(report, "admin-password"));
        Assert.Contains(weak.Email, Check(report, "admin-password")["detail"]!.GetValue<string>());
        Assert.Contains("Change password", Check(report, "admin-password")["fix"]!.GetValue<string>());

        // After choosing a strong password the address is no longer listed.
        Assert.True((await weak.Post("/api/v1/me/password", new { currentPassword = "Admin@12345", newPassword = "Str0ng&Unique#Pass" })).Ok);
        Assert.True((await weak.LoginAsync("Str0ng&Unique#Pass")).Ok);
        Assert.DoesNotContain(weak.Email, Check((await weak.Get("/api/v1/admin/go-live")).Data!, "admin-password")["detail"]!.GetValue<string>());
    }

    [Fact]
    public async Task The_backup_check_follows_what_is_in_the_backup_folder()
    {
        var admin = await AdminWith();
        try
        {
            ClearBackups();
            Assert.Equal("fail", Status((await admin.Get("/api/v1/admin/go-live")).Data!, "backup"));      // a folder but nothing in it

            WriteBackup("db-20260101-020000.dump", TimeSpan.FromHours(50));
            var stale = Check((await admin.Get("/api/v1/admin/go-live")).Data!, "backup");
            Assert.Equal("fail", stale["status"]!.GetValue<string>());
            Assert.Contains("db-20260101-020000.dump", stale["detail"]!.GetValue<string>());

            WriteBackup("db-20260102-020000.dump", TimeSpan.FromHours(3), 3 * 1024 * 1024);
            var fresh = Check((await admin.Get("/api/v1/admin/go-live")).Data!, "backup");
            Assert.Equal("ok", fresh["status"]!.GetValue<string>());
            Assert.Contains("db-20260102-020000.dump", fresh["detail"]!.GetValue<string>());     // the newest one is reported
        }
        finally { ClearBackups(); }
    }

    [Fact]
    public async Task The_test_email_goes_to_the_signed_in_administrator_and_reports_the_result()
    {
        var admin = await AdminWith();
        var res = await admin.Post("/api/v1/admin/test-email");
        Assert.True(res.Ok, res.ToString());
        Assert.True(res.Data!["sent"]!.GetValue<bool>());
        Assert.Equal(admin.Email, res.Data["to"]!.GetValue<string>());
        Assert.NotEmpty(res.Data["provider"]!.GetValue<string>());
    }
}
