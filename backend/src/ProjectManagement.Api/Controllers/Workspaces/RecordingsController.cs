using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Agent;
namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>"Record this meeting" from the person's own device: sound in short pieces in, words out, then minutes and tasks. The sound is never kept.</summary>
[Route("api/v1/me/recordings"), RequireWorkspace, ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
public class RecordingsController(DeviceRecordingService recordings) : ApiControllerBase
{
    [HttpGet("status")] public IActionResult Status() => Ok(new { speech = recordings.SpeechReady });
    [HttpPost] public async Task<IActionResult> Start([FromBody] RecordingStartRequest req, CancellationToken ct) => Created(await recordings.StartAsync(req, ct));
    [HttpGet("{id:guid}")] public async Task<IActionResult> Get(Guid id, CancellationToken ct) => Ok(await recordings.GetAsync(id, ct));
    [HttpGet("{id:guid}/lines")] public async Task<IActionResult> Lines(Guid id, CancellationToken ct) => Ok(await recordings.LinesAsync(id, ct));

    [HttpPost("{id:guid}/segment"), AiRequestLimit]
    [RequestSizeLimit(DeviceRecordingService.MaxPieceBytes + 8192), RequestFormLimits(MultipartBodyLengthLimit = DeviceRecordingService.MaxPieceBytes + 8192)]
    public async Task<IActionResult> Segment(Guid id, IFormFile file, [FromForm] string? who, [FromForm] int offset, CancellationToken ct)
    {
        await using var stream = file.OpenReadStream();
        using var buffer = new MemoryStream();
        await stream.CopyToAsync(buffer, ct);
        return Ok(await recordings.SegmentAsync(id, who == "me" ? "me" : "others", offset, buffer.ToArray(), file.ContentType ?? "audio/webm", ct));
    }

    [HttpPost("{id:guid}/finish"), AiRequestLimit] public async Task<IActionResult> Finish(Guid id, CancellationToken ct) => Ok(await recordings.FinishAsync(id, ct));
    [HttpPost("{id:guid}/tasks")] public async Task<IActionResult> Tasks(Guid id, [FromBody] RecordingTasksRequest req, CancellationToken ct) => Ok(await recordings.CreateTasksAsync(id, req, ct));
}
