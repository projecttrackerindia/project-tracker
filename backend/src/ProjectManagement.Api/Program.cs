using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using ProjectManagement.Api.Extensions;
using ProjectManagement.Api.Middleware;
using ProjectManagement.Application;
using ProjectManagement.Infrastructure;
using ProjectManagement.Infrastructure.Persistence;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

builder.Host.UseSerilog((context, services, cfg) => cfg
    .ReadFrom.Configuration(context.Configuration)
    .Enrich.FromLogContext()
    .Enrich.With<TraceEnricher>()
    // Locally: readable text. Deployed: one JSON line per event with a real severity ("warn" is not "info").
    .WriteTo.Console(context.HostingEnvironment.IsDevelopment() || context.Configuration["Logging:Format"] == "text"
        ? new Serilog.Formatting.Display.MessageTemplateTextFormatter("[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}{Exception}")
        : new ProjectManagement.Api.Logging.JsonLineFormatter()));

builder.Services
    .AddApplication()
    .AddInfrastructure(builder.Configuration)
    .AddApiControllers(builder.Configuration)
    .AddJwtAuthentication(builder.Configuration, builder.Environment)
    .AddApiCors(builder.Configuration)
    .AddApiRateLimiting(builder.Configuration)
    .AddApiHealthChecks()
    .AddTelemetry(builder.Configuration, builder.Environment)
    .AddForwardedHeadersIfTrusted(builder.Configuration);

// The API description is published in Development, and elsewhere only when Swagger:Enabled=true (customers who use API keys may need it).
// Api:PublishDocs=false hides it everywhere.
var publishDocs = (builder.Environment.IsDevelopment() || builder.Configuration.GetValue("Swagger:Enabled", false))
    && builder.Configuration.GetValue("Api:PublishDocs", true);
if (publishDocs) builder.Services.AddApiSwagger();

var app = builder.Build();

app.UseResponseCompression();
app.UseMiddleware<MetricsMiddleware>();
// Outside the exception handler, so each request is logged with the status the caller really got: an expected refusal (401, 403,
// 404, 422...) is an ordinary line, not a "500" error with a stack trace. Unexpected failures are logged by ApiExceptionMiddleware.
app.UseSerilogRequestLogging();
app.UseMiddleware<ApiExceptionMiddleware>();
app.UseMiddleware<SecurityHeadersMiddleware>();
if (app.Configuration.GetValue("Proxy:Trust", false)) app.UseForwardedHeaders();
if (!app.Environment.IsDevelopment() && app.Configuration.GetValue("Https:Redirect", false))
{
    app.UseHsts();
    app.UseHttpsRedirection();
}
app.UseCors();
app.UseMiddleware<McpChallengeMiddleware>();
app.UseMiddleware<ApiKeyAuthMiddleware>();
app.UseAuthentication();
app.UseRateLimiter();
app.UseMiddleware<CurrentContextMiddleware>();
app.UseMiddleware<MaintenanceMiddleware>();
app.UseMiddleware<PasswordChangeMiddleware>();
app.UseMiddleware<ConsentMiddleware>();
app.UseAuthorization();
app.UseMiddleware<IdempotencyMiddleware>();

if (publishDocs)
{
    app.UseSwagger(c => c.RouteTemplate = "api/openapi/{documentName}.json");
    app.UseSwaggerUI(c =>
    {
        c.RoutePrefix = "api/docs";
        c.DocumentTitle = "Project Tracker API";
        c.SwaggerEndpoint("/api/openapi/v1.json", "Project Tracker API v1");
        c.DisplayRequestDuration();
    });
}

app.MapControllers();
app.MapHub<ProjectManagement.Api.Realtime.ChatHub>("/hubs/chat");
app.MapHealthChecks("/health");
app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = _ => false });
app.MapHealthChecks("/health/ready", new HealthCheckOptions { Predicate = c => c.Tags.Contains("ready") });

WarnAboutUnsafeSettings(app);
await DatabaseInitializer.InitializeAsync(app.Services);
await app.RunAsync();

// Settings that are fine on a developer's machine and dangerous anywhere else. Logged loudly rather than refused, so an existing
// deployment keeps starting; each one should be fixed before real customers use it.
static void WarnAboutUnsafeSettings(WebApplication app)
{
    if (app.Environment.IsDevelopment()) return;
    var config = app.Configuration;
    var log = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Startup");
    if ((config["Email:Provider"] ?? "Log").Equals("Log", StringComparison.OrdinalIgnoreCase))
        log.LogCritical("Email:Provider is \"Log\" outside Development: no email (verification, password reset, invitations, security alerts) is delivered. Set Email:Provider to Smtp or Resend.");
    if (!(config["Billing:Provider"] ?? "Mock").Equals("Razorpay", StringComparison.OrdinalIgnoreCase) && config.GetValue<bool>("Billing:Upi:Enabled"))
        log.LogInformation("Paid plans are paid by UPI QR (Billing:Upi) and switched on when a platform administrator confirms the payment.");
    else if (!(config["Billing:Provider"] ?? "Mock").Equals("Razorpay", StringComparison.OrdinalIgnoreCase))
        log.LogCritical("Billing:Provider is the simulated (Mock) provider outside Development: every paid plan is granted without any payment. Set Billing:Provider=Razorpay.");
    if (string.IsNullOrWhiteSpace(config["Mfa:EncryptionKey"]))
        log.LogCritical("Mfa:EncryptionKey is empty outside Development: stored secrets (authenticator keys, single sign-on client secrets) are encrypted with a key derived from Jwt:SigningKey, so rotating the signing key makes them all unreadable. Set Mfa:EncryptionKey to the key currently in effect before rotating.");
}

/// <summary>Exposed for WebApplicationFactory-based integration tests.</summary>
public partial class Program;
