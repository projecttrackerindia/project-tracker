using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Chat;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Chat;

/// <summary>Chat between people of the workspace: private chats and groups. Live delivery is through the hub at /hubs/chat.</summary>
[Route("api/v1/chat"), RequireWorkspace]
public class ChatController(ChatService chat, ChatAiService chatAi, ReminderSuggestionService promises) : ApiControllerBase
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
    public async Task<IActionResult> Send(Guid id, [FromBody] SendMessageRequest req, CancellationToken ct)
    {
        var sent = await chat.SendAsync(id, req, ct);
        // "I'll send the estimate by Friday": offered as a reminder for the writer (never set without their tap).
        await promises.OfferFromTextAsync(req.Body, "chat", $"chat:{sent.Id}", $"/chat/{id}", ct);
        return Created(sent);
    }

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

    // ---- threads, pins, saved messages, seen by, questions waiting for me

    [HttpGet("messages/{id:guid}/thread")]
    public async Task<IActionResult> Thread(Guid id, CancellationToken ct) => Ok(await chat.ThreadAsync(id, ct));

    [HttpPut("messages/{id:guid}/pin")]
    public async Task<IActionResult> Pin(Guid id, CancellationToken ct) => Ok(await chat.PinAsync(id, true, ct));

    [HttpDelete("messages/{id:guid}/pin")]
    public async Task<IActionResult> Unpin(Guid id, CancellationToken ct) => Ok(await chat.PinAsync(id, false, ct));

    [HttpGet("conversations/{id:guid}/pins")]
    public async Task<IActionResult> Pins(Guid id, CancellationToken ct) => Ok(await chat.PinsAsync(id, ct));

    [HttpPut("messages/{id:guid}/save")]
    public async Task<IActionResult> Save(Guid id, CancellationToken ct) => Ok(await chat.SaveMessageAsync(id, true, ct));

    [HttpDelete("messages/{id:guid}/save")]
    public async Task<IActionResult> Unsave(Guid id, CancellationToken ct) => Ok(await chat.SaveMessageAsync(id, false, ct));

    [HttpGet("saved")]
    public async Task<IActionResult> Saved(CancellationToken ct) => Ok(await chat.SavedAsync(ct));

    [HttpGet("messages/{id:guid}/seen")]
    public async Task<IActionResult> SeenBy(Guid id, CancellationToken ct) => Ok(await chat.SeenByAsync(id, ct));

    /// <summary>Questions put to the caller in the last two weeks that they have not answered.</summary>
    [HttpGet("questions")]
    public async Task<IActionResult> Questions(CancellationToken ct) => Ok(await chat.QuestionsAsync(ct));

    // ---- status and do-not-disturb

    [HttpGet("status")]
    public async Task<IActionResult> Status(CancellationToken ct) => Ok(await chat.MyStatusAsync(ct));

    [HttpPut("status")]
    public async Task<IActionResult> SetStatus([FromBody] SetChatStatusRequest req, CancellationToken ct) => Ok(await chat.SetStatusAsync(req, ct));

    // ---- polls

    [HttpPost("conversations/{id:guid}/polls")]
    public async Task<IActionResult> CreatePoll(Guid id, [FromBody] CreatePollRequest req, CancellationToken ct) => Created(await chat.CreatePollAsync(id, req, ct));

    [HttpPost("polls/{id:guid}/vote")]
    public async Task<IActionResult> Vote(Guid id, [FromBody] VotePollRequest req, CancellationToken ct) => Ok(await chat.VoteAsync(id, req, ct));

    [HttpPost("polls/{id:guid}/close")]
    public async Task<IActionResult> ClosePoll(Guid id, [FromBody] ClosePollRequest? req, CancellationToken ct) => Ok(await chat.ClosePollAsync(id, req ?? new ClosePollRequest(null), ct));

    // ---- scheduled send

    [HttpPost("conversations/{id:guid}/scheduled")]
    public async Task<IActionResult> Schedule(Guid id, [FromBody] ScheduleMessageRequest req, CancellationToken ct) => Created(await chat.ScheduleAsync(id, req, ct));

    [HttpGet("scheduled")]
    public async Task<IActionResult> Scheduled([FromQuery] Guid? conversationId, CancellationToken ct) => Ok(await chat.ScheduledAsync(conversationId, ct));

    [HttpPut("scheduled/{id:guid}")]
    public async Task<IActionResult> UpdateScheduled(Guid id, [FromBody] ScheduleMessageRequest req, CancellationToken ct) => Ok(await chat.UpdateScheduledAsync(id, req, ct));

    [HttpDelete("scheduled/{id:guid}")]
    public async Task<IActionResult> CancelScheduled(Guid id, CancellationToken ct)
    {
        await chat.CancelScheduledAsync(id, ct);
        return NoContent();
    }

    // ---- voice notes (a WAV recorded in the browser; transcribed when it arrives)

    [HttpPost("conversations/{id:guid}/voice"), RequestSizeLimit(25 * 1024 * 1024), RequestFormLimits(MultipartBodyLengthLimit = 25 * 1024 * 1024)]
    public async Task<IActionResult> UploadVoice(Guid id, IFormFile file, [FromForm] int? seconds, CancellationToken ct)
    {
        await using var stream = file.OpenReadStream();
        return Created(await chat.UploadVoiceAsync(id, stream, file.Length, seconds, ct));
    }

    // ---- what was made from a message, and task / page keys as live cards

    [HttpPost("messages/{id:guid}/links")]
    public async Task<IActionResult> Link(Guid id, [FromBody] LinkMessageRequest req, CancellationToken ct) => Ok(await chat.LinkAsync(id, req, ct));

    [HttpGet("unfurl")]
    public async Task<IActionResult> Unfurl([FromQuery] string? keys, CancellationToken ct) =>
        Ok(await chat.UnfurlAsync((keys ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries), ct));

    // ---- AI: catch me up, ask the chat, smart replies, fields from a message, rewrite or translate

    [HttpPost("ai/catch-up"), AiRequestLimit]
    public async Task<IActionResult> CatchUp([FromBody] ChatCatchUpRequest? req, CancellationToken ct) => Ok(await chatAi.CatchUpAsync(req ?? new ChatCatchUpRequest(null), ct));

    [HttpPost("ai/ask"), AiRequestLimit]
    public async Task<IActionResult> Ask([FromBody] ChatAskRequest req, CancellationToken ct) => Ok(await chatAi.AskAsync(req, ct));

    [HttpPost("messages/{id:guid}/replies"), AiRequestLimit]
    public async Task<IActionResult> Replies(Guid id, CancellationToken ct) => Ok(await chatAi.RepliesAsync(id, ct));

    [HttpPost("messages/{id:guid}/extract")]
    public async Task<IActionResult> Extract(Guid id, [FromBody] ChatExtractRequest req, CancellationToken ct) => Ok(await chatAi.ExtractAsync(id, req, ct));

    [HttpPost("ai/transform"), AiRequestLimit]
    public async Task<IActionResult> Transform([FromBody] ChatTransformRequest req, CancellationToken ct) => Ok(await chatAi.TransformAsync(req, ct));
}
