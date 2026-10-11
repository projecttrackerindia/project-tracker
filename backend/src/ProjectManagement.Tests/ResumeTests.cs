using System.Net;
using Microsoft.EntityFrameworkCore;
using System.IO.Compression;
using System.Text.Json.Nodes;
using ProjectManagement.Application.Features.Resumes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;
namespace ProjectManagement.Tests;
[Collection("api")]
public class ResumeTests(ApiFactory factory)
{
    private static object Content(string name="Resume Owner",string summary="Delivered verified work.") => new{name,headline="Project manager",contact="resume@example.com",summary,sections=new[]{new{heading="Experience",text="Led a project team."}}};
    [Fact]
    public async Task Private_versions_require_approval_and_cannot_be_exported_by_another_member()
    {
        var owner=await TestClient.RegisterAsync(factory,"Resume Owner");await owner.CreateOrgAsync();await owner.UpgradeAsync("BUSINESS");
        var created=await owner.Post("/api/v1/me/resumes",new{title="My private resume",content=Content(),expectedVersion=0});Assert.True(created.Ok,created.ToString());
        var id=created.Data!["id"]!.GetValue<string>();
        var other=await owner.AddMemberAsync(factory,TenantRole.Admin,"Other administrator");
        Assert.Empty((await other.Get("/api/v1/me/resumes")).Data!.AsArray());
        Assert.Equal(HttpStatusCode.NotFound,(await other.Post($"/api/v1/me/resumes/{id}/versions/1/approve")).Status);
        Assert.Equal(HttpStatusCode.Conflict,(await owner.Get($"/api/v1/me/resumes/{id}/versions/1/export?template=1&format=pdf")).Status);
        Assert.True((await owner.Post($"/api/v1/me/resumes/{id}/versions/1/approve")).Ok);
        using(var pdf=await owner.Raw($"/api/v1/me/resumes/{id}/versions/1/export?template=1&format=pdf")){
            Assert.Equal(HttpStatusCode.OK,pdf.StatusCode);var bytes=await pdf.Content.ReadAsByteArrayAsync();using var parsed=UglyToad.PdfPig.PdfDocument.Open(bytes);var text=string.Join(" ",parsed.GetPages().Select(p=>p.Text));Assert.Contains("Resume Owner",text);Assert.Contains("Project Tracker",text);
        }
        using(var doc=await owner.Raw($"/api/v1/me/resumes/{id}/versions/1/export?template=1&format=docx")){
            Assert.Equal(HttpStatusCode.OK,doc.StatusCode);using var zip=new ZipArchive(new MemoryStream(await doc.Content.ReadAsByteArrayAsync()));using var reader=new StreamReader(zip.GetEntry("word/header1.xml")!.Open());Assert.Contains("Project Tracker",await reader.ReadToEndAsync());
        }
        Assert.Equal(HttpStatusCode.NotFound,(await other.Get($"/api/v1/me/resumes/{id}/versions/1/export?template=1&format=pdf")).Status);
        Assert.Equal("RESUME_CHECKOUT_DISABLED",(await owner.Get($"/api/v1/me/resumes/{id}/versions/1/export?template=1&format=pdf&clean=true")).ErrorCode);
        var saved=await owner.Put($"/api/v1/me/resumes/{id}",new{title="My private resume",content=Content(summary:"Revised manually."),expectedVersion=1});Assert.True(saved.Ok,saved.ToString());
        Assert.Equal(2,saved.Data!["version"]!.GetValue<int>());Assert.Null(saved.Data!["versions"]![0]!["approvedAt"]);
        Assert.Equal(HttpStatusCode.Conflict,(await owner.Put($"/api/v1/me/resumes/{id}",new{title="Old edit",content=Content(),expectedVersion=1})).Status);
        Assert.Equal(HttpStatusCode.Conflict,(await owner.Get($"/api/v1/me/resumes/{id}/versions/2/export?template=1&format=docx")).Status);
        Assert.True((await owner.Delete($"/api/v1/me/resumes/{id}")).Ok);Assert.Empty((await owner.Get("/api/v1/me/resumes")).Data!.AsArray());
    }
    [Fact]
    public async Task Template_caps_follow_current_plan_and_manual_edits_do_not_require_ai()
    {
        var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();
        foreach(var (plan,count) in new[]{("FREE",2),("PRO",5),("BUSINESS",8)}){
            if(plan!="FREE")await owner.UpgradeAsync(plan);
            var opts=await owner.Get("/api/v1/me/resumes/options");Assert.True(opts.Ok,opts.ToString());Assert.Equal(count,opts.Data!["templates"]!.AsArray().Count);Assert.False(opts.Data["cleanCheckoutEnabled"]!.GetValue<bool>());
        }
    }
    [Fact]
    public async Task Fake_or_compressed_uploads_are_rejected_and_docx_import_has_separate_sources()
    {
        var user=await TestClient.RegisterAsync(factory,"Import User");
        Assert.Equal(HttpStatusCode.UnprocessableEntity,(await user.Upload("/api/v1/me/resumes/import","fake.pdf","not a valid PDF file"u8.ToArray())).Status);
        var doc=ResumeFiles.Docx(new("Import User","Engineer","person@example.com","Supplied experience",[new("Skills","C# and project planning")]),ResumeService.Templates[0],false);
        var imported=await user.Upload("/api/v1/me/resumes/import","old.docx",doc);Assert.True(imported.Ok,imported.ToString());
        Assert.True(imported.Data!["versions"]![0]!["hasOriginal"]!.GetValue<bool>());Assert.Empty(imported.Data["versions"]![0]!["evidence"]!.AsArray());
        Assert.Contains("Supplied experience",imported.Data["versions"]![0]!["content"]!["sections"]![0]!["text"]!.GetValue<string>());
        using var bomb=new MemoryStream();using(var zip=new ZipArchive(bomb,ZipArchiveMode.Create,true)){using var w=new StreamWriter(zip.CreateEntry("word/document.xml").Open());w.Write(new string('x',3*1024*1024));}
        Assert.Equal(HttpStatusCode.UnprocessableEntity,(await user.Upload("/api/v1/me/resumes/import","compressed.docx",bomb.ToArray())).Status);
    }
    [Fact]
    public async Task Invalid_ai_drafts_release_credits_and_retries_cannot_double_charge()
    {
        var owner=await TestClient.RegisterAsync(factory,"Resume Owner");await owner.CreateOrgAsync();await owner.UpgradeAsync("BUSINESS");
        var created=await owner.Post("/api/v1/me/resumes",new{title="AI draft",content=Content(summary:"Worked on delivery."),expectedVersion=0});Assert.True(created.Ok,created.ToString());var id=created.Data!["id"]!.GetValue<string>();
        factory.Ai.Configured=true;
        try{
            var before=(await owner.Get("/api/v1/ai/credits")).Data;
            factory.Ai.Answer=(_,_)=>"{\"name\":\"Resume Owner\",\"headline\":\"Project manager\",\"contact\":\"resume@example.com\",\"summary\":\"Saved 999999 rupees.\",\"sections\":[]}";
            var invalid=await owner.Post($"/api/v1/me/resumes/{id}/improve",new{operationId=Guid.NewGuid(),targetRole="Manager",expectedVersion=1});Assert.Equal("AI_RESUME_INVALID",invalid.ErrorCode);
            Assert.Equal(before?["spent"]?.ToJsonString(),(await owner.Get("/api/v1/ai/credits")).Data?["spent"]?.ToJsonString());
            factory.Ai.Answer=(_,_)=>"{\"name\":\"Resume Owner\",\"headline\":\"Project manager\",\"contact\":\"resume@example.com\",\"summary\":\"Contributed to delivery.\",\"sections\":[]}";
            var operation=Guid.NewGuid();var good=await owner.Post($"/api/v1/me/resumes/{id}/improve",new{operationId=operation,targetRole="Manager",expectedVersion=1});Assert.True(good.Ok,good.ToString());Assert.Null(good.Data!["versions"]![0]!["approvedAt"]);
            var spent=(await owner.Get("/api/v1/ai/credits")).Data?["spent"]?.ToJsonString();var replay=await owner.Post($"/api/v1/me/resumes/{id}/improve",new{operationId=operation,targetRole="Manager",expectedVersion=2});Assert.Equal("AI_OPERATION_ALREADY_ADMITTED",replay.ErrorCode);Assert.Equal(spent,(await owner.Get("/api/v1/ai/credits")).Data?["spent"]?.ToJsonString());
        }finally{factory.Ai.Reset();}
    }
    [Fact]
    public async Task Certification_urls_dates_and_owner_isolation_are_enforced()
    {
        var user=await TestClient.RegisterAsync(factory);var other=await TestClient.RegisterAsync(factory);
        var invalid=await user.Post("/api/v1/me/certifications",new{name="PMP",issuer="Issuer",issuedOn="2025-01-01",verificationUrl="javascript:alert(1)",version=0});Assert.Equal(HttpStatusCode.UnprocessableEntity,invalid.Status);
        var c=await user.Post("/api/v1/me/certifications",new{name="PMP",issuer="Issuer",issuedOn="2025-01-01",expiresOn="2028-01-01",verificationUrl="https://example.com/verify",version=0});Assert.True(c.Ok,c.ToString());Assert.Equal("self-reported",c.Data!["verificationStatus"]!.GetValue<string>());
        Assert.Empty((await other.Get("/api/v1/me/certifications")).Data!.AsArray());Assert.Equal(HttpStatusCode.NotFound,(await other.Delete($"/api/v1/me/certifications/{c.Data["id"]!.GetValue<string>()}")).Status);
    }
}
