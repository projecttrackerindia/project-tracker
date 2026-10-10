using System.Net;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public class AiKnowledgeTests(ApiFactory factory)
{
    [Fact]
    public async Task Search_and_read_use_current_tenant_and_reject_stale_project_versions()
    {
        var owner = await TestClient.RegisterAsync(factory, "Knowledge owner"); await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
        var project = await owner.CreateProjectAsync("Unique knowledge evidence");
        var stranger = await TestClient.RegisterAsync(factory, "Knowledge stranger"); await stranger.CreateOrgAsync();
        var search = await owner.Get("/api/v1/ai/knowledge?query=Unique%20knowledge"); Assert.True(search.Ok, search.ToString());
        var source = search.Data!["items"]!.AsArray().Single(x => x!["source"]!["kind"]!.GetValue<string>() == "project")!["source"]!;
        var version = source["version"]!.GetValue<string>();
        var read = await owner.Get($"/api/v1/ai/knowledge/project/{project}?expectedVersion={version}"); Assert.True(read.Ok, read.ToString());
        Assert.Contains("Unique knowledge evidence", read.Data!["text"]!.GetValue<string>());
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.Get($"/api/v1/ai/knowledge/project/{project}")).Status);
        Assert.Empty((await stranger.Get("/api/v1/ai/knowledge?query=Unique%20knowledge")).Data!["items"]!.AsArray());
        factory.WithDb(db => db.Projects.IgnoreQueryFilters().Where(p => p.Id == project).ExecuteUpdate(s => s.SetProperty(p => p.Version, p => p.Version + 1)));
        var stale = await owner.Get($"/api/v1/ai/knowledge/project/{project}?expectedVersion={version}");
        Assert.Equal(HttpStatusCode.Conflict, stale.Status); Assert.Equal("AI_SOURCE_CHANGED", stale.ErrorCode);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Get($"/api/v1/ai/knowledge/project/{project}?offset=200001")).Status);
    }

    [Fact]
    public async Task Document_evidence_reuses_explicit_deny_and_version_checks()
    {
        var owner = await TestClient.RegisterAsync(factory, "Document evidence owner"); await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
        var member = await owner.AddMemberAsync(factory, ProjectManagement.Domain.Enums.TenantRole.Member, "Denied reader");
        var types = await owner.Get("/api/v1/document-types");
        var type = types.Data!.AsArray().First(t => t!["code"]!.GetValue<string>() == "BRD")!["id"]!.GetValue<string>();
        var created = await owner.Post("/api/v1/documents", new { title = "Restricted evidence source", typeId = type, visibility = "Organization" }); Assert.True(created.Ok, created.ToString());
        var id = created.Data!["item"]!["id"]!.GetValue<string>();
        var evidence = await owner.Get($"/api/v1/ai/knowledge/document/{id}"); Assert.True(evidence.Ok, evidence.ToString());
        Assert.Contains("draft", evidence.Data!["source"]!["version"]!.GetValue<string>());
        var deny = await owner.Post($"/api/v1/documents/{id}/grants", new { principalType = "User", principalId = member.UserId, level = "Viewer", deny = true }); Assert.True(deny.Ok, deny.ToString());
        Assert.False((await member.Get($"/api/v1/ai/knowledge/document/{id}")).Ok);
        Assert.DoesNotContain(id, (await member.Get("/api/v1/ai/knowledge?query=Restricted%20evidence")).Data!.ToJsonString());
        var stale = await owner.Get($"/api/v1/ai/knowledge/document/{id}?expectedVersion=old-version");
        Assert.Equal("AI_SOURCE_CHANGED", stale.ErrorCode);
    }
}
