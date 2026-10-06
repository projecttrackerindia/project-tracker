using System.Net;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Notifications;

/// <summary>
/// Account security alerts cannot be switched off. Signed in with a workspace: they arrive in the bell and by e-mail through the normal
/// notification pipeline; otherwise a plain e-mail is sent. A mail-server problem never blocks the security-relevant action itself.
/// </summary>
public class SecurityAlerts(ICurrentContext ctx, NotificationService notifications, IEmailSender email, IOptions<AppOptions> options)
{
    public async Task SendAsync(User user, string title, string body, CancellationToken ct = default)
    {
        if (ctx.TenantId is not null && ctx.UserId == user.Id)
        {
            await notifications.AddAsync(user.Id, NotificationType.Security, title, body, "/account", toSelf: true, ct: ct);
            return;
        }
        var link = options.Value.WebBaseUrl.TrimEnd('/') + "/account";
        try
        {
            await email.SendAsync(new EmailMessage(user.Email, title,
                EmailTemplates.Wrap(title, WebUtility.HtmlEncode($"Hi {user.DisplayName},"), body, "Review your account", link, preheader: body, kind: EmailKind.Security), $"{title}\n{body}\n{link}", "security"), ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException) { /* never block the account action */ }
    }
}
