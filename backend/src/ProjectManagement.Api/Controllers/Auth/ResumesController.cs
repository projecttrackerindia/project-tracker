using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Resumes;
namespace ProjectManagement.Api.Controllers.Auth;
[Route("api/v1/me/resumes")]
public class ResumesController(ResumeService service):ApiControllerBase
{
    [HttpGet] public async Task<IActionResult> List(CancellationToken ct)=>Ok(await service.ListAsync(ct));
    [HttpGet("{id:guid}")] public async Task<IActionResult> Get(Guid id,int? number,CancellationToken ct)=>Ok(await service.GetAsync(id,number,ct));
    [HttpGet("options")]public async Task<IActionResult> Options(CancellationToken ct)=>Ok(await service.OptionsAsync(ct));
    [HttpGet("evidence")]public async Task<IActionResult> Evidence(CancellationToken ct)=>Ok(await service.EvidenceAsync(ct));
    [HttpPost]public async Task<IActionResult> Create(ResumeSaveRequest req,CancellationToken ct)=>Ok(await service.SaveAsync(null,req,ct));
    [HttpPut("{id:guid}")]public async Task<IActionResult> Save(Guid id,ResumeSaveRequest req,CancellationToken ct)=>Ok(await service.SaveAsync(id,req,ct));
    [HttpPost("import"),RequestSizeLimit(2200000)]public async Task<IActionResult> Import(IFormFile file,CancellationToken ct){await using var s=file.OpenReadStream();return Ok(await service.ImportAsync(file.FileName,s,ct));}
    [HttpPost("{id:guid}/versions/{number:int}/approve")]public async Task<IActionResult> Approve(Guid id,int number,CancellationToken ct){await service.ApproveAsync(id,number,ct);return NoContent();}
    [HttpGet("{id:guid}/versions/{number:int}/original")]
    public async Task<IActionResult> Original(Guid id,int number,CancellationToken ct)
    { var file=await service.OpenOriginalAsync(id,number,ct);return File(file.Bytes,file.ContentType,file.FileName); }
    [HttpDelete("{id:guid}/versions/{number:int}/original")]
    public async Task<IActionResult> RemoveOriginal(Guid id,int number,CancellationToken ct)
    { await service.RemoveOriginalAsync(id,number,ct);return NoContent(); }
    [HttpPost("{id:guid}/improve"),RequireWorkspace,AiRequestLimit]public async Task<IActionResult> Improve(Guid id,ResumeAiRequest req,CancellationToken ct)=>Ok(await service.ImproveAsync(id,req,ct));
    [HttpGet("{id:guid}/versions/{number:int}/export")]public async Task<IActionResult> Export(Guid id,int number,int template,string format,bool clean,CancellationToken ct){var f=await service.ExportAsync(id,number,template,format,clean,ct);return File(f.Bytes,f.ContentType,f.FileName);}
    [HttpDelete("{id:guid}")]public async Task<IActionResult> Delete(Guid id,CancellationToken ct){await service.DeleteAsync(id,ct);return NoContent();}
}
[Route("api/v1/me/certifications")]
public class CertificationsController(CertificationService service):ApiControllerBase
{
    [HttpGet]public async Task<IActionResult> List(CancellationToken ct)=>Ok(await service.ListAsync(ct));
    [HttpPost]public async Task<IActionResult> Create(CertificationRequest req,CancellationToken ct)=>Ok(await service.SaveAsync(null,req,ct));
    [HttpPut("{id:guid}")]public async Task<IActionResult> Save(Guid id,CertificationRequest req,CancellationToken ct)=>Ok(await service.SaveAsync(id,req,ct));
    [HttpPost("{id:guid}/attachment"), RequestSizeLimit(2200000)]
    public async Task<IActionResult> Attach(Guid id, IFormFile file, int version, CancellationToken ct)
    { await using var stream=file.OpenReadStream(); await service.SetAttachmentAsync(id,file.FileName,stream,version,ct); return NoContent(); }
    [HttpGet("{id:guid}/attachment")]
    public async Task<IActionResult> Attachment(Guid id,CancellationToken ct)
    { var file=await service.OpenAttachmentAsync(id,ct); return File(file.Bytes,file.ContentType,file.FileName); }
    [HttpDelete("{id:guid}/attachment")]
    public async Task<IActionResult> RemoveAttachment(Guid id,int version,CancellationToken ct)
    { await service.RemoveAttachmentAsync(id,version,ct); return NoContent(); }
    [HttpDelete("{id:guid}")]public async Task<IActionResult> Delete(Guid id,CancellationToken ct){await service.DeleteAsync(id,ct);return NoContent();}
}
