using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Notes;

namespace ProjectManagement.Api.Controllers.Notes;

/// <summary>Notes in the current workspace (see <see cref="NoteService"/>): list and search, read, write, share, delete.</summary>
[Route("api/v1/notes"), RequireWorkspace]
public class NotesController(NoteService notes) : ApiControllerBase
{
    /// <param name="view">all (default), pinned, shared or meetings.</param>
    /// <param name="q">Search words: every word must be in the title, the text or a tag.</param>
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] string? view, [FromQuery] string? folder, [FromQuery] string? tag, [FromQuery] string? q, CancellationToken ct)
        => Ok(await notes.ListAsync(view, folder, tag, q, ct));

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => Ok(await notes.GetAsync(id, ct));

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] SaveNoteRequest req, CancellationToken ct) => Created(await notes.CreateAsync(req, ct));

    [HttpPatch("{id:guid}")]
    public async Task<IActionResult> Update(Guid id, [FromBody] SaveNoteRequest req, CancellationToken ct) => Ok(await notes.UpdateAsync(id, req, ct));

    [HttpPut("{id:guid}/sharing")]
    public async Task<IActionResult> Share(Guid id, [FromBody] ShareNoteRequest req, CancellationToken ct) => Ok(await notes.ShareAsync(id, req, ct));

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct) { await notes.DeleteAsync(id, ct); return NoContent(); }
}
