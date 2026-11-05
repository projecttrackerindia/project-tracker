using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using ProjectManagement.Api.Extensions;
using ProjectManagement.Api.Middleware;
using ProjectManagement.Application;
using ProjectManagement.Infrastructure;
using ProjectManagement.Infrastructure.Persistence;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

// Unexpected errors go to a Sentry-compatible service when Sentry__Dsn is set (off otherwise); see docs/ops.md › Error tracking.
var errorReporter = ProjectManagement.Api.Logging.ErrorReporter.FromConfiguration(builder.Configuration, builder.Environment.EnvironmentName);
builder.Services.AddSingleton(errorReporter);
builder.Services.AddSingleton<ProjectManagement.Api.Logging.WebVitalsStore>();

builder.Host.UseSerilog((context, services, cfg) => cfg
    .ReadFrom.Configuration(context.Configuration)
    .Enrich.FromLogContext()
    .Enrich.With<TraceEnricher>()
    // Locally: readable text. Deployed: one JSON line per event with a real severity ("warn" is not "info").
    .WriteTo.Console(context.HostingEnvironment.IsDevelopment() || context.Configuration["Logging:Format"] == "text"
        ? new Serilog.Formatting.Display.MessageTemplateTextFormatter("[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}{Exception}")
        : new ProjectManagement.Api.Logging.JsonLineFormatter())
    .WriteTo.Sink(new ProjectManagement.Api.Logging.ErrorReporterSink(errorReporter), Serilog.Events.LogEventLevel.Error));

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
ProductionSafety.Validate(app.Configuration, app.Environment.EnvironmentName);

// With the master key held by Google Cloud KMS, unwrap it now: a wrong key name or a missing permission stops the start with a clear message,
// rather than every encrypted value failing later.
if (!string.IsNullOrWhiteSpace(app.Configuration["Mfa:EncryptionKeyWrapped"]))
{
    var protector = app.Services.GetRequiredService<ProjectManagement.Application.Abstractions.ISecretProtector>();
    if (protector.Unprotect(protector.Protect("kms-probe")) != "kms-probe") throw new InvalidOperationException("The KMS master key does not round-trip.");
}

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

await DatabaseInitializer.InitializeAsync(app.Services);
await app.RunAsync();

/// <summary>Exposed for WebApplicationFactory-based integration tests.</summary>
public partial class Program;

