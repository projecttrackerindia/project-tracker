using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.IdentityModel.Tokens;
using Microsoft.OpenApi.Models;
using ProjectManagement.Api.Common;
using ProjectManagement.Api.Filters;
using ProjectManagement.Api.Middleware;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Infrastructure.Persistence;
using ProjectManagement.Infrastructure.Services;

namespace ProjectManagement.Api.Extensions;

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddApiControllers(this IServiceCollection services, IConfiguration config)
    {
        services.AddControllers(o =>
            {
                o.Filters.Add<ValidationFilter>();
                o.Filters.Add<ApiResponseFilter>();
                o.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes = true;
            })
            .ConfigureApiBehaviorOptions(o => o.SuppressModelStateInvalidFilter = true) // ValidationFilter renders errors instead
            .AddJsonOptions(o => Json.Configure(o.JsonSerializerOptions));
        services.ConfigureHttpJsonOptions(o => Json.Configure(o.SerializerOptions));

        // Live events (chat, presence, changes): the hub carries events out; changes go through the normal API.
        var signalR = services.AddSignalR(o => { o.MaximumReceiveMessageSize = 16 * 1024; o.KeepAliveInterval = TimeSpan.FromSeconds(15); })
            .AddJsonProtocol(o => Json.Configure(o.PayloadSerializerOptions));
        if (!string.IsNullOrWhiteSpace(config["Redis:ConnectionString"]))
        {
            // Several API servers: messages published on one server reach the clients connected to the others (Redis backplane), and
            // presence is counted in Redis too. The connection to Redis is the one the infrastructure already opened.
            signalR.AddStackExchangeRedis();
            services.AddOptions<Microsoft.AspNetCore.SignalR.StackExchangeRedis.RedisOptions>()
                .Configure<StackExchange.Redis.IConnectionMultiplexer>((o, mux) =>
                {
                    o.ConnectionFactory = _ => Task.FromResult(mux);
                    o.Configuration.ChannelPrefix = StackExchange.Redis.RedisChannel.Literal("pm:signalr");
                });
            services.AddSingleton<ProjectManagement.Api.Realtime.RedisPresenceStore>();
            services.AddSingleton<ProjectManagement.Api.Realtime.IPresenceStore>(sp => sp.GetRequiredService<ProjectManagement.Api.Realtime.RedisPresenceStore>());
            services.AddHostedService(sp => sp.GetRequiredService<ProjectManagement.Api.Realtime.RedisPresenceStore>());
        }
        else services.AddSingleton<ProjectManagement.Api.Realtime.IPresenceStore, ProjectManagement.Api.Realtime.InMemoryPresenceStore>();
        services.AddSingleton<ProjectManagement.Api.Realtime.ChatPresence>();
        services.AddSingleton<ProjectManagement.Application.Features.Chat.IChatPresence>(sp => sp.GetRequiredService<ProjectManagement.Api.Realtime.ChatPresence>());
        services.AddSingleton<ProjectManagement.Application.Features.Chat.IChatNotifier, ProjectManagement.Api.Realtime.SignalRChatNotifier>();
        services.AddSingleton<ProjectManagement.Application.Abstractions.IChangeFeed, ProjectManagement.Api.Realtime.SignalRChangeFeed>();
        return services;
    }

    public static IServiceCollection AddJwtAuthentication(this IServiceCollection services, IConfiguration config, IHostEnvironment env)
    {
        var jwt = config.GetSection(JwtOptions.Section).Get<JwtOptions>() ?? new JwtOptions();
        if (jwt.SigningKey.Length < 32)
            throw new InvalidOperationException(
                "Jwt:SigningKey must be at least 32 characters. Set it via environment variable Jwt__SigningKey or user-secrets — never commit a production key.");

        services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(o =>
        {
            o.MapInboundClaims = false; // keep "sub", "sid", "wid" as issued
            o.TokenValidationParameters = new TokenValidationParameters
            {
                ValidateIssuer = true, ValidIssuer = jwt.Issuer,
                ValidateAudience = true, ValidAudience = jwt.Audience,
                ValidateIssuerSigningKey = true, IssuerSigningKey = TokenService.KeyFrom(jwt.SigningKey),
                ValidateLifetime = true, ClockSkew = TimeSpan.FromSeconds(30),
                ValidAlgorithms = [SecurityAlgorithms.HmacSha256],
            };
            o.Events = new JwtBearerEvents
            {
                OnMessageReceived = ctx =>
                {
                    var token = ctx.Request.Query["access_token"];
                    if (!string.IsNullOrEmpty(token) && ctx.HttpContext.Request.Path.StartsWithSegments("/hubs/chat")) ctx.Token = token;
                    return Task.CompletedTask;
                },
                OnChallenge = async ctx =>
                {
                    ctx.HandleResponse();
                    await ErrorWriter.WriteAsync(ctx.HttpContext, 401, "Authentication is required.", [new ApiError("UNAUTHORIZED", "Authentication is required.")]);
                },
                OnForbidden = ctx => ErrorWriter.WriteAsync(ctx.HttpContext, 403, "You do not have permission to perform this action.",
                    [new ApiError("FORBIDDEN", "You do not have permission to perform this action.")]),
            };
        });
        services.AddAuthorization();
        return services;
    }

    public static IServiceCollection AddApiCors(this IServiceCollection services, IConfiguration config)
    {
        var origins = config.GetSection("Cors:Origins").Get<string[]>() ?? [];
        services.AddCors(o => o.AddDefaultPolicy(p =>
        {
            if (origins.Length > 0) p.WithOrigins(origins).AllowAnyHeader().AllowAnyMethod().AllowCredentials();
        }));
        return services;
    }

    public static IServiceCollection AddApiRateLimiting(this IServiceCollection services, IConfiguration config)
    {
        var enabled = config.GetValue("RateLimiting:Enabled", true);
        int anon = config.GetValue("RateLimiting:AnonymousPerMinute", 60);
        int authed = config.GetValue("RateLimiting:AuthenticatedPerMinute", 300);
        int auth = config.GetValue("RateLimiting:AuthPerMinute", 10);
        int scim = config.GetValue("RateLimiting:ScimPerMinute", 600);

        FixedWindowRateLimiterOptions Window(int limit) => new() { PermitLimit = limit, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 };
        static string Ip(HttpContext http) => http.Connection.RemoteIpAddress?.ToString() ?? "unknown";

        var redisConfigured = !string.IsNullOrWhiteSpace(config["Redis:ConnectionString"]);

        services.AddRateLimiter(o =>
        {
            o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            o.OnRejected = async (context, _) =>
            {
                if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retry))
                    context.HttpContext.Response.Headers.RetryAfter = ((int)retry.TotalSeconds).ToString();
                await ErrorWriter.WriteAsync(context.HttpContext, 429, "Too many requests. Please slow down.", [new ApiError("TOO_MANY_REQUESTS", "Too many requests. Please slow down.")]);
            };
            // With Redis the counters are shared by every API instance; without it each instance counts for itself.
            RateLimitPartition<string> Limited(HttpContext http, string key, int limit) => redisConfigured
                ? RateLimitPartition.Get(key, k => new RedisFixedWindowRateLimiter(http.RequestServices.GetRequiredService<StackExchange.Redis.IConnectionMultiplexer>(), k, limit, TimeSpan.FromMinutes(1), TimeProvider.System))
                : RateLimitPartition.GetFixedWindowLimiter(key, _ => Window(limit));

            o.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(http =>
            {
                if (!enabled) return RateLimitPartition.GetNoLimiter("off");
                // Identity providers synchronise in bursts: SCIM gets its own allowance per token (by its non-secret prefix).
                if (http.Request.Path.StartsWithSegments("/scim"))
                {
                    var bearer = http.Request.Headers.Authorization.ToString();
                    var prefix = bearer.Length > 19 ? bearer.Substring(7, 12) : "none";
                    return Limited(http, $"scim:{prefix}", scim);
                }
                var uid = http.User.FindFirst("sub")?.Value;
                var keyId = http.User.FindFirst("api_key")?.Value; // integrations get their own allowance, separate from the person's browser use
                if (keyId is not null) return Limited(http, $"key:{keyId}", authed);
                return uid is not null ? Limited(http, $"user:{uid}", authed) : Limited(http, $"ip:{Ip(http)}", anon);
            });
            // Login, registration and password flows: brute-force protection per client address.
            o.AddPolicy("auth", http => enabled ? Limited(http, $"auth:{Ip(http)}", auth) : RateLimitPartition.GetNoLimiter("off"));
        });
        return services;
    }

    public static IServiceCollection AddApiHealthChecks(this IServiceCollection services)
    {
        services.AddHealthChecks().AddCheck<DatabaseHealthCheck>("database", tags: ["ready"]);
        return services;
    }

    public static IServiceCollection AddApiSwagger(this IServiceCollection services)
    {
        services.AddEndpointsApiExplorer();
        services.AddSwaggerGen(c =>
        {
            c.SwaggerDoc("v1", new OpenApiInfo { Title = "Project Management API", Version = "v1" });
            c.CustomSchemaIds(t => t.FullName!.Replace("ProjectManagement.Application.Features.", "").Replace('+', '.'));
            c.AddSecurityDefinition("Bearer", new OpenApiSecurityScheme
            {
                Type = SecuritySchemeType.Http, Scheme = "bearer", BearerFormat = "JWT", In = ParameterLocation.Header,
                Description = "Paste the access token returned by POST /api/v1/auth/login.",
            });
            c.AddSecurityRequirement(new OpenApiSecurityRequirement
            {
                [new OpenApiSecurityScheme { Reference = new OpenApiReference { Type = ReferenceType.SecurityScheme, Id = "Bearer" } }] = [],
            });
        });
        return services;
    }

    public static IServiceCollection AddForwardedHeadersIfTrusted(this IServiceCollection services, IConfiguration config)
    {
        // Only enable behind a proxy you control; otherwise clients could spoof their address.
        if (!config.GetValue("Proxy:Trust", false)) return services;
        services.Configure<ForwardedHeadersOptions>(o =>
        {
            o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
            o.KnownNetworks.Clear();
            o.KnownProxies.Clear();
        });
        return services;
    }
}

public class DatabaseHealthCheck(AppDbContext db) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken ct = default)
    {
        try { return await db.Database.CanConnectAsync(ct) ? HealthCheckResult.Healthy() : HealthCheckResult.Unhealthy("Cannot connect to the database."); }
        catch (Exception ex) { return HealthCheckResult.Unhealthy("Database check failed.", ex); }
    }
}
