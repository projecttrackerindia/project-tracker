using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Integrations;
namespace ProjectManagement.Api.Controllers.Workspaces;
[Route("api/v1/integrations/microsoft"),RequireWorkspace,ResponseCache(NoStore=true,Location=ResponseCacheLocation.None)]
public class MicrosoftIntegrationController(MicrosoftProductivityAuthService service):ApiControllerBase
{
    public const string ProofCookie="__Secure-pt-microsoft-connect";
    public const string CallbackPath="/api/v1/integrations/microsoft/callback";
    [HttpGet("status")] public async Task<IActionResult> Status(CancellationToken ct)=>Ok(await service.StatusAsync(ct));
    [HttpGet("connect")] public async Task<IActionResult> Connect(CancellationToken ct){
        var result=await service.StartAsync(ct);
        Response.Cookies.Append(ProofCookie,result.BrowserProof,new CookieOptions{HttpOnly=true,Secure=true,SameSite=SameSiteMode.Lax,Path=CallbackPath,MaxAge=TimeSpan.FromMinutes(10)});
        return Ok(new{url=result.Url});
    }
    [HttpPost("disconnect")] public async Task<IActionResult> Disconnect(CancellationToken ct){await service.DisconnectAsync(ct);return NoContent();}
}
[Route(MicrosoftIntegrationController.CallbackPath),AllowAnonymous]
public class MicrosoftIntegrationCallbackController(MicrosoftProductivityAuthService service):ApiControllerBase
{
    [HttpGet] public async Task<IActionResult> Callback([FromQuery]string? state,[FromQuery]string? code,[FromQuery]string? error,CancellationToken ct){
        var proof=Request.Cookies[MicrosoftIntegrationController.ProofCookie];
        Response.Headers.CacheControl="no-store";
        Response.Cookies.Delete(MicrosoftIntegrationController.ProofCookie,new CookieOptions{HttpOnly=true,Secure=true,SameSite=SameSiteMode.Lax,Path=MicrosoftIntegrationController.CallbackPath});
        return Redirect(await service.CompleteAsync(state,proof,code,error,ct));
    }
}
