using System.Collections.Concurrent;
using System.Net;
using System.Net.Mail;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;

namespace ProjectManagement.Infrastructure.Services;

public record DevEmail(Guid Id, DateTime SentAt, string To, string Subject, string? Text, string Html);

/// <summary>In-memory outbox so verification / reset / invitation links are reachable during development.</summary>
public class DevMailbox
{
    private readonly ConcurrentQueue<DevEmail> _emails = new();

    public void Add(DevEmail email)
    {
        _emails.Enqueue(email);
        while (_emails.Count > 50) _emails.TryDequeue(out _);
    }

    public IReadOnlyList<DevEmail> Recent() => _emails.Reverse().ToList();
}

/// <summary>Development sender: writes to the log and the in-memory <see cref="DevMailbox"/>.</summary>
public class LogEmailSender(ILogger<LogEmailSender> log, DevMailbox mailbox, TimeProvider clock) : IEmailSender
{
    public string Name => "log";

    public Task SendAsync(EmailMessage message, CancellationToken ct = default)
    {
        mailbox.Add(new DevEmail(Guid.NewGuid(), clock.GetUtcNow().UtcDateTime, message.To, message.Subject, message.Text, message.Html));
        log.LogInformation("Email to {To}: {Subject}\n{Text}", message.To, message.Subject, message.Text);
        return Task.CompletedTask;
    }
}

public class SmtpOptions
{
    public const string Section = "Email:Smtp";
    public string Host { get; set; } = "";
    public int Port { get; set; } = 587;
    public bool EnableSsl { get; set; } = true;
    public string? Username { get; set; }
    public string? Password { get; set; }
    public string From { get; set; } = "no-reply@example.com";
}

/// <summary>Plain SMTP sender (SES SMTP, SendGrid SMTP, Microsoft 365, ...). Swap for an API-based provider behind the same interface.</summary>
public class SmtpEmailSender(IOptions<SmtpOptions> options) : IEmailSender
{
    public string Name => "smtp";

    public async Task SendAsync(EmailMessage message, CancellationToken ct = default)
    {
        var o = options.Value;
        using var client = new SmtpClient(o.Host, o.Port) { EnableSsl = o.EnableSsl };
        if (!string.IsNullOrEmpty(o.Username)) client.Credentials = new NetworkCredential(o.Username, o.Password);
        using var mail = new MailMessage(o.From, message.To, message.Subject, message.Html) { IsBodyHtml = true };
        await client.SendMailAsync(mail, ct);
    }
}

/// <summary>Stand-in payment gateway. Replace with Stripe / Razorpay / Paddle behind <see cref="IPaymentProvider"/>.</summary>
public class MockPaymentProvider(ILogger<MockPaymentProvider> log) : IPaymentProvider
{
    public Task<PaymentResult> ChargeAsync(Guid tenantId, string planCode, decimal amount, string currency, CancellationToken ct = default)
    {
        log.LogInformation("[mock-payments] charged {Amount} {Currency} for tenant {Tenant} ({Plan})", amount, currency, tenantId, planCode);
        return Task.FromResult(new PaymentResult(true, $"mock_{Guid.NewGuid():N}"[..20], null));
    }
}
