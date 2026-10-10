namespace ProjectManagement.Application.Features.Ai;

// A small, provider-neutral shape for a conversation with a model that can think, use tools and read images and documents. The agent
// works in these types; the one class that talks to Claude (in Infrastructure) turns them into API calls and back.

public abstract record AiBlock;
public sealed record AiText(string Text) : AiBlock;
/// <summary>The model's reasoning. It must go back unchanged, signature included, when the same answer continues after a tool call.</summary>
public sealed record AiThinking(string Text, string Signature) : AiBlock;
public sealed record AiRedactedThinking(string Data) : AiBlock;
public sealed record AiToolUse(string Id, string Name, string InputJson) : AiBlock;
public sealed record AiToolResult(string ToolUseId, string Content, bool IsError = false) : AiBlock;
public sealed record AiImage(string MediaType, byte[] Data) : AiBlock;
public sealed record AiPdf(byte[] Data, string Name) : AiBlock;

/// <summary><paramref name="Role"/> is "user" or "assistant".</summary>
public sealed record AiTurn(string Role, IReadOnlyList<AiBlock> Blocks)
{
    public static AiTurn User(string text) => new("user", [new AiText(text)]);
}

/// <summary>A tool the model may call. <paramref name="SchemaJson"/> is the JSON Schema of its input (an object).</summary>
public sealed record AiToolDef(string Name, string Description, string SchemaJson);

/// <summary>
/// <paramref name="System"/> is the same for every question (so the provider can cache it); <paramref name="Context"/> is what changes from
/// person to person and day to day (who is asking, the date, the organization's own description) and follows it uncached.
/// </summary>
public sealed record AiChatRequest(string Model, string System, string Context, IReadOnlyList<AiTurn> Turns, IReadOnlyList<AiToolDef> Tools, int MaxTokens,
    string? Effort, bool ShowReasoning);

public abstract record AiChatEvent;
public sealed record AiTextDelta(string Text) : AiChatEvent;
public sealed record AiThinkingDelta(string Text) : AiChatEvent;
/// <summary>
/// One model turn is complete: everything it produced (to send back after tool results), why it stopped, and what it used. InputTokens is the
/// part that was not cached; the cached part is counted apart because the provider bills it very differently.
/// </summary>
public sealed record AiTurnEnd(IReadOnlyList<AiBlock> Assistant, string StopReason, int InputTokens, int OutputTokens, int CacheReadTokens = 0, int CacheWriteTokens = 0, string? Model = null, string? Provider = null, AiRuntimeTiming? Runtime = null) : AiChatEvent
{
    public bool WantsTools => StopReason == "tool_use";
}

/// <summary>The model behind the AI workspace. Streams one turn at a time; the agent runs the tool loop around it.</summary>
public interface IAiChat
{
    bool Configured { get; }
    string Provider => "configured provider";
    string ModelFor(string requestedModel) => requestedModel;
    IAsyncEnumerable<AiChatEvent> StreamAsync(AiChatRequest request, CancellationToken ct);
    /// <summary>A short, non-streaming answer (used to size up a question before choosing a model level).</summary>
    Task<string> CompleteAsync(string model, string system, string user, int maxTokens, CancellationToken ct);
}
