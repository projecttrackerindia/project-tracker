using System.Net;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Anthropic.Exceptions;
using Anthropic.Models.Messages;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Ai;
using SdkClient = Anthropic.AnthropicClient;   // this project has its own AnthropicClient (the one-shot features); this is the SDK's

namespace ProjectManagement.Infrastructure.Services;

/// <summary>
/// The AI workspace's connection to Claude, through the official Anthropic SDK. One streamed turn at a time: text and reasoning arrive as
/// they are written, and tool calls come back whole for the agent to run. Nothing is called unless <c>Ai:AnthropicApiKey</c> is set.
/// Provider failures become the same friendly <see cref="AiProviderException"/>s the rest of the assistant uses.
/// </summary>
public sealed class AnthropicChat(IOptions<AiOptions> options, ILogger<AnthropicChat> log) : IAiChat
{
    private readonly object _gate = new();
    private SdkClient? _client;
    private string? _clientKey;

    public bool Configured => !string.IsNullOrWhiteSpace(options.Value.AnthropicApiKey);

    private SdkClient Client()
    {
        var o = options.Value;
        lock (_gate)
        {
            if (_client is null || _clientKey != o.AnthropicApiKey)
            {
                _client = new SdkClient { ApiKey = o.AnthropicApiKey, BaseUrl = o.BaseUrl, Timeout = TimeSpan.FromMinutes(5), MaxRetries = 2 };
                _clientKey = o.AnthropicApiKey;
            }
            return _client;
        }
    }

    // ------------------------------------------------------------------ a short answer

    public async Task<string> CompleteAsync(string model, string system, string user, int maxTokens, CancellationToken ct)
    {
        if (!Configured) throw new Application.Exceptions.ConflictException("The AI assistant is not set up on this installation.", "AI_NOT_CONFIGURED");
        try
        {
            var response = await Client().Messages.Create(new MessageCreateParams
            {
                Model = model,
                MaxTokens = maxTokens,
                System = system,
                Messages = [new() { Role = Role.User, Content = user }],
            }, ct);
            return string.Concat(response.Content.Select(b => b.Value).OfType<TextBlock>().Select(t => t.Text)).Trim();
        }
        catch (Exception ex) when (Map(ex, ct) is { } mapped) { throw mapped; }
    }

    // ------------------------------------------------------------------ a streamed turn

    public async IAsyncEnumerable<AiChatEvent> StreamAsync(AiChatRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        if (!Configured) throw new Application.Exceptions.ConflictException("The AI assistant is not set up on this installation.", "AI_NOT_CONFIGURED");
        var parameters = Build(request);
        var blocks = new SortedDictionary<long, Acc>();
        int input = 0, output = 0;
        string stop = "end_turn";

        var stream = Client().Messages.CreateStreaming(parameters, ct);
        await using var events = stream.GetAsyncEnumerator(ct);
        while (true)
        {
            bool more;
            try { more = await events.MoveNextAsync(); }
            catch (Exception ex) when (Map(ex, ct) is { } mapped) { throw mapped; }
            if (!more) break;
            var e = events.Current;

            if (e.TryPickStart(out var start))
            {
                var u = start.Message.Usage;
                input = (int)(u.InputTokens + (u.CacheReadInputTokens ?? 0) + (u.CacheCreationInputTokens ?? 0));
            }
            else if (e.TryPickContentBlockStart(out var open))
            {
                var acc = new Acc();
                var b = open.ContentBlock;
                if (b.TryPickText(out var t)) { acc.Kind = "text"; acc.Text.Append(t.Text); }
                else if (b.TryPickThinking(out var th)) { acc.Kind = "thinking"; acc.Text.Append(th.Thinking); acc.Signature = th.Signature; }
                else if (b.TryPickRedactedThinking(out var rd)) { acc.Kind = "redacted"; acc.Signature = rd.Data; }
                else if (b.TryPickToolUse(out var tu)) { acc.Kind = "tool"; acc.Id = tu.ID; acc.Name = tu.Name; }
                else acc.Kind = "other";
                blocks[open.Index] = acc;
            }
            else if (e.TryPickContentBlockDelta(out var delta) && blocks.TryGetValue(delta.Index, out var cur))
            {
                var d = delta.Delta;
                if (d.TryPickText(out var td)) { cur.Text.Append(td.Text); if (td.Text.Length > 0) yield return new AiTextDelta(td.Text); }
                else if (d.TryPickThinking(out var thd)) { cur.Text.Append(thd.Thinking); if (thd.Thinking.Length > 0) yield return new AiThinkingDelta(thd.Thinking); }
                else if (d.TryPickSignature(out var sg)) cur.Signature = (cur.Signature ?? "") + sg.Signature;
                else if (d.TryPickInputJson(out var ij)) cur.Json.Append(ij.PartialJson);
            }
            else if (e.TryPickDelta(out var md))
            {
                // The SDK's enum prints its JSON form ("tool_use" with the quotes), so the quotes come off.
                if (md.Delta.StopReason is { } sr) stop = sr.ToString()?.Trim('"') is { Length: > 0 } reason ? reason : stop;
                output = (int)md.Usage.OutputTokens;
                if (md.Usage.InputTokens is { } it) input = (int)it;
            }
        }

        var assistant = new List<AiBlock>();
        foreach (var acc in blocks.Values)
        {
            switch (acc.Kind)
            {
                case "text" when acc.Text.Length > 0: assistant.Add(new AiText(acc.Text.ToString())); break;
                case "thinking": assistant.Add(new AiThinking(acc.Text.ToString(), acc.Signature ?? "")); break;
                case "redacted": assistant.Add(new AiRedactedThinking(acc.Signature ?? "")); break;
                case "tool": assistant.Add(new AiToolUse(acc.Id ?? "", acc.Name ?? "", acc.Json.Length == 0 ? "{}" : acc.Json.ToString())); break;
            }
        }
        log.LogDebug("Claude turn on {Model}: {Stop}, {In} in / {Out} out", request.Model, stop, input, output);
        yield return new AiTurnEnd(assistant, stop, input, output);
    }

    private sealed class Acc
    {
        public string Kind = "";
        public StringBuilder Text = new();
        public StringBuilder Json = new();
        public string? Signature, Id, Name;
    }

    // ------------------------------------------------------------------ request building

    private static MessageCreateParams Build(AiChatRequest r)
    {
        var p = new MessageCreateParams
        {
            Model = r.Model,
            MaxTokens = r.MaxTokens,
            // The instructions are the same for every question, so they are cached: later turns of a conversation read them at a fraction of the price.
            // What changes per person and day follows in its own block, after the cached part.
            System = SystemBlocks(r),
            Messages = r.Turns.Select(ToMessage).ToList(),
        };
        if (r.Tools.Count > 0) p = p with { Tools = r.Tools.Select(ToTool).ToList() };
        // Haiku does not think and rejects an effort setting; the larger models think adaptively and take one.
        if (r.Effort is { Length: > 0 } effort && ParseEffort(effort) is { } level) p = p with { OutputConfig = new OutputConfig { Effort = level } };
        if (r.ShowReasoning) p = p with { Thinking = new ThinkingConfigAdaptive { Display = Display.Summarized } };
        return p;
    }

    private static List<TextBlockParam> SystemBlocks(AiChatRequest r)
    {
        var blocks = new List<TextBlockParam> { new() { Text = r.System, CacheControl = new CacheControlEphemeral() } };
        if (!string.IsNullOrWhiteSpace(r.Context)) blocks.Add(new TextBlockParam { Text = r.Context });
        return blocks;
    }

    private static Effort? ParseEffort(string e) => e.ToLowerInvariant() switch
    {
        "low" => Effort.Low, "medium" => Effort.Medium, "high" => Effort.High, "max" => Effort.Max, _ => null,
    };

    private static ToolUnion ToTool(AiToolDef t)
    {
        using var doc = JsonDocument.Parse(t.SchemaJson);
        var root = doc.RootElement;
        var props = new Dictionary<string, JsonElement>();
        if (root.TryGetProperty("properties", out var ps)) foreach (var p in ps.EnumerateObject()) props[p.Name] = p.Value.Clone();
        var required = root.TryGetProperty("required", out var rq) ? rq.EnumerateArray().Select(x => x.GetString()!).ToList() : [];
        return new Tool { Name = t.Name, Description = t.Description, InputSchema = new() { Properties = props, Required = required } };
    }

    private static MessageParam ToMessage(AiTurn turn)
    {
        var content = new List<ContentBlockParam>();
        foreach (var b in turn.Blocks)
        {
            switch (b)
            {
                case AiText t: content.Add(new TextBlockParam { Text = t.Text }); break;
                case AiThinking th: content.Add(new ThinkingBlockParam { Thinking = th.Text, Signature = th.Signature }); break;
                case AiRedactedThinking rd: content.Add(new RedactedThinkingBlockParam { Data = rd.Data }); break;
                case AiToolUse tu:
                    content.Add(new ToolUseBlockParam
                    {
                        ID = tu.Id, Name = tu.Name,
                        Input = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(string.IsNullOrWhiteSpace(tu.InputJson) ? "{}" : tu.InputJson) ?? [],
                    });
                    break;
                case AiToolResult tr: content.Add(new ToolResultBlockParam { ToolUseID = tr.ToolUseId, Content = tr.Content, IsError = tr.IsError }); break;
                case AiImage im:
                    content.Add(new ImageBlockParam { Source = new Base64ImageSource { Data = Convert.ToBase64String(im.Data), MediaType = MediaTypeOf(im.MediaType) } });
                    break;
                case AiPdf pdf: content.Add(new DocumentBlockParam { Title = pdf.Name, Source = new Base64PdfSource { Data = Convert.ToBase64String(pdf.Data) } }); break;
            }
        }
        return new MessageParam { Role = turn.Role == "assistant" ? Role.Assistant : Role.User, Content = content };
    }

    private static MediaType MediaTypeOf(string contentType) => contentType.ToLowerInvariant() switch
    {
        "image/png" => MediaType.ImagePng, "image/gif" => MediaType.ImageGif, "image/webp" => MediaType.ImageWebP, _ => MediaType.ImageJpeg,
    };

    // ------------------------------------------------------------------ failures

    /// <summary>Turns a failure of the SDK or the network into an <see cref="AiProviderException"/>; null leaves any other exception alone.</summary>
    private Exception? Map(Exception ex, CancellationToken ct)
    {
        switch (ex)
        {
            case OperationCanceledException when ct.IsCancellationRequested: return null;
            case AnthropicApiException api:
                log.LogWarning("Claude answered {Status}: {Message}", (int)api.StatusCode, api.Message.Length > 300 ? api.Message[..300] : api.Message);
                return AiFailure.For("Claude", (HttpStatusCode)(int)api.StatusCode, api.Message);
            case TaskCanceledException or HttpRequestException or AnthropicIOException:
                log.LogWarning(ex, "Claude could not be reached");
                return AiFailure.Unreachable("Claude", ex);
            default: return null;
        }
    }
}
