using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Integrations;
namespace ProjectManagement.Api.Controllers.Workspaces;
[Route("api/v1/integrations/microsoft"),RequireWorkspace,ResponseCache(NoStore=true,Location=ResponseCacheLocation.None)]
public class MicrosoftIntegrationController(MicrosoftProductivityAuthService service,IWebHostEnvironment environment):ApiControllerBase
{
    public const string ProofCookie="__Secure-pt-microsoft-connect";
    public const string CallbackPath="/api/v1/integrations/microsoft/callback";
    [HttpGet("status")] public async Task<IActionResult> Status(CancellationToken ct)=>Ok(await service.StatusAsync(ct));
    [HttpGet("connect")] public async Task<IActionResult> Connect(CancellationToken ct,[FromQuery]bool inbox=false,[FromQuery]bool calendars=false,[FromQuery]bool meetings=false,[FromQuery]string? returnUrl=null){
        var result=await service.StartAsync(ct,inbox,calendars,meetings,returnUrl);
        Response.Cookies.Append(ProviderConnectionBrowser.CookieName("microsoft",Request,environment),result.BrowserProof,ProviderConnectionBrowser.CookieOptions(CallbackPath,Request,environment));
        return Ok(new{url=result.Url});
    }
    [HttpGet("callback/browser-check")] public IActionResult BrowserCheck(){
        ProviderConnectionBrowser.Verify("microsoft",Request,environment);return NoContent();
    }
    [HttpPost("disconnect")] public async Task<IActionResult> Disconnect(CancellationToken ct){await service.DisconnectAsync(ct);return NoContent();}
    /// <summary>Stops one feature (mail, inbox, calendar, meetings) and keeps the rest connected.</summary>
    [HttpPost("features/{feature}/off")] public async Task<IActionResult> TurnOff(string feature,CancellationToken ct)=>Ok(await service.TurnOffAsync(feature,ct));
}
[Route(MicrosoftIntegrationController.CallbackPath),AllowAnonymous]
public class MicrosoftIntegrationCallbackController(MicrosoftProductivityAuthService service,IWebHostEnvironment environment):ApiControllerBase
{
    [HttpGet] public async Task<IActionResult> Callback([FromQuery]string? state,[FromQuery]string? code,[FromQuery]string? error,CancellationToken ct){
        var cookieName=ProviderConnectionBrowser.CookieName("microsoft",Request,environment);
        var proof=Request.Cookies[cookieName];
        Response.Headers.CacheControl="no-store";
        Response.Cookies.Delete(cookieName,ProviderConnectionBrowser.CookieOptions(MicrosoftIntegrationController.CallbackPath,Request,environment));
        try { return Redirect(await service.CompleteAsync(state,proof,code,error,ct)); }
        catch (ProjectManagement.Application.Exceptions.UnauthorizedException ex) when (ex.Code == "MICROSOFT_STATE_INVALID")
        { return ProviderConnectionBrowser.Recovery(Response); }
    }
}
