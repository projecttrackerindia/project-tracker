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
/// The backup model: any provider that speaks the OpenAI chat-completions API (POST {BaseUrl}/chat/completions with a bearer key) -
/// Google Gemini, Groq, OpenRouter, Mistral, a self-hosted Ollama. Nothing is called unless <c>Ai:Fallback:BaseUrl</c> and <c>Model</c> are set.
/// </summary>
public class OpenAiCompatibleClient(IHttpClientFactory http, IOptions<AiOptions> options, ILogger<OpenAiCompatibleClient> log)
{
    private AiFallbackOptions F => options.Value.Fallback;
    public bool Configured => !string.IsNullOrWhiteSpace(F.BaseUrl) && !string.IsNullOrWhiteSpace(F.Model);
    public string Model => F.Model?.Trim() ?? "";
    public string Name => !string.IsNullOrWhiteSpace(F.Name) ? F.Name.Trim() : NameFor(F.BaseUrl);

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
        var body = new JsonObject
        {
            ["model"] = Model,
            ["max_tokens"] = Math.Clamp(maxTokens, 64, options.Value.MaxTokens) + Math.Max(0, F.ThinkingTokens),
            ["messages"] = new JsonArray(
                new JsonObject { ["role"] = "system", ["content"] = system },
                new JsonObject { ["role"] = "user", ["content"] = user }),
        };
        if (!string.IsNullOrWhiteSpace(F.ReasoningEffort)) body["reasoning_effort"] = F.ReasoningEffort.Trim();
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{F.BaseUrl!.Trim().TrimEnd('/')}/chat/completions")
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        if (!string.IsNullOrWhiteSpace(F.ApiKey)) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", F.ApiKey.Trim());

        HttpResponseMessage res;
        try { res = await http.CreateClient("ai-backup").SendAsync(req, ct); }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            log.LogWarning(ex, "The backup model ({Name}) could not be reached", Name);
            throw new AppException(503, "AI_UNAVAILABLE", "The AI assistant could not be reached. Try again in a moment.");
        }
        using (res)
        {
            var text = await res.Content.ReadAsStringAsync(ct);
            if (!res.IsSuccessStatusCode)
            {
                log.LogWarning("The backup model ({Name}) answered {Status}: {Body}", Name, (int)res.StatusCode, text.Length > 300 ? text[..300] : text);
                throw AiFailure.For(res.StatusCode, text);
            }
            JsonNode? choice;
            try { choice = JsonNode.Parse(text)?["choices"]?[0]; } catch (JsonException) { choice = null; }
            var content = choice?["message"]?["content"] switch
            {
                JsonValue v when v.TryGetValue<string>(out var s) => s,
                // A few providers answer with content parts, like the newer OpenAI format.
                JsonArray parts => string.Concat(parts.Select(p => p?["text"]?.GetValue<string>() ?? "")),
                _ => null,
            };
            if (string.IsNullOrWhiteSpace(content))
            {
                log.LogWarning("The backup model ({Name}) gave no answer (finish reason {Reason})", Name, choice?["finish_reason"]?.ToString());
                throw new AppException(502, "AI_FAILED", "The AI assistant could not answer that.");
            }
            return content.Trim();
        }
    }
}

/// <summary>
/// The assistant's model: Claude, and the backup when Claude cannot answer - or the backup alone when no Anthropic key is set. Running out
/// of credit or a refused key does not mend itself in seconds, so after either the backup answers straight away for a while.
/// </summary>
public sealed class AiRouter(AnthropicClient claude, OpenAiCompatibleClient backup, ILogger<AiRouter> log) : IAiClient
{
    private static readonly TimeSpan Rest = TimeSpan.FromMinutes(15);
    private long _claudeRestsUntil;   // UTC ticks

    public bool Configured => claude.Configured || backup.Configured;
    public string Model => claude.Configured ? claude.Model : backup.Model;
    public string? Provider => claude.Configured ? "Claude (Anthropic)" : backup.Configured ? backup.Name : null;
    public string? Backup => claude.Configured && backup.Configured ? backup.Name : null;

    public async Task<AiAnswer> CompleteAsync(string system, string user, int maxTokens, CancellationToken ct)
    {
        if (!Configured) throw new ConflictException("The AI assistant is not set up on this installation.", "AI_NOT_CONFIGURED");
        if (claude.Configured && (!backup.Configured || DateTime.UtcNow.Ticks >= Interlocked.Read(ref _claudeRestsUntil)))
        {
            try { return new AiAnswer(await claude.CompleteAsync(system, user, maxTokens, ct), claude.Model); }
            catch (AppException ex) when (backup.Configured)
            {
                if (ex.Code is "AI_NO_CREDIT" or "AI_KEY_REFUSED") Interlocked.Exchange(ref _claudeRestsUntil, (DateTime.UtcNow + Rest).Ticks);
                log.LogWarning("Claude could not answer ({Code}); asking the backup model ({Backup})", ex.Code, backup.Name);
            }
        }
        return new AiAnswer(await backup.CompleteAsync(system, user, maxTokens, ct), backup.Model);
    }
}
