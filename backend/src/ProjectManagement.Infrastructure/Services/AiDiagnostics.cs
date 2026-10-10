using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Infrastructure.Services;

public sealed class AiDiagnostics(IHttpClientFactory http, IOptions<AiOptions> options, IAiChat chat, AiInferenceGate gate) : IAiDiagnostics
{
    public async Task<AiDiagnosticsDto> CheckAsync(CancellationToken ct)
    {
        var settings = options.Value.Fallback;
        var model = chat.ModelFor(options.Value.Chat.Standard.Model);
        AiDiagnosticsDto Report(bool configured, bool reachable, bool available, string? error) =>
            new(configured, reachable, available, chat.Provider, model, gate.QueueDepth, error,
                options.Value.UsesAnthropic ? null : gate.ActiveRequests, options.Value.UsesAnthropic ? null : gate.MaxConcurrentRequests,
                options.Value.UsesAnthropic ? null : gate.MaxQueuedRequests, options.Value.UsesAnthropic ? null : gate.QueueTimeoutSeconds);
        if (!chat.Configured) return Report(false, false, false, "AI_NOT_CONFIGURED");
        if (options.Value.UsesAnthropic) return Report(true, false, false, "AI_HEALTH_UNSUPPORTED");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(5));
        try
        {
            var root = settings.BaseUrl!.Trim().TrimEnd('/');
            var native = settings.Wire?.Equals("ollama", StringComparison.OrdinalIgnoreCase) == true;
            if (native && root.EndsWith("/v1", StringComparison.OrdinalIgnoreCase)) root = root[..^3];
            using var req = new HttpRequestMessage(HttpMethod.Get, root + (native ? "/api/tags" : "/models"));
            if (!string.IsNullOrWhiteSpace(settings.ApiKey)) req.Headers.Authorization = new("Bearer", settings.ApiKey.Trim());
            using var response = await http.CreateClient("ai-backup").SendAsync(req, deadline.Token);
            if (!response.IsSuccessStatusCode) return Report(true, false, false, "AI_HEALTH_FAILED");
            var body = JsonNode.Parse(await response.Content.ReadAsStringAsync(deadline.Token));
            var models = body?[native ? "models" : "data"] as JsonArray;
            var available = models?.Any(m => m?[native ? "name" : "id"]?.GetValue<string>() == model) == true;
            return Report(true, true, available, available ? null : "AI_MODEL_UNKNOWN");
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        { return Report(true, false, false, "AI_UNREACHABLE"); }
    }
}
