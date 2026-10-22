using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Mailbox;
namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>The person's own Mailbox: connected accounts, reading, replying and the mail agent. Private to the signed-in person.</summary>
[Route("api/v1/me/mailbox"), RequireWorkspace, ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
public class MailboxController(MailboxService mailbox, MailboxAgent agent) : ApiControllerBase
{
    [HttpGet("accounts")] public async Task<IActionResult> Accounts(CancellationToken ct) => Ok(await mailbox.AccountsAsync(ct));
    [HttpPut("company")] public async Task<IActionResult> Company([FromBody] SaveCompanyMailRequest req, CancellationToken ct) => Ok(await mailbox.SaveCompanyAsync(req, ct));
    [HttpPost("company/test")] public async Task<IActionResult> TestCompany([FromBody] TestCompanyMailRequest req, CancellationToken ct) => Ok(await mailbox.TestCompanyAsync(req, ct));
    [HttpPost("accounts/imap"), ExternalOperation] public async Task<IActionResult> Connect([FromBody] ConnectImapRequest req, CancellationToken ct) => Created(await mailbox.ConnectImapAsync(req, ct));
    [HttpDelete("accounts/imap/{id:guid}")] public async Task<IActionResult> Disconnect(Guid id, CancellationToken ct) { await mailbox.DisconnectImapAsync(id, ct); return NoContent(); }
    [HttpGet("messages")] public async Task<IActionResult> Messages([FromQuery] string account, [FromQuery] string? folder, [FromQuery] string? cursor, [FromQuery] string? q, CancellationToken ct)
        => Ok(await mailbox.ListAsync(account, folder, cursor, q, ct));
    [HttpGet("thread")] public async Task<IActionResult> Thread([FromQuery] string account, [FromQuery] string? folder, [FromQuery] string messageId, CancellationToken ct)
        => Ok(await mailbox.ThreadAsync(account, folder, messageId, ct));
    [HttpPost("send"), ExternalOperation] public async Task<IActionResult> Send([FromBody] MailSendRequest req, CancellationToken ct) => Ok(await mailbox.SendAsync(req, ct));
    [HttpGet("agent/options")] public async Task<IActionResult> AgentOptions(CancellationToken ct) => Ok(await agent.OptionsAsync(ct));
    [HttpPost("agent/assist"), AiRequestLimit] public async Task<IActionResult> Assist([FromBody] MailAssistRequest req, CancellationToken ct) => Ok(await agent.AssistAsync(req, ct));
    [HttpPost("agent/compose"), AiRequestLimit] public async Task<IActionResult> Compose([FromBody] MailComposeAssistRequest req, CancellationToken ct) => Ok(await agent.ComposeAsync(req, ct));
}
