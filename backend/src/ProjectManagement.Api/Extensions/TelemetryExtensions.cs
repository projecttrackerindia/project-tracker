using System.Diagnostics;
using Microsoft.AspNetCore.Http;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using ProjectManagement.Application.Common;
using Serilog.Core;
using Serilog.Events;

namespace ProjectManagement.Api.Extensions;

public static class TelemetryExtensions
{
    /// <summary>True when an OTLP collector has been configured (standard OTEL_EXPORTER_OTLP_ENDPOINT, or Telemetry:Otlp:Endpoint).</summary>
    public static bool TelemetryEnabled(IConfiguration config) =>
        !string.IsNullOrWhiteSpace(config["OTEL_EXPORTER_OTLP_ENDPOINT"]) || !string.IsNullOrWhiteSpace(config["Telemetry:Otlp:Endpoint"]);

    /// <summary>
    /// OpenTelemetry traces and metrics, exported over OTLP to whatever collector is configured (Grafana, Jaeger, Datadog, Azure Monitor,
    /// ...). Off unless an endpoint is set, so a plain install sends nothing anywhere.
    /// </summary>
    public static IServiceCollection AddTelemetry(this IServiceCollection services, IConfiguration config, IHostEnvironment env)
    {
        if (!TelemetryEnabled(config)) return services;

        // The endpoint can also come from appsettings; the SDK itself only reads the environment variable.
        if (string.IsNullOrWhiteSpace(config["OTEL_EXPORTER_OTLP_ENDPOINT"]) && config["Telemetry:Otlp:Endpoint"] is { } fromSettings)
            Environment.SetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT", fromSettings);

        var version = typeof(TelemetryExtensions).Assembly.GetName().Version?.ToString(3) ?? "1.0.0";
        services.AddOpenTelemetry()
            .ConfigureResource(r => r.AddService(config["OTEL_SERVICE_NAME"] ?? "projectmanagement-api", serviceVersion: version)
                .AddAttributes([new("deployment.environment", env.EnvironmentName)]))
            .WithTracing(t => t
                .AddAspNetCoreInstrumentation(o =>
                {
                    // Health probes and static files would drown the interesting requests.
                    o.Filter = ctx => !ctx.Request.Path.StartsWithSegments("/health") && ctx.Request.Path.StartsWithSegments("/api");
                    o.RecordException = true;
                })
                .AddHttpClientInstrumentation()
                .AddSource("Npgsql")           // database calls (PostgreSQL)
                .AddSource(AppTelemetry.Name)) // background jobs
            .WithMetrics(m => m
                .AddAspNetCoreInstrumentation()
                .AddHttpClientInstrumentation()
                .AddRuntimeInstrumentation()
                .AddMeter(AppTelemetry.Name))
            .UseOtlpExporter();
        return services;
    }
}

/// <summary>Puts the current trace and span id on every log line, so a log entry can be found from its trace and the other way round.</summary>
public class TraceEnricher : ILogEventEnricher
{
    public void Enrich(LogEvent logEvent, ILogEventPropertyFactory factory)
    {
        var activity = Activity.Current;
        if (activity is null) return;
        logEvent.AddPropertyIfAbsent(factory.CreateProperty("TraceId", activity.TraceId.ToString()));
        logEvent.AddPropertyIfAbsent(factory.CreateProperty("SpanId", activity.SpanId.ToString()));
    }
}
