using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Recurring;

namespace ProjectManagement.Api.Controllers.Recurring;

/// <summary>The weekly manager e-mail, as it would be sent now (workspace owners and admins).</summary>
[Route("api/v1/digest/manager"), RequireWorkspace]
public class ManagerDigestController(ManagerDigestService digest) : ApiControllerBase
{
    [HttpGet("preview")]
    public async Task<IActionResult> Preview([FromQuery] Guid? userId, CancellationToken ct) => Ok(await digest.PreviewAsync(userId, ct));

    /// <summary>The e-mail itself, to open in a browser tab.</summary>
    [HttpGet("preview.html")]
    public async Task<IActionResult> PreviewHtml([FromQuery] Guid? userId, CancellationToken ct) =>
        Content((await digest.PreviewAsync(userId, ct)).Html, "text/html; charset=utf-8");
}
