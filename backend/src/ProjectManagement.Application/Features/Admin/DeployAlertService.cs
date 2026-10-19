using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Auth;

namespace ProjectManagement.Application.Features.Admin;

/// <summary>
/// The hosting platform (Railway) telling us a deployment failed or a service crashed: the platform administrators get an e-mail at once, so a
/// broken release or a crashing meeting bot is noticed before customers notice it. The webhook is authorised by the secret token in its address
/// (Ops:DeployWebhookToken); successful deploys and other events are accepted and ignored.
/// </summary>
public class DeployAlertService(IAppDbContext db, IEmailSender email, IConfiguration config, ILogger<DeployAlertService> log)
{
    private static readonly ConcurrentDictionary<string, DateTime> Sent = new();
    private static readonly string[] Bad = ["FAILED", "CRASHED", "BUILD_FAILED", "DEPLOY_FAILED", "OOM", "UNHEALTHY"];

    public record Alert(string Service, string Status, string? Environment, string? Commit, string? Url);

    /// <summary>What the webhook says, or null when it is not about a failure.</summary>
    public static Alert? Parse(string body)
    {
        JsonElement root;
        try { root = JsonDocument.Parse(body).RootElement; } catch (JsonException) { return null; }
        if (root.ValueKind != JsonValueKind.Object) return null;
        string? S(JsonElement o, params string[] path)
        {
            var cur = o;
            foreach (var p in path) { if (cur.ValueKind != JsonValueKind.Object || !cur.TryGetProperty(p, out cur)) return null; }
            return cur.ValueKind == JsonValueKind.String ? cur.GetString() : null;
        }
        // Railway has sent both {"type":"DEPLOY","status":"FAILED",...} and {"type":"Deployment.failed","details":{...},"resource":{...}}.
        var status = (S(root, "status") ?? S(root, "details", "status") ?? S(root, "deployment", "status") ?? "").ToUpperInvariant();
        var type = S(root, "type") ?? "";
        if (status.Length == 0 && type.Contains('.')) status = type[(type.LastIndexOf('.') + 1)..].ToUpperInvariant();
        if (type.EndsWith("crashed", StringComparison.OrdinalIgnoreCase)) status = "CRASHED";
        if (!Bad.Any(b => status.Contains(b, StringComparison.Ordinal))) return null;
        var service = S(root, "service", "name") ?? S(root, "resource", "service", "name") ?? S(root, "details", "serviceName") ?? "a service";
        var env = S(root, "environment", "name") ?? S(root, "resource", "environment", "name");
        var commit = S(root, "deployment", "meta", "commitMessage") ?? S(root, "details", "commitMessage");
        var url = S(root, "deployment", "url") ?? S(root, "details", "url");
        return new Alert(Cut(service, 80), status, env is null ? null : Cut(env, 40), commit is null ? null : Cut(commit.Split('\n')[0], 140), url);
    }

    public async Task<bool> ReceiveAsync(string token, string body, CancellationToken ct)
    {
        var expected = config["Ops:DeployWebhookToken"];
        if (expected is not { Length: >= 24 } || !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(token), Encoding.UTF8.GetBytes(expected)))
            throw new NotFoundException("Not found.");
        if (body.Length > 256 * 1024) throw new ValidationException("body", "Too large.");
        if (Parse(body) is not { } alert) return false;
        // The same failure is reported once every 15 minutes at most (Railway retries, and a crash loop repeats).
        var key = $"{alert.Service}|{alert.Status}";
        var now = DateTime.UtcNow;
        if (Sent.TryGetValue(key, out var last) && now - last < TimeSpan.FromMinutes(15)) return false;
        Sent[key] = now;
        var to = await db.Users.IgnoreQueryFilters().AsNoTracking().Where(u => u.IsPlatformAdmin && u.IsActive).Select(u => u.Email).Take(20).ToListAsync(ct);
        if (config["Ops:AlertEmail"] is { Length: > 3 } extra && extra.Contains('@')) to.Add(extra.Trim());
        var what = alert.Status.Contains("CRASH", StringComparison.Ordinal) ? "crashed" : "failed to deploy";
        var subject = $"{alert.Service} {what}{(alert.Environment is null ? "" : $" ({alert.Environment})")}";
        var text = $"{alert.Service} {what}{(alert.Environment is null ? "" : $" in {alert.Environment}")}. Status: {alert.Status}." +
            (alert.Commit is null ? "" : $" Change: {alert.Commit}.") + " The previous deployment keeps running when a new one fails; a crash restarts the service.";
        var html = EmailTemplates.Wrap(subject, "Hello,", text, "Open the hosting dashboard", alert.Url is { } u && u.StartsWith("https://", StringComparison.Ordinal) ? u : "https://railway.com/dashboard");
        foreach (var address in to.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            try { await email.SendAsync(new EmailMessage(address, subject, html, text, "ops-alert"), ct); }
            catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "Deploy alert e-mail could not be sent"); }
        }
        log.LogWarning("Deploy alert: {Service} {Status}", alert.Service, alert.Status);
        return true;
    }

    private static string Cut(string s, int max) => s.Length <= max ? s : s[..max];
}
