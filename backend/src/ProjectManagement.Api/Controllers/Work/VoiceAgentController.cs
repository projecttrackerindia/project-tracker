using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Voice;
namespace ProjectManagement.Api.Controllers.Work;

/// <summary>The support voice agent: settings, the company APIs it may read, test calls and the call log.</summary>
[Route("api/v1/voice"), RequireWorkspace, ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
public class VoiceAgentController(VoiceAgentService voice) : ApiControllerBase
{
    [HttpGet("settings")] public async Task<IActionResult> Settings(CancellationToken ct) => Ok(await voice.SettingsAsync(ct));
    [HttpPut("settings")] public async Task<IActionResult> SaveSettings([FromBody] SaveVoiceSettingsRequest req, CancellationToken ct) => Ok(await voice.SaveSettingsAsync(req, ct));
    [HttpGet("connectors")] public async Task<IActionResult> Connectors(CancellationToken ct) => Ok(await voice.ConnectorsAsync(ct));
    [HttpPost("connectors")] public async Task<IActionResult> AddConnector([FromBody] SaveVoiceConnectorRequest req, CancellationToken ct) => Created(await voice.SaveConnectorAsync(null, req, ct));
    [HttpPut("connectors/{id:guid}")] public async Task<IActionResult> SaveConnector(Guid id, [FromBody] SaveVoiceConnectorRequest req, CancellationToken ct) => Ok(await voice.SaveConnectorAsync(id, req, ct));
    [HttpDelete("connectors/{id:guid}")] public async Task<IActionResult> DeleteConnector(Guid id, CancellationToken ct) { await voice.DeleteConnectorAsync(id, ct); return NoContent(); }
    [HttpGet("calls")] public async Task<IActionResult> Calls(CancellationToken ct) => Ok(await voice.CallsAsync(ct));
    [HttpGet("calls/{id:guid}")] public async Task<IActionResult> Call(Guid id, CancellationToken ct) => Ok(await voice.CallAsync(id, ct));
    [HttpPost("calls/test"), AiRequestLimit] public async Task<IActionResult> StartTest([FromBody] StartVoiceCallRequest req, CancellationToken ct) => Ok(await voice.StartTestAsync(req, ct));
    [HttpPost("calls/{id:guid}/say"), AiRequestLimit] public async Task<IActionResult> Say(Guid id, [FromBody] VoiceSayRequest req, CancellationToken ct) => Ok(await voice.SayAsync(id, req, ct));
    [HttpPost("calls/{id:guid}/end"), AiRequestLimit] public async Task<IActionResult> End(Guid id, CancellationToken ct) => Ok(await voice.HangUpAsync(id, ct));
}
