using System.Diagnostics;
using System.Diagnostics.Metrics;

namespace ProjectManagement.Application.Common;

/// <summary>
/// The application's own traces and metrics, on top of what ASP.NET, HTTP and the database report by themselves. Nothing is sent anywhere
/// unless an OpenTelemetry endpoint is configured (see docs in README); these calls are then close to free.
/// </summary>
public static class AppTelemetry
{
    public const string Name = "ProjectManagement";

    /// <summary>Spans for work that is not an HTTP request (background jobs).</summary>
    public static readonly ActivitySource Source = new(Name);

    private static readonly Meter Meter = new(Name);

    /// <summary>Sign-ins by outcome: success, wrong_password, wrong_code, locked, mfa_required.</summary>
    public static readonly Counter<long> Logins = Meter.CreateCounter<long>("pm.auth.logins", description: "Sign-in attempts by outcome");
    /// <summary>Webhook requests by outcome: succeeded, retry, failed.</summary>
    public static readonly Counter<long> WebhookDeliveries = Meter.CreateCounter<long>("pm.webhook.deliveries", description: "Webhook delivery attempts by outcome");
    /// <summary>Generated reports by outcome: ready, failed.</summary>
    public static readonly Counter<long> ReportExports = Meter.CreateCounter<long>("pm.report.exports", description: "Report exports by outcome");
    /// <summary>Notification e-mails by outcome: sent, failed.</summary>
    public static readonly Counter<long> Emails = Meter.CreateCounter<long>("pm.email.sent", description: "Notification e-mails by outcome");
    /// <summary>How long a background round takes, by worker.</summary>
    public static readonly Histogram<double> WorkerRoundSeconds = Meter.CreateHistogram<double>("pm.worker.round.duration", unit: "s", description: "Duration of one background worker round");

    public static void Count(Counter<long> counter, string outcome) => counter.Add(1, new KeyValuePair<string, object?>("outcome", outcome));
}
