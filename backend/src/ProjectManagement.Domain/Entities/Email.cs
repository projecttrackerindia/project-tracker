using ProjectManagement.Domain.Common;
namespace ProjectManagement.Domain.Entities;

public enum EmailStatus { Queued = 0, Sent = 1, Failed = 2, Suppressed = 3 }

/// <summary>
/// One e-mail the server tried to send: to whom, what kind, how it went. The subject and result are kept for the delivery log; the body is kept only while a
/// message waits for another attempt (it can hold a one-time link) and is dropped as soon as the message is sent or given up. Forgotten after 30 days.
/// </summary>
public class EmailLog : Entity
{
    public string ToEmail { get; set; } = "";
    public string Subject { get; set; } = "";
    public string? Kind { get; set; }
    public EmailStatus Status { get; set; }
    public int Attempts { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? SentAt { get; set; }
    public DateTime? NextAttemptAt { get; set; }
    public string? Error { get; set; }
    public string? Html { get; set; }
    public string? Text { get; set; }
    /// <summary>Extra headers (List-Unsubscribe ...) as JSON, kept with the body for a retry.</summary>
    public string? HeadersJson { get; set; }
}

/// <summary>An address that must not be written to any more: it bounced for good, someone marked a message as spam, or an administrator blocked it.</summary>
public class EmailSuppression : Entity
{
    public string Email { get; set; } = "";
    public string Reason { get; set; } = "";
    public string? Detail { get; set; }
    public DateTime CreatedAt { get; set; }
}
