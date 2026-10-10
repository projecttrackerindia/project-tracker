namespace ProjectManagement.Application.Features.Ai;

// ---- what the AI page reads

/// <summary>What the workspace's plan allows and how much of the month is left, for the AI page's header and its model picker.</summary>
public record AiUsageDto(string Month, long CreditsUsed, long CreditsLimit, long CreditsLeft, bool Unlimited, string MaxTier, bool Attachments, bool Actions,
    IReadOnlyList<AiTierInfoDto> Tiers, IReadOnlyList<string> AttachmentTypes, int MaxFiles, int MaxImageMb, int MaxDocumentMb);

/// <summary>One model level as the page shows it. <see cref="Allowed"/> is whether the plan includes it.</summary>
public record AiTierInfoDto(string Id, string Label, string Model, int Credits, bool Allowed, string Description);

public record AiConversationDto(Guid Id, string Title, DateTime LastMessageAt, bool IsPinned);

public record AiToolUseDto(string Name, string Label, int? Count);
public record AiAttachmentDto(Guid Id, string Name, string ContentType, long SizeBytes, bool IsImage);

/// <summary>
/// A change the assistant proposed. Nothing happens until the person confirms it: <see cref="Status"/> goes from "proposed" to "done"
/// (with a link to the result), "failed" (with the reason) or "dismissed". <see cref="Preview"/> is the full text of what would be created or sent,
/// so the person can read it before confirming.
/// </summary>
public record AiActionDto(string Id, string Kind, string Title, string Summary, string Status, string? Link = null, string? Error = null, string? Preview = null, Guid? ResultId = null, AiActionLifecycleDto? Lifecycle = null);

public record AiMessageDto(Guid Id, string Role, string Content, string? Reasoning, string? Tier, string? Model, string? RouteReason, int Credits, string Status,
    IReadOnlyList<AiToolUseDto> Tools, IReadOnlyList<AiActionDto> Actions, IReadOnlyList<AiAttachmentDto> Attachments, DateTime CreatedAt,
    IReadOnlyList<string>? FollowUps = null, IReadOnlyList<string>? UnverifiedKeys = null, string? Feedback = null);

public record AiConversationDetailDto(AiConversationDto Conversation, IReadOnlyList<AiMessageDto> Messages);

public record AiInstructionsDto(string? Text, bool CanEdit);
public record SetAiInstructionsRequest(string? Text);
public record RenameAiConversationRequest(string? Title, bool? Pinned);

// ---- a question

/// <summary>A question for the assistant. <see cref="Mode"/> is "auto" (the default), "quick", "standard" or "deep".</summary>
public record AiConfirmationBinding(Guid MessageId, string ActionId, string Kind);
public record AiAskRequest(string? Text, string? Mode, IReadOnlyList<Guid>? AttachmentIds, string? TimeZone, AiConfirmationBinding? Confirmation = null);

// ---- the live stream of one answer

/// <summary>One piece of an answer as it is produced. The controller sends each as a server-sent event named <see cref="Name"/>.</summary>
public abstract record AiStreamEvent(string Name);
public sealed record AiStreamStarted(Guid ConversationId, Guid QuestionId, string Title) : AiStreamEvent("started");
/// <summary>Which level was chosen and why; <see cref="Limited"/> means the question deserved a higher level than the plan (or the credits left) allows.</summary>
public sealed record AiStreamRoute(string Tier, string Model, string Reason, bool Limited, string Wanted, int Credits) : AiStreamEvent("route");
public sealed record AiStreamReasoning(string Delta) : AiStreamEvent("reasoning");
public sealed record AiStreamInference(string State, int? WaitLimitSeconds) : AiStreamEvent("inference");
public sealed record AiStreamText(string Delta) : AiStreamEvent("text");
/// <summary><paramref name="State"/> is "running" or "done".</summary>
public sealed record AiStreamTool(string Id, string Tool, string Label, string State, int? Count) : AiStreamEvent("tool");
public sealed record AiStreamAction(AiActionDto Action) : AiStreamEvent("action");
public sealed record AiStreamDone(AiMessageDto Message, long CreditsLeft, bool Unlimited) : AiStreamEvent("done");
public sealed record AiStreamError(string Code, string Message) : AiStreamEvent("error");
