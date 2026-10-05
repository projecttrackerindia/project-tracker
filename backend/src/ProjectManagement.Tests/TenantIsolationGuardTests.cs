using System.Net;
using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Tripwires for isolation between organizations, and between people inside one.</summary>
[Collection("api")]
public class TenantIsolationGuardTests(ApiFactory factory)
{
    /// <summary>
    /// Entities that carry a TenantId but are NOT filtered to the current organization automatically (they are looked up by token, e-mail or
    /// domain, or list a person's memberships across organizations). Every query on them must say which organization it means. Reviewed one by one:
    /// a new entry here means someone decided that on purpose; a new entity that is not marked ITenantScoped fails this test until they do.
    /// </summary>
    private static readonly string[] ReviewedUnfiltered = ["ScimToken", "SsoConnection", "SsoDomain", "Subscription", "TenantFeatureOverride", "TenantInvitation", "TenantMember"];

    [Fact]
    public void Every_organization_owned_entity_is_filtered_automatically_unless_it_was_reviewed_on_purpose()
    {
        var unfiltered = typeof(TenantEntity).Assembly.GetTypes()
            .Where(t => !t.IsAbstract && typeof(TenantEntity).IsAssignableFrom(t) && !typeof(ITenantScoped).IsAssignableFrom(t))
            .Select(t => t.Name).OrderBy(n => n).ToArray();
        Assert.Equal(ReviewedUnfiltered, unfiltered);
    }

    [Fact]
    public async Task A_person_who_may_not_open_a_project_learns_nothing_about_the_task_that_blocks_one_they_can()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gus Guest");
        var visible = await owner.CreateProjectAsync("Visible Programme");
        var secret = await owner.CreateProjectAsync("Secret Acquisition");
        var add = await owner.Post($"/api/v1/projects/{visible}/members", new { userId = guest.UserId }); Assert.True(add.Ok, add.ToString());   // the guest is only in the first project

        var mine = (await owner.CreateTaskAsync(visible, "Prepare the board pack"))["id"]!.GetValue<string>();
        var hidden = (await owner.CreateTaskAsync(secret, "Confidential due diligence"))["id"]!.GetValue<string>();
        // The API only links tasks of one project, so such a link can only come from imported or older data: it is put in directly, the way an import would.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"/api/v1/tasks/{mine}/dependencies", new { dependsOnTaskId = hidden, type = "FinishToStart" })).Status);
        factory.WithDb(db => { db.TaskDependencies.Add(new TaskDependency { TenantId = owner.WorkspaceId, TaskId = Guid.Parse(mine), DependsOnTaskId = Guid.Parse(hidden), Type = DependencyType.FinishToStart, CreatedAt = DateTime.UtcNow }); db.SaveChanges(); return 0; });

        // The owner sees what blocks the task; the guest sees that something does, and nothing more.
        var asOwner = (await owner.Get($"/api/v1/project-status/projects/{visible}")).Data!.ToJsonString();
        Assert.Contains("Confidential due diligence", asOwner);
        var asGuest = await guest.Get($"/api/v1/project-status/projects/{visible}");
        Assert.True(asGuest.Ok, asGuest.ToString());
        var text = asGuest.Data!.ToJsonString();
        Assert.DoesNotContain("Confidential due diligence", text);
        Assert.DoesNotContain("Secret Acquisition", text);
        Assert.Contains("A task you cannot see", text);
        Assert.Equal(1, asGuest.Data["blockedTasks"]!.GetValue<int>());
        Assert.Equal(HttpStatusCode.NotFound, (await guest.Get($"/api/v1/project-status/projects/{secret}")).Status);   // and the project itself is not theirs to open
    }
}
