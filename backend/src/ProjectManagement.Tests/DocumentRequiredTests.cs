using System.Net;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>"Needs attention": document kinds every project should have, projects missing them, and drafts created in one go.</summary>
[Collection("api")]
public class DocumentRequiredTests(ApiFactory factory)
{
    [Fact]
    public async Task A_required_kind_shows_projects_without_it_until_a_draft_is_created()
    {
        var owner = await TestClient.RegisterAsync(factory, "Docs Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var project = await owner.CreateProjectAsync("Loan Origination");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Writer");

        var types = (await owner.Get("/api/v1/document-types")).Data!.AsArray();
        var type = types[0]!;
        var typeId = type["id"]!.GetValue<string>();
        Assert.False(type["requiredForProjects"]!.GetValue<bool>());

        Assert.Equal(HttpStatusCode.Forbidden, (await member.Put($"/api/v1/document-types/{typeId}/required", new { required = true })).Status);
        var set = await owner.Put($"/api/v1/document-types/{typeId}/required", new { required = true });
        Assert.True(set.Ok, set.ToString());
        Assert.True(set.Data!["requiredForProjects"]!.GetValue<bool>());

        var gaps = (await owner.Get("/api/v1/documents/required-gaps")).Data!.AsArray();
        var gap = Assert.Single(gaps, g => g!["projectId"]!.GetValue<string>() == project.ToString());
        Assert.Equal(typeId, gap!["missing"]![0]!["id"]!.GetValue<string>());
        Assert.True((await owner.Get("/api/v1/documents/dashboard")).Data!["projectsMissingRequired"]!.GetValue<int>() >= 1);

        var created = await owner.Post($"/api/v1/projects/{project}/documents/required", new { });
        Assert.Equal(HttpStatusCode.Created, created.Status);
        Assert.Single(created.Data!.AsArray());

        gaps = (await owner.Get("/api/v1/documents/required-gaps")).Data!.AsArray();
        Assert.DoesNotContain(gaps, g => g!["projectId"]!.GetValue<string>() == project.ToString());

        // A new draft is "never published", so it is listed under Needs attention.
        var unpublished = (await owner.Get($"/api/v1/documents?scope=unpublished&projectId={project}")).Data!["items"]!.AsArray();
        Assert.Single(unpublished);
        var stale = (await owner.Get($"/api/v1/documents?scope=stale&projectId={project}")).Data!["items"]!.AsArray();
        Assert.Empty(stale);
    }
}
