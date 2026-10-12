using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;
namespace ProjectManagement.Tests;
[Collection("api")]
public class ResumeEvidenceTests(ApiFactory factory)
{
    [Fact]
    public async Task Organization_outcomes_require_independent_acceptance_and_are_rechecked_when_work_reopens()
    {
        var reporter=await TestClient.RegisterAsync(factory,"Reporter");await reporter.CreateOrgAsync();await reporter.UpgradeAsync("BUSINESS");
        var worker=await reporter.AddMemberAsync(factory,TenantRole.Admin,"Resume Owner");
        var type=(await reporter.Get("/api/v1/work-types")).Data!.AsArray().First()!["id"]!.GetValue<string>();
        var made=await reporter.Post("/api/v1/work-tasks",new{title="Delivered support outcome",workTypeId=type,assigneeId=worker.UserId});Assert.True(made.Ok,made.ToString());
        var work=made.Data!["id"]!.GetValue<string>();
        Assert.DoesNotContain(work,(await worker.Get("/api/v1/me/resumes/evidence")).Data!.ToJsonString());
        Assert.True((await worker.Put($"/api/v1/work-tasks/{work}/status",new{status="Completed"})).Ok);
        Assert.DoesNotContain(work,(await worker.Get("/api/v1/me/resumes/evidence")).Data!.ToJsonString());
        var resolution=await worker.Get($"/api/v1/work-tasks/{work}/resolution");
        var proposed=await worker.Put($"/api/v1/work-tasks/{work}/resolution",new{workVersion=resolution.Data!["workVersion"]!.GetValue<int>(),note="Delivered a documented, verified fix."});Assert.True(proposed.Ok,proposed.ToString());
        Assert.True((await reporter.Post($"/api/v1/work-tasks/{work}/resolution/accept",new{workVersion=proposed.Data!["workVersion"]!.GetValue<int>()})).Ok);
        Assert.Contains(work,(await worker.Get("/api/v1/me/resumes/evidence")).Data!.ToJsonString());
        var content=new{name="Resume Owner",headline="Engineer",contact="",summary="Self-supplied experience",sections=Array.Empty<object>()};
        var resume=await worker.Post("/api/v1/me/resumes",new{title="Evidence-backed resume",content,expectedVersion=0,evidenceIds=new[]{work}});Assert.True(resume.Ok,resume.ToString());
        var id=resume.Data!["id"]!.GetValue<string>();Assert.True((await worker.Post($"/api/v1/me/resumes/{id}/versions/1/approve")).Ok);
        Assert.True((await worker.Put($"/api/v1/work-tasks/{work}/status",new{status="InProgress"})).Ok);
        Assert.Equal("RESUME_EVIDENCE_STALE",(await worker.Get($"/api/v1/me/resumes/{id}")).ErrorCode);
        Assert.Equal("RESUME_EVIDENCE_STALE",(await worker.Get($"/api/v1/me/resumes/{id}/versions/1/export?template=1&format=pdf")).ErrorCode);
    }
}