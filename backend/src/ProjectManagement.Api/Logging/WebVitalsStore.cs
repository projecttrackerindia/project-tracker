using System.Collections.Concurrent;
using System.Text.RegularExpressions;

namespace ProjectManagement.Api.Logging;

public record WebVitalSample(string Name, double Value);
public record WebVitalsBeacon(string? Page, string? Device, IReadOnlyList<WebVitalSample>? Metrics);
public record WebVitalRow(string Page, string Device, string Metric, int Count, double P75, string Rating);
public record WebVitalsReport(int Days, IReadOnlyList<WebVitalRow> Rows, int Samples);

/// <summary>
/// Real-user speed (Core Web Vitals) kept per workspace: page pattern (ids removed), device class and metric, the newest 300
/// values each for up to 7 days. Nothing personal is stored: no user, no URL query, no address. A workspace only ever reads its
/// own numbers; the platform view only sees page patterns. Kept in memory on this server (resets on restart).
/// </summary>
public sealed partial class WebVitalsStore
{
    public static readonly string[] Metrics = ["LCP", "INP", "CLS", "TTFB", "FCP"];
    public static readonly string[] Devices = ["mobile", "tablet", "desktop"];
    private const int PerKey = 300, KeysPerTenant = 400, MaxKeys = 20_000;
    private static readonly TimeSpan Keep = TimeSpan.FromDays(7);

    private sealed class Series { public readonly Queue<(DateTime At, double Value)> Values = new(); }
    private readonly ConcurrentDictionary<(Guid Tenant, string Page, string Device, string Metric), Series> _data = new();
    private readonly Func<DateTime> _now;

    public WebVitalsStore() : this(() => DateTime.UtcNow) { }
    public WebVitalsStore(Func<DateTime> now) => _now = now;

    [GeneratedRegex(@"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", RegexOptions.CultureInvariant)] private static partial Regex Guid36();
    [GeneratedRegex(@"/[^/]*\d[^/]*", RegexOptions.CultureInvariant)] private static partial Regex SegmentWithDigit();
    [GeneratedRegex(@"[^a-z0-9/_:.-]", RegexOptions.CultureInvariant)] private static partial Regex Odd();

    /// <summary>"/projects/1b4e…/board?x=1" → "/projects/:id/board". Any path segment holding a digit becomes ":id".</summary>
    public static string NormalizePage(string? page)
    {
        var p = (page ?? "/").Split('?', 2)[0].Split('#', 2)[0].Trim().ToLowerInvariant();
        if (!p.StartsWith('/')) p = "/" + p;
        p = Guid36().Replace(p, ":id");
        p = SegmentWithDigit().Replace(p, "/:id");
        p = Odd().Replace(p, "");
        if (p.Length > 1) p = p.TrimEnd('/');
        return p.Length > 80 ? p[..80] : p;
    }

    /// <summary>Good / needs-improvement / poor, using web.dev's thresholds on the 75th percentile.</summary>
    public static string Rate(string metric, double p75) => metric switch
    {
        "LCP" => p75 <= 2500 ? "good" : p75 <= 4000 ? "needs-improvement" : "poor",
        "INP" => p75 <= 200 ? "good" : p75 <= 500 ? "needs-improvement" : "poor",
        "CLS" => p75 <= 0.1 ? "good" : p75 <= 0.25 ? "needs-improvement" : "poor",
        "TTFB" => p75 <= 800 ? "good" : p75 <= 1800 ? "needs-improvement" : "poor",
        "FCP" => p75 <= 1800 ? "good" : p75 <= 3000 ? "needs-improvement" : "poor",
        _ => "unknown",
    };

    /// <summary>Stores the valid samples of one beacon; returns how many were kept.</summary>
    public int Record(Guid tenantId, WebVitalsBeacon beacon)
    {
        if (beacon.Metrics is not { Count: > 0 } metrics) return 0;
        var page = NormalizePage(beacon.Page);
        var device = beacon.Device is { } d && Devices.Contains(d) ? d : "desktop";
        var now = _now();
        var kept = 0;
        foreach (var m in metrics.Take(10))
        {
            var name = (m.Name ?? "").ToUpperInvariant();
            if (!Metrics.Contains(name) || double.IsNaN(m.Value) || m.Value < 0 || m.Value > (name == "CLS" ? 10 : 120_000)) continue;
            var key = (tenantId, page, device, name);
            if (!_data.TryGetValue(key, out var series))
            {
                if (_data.Count >= MaxKeys || _data.Keys.Count(k => k.Tenant == tenantId) >= KeysPerTenant) continue;
                series = _data.GetOrAdd(key, _ => new Series());
            }
            lock (series)
            {
                series.Values.Enqueue((now, m.Value));
                while (series.Values.Count > PerKey || (series.Values.Count > 0 && now - series.Values.Peek().At > Keep)) series.Values.Dequeue();
            }
            kept++;
        }
        return kept;
    }

    /// <summary>The 75th percentile per page, device and metric over the last <paramref name="days"/> days, for one workspace or (null) all.</summary>
    public WebVitalsReport Report(Guid? tenantId, int days = 7)
    {
        days = Math.Clamp(days, 1, 7);
        var since = _now() - TimeSpan.FromDays(days);
        var grouped = new Dictionary<(string Page, string Device, string Metric), List<double>>();
        foreach (var (key, series) in _data)
        {
            if (tenantId is { } t && key.Tenant != t) continue;
            double[] values;
            lock (series) values = series.Values.Where(v => v.At >= since).Select(v => v.Value).ToArray();
            if (values.Length == 0) continue;
            var k = (key.Page, key.Device, key.Metric);
            if (!grouped.TryGetValue(k, out var list)) grouped[k] = list = [];
            list.AddRange(values);
        }
        var rows = grouped.Select(g =>
        {
            var sorted = g.Value.OrderBy(v => v).ToArray();
            var p75 = sorted[Math.Clamp((int)Math.Ceiling(sorted.Length * 0.75) - 1, 0, sorted.Length - 1)];
            p75 = g.Key.Metric == "CLS" ? Math.Round(p75, 3) : Math.Round(p75);
            return new WebVitalRow(g.Key.Page, g.Key.Device, g.Key.Metric, sorted.Length, p75, Rate(g.Key.Metric, p75));
        }).OrderByDescending(r => r.Count).ThenBy(r => r.Page).ThenBy(r => r.Device).ThenBy(r => r.Metric).Take(500).ToList();
        return new WebVitalsReport(days, rows, rows.Sum(r => r.Count));
    }
}
