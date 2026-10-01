using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Compliance;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>Setting up integrations: the work mailbox, repository connections, my calendar subscription, development links on tasks, and the data policy.</summary>
[Route("api/v1"), RequireWorkspace]
public class IntegrationsController(InboundEmailService inbound, GitLinkService git, CalendarFeedService calendar, DataPolicyService data) : ApiControllerBase
{
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
public class InboundController(IServiceProvider services) : ApiControllerBase
{
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
        InboundEmail email;
        if (Request.HasFormContentType)
        {
            var f = await Request.ReadFormAsync(ct);
            string? F(params string[] names) => names.Select(n => f[n].ToString()).FirstOrDefault(v => !string.IsNullOrWhiteSpace(v));
            email = new InboundEmail(F("sender", "from", "From"), F("recipient", "to", "To"), F("subject", "Subject"), F("stripped-text", "body-plain", "text", "TextBody"));
        }
        else
        {
            using var reader = new StreamReader(Request.Body);
            JsonNode? j;
            try { j = JsonNode.Parse(await reader.ReadToEndAsync(ct)); } catch (System.Text.Json.JsonException) { return BadRequest(); }
            string? J(params string[] names) => names.Select(n => j?[n]?.ToString()).FirstOrDefault(v => !string.IsNullOrWhiteSpace(v));
            email = new InboundEmail(J("FromFull") is { } full && JsonNode.Parse(full)?["Email"]?.ToString() is { } e ? e : J("from", "From", "sender"),
                J("to", "To", "OriginalRecipient", "recipient"), J("subject", "Subject"), J("StrippedTextReply", "text", "TextBody", "body"));
        }
        var created = await InboundEmailService.ReceiveAsync(services, token, key ?? Request.Headers["X-Inbound-Key"].ToString(), email, ct);
        return Ok(new { workTask = created });
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
