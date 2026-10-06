using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Sso;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Notifications;

/// <summary>
/// What the app sends e-mail through. Around the real provider it adds what a mail system needs to be trusted: addresses that bounced or complained are
/// never written to again, every attempt is logged for the administrator, and an important message (a verification or reset link, an invitation, a
/// security alert) that could not be delivered is kept and tried again a few times instead of being lost. Logging never gets in the way of sending.
/// </summary>
public class ReliableEmailSender(IEmailTransport inner, IServiceScopeFactory scopes, TimeProvider clock, ILogger<ReliableEmailSender> log) : IEmailSender
{
    public string Name => inner.Name;

    public async Task SendAsync(EmailMessage message, CancellationToken ct = default)
    {
        var to = Text.NormalizeEmail(message.To);
        if (await IsSuppressedAsync(to))
        {
            await WriteAsync(message, EmailStatus.Suppressed, 0, "This address no longer receives e-mail (it bounced or was reported).", keepBody: false);
            return;
        }
        try
        {
            await inner.SendAsync(message, ct);
            await WriteAsync(message, EmailStatus.Sent, 1, null, keepBody: false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            var reason = Trim(ex.GetType().Name + ": " + ex.Message);
            if (message.Kind is null) { await WriteAsync(message, EmailStatus.Failed, 1, reason, keepBody: false); throw; }
            // Important: keep it, and the worker will try again.
            await WriteAsync(message, EmailStatus.Queued, 1, reason, keepBody: true);
        }
    }

    private static string Trim(string s) => s.Length > 280 ? s[..280] : s;

    private async Task<bool> IsSuppressedAsync(string to)
    {
        try { using var scope = scopes.CreateScope(); return await scope.ServiceProvider.GetRequiredService<IAppDbContext>().EmailSuppressions.AnyAsync(s => s.Email == to); }
        catch (Exception ex) { log.LogWarning(ex, "Could not check the e-mail suppression list"); return false; }
    }

    private async Task WriteAsync(EmailMessage m, EmailStatus status, int attempts, string? error, bool keepBody)
    {
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<IAppDbContext>();
            var now = clock.GetUtcNow().UtcDateTime;
            db.EmailLogs.Add(new EmailLog
            {
                ToEmail = Text.NormalizeEmail(m.To), Subject = Text.Truncate(m.Subject, 300) ?? "", Kind = m.Kind, Status = status, Attempts = attempts, CreatedAt = now,
                SentAt = status == EmailStatus.Sent ? now : null, NextAttemptAt = status == EmailStatus.Queued ? now.AddMinutes(1) : null, Error = error,
                Html = keepBody ? m.Html : null, Text = keepBody ? m.Text : null, HeadersJson = keepBody && m.Headers is { Count: > 0 } ? JsonSerializer.Serialize(m.Headers) : null,
            });
            await db.SaveChangesAsync();
        }
        catch (Exception ex) { log.LogWarning(ex, "Could not write the e-mail delivery log"); }
    }
}

/// <summary>Tries again the messages that could not be delivered the first time: after 1, 5, 15 and 60 minutes, then gives up (the body is dropped either way).</summary>
public class EmailRetryService(IAppDbContext db, IEmailTransport transport, TimeProvider clock, ILogger<EmailRetryService> log)
{
    public const int MaxAttempts = 5;
    private static readonly int[] Minutes = [1, 5, 15, 60];

    public async Task<int> RetryDueAsync(int batch = 50, CancellationToken ct = default)
    {
        var now = clock.GetUtcNow().UtcDateTime;
        var due = await db.EmailLogs.Where(l => l.Status == EmailStatus.Queued && l.NextAttemptAt <= now).OrderBy(l => l.CreatedAt).Take(batch).ToListAsync(ct);
        var sent = 0;
        foreach (var l in due)
        {
            if (await db.EmailSuppressions.AnyAsync(s => s.Email == l.ToEmail, ct)) { Finish(l, EmailStatus.Suppressed, "This address no longer receives e-mail."); continue; }
            try
            {
                var headers = string.IsNullOrEmpty(l.HeadersJson) ? null : JsonSerializer.Deserialize<Dictionary<string, string>>(l.HeadersJson);
                await transport.SendAsync(new EmailMessage(l.ToEmail, l.Subject, l.Html ?? "", l.Text, l.Kind, headers), ct).WaitAsync(EmailSenderExtensions.DefaultSendTimeout, ct);
                l.SentAt = now; l.Attempts++; Finish(l, EmailStatus.Sent, null); sent++;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                l.Attempts++;
                l.Error = (ex.GetType().Name + ": " + ex.Message) is { Length: > 280 } e ? e[..280] : ex.GetType().Name + ": " + ex.Message;
                if (l.Attempts >= MaxAttempts) Finish(l, EmailStatus.Failed, l.Error);
                else l.NextAttemptAt = now.AddMinutes(Minutes[Math.Min(l.Attempts - 1, Minutes.Length - 1)]);
                log.LogWarning(ex, "Retry {Attempt}/{Max} of the e-mail to {To} failed", l.Attempts, MaxAttempts, l.ToEmail);
            }
        }
        // Old entries are forgotten.
        await db.EmailLogs.Where(l => l.CreatedAt < now.AddDays(-30)).ExecuteDeleteAsync(ct);
        await db.SaveChangesAsync(ct);
        return sent;
    }

    private static void Finish(EmailLog l, EmailStatus status, string? error)
    {
        l.Status = status; l.Error = error; l.NextAttemptAt = null; l.Html = null; l.Text = null; l.HeadersJson = null;
    }
}

/// <summary>
/// "Stop emails like this": a signed link in the e-mail (and the List-Unsubscribe header mail programs show as a button) that turns off the e-mail
/// channel for that kind of notification, for that person, without signing in. Security alerts and anything else that cannot be switched off carry none.
/// </summary>
public class EmailLinks(IConfiguration config, IOptions<AppOptions> app)
{
    private byte[] Key => Encoding.UTF8.GetBytes("email-unsubscribe:" + (config["Jwt:SigningKey"] ?? ""));

    public string Token(Guid userId, NotificationType type)
    {
        var payload = $"{userId:N}.{(int)type}";
        var sig = Convert.ToHexString(HMACSHA256.HashData(Key, Encoding.UTF8.GetBytes(payload)))[..32];
        return $"{payload}.{sig}";
    }

    public bool TryRead(string? token, out Guid userId, out NotificationType type)
    {
        userId = default; type = default;
        var parts = (token ?? "").Split('.');
        if (parts.Length != 3 || !Guid.TryParseExact(parts[0], "N", out userId) || !int.TryParse(parts[1], out var t) || !Enum.IsDefined(typeof(NotificationType), t)) return false;
        var expected = Convert.ToHexString(HMACSHA256.HashData(Key, Encoding.UTF8.GetBytes($"{parts[0]}.{parts[1]}")))[..32];
        if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(parts[2]))) return false;
        type = (NotificationType)t;
        return !NotificationCatalog.For(type).Locked;
    }

    public string PageUrl(string token) => $"{app.Value.WebBaseUrl.TrimEnd('/')}/unsubscribe?token={Uri.EscapeDataString(token)}";
    public string ApiUrl(string token) => $"{(app.Value.ApiBaseUrl ?? app.Value.WebBaseUrl).TrimEnd('/')}/api/v1/email/unsubscribe?token={Uri.EscapeDataString(token)}";

    /// <summary>The headers that put an "Unsubscribe" button in Gmail, Outlook and Apple Mail (RFC 2369 and 8058: one click, no sign-in).</summary>
    public IReadOnlyDictionary<string, string>? Headers(Guid userId, NotificationType type)
    {
        if (NotificationCatalog.For(type).Locked) return null;
        var token = Token(userId, type);
        return new Dictionary<string, string> { ["List-Unsubscribe"] = $"<{ApiUrl(token)}>, <{PageUrl(token)}>", ["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click" };
    }
}

public record UnsubscribeInfoDto(string Label, bool AlreadyOff);

public class UnsubscribeService(IAppDbContext db, EmailLinks links)
{
    public async Task<UnsubscribeInfoDto> InfoAsync(string? token, CancellationToken ct = default)
    {
        if (!links.TryRead(token, out var uid, out var type)) throw new NotFoundException("This link is not valid any more.");
        var off = await db.NotificationPreferences.AsNoTracking().AnyAsync(p => p.UserId == uid && p.Type == type && !p.Email, ct);
        return new UnsubscribeInfoDto(NotificationCatalog.For(type).Label, off);
    }

    public async Task<UnsubscribeInfoDto> UnsubscribeAsync(string? token, CancellationToken ct = default)
    {
        if (!links.TryRead(token, out var uid, out var type)) throw new NotFoundException("This link is not valid any more.");
        var row = await db.NotificationPreferences.FirstOrDefaultAsync(p => p.UserId == uid && p.Type == type, ct);
        var kind = NotificationCatalog.For(type);
        if (row is null) db.NotificationPreferences.Add(new NotificationPreference { UserId = uid, Type = type, InApp = kind.InApp, Email = false, Browser = kind.Browser });
        else row.Email = false;
        await db.SaveChangesAsync(ct);
        return new UnsubscribeInfoDto(kind.Label, true);
    }
}

/// <summary>Checks the signature on a webhook sent through Svix (the way Resend signs its delivery events): HMAC-SHA256 of "id.timestamp.body" with the secret.</summary>
public static class SvixSignature
{
    public static bool Verify(string secret, string? id, string? timestamp, string? signatures, string body, DateTimeOffset now, TimeSpan? tolerance = null)
    {
        if (string.IsNullOrEmpty(secret) || string.IsNullOrEmpty(id) || string.IsNullOrEmpty(timestamp) || string.IsNullOrEmpty(signatures)) return false;
        if (!long.TryParse(timestamp, out var ts) || Math.Abs((now - DateTimeOffset.FromUnixTimeSeconds(ts)).TotalSeconds) > (tolerance ?? TimeSpan.FromMinutes(5)).TotalSeconds) return false;
        byte[] key;
        try { key = Convert.FromBase64String(secret.StartsWith("whsec_", StringComparison.Ordinal) ? secret[6..] : secret); } catch (FormatException) { return false; }
        var expected = HMACSHA256.HashData(key, Encoding.UTF8.GetBytes($"{id}.{timestamp}.{body}"));
        foreach (var part in signatures.Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            var bits = part.Split(',', 2);
            if (bits.Length != 2 || bits[0] != "v1") continue;
            try { if (CryptographicOperations.FixedTimeEquals(expected, Convert.FromBase64String(bits[1]))) return true; } catch (FormatException) { /* next */ }
        }
        return false;
    }
}

public record EmailLogDto(Guid Id, string To, string Subject, string? Kind, string Status, int Attempts, DateTime CreatedAt, DateTime? SentAt, string? Error);
public record EmailSuppressionDto(Guid Id, string Email, string Reason, string? Detail, DateTime CreatedAt);
public record EmailCheckDto(string Id, string Title, string Status, string Detail, string? Fix);
public record EmailDomainDto(string Domain, IReadOnlyList<EmailCheckDto> Checks);
public record EmailOverviewDto(string Provider, int Sent24h, int Failed24h, int Queued, int Suppressed, IReadOnlyList<EmailLogDto> Recent);

/// <summary>For platform administrators: what was sent and what went wrong, who is blocked, and whether the sending domain is set up so mail lands in inboxes.</summary>
public class EmailAdminService(IAppDbContext db, ICurrentContext ctx, IConfiguration config, IEmailSender sender, IDomainVerifier dns, TimeProvider clock, Recorder recorder)
{
    private void RequireAdmin() { if (!ctx.IsPlatformAdmin) throw new ForbiddenException("Platform administrators only.", "PERMISSION_DENIED"); }

    public async Task<EmailOverviewDto> OverviewAsync(string? status, CancellationToken ct = default)
    {
        RequireAdmin();
        var since = clock.GetUtcNow().UtcDateTime.AddHours(-24);
        var q = db.EmailLogs.AsNoTracking();
        var sent = await q.CountAsync(l => l.Status == EmailStatus.Sent && l.CreatedAt >= since, ct);
        var failed = await q.CountAsync(l => l.Status == EmailStatus.Failed && l.CreatedAt >= since, ct);
        var queued = await q.CountAsync(l => l.Status == EmailStatus.Queued, ct);
        var suppressed = await db.EmailSuppressions.CountAsync(ct);
        var filtered = Enum.TryParse<EmailStatus>(status, true, out var s) ? q.Where(l => l.Status == s) : q;
        var recent = await filtered.OrderByDescending(l => l.CreatedAt).Take(60).Select(l => new EmailLogDto(l.Id, l.ToEmail, l.Subject, l.Kind, l.Status.ToString(), l.Attempts, l.CreatedAt, l.SentAt, l.Error)).ToListAsync(ct);
        return new EmailOverviewDto(sender.Name, sent, failed, queued, suppressed, recent);
    }

    public async Task<IReadOnlyList<EmailSuppressionDto>> SuppressionsAsync(CancellationToken ct = default)
    {
        RequireAdmin();
        return await db.EmailSuppressions.AsNoTracking().OrderByDescending(s => s.CreatedAt).Take(200).Select(s => new EmailSuppressionDto(s.Id, s.Email, s.Reason, s.Detail, s.CreatedAt)).ToListAsync(ct);
    }

    public async Task RemoveSuppressionAsync(Guid id, CancellationToken ct = default)
    {
        RequireAdmin();
        var row = await db.EmailSuppressions.FirstOrDefaultAsync(s => s.Id == id, ct) ?? throw new NotFoundException("That address is not blocked.");
        db.EmailSuppressions.Remove(row);
        recorder.Audit("admin.email_unblocked", "Email", null, oldValue: new { row.Email, row.Reason });
        await db.SaveChangesAsync(ct);
    }

    public async Task SuppressAsync(string email, string reason, string? detail, CancellationToken ct = default)
    {
        var e = Text.NormalizeEmail(email);
        if (e.Length == 0 || await db.EmailSuppressions.AnyAsync(s => s.Email == e, ct)) return;
        db.EmailSuppressions.Add(new EmailSuppression { Email = e, Reason = reason, Detail = Text.Truncate(detail, 300), CreatedAt = clock.GetUtcNow().UtcDateTime });
        await db.SaveChangesAsync(ct);
    }

    /// <summary>SPF, DKIM and DMARC for the sending domain: the three records receiving mail servers use to decide between the inbox and the spam folder.</summary>
    public async Task<EmailDomainDto> CheckDomainAsync(string? domain, CancellationToken ct = default)
    {
        RequireAdmin();
        domain = (domain ?? DomainOfSender()).Trim().ToLowerInvariant();
        if (domain.Length == 0 || !domain.Contains('.') || domain.Any(c => !(char.IsLetterOrDigit(c) || c is '.' or '-')))
            throw new ValidationException("domain", "Enter the domain you send e-mail from, like example.com. (Set the sender address first: SMTP_FROM or RESEND_FROM.)");
        var checks = new List<EmailCheckDto>();

        var txt = await dns.GetRecordsAsync(domain, "TXT", ct);
        var spf = txt.FirstOrDefault(t => t.StartsWith("v=spf1", StringComparison.OrdinalIgnoreCase));
        checks.Add(spf is null
            ? new("spf", "SPF", "fail", "No SPF record found.", $"Add a TXT record on {domain} listing your mail provider, for example: v=spf1 include:<your provider> ~all (your provider's dashboard shows the exact value).")
            : spf.Contains("-all") || spf.Contains("~all") ? new("spf", "SPF", "ok", "Published and ends with an all-rule.", null)
            : new("spf", "SPF", "warn", "Published, but it does not end with ~all or -all.", "End the record with ~all (or -all) so unlisted servers are not trusted."));

        string[] selectors = ["resend", "google", "selector1", "selector2", "k1", "k2", "s1", "s2", "default", "mail", "smtp", "dkim"];
        string? foundSelector = null;
        foreach (var sel in selectors)
        {
            var host = $"{sel}._domainkey.{domain}";
            if ((await dns.GetRecordsAsync(host, "TXT", ct)).Any(t => t.Contains("v=DKIM1", StringComparison.OrdinalIgnoreCase) || t.Contains("p=")) || (await dns.GetRecordsAsync(host, "CNAME", ct)).Count > 0) { foundSelector = sel; break; }
        }
        checks.Add(foundSelector is not null ? new("dkim", "DKIM", "ok", $"A signing key is published (selector “{foundSelector}”).", null)
            : new("dkim", "DKIM", "warn", "No signing key found under the usual selectors.", "Your mail provider gives you one or more DKIM records to add (they look like <name>._domainkey.<domain>). If you already added them under another name, this check cannot see them."));

        var dmarc = (await dns.GetRecordsAsync($"_dmarc.{domain}", "TXT", ct)).FirstOrDefault(t => t.StartsWith("v=DMARC1", StringComparison.OrdinalIgnoreCase));
        checks.Add(dmarc is null
            ? new("dmarc", "DMARC", "fail", "No DMARC record found. Gmail and Yahoo expect one from senders of bulk mail.", $"Add a TXT record on _dmarc.{domain} with: v=DMARC1; p=none; rua=mailto:dmarc@{domain} (start with p=none, then move to quarantine once reports look clean).")
            : dmarc.Contains("p=none", StringComparison.OrdinalIgnoreCase) ? new("dmarc", "DMARC", "warn", "Published in monitoring mode (p=none).", "When reports show only your own mail, change p=none to p=quarantine.")
            : new("dmarc", "DMARC", "ok", "Published with an enforcing policy.", null));
        return new EmailDomainDto(domain, checks);
    }

    private string DomainOfSender()
    {
        var from = config["Email:Provider"]?.Equals("Resend", StringComparison.OrdinalIgnoreCase) == true ? config["Email:Resend:From"] : config["Email:Smtp:From"];
        var at = (from ?? "").TrimEnd('>', ' ').LastIndexOf('@');
        return at < 0 ? "" : from!.TrimEnd('>', ' ')[(at + 1)..];
    }
}
