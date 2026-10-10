using System.Net;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;
using StackExchange.Redis;

namespace ProjectManagement.Infrastructure.Services;

public sealed record GeminiAdmissionReceipt(string CapacityKey, string ReceiptKey);

/// <summary>Shared, fail-closed admission. Completed usage reconciles conservative reservations; uncertain failures retain them.</summary>
public class GeminiAdmission(IOptions<AiOptions> options, IConnectionMultiplexer? redis = null, ILogger<GeminiAdmission>? logger = null)
{
    private const string Script = """
        local now = tonumber(redis.call('TIME')[1])
        local minute = math.floor(now / 60)
        local day = math.floor(now / 86400)
        if tonumber(redis.call('HGET', KEYS[1], 'minute') or '-1') ~= minute then
            redis.call('HSET', KEYS[1], 'minute', minute, 'requests', 0, 'tokens', 0)
        end
        if tonumber(redis.call('HGET', KEYS[1], 'day') or '-1') ~= day then
            redis.call('HSET', KEYS[1], 'day', day, 'daily', 0)
        end
        if tonumber(redis.call('HGET', KEYS[1], 'requests') or '0') + 1 > tonumber(ARGV[1]) or
           tonumber(redis.call('HGET', KEYS[1], 'tokens') or '0') + tonumber(ARGV[4]) > tonumber(ARGV[2]) then
            return 1
        end
        if tonumber(redis.call('HGET', KEYS[1], 'daily') or '0') + 1 > tonumber(ARGV[3]) then return 2 end
        if tonumber(redis.call('HGET', KEYS[1], 'pilotIn') or '0') + tonumber(ARGV[4]) > tonumber(ARGV[6]) or
           tonumber(redis.call('HGET', KEYS[1], 'pilotOut') or '0') + tonumber(ARGV[5]) > tonumber(ARGV[7]) then return 3 end
        redis.call('HINCRBY', KEYS[1], 'requests', 1)
        redis.call('HINCRBY', KEYS[1], 'tokens', ARGV[4])
        redis.call('HINCRBY', KEYS[1], 'daily', 1)
        redis.call('HINCRBY', KEYS[1], 'pilotIn', ARGV[4])
        redis.call('HINCRBY', KEYS[1], 'pilotOut', ARGV[5])
        redis.call('HSET', KEYS[2], 'input', ARGV[4], 'output', ARGV[5], 'minute', minute, 'settled', 0)
        redis.call('EXPIRE', KEYS[2], 86400)
        return 0
        """;

    private const string ReconcileScript = """
        if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[2]) == 0 then return 0 end
        if tonumber(redis.call('HGET', KEYS[2], 'settled') or '1') ~= 0 then return 0 end
        local inputDelta = tonumber(ARGV[1]) - tonumber(redis.call('HGET', KEYS[2], 'input'))
        local outputDelta = tonumber(ARGV[2]) - tonumber(redis.call('HGET', KEYS[2], 'output'))
        redis.call('HINCRBY', KEYS[1], 'pilotIn', inputDelta)
        redis.call('HINCRBY', KEYS[1], 'pilotOut', outputDelta)
        if redis.call('HGET', KEYS[1], 'minute') == redis.call('HGET', KEYS[2], 'minute') then
            redis.call('HINCRBY', KEYS[1], 'tokens', inputDelta)
        end
        redis.call('HSET', KEYS[2], 'settled', 1, 'actualInput', ARGV[1], 'actualOutput', ARGV[2])
        return 1
        """;

    public virtual async Task<GeminiAdmissionReceipt> ReserveAsync(int inputEstimate, int maxOutput, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (redis is null) throw new AppException(503, "AI_LIMIT_STORE_UNAVAILABLE", "Gemini needs shared capacity controls before it can answer.");
        var o = options.Value.Gemini;
        var receipt = new GeminiAdmissionReceipt($"pm:gemini:{{{o.ProjectId}}}:pilot:v1", $"pm:gemini:{{{o.ProjectId}}}:usage:{Guid.NewGuid():N}");
        int result;
        try
        {
            result = (int)await redis.GetDatabase().ScriptEvaluateAsync(Script,
                [receipt.CapacityKey, receipt.ReceiptKey],
                [o.RequestsPerMinute, o.InputTokensPerMinute, o.RequestsPerDay, inputEstimate, maxOutput,
                    o.PilotInputTokenAllowance, o.PilotOutputTokenAllowance]).WaitAsync(ct);
        }
        catch (RedisException) { throw new AppException(503, "AI_LIMIT_STORE_UNAVAILABLE", "The assistant's shared capacity controls are unavailable."); }
        if (result != 0) throw new AiRequestLimitException(result == 3 ? "AI_PILOT_BUDGET" : "AI_PROVIDER_LIMIT", result == 1 ? 60 : 3600,
            result == 3 ? "The Gemini pilot allowance has been reached. An administrator needs to review usage."
            : "The shared AI request allowance has been reached. Please try again later.");
        return receipt;
    }

    public virtual async Task ReconcileAsync(GeminiAdmissionReceipt receipt, int actualInput, int actualOutput)
    {
        if (redis is null || string.IsNullOrEmpty(receipt.ReceiptKey)) return;
        if (actualInput < 0 || actualOutput < 0) throw new ArgumentOutOfRangeException(nameof(actualInput));
        try
        {
            await redis.GetDatabase().ScriptEvaluateAsync(ReconcileScript, [receipt.CapacityKey, receipt.ReceiptKey], [actualInput, actualOutput])
                .WaitAsync(TimeSpan.FromSeconds(2));
        }
        catch (Exception ex) when (ex is RedisException or TimeoutException)
        {
            // Keep the pessimistic hold; accounting availability must not destroy a completed answer.
            logger?.LogWarning("Gemini usage reconciliation was unavailable; its conservative reservation was retained.");
        }
    }
}

/// <summary>A connection failure or HTTP server rejection before any response content. Safe for bounded local fallback.</summary>
public sealed class GeminiUnavailableException(string code, string message) : AppException(502, code, message);

/// <summary>Native Gemini SSE. No automatic retries or provider switching after response content.</summary>
public sealed class GeminiChat(IHttpClientFactory http, IOptions<AiOptions> options, GeminiAdmission admission) : IAiChat
{
    private AiGeminiOptions G => options.Value.Gemini;
    public bool Configured => options.Value.UsesGemini && !string.IsNullOrWhiteSpace(G.ApiKey);
    public string Provider => "Google Gemini";
    public string ModelFor(string requestedModel) => G.Model;

    public async Task<string> CompleteAsync(string model, string system, string user, int maxTokens, CancellationToken ct)
    {
        var text = new StringBuilder();
        await foreach (var e in StreamAsync(new(model, system, "", [AiTurn.User(user)], [], maxTokens, null, false), ct))
            if (e is AiTextDelta t) text.Append(t.Text);
        return text.Length > 0 ? text.ToString() : throw new AppException(502, "AI_NO_ANSWER", "Gemini returned no answer.");
    }

    public async IAsyncEnumerable<AiChatEvent> StreamAsync(AiChatRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        if (!Configured) throw new ConflictException("Gemini is not enabled on this installation.", "AI_NOT_CONFIGURED");
        var outputLimit = Math.Clamp(request.MaxTokens, 1, G.MaxOutputTokens);
        var body = Build(request, outputLimit).ToJsonString();
        var bytes = Encoding.UTF8.GetByteCount(body);
        if (bytes > G.MaxPromptBytes) throw new AppException(422, "AI_CONTEXT_OVERFLOW", "This question exceeds the assistant's context budget. Narrow it or start a new conversation.");
        // Bytes plus overhead are deliberately pessimistic. This is admission accounting, not exact provider token billing.
        var receipt = await admission.ReserveAsync(bytes + 4096, outputLimit, ct);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(G.TimeoutSeconds));
        await using var events = ReadAsync(body, request, deadline.Token).GetAsyncEnumerator(deadline.Token);
        while (true)
        {
            bool more;
            try { more = await events.MoveNextAsync(); }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            { throw new AppException(504, "AI_TIMEOUT", "Gemini exceeded its response deadline. Completed actions remain available."); }
            if (!more) yield break;
            if (events.Current is AiTurnEnd { UsageKnown: true } completed)
                await admission.ReconcileAsync(receipt, checked(completed.InputTokens + completed.CacheReadTokens), completed.OutputTokens);
            yield return events.Current;
        }
    }

    private async IAsyncEnumerable<AiChatEvent> ReadAsync(string body, AiChatRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post,
            $"https://generativelanguage.googleapis.com/v1beta/models/{Uri.EscapeDataString(G.Model)}:streamGenerateContent?alt=sse")
        { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        req.Headers.Add("x-goog-api-key", G.ApiKey!.Trim());
        HttpResponseMessage response;
        try { response = await http.CreateClient("ai-gemini").SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct); }
        catch (HttpRequestException) { throw new GeminiUnavailableException("AI_UNREACHABLE", "Gemini could not be reached. Please try again later."); }
        using var res = response;
        if ((int)res.StatusCode >= 500)
            throw new GeminiUnavailableException("AI_PROVIDER_ERROR", "Gemini is temporarily unavailable.");
        if (res.StatusCode == HttpStatusCode.TooManyRequests)
            throw new AiRequestLimitException("AI_PROVIDER_LIMIT", 60, "Gemini's capacity limit was reached. Please try again shortly.");
        if (!res.IsSuccessStatusCode)
            throw new AppException(res.StatusCode == HttpStatusCode.TooManyRequests ? 429 : 502,
                res.StatusCode == HttpStatusCode.TooManyRequests ? "AI_PROVIDER_LIMIT" : "AI_PROVIDER_ERROR",
                res.StatusCode == HttpStatusCode.TooManyRequests ? "Gemini's capacity limit was reached. Please try again shortly."
                : "Gemini could not answer. An administrator can check its configuration and billing.");
        yield return new AiInferenceState("running");
        await using var stream = await res.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream);
        var assistant = new List<AiBlock>();
        var toolNames = request.Tools.Select(t => t.Name).ToHashSet(StringComparer.Ordinal);
        int input = 0, output = 0, cached = 0, responseBytes = 0, tools = 0;
        var usageKnown = false;
        string? finish = null;
        var data = new StringBuilder();
        while (true)
        {
            var line = await reader.ReadLineAsync(ct);
            if (line is not null && line.StartsWith("data:", StringComparison.Ordinal))
            {
                data.AppendLine(line[5..].TrimStart());
                if (data.Length > 1000000) throw Bad("AI_RESPONSE_LIMIT");
                continue;
            }
            if (line is not null && line.Length != 0) continue;
            if (data.Length > 0)
            {
                JsonNode json;
                try { json = JsonNode.Parse(data.ToString()) ?? throw new JsonException(); }
                catch (JsonException) { throw Bad("AI_MALFORMED_RESPONSE"); }
                data.Clear();
                if (json["error"] is not null) throw Bad("AI_PROVIDER_ERROR");
                var usage = json["usageMetadata"];
                if (usage is not null)
                {
                    usageKnown = usage["promptTokenCount"] is not null && usage["candidatesTokenCount"] is not null;
                    input = usage["promptTokenCount"]?.GetValue<int>() ?? input;
                    cached = usage["cachedContentTokenCount"]?.GetValue<int>() ?? cached;
                    output = (usage["candidatesTokenCount"]?.GetValue<int>() ?? 0) + (usage["thoughtsTokenCount"]?.GetValue<int>() ?? 0);
                }
                if (json["promptFeedback"]?["blockReason"] is not null) finish = "SAFETY";
                var candidate = json["candidates"] is JsonArray { Count: > 0 } candidates ? candidates[0] : null;
                if (candidate?["content"]?["parts"] is JsonArray parts)
                    foreach (var part in parts)
                    {
                        if (part is null) continue;
                        var raw = part.ToJsonString();
                        responseBytes += Encoding.UTF8.GetByteCount(raw);
                        if (responseBytes > 1000000) throw Bad("AI_RESPONSE_LIMIT");
                        // Opaque parts retain their original order and signature. Tool blocks are execution instructions only.
                        assistant.Add(new AiGeminiPart(raw));
                        if (part["functionCall"] is { } call)
                        {
                            var name = call["name"]?.GetValue<string>() ?? "";
                            var args = call["args"] as JsonObject;
                            if (++tools > 64 || !toolNames.Contains(name) || args is null || args.ToJsonString().Length > 16000)
                                throw Bad("AI_INVALID_TOOL_CALL");
                            assistant.Add(new AiToolUse(call["id"]?.GetValue<string>() ?? Guid.NewGuid().ToString("N"), name, args.ToJsonString()));
                        }
                        else if (part["text"] is { } text)
                        {
                            var value = text.GetValue<string>();
                            if (part["thought"]?.GetValue<bool>() == true)
                            { if (request.ShowReasoning) yield return new AiThinkingDelta(value); }
                            else yield return new AiTextDelta(value);
                        }
                    }
                finish = candidate?["finishReason"]?.GetValue<string>() ?? finish;
            }
            if (line is null) break;
        }
        if (finish is null) throw Bad("AI_INCOMPLETE_RESPONSE");
        var stop = finish switch
        {
            "STOP" => tools > 0 ? "tool_use" : "end_turn",
            "MAX_TOKENS" => "max_tokens",
            "SAFETY" or "RECITATION" or "BLOCKLIST" or "PROHIBITED_CONTENT" or "SPII" => "refusal",
            _ => throw Bad("AI_PROVIDER_ERROR")
        };
        if (assistant.Count == 0 && stop == "end_turn") throw Bad("AI_NO_ANSWER");
        yield return new AiTurnEnd(assistant, stop, Math.Max(0, input - cached), output, cached, Model: G.Model, Provider: Provider, UsageKnown: usageKnown);
    }

    private static AppException Bad(string code) => new(502, code, "Gemini returned an incomplete or unsupported response. Please try a narrower question.");

    private JsonObject Build(AiChatRequest request, int maxOutput)
    {
        var contents = new JsonArray();
        var calls = new Dictionary<string, AiToolUse>();
        foreach (var turn in request.Turns)
        {
            var parts = new JsonArray();
            var opaque = turn.Blocks.OfType<AiGeminiPart>().Any();
            foreach (var block in turn.Blocks)
            {
                switch (block)
                {
                    case AiGeminiPart p: parts.Add(JsonNode.Parse(p.Json)); break;
                    case AiText t when !opaque: parts.Add(new JsonObject { ["text"] = t.Text }); break;
                    case AiToolUse t:
                        calls[t.Id] = t;
                        if (!opaque) parts.Add(new JsonObject { ["functionCall"] = new JsonObject { ["name"] = t.Name, ["args"] = JsonNode.Parse(t.InputJson) } });
                        break;
                    case AiToolResult t:
                        if (!calls.TryGetValue(t.ToolUseId, out var call)) throw Bad("AI_INVALID_TOOL_RESULT");
                        // Include provider call IDs only if Gemini supplied them; locally generated IDs are not provider IDs.
                        var result = new JsonObject { ["name"] = call.Name,
                            ["response"] = new JsonObject { [t.IsError ? "error" : "result"] = t.Content } };
                        var providerId = request.Turns.SelectMany(x => x.Blocks).OfType<AiGeminiPart>()
                            .Select(x => JsonNode.Parse(x.Json)?["functionCall"])
                            .FirstOrDefault(x => x?["id"]?.GetValue<string>() == t.ToolUseId)?["id"]?.GetValue<string>();
                        if (providerId is not null) result["id"] = providerId;
                        parts.Add(new JsonObject { ["functionResponse"] = result });
                        break;
                    case AiImage or AiPdf: throw new AppException(422, "AI_ATTACHMENT_UNSUPPORTED", "The Gemini pilot accepts extracted text attachments only.");
                }
            }
            if (parts.Count > 0) contents.Add(new JsonObject { ["role"] = turn.Role == "assistant" ? "model" : "user", ["parts"] = parts });
        }
        var body = new JsonObject
        {
            ["systemInstruction"] = new JsonObject { ["parts"] = new JsonArray(new JsonObject { ["text"] = request.System + "\n\n" + request.Context }) },
            ["contents"] = contents,
            ["generationConfig"] = new JsonObject { ["maxOutputTokens"] = maxOutput }
        };
        if (request.Tools.Count > 0) body["tools"] = new JsonArray(new JsonObject
        {
            ["functionDeclarations"] = new JsonArray(request.Tools.Select(t => (JsonNode)new JsonObject
                { ["name"] = t.Name, ["description"] = t.Description, ["parametersJsonSchema"] = JsonNode.Parse(t.SchemaJson) }).ToArray())
        });
        return body;
    }
}
