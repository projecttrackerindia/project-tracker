using System.Net;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Infrastructure.Services;

/// <summary>
/// The AI workspace (streamed, with tools) on a provider that speaks the OpenAI chat-completions API: a self-hosted Ollama or llama.cpp
/// server, Groq, OpenRouter. This is the provider a CPU-only deployment runs on, and the backup when Claude cannot answer. It shares its
/// settings (<c>Ai:Fallback:*</c>) with <see cref="OpenAiCompatibleClient"/>, the one-shot version used to size up a question; the two are
/// the same provider, used two different ways. Google's own API shape (generativelanguage.googleapis.com) is not implemented here - that
/// address only works for the one-shot client, not this streamed one, so it reports itself as not configured.
/// </summary>
public sealed class OpenAiCompatibleChat(IHttpClientFactory http, IOptions<AiOptions> options, OpenAiCompatibleClient oneShot, ILogger<OpenAiCompatibleChat> log) : IAiChat
{
    private AiFallbackOptions F => options.Value.Fallback;

    /// <summary>False for a Google address: streamed tool-use needs Gemini's own API shape, which this class does not speak.</summary>
    public bool Configured => !string.IsNullOrWhiteSpace(F.BaseUrl) && !string.IsNullOrWhiteSpace(F.Model) && !oneShot.UsesGeminiApi;

    public Task<string> CompleteAsync(string model, string system, string user, int maxTokens, CancellationToken ct) => oneShot.CompleteAsync(system, user, maxTokens, ct);

    public async IAsyncEnumerable<AiChatEvent> StreamAsync(AiChatRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        if (!Configured) throw new ConflictException("The AI assistant is not set up on this installation.", "AI_NOT_CONFIGURED");
        var body = Build(request);
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{F.BaseUrl!.Trim().TrimEnd('/')}/chat/completions")
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        if (!string.IsNullOrWhiteSpace(F.ApiKey)) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", F.ApiKey.Trim());

        HttpResponseMessage res;
        try { res = await http.CreateClient("ai-backup-stream").SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct); }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            log.LogWarning(ex, "The local model ({Name}) could not be reached", oneShot.Name);
            throw AiFailure.Unreachable(oneShot.Name, ex);
        }
        using (res)
        {
            if (!res.IsSuccessStatusCode)
            {
                var text = await res.Content.ReadAsStringAsync(ct);
                log.LogWarning("The local model ({Name}) answered {Status}: {Body}", oneShot.Name, (int)res.StatusCode, text.Length > 300 ? text[..300] : text);
                throw AiFailure.For(oneShot.Name, res.StatusCode, text);
            }

            var textAcc = new StringBuilder();
            var tools = new SortedDictionary<int, ToolAcc>();
            string stop = "end_turn";
            int input = 0, output = 0;
            var sawAnyChunk = false;

            await using var stream = await res.Content.ReadAsStreamAsync(ct);
            using var reader = new StreamReader(stream);
            while (await reader.ReadLineAsync(ct) is { } line)
            {
                if (line.Length == 0 || !line.StartsWith("data:", StringComparison.Ordinal)) continue;
                var payload = line["data:".Length..].Trim();
                if (payload is "" or "[DONE]") continue;
                JsonNode? json;
                try { json = JsonNode.Parse(payload); } catch (JsonException) { continue; }   // a malformed keep-alive line; nothing useful to read
                sawAnyChunk = true;

                if (json?["usage"] is { } u)
                {
                    input = u["prompt_tokens"]?.GetValue<int>() ?? input;
                    output = u["completion_tokens"]?.GetValue<int>() ?? output;
                }
                var choice = json?["choices"]?[0];
                var delta = choice?["delta"];
                if (delta?["content"] is JsonValue c && c.TryGetValue<string>(out var textDelta) && textDelta.Length > 0)
                {
                    textAcc.Append(textDelta);
                    yield return new AiTextDelta(textDelta);
                }
                if (delta?["tool_calls"] is JsonArray calls)
                {
                    foreach (var call in calls)
                    {
                        var index = call?["index"]?.GetValue<int>() ?? 0;
                        var acc = tools.TryGetValue(index, out var existing) ? existing : tools[index] = new ToolAcc();
                        if (call?["id"]?.GetValue<string>() is { Length: > 0 } id) acc.Id = id;
                        if (call?["function"]?["name"]?.GetValue<string>() is { Length: > 0 } name) acc.Name = name;
                        if (call?["function"]?["arguments"]?.GetValue<string>() is { } args) acc.Arguments.Append(args);
                    }
                }
                if (choice?["finish_reason"]?.GetValue<string>() is { Length: > 0 } fr)
                    stop = fr switch { "tool_calls" => "tool_use", "length" => "max_tokens", "stop" => "end_turn", _ => fr };
            }
            if (!sawAnyChunk) throw AiFailure.NoAnswer(oneShot.Name, null);

            var assistant = new List<AiBlock>();
            if (textAcc.Length > 0) assistant.Add(new AiText(textAcc.ToString()));
            foreach (var t in tools.Values) assistant.Add(new AiToolUse(t.Id ?? Guid.NewGuid().ToString("N")[..12], t.Name ?? "", t.Arguments.Length == 0 ? "{}" : t.Arguments.ToString()));
            if (tools.Count > 0 && stop == "end_turn") stop = "tool_use";   // some servers send tool_calls without ever setting finish_reason
            log.LogDebug("{Name} turn on {Model}: {Stop}, {In} in / {Out} out", oneShot.Name, request.Model, stop, input, output);
            yield return new AiTurnEnd(assistant, stop, input, output);
        }
    }

    private sealed class ToolAcc { public string? Id, Name; public StringBuilder Arguments = new(); }

    // ------------------------------------------------------------------ request building

    private JsonObject Build(AiChatRequest r)
    {
        var tokens = Math.Clamp(r.MaxTokens, 64, options.Value.MaxTokens) + Math.Max(0, F.ThinkingTokens);
        var messages = new JsonArray { new JsonObject { ["role"] = "system", ["content"] = string.IsNullOrWhiteSpace(r.Context) ? r.System : $"{r.System}\n\n{r.Context}" } };
        foreach (var turn in r.Turns) AppendTurn(messages, turn);
        // r.Model is whichever Claude model the tier router picked (e.g. "claude-haiku-4-5") - meaningless to this provider, which has
        // its own configured model regardless of which Claude tier the person's question was routed to.
        // think: Ollama defaults to asking for a thinking model's reasoning trace unless told not to, and 400s a model whose template
        // does not support thinking at all (most quantized instruct models) rather than just ignoring the request. This provider does not
        // read reasoning traces back out (AiThinking/AiRedactedThinking are Claude-specific blocks this class never produces), so it is
        // always turned off, not only when r.ShowReasoning is false.
        var body = new JsonObject { ["model"] = F.Model, ["stream"] = true, ["max_tokens"] = tokens, ["think"] = false, ["messages"] = messages, ["stream_options"] = new JsonObject { ["include_usage"] = true } };
        if (r.Tools.Count > 0) body["tools"] = new JsonArray(r.Tools.Select(ToTool).ToArray());
        if (!string.IsNullOrWhiteSpace(F.ReasoningEffort)) body["reasoning_effort"] = F.ReasoningEffort.Trim();
        return body;
    }

    private static JsonNode ToTool(AiToolDef t)
    {
        var schema = JsonNode.Parse(t.SchemaJson) ?? new JsonObject();
        return new JsonObject { ["type"] = "function", ["function"] = new JsonObject { ["name"] = t.Name, ["description"] = t.Description, ["parameters"] = schema } };
    }

    /// <summary>
    /// A tool-result turn (<see cref="AiToolResult"/> only, as the agent sends them) becomes one "tool" message per result; anything else
    /// becomes one user/assistant message, its text blocks joined and its tool calls (if it is a past assistant turn) attached. Thinking
    /// blocks are Claude-specific and are left out - this provider does not need them to continue the conversation.
    /// </summary>
    private static void AppendTurn(JsonArray messages, AiTurn turn)
    {
        var results = turn.Blocks.OfType<AiToolResult>().ToList();
        if (results.Count > 0) { foreach (var tr in results) messages.Add(new JsonObject { ["role"] = "tool", ["tool_call_id"] = tr.ToolUseId, ["content"] = tr.Content }); return; }

        var role = turn.Role == "assistant" ? "assistant" : "user";
        var text = new StringBuilder();
        var parts = new JsonArray();
        var hasMedia = false;
        foreach (var b in turn.Blocks)
        {
            switch (b)
            {
                case AiText t: text.Append(t.Text); break;
                case AiImage im:
                    hasMedia = true;
                    parts.Add(new JsonObject { ["type"] = "image_url", ["image_url"] = new JsonObject { ["url"] = $"data:{im.MediaType};base64,{Convert.ToBase64String(im.Data)}" } });
                    break;
                case AiPdf pdf: text.Append($"\n[Attachment “{pdf.Name}” omitted: this model only reads text and images.]"); break;
            }
        }
        var toolCalls = turn.Blocks.OfType<AiToolUse>().ToList();
        var msg = new JsonObject { ["role"] = role };
        if (hasMedia) { if (text.Length > 0) parts.Insert(0, new JsonObject { ["type"] = "text", ["text"] = text.ToString() }); msg["content"] = parts; }
        else msg["content"] = text.Length > 0 ? text.ToString() : toolCalls.Count > 0 ? null : "";
        if (toolCalls.Count > 0)
            msg["tool_calls"] = new JsonArray(toolCalls.Select(tu => (JsonNode)new JsonObject
            {
                ["id"] = tu.Id, ["type"] = "function", ["function"] = new JsonObject { ["name"] = tu.Name, ["arguments"] = string.IsNullOrWhiteSpace(tu.InputJson) ? "{}" : tu.InputJson },
            }).ToArray());
        messages.Add(msg);
    }
}

/// <summary>
/// The AI workspace's model: Claude, with the same <c>Ai:Fallback:*</c> provider as backup - a self-hosted Ollama/llama.cpp server for a
/// CPU-only deployment, or any other OpenAI-compatible address. Mirrors <see cref="AiRouter"/>'s one-shot fallback, but for the streamed,
/// tool-using conversation the AI workspace actually runs on; without this, a CPU-only or Claude-outage deployment had no fallback at all
/// for the workspace itself; even in a workspace that still has Claude a mid-stream failure (and a provider misconfiguration, which does
/// not mend itself in seconds) rests Claude for a while, same as the one-shot router.
/// </summary>
public sealed class AiChatRouter(AnthropicChat claude, OpenAiCompatibleChat backup, ILogger<AiChatRouter> log) : IAiChat
{
    private static readonly TimeSpan Rest = TimeSpan.FromMinutes(15);
    private long _claudeRestsUntil;

    public bool Configured => claude.Configured || backup.Configured;

    public Task<string> CompleteAsync(string model, string system, string user, int maxTokens, CancellationToken ct) =>
        claude.Configured ? claude.CompleteAsync(model, system, user, maxTokens, ct) : backup.CompleteAsync(model, system, user, maxTokens, ct);

    public async IAsyncEnumerable<AiChatEvent> StreamAsync(AiChatRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        if (!Configured) throw new ConflictException("The AI assistant is not set up on this installation.", "AI_NOT_CONFIGURED");
        var useClaude = claude.Configured && (!backup.Configured || DateTime.UtcNow.Ticks >= Interlocked.Read(ref _claudeRestsUntil));
        if (useClaude)
        {
            // Claude is asked first, one turn at a time; if the very first thing it returns is a failure (not configured, no credit, a
            // network error...) nothing has reached the person yet, so switching to the backup here is still invisible to them. A failure
            // after that point - mid-stream - is rare and is simply let through, rather than silently restarting the answer on another model.
            var events = claude.StreamAsync(request, ct).GetAsyncEnumerator(ct);
            AiProviderException? failure = null;
            bool more;
            try { more = await events.MoveNextAsync(); }
            catch (AiProviderException ex) when (backup.Configured) { failure = ex; more = false; }
            if (failure is null)
            {
                while (more) { yield return events.Current; more = await events.MoveNextAsync(); }
                yield break;
            }
            if (AiProviderException.NeedsAdmin(failure.Code)) Interlocked.Exchange(ref _claudeRestsUntil, (DateTime.UtcNow + Rest).Ticks);
            log.LogWarning("Claude could not answer ({Code}); asking the backup model for the AI workspace", failure.Code);
        }
        await foreach (var e in backup.StreamAsync(request, ct)) yield return e;
    }
}
