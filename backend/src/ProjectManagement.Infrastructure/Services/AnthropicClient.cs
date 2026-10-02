using System.Net;
using System.Net.Http.Json;
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
            throw new AppException(503, "AI_UNAVAILABLE", "The AI assistant could not be reached. Try again in a moment.");
        }
        using (res)
        {
            var body = await res.Content.ReadAsStringAsync(ct);
            if (!res.IsSuccessStatusCode)
            {
                log.LogWarning("Claude answered {Status}: {Body}", (int)res.StatusCode, body.Length > 300 ? body[..300] : body);
                throw AiFailure.For(res.StatusCode, body);
            }
            var json = JsonNode.Parse(body);
            var text = string.Concat((json?["content"]?.AsArray() ?? []).Where(c => c?["type"]?.GetValue<string>() == "text").Select(c => c!["text"]!.GetValue<string>()));
            return text.Trim();
        }
    }
}

/// <summary>What a model provider's error answer means for the person asking.</summary>
public static class AiFailure
{
    public static AppException For(HttpStatusCode status, string body) =>
        (int)status is 429 or 529 or 503
            ? new AppException(503, "AI_BUSY", "The AI assistant is busy. Try again in a moment.")
            // Anthropic says "Your credit balance is too low" with a 400; others use 402 Payment Required.
            : status is HttpStatusCode.PaymentRequired || body.Contains("credit balance", StringComparison.OrdinalIgnoreCase)
                ? new AppException(503, "AI_NO_CREDIT", "The AI assistant has run out of credit. An administrator needs to top it up.")
                : status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden
                    ? new AppException(503, "AI_KEY_REFUSED", "The AI assistant's key was refused. An administrator needs to check it.")
                    : new AppException(502, "AI_FAILED", "The AI assistant could not answer that.");
}
