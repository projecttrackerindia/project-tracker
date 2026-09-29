using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;

namespace ProjectManagement.Application.Common;

public static class EmailSenderExtensions
{
    public static readonly TimeSpan DefaultSendTimeout = TimeSpan.FromSeconds(10);

    /// <summary>
    /// Sends a message that follows an action which is already saved (registration, an invitation, a password reset). A slow or
    /// unreachable mail server must not make that action hang or fail, so the wait is capped and a failure is logged and reported
    /// as <c>false</c> instead of thrown.
    /// </summary>
    public static async Task<bool> TrySendAsync(this IEmailSender email, EmailMessage message, ILogger log, CancellationToken ct = default, TimeSpan? timeout = null)
    {
        try
        {
            await email.SendAsync(message, ct).WaitAsync(timeout ?? DefaultSendTimeout, ct);
            return true;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Could not send the e-mail \"{Subject}\" through the {Provider} provider", message.Subject, email.Name);
            return false;
        }
    }
}
