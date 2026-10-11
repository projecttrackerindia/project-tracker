using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Application.Features.Resumes;
namespace ProjectManagement.Api.Controllers.Auth;
[Route("api/v1/me/resume-purchases")]
public class ResumePurchasesController(ResumePurchaseService service):ApiControllerBase
{
    [HttpGet]public async Task<IActionResult> List(CancellationToken ct)=>Ok(await service.ListAsync(ct));
    [HttpPost]public async Task<IActionResult> Start(ResumePurchaseRequest req,CancellationToken ct)=>Ok(await service.StartAsync(req,ct));
    [HttpPost("{id:guid}/verify")]public async Task<IActionResult> Verify(Guid id,ResumePaymentProof req,CancellationToken ct)=>Ok(await service.VerifyAsync(id,req,ct));
    [HttpPost("{id:guid}/recover")]public async Task<IActionResult> Recover(Guid id,CancellationToken ct)=>Ok(await service.RecoverAsync(id,ct));
    [HttpGet("{id:guid}/download")]public async Task<IActionResult> Download(Guid id,CancellationToken ct){var file=await service.DownloadAsync(id,ct);return File(file.Bytes,file.ContentType,file.FileName);}
}
