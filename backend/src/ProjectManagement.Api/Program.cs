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
    .WriteTo.Console());

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

if (builder.Environment.IsDevelopment()) builder.Services.AddApiSwagger();

var app = builder.Build();

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
app.UseMiddleware<ApiKeyAuthMiddleware>();
app.UseAuthentication();
app.UseRateLimiter();
app.UseMiddleware<CurrentContextMiddleware>();
app.UseMiddleware<MaintenanceMiddleware>();
app.UseMiddleware<PasswordChangeMiddleware>();
app.UseMiddleware<ConsentMiddleware>();
app.UseAuthorization();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI(c => c.SwaggerEndpoint("/swagger/v1/swagger.json", "Project Management API v1"));
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
