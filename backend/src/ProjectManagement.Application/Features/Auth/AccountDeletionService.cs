using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;

namespace ProjectManagement.Application.Features.Auth;

/// <summary>
/// A signed-in person asks for their account and personal data to be deleted (Account › Profile, and the public /delete-account/ page, as
/// app stores require). The request goes to support (App:SupportEmail) and the platform administrators, the person gets a confirmation,
/// and it is in the audit log. Support completes it within 30 days: a person who owns a workspace first hands it over or closes it, so
/// nobody else loses their work by surprise.
/// </summary>
public class AccountDeletionService(IAppDbContext db, ICurrentContext ctx, Recorder recorder, IEmailSender email, IConfiguration config, ILogger<AccountDeletionService> log)
{
    private static readonly ConcurrentDictionary<Guid, DateTime> Recent = new();

    public record DeletionRequest(string? Reason);
    public record DeletionRequested(string Email, int CompleteWithinDays);

    public async Task<DeletionRequested> RequestAsync(DeletionRequest req, CancellationToken ct)
    {
        var userId = ctx.UserId ?? throw new AppException(401, "UNAUTHORIZED", "Sign in to request deletion of your account.");
        var reason = (req.Reason ?? "").Trim();
        if (reason.Length > 1000) throw new ValidationException("reason", "Keep the reason under 1000 characters.");
        // One request a day is plenty; repeats are acknowledged without sending everything again.
        var now = DateTime.UtcNow;
        var user = await db.Users.IgnoreQueryFilters().AsNoTracking().Where(u => u.Id == userId).Select(u => new { u.Email, u.DisplayName }).FirstOrDefaultAsync(ct)
            ?? throw new NotFoundException("Account not found.");
        if (Recent.TryGetValue(userId, out var last) && now - last < TimeSpan.FromDays(1)) return new(user.Email, 30);
        Recent[userId] = now;

        var owns = await db.TenantMembers.IgnoreQueryFilters().AsNoTracking()
            .Where(m => m.UserId == userId && m.Role == Domain.Enums.TenantRole.Owner).CountAsync(ct);
        recorder.Audit("account.deletion_requested", "User", userId, newValue: new { reason = reason.Length > 0 ? reason : null, ownedWorkspaces = owns }, userId: userId);
        await db.SaveChangesAsync(ct);

        var support = config["App:SupportEmail"] is { Length: > 3 } s && s.Contains('@') ? s.Trim() : EmailTemplates.SupportEmail;
        var admins = await db.Users.IgnoreQueryFilters().AsNoTracking().Where(u => u.IsPlatformAdmin && u.IsActive).Select(u => u.Email).Take(10).ToListAsync(ct);
        var staffText = $"{user.DisplayName} ({user.Email}) asked for their account and personal data to be deleted. " +
            (owns > 0 ? $"They own {owns} workspace(s): agree with them who takes over or whether it closes. " : "") +
            (reason.Length > 0 ? $"Reason given: {reason} " : "") + "Complete it within 30 days and reply to them when done.";
        var staffHtml = EmailTemplates.Wrap("Account deletion request", "Hello,", staffText, "Open the platform admin", "/admin");
        foreach (var to in admins.Append(support).Distinct(StringComparer.OrdinalIgnoreCase))
            await Send(new EmailMessage(to, $"Account deletion request: {user.Email}", staffHtml, staffText, "security", ReplyTo: user.Email), ct);

        var text = "We received your request to delete your Project Tracker account and the personal data linked to it. " +
            "We will complete it within 30 days and write to you when it is done. " +
            (owns > 0 ? "You own a workspace: we will contact you first about who takes it over, so your team does not lose their work. " : "") +
            "If you did not ask for this, reply to this e-mail straight away.";
        var html = EmailTemplates.Wrap("Your account deletion request", $"Hello {user.DisplayName},", text, "Open Project Tracker", "/account");
        await Send(new EmailMessage(user.Email, "We received your account deletion request", html, text, "security", ReplyTo: support), ct);
        return new(user.Email, 30);
    }

    private async Task Send(EmailMessage m, CancellationToken ct)
    {
        try { await email.SendAsync(m, ct); }
        catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "Account deletion e-mail could not be sent"); }
    }
}
