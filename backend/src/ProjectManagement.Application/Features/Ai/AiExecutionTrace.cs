namespace ProjectManagement.Application.Features.Ai;

/// <summary>Operational metadata only: never requests, tool arguments, results, attachments or provider error text.</summary>
public sealed record AiExecutionTrace(string Agent, string Version, string CorrelationId, string Provider, string Model,
    DateTime StartedAt, long DurationMs, long ContextMs, long? FirstTokenMs, int PromptChars, int ToolDefinitions,
    string Outcome, string? ErrorCode, IReadOnlyList<AiModelTiming> Models, IReadOnlyList<AiToolTiming> Tools, string? Intent = null, double? IntentConfidence = null, long? IntentMs = null);
public sealed record AiModelTiming(int Step, long DurationMs, int InputTokens, int OutputTokens, string StopReason);
public sealed record AiToolTiming(string Name, long DurationMs, bool Succeeded, string State);
