using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Integrations;

namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>My account > Connected accounts: everything a person connected, their meeting and Slack choices, and their own Slack link.</summary>
[Route("api/v1"), RequireWorkspace, ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
public class ConnectedAccountsController(ConnectedAccountsService accounts, SlackUserLinkService slack, IWebHostEnvironment environment) : ApiControllerBase
{
    [HttpGet("me/connected-accounts")]
    public async Task<IActionResult> Get(CancellationToken ct) => Ok(await accounts.GetAsync(ct));

    [HttpPut("me/connected-accounts")]
    public async Task<IActionResult> Save([FromBody] SaveConnectionChoicesRequest req, CancellationToken ct) => Ok(await accounts.SaveAsync(req, ct));

    /// <summary>Slack's sign-in address for this person (the browser goes there itself; see the Google connect endpoint for why).</summary>
    [HttpGet("integrations/slack/me/connect")]
    public async Task<IActionResult> SlackConnect(CancellationToken ct)
    {
        var start = await slack.StartAsync(ct);
        Response.Cookies.Append(ProviderConnectionBrowser.CookieName("slack-user", Request, environment), start.BrowserProof,
            ProviderConnectionBrowser.CookieOptions(SlackUserLinkService.CallbackPath, Request, environment));
        return Ok(new { url = start.Url });
    }

    [HttpGet("integrations/slack/me/callback/browser-check")]
    public IActionResult SlackBrowserCheck()
    {
        ProviderConnectionBrowser.Verify("slack-user", Request, environment);
        return NoContent();
    }

    [HttpDelete("integrations/slack/me")]
    public async Task<IActionResult> SlackUnlink(CancellationToken ct)
    {
        await slack.UnlinkAsync(ct);
        return NoContent();
    }
}

/// <summary>Slack's redirect back after a person signs in with Slack; no Project Tracker session reaches this request.</summary>
[Route(SlackUserLinkService.CallbackPath), AllowAnonymous]
public class SlackUserCallbackController(SlackUserLinkService slack, IWebHostEnvironment environment) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Callback([FromQuery] string? code, [FromQuery] string? state, [FromQuery] string? error, CancellationToken ct)
    {
        var cookie = ProviderConnectionBrowser.CookieName("slack-user", Request, environment);
        var proof = Request.Cookies[cookie];
        Response.Headers.CacheControl = "no-store";
        Response.Cookies.Delete(cookie, ProviderConnectionBrowser.CookieOptions(SlackUserLinkService.CallbackPath, Request, environment));
        try { return Redirect(await slack.CompleteAsync(code, state, error, proof, ct)); }
        catch (ProjectManagement.Application.Exceptions.UnauthorizedException ex) when (ex.Code == "SLACK_STATE_INVALID")
        { return ProviderConnectionBrowser.Recovery(Response); }
    }
}
