using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json.Nodes;
using System.Runtime.CompilerServices;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Infrastructure.Services;

/// <summary>
/// AI clients on a workspace's own key: Claude through the same client the platform uses for Claude, ChatGPT through the OpenAI-compatible
/// client (one per model, since that client speaks to one model). Built once per workspace and key version, then reused.
/// </summary>
public sealed class WorkspaceAiClients(IHttpClientFactory http, IOptions<AiOptions> platform, ILoggerFactory logs) : IWorkspaceAiClients
{
    public const string AnthropicBase = "https://api.anthropic.com";
    public const string OpenAiBase = "https://api.openai.com/v1";
    private readonly ConcurrentDictionary<string, (IAiChat Chat, IAiClient OneShot)> cache = new();

    private static string CacheKey(WorkspaceAiKey k) => $"{k.TenantId:N}:{k.Version}:{k.Provider}:{k.QuickModel}:{k.StandardModel}:{k.DeepModel}";

    public IAiChat Chat(WorkspaceAiKey key) => Build(key).Chat;
    public IAiClient OneShot(WorkspaceAiKey key) => Build(key).OneShot;

    private (IAiChat Chat, IAiClient OneShot) Build(WorkspaceAiKey key)
    {
        // An older version of the same workspace's key is dropped when a newer one arrives.
        foreach (var stale in cache.Keys.Where(k => k.StartsWith($"{key.TenantId:N}:", StringComparison.Ordinal) && k != CacheKey(key))) cache.TryRemove(stale, out _);
        return cache.GetOrAdd(CacheKey(key), _ =>
        {
            if (key.Provider == "openai")
            {
                var chats = new ConcurrentDictionary<string, IAiChat>(StringComparer.OrdinalIgnoreCase);
                IAiChat ForModel(string model) => chats.GetOrAdd(model, m =>
                {
                    var o = OpenAiOptions(key, m);
                    var client = new OpenAiCompatibleClient(http, o, logs.CreateLogger<OpenAiCompatibleClient>(), new AiInferenceGate(o));
                    return new OpenAiCompatibleChat(http, o, client, logs.CreateLogger<OpenAiCompatibleChat>());
                });
                var oneShotOptions = OpenAiOptions(key, key.StandardModel);
                var oneShot = new OpenAiCompatibleClient(http, oneShotOptions, logs.CreateLogger<OpenAiCompatibleClient>(), new AiInferenceGate(oneShotOptions));
                return (new WorkspaceKeyChat(key, platform.Value.Chat, ForModel), new WorkspaceKeyOneShot(key, (s, u, t, ct) => oneShot.CompleteAsync(s, u, t, ct)));
            }
            var claudeOptions = Options.Create(new AiOptions
            {
                PrimaryProvider = "anthropic", AllowAnthropic = true, AnthropicApiKey = key.ApiKey, BaseUrl = AnthropicBase,
                Model = key.StandardModel, MaxTokens = Math.Max(platform.Value.MaxTokens, 4000), Chat = platform.Value.Chat,
            });
            var claude = new AnthropicChat(claudeOptions, logs.CreateLogger<AnthropicChat>());
            var claudeOneShot = new AnthropicClient(http, claudeOptions, logs.CreateLogger<AnthropicClient>());
            return (new WorkspaceKeyChat(key, platform.Value.Chat, _ => claude), new WorkspaceKeyOneShot(key, (s, u, t, ct) => claudeOneShot.CompleteAsync(s, u, t, ct)));
        });
    }

    private static IOptions<AiOptions> OpenAiOptions(WorkspaceAiKey key, string model) => Options.Create(new AiOptions
    {
        PrimaryProvider = "openai",
        Fallback = new AiFallbackOptions
        {
            BaseUrl = OpenAiBase, ApiKey = key.ApiKey, Model = model, Name = "ChatGPT (OpenAI)", OpenAiNative = true, SupportsImages = true,
            MaxOutputTokens = 16000, TimeoutSeconds = 240, MaxConcurrentRequests = 8, MaxQueuedRequests = 64, QueueTimeoutSeconds = 30, MaxPromptChars = 600_000,
        },
    });

    public async Task<IReadOnlyList<string>> ListModelsAsync(string provider, string apiKey, CancellationToken ct)
    {
        var who = WorkspaceAiService.NameOf(provider);
        using var req = new HttpRequestMessage(HttpMethod.Get, provider == "openai" ? $"{OpenAiBase}/models" : $"{AnthropicBase}/v1/models?limit=100");
        if (provider == "openai") req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        else { req.Headers.Add("x-api-key", apiKey); req.Headers.Add("anthropic-version", "2023-06-01"); }
        HttpResponseMessage res;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(20));
        try { res = await http.CreateClient(provider == "openai" ? "openai" : "anthropic").SendAsync(req, deadline.Token); }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        { throw new AppException(502, "AI_KEY_UNREACHABLE", $"{who} could not be reached. Try again in a moment."); }
        using (res)
        {
            if (res.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                throw new AppException(422, "AI_KEY_REFUSED", $"{who} refused this key. Check it is copied completely and still active.");
            if (!res.IsSuccessStatusCode)
                throw new AppException(502, "AI_KEY_CHECK_FAILED", $"{who} answered {(int)res.StatusCode} when asked which models this key may use. Try again in a moment.");
            var json = JsonNode.Parse(await res.Content.ReadAsStringAsync(ct));
            var ids = (json?["data"]?.AsArray() ?? []).Select(m => m?["id"]?.GetValue<string>()).OfType<string>();
            // OpenAI lists every kind of model it has (images, speech, embeddings); only chat models can run the assistant.
            if (provider == "openai")
                ids = ids.Where(id => (id.StartsWith("gpt-", StringComparison.Ordinal) || id.StartsWith("o", StringComparison.Ordinal) && id.Length > 1 && char.IsDigit(id[1]) || id.StartsWith("chatgpt", StringComparison.Ordinal))
                    && !id.Contains("audio") && !id.Contains("realtime") && !id.Contains("transcribe") && !id.Contains("tts") && !id.Contains("image") && !id.Contains("search") && !id.Contains("instruct"));
            var list = ids.Distinct().OrderBy(x => x, StringComparer.Ordinal).ToList();
            if (list.Count == 0) throw new AppException(422, "AI_KEY_NO_MODELS", $"{who} accepted the key but lists no chat models for it. Check the key's project has model access.");
            return list;
        }
    }
}

/// <summary>
/// The assistant on a workspace's own key. Project Tracker asks for a level of model (quick, standard, deep, named after the platform's own
/// models); this answers with the model the workspace chose for that level.
/// </summary>
public sealed class WorkspaceKeyChat(WorkspaceAiKey key, AiChatOptions tiers, Func<string, IAiChat> chatFor) : IAiChat
{
    public bool Configured => true;
    public string Provider => key.ProviderName;

    public string ModelFor(string requestedModel) => Map(requestedModel);

    public string Map(string requested) => key.ModelFor(requested, tiers);

    public IAsyncEnumerable<AiChatEvent> StreamAsync(AiChatRequest request, CancellationToken ct)
    {
        var model = Map(request.Model);
        return chatFor(model).StreamAsync(request with { Model = model }, ct);
    }

    public Task<string> CompleteAsync(string model, string system, string user, int maxTokens, CancellationToken ct)
    {
        var m = Map(model);
        return chatFor(m).CompleteAsync(m, system, user, maxTokens, ct);
    }
}

/// <summary>A short answer on a workspace's own key.</summary>
public sealed class WorkspaceKeyOneShot(WorkspaceAiKey key, Func<string, string, int, CancellationToken, Task<string>> complete) : IAiClient
{
    public bool Configured => true;
    public string Model => key.StandardModel;
    public string? Provider => key.ProviderName;
    public string? Backup => null;
    public async Task<AiAnswer> CompleteAsync(string system, string user, int maxTokens, CancellationToken ct) => new(await complete(system, user, maxTokens, ct), key.StandardModel);
}

/// <summary>
/// Finds the workspace key for the request being served: the person's own request, in a workspace that uses its own key, after they agreed.
/// Background work has no request (and nobody who agreed), so it gets none and keeps using Project Tracker's own AI.
/// </summary>
public sealed class WorkspaceAiResolver(IHttpContextAccessor accessor, IWorkspaceAiClients clients)
{
    public IWorkspaceAiClients Clients => clients;

    public async Task<(WorkspaceAiKey Key, WorkspaceAiService Service)?> CurrentAsync(CancellationToken ct)
    {
        var services = accessor.HttpContext?.RequestServices;
        if (services?.GetService<WorkspaceAiService>() is not { } service) return null;
        try { return await service.ActiveAsync(ct) is { } key ? (key, service) : null; }
        catch (Exception ex) when (ex is not OperationCanceledException) { return null; }
    }

    /// <summary>What a person sees when their organization's key fails and the organization chose not to fall back.</summary>
    public static AppException Failed(WorkspaceAiKey key, AppException failure) =>
        new(502, "AI_WORKSPACE_KEY_FAILED", $"Your organization's {key.ProviderName} key could not answer: {failure.Message.TrimEnd('.')}. An owner or administrator can check it in Settings › AI.");
}

/// <summary>
/// The assistant as everything in the app sees it: the organization's own key first, for a person who agreed to it, then Project Tracker's
/// own AI. A failure before anything reached the person may switch to Project Tracker's AI (if the organization allows it); a failure
/// mid-answer is let through rather than silently restarting the answer on another model.
/// </summary>
public sealed class WorkspaceAwareChat(IAiChat platform, WorkspaceAiResolver workspace, ILogger<WorkspaceAwareChat> log) : IAiChat
{
    public bool Configured => platform.Configured;
    public string Provider => platform.Provider;
    public string ModelFor(string requestedModel) => platform.ModelFor(requestedModel);

    public async Task<string> CompleteAsync(string model, string system, string user, int maxTokens, CancellationToken ct)
    {
        if (await workspace.CurrentAsync(ct) is { } own)
        {
            try { return await workspace.Clients.Chat(own.Key).CompleteAsync(model, system, user, maxTokens, ct); }
            catch (AppException ex) when (ex is not ValidationException && !ct.IsCancellationRequested)
            {
                await own.Service.ReportFailureAsync(ex.Message, CancellationToken.None);
                if (!own.Key.FallbackToPlatform || !platform.Configured) throw WorkspaceAiResolver.Failed(own.Key, ex);
                log.LogWarning("The workspace's own {Provider} key could not answer ({Code}); using Project Tracker's AI", own.Key.Provider, ex.Code);
            }
        }
        return await platform.CompleteAsync(model, system, user, maxTokens, ct);
    }

    public async IAsyncEnumerable<AiChatEvent> StreamAsync(AiChatRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        if (await workspace.CurrentAsync(ct) is { } own)
        {
            await using var events = workspace.Clients.Chat(own.Key).StreamAsync(request, ct).GetAsyncEnumerator(ct);
            AppException? failure = null;
            bool more;
            try { more = await events.MoveNextAsync(); }
            catch (AppException ex) when (ex is not ValidationException && !ct.IsCancellationRequested) { failure = ex; more = false; }
            if (failure is null)
            {
                while (more) { yield return events.Current; more = await events.MoveNextAsync(); }
                yield break;
            }
            await own.Service.ReportFailureAsync(failure.Message, CancellationToken.None);
            if (!own.Key.FallbackToPlatform || !platform.Configured) throw WorkspaceAiResolver.Failed(own.Key, failure);
            log.LogWarning("The workspace's own {Provider} key could not answer ({Code}); using Project Tracker's AI", own.Key.Provider, failure.Code);
        }
        await foreach (var e in platform.StreamAsync(request, ct)) yield return e;
    }
}

/// <summary>Short answers, the same way: the organization's own key first for a person who agreed to it, then Project Tracker's AI.</summary>
public sealed class WorkspaceAwareClient(IAiClient platform, WorkspaceAiResolver workspace, ILogger<WorkspaceAwareClient> log) : IAiClient
{
    public bool Configured => platform.Configured;
    public string Model => platform.Model;
    public string? Provider => platform.Provider;
    public string? Backup => platform.Backup;

    public async Task<AiAnswer> CompleteAsync(string system, string user, int maxTokens, CancellationToken ct)
    {
        if (await workspace.CurrentAsync(ct) is { } own)
        {
            try { return await workspace.Clients.OneShot(own.Key).CompleteAsync(system, user, maxTokens, ct); }
            catch (AppException ex) when (ex is not ValidationException && !ct.IsCancellationRequested)
            {
                await own.Service.ReportFailureAsync(ex.Message, CancellationToken.None);
                if (!own.Key.FallbackToPlatform || !platform.Configured) throw WorkspaceAiResolver.Failed(own.Key, ex);
                log.LogWarning("The workspace's own {Provider} key could not answer ({Code}); using Project Tracker's AI", own.Key.Provider, ex.Code);
            }
        }
        return await platform.CompleteAsync(system, user, maxTokens, ct);
    }
}

