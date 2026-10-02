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
        services.Configure<JwtOptions>(config.GetSection(JwtOptions.Section));
        services.Configure<SmtpOptions>(config.GetSection(SmtpOptions.Section));
        services.Configure<ResendOptions>(config.GetSection(ResendOptions.Section));
        services.Configure<MaintenanceOptions>(config.GetSection(MaintenanceOptions.Section));
        services.Configure<NotificationOptions>(config.GetSection(NotificationOptions.Section));
        services.Configure<StorageOptions>(config.GetSection(StorageOptions.Section));
        services.Configure<MfaOptions>(config.GetSection(MfaOptions.Section));
        services.Configure<ProjectManagement.Application.Features.Sso.ExternalAuthOptions>(config.GetSection(ProjectManagement.Application.Features.Sso.ExternalAuthOptions.Section));
        services.Configure<ProjectManagement.Application.Features.Integrations.InboundEmailOptions>(config.GetSection(ProjectManagement.Application.Features.Integrations.InboundEmailOptions.Section));
        services.Configure<ProjectManagement.Application.Features.Ai.AiOptions>(config.GetSection(ProjectManagement.Application.Features.Ai.AiOptions.Section));

        var provider = config["Database:Provider"] ?? "Postgres";
        var connection = config.GetConnectionString("Default")
            ?? throw new InvalidOperationException("ConnectionStrings:Default is not configured.");

        services.AddDbContext<AppDbContext>(o =>
        {
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
        services.AddSingleton<ProjectManagement.Application.Services.EntitlementCache>();

        services.AddSingleton(TimeProvider.System);
        services.AddSingleton<IPasswordHasher, PasswordHasherAdapter>();
        services.AddSingleton<ITokenService, TokenService>();
        services.AddSingleton<ISecretProtector, AesSecretProtector>();
        services.AddSingleton<IPaymentProvider, MockPaymentProvider>();

        // Single sign-on and social sign-in: identity providers are reached through the "oidc" HTTP client.
        services.AddHttpClient("oidc", c => c.Timeout = TimeSpan.FromSeconds(15));
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
        services.AddSingleton<AnthropicClient>();
        services.AddSingleton<OpenAiCompatibleClient>();
        services.AddSingleton<ProjectManagement.Application.Features.Ai.IAiClient, AiRouter>();
        if ((config["Storage:Provider"] ?? "Local").Equals("S3", StringComparison.OrdinalIgnoreCase))
        {
            services.AddSingleton<IFileStorage, S3FileStorage>();
            services.AddHostedService<StorageMigrationWorker>();
        }
        else services.AddSingleton<IFileStorage, LocalFileStorage>();

        var emailProvider = config["Email:Provider"] ?? "Log";
        if (emailProvider.Equals("Smtp", StringComparison.OrdinalIgnoreCase))
            services.AddSingleton<IEmailSender, SmtpEmailSender>();
        else if (emailProvider.Equals("Resend", StringComparison.OrdinalIgnoreCase))
            services.AddHttpClient<IEmailSender, ResendEmailSender>(c => c.Timeout = TimeSpan.FromSeconds(15));
        else
            services.AddSingleton<IEmailSender, LogEmailSender>();

        services.AddHostedService<MaintenanceWorker>();
        services.AddHostedService<NotificationEmailWorker>();
        services.Configure<ReportOptions>(config.GetSection(ReportOptions.Section));
        services.AddHostedService<ReportExportWorker>();
        services.Configure<ProjectManagement.Application.Features.Integrations.WebhookOptions>(config.GetSection(ProjectManagement.Application.Features.Integrations.WebhookOptions.Section));
        services.AddSingleton<ProjectManagement.Application.Features.Integrations.IWebhookTransport, HttpWebhookTransport>();
        services.AddHostedService<WebhookWorker>();
        services.Configure<SlaOptions>(config.GetSection(SlaOptions.Section));
        services.AddHostedService<SlaWorker>();
        services.Configure<AutomationOptions>(config.GetSection(AutomationOptions.Section));
        services.AddHostedService<AutomationWorker>();
        // Push notifications to devices (Web Push with VAPID; keys are made on first use).
        services.Configure<ProjectManagement.Application.Features.Notifications.PushOptions>(config.GetSection(ProjectManagement.Application.Features.Notifications.PushOptions.Section));
        services.AddHttpClient("push", c => c.Timeout = TimeSpan.FromSeconds(15));
        services.AddSingleton<ProjectManagement.Application.Features.Notifications.IWebPushSender, WebPushSender>();
        services.AddSingleton<ProjectManagement.Application.Features.Notifications.PushDispatcher>();
        services.AddHostedService<PushWorker>();
        return services;
    }
}
