using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Files;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>File attachments: storage, allowed types, plan limits, permissions, tenant isolation and clean-up.</summary>
[Collection("api")]
public class AttachmentTests(ApiFactory factory)
{
    private static byte[] Pdf(int extra = 0) => [.. "%PDF-1.4\n%test file\n"u8.ToArray(), .. new byte[extra]];
    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52];

    private async Task<(TestClient Owner, Guid Project, Guid Task)> Setup(string plan = "BUSINESS")
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        if (plan != "FREE") await owner.UpgradeAsync(plan);
        var project = await owner.CreateProjectAsync("Atlas");
        var task = await owner.CreateTaskAsync(project, "Spec");
        return (owner, project, Guid.Parse(task["id"]!.GetValue<string>()));
    }

    private static string ForTask(Guid p, Guid t) => $"/api/v1/projects/{p}/tasks/{t}/attachments";
    private static string ForProject(Guid p) => $"/api/v1/projects/{p}/attachments";
    private static Guid Id(ApiResult r) => Guid.Parse(r.Data!["id"]!.GetValue<string>());

    private Task<bool> BlobExists(Guid attachmentId)
    {
        var key = factory.WithDb(db => db.Attachments.IgnoreQueryFilters().Where(a => a.Id == attachmentId).Select(a => a.StorageKey).FirstOrDefault());
        return key is null ? Task.FromResult(false) : factory.Services.GetRequiredService<IFileStorage>().ExistsAsync(key);
    }

    [Fact]
    public async Task A_file_can_be_attached_listed_downloaded_unchanged_and_removed()
    {
        var (c, project, task) = await Setup();
        var bytes = Pdf(5000);
        var up = await c.Upload(ForTask(project, task), "Spec v1.pdf", bytes);
        Assert.Equal(HttpStatusCode.Created, up.Status);
        var id = Id(up);
        Assert.Equal("Spec v1.pdf", up.Data!["fileName"]!.GetValue<string>());
        Assert.Equal("application/pdf", up.Data["contentType"]!.GetValue<string>());
        Assert.Equal(bytes.Length, up.Data["sizeBytes"]!.GetValue<long>());
        Assert.True(await BlobExists(id));

        var onTask = (await c.Get(ForTask(project, task))).Data!.AsArray();
        Assert.Single(onTask);
        Assert.Equal("Spec", onTask[0]!["taskTitle"]!.GetValue<string>());
        Assert.Single((await c.Get(ForProject(project))).Data!.AsArray());             // project list includes task files

        using var res = await c.Raw($"/api/v1/attachments/{id}/download");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(bytes, await res.Content.ReadAsByteArrayAsync());
        Assert.Equal("application/pdf", res.Content.Headers.ContentType!.MediaType);
        Assert.Equal("attachment", res.Content.Headers.ContentDisposition!.DispositionType);
        Assert.Equal("Spec v1.pdf", res.Content.Headers.ContentDisposition.FileNameStar ?? res.Content.Headers.ContentDisposition.FileName!.Trim('"'));
        Assert.Equal("nosniff", res.Headers.GetValues("X-Content-Type-Options").Single());

        // Images may be shown inline; a PDF never is, even when asked.
        var png = Id(await c.Upload(ForProject(project), "logo.png", Png));
        using var inlineImg = await c.Raw($"/api/v1/attachments/{png}/download?inline=true");
        Assert.Null(inlineImg.Content.Headers.ContentDisposition?.DispositionType);
        using var inlinePdf = await c.Raw($"/api/v1/attachments/{id}/download?inline=true");
        Assert.Equal("attachment", inlinePdf.Content.Headers.ContentDisposition!.DispositionType);

        Assert.Equal(HttpStatusCode.NoContent, (await c.Delete($"/api/v1/attachments/{id}")).Status);
        Assert.False(await BlobExists(id));                                            // the bytes are gone from storage too
        Assert.Equal(HttpStatusCode.NotFound, (await c.Get($"/api/v1/attachments/{id}/download")).Status);
        Assert.Single((await c.Get(ForProject(project))).Data!.AsArray());
    }

    [Fact]
    public async Task Only_safe_types_whose_content_matches_the_extension_are_accepted()
    {
        var (c, project, task) = await Setup();
        foreach (var name in new[] { "run.exe", "page.html", "image.svg", "script.js", "noextension", "archive.pdf.exe", "macro.docm", "tricky.php" })
        {
            var r = await c.Upload(ForTask(project, task), name, Pdf());
            Assert.Equal(HttpStatusCode.UnprocessableEntity, r.Status);
        }
        // Content must agree with the name.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Upload(ForTask(project, task), "fake.png", "MZ this is an executable"u8.ToArray())).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Upload(ForTask(project, task), "fake.pdf", Png)).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Upload(ForTask(project, task), "binary.csv", [1, 2, 0, 3])).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Upload(ForTask(project, task), "empty.pdf", [])).Status);
        Assert.Empty((await c.Get(ForTask(project, task))).Data!.AsArray());

        // Real ones pass: text, spreadsheet-style csv, Office (zip container).
        Assert.Equal(HttpStatusCode.Created, (await c.Upload(ForTask(project, task), "data.csv", "a,b\n1,2\n"u8.ToArray())).Status);
        Assert.Equal(HttpStatusCode.Created, (await c.Upload(ForTask(project, task), "sheet.xlsx", [0x50, 0x4B, 0x03, 0x04, 1, 2, 3])).Status);
    }

    [Fact]
    public async Task Jar_archives_and_other_developer_formats_are_accepted_when_the_content_matches()
    {
        var (c, project, task) = await Setup();
        byte[] zip = [0x50, 0x4B, 0x03, 0x04, 1, 2, 3];
        Assert.Equal(HttpStatusCode.Created, (await c.Upload(ForTask(project, task), "app.jar", zip)).Status);
        Assert.Equal(HttpStatusCode.Created, (await c.Upload(ForTask(project, task), "site.war", zip)).Status);
        Assert.Equal(HttpStatusCode.Created, (await c.Upload(ForTask(project, task), "config.json", "{\"a\":1}"u8.ToArray())).Status);
        Assert.Equal(HttpStatusCode.Created, (await c.Upload(ForTask(project, task), "logs.gz", [0x1F, 0x8B, 8, 0, 0])).Status);
        // A .jar still has to be a real zip container, and executables stay blocked.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Upload(ForTask(project, task), "fake.jar", "MZ this is an executable"u8.ToArray())).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await c.Upload(ForTask(project, task), "run.exe", zip)).Status);
        Assert.Contains((await c.Get("/api/v1/attachments/limits")).Data!["allowedExtensions"]!.AsArray(), e => e!.GetValue<string>() == "jar");
    }

    [Fact]
    public async Task File_names_are_cleaned_and_never_control_where_a_file_is_stored()
    {
        var (c, project, task) = await Setup();
        var up = await c.Upload(ForTask(project, task), @"..\..\evil/..\report.pdf", Pdf());
        Assert.Equal(HttpStatusCode.Created, up.Status);
        Assert.Equal("report.pdf", up.Data!["fileName"]!.GetValue<string>());
        var id = Id(up);
        var key = factory.WithDb(db => db.Attachments.IgnoreQueryFilters().Where(a => a.Id == id).Select(a => a.StorageKey).First());
        Assert.DoesNotContain("report", key);
        Assert.DoesNotContain("..", key);
        Assert.True(File.Exists(Path.Combine(factory.FilesPath, key.Replace('/', Path.DirectorySeparatorChar))));
    }

    [Fact]
    public async Task The_plan_limits_file_size_and_total_storage_and_deleting_frees_space()
    {
        var (c, project, task) = await Setup("FREE");     // Free: 10 MB per file
        var big = await c.Upload(ForTask(project, task), "big.pdf", Pdf(11 * 1024 * 1024));
        Assert.Equal(HttpStatusCode.Forbidden, big.Status);
        Assert.Equal("PLAN_LIMIT_REACHED", big.ErrorCode);
        var limits = (await c.Get("/api/v1/attachments/limits")).Data!;
        Assert.Equal(10L * 1024 * 1024, limits["maxFileBytes"]!.GetValue<long>());
        Assert.Equal(500L * 1024 * 1024, limits["storageLimitBytes"]!.GetValue<long>());
        Assert.Contains(limits["allowedExtensions"]!.AsArray(), e => e!.GetValue<string>() == "pdf");

        // Shrink the Free plan's storage to 1 MB for this test only.
        SetPlanValue("FREE", "STORAGE_LIMIT_MB", 1);
        try
        {
            var first = await c.Upload(ForTask(project, task), "a.pdf", Pdf(600 * 1024));
            Assert.Equal(HttpStatusCode.Created, first.Status);
            var second = await c.Upload(ForTask(project, task), "b.pdf", Pdf(600 * 1024));
            Assert.Equal(HttpStatusCode.Forbidden, second.Status);
            Assert.Equal("PLAN_LIMIT_REACHED", second.ErrorCode);
            Assert.Contains("storage", second.Json!["errors"]![0]!["message"]!.GetValue<string>());

            var usage = (await c.Get("/api/v1/billing")).Data!["usage"]!.AsArray().First(u => u!["key"]!.GetValue<string>() == "STORAGE_LIMIT_MB")!;
            Assert.Equal(1, usage["used"]!.GetValue<int>());
            Assert.Equal(1, usage["limit"]!.GetValue<int>());

            Assert.Equal(HttpStatusCode.NoContent, (await c.Delete($"/api/v1/attachments/{Id(first)}")).Status);
            Assert.Equal(HttpStatusCode.Created, (await c.Upload(ForTask(project, task), "b.pdf", Pdf(600 * 1024))).Status);   // space is free again
        }
        finally { SetPlanValue("FREE", "STORAGE_LIMIT_MB", 500); }
    }

    private void SetPlanValue(string plan, string key, long value) => factory.WithDb(db =>
    {
        var row = db.PlanFeatures.First(f => f.FeatureKey == key && db.Plans.Any(p => p.Id == f.PlanId && p.Code == plan));
        row.Value = value;
        db.SaveChanges();
        return 0;
    });

    [Fact]
    public async Task Workspaces_cannot_see_each_others_files()
    {
        var (a, projectA, taskA) = await Setup();
        var id = Id(await a.Upload(ForTask(projectA, taskA), "secret.pdf", Pdf()));

        var (b, projectB, _) = await Setup();
        Assert.Equal(HttpStatusCode.NotFound, (await b.Get($"/api/v1/attachments/{id}/download")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await b.Delete($"/api/v1/attachments/{id}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await b.Get(ForProject(projectA))).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await b.Upload(ForProject(projectA), "x.pdf", Pdf())).Status);
        Assert.Empty((await b.Get(ForProject(projectB))).Data!.AsArray());
        Assert.True(await BlobExists(id));
        Assert.DoesNotContain((await b.Get("/api/v1/search?q=secret")).Data!["hits"]!.AsArray(), h => h!["type"]!.GetValue<string>() == "file");
    }

    [Fact]
    public async Task Access_follows_projects_permissions_and_job_role_levels()
    {
        var (owner, project, task) = await Setup();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Mia");
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gus");
        var ownerFile = Id(await owner.Upload(ForTask(project, task), "owner.pdf", Pdf()));

        // A guest outside the project sees nothing; once added to it they can read but not add.
        Assert.Equal(HttpStatusCode.NotFound, (await guest.Get($"/api/v1/attachments/{ownerFile}/download")).Status);
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = guest.UserId })).Ok);
        using (var ok = await guest.Raw($"/api/v1/attachments/{ownerFile}/download")) Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await guest.Upload(ForTask(project, task), "g.pdf", Pdf())).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await guest.Delete($"/api/v1/attachments/{ownerFile}")).Status);

        // A member may add files to a task assigned to them, and remove their own but not other people's.
        Assert.True((await owner.Put($"/api/v1/tasks/{task}", new { title = "Spec", priority = "Medium", statusId = (await owner.Get($"/api/v1/projects/{project}")).Data!["statuses"]![0]!["id"]!.GetValue<string>(), assigneeId = member.UserId, version = 1 })).Ok);
        var memberFile = Id(await member.Upload(ForTask(project, task), "mine.pdf", Pdf()));
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Delete($"/api/v1/attachments/{ownerFile}")).Status);
        Assert.Equal(HttpStatusCode.NoContent, (await member.Delete($"/api/v1/attachments/{memberFile}")).Status);
        // ...while an admin-level owner may remove anyone's.
        var again = Id(await member.Upload(ForTask(project, task), "again.pdf", Pdf()));
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Delete($"/api/v1/attachments/{again}")).Status);

        // A view-only job role can read files but not add them; a role without Tasks cannot reach task files at all.
        var viewer = (await owner.Post("/api/v1/org/roles", new { name = "Viewer" })).Data!["id"]!.GetValue<string>();
        var levels = new[] { "projects", "tasks", "calendar", "teams", "members", "organization", "reports", "activity", "audit", "billing" }.ToDictionary(m => m, _ => 0);
        levels["projects"] = 1; levels["tasks"] = 1;
        Assert.True((await owner.Put($"/api/v1/org/members/{member.UserId}/role", new { roleId = viewer })).Ok);
        Assert.True((await owner.Put($"/api/v1/org/roles/{viewer}/access", new { modules = levels, actions = new Dictionary<string, bool>() })).Ok);
        using (var read = await member.Raw($"/api/v1/attachments/{ownerFile}/download")) Assert.Equal(HttpStatusCode.OK, read.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Upload(ForTask(project, task), "nope.pdf", Pdf())).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Upload(ForProject(project), "nope.pdf", Pdf())).Status);
        levels["tasks"] = 0;
        Assert.True((await owner.Put($"/api/v1/org/roles/{viewer}/access", new { modules = levels, actions = new Dictionary<string, bool>() })).Ok);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get(ForTask(project, task))).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get($"/api/v1/attachments/{ownerFile}/download")).Status);
    }

    [Fact]
    public async Task Files_are_searchable_by_name_and_removed_for_good_with_their_deleted_project()
    {
        var (c, project, task) = await Setup();
        var id = Id(await c.Upload(ForTask(project, task), "Quarterly budget.pdf", Pdf()));
        var hits = (await c.Get("/api/v1/search?q=budget")).Data!["hits"]!.AsArray();
        var hit = hits.First(h => h!["type"]!.GetValue<string>() == "file")!;
        Assert.Equal("Quarterly budget.pdf", hit["title"]!.GetValue<string>());
        Assert.Equal(project.ToString(), hit["projectId"]!.GetValue<string>());

        Assert.True((await c.Delete($"/api/v1/projects/{project}")).Ok);
        Assert.Equal(HttpStatusCode.NotFound, (await c.Get($"/api/v1/attachments/{id}/download")).Status);   // hidden with the project
        var usage = (await c.Get("/api/v1/billing")).Data!["usage"]!.AsArray().First(u => u!["key"]!.GetValue<string>() == "STORAGE_LIMIT_MB")!;
        Assert.Equal(0, usage["used"]!.GetValue<int>());                                                      // and no longer counted
        Assert.True(await BlobExists(id));                                                                    // kept for now...

        using (var scope = factory.Services.CreateScope())
        {
            var janitor = scope.ServiceProvider.GetRequiredService<AttachmentJanitor>();
            Assert.Equal(0, await janitor.PurgeOrphansAsync(TimeSpan.FromDays(7)));                          // ...not yet a week old
            Assert.Equal(1, await janitor.PurgeOrphansAsync(TimeSpan.Zero));                                  // ...removed once it is
        }
        Assert.False(await BlobExists(id));
        Assert.False(factory.WithDb(db => db.Attachments.IgnoreQueryFilters().Any(a => a.Id == id)));
    }

    [Fact]
    public async Task Uploads_need_a_signed_in_member_and_a_file()
    {
        var (c, project, _) = await Setup();
        var anon = await new TestClient(factory).Upload(ForProject(project), "x.pdf", Pdf());
        Assert.Equal(HttpStatusCode.Unauthorized, anon.Status);
        Assert.True((int)(await c.Send(HttpMethod.Post, ForProject(project), new { })).Status is 400 or 415 or 422);   // JSON instead of a file
    }
}
