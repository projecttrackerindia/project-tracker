namespace ProjectManagement.Application.Features.Ai;

/// <summary>Operational metadata only: never requests, tool arguments, results, attachments or provider error text.</summary>
public sealed record AiExecutionTrace(string Agent, string Version, string CorrelationId, string Provider, string Model,
    DateTime StartedAt, long DurationMs, long ContextMs, long? FirstTokenMs, int PromptChars, int ToolDefinitions,
    string Outcome, string? ErrorCode, IReadOnlyList<AiModelTiming> Models, IReadOnlyList<AiToolTiming> Tools, string? Intent = null, double? IntentConfidence = null, long? IntentMs = null, AiDatabaseTiming? Database = null, IReadOnlyList<AiActionTiming>? Actions = null, AiPreparationTiming? Preparation = null);
public sealed record AiModelTiming(int Step, long DurationMs, int InputTokens, int OutputTokens, string StopReason, AiRuntimeTiming? Runtime = null,
    string? Model = null, int CacheReadTokens = 0, int CacheWriteTokens = 0, bool UsageKnown = true);
public sealed record AiToolTiming(string Name, long DurationMs, bool Succeeded, string State);

public sealed record AiRuntimeTiming(double? LoadMs, double? PromptEvalMs, double? GenerationMs, double? TotalMs, int? CachedPromptTokens, double? QueueMs = null);

public sealed record AiActionTiming(string Id, string Kind, string Status, long? DurationMs, long? ConfirmationWaitMs, int Attempts, AiDatabaseTiming? Database);

public sealed record AiPreparationTiming(DateTime StartedAt, long DurationMs, AiDatabaseTiming Database);
