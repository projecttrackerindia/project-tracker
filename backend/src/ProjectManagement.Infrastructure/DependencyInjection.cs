using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Infrastructure.Persistence;
using ProjectManagement.Infrastructure.Services;
using ProjectManagement.Infrastructure.Workers;

namespace ProjectManagement.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(this IServiceCollection services, IConfiguration config)
    {
        services.Configure<AppOptions>(config.GetSection(AppOptions.Section));
        services.Configure<ProjectManagement.Application.Features.Billing.PricingOptions>(config.GetSection(ProjectManagement.Application.Features.Billing.PricingOptions.Section));
        services.Configure<JwtOptions>(config.GetSection(JwtOptions.Section));
        services.Configure<SmtpOptions>(config.GetSection(SmtpOptions.Section));
        services.Configure<ResendOptions>(config.GetSection(ResendOptions.Section));
        services.Configure<MaintenanceOptions>(config.GetSection(MaintenanceOptions.Section));
        services.Configure<NotificationOptions>(config.GetSection(NotificationOptions.Section));
        services.Configure<StorageOptions>(config.GetSection(StorageOptions.Section));
        services.Configure<MfaOptions>(config.GetSection(MfaOptions.Section));
        services.Configure<ProjectManagement.Application.Features.Sso.ExternalAuthOptions>(config.GetSection(ProjectManagement.Application.Features.Sso.ExternalAuthOptions.Section));
        services.Configure<ProjectManagement.Application.Features.Integrations.InboundEmailOptions>(config.GetSection(ProjectManagement.Application.Features.Integrations.InboundEmailOptions.Section));
        services.Configure<ProjectManagement.Application.Features.Integrations.GoogleCalendarOptions>(config.GetSection(ProjectManagement.Application.Features.Integrations.GoogleCalendarOptions.Section));
        services.AddOptions<ProjectManagement.Application.Features.Ai.AiOptions>()
            .Bind(config.GetSection(ProjectManagement.Application.Features.Ai.AiOptions.Section))
            .PostConfigure(o => { if (string.IsNullOrWhiteSpace(o.Gemini.ApiKey)) o.Gemini.ApiKey = config["AI_gemini_apikey"]; })
            .Validate(o => o.PrimaryProvider is "local" or "anthropic" or "gemini", "Ai:PrimaryProvider must be local, anthropic or gemini.")
            .Validate(o => o.PrimaryProvider != "gemini" || o.Gemini.Enabled && !string.IsNullOrWhiteSpace(o.Gemini.ApiKey), "Gemini requires explicit enablement and a backend key.")
            .Validate(o => !o.Gemini.Enabled || !string.IsNullOrWhiteSpace(o.Gemini.Model) && System.Text.RegularExpressions.Regex.IsMatch(o.Gemini.ProjectId, "^[a-zA-Z0-9-]+$"), "Gemini needs a model and a valid project identifier.")
            .Validate(o => o.Gemini.MaxOutputTokens is >= 1 and <= 16000 && o.Gemini.TimeoutSeconds is >= 1 and <= 600 && o.Gemini.MaxPromptBytes >= 256 && o.Gemini.RequestsPerMinute > 0 && o.Gemini.InputTokensPerMinute > 0 && o.Gemini.RequestsPerDay > 0 && o.Gemini.PilotInputTokenAllowance > 0 && o.Gemini.PilotOutputTokenAllowance > 0, "Gemini capacity and pilot settings are invalid.")
            .Validate(o => o.PrimaryProvider != "anthropic" || o.AllowAnthropic, "Anthropic requires explicit Ai:AllowAnthropic=true.")
            .Validate(o => string.IsNullOrWhiteSpace(o.Fallback.BaseUrl) || Uri.TryCreate(o.Fallback.BaseUrl, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" && string.IsNullOrEmpty(uri.UserInfo), "Ai:Fallback:BaseUrl must be an HTTP(S) address without embedded credentials.")
            .Validate(o => o.Fallback.MaxOutputTokens is >= 1 and <= 16000 && o.Fallback.TimeoutSeconds is >= 1 and <= 600 && o.Fallback.MaxPromptChars >= 256, "AI output, timeout and prompt limits are invalid.")
            .Validate(o => o.Chat.MaxToolCalls is >= 1 and <= 64 && o.Chat.MaxToolSteps is >= 1 and <= 16, "AI tool execution limits are invalid.")
            .ValidateOnStart();

        var provider = config["Database:Provider"] ?? "Postgres";
        var connection = config.GetConnectionString("Default")
            ?? throw new InvalidOperationException("ConnectionStrings:Default is not configured.");

        services.AddScoped<AiDatabaseCommandInterceptor>();
        services.AddSingleton<TransactionEffectsInterceptor>();
        services.AddDbContext<AppDbContext>((sp, o) =>
        {
            o.AddInterceptors(sp.GetRequiredService<AiDatabaseCommandInterceptor>(), sp.GetRequiredService<TransactionEffectsInterceptor>());
            if (provider.Equals("Sqlite", StringComparison.OrdinalIgnoreCase)) o.UseSqlite(connection);
            else o.UseNpgsql(connection);
        });
        services.AddScoped<IAppDbContext>(sp => sp.GetRequiredService<AppDbContext>());

        // Shared cache: Redis when Redis:ConnectionString is set (needed to run several API servers), otherwise in-process memory.
        services.Configure<ProjectManagement.Application.Services.CacheOptions>(config.GetSection(ProjectManagement.Application.Services.CacheOptions.Section));
        var redis = config["Redis:ConnectionString"];
        if (!string.IsNullOrWhiteSpace(redis))
        {
            var options = StackExchange.Redis.ConfigurationOptions.Parse(redis);
            options.AbortOnConnectFail = false;   // start even if Redis is briefly down; it reconnects by itself
            options.ConnectTimeout = 3000; options.SyncTimeout = 1000; options.AsyncTimeout = 1000;
            var mux = StackExchange.Redis.ConnectionMultiplexer.Connect(options);
            services.AddSingleton<StackExchange.Redis.IConnectionMultiplexer>(mux);
            services.AddStackExchangeRedisCache(o => { o.ConnectionMultiplexerFactory = () => Task.FromResult<StackExchange.Redis.IConnectionMultiplexer>(mux); o.InstanceName = "pm:"; });
        }
        else services.AddDistributedMemoryCache();
        services.Configure<ProjectManagement.Application.Features.Ai.AiRateLimitOptions>(config.GetSection(ProjectManagement.Application.Features.Ai.AiRateLimitOptions.Section));
        if (!string.IsNullOrWhiteSpace(redis))
            services.AddSingleton<ProjectManagement.Application.Features.Ai.IAiRequestLimiter, RedisAiRequestLimiter>();
        else
            services.AddSingleton<ProjectManagement.Application.Features.Ai.IAiRequestLimiter, MemoryAiRequestLimiter>();
        services.AddSingleton<ProjectManagement.Application.Services.EntitlementCache>();

        services.AddSingleton(TimeProvider.System);
        services.AddSingleton<IPasswordHasher, PasswordHasherAdapter>();
        services.AddSingleton<ITokenService, TokenService>();
        services.AddSingleton<ISecretProtector, AesSecretProtector>();
        // Payments: simulated unless Billing:Provider=Razorpay (keys in Billing:Razorpay:*).
        services.Configure<RazorpayOptions>(config.GetSection(RazorpayOptions.Section));
        if ((config["Billing:Provider"] ?? "Mock").Equals("Razorpay", StringComparison.OrdinalIgnoreCase))
            services.AddHttpClient<IPaymentProvider, RazorpayPaymentProvider>(c => c.Timeout = TimeSpan.FromSeconds(20));
        else
            services.AddSingleton<IPaymentProvider, MockPaymentProvider>();

        // Single sign-on and social sign-in: identity providers are reached through the "oidc" HTTP client.
        services.AddHttpClient("oidc", c => c.Timeout = TimeSpan.FromSeconds(15));
        services.AddHttpClient("google-calendar", c => c.Timeout = TimeSpan.FromSeconds(20));
        services.AddSingleton<ProjectManagement.Application.Features.Sso.IOidcProtocol, OidcProtocol>();
        services.AddSingleton<ProjectManagement.Application.Features.Sso.IGitHubOAuth, GitHubOAuth>();
        services.AddSingleton<ProjectManagement.Application.Features.Sso.IAppleClientSecret, AppleClientSecret>();
        services.AddSingleton<ProjectManagement.Application.Features.Sso.ISamlProtocol, SamlProtocol>();
        services.AddSingleton<ProjectManagement.Application.Features.Sso.IDomainVerifier, DnsDomainVerifier>();
        services.AddSingleton<DevMailbox>();
        // The AI assistant: Claude through the Anthropic API when Ai:AnthropicApiKey is set, and the backup model (Ai:Fallback:*) when
        // Claude cannot answer or on its own.
        services.AddHttpClient("anthropic", c => c.Timeout = TimeSpan.FromSeconds(90));
        services.AddHttpClient("ai-backup", c => c.Timeout = TimeSpan.FromSeconds(90));
        services.AddHttpClient("ai-backup-stream", c => c.Timeout = TimeSpan.FromMinutes(5));   // a CPU-only local model can take far longer than a one-shot sizing call
        services.AddSingleton<AnthropicClient>();
        services.AddHostedService<AiTraceRetentionWorker>();
        services.AddSingleton<AiInferenceGate>();
        services.AddSingleton<ProjectManagement.Application.Features.Ai.IAiDiagnostics, AiDiagnostics>();
        services.AddSingleton<OpenAiCompatibleClient>();
        services.AddSingleton<ProjectManagement.Application.Features.Ai.IAiClient, AiRouter>();
        services.AddSingleton<AnthropicChat>();
        services.AddSingleton<OpenAiCompatibleChat>();
        services.AddSingleton<GeminiAdmission>();
        services.AddSingleton<GeminiChat>();
        services.AddHttpClient("ai-gemini", c => c.Timeout = Timeout.InfiniteTimeSpan);
        // The AI workspace: streamed, with tools and files. Claude first, the same Ai:Fallback:* provider as backup - a self-hosted
        // Ollama/llama.cpp server for a CPU-only deployment, or any other OpenAI-compatible address, used when Claude cannot answer or
        // there is no Anthropic key at all.
        services.AddSingleton<ProjectManagement.Application.Features.Ai.IAiChat, AiChatRouter>();
        if ((config["Storage:Provider"] ?? "Local").Equals("S3", StringComparison.OrdinalIgnoreCase))
        {
            services.AddSingleton<IFileStorage, S3FileStorage>();
            services.AddHostedService<StorageMigrationWorker>();
        }
        else services.AddSingleton<IFileStorage, LocalFileStorage>();

        var emailProvider = config["Email:Provider"] ?? "Log";
        if (emailProvider.Equals("Smtp", StringComparison.OrdinalIgnoreCase))
            services.AddSingleton<IEmailTransport, SmtpEmailSender>();
        else if (emailProvider.Equals("Resend", StringComparison.OrdinalIgnoreCase))
            services.AddHttpClient<IEmailTransport, ResendEmailSender>(c => c.Timeout = TimeSpan.FromSeconds(15));
        else
            services.AddSingleton<IEmailTransport, LogEmailSender>();
        services.Configure<EmailCommonOptions>(config.GetSection("Email"));
        // What the app sends through: the provider above, plus suppression of bad addresses, a delivery log and retries for important messages.
        services.AddSingleton<IEmailSender, ProjectManagement.Application.Features.Notifications.ReliableEmailSender>();

        services.AddHostedService<MaintenanceWorker>();
        services.AddHostedService<NotificationEmailWorker>();
        services.Configure<ReportOptions>(config.GetSection(ReportOptions.Section));
        services.AddHostedService<ReportExportWorker>();
        services.Configure<ProjectManagement.Application.Features.Integrations.WebhookOptions>(config.GetSection(ProjectManagement.Application.Features.Integrations.WebhookOptions.Section));
        services.AddSingleton<ProjectManagement.Application.Features.Integrations.IWebhookTransport, HttpWebhookTransport>();
        services.AddHostedService<WebhookWorker>();
        services.Configure<SlaOptions>(config.GetSection(SlaOptions.Section));
        services.AddHostedService<SlaWorker>();
        services.Configure<GoogleMeetSyncOptions>(config.GetSection(GoogleMeetSyncOptions.Section));
        services.AddHostedService<GoogleMeetSyncWorker>();
        services.Configure<AutomationOptions>(config.GetSection(AutomationOptions.Section));
        services.AddHostedService<AutomationWorker>();
        services.Configure<ReminderOptions>(config.GetSection(ReminderOptions.Section));
        services.AddHostedService<ReminderWorker>();
        // Push notifications to devices (Web Push with VAPID; keys are made on first use).
        services.Configure<ProjectManagement.Application.Features.Notifications.PushOptions>(config.GetSection(ProjectManagement.Application.Features.Notifications.PushOptions.Section));
        services.AddHttpClient("push", c => c.Timeout = TimeSpan.FromSeconds(15));
        services.AddSingleton<WebPushSender>();
        services.AddSingleton<FcmSender>();
        // One sender for every kind of device: browsers and installed web apps (Web Push), the Android app (Firebase Cloud Messaging).
        services.AddSingleton<ProjectManagement.Application.Features.Notifications.IWebPushSender, DevicePushSender>();
        services.AddSingleton<ProjectManagement.Application.Features.Notifications.PushDispatcher>();
        services.AddHostedService<PushWorker>();
        return services;
    }
}
