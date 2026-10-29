namespace ProjectManagement.Application.Features.Ai;

// ---- what the AI page reads

/// <summary>What the workspace's plan allows and how much of the month is left, for the AI page's header and its model picker.</summary>
public record AiUsageDto(string Month, long CreditsUsed, long CreditsLimit, long CreditsLeft, bool Unlimited, string MaxTier, bool Attachments, bool Actions,
    IReadOnlyList<AiTierInfoDto> Tiers, IReadOnlyList<string> AttachmentTypes, int MaxFiles, int MaxImageMb, int MaxDocumentMb, AiRequestLimitDto? RequestLimits = null, long CreditsReserved = 0);

/// <summary>One model level as the page shows it. <see cref="Allowed"/> is whether the plan includes it.</summary>
public record AiTierInfoDto(string Id, string Label, string Model, int Credits, bool Allowed, string Description);

public record AiConversationDto(Guid Id, string Title, DateTime LastMessageAt, bool IsPinned);

/// <summary>What the assistant looked at. A plan it showed (<see cref="AiHomeTools.ShowPlan"/>) carries its <see cref="Steps"/> with how each ended.</summary>
public record AiToolUseDto(string Name, string Label, int? Count, IReadOnlyList<AiPlanStepDto>? Steps = null);
public record AiAttachmentDto(Guid Id, string Name, string ContentType, long SizeBytes, bool IsImage);

/// <summary>
/// A change the assistant proposed. Nothing happens until the person confirms it: <see cref="Status"/> goes from "proposed" to "done"
/// (with a link to the result), "failed" (with the reason) or "dismissed". <see cref="Preview"/> is the full text of what would be created or sent,
/// so the person can read it before confirming.
/// </summary>
public record AiActionDto(string Id, string Kind, string Title, string Summary, string Status, string? Link = null, string? Error = null, string? Preview = null, Guid? ResultId = null, AiActionLifecycleDto? Lifecycle = null,
    DateTime? UndoUntil = null, bool? Undoable = null, string? UndoNote = null);

/// <summary>One step of an answer's plan: its place in the order, what it does, where it stands, and whether (and how) it can be undone.</summary>
public sealed record AiRunStepDto(int Index, string Id, string Kind, string Title, string Summary, string Status, bool Undoable, string? UndoNote, DateTime? UndoUntil,
    string? Link = null, string? Error = null);

/// <summary>
/// An answer's proposed actions seen as one run: the plan before anything happens, or what happened after it was carried out (or undone) in
/// order. <see cref="Outcome"/>: awaiting_confirmation, succeeded, partial, failed, cancelled, executing or undone. <see cref="Completed"/>
/// lists the steps that took effect; <see cref="FailedStepId"/> is where a run stopped. <see cref="UndoUntil"/> is the last moment Undo for
/// the whole run is offered (null when no step can be undone).
/// </summary>
public sealed record AiRunDto(Guid MessageId, string Outcome, IReadOnlyList<AiRunStepDto> Steps, IReadOnlyList<string> Completed, string? FailedStepId, DateTime? UndoUntil,
    string? Message = null);

public record AiMessageDto(Guid Id, string Role, string Content, string? Reasoning, string? Tier, string? Model, string? RouteReason, int Credits, string Status,
    IReadOnlyList<AiToolUseDto> Tools, IReadOnlyList<AiActionDto> Actions, IReadOnlyList<AiAttachmentDto> Attachments, DateTime CreatedAt,
    IReadOnlyList<string>? FollowUps = null, IReadOnlyList<string>? UnverifiedKeys = null, string? Feedback = null, IReadOnlyList<AiKnowledgeReference>? Sources = null,
    /// <summary>Which AI wrote it, e.g. "Claude · your organization's account" or "Project Tracker AI".</summary>
    string? AnsweredBy = null);

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
/// <summary>The plan for a request with several parts, sent when it is shown and again each time a step moves on.</summary>
public sealed record AiStreamPlan(IReadOnlyList<AiPlanStepDto> Steps) : AiStreamEvent("plan");
public sealed record AiStreamDone(AiMessageDto Message, long CreditsLeft, bool Unlimited) : AiStreamEvent("done");
/// <summary>The run failed. <see cref="Saved"/> is the answer as it was saved (its text so far and any suggestions it prepared, which can still be confirmed).</summary>
public sealed record AiStreamError(string Code, string Message, int? RetryAfterSeconds = null, AiMessageDto? Saved = null) : AiStreamEvent("error");
