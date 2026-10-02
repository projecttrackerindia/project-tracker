using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Infrastructure.Services;

/// <summary>
/// Claude through the Anthropic Messages API (POST /v1/messages). The key stays on the server; nothing is called unless
/// <c>Ai:AnthropicApiKey</c> is set. Overload and rate-limit answers become a friendly "try again" instead of an error page.
/// </summary>
public class AnthropicClient(IHttpClientFactory http, IOptions<AiOptions> options, ILogger<AnthropicClient> log)
{
    public bool Configured => !string.IsNullOrWhiteSpace(options.Value.AnthropicApiKey);
    public string Model => options.Value.Model;

    public async Task<string> CompleteAsync(string system, string user, int maxTokens, CancellationToken ct)
    {
        if (!Configured) throw new ConflictException("The AI assistant is not set up on this installation.", "AI_NOT_CONFIGURED");
        var o = options.Value;
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{o.BaseUrl.TrimEnd('/')}/v1/messages")
        {
            Content = JsonContent.Create(new
            {
                model = o.Model, max_tokens = Math.Clamp(maxTokens, 64, o.MaxTokens), system,
                messages = new[] { new { role = "user", content = user } },
            }),
        };
        req.Headers.Add("x-api-key", o.AnthropicApiKey);
        req.Headers.Add("anthropic-version", "2023-06-01");

        HttpResponseMessage res;
        try { res = await http.CreateClient("anthropic").SendAsync(req, ct); }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            log.LogWarning(ex, "Claude could not be reached");
            throw AiFailure.Unreachable("Claude", ex);
        }
        using (res)
        {
            var body = await res.Content.ReadAsStringAsync(ct);
            if (!res.IsSuccessStatusCode)
            {
                log.LogWarning("Claude answered {Status}: {Body}", (int)res.StatusCode, body.Length > 300 ? body[..300] : body);
                throw AiFailure.For("Claude", res.StatusCode, body);
            }
            var json = JsonNode.Parse(body);
            var text = string.Concat((json?["content"]?.AsArray() ?? []).Where(c => c?["type"]?.GetValue<string>() == "text").Select(c => c!["text"]!.GetValue<string>()));
            return text.Trim();
        }
    }
}

/// <summary>Turns a model provider's failure into an <see cref="AiProviderException"/>.</summary>
public static class AiFailure
{
    public static AiProviderException Unreachable(string who, Exception ex) =>
        new(503, "AI_UNAVAILABLE", who, "could not be reached", ex is TaskCanceledException ? "no answer within 90 seconds" : ex.Message);
    public static AiProviderException NoAnswer(string who, string? finishReason) =>
        new(502, "AI_FAILED", who, "gave no answer", $"empty answer (finish reason {finishReason ?? "none"})");

    /// <summary>
    /// The provider's own message: Anthropic and OpenAI-style APIs answer {"error":{"message":..}}, Google's OpenAI-style endpoint
    /// [{"error":{"message":..}}].
    /// </summary>
    public static string DetailOf(int status, string body)
    {
        string? message = null;
        try
        {
            var j = JsonNode.Parse(body);
            if (j is JsonArray a) j = a.FirstOrDefault();
            message = j?["error"]?["message"]?.GetValue<string>() ?? j?["message"]?.GetValue<string>();
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException) { }
        message = (message ?? (body.TrimStart().StartsWith('<') ? null : body))?.Trim();
        if (message is { Length: > 200 }) message = message[..200] + "…";
        return string.IsNullOrEmpty(message) ? $"HTTP {status}" : $"HTTP {status}: {message}";
    }

    /// <summary>
    /// Reads a provider's error answer. Providers disagree on status codes - Google answers a bad key with 400, Anthropic an empty balance
    /// with 400 - so the wording of the answer counts as much as the code.
    /// </summary>
    public static AiProviderException For(string who, HttpStatusCode status, string body)
    {
        var s = (int)status;
        var detail = DetailOf(s, body);
        bool Says(params string[] words) => words.Any(w => body.Contains(w, StringComparison.OrdinalIgnoreCase));
        if (s == 402 || Says("credit balance", "insufficient_quota", "billing_hard_limit"))
            return new(503, "AI_NO_CREDIT", who, "has run out of credit", detail);
        if (Says("location is not supported", "not available in your country", "unsupported_country", "not supported in your region"))
            return new(503, "AI_REGION", who, "is not available from where this server runs", detail);
        if (s is 401 or 403 || Says("Invalid Auth key", "API key not valid", "API_KEY_INVALID", "invalid_api_key", "Incorrect API key", "invalid x-api-key"))
            return new(503, "AI_KEY_REFUSED", who, "refused its key", detail);
        if (s == 404 || Says("model_not_found", "is not found for API version", "model not found", "Unknown model"))
            return new(502, "AI_MODEL_UNKNOWN", who, "does not recognise the model name", detail);
        if (s is 429 or 529 or 503)
            return new(503, "AI_BUSY", who, "is busy", detail);
        return new(502, "AI_FAILED", who, "could not answer", detail);
    }
}
