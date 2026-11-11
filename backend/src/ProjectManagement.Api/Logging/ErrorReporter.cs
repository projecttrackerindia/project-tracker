using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Serilog.Core;
using Serilog.Events;

namespace ProjectManagement.Api.Logging;

/// <summary>A Sentry-style DSN (<c>https://PUBLIC_KEY@host/[path/]PROJECT_ID</c>); works with Sentry, GlitchTip and self-hosted Sentry.</summary>
public sealed record ErrorDsn(Uri EnvelopeUri, string PublicKey)
{
    public static ErrorDsn? Parse(string? dsn)
    {
        if (string.IsNullOrWhiteSpace(dsn) || !Uri.TryCreate(dsn.Trim(), UriKind.Absolute, out var u)) return null;
        if (u.Scheme is not ("https" or "http") || string.IsNullOrEmpty(u.UserInfo)) return null;
        var key = u.UserInfo.Split(':')[0];
        var path = u.AbsolutePath.Trim('/');
        var cut = path.LastIndexOf('/');
        var project = cut < 0 ? path : path[(cut + 1)..];
        var prefix = cut < 0 ? "" : "/" + path[..cut];
        if (key.Length == 0 || project.Length == 0 || !project.All(char.IsLetterOrDigit)) return null;
        var port = u.IsDefaultPort ? "" : ":" + u.Port;
        return new ErrorDsn(new Uri($"{u.Scheme}://{u.Host}{port}{prefix}/api/{project}/envelope/"), key);
    }
}

/// <summary>What an app sends to POST /api/v1/telemetry/errors.</summary>
public record ClientErrorReport(string? Type, string? Message, string? Stack, string? Page, string? App, string? Release, string? Device);

/// <summary>Removes personal data before anything leaves the server: e-mail addresses, phone-like numbers, tokens and secrets.</summary>
public static partial class ErrorScrubber
{
    [GeneratedRegex(@"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", RegexOptions.CultureInvariant)] private static partial Regex Email();
    [GeneratedRegex(@"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*", RegexOptions.CultureInvariant)] private static partial Regex Jwt();
    [GeneratedRegex(@"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}", RegexOptions.CultureInvariant)] private static partial Regex AuthHeader();
    [GeneratedRegex(@"(?i)\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|cookie|otp)\b(\s*[=:]\s*)(""[^""]*""|'[^']*'|[^\s,;&]+)", RegexOptions.CultureInvariant)] private static partial Regex KeyValue();
    [GeneratedRegex(@"\bpmk_[A-Za-z0-9_-]{8,}", RegexOptions.CultureInvariant)] private static partial Regex ApiKey();
    [GeneratedRegex(@"(?<![\w-])\+?\d[\d -]{8,}\d(?![\w-])", RegexOptions.CultureInvariant)] private static partial Regex Phone();

    public static string Scrub(string? text)
    {
        if (string.IsNullOrEmpty(text)) return "";
        var s = text.Length > 8000 ? text[..8000] : text;
        s = Jwt().Replace(s, "[token]");
        s = AuthHeader().Replace(s, m => m.Groups[1].Value + " [redacted]");
        s = ApiKey().Replace(s, "[api-key]");
        s = KeyValue().Replace(s, m => m.Groups[1].Value + m.Groups[2].Value + "[redacted]");
        s = Email().Replace(s, "[email]");
        s = Phone().Replace(s, "[number]");
        return s;
    }

    /// <summary>A path without its query string, and with long numbers replaced (ids stay: they are GUIDs, not personal data).</summary>
    public static string ScrubPath(string? path) => Scrub((path ?? "").Split('?', 2)[0]);
}

/// <summary>
/// Sends unexpected server errors to a Sentry-compatible service. Off unless <c>Sentry:Dsn</c> (env <c>Sentry__Dsn</c>) is set.
/// Events carry the release (<c>APP_RELEASE</c>, the image tag) and environment; never request bodies, headers, cookies, query
/// strings, IP addresses, names or e-mail addresses. Sending happens in the background, at most 30 events a minute.
/// </summary>
public sealed class ErrorReporter
{
    private readonly ErrorDsn? _dsn;
    private readonly HttpClient _http;
    private readonly string _release, _environment;
    private readonly SemaphoreSlim _inFlight = new(4);
    private readonly object _gate = new();
    private DateTime _windowStart = DateTime.MinValue;
    private int _windowCount;
    public const int PerMinute = 30;

    public ErrorReporter(string? dsn, string? release, string? environment, HttpMessageHandler? handler = null)
    {
        _dsn = ErrorDsn.Parse(dsn);
        _release = string.IsNullOrWhiteSpace(release) ? "dev" : release.Trim();
        _environment = string.IsNullOrWhiteSpace(environment) ? "production" : environment.Trim().ToLowerInvariant();
        _http = handler is null ? new HttpClient() : new HttpClient(handler);
        _http.Timeout = TimeSpan.FromSeconds(10);
    }

    public static ErrorReporter FromConfiguration(IConfiguration config, string environmentName)
    {
        static string? Set(string? v) => string.IsNullOrWhiteSpace(v) ? null : v;
        return new(config["Sentry:Dsn"], Set(config["Sentry:Release"]) ?? Set(config["APP_RELEASE"]),
            Set(config["Sentry:Environment"]) ?? environmentName);
    }

    public bool Enabled => _dsn is not null;
    public string Release => _release;

    /// <summary>Queues one error; returns the event id, or null when off or over the rate limit.</summary>
    public string? Capture(Exception? exception, string? message, IReadOnlyDictionary<string, string?>? tags = null)
    {
        if (_dsn is null || !Admit()) return null;
        var id = Guid.NewGuid().ToString("N");
        var body = BuildEnvelope(id, exception, message, tags, DateTime.UtcNow);
        _ = SendAsync(body);
        return id;
    }

    /// <summary>Sends and waits (tests and short-lived processes).</summary>
    public async Task<bool> CaptureAndSendAsync(Exception? exception, string? message, IReadOnlyDictionary<string, string?>? tags = null)
    {
        if (_dsn is null || !Admit()) return false;
        return await SendAsync(BuildEnvelope(Guid.NewGuid().ToString("N"), exception, message, tags, DateTime.UtcNow));
    }

    private bool Admit()
    {
        lock (_gate)
        {
            var now = DateTime.UtcNow;
            if (now - _windowStart > TimeSpan.FromMinutes(1)) { _windowStart = now; _windowCount = 0; }
            return ++_windowCount <= PerMinute;
        }
    }

    /// <summary>
    /// An error from one of our apps (web, desktop, Android, iOS), relayed through the API so the apps need no DSN, no extra CSP
    /// entry and no third-party script. Scrubbed again here; the app's own release (from its build) is kept if it sent one.
    /// </summary>
    public string? CaptureClient(ClientErrorReport report)
    {
        if (_dsn is null || !Admit()) return null;
        var id = Guid.NewGuid().ToString("N");
        var frames = new JsonArray();
        foreach (var line in (report.Stack ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Take(40).Reverse())
            frames.Add(new JsonObject { ["function"] = ErrorScrubber.ScrubPath(line.Length > 300 ? line[..300] : line), ["in_app"] = true });
        var value = new JsonObject
        {
            ["type"] = ErrorScrubber.Scrub(string.IsNullOrWhiteSpace(report.Type) ? "Error" : report.Type.Length > 100 ? report.Type[..100] : report.Type),
            ["value"] = ErrorScrubber.Scrub(report.Message),
        };
        if (frames.Count > 0) value["stacktrace"] = new JsonObject { ["frames"] = frames };
        var app = report.App is "web" or "desktop" or "android" or "ios" ? report.App : "web";
        var tags = new Dictionary<string, string?> { ["app"] = app, ["path"] = report.Page, ["device"] = report.Device };
        var release = report.Release is { Length: > 0 and <= 64 } r ? r : null;
        _ = SendAsync(BuildEnvelope(id, null, null, tags, DateTime.UtcNow, new JsonArray(value), "javascript", release, "projecttracker." + app));
        return id;
    }

    public string BuildEnvelope(string eventId, Exception? exception, string? message, IReadOnlyDictionary<string, string?>? tags, DateTime utcNow,
        JsonArray? clientValues = null, string platform = "csharp", string? release = null, string logger = "projecttracker.api")
    {
        var ev = new JsonObject
        {
            ["event_id"] = eventId,
            ["timestamp"] = utcNow.ToString("O"),
            ["platform"] = platform,
            ["level"] = "error",
            ["logger"] = logger,
            ["release"] = release ?? _release,
            ["environment"] = _environment,
            ["server_name"] = platform == "csharp" ? "api" : null,
        };
        if (!string.IsNullOrWhiteSpace(message)) ev["message"] = new JsonObject { ["formatted"] = ErrorScrubber.Scrub(message) };
        if (clientValues is not null) ev["exception"] = new JsonObject { ["values"] = clientValues };
        else if (exception is not null)
        {
            var values = new JsonArray();
            // Sentry wants the innermost exception last.
            var chain = new List<Exception>();
            for (var e = exception; e is not null && chain.Count < 5; e = e.InnerException) chain.Add(e);
            chain.Reverse();
            foreach (var e in chain)
            {
                var frames = new JsonArray();
                var st = new System.Diagnostics.StackTrace(e, false);
                foreach (var f in Enumerable.Reverse(st.GetFrames()).TakeLast(50))
                {
                    var m = f.GetMethod();
                    if (m is null) continue;
                    var module = m.DeclaringType?.FullName ?? "";
                    frames.Add(new JsonObject
                    {
                        ["function"] = m.Name, ["module"] = module,
                        ["in_app"] = module.StartsWith("ProjectManagement", StringComparison.Ordinal),
                    });
                }
                var item = new JsonObject { ["type"] = e.GetType().FullName, ["value"] = ErrorScrubber.Scrub(e.Message) };
                if (frames.Count > 0) item["stacktrace"] = new JsonObject { ["frames"] = frames };
                values.Add(item);
            }
            ev["exception"] = new JsonObject { ["values"] = values };
        }
        if (tags is { Count: > 0 })
        {
            var t = new JsonObject();
            foreach (var (k, v) in tags)
                if (!string.IsNullOrWhiteSpace(v)) t[k] = k == "path" ? ErrorScrubber.ScrubPath(v) : ErrorScrubber.Scrub(v);
            ev["tags"] = t;
        }
        var header = new JsonObject { ["event_id"] = eventId, ["sent_at"] = utcNow.ToString("O") };
        var payload = ev.ToJsonString();
        var item1 = new JsonObject { ["type"] = "event", ["length"] = Encoding.UTF8.GetByteCount(payload) };
        return header.ToJsonString() + "\n" + item1.ToJsonString() + "\n" + payload + "\n";
    }

    private async Task<bool> SendAsync(string envelope)
    {
        if (_dsn is null || !await _inFlight.WaitAsync(0)) return false;
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, _dsn.EnvelopeUri)
            {
                Content = new StringContent(envelope, Encoding.UTF8, "application/x-sentry-envelope"),
            };
            req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/x-sentry-envelope");
            req.Headers.TryAddWithoutValidation("X-Sentry-Auth",
                $"Sentry sentry_version=7, sentry_client=projecttracker-api/1.0, sentry_key={_dsn.PublicKey}");
            using var res = await _http.SendAsync(req);
            return res.IsSuccessStatusCode;
        }
        catch { return false; }   // reporting must never break or log-loop the app
        finally { _inFlight.Release(); }
    }
}

/// <summary>Serilog sink: every Error/Fatal log event (with or without an exception) becomes one reported error.</summary>
public sealed class ErrorReporterSink(ErrorReporter reporter) : ILogEventSink
{
    private static readonly string[] TagProperties = ["RequestPath", "Path", "Method", "SourceContext", "TraceId"];

    public void Emit(LogEvent logEvent)
    {
        if (!reporter.Enabled || logEvent.Level < LogEventLevel.Error) return;
        // Never report about the reporter's own traffic.
        if (logEvent.Properties.TryGetValue("SourceContext", out var sc) && sc.ToString().Contains("System.Net.Http", StringComparison.Ordinal)) return;
        var tags = new Dictionary<string, string?>();
        foreach (var name in TagProperties)
            if (logEvent.Properties.TryGetValue(name, out var v))
                tags[name switch { "RequestPath" or "Path" => "path", "Method" => "method", "SourceContext" => "logger", _ => "trace_id" }] =
                    v is ScalarValue { Value: var s } ? s?.ToString() : v.ToString().Trim('"');
        reporter.Capture(logEvent.Exception, logEvent.RenderMessage(), tags);
    }
}
