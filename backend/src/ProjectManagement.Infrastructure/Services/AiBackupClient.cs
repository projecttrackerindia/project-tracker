using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Infrastructure.Services;

/// <summary>
/// The backup model. Google Gemini addresses (generativelanguage.googleapis.com) use Google's own generateContent API with the key in
/// x-goog-api-key, the way AI Studio documents its keys - including the newer AQ.… ones. Any other address is taken to speak the OpenAI
/// chat-completions API (POST {BaseUrl}/chat/completions with a bearer key): Groq, OpenRouter, Mistral, a self-hosted Ollama. Nothing is
/// called unless <c>Ai:Fallback:BaseUrl</c> and <c>Model</c> are set.
/// </summary>
public class OpenAiCompatibleClient(IHttpClientFactory http, IOptions<AiOptions> options, ILogger<OpenAiCompatibleClient> log, AiInferenceGate? gate = null)
{
    private AiFallbackOptions F => options.Value.Fallback;
    internal AiOptions Settings => options.Value;
    internal AiInferenceGate Gate { get; } = gate ?? new AiInferenceGate(options);
    public bool Configured => !string.IsNullOrWhiteSpace(F.BaseUrl) && !string.IsNullOrWhiteSpace(F.Model);
    public string Model => F.Model?.Trim() ?? "";
    public string Name => !string.IsNullOrWhiteSpace(F.Name) ? F.Name.Trim() : NameFor(F.BaseUrl);
    public bool UsesGeminiApi => Uri.TryCreate(F.BaseUrl?.Trim(), UriKind.Absolute, out var u) && u.Host.Equals("generativelanguage.googleapis.com", StringComparison.OrdinalIgnoreCase);

    /// <summary>A name people recognise for the privacy notes, from the provider's address.</summary>
    public static string NameFor(string? baseUrl)
    {
        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var u)) return "the backup model";
        var h = u.Host.ToLowerInvariant();
        bool Is(string domain) => h == domain || h.EndsWith("." + domain, StringComparison.Ordinal);
        return Is("googleapis.com") ? "Google Gemini"
            : Is("groq.com") ? "Groq"
            : Is("openrouter.ai") ? "OpenRouter"
            : Is("mistral.ai") ? "Mistral"
            : Is("openai.com") ? "OpenAI"
            : h is "localhost" or "127.0.0.1" || u.IsLoopback || !h.Contains('.') ? "a model on your own server"
            : h;
    }

    public async Task<string> CompleteAsync(string system, string user, int maxTokens, CancellationToken ct)
    {
        if (!Configured) throw new ConflictException("The AI assistant is not set up on this installation.", "AI_NOT_CONFIGURED");
        using var lease = await Gate.EnterAsync(ct);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(F.TimeoutSeconds, 1, 600)));
        var token = deadline.Token;
        if (system.Length + user.Length > F.MaxPromptChars)
            throw new AppException(422, "AI_CONTEXT_OVERFLOW", "This request exceeds the local model's context budget. Narrow the question or start a new conversation.");
        // Models that think before answering count the thinking against the same limit, so they get room for it on top.
        var tokens = Math.Clamp(maxTokens + Math.Max(0, F.ThinkingTokens), 1, F.MaxOutputTokens);
        var gemini = UsesGeminiApi;
        using var req = gemini ? GeminiRequest(system, user, tokens) : F.Wire?.Equals("ollama", StringComparison.OrdinalIgnoreCase) == true ? OllamaRequest(system, user, tokens) : ChatRequest(system, user, tokens);

        HttpResponseMessage res;
        try { res = await http.CreateClient("ai-backup").SendAsync(req, token); }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            log.LogWarning(ex, "The backup model ({Name}) could not be reached", Name);
            if (ex is TaskCanceledException && deadline.IsCancellationRequested)
                throw new AiProviderException(504, "AI_TIMEOUT", Name, "exceeded its configured response deadline");
            throw AiFailure.Unreachable(Name, ex);
        }
        using (res)
        {
            var text = await res.Content.ReadAsStringAsync(token);
            if (!res.IsSuccessStatusCode)
            {
                log.LogWarning("The backup model ({Name}) answered {Status}", Name, (int)res.StatusCode);
                throw AiFailure.For(Name, res.StatusCode, text);
            }
            JsonNode? json;
            try { json = JsonNode.Parse(text); } catch (JsonException) { json = null; }
            var (content, finish) = gemini ? GeminiAnswer(json) : F.Wire?.Equals("ollama", StringComparison.OrdinalIgnoreCase) == true ? (json?["message"]?["content"]?.GetValue<string>(), json?["done_reason"]?.ToString()) : ChatAnswer(json);
            if (string.IsNullOrWhiteSpace(content))
            {
                log.LogWarning("The backup model ({Name}) gave no answer (finish reason {Reason})", Name, finish);
                throw AiFailure.NoAnswer(Name, finish);
            }
            return content.Trim();
        }
    }

    // ------------------------------------------------------------------ OpenAI chat completions

    private HttpRequestMessage OllamaRequest(string system, string user, int tokens)
    {
        var root = F.BaseUrl!.Trim().TrimEnd('/');
        if (root.EndsWith("/v1", StringComparison.OrdinalIgnoreCase)) root = root[..^3];
        var settings = new JsonObject { ["num_predict"] = tokens };
        if (F.NumCtx is { } context) settings["num_ctx"] = context;
        if (F.NumThread is { } threads) settings["num_thread"] = threads;
        var body = new JsonObject { ["model"] = Model, ["stream"] = false, ["think"] = false, ["keep_alive"] = F.KeepAlive,
            ["options"] = settings, ["messages"] = new JsonArray(new JsonObject { ["role"] = "system", ["content"] = system }, new JsonObject { ["role"] = "user", ["content"] = user }) };
        var req = new HttpRequestMessage(HttpMethod.Post, $"{root}/api/chat") { Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json") };
        if (!string.IsNullOrWhiteSpace(F.ApiKey)) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", F.ApiKey.Trim());
        return req;
    }

    private HttpRequestMessage ChatRequest(string system, string user, int tokens)
    {
        var body = new JsonObject
        {
            ["model"] = Model,
            ["max_tokens"] = tokens,
            ["messages"] = new JsonArray(
                new JsonObject { ["role"] = "system", ["content"] = system },
                new JsonObject { ["role"] = "user", ["content"] = user }),
        };
        if (!string.IsNullOrWhiteSpace(F.ReasoningEffort)) body["reasoning_effort"] = F.ReasoningEffort.Trim();
        var req = new HttpRequestMessage(HttpMethod.Post, $"{F.BaseUrl!.Trim().TrimEnd('/')}/chat/completions")
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        if (!string.IsNullOrWhiteSpace(F.ApiKey)) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", F.ApiKey.Trim());
        return req;
    }

    private static (string? Text, string? Finish) ChatAnswer(JsonNode? json)
    {
        var choice = json?["choices"]?[0];
        var text = choice?["message"]?["content"] switch
        {
            JsonValue v when v.TryGetValue<string>(out var s) => s,
            // A few providers answer with content parts, like the newer OpenAI format.
            JsonArray parts => string.Concat(parts.Select(p => p?["text"]?.GetValue<string>() ?? "")),
            _ => null,
        };
        return (text, choice?["finish_reason"]?.ToString());
    }

    // ------------------------------------------------------------------ Google's generateContent

    private HttpRequestMessage GeminiRequest(string system, string user, int tokens)
    {
        // The version from the configured address (".../v1beta/openai" or ".../v1beta"), the model without a "models/" prefix.
        var u = new Uri(F.BaseUrl!.Trim());
        var version = u.Segments.Select(s => s.Trim('/')).FirstOrDefault(s => s.StartsWith("v1", StringComparison.Ordinal)) ?? "v1beta";
        var model = Model.StartsWith("models/", StringComparison.OrdinalIgnoreCase) ? Model["models/".Length..] : Model;
        var generation = new JsonObject { ["maxOutputTokens"] = tokens };
        if (!string.IsNullOrWhiteSpace(F.ReasoningEffort))
        {
            var effort = F.ReasoningEffort.Trim().ToLowerInvariant();
            // Gemini 2.x takes a thinking budget in tokens; later models a level.
            generation["thinkingConfig"] = model.StartsWith("gemini-2", StringComparison.OrdinalIgnoreCase)
                ? new JsonObject { ["thinkingBudget"] = effort switch { "none" or "minimal" => 0, "low" => 1024, "medium" => 8192, _ => 24576 } }
                : new JsonObject { ["thinkingLevel"] = effort };
        }
        var body = new JsonObject
        {
            ["systemInstruction"] = new JsonObject { ["parts"] = new JsonArray(new JsonObject { ["text"] = system }) },
            ["contents"] = new JsonArray(new JsonObject { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = user }) }),
            ["generationConfig"] = generation,
        };
        var req = new HttpRequestMessage(HttpMethod.Post, $"{u.Scheme}://{u.Authority}/{version}/models/{Uri.EscapeDataString(model)}:generateContent")
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        if (!string.IsNullOrWhiteSpace(F.ApiKey)) req.Headers.Add("x-goog-api-key", F.ApiKey.Trim());
        return req;
    }

    private static (string? Text, string? Finish) GeminiAnswer(JsonNode? json)
    {
        var candidate = json?["candidates"]?[0];
        // Thought summaries, when a model returns them, are not part of the answer.
        var text = string.Concat((candidate?["content"]?["parts"] as JsonArray ?? [])
            .Where(p => !(p?["thought"] is JsonValue t && t.TryGetValue<bool>(out var thought) && thought))
            .Select(p => p?["text"] is JsonValue v && v.TryGetValue<string>(out var s) ? s : ""));
        return (text, candidate?["finishReason"]?.ToString() ?? json?["promptFeedback"]?["blockReason"]?.ToString());
    }
}

/// <summary>
/// The assistant's model: Claude, and the backup when Claude cannot answer - or the backup alone when no Anthropic key is set. A setting
/// that is wrong (no credit, a refused key, an unknown model) does not mend itself in seconds, so after one the backup answers straight
/// away for a while. When both fail, the person hears both reasons.
/// </summary>
public sealed class AiRouter(AnthropicClient claude, OpenAiCompatibleClient backup, ILogger<AiRouter> log, GeminiChat? gemini = null) : IAiClient
{
    private static readonly TimeSpan Rest = TimeSpan.FromMinutes(15);
    private long _claudeRestsUntil;   // UTC ticks
    private AiProviderException? _claudeFailure;

    public bool Configured => backup.Settings.UsesGemini ? gemini?.Configured == true : backup.Settings.UsesAnthropic ? claude.Configured || backup.Configured : backup.Configured;
    public string Model => backup.Settings.UsesGemini ? gemini?.ModelFor("") ?? "" : backup.Settings.UsesAnthropic && claude.Configured ? claude.Model : backup.Model;
    public string? Provider => backup.Settings.UsesGemini ? "Google Gemini" : backup.Settings.UsesAnthropic && claude.Configured ? "Claude (Anthropic)" : backup.Configured ? backup.Name : null;
    public string? Backup => backup.Settings.UsesAnthropic && claude.Configured && backup.Configured ? backup.Name : null;

    public async Task<AiAnswer> CompleteAsync(string system, string user, int maxTokens, CancellationToken ct)
    {
        if (!Configured) throw new ConflictException("The AI assistant is not set up on this installation.", "AI_NOT_CONFIGURED");
        if (backup.Settings.UsesGemini)
            return new AiAnswer(await gemini!.CompleteAsync(Model, system, user, maxTokens, ct), Model);
        AiProviderException? claudeFailed = null;
        if (backup.Settings.UsesAnthropic && claude.Configured)
        {
            if (!backup.Configured || DateTime.UtcNow.Ticks >= Interlocked.Read(ref _claudeRestsUntil))
            {
                try { return new AiAnswer(await claude.CompleteAsync(system, user, maxTokens, ct), claude.Model); }
                catch (AiProviderException ex) when (backup.Configured)
                {
                    claudeFailed = _claudeFailure = ex;
                    if (AiProviderException.NeedsAdmin(ex.Code)) Interlocked.Exchange(ref _claudeRestsUntil, (DateTime.UtcNow + Rest).Ticks);
                    log.LogWarning("Claude could not answer ({Code}); asking the backup model ({Backup})", ex.Code, backup.Name);
                }
            }
            else claudeFailed = _claudeFailure;   // resting after a failure that needs an administrator
        }
        try { return new AiAnswer(await backup.CompleteAsync(system, user, maxTokens, ct), backup.Model); }
        catch (AiProviderException b) when (claudeFailed is not null)
        {
            var advice = AiProviderException.AdviceFor(AiProviderException.NeedsAdmin(claudeFailed.Code) && !AiProviderException.NeedsAdmin(b.Code) ? claudeFailed.Code : b.Code);
            var detail = string.Join("; ", new[] { claudeFailed.Detail is { } c ? $"{claudeFailed.Who}: {c}" : null, b.Detail is { } d ? $"{b.Who}: {d}" : null }.Where(x => x is not null));
            throw new AiProviderException(b.StatusCode, b.Code, b.Who, b.Reason, detail.Length > 0 ? detail : null,
                $"{claudeFailed.Who} {claudeFailed.Reason} and the backup ({b.Who}) {b.Reason}. {advice}");
        }
    }
}
