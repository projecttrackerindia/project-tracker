using System.Net;
using System.Diagnostics;
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

    internal AiOptions Settings => options.Value;
    public string Provider => oneShot.Name;
    public string ModelFor(string requestedModel) => F.Model?.Trim() ?? "";

    private bool Native => F.Wire?.Equals("ollama", StringComparison.OrdinalIgnoreCase) == true;

    public async IAsyncEnumerable<AiChatEvent> StreamAsync(AiChatRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        if (request.Turns.SelectMany(t => t.Blocks).Any(b => b is AiPdf || b is AiImage && !F.SupportsImages))
            throw new AppException(422, "AI_ATTACHMENT_UNSUPPORTED", "This text model cannot read image or PDF attachments. Attach extracted text instead.");
        var body = Native ? BuildOllama(request, new()) : Build(request);
        if (body.ToJsonString().Length > F.MaxPromptChars)
            throw new AppException(422, "AI_CONTEXT_OVERFLOW", "This request exceeds the local model's context budget. Narrow the question or start a new conversation.");
        var queueTimer = Stopwatch.StartNew();
        using var admissionCancellation = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var admission = oneShot.Gate.EnterAsync(admissionCancellation.Token);
        IDisposable? lease = null;
        try
        {
            if (!admission.IsCompleted) yield return new AiInferenceState("queued", oneShot.Gate.QueueTimeoutSeconds);
            lease = await admission;
            var queueMs = queueTimer.Elapsed.TotalMilliseconds;
            yield return new AiInferenceState("running");
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(F.TimeoutSeconds, 1, 600)));
            await using var events = (Native ? StreamOllamaAsync(request, deadline.Token) : StreamOpenAiAsync(request, deadline.Token)).GetAsyncEnumerator(deadline.Token);
            while (true)
            {
                bool more;
                try { more = await events.MoveNextAsync(); }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                { throw new AppException(504, "AI_TIMEOUT", "The local model exceeded its response deadline. Try a narrower question."); }
                if (!more) yield break;
                yield return events.Current is AiTurnEnd end ? end with { Runtime = end.Runtime is { } runtime ? runtime with { QueueMs = queueMs } : new AiRuntimeTiming(null, null, null, null, null, queueMs) } : events.Current;
            }
        }
        finally
        {
            admissionCancellation.Cancel();
            if (lease is not null) lease.Dispose();
            else
            {
                // A client can stop immediately after the queued event, including just as a slot becomes available.
                try { (await admission).Dispose(); }
                catch (OperationCanceledException) { }
                catch (AppException) { }
            }
        }
    }

    // ------------------------------------------------------------------ OpenAI chat-completions wire format

    private async IAsyncEnumerable<AiChatEvent> StreamOpenAiAsync(AiChatRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        if (!Configured) throw new ConflictException("The AI assistant is not set up on this installation.", "AI_NOT_CONFIGURED");
        var body = Build(request);
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{F.BaseUrl!.Trim().TrimEnd('/')}/chat/completions")
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        if (!string.IsNullOrWhiteSpace(F.ApiKey)) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", F.ApiKey.Trim());

        using var res = await SendAsync(req, ct);
        var textAcc = new StringBuilder();
        var tools = new SortedDictionary<int, ToolAcc>();
        string stop = "end_turn";
        int input = 0, output = 0;
        var sawAnyChunk = false;
        var finished = false;

        await using var stream = await res.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream);
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (line.Length == 0 || !line.StartsWith("data:", StringComparison.Ordinal)) continue;
            var payload = line["data:".Length..].Trim();
            if (payload == "[DONE]") { finished = true; continue; }
            if (payload == "") continue;
            JsonNode? json;
            try { json = JsonNode.Parse(payload); } catch (JsonException) { throw new AppException(502, "AI_MALFORMED_RESPONSE", "The model returned invalid streaming data."); }   // a malformed keep-alive line; nothing useful to read
            sawAnyChunk = true;
            if (json?["error"] is not null) throw new AppException(502, "AI_MODEL_ERROR", "The model reported an inference error.");

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
                if (textAcc.Length > 64000) throw new AppException(502, "AI_RESPONSE_LIMIT", "The model exceeded its response size limit.");
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
                    if (tools.Count > 64 || acc.Arguments.Length > 16000) throw new AppException(502, "AI_RESPONSE_LIMIT", "The model exceeded its tool response limits.");
                }
            }
            if (choice?["finish_reason"]?.GetValue<string>() is { Length: > 0 } fr)
            { finished = true; stop = fr switch { "tool_calls" => "tool_use", "length" => "max_tokens", "stop" => "end_turn", _ => fr }; }
        }
        if (!sawAnyChunk) throw AiFailure.NoAnswer(oneShot.Name, null);
        if (!finished) throw new AppException(502, "AI_INCOMPLETE_RESPONSE", "The model connection closed before the answer completed.");

        var assistant = new List<AiBlock>();
        if (textAcc.Length > 0) assistant.Add(new AiText(textAcc.ToString()));
        foreach (var t in tools.Values) assistant.Add(new AiToolUse(t.Id ?? Guid.NewGuid().ToString("N")[..12], t.Name ?? "", t.Arguments.Length == 0 ? "{}" : t.Arguments.ToString()));
        if (tools.Count > 0 && stop == "end_turn") stop = "tool_use";   // some servers send tool_calls without ever setting finish_reason
        log.LogDebug("{Name} turn on {Model}: {Stop}, {In} in / {Out} out", oneShot.Name, request.Model, stop, input, output);
        yield return new AiTurnEnd(assistant, stop, input, output, Model: oneShot.Model, Provider: oneShot.Name);
    }

    private sealed class ToolAcc { public string? Id, Name; public StringBuilder Arguments = new(); }

    // ------------------------------------------------------------------ Ollama's own native wire format (POST {BaseUrl}/api/chat)

    private async IAsyncEnumerable<AiChatEvent> StreamOllamaAsync(AiChatRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        if (!Configured) throw new ConflictException("The AI assistant is not set up on this installation.", "AI_NOT_CONFIGURED");
        var idToName = new Dictionary<string, string>();
        var body = BuildOllama(request, idToName);
        var root = F.BaseUrl!.Trim().TrimEnd('/');
        if (root.EndsWith("/v1", StringComparison.OrdinalIgnoreCase)) root = root[..^3].TrimEnd('/');
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{root}/api/chat") { Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json") };
        if (!string.IsNullOrWhiteSpace(F.ApiKey)) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", F.ApiKey.Trim());

        using var res = await SendAsync(req, ct);
        var textAcc = new StringBuilder();
        var assistant = new List<AiBlock>();
        string stop = "end_turn";
        int input = 0, output = 0;
        var sawAnyChunk = false;
        var finished = false;
        AiRuntimeTiming? runtime = null;

        await using var stream = await res.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream);
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (line.Length == 0) continue;
            JsonNode? json;
            try { json = JsonNode.Parse(line); } catch (JsonException) { throw new AppException(502, "AI_MALFORMED_RESPONSE", "The model returned invalid streaming data."); }
            sawAnyChunk = true;
            if (json?["error"] is not null) throw new AppException(502, "AI_MODEL_ERROR", "The model reported an inference error.");

            var message = json?["message"];
            if (message?["content"] is JsonValue c && c.TryGetValue<string>(out var textDelta) && textDelta.Length > 0)
            {
                textAcc.Append(textDelta);
                if (textAcc.Length > 64000) throw new AppException(502, "AI_RESPONSE_LIMIT", "The model exceeded its response size limit.");
                yield return new AiTextDelta(textDelta);
            }
            if (message?["tool_calls"] is JsonArray calls)
            {
                foreach (var call in calls)
                {
                    var name = call?["function"]?["name"]?.GetValue<string>() ?? "";
                    var args = call?["function"]?["arguments"];
                    var id = $"{name}|{Guid.NewGuid():N}";
                    idToName[id] = name;
                    var arguments = args is null ? "{}" : args.ToJsonString();
                    if (assistant.Count > 64 || arguments.Length > 16000) throw new AppException(502, "AI_RESPONSE_LIMIT", "The model exceeded its tool response limits.");
                    assistant.Add(new AiToolUse(id, name, arguments));
                }
            }
            if (json?["done"]?.GetValue<bool>() == true)
            {
                finished = true;
                double? Milliseconds(string key) => json[key] is JsonValue value && value.TryGetValue<long>(out var ns) && ns >= 0 ? ns / 1_000_000d : null;
                runtime = new AiRuntimeTiming(Milliseconds("load_duration"), Milliseconds("prompt_eval_duration"), Milliseconds("eval_duration"), Milliseconds("total_duration"),
                    json["prompt_eval_cached_count"] is JsonValue cached && cached.TryGetValue<int>(out var cachedCount) && cachedCount >= 0 ? cachedCount : null);
                input = json["prompt_eval_count"]?.GetValue<int>() ?? input;
                output = json["eval_count"]?.GetValue<int>() ?? output;
                stop = json["done_reason"]?.GetValue<string>() switch { "length" => "max_tokens", _ => "end_turn" };
            }
        }
        if (!sawAnyChunk) throw AiFailure.NoAnswer(oneShot.Name, null);
        if (!finished) throw new AppException(502, "AI_INCOMPLETE_RESPONSE", "The model connection closed before the answer completed.");

        if (textAcc.Length > 0) assistant.Insert(0, new AiText(textAcc.ToString()));
        if (assistant.OfType<AiToolUse>().Any()) stop = "tool_use";
        log.LogDebug("{Name} turn on {Model} (native): {Stop}, {In} in / {Out} out", oneShot.Name, request.Model, stop, input, output);
        yield return new AiTurnEnd(assistant, stop, input, output, Model: oneShot.Model, Provider: oneShot.Name, Runtime: runtime);
    }

    private async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        HttpResponseMessage res;
        try { res = await http.CreateClient("ai-backup-stream").SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct); }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            log.LogWarning(ex, "The local model ({Name}) could not be reached", oneShot.Name);
            throw AiFailure.Unreachable(oneShot.Name, ex);
        }
        if (!res.IsSuccessStatusCode)
        {
            var text = await res.Content.ReadAsStringAsync(ct);
            log.LogWarning("The local model ({Name}) answered {Status}", oneShot.Name, (int)res.StatusCode);
            res.Dispose();
            throw AiFailure.For(oneShot.Name, res.StatusCode, text);
        }
        return res;
    }

    private JsonObject BuildOllama(AiChatRequest r, Dictionary<string, string> idToName)
    {
        var messages = new JsonArray { new JsonObject { ["role"] = "system", ["content"] = string.IsNullOrWhiteSpace(r.Context) ? r.System : $"{r.System}\n\n{r.Context}" } };
        foreach (var turn in r.Turns) AppendOllamaTurn(messages, turn, idToName);
        // think:false works correctly on the native route (unlike /v1/chat/completions, which silently drops it) - this provider never
        // reads a reasoning trace back out regardless, so it is always off.
        var body = new JsonObject { ["model"] = oneShot.Model, ["stream"] = true, ["think"] = false, ["messages"] = messages };
        if (r.Tools.Count > 0) body["tools"] = new JsonArray(r.Tools.Select(ToTool).ToArray());
        var o = new JsonObject { ["num_predict"] = Math.Clamp(r.MaxTokens, 1, F.MaxOutputTokens) };
        body["keep_alive"] = F.KeepAlive;
        if (F.NumCtx is { } c) o["num_ctx"] = c;
        if (F.NumThread is { } t) o["num_thread"] = t;
        body["options"] = o;
        return body;
    }

    /// <summary>
    /// Same shape as <see cref="AppendTurn"/> for the OpenAI wire format, with three native differences: a tool result is matched back by
    /// name (<c>tool_name</c>), not an id the native API has no notion of - <paramref name="idToName"/> is filled in as each AiToolUse is
    /// seen, from whichever provider originally produced it, so a tool called earlier in the conversation by Claude still resolves
    /// correctly here. A tool call's arguments are a JSON object, not a JSON-encoded string. An image is its own "images" array of bare
    /// base64, not an inline content part.
    /// </summary>
    private static void AppendOllamaTurn(JsonArray messages, AiTurn turn, Dictionary<string, string> idToName)
    {
        var results = turn.Blocks.OfType<AiToolResult>().ToList();
        if (results.Count > 0)
        {
            foreach (var tr in results) messages.Add(new JsonObject { ["role"] = "tool", ["tool_name"] = idToName.GetValueOrDefault(tr.ToolUseId, tr.ToolUseId), ["content"] = tr.Content });
            return;
        }

        var role = turn.Role == "assistant" ? "assistant" : "user";
        var text = new StringBuilder();
        var images = new JsonArray();
        foreach (var b in turn.Blocks)
        {
            switch (b)
            {
                case AiText t: text.Append(t.Text); break;
                case AiImage im: images.Add(Convert.ToBase64String(im.Data)); break;
                case AiPdf pdf: text.Append($"\n[Attachment “{pdf.Name}” omitted: this model only reads text and images.]"); break;
            }
        }
        var toolCalls = turn.Blocks.OfType<AiToolUse>().ToList();
        foreach (var tu in toolCalls) idToName[tu.Id] = tu.Name;
        var msg = new JsonObject { ["role"] = role, ["content"] = text.ToString() };
        if (images.Count > 0) msg["images"] = images;
        if (toolCalls.Count > 0)
            msg["tool_calls"] = new JsonArray(toolCalls.Select(tu => (JsonNode)new JsonObject
            {
                ["function"] = new JsonObject { ["name"] = tu.Name, ["arguments"] = string.IsNullOrWhiteSpace(tu.InputJson) ? new JsonObject() : JsonNode.Parse(tu.InputJson) },
            }).ToArray());
        messages.Add(msg);
    }

    // ------------------------------------------------------------------ request building (OpenAI wire format)

    private JsonObject Build(AiChatRequest r)
    {
        var tokens = Math.Clamp(r.MaxTokens + Math.Max(0, F.ThinkingTokens), 1, F.MaxOutputTokens);
        var messages = new JsonArray { new JsonObject { ["role"] = "system", ["content"] = string.IsNullOrWhiteSpace(r.Context) ? r.System : $"{r.System}\n\n{r.Context}" } };
        foreach (var turn in r.Turns) AppendTurn(messages, turn);
        // r.Model is whichever Claude model the tier router picked (e.g. "claude-haiku-4-5") - meaningless to this provider, which has
        // its own configured model regardless of which Claude tier the person's question was routed to.
        // think / reasoning_effort: tried both, live, against a real Ollama server - neither changed the "<model> does not support
        // thinking" 400 at all, including a request with NEITHER field present. So that 400 is not actually about a thinking-control
        // field's presence or value; something else in the request body is tripping it. stream_options is the next suspect: a newer
        // OpenAI field (added after the core chat-completions spec) that less mature compat layers are known to mishandle. Left out
        // entirely for now - token-accounting (InputTokens/OutputTokens) just defaults to 0 without it, already handled below.
        var body = new JsonObject { ["model"] = oneShot.Model, ["stream"] = true, ["max_tokens"] = tokens, ["messages"] = messages };
        // An administrator's own explicit choice is still sent if set; nothing is added by default any more (see note above).
        if (!string.IsNullOrWhiteSpace(F.ReasoningEffort)) body["reasoning_effort"] = F.ReasoningEffort.Trim();
        if (r.Tools.Count > 0) body["tools"] = new JsonArray(r.Tools.Select(ToTool).ToArray());
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

    public bool Configured => backup.Settings.UsesAnthropic ? claude.Configured || backup.Configured : backup.Configured;
    public string Provider => backup.Settings.UsesAnthropic && claude.Configured ? "Claude (Anthropic)" : backup.Provider;
    public string ModelFor(string requestedModel) => backup.Settings.UsesAnthropic && claude.Configured ? requestedModel : backup.ModelFor(requestedModel);

    public Task<string> CompleteAsync(string model, string system, string user, int maxTokens, CancellationToken ct) =>
        backup.Settings.UsesAnthropic && claude.Configured ? claude.CompleteAsync(model, system, user, maxTokens, ct) : backup.CompleteAsync(model, system, user, maxTokens, ct);

    public async IAsyncEnumerable<AiChatEvent> StreamAsync(AiChatRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        if (!Configured) throw new ConflictException("The AI assistant is not set up on this installation.", "AI_NOT_CONFIGURED");
        var useClaude = backup.Settings.UsesAnthropic && claude.Configured && (!backup.Configured || DateTime.UtcNow.Ticks >= Interlocked.Read(ref _claudeRestsUntil));
        if (useClaude)
        {
            // Claude is asked first, one turn at a time; if the very first thing it returns is a failure (not configured, no credit, a
            // network error...) nothing has reached the person yet, so switching to the backup here is still invisible to them. A failure
            // after that point - mid-stream - is rare and is simply let through, rather than silently restarting the answer on another model.
            await using var events = claude.StreamAsync(request, ct).GetAsyncEnumerator(ct);
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
