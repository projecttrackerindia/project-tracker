using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>Settings › AI (the AI control centre): what each agent may do here, and a first draft of the organisation context.</summary>
[Route("api/v1/ai/control"), RequireWorkspace]
public sealed class AiControlController(AiControlCentre control) : ApiControllerBase
{
    /// <summary>Each agent's level, and the figures beside them (context length, automations, people).</summary>
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct) => Ok(await control.GetAsync(ct));

    /// <summary>Owners and admins: Off, Suggest, Ask first or Auto for one agent.</summary>
    [HttpPut("agents/{agent}")]
    public async Task<IActionResult> SetLevel(string agent, [FromBody] SetAiAgentLevelRequest req, CancellationToken ct) => Ok(await control.SetLevelAsync(agent, req.Level, ct));

    /// <summary>Owners and admins: "Draft it from my projects" (written from the workspace's records, never saved here, no AI credits).</summary>
    [HttpPost("context/draft")]
    public async Task<IActionResult> DraftContext(CancellationToken ct) => Ok(await control.DraftContextAsync(ct));
}
