using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Chat;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Chat;

/// <summary>Chat between people of the workspace: private chats and groups. Live delivery is through the hub at /hubs/chat.</summary>
[Route("api/v1/chat"), RequireWorkspace]
public class ChatController(ChatService chat) : ApiControllerBase
{
    [HttpGet("people")]
    public async Task<IActionResult> People(CancellationToken ct) => Ok(await chat.PeopleAsync(ct));

    [HttpGet("unread")]
    public async Task<IActionResult> Unread(CancellationToken ct) => Ok(await chat.UnreadAsync(ct));

    [HttpGet("search")]
    public async Task<IActionResult> Search([FromQuery] string? q, CancellationToken ct) => Ok(await chat.SearchAsync(q, ct));

    /// <summary>The team chat of a project (created on first use): its team, its owner and the organization's Owners, Admins and Managers.</summary>
    [HttpPost("projects/{projectId:guid}/open"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> OpenProject(Guid projectId, CancellationToken ct) => Ok(await chat.OpenProjectAsync(projectId, ct));

    /// <summary>Projects whose chat has messages the caller has not read yet, and how many of them mention the caller.</summary>
    [HttpGet("projects/unread"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> ProjectUnread(CancellationToken ct) => Ok(await chat.ProjectUnreadAsync(ct));

    [HttpGet("conversations")]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await chat.ListAsync(ct));

    [HttpGet("conversations/{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => Ok(await chat.GetAsync(id, ct));

    [HttpPost("conversations/direct")]
    public async Task<IActionResult> OpenDirect([FromBody] OpenDirectRequest req, CancellationToken ct) => Ok(await chat.OpenDirectAsync(req, ct));

    [HttpPost("conversations/group")]
    public async Task<IActionResult> CreateGroup([FromBody] CreateGroupRequest req, CancellationToken ct) => Created(await chat.CreateGroupAsync(req, ct));

    [HttpPut("conversations/{id:guid}")]
    public async Task<IActionResult> Rename(Guid id, [FromBody] RenameGroupRequest req, CancellationToken ct) => Ok(await chat.RenameAsync(id, req, ct));

    [HttpPost("conversations/{id:guid}/members")]
    public async Task<IActionResult> AddMembers(Guid id, [FromBody] AddMembersRequest req, CancellationToken ct) => Ok(await chat.AddMembersAsync(id, req, ct));

    /// <summary>Removes a person from a group; removing yourself leaves it.</summary>
    [HttpDelete("conversations/{id:guid}/members/{userId:guid}")]
    public async Task<IActionResult> RemoveMember(Guid id, Guid userId, CancellationToken ct)
    {
        await chat.RemoveMemberAsync(id, userId, ct);
        return NoContent();
    }

    [HttpGet("conversations/{id:guid}/messages")]
    public async Task<IActionResult> Messages(Guid id, [FromQuery] DateTime? before, [FromQuery] int? limit, CancellationToken ct) =>
        Ok(await chat.MessagesAsync(id, before, limit, ct));

    [HttpPost("conversations/{id:guid}/messages")]
    public async Task<IActionResult> Send(Guid id, [FromBody] SendMessageRequest req, CancellationToken ct) => Created(await chat.SendAsync(id, req, ct));

    [HttpPost("conversations/{id:guid}/read")]
    public async Task<IActionResult> MarkRead(Guid id, CancellationToken ct)
    {
        await chat.MarkReadAsync(id, ct);
        return NoContent();
    }

    [HttpPut("conversations/{id:guid}/mute")]
    public async Task<IActionResult> Mute(Guid id, [FromBody] MuteRequest req, CancellationToken ct)
    {
        await chat.SetMutedAsync(id, req.Muted, ct);
        return NoContent();
    }

    [HttpPut("messages/{id:guid}")]
    public async Task<IActionResult> Edit(Guid id, [FromBody] EditMessageRequest req, CancellationToken ct) => Ok(await chat.EditAsync(id, req, ct));

    [HttpDelete("messages/{id:guid}")]
    public async Task<IActionResult> DeleteMessage(Guid id, CancellationToken ct)
    {
        await chat.DeleteMessageAsync(id, ct);
        return NoContent();
    }

    // ---- files (stored in the configured file storage, S3 or local; allowed by the plan's CHAT_ATTACHMENTS, file size and storage limits)

    private const long FileCeiling = 520L * 1024 * 1024;   // the largest file the plans allow plus form overhead; the real limits are in AttachmentService

    [HttpPost("conversations/{id:guid}/files")]
    [RequestSizeLimit(FileCeiling), RequestFormLimits(MultipartBodyLengthLimit = FileCeiling)]
    public async Task<IActionResult> UploadFile(Guid id, IFormFile file, CancellationToken ct)
    {
        await using var stream = file.OpenReadStream();
        return Created(await chat.UploadAsync(id, file.FileName, stream, file.Length, ct));
    }

    [HttpGet("conversations/{id:guid}/files")]
    public async Task<IActionResult> Files(Guid id, [FromQuery] DateTime? before, [FromQuery] int? limit, CancellationToken ct) =>
        Ok(await chat.FilesAsync(id, before, limit, ct));

    /// <summary>A file of a conversation the caller is in. Pictures can be shown inline; everything else downloads.</summary>
    [HttpGet("files/{id:guid}")]
    public async Task<IActionResult> DownloadFile(Guid id, [FromQuery] bool inline, CancellationToken ct)
    {
        var (file, content) = await chat.OpenFileAsync(id, ct);
        Response.Headers.CacheControl = "private, no-store";
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        Response.Headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
        return inline && ProjectManagement.Application.Features.Files.FileRules.IsImage(file.ContentType) ? File(content, file.ContentType) : File(content, file.ContentType, file.FileName);
    }

    /// <summary>Takes back a file that was added but not sent.</summary>
    [HttpDelete("files/{id:guid}")]
    public async Task<IActionResult> RemoveFile(Guid id, CancellationToken ct)
    {
        await chat.RemovePendingFileAsync(id, ct);
        return NoContent();
    }

    // ---- reactions

    [HttpPut("messages/{id:guid}/reaction")]
    public async Task<IActionResult> React(Guid id, [FromBody] ReactRequest req, CancellationToken ct) => Ok(await chat.ReactAsync(id, req.Emoji, true, ct));

    [HttpDelete("messages/{id:guid}/reaction")]
    public async Task<IActionResult> Unreact(Guid id, [FromQuery] string emoji, CancellationToken ct) => Ok(await chat.ReactAsync(id, emoji, false, ct));
}
