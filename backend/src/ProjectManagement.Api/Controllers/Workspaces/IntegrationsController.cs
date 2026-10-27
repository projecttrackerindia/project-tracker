using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Application.Features.Compliance;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>Setting up integrations: the work mailbox, repository connections, my calendar subscription, development links on tasks, and the data policy.</summary>
[Route("api/v1"), RequireWorkspace]
public class IntegrationsController(InboundEmailService inbound, GitLinkService git, CalendarFeedService calendar, DataPolicyService data, GoogleCalendarAuthService google, IWebHostEnvironment environment,
    GitHubAppService gitHub) : ApiControllerBase
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
    public async Task<IActionResult> GoogleConnect([FromQuery] string? returnUrl, CancellationToken ct,[FromQuery] bool mail=false,[FromQuery] bool inbox=false,[FromQuery] bool transcripts=false,[FromQuery] bool autoTranscripts=false)
    {
        var proof=Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
        var url=await google.StartConnectAsync(returnUrl,proof,ct,mail,inbox,transcripts,autoTranscripts);
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

    /// <summary>Stops one Google feature (calendar, mail, inbox, transcripts) and keeps the rest connected.</summary>
    [HttpPost("integrations/google/features/{feature}/off")]
    public async Task<IActionResult> GoogleFeatureOff(string feature, CancellationToken ct) => Ok(await google.TurnOffAsync(feature, ct));

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

    // ---- the GitHub App
    [HttpGet("integrations/github-app")]
    public async Task<IActionResult> GitHubApp(CancellationToken ct) => Ok(await gitHub.StatusAsync(ct));

    /// <summary>Where to send the admin to install the app on GitHub (with a sealed state for this workspace and person).</summary>
    [HttpPost("integrations/github-app/install")]
    public IActionResult InstallGitHub() => Ok(gitHub.Start());

    /// <summary>GitHub sent the admin back: the installation, checked against who installed it.</summary>
    [HttpPost("integrations/github-app/complete")]
    public async Task<IActionResult> CompleteGitHub([FromBody] GitHubInstallCompleteRequest req, CancellationToken ct) => Ok(await gitHub.CompleteAsync(req, ct));

    [HttpPut("integrations/github-app")]
    public async Task<IActionResult> SaveGitHub([FromBody] SaveGitHubSettingsRequest req, CancellationToken ct) => Ok(await gitHub.SaveSettingsAsync(req, ct));

    [HttpDelete("integrations/github-app")]
    public async Task<IActionResult> DisconnectGitHub(CancellationToken ct)
    {
        await gitHub.DisconnectAsync(ct);
        return NoContent();
    }

    [HttpPost("tasks/{taskId:guid}/github-branch"), RequireModule(Modules.Tasks)]
    public async Task<IActionResult> CreateBranch(Guid taskId, [FromBody] CreateBranchRequest req, CancellationToken ct) => Ok(await gitHub.CreateBranchAsync(taskId, req, ct));

    /// <summary>Pull requests waiting on my review, and mine waiting on others (Home).</summary>
    [HttpGet("me/review-queue")]
    public async Task<IActionResult> ReviewQueue(CancellationToken ct) => Ok(await gitHub.ReviewQueueAsync(ct));

    [HttpGet("projects/{projectId:guid}/release-notes"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> ReleaseNotes(Guid projectId, [FromQuery] DateOnly? from, [FromQuery] DateOnly? to, CancellationToken ct) =>
        Ok(await gitHub.ReleaseNotesAsync(projectId, from, to, ct));

    [HttpPost("projects/{projectId:guid}/release-notes/page"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> ReleaseNotesPage(Guid projectId, [FromQuery] DateOnly? from, [FromQuery] DateOnly? to, CancellationToken ct) =>
        Ok(new { documentId = await gitHub.ReleaseNotesPageAsync(projectId, from, to, ct) });

    /// <summary>Delivery metrics for a project (its tasks' repositories), or the whole workspace without a project.</summary>
    [HttpGet("integrations/github-app/delivery")]
    public async Task<IActionResult> Delivery([FromQuery] Guid? projectId, [FromQuery] int days = 90, CancellationToken ct = default) => Ok(await gitHub.MetricsAsync(projectId, days, ct));

    [HttpGet("tasks/{taskId:guid}/dev-links"), RequireModule(Modules.Tasks)]
    public async Task<IActionResult> TaskLinks(Guid taskId, CancellationToken ct) => Ok(await git.ForTaskAsync(taskId, ct));

    /// <summary>Pull request and checks status for many tasks and tickets at once (comma-separated ids), for My Work's chips.</summary>
    [HttpGet("dev-links/status")]
    public async Task<IActionResult> DevStatus([FromQuery] string? ids, CancellationToken ct) =>
        Ok(await git.StatusAsync((ids ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(x => Guid.TryParse(x, out var g) ? g : Guid.Empty).Where(g => g != Guid.Empty).ToList(), ct));

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
        {
            var signal = await AgentSignalService.ReceiveMailAsync(services, agentToken, key ?? Request.Headers["X-Inbound-Key"].ToString(), email, ct);
            // The same mail can also be addressed to the work mailbox (work+token@): it still becomes a work task.
            var workToken = System.Text.RegularExpressions.Regex.Match(email.To ?? "", @"work\+([0-9a-f]{24})@", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            if (!workToken.Success) return Ok(new { agentSignal = signal });
            var work = await InboundEmailService.ReceiveAsync(services, workToken.Groups[1].Value, key ?? Request.Headers["X-Inbound-Key"].ToString(), email, ct);
            return Ok(new { agentSignal = signal, workTask = work });
        }
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

    /// <summary>Real-time captions from the project agent's own meeting bot (apps/meetbot); the token in the address picks the bot.</summary>
    [HttpPost("agent/bot/{token}")]
    [RequestSizeLimit(2 * 1024 * 1024)]
    public async Task<IActionResult> BotTranscript(string token, CancellationToken ct)
    {
        using var reader = new StreamReader(Request.Body, Encoding.UTF8);
        await AgentMeetingService.ReceiveBotAsync(services, token, await reader.ReadToEndAsync(ct), ct);
        return Ok(new { received = true });
    }

    /// <summary>One person's words in one of our own calls, as audio (the worker hears each person separately); the token picks the agent's session.</summary>
    [HttpPost("agent/bot/{token}/speech")]
    [RequestSizeLimit(5 * 1024 * 1024), RequestFormLimits(MultipartBodyLengthLimit = 5 * 1024 * 1024)]
    public async Task<IActionResult> BotSpeech(string token, IFormFile file, [FromForm] string? name, CancellationToken ct)
    {
        await using var stream = file.OpenReadStream();
        using var buffer = new MemoryStream();
        await stream.CopyToAsync(buffer, ct);
        var text = await AgentMeetingService.ReceiveSpeechAsync(services, token, name, buffer.ToArray(), file.ContentType ?? "audio/wav", ct);
        return Ok(new { text });
    }

    /// <summary>Events from our own media server (who joined or left a call, a call that closed), signed with the shared secret.</summary>
    [HttpPost("calls/livekit")]
    [RequestSizeLimit(256 * 1024)]
    public async Task<IActionResult> LiveKitWebhook(CancellationToken ct)
    {
        using var reader = new StreamReader(Request.Body, Encoding.UTF8);
        var body = await reader.ReadToEndAsync(ct);
        return await ProjectManagement.Application.Features.Calls.CallService.WebhookAsync(services, Request.Headers.Authorization.ToString(), body, ct) ? Ok(new { received = true }) : Unauthorized();
    }

    /// <summary>
    /// A meeting-bot worker (apps/meetbot) reporting its bots and asking for sessions (Bearer Agent:MeetingBotSecret). Workers call this every
    /// few seconds; any number of them can run.
    /// </summary>
    [HttpPost("agent/bot-workers/poll")]
    [RequestSizeLimit(256 * 1024)]
    public async Task<IActionResult> BotWorkerPoll([FromBody] BotWorkerReport report, CancellationToken ct)
    {
        var bearer = Request.Headers.Authorization.ToString();
        bearer = bearer.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? bearer[7..].Trim() : "";
        return Ok(await services.GetRequiredService<MeetingBotQueue>().PollAsync(bearer, report, ct));
    }

    /// <summary>The hosting platform reporting a failed deployment or a crash (Railway webhook); platform administrators are e-mailed.</summary>
    [HttpPost("inbound/deploy/{token}")]
    [RequestSizeLimit(256 * 1024)]
    public async Task<IActionResult> DeployAlert(string token, CancellationToken ct)
    {
        using var reader = new StreamReader(Request.Body, Encoding.UTF8);
        var alerted = await services.GetRequiredService<ProjectManagement.Application.Features.Admin.DeployAlertService>().ReceiveAsync(token, await reader.ReadToEndAsync(ct), ct);
        return Ok(new { alerted });
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

    /// <summary>The ProjectTracker GitHub App's webhook (every workspace's installations): checked with the app's secret.</summary>
    [HttpPost("integrations/github-app/webhook")]
    [RequestSizeLimit(26 * 1024 * 1024)]
    public async Task<IActionResult> GitHubAppWebhook(CancellationToken ct)
    {
        using var ms = new MemoryStream();
        await Request.Body.CopyToAsync(ms, ct);
        var ok = await services.GetRequiredService<ProjectManagement.Application.Features.Integrations.GitHubAppWebhook>()
            .ReceiveAsync(ms.ToArray(), Request.Headers["X-Hub-Signature-256"].FirstOrDefault(), Request.Headers["X-GitHub-Event"].FirstOrDefault(), ct);
        return ok ? Ok(new { received = true }) : Unauthorized();
    }

    /// <summary>
    /// An incoming webhook: any system posts JSON, a form or text here and it becomes a ticket, a task or a reminder by the address's mapping.
    /// Answers 202 with what became of it (created, merged, resolved, ignored or failed), 401 for a wrong secret, 404 for an unknown address.
    /// </summary>
    [HttpPost("hooks/in/{token}")]
    [RequestSizeLimit(1024 * 1024)]
    public async Task<IActionResult> Incoming(string token, CancellationToken ct)
    {
        using var ms = new MemoryStream();
        if (Request.Body.CanSeek) Request.Body.Position = 0;
        await Request.Body.CopyToAsync(ms, ct);
        var raw = ms.ToArray();
        // A form post can reach here already read (the form is parsed once per request): rebuild it from the parsed fields.
        if (raw.Length == 0 && Request.HasFormContentType)
        {
            var form = await Request.ReadFormAsync(ct);
            raw = Encoding.UTF8.GetBytes(string.Join("&", form.SelectMany(f => f.Value.Select(v => $"{Uri.EscapeDataString(f.Key)}={Uri.EscapeDataString(v ?? "")}"))));
        }
        var headers = Request.Headers.ToDictionary(h => h.Key, h => h.Value.ToString(), StringComparer.OrdinalIgnoreCase);
        var receipt = await ProjectManagement.Application.Features.Integrations.IncomingWebhookService.ReceiveAsync(services, token, raw, Request.ContentType, headers, ct);
        return receipt is null ? NotFound() : StatusCode(StatusCodes.Status202Accepted, receipt);
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
