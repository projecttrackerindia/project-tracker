using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Application.Features.Compliance;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>Setting up integrations: the work mailbox, repository connections, my calendar subscription, development links on tasks, and the data policy.</summary>
[Route("api/v1"), RequireWorkspace]
public class IntegrationsController(InboundEmailService inbound, GitLinkService git, CalendarFeedService calendar, DataPolicyService data, GoogleCalendarAuthService google, IWebHostEnvironment environment) : ApiControllerBase
{
    public const string GoogleProofCookie="__Secure-pt-google-connect";
    // ---- Google Workspace (Calendar + Meet): one connection per person, not a shared workspace credential - see GoogleCalendarAuthService.
    [HttpGet("integrations/google/status")]
    public async Task<IActionResult> GoogleStatus(CancellationToken ct) => Ok(await google.StatusAsync(ct));

    /// <summary>
    /// The address of Google's consent screen, for the frontend to navigate the whole page to itself (window.location.assign). This cannot
    /// be the redirect endpoint itself: unlike "Sign in with Google" (anonymous - there is no one signed in yet), this action needs to know
    /// who is connecting, which only an authenticated call carries, and a plain full-page navigation cannot attach an Authorization header.
    /// So the browser makes one ordinary authenticated fetch here to learn the URL, then navigates itself - Google's own consent screen needs
    /// no header from us at all.
    /// </summary>
    [HttpGet("integrations/google/connect")]
    public async Task<IActionResult> GoogleConnect([FromQuery] string? returnUrl, CancellationToken ct,[FromQuery] bool mail=false,[FromQuery] bool inbox=false,[FromQuery] bool transcripts=false)
    {
        var proof=Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
        var url=await google.StartConnectAsync(returnUrl,proof,ct,mail,inbox,transcripts);
        Response.Headers.CacheControl="no-store";
        Response.Cookies.Append(ProviderConnectionBrowser.CookieName("google",Request,environment),proof,ProviderConnectionBrowser.CookieOptions("/api/v1/integrations/google/callback",Request,environment));
        return Ok(new{url});
    }

    [HttpGet("integrations/google/callback/browser-check")]
    public IActionResult GoogleBrowserCheck()
    {
        Response.Headers.CacheControl="no-store";
        ProviderConnectionBrowser.Verify("google",Request,environment);
        return NoContent();
    }

    [HttpPost("integrations/google/disconnect")]
    public async Task<IActionResult> GoogleDisconnect(CancellationToken ct)
    {
        await google.DisconnectAsync(ct);
        return NoContent();
    }

    // ---- email to work task
    [HttpGet("integrations/inbound-email"), RequireModule(Modules.Work)]
    public async Task<IActionResult> Mailbox(CancellationToken ct) => Ok(await inbound.GetAsync(ct));

    [HttpPut("integrations/inbound-email"), RequireModule(Modules.Work)]
    public async Task<IActionResult> SaveMailbox([FromBody] SaveInboundMailboxRequest req, CancellationToken ct) => Ok(await inbound.SaveAsync(req, ct));

    [HttpPost("integrations/inbound-email/reset"), RequireModule(Modules.Work)]
    public async Task<IActionResult> ResetMailbox(CancellationToken ct) => Ok(await inbound.ResetAsync(ct));

    // ---- repositories
    [HttpGet("integrations/git")]
    public async Task<IActionResult> GitConnections(CancellationToken ct) => Ok(await git.ListAsync(ct));

    [HttpPost("integrations/git")]
    public async Task<IActionResult> CreateGit([FromBody] SaveGitConnectionRequest req, CancellationToken ct) => Created(await git.CreateAsync(req, ct));

    [HttpPut("integrations/git/{id:guid}")]
    public async Task<IActionResult> UpdateGit(Guid id, [FromBody] SaveGitConnectionRequest req, CancellationToken ct) => Ok(await git.UpdateAsync(id, req, ct));

    [HttpDelete("integrations/git/{id:guid}")]
    public async Task<IActionResult> DeleteGit(Guid id, CancellationToken ct)
    {
        await git.DeleteAsync(id, ct);
        return NoContent();
    }

    [HttpGet("tasks/{taskId:guid}/dev-links"), RequireModule(Modules.Tasks)]
    public async Task<IActionResult> TaskLinks(Guid taskId, CancellationToken ct) => Ok(await git.ForTaskAsync(taskId, ct));

    [HttpGet("work-tasks/{workTaskId:guid}/dev-links")]
    public async Task<IActionResult> WorkTaskLinks(Guid workTaskId, CancellationToken ct) => Ok(await git.ForWorkTaskAsync(workTaskId, ct));

    // ---- my calendar subscription
    [HttpGet("calendar/feed")]
    public async Task<IActionResult> Feed(CancellationToken ct) => Ok(await calendar.GetAsync(ct));

    [HttpPost("calendar/feed")]
    public async Task<IActionResult> ResetFeed(CancellationToken ct) => Ok(await calendar.ResetAsync(ct));

    [HttpDelete("calendar/feed")]
    public async Task<IActionResult> DeleteFeed(CancellationToken ct)
    {
        await calendar.DeleteAsync(ct);
        return NoContent();
    }

    // ---- data policy
    [HttpGet("workspace/data-policy")]
    public async Task<IActionResult> DataPolicy(CancellationToken ct) => Ok(await data.GetAsync(ct));

    [HttpPut("workspace/data-policy")]
    public async Task<IActionResult> SaveDataPolicy([FromBody] SaveDataPolicyRequest req, CancellationToken ct) => Ok(await data.SaveAsync(req, ct));
}

/// <summary>
/// What outside systems call, without a signed-in user: calendar apps fetching a feed, an email provider forwarding mail, and GitHub or
/// Azure DevOps reporting pushes and pull requests. Each is authorised by the secret token in its URL (plus a signature for Git).
/// </summary>
[Route("api/v1"), AllowAnonymous]
public class InboundController(IServiceProvider services, GoogleCalendarAuthService google, IWebHostEnvironment environment) : ApiControllerBase
{
    /// <summary>
    /// Google's redirect back after the person grants (or refuses) Calendar/Meet access. No Project Tracker session reaches this request -
    /// the refresh cookie is scoped to /api/v1/auth, and a full-page redirect through Google loses the in-memory access token - so who
    /// started this is recovered entirely from the one-time state GoogleCalendarAuthService.StartConnectAsync saved, not from being signed in now.
    /// </summary>
    [HttpGet("integrations/google/callback")]
    public async Task<IActionResult> GoogleCallback([FromQuery] string? code, [FromQuery] string? state, [FromQuery] string? error, CancellationToken ct)
    {
        var cookieName=ProviderConnectionBrowser.CookieName("google",Request,environment);
        var proof=Request.Cookies[cookieName];
        Response.Headers.CacheControl="no-store";
        Response.Cookies.Delete(cookieName,ProviderConnectionBrowser.CookieOptions("/api/v1/integrations/google/callback",Request,environment));
        try { return Redirect(await google.CompleteConnectAsync(code,state,error,proof,ct)); }
        catch (ProjectManagement.Application.Exceptions.UnauthorizedException ex) when (ex.Code is "GOOGLE_BROWSER_INVALID" or "GOOGLE_STATE_INVALID")
        { return ProviderConnectionBrowser.Recovery(Response); }
    }

    [HttpGet("calendar/feed/{token}.ics")]
    public async Task<IActionResult> CalendarFeed(string token, CancellationToken ct)
    {
        var ics = await CalendarFeedService.RenderAsync(services, token, ct);
        if (ics is null) return NotFound();
        Response.Headers.CacheControl = "private, max-age=900";
        return File(Encoding.UTF8.GetBytes(ics), "text/calendar; charset=utf-8", "work.ics");
    }

    /// <summary>
    /// An email, from Mailgun (form fields sender / recipient / subject / body-plain), SendGrid Inbound Parse (from / to / subject / text),
    /// Postmark (JSON From / To / Subject / TextBody) or any JSON { from, to, subject, text }. The mailbox is the token in the URL, or the
    /// "+token" in the recipient address when one route forwards every workspace's mail here.
    /// </summary>
    [HttpPost("inbound/email/{token?}")]
    [RequestSizeLimit(10 * 1024 * 1024)]
    public async Task<IActionResult> Email(string? token, [FromQuery] string? key, CancellationToken ct)
    {
        var email = await ReadEmailAsync(ct);
        if (email is null) return BadRequest();
        // One forwarding route can carry every mailbox: mail to a project agent's address (agent+token@) goes to that project's agent.
        if (token is null && AgentSignalService.TokenFromRecipients(email.To) is { } agentToken)
            return Ok(new { agentSignal = await AgentSignalService.ReceiveMailAsync(services, agentToken, key ?? Request.Headers["X-Inbound-Key"].ToString(), email, ct) });
        var created = await InboundEmailService.ReceiveAsync(services, token, key ?? Request.Headers["X-Inbound-Key"].ToString(), email, ct);
        return Ok(new { workTask = created });
    }

    /// <summary>Mail for one project's agent, when the provider posts each address to its own URL.</summary>
    [HttpPost("inbound/agent/{token}")]
    [RequestSizeLimit(10 * 1024 * 1024)]
    public async Task<IActionResult> AgentEmail(string token, [FromQuery] string? key, CancellationToken ct)
    {
        if (token.Length != 24 || !token.All(Uri.IsHexDigit)) return NotFound();
        var email = await ReadEmailAsync(ct);
        if (email is null) return BadRequest();
        return Ok(new { agentSignal = await AgentSignalService.ReceiveMailAsync(services, token, key ?? Request.Headers["X-Inbound-Key"].ToString(), email, ct) });
    }

    /// <summary>Real-time transcript from the project agent's meeting bot (Recall.ai); the token in the address picks the bot.</summary>
    [HttpPost("agent/recall/{token}")]
    [RequestSizeLimit(2 * 1024 * 1024)]
    public async Task<IActionResult> RecallTranscript(string token, CancellationToken ct)
    {
        using var reader = new StreamReader(Request.Body, Encoding.UTF8);
        await AgentMeetingService.ReceiveRecallAsync(services, token, await reader.ReadToEndAsync(ct), ct);
        return Ok(new { received = true });
    }

    private async Task<InboundEmail?> ReadEmailAsync(CancellationToken ct)
    {
        if (Request.HasFormContentType)
        {
            var f = await Request.ReadFormAsync(ct);
            string? F(params string[] names) => names.Select(n => f[n].ToString()).FirstOrDefault(v => !string.IsNullOrWhiteSpace(v));
            return new InboundEmail(F("sender", "from", "From"), F("recipient", "to", "To"), F("subject", "Subject"), F("stripped-text", "body-plain", "text", "TextBody"));
        }
        else
        {
            using var reader = new StreamReader(Request.Body);
            JsonNode? j;
            try { j = JsonNode.Parse(await reader.ReadToEndAsync(ct)); } catch (System.Text.Json.JsonException) { return null; }
            string? J(params string[] names) => names.Select(n => j?[n]?.ToString()).FirstOrDefault(v => !string.IsNullOrWhiteSpace(v));
            return new InboundEmail(J("FromFull") is { } full && JsonNode.Parse(full)?["Email"]?.ToString() is { } e ? e : J("from", "From", "sender"),
                J("to", "To", "OriginalRecipient", "recipient"), J("subject", "Subject"), J("StrippedTextReply", "text", "TextBody", "body"));
        }
    }

    [HttpPost("inbound/git/{provider}/{token}")]
    [RequestSizeLimit(26 * 1024 * 1024)]
    public async Task<IActionResult> Git(string provider, string token, CancellationToken ct)
    {
        var kind = provider switch { "github" => GitProvider.GitHub, "azure-devops" => GitProvider.AzureDevOps, _ => (GitProvider?)null };
        if (kind is null) return NotFound();
        using var reader = new StreamReader(Request.Body, Encoding.UTF8);
        var body = await reader.ReadToEndAsync(ct);
        var linked = await GitLinkService.ReceiveAsync(services, kind.Value, token, body, Request.Headers["X-GitHub-Event"].FirstOrDefault(),
            Request.Headers["X-Hub-Signature-256"].FirstOrDefault(), Request.Headers.Authorization.FirstOrDefault(), ct);
        return Ok(new { linked });
    }
}
