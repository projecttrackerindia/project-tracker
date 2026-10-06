using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Auth;

namespace ProjectManagement.Application.Features.Admin;

public record GoLiveCheckDto(string Id, string Title, string Status, string Detail, string? Fix);
public record GoLiveDto(string Verdict, int Failing, int Warnings, IReadOnlyList<GoLiveCheckDto> Checks);
public record TestEmailResultDto(bool Sent, string Provider, string To, string? Error);

/// <summary>
/// The "are we safe to open this to real people?" checklist for platform administrators: it inspects the running configuration and data
/// (never showing a secret) and says what is fine, what deserves attention and what must be fixed first.
/// </summary>
public class GoLiveService(IAppDbContext db, ICurrentContext ctx, IConfiguration config, IPasswordHasher hasher, IEmailSender email)
{
    private static readonly string[] KnownDefaultPasswords = ["Admin@12345", "Demo@12345", "admin", "password", "Password1", "changeme", "change-me"];

    private void RequireAdmin()
    {
        if (!ctx.IsPlatformAdmin) throw new ForbiddenException("Platform administrators only.", "PERMISSION_DENIED");
    }

    private static GoLiveCheckDto Ok(string id, string title, string detail) => new(id, title, "ok", detail, null);
    private static GoLiveCheckDto Warn(string id, string title, string detail, string fix) => new(id, title, "warn", detail, fix);
    private static GoLiveCheckDto Fail(string id, string title, string detail, string fix) => new(id, title, "fail", detail, fix);

    public async Task<GoLiveDto> CheckAsync(CancellationToken ct = default)
    {
        RequireAdmin();
        var checks = new List<GoLiveCheckDto>();

        // ---- secrets and keys
        var jwt = config["Jwt:SigningKey"] ?? "";
        checks.Add(jwt.Length >= 48 ? Ok("jwt", "Token signing key", "Long enough.")
            : Warn("jwt", "Token signing key", $"The signing key is {jwt.Length} characters.", "Use at least 48 random characters for JWT_SIGNING_KEY (openssl rand -base64 48)."));
        checks.Add(!string.IsNullOrWhiteSpace(config["Mfa:EncryptionKey"]) ? Ok("mfa-key", "Authenticator-secret key", "A separate key is configured.")
            : Warn("mfa-key", "Authenticator-secret key", "Two-step verification secrets are encrypted with a key derived from the signing key.", "Set MFA_ENCRYPTION_KEY to its own long random value (and keep it stable), so rotating the signing key does not lock people out."));

        // ---- accounts with well-known passwords
        var admins = await db.Users.IgnoreQueryFilters().Where(u => u.IsPlatformAdmin && u.IsActive).ToListAsync(ct);
        var weakAdmins = admins.Where(a => KnownDefaultPasswords.Any(p => hasher.Verify(a.PasswordHash, p))).Select(a => a.Email).ToList();
        checks.Add(weakAdmins.Count == 0 ? Ok("admin-password", "Platform administrator passwords", $"{admins.Count} administrator account(s), none using a well-known password.")
            : Fail("admin-password", "Platform administrator passwords", $"Still using a default password: {string.Join(", ", weakAdmins)}.", "Sign in as that account, open Settings → Change password, and choose a strong password. Then remove SEED_ADMIN_* from the environment."));

        var demo = await db.Users.IgnoreQueryFilters().AnyAsync(u => u.Email == "demo@example.com" && u.IsActive, ct);
        checks.Add(demo ? Fail("demo", "Demo accounts", "The demo organization and its accounts (well-known password) exist.", "Set SEED_DEMO=false, then disable or delete the demo users and organization from the admin portal.")
            : Ok("demo", "Demo accounts", "No demo accounts."));

        // ---- payments
        var billing = config["Billing:Provider"] ?? "Mock";
        if (billing.Equals("Razorpay", StringComparison.OrdinalIgnoreCase))
        {
            var missing = new[] { ("KeyId", "Billing:Razorpay:KeyId"), ("KeySecret", "Billing:Razorpay:KeySecret"), ("WebhookSecret", "Billing:Razorpay:WebhookSecret") }.Where(k => string.IsNullOrWhiteSpace(config[k.Item2])).Select(k => k.Item1).ToList();
            var live = (config["Billing:Razorpay:KeyId"] ?? "").StartsWith("rzp_live_", StringComparison.Ordinal);
            checks.Add(missing.Count > 0 ? Fail("payments", "Payments", $"Razorpay is selected but {string.Join(", ", missing)} {(missing.Count == 1 ? "is" : "are")} not set.", "Set BILLING_RAZORPAY_KEY_ID, BILLING_RAZORPAY_KEY_SECRET and BILLING_RAZORPAY_WEBHOOK_SECRET, and add the webhook https://<your site>/api/v1/billing/webhooks/razorpay in the Razorpay dashboard (events: subscription.activated, charged, pending, halted, cancelled, completed).")
                : live ? Ok("payments", "Payments", "Razorpay in live mode: real money is taken.")
                : Warn("payments", "Payments", "Razorpay is connected with test keys: no real money is taken.", "Switch to the rzp_live_ keys when you are ready to charge customers."));
        }
        else checks.Add(Warn("payments", "Payments", "Payments are simulated: choosing a paid plan succeeds without taking any money.", "Set BILLING_PROVIDER=Razorpay and the Razorpay keys before you charge customers."));

        // ---- e-mail
        var provider = config["Email:Provider"] ?? "Log";
        if (provider.Equals("Smtp", StringComparison.OrdinalIgnoreCase))
            checks.Add(string.IsNullOrWhiteSpace(config["Email:Smtp:Host"]) ? Fail("email", "E-mail delivery", "SMTP is selected but no host is set.", "Set SMTP_HOST, SMTP_USER and SMTP_PASSWORD, then use “Send test email” below.")
                : Ok("email", "E-mail delivery", $"Sending through {config["Email:Smtp:Host"]}. Use “Send test email” to confirm it works."));
        else if (provider.Equals("Resend", StringComparison.OrdinalIgnoreCase))
            checks.Add(string.IsNullOrWhiteSpace(config["Email:Resend:ApiKey"]) || string.IsNullOrWhiteSpace(config["Email:Resend:From"])
                ? Fail("email", "E-mail delivery", "Resend is selected but the API key or sender address is missing.", "Set RESEND_API_KEY and RESEND_FROM, then use “Send test email” below.")
                : Ok("email", "E-mail delivery", "Sending through Resend. Use “Send test email” to confirm it works."));
        else
            checks.Add(Fail("email", "E-mail delivery", "Messages are only written to the server log. Nobody receives verification, invitation, password-reset or notification e-mails.",
                "Set EMAIL_PROVIDER=Smtp with your SMTP_* settings, or EMAIL_PROVIDER=Resend with RESEND_API_KEY / RESEND_FROM if your host blocks outbound SMTP."));
        checks.Add(config.GetValue("App:RequireEmailVerification", true) ? Ok("verify", "E-mail verification", "New accounts must confirm their address.")
            : Warn("verify", "E-mail verification", "New accounts can sign in without confirming their address.", "Turn App:RequireEmailVerification back on."));

        // ---- network
        var baseUrl = config["App:WebBaseUrl"] ?? "";
        checks.Add(baseUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ? Ok("https", "HTTPS", $"Links and cookies use {baseUrl}.")
            : Fail("https", "HTTPS", $"The public address is {(baseUrl == "" ? "not set" : baseUrl)}: sign-in and data travel unencrypted.", "Put the app behind HTTPS (see deploy/DEPLOY.md, Caddy handles certificates) and set APP_URL to the https address."));
        var origins = config.GetSection("Cors:Origins").Get<string[]>() ?? [];
        checks.Add(origins.Any(o => o.Contains("localhost", StringComparison.OrdinalIgnoreCase) || o.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
            ? Warn("cors", "Allowed web origins", "CORS still allows a localhost or plain-http origin.", "Set APP_URL to the real https address; it becomes the only allowed origin.") : Ok("cors", "Allowed web origins", "Only your public address is allowed."));
        checks.Add(config.GetValue("RateLimiting:Enabled", true) ? Ok("ratelimit", "Rate limiting", "Enabled.") : Fail("ratelimit", "Rate limiting", "Switched off: sign-in and the API can be hammered.", "Set RateLimiting:Enabled to true."));
        checks.Add(config.GetValue("Webhooks:AllowPrivateTargets", false) ? Fail("ssrf", "Webhook targets", "Webhooks may call private and internal addresses.", "Set WEBHOOKS_ALLOW_PRIVATE=false.") : Ok("ssrf", "Webhook targets", "Internal addresses are refused."));

        // ---- data safety
        var dbProvider = config["Database:Provider"] ?? "Postgres";
        var conn = config["ConnectionStrings:Default"] ?? "";
        var weakDbPassword = dbProvider.Equals("Postgres", StringComparison.OrdinalIgnoreCase)
            && new[] { "Password=postgres", "Password=change-me", "Password=password", "Password=admin" }.Any(p => conn.Contains(p, StringComparison.OrdinalIgnoreCase));
        checks.Add(dbProvider.Equals("Postgres", StringComparison.OrdinalIgnoreCase)
            ? (weakDbPassword ? Fail("db", "Database", "The database password is a well-known one.", "Set POSTGRES_PASSWORD to a long random value before first start (or change it inside PostgreSQL).") : Ok("db", "Database", "PostgreSQL with a non-default password."))
            : Warn("db", "Database", $"Running on {dbProvider}, which is meant for development and tests.", "Use PostgreSQL for a real deployment."));
        checks.Add(await BackupCheckAsync());

        var failing = checks.Count(c => c.Status == "fail"); var warnings = checks.Count(c => c.Status == "warn");
        return new GoLiveDto(failing > 0 ? "not-ready" : warnings > 0 ? "almost" : "ready", failing, warnings, checks);
    }

    private Task<GoLiveCheckDto> BackupCheckAsync()
    {
        var path = config["Backups:Path"];
        if (string.IsNullOrWhiteSpace(path) || !Directory.Exists(path))
            return Task.FromResult(Warn("backup", "Backups", "No backup folder is visible to the server, so it cannot confirm that backups run.", "Keep the bundled backup service enabled (see deploy/DEPLOY.md) and mount its volume at Backups:Path, or monitor your own backups."));

        var newest = new DirectoryInfo(path).EnumerateFiles("db-*.dump").OrderByDescending(f => f.LastWriteTimeUtc).FirstOrDefault();
        if (newest is null) return Task.FromResult(Fail("backup", "Backups", "The backup folder has no database backup yet.", "Check the backup service logs: docker compose logs backup."));
        var age = DateTime.UtcNow - newest.LastWriteTimeUtc;
        var detail = $"Newest database backup: {newest.Name}, {(age.TotalHours < 1 ? $"{(int)age.TotalMinutes} min" : $"{(int)age.TotalHours} h")} old, {newest.Length / 1024 / 1024.0:0.#} MB.";
        return Task.FromResult(age.TotalHours <= 30 ? Ok("backup", "Backups", detail)
            : Fail("backup", "Backups", detail + " That is more than a day.", "The nightly backup is not running. Check: docker compose logs backup."));
    }

    /// <summary>Sends a real message to the administrator's own address, so delivery is proved rather than assumed.</summary>
    public async Task<TestEmailResultDto> SendTestEmailAsync(CancellationToken ct = default)
    {
        RequireAdmin();
        var me = await db.Users.IgnoreQueryFilters().FirstAsync(u => u.Id == ctx.RequireUserId(), ct);
        try
        {
            await email.SendAsync(new EmailMessage(me.Email, "Test e-mail from your project management server",
                EmailTemplates.Wrap("E-mail is working", $"Hi {System.Net.WebUtility.HtmlEncode(me.DisplayName)},", "This test message confirms that the server can send e-mail.", "Open the app", config["App:WebBaseUrl"] ?? "/"),
                "This test message confirms that the server can send e-mail."), ct).WaitAsync(EmailSenderExtensions.DefaultSendTimeout, ct);
            return new TestEmailResultDto(true, email.Name, me.Email, null);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // The kind of failure is useful ("authentication failed", "cannot connect"); the message can carry server details, so it is trimmed.
            var msg = ex.Message.Length > 200 ? ex.Message[..200] : ex.Message;
            return new TestEmailResultDto(false, email.Name, me.Email, $"{ex.GetType().Name}: {msg}");
        }
    }
}
