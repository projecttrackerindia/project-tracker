using System.Net.Mail;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Sso;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Integrations;

public class InboundEmailOptions
{
    public const string Section = "InboundEmail";
    /// <summary>The domain your provider receives mail for (work+token@this-domain). Empty = addresses are not shown; the webhook URL still works.</summary>
    public string? Domain { get; set; }
    /// <summary>Optional shared key the provider must send (?key= or X-Inbound-Key), on top of the mailbox token.</summary>
    public string? Key { get; set; }
}

/// <summary>An email as any provider describes it, reduced to what turns into work.</summary>
public record InboundEmail(string? From, string? To, string? Subject, string? Text);
public record InboundMailboxDto(bool Configured, bool Enabled, string? Address, string? WebhookUrl, Guid? WorkTypeId, Priority Priority, int Received, DateTime? LastReceivedAt, string? LastError, bool CanManage);
public record SaveInboundMailboxRequest(bool Enabled, Guid? WorkTypeId, Priority? Priority);

/// <summary>
/// Email to work task: each workspace can have one mailbox address. Mail sent to it - forwarded by Mailgun, SendGrid Inbound Parse, Postmark
/// or anything that can post JSON - becomes an operational work task raised by the sender, who must be a member of the workspace allowed to
/// create work (everyone else is refused). Subject becomes the title, the text the description.
/// </summary>
public class InboundEmailService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions,
    IOptions<InboundEmailOptions> options, IOptions<AppOptions> app)
{
    private const int MaxPerDay = 500;

    private static string NewToken() => Convert.ToHexString(RandomNumberGenerator.GetBytes(12)).ToLowerInvariant();
    private string? AddressOf(string token) => string.IsNullOrWhiteSpace(options.Value.Domain) ? null : $"work+{token}@{options.Value.Domain!.Trim().TrimStart('@')}";
    private string WebhookOf(string token) => $"{PublicUrls.Api(app.Value)}/api/v1/inbound/email/{token}";
    private bool IsAdmin => ctx.Role is TenantRole.Owner or TenantRole.Admin;

    public async Task<InboundMailboxDto> GetAsync(CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        await permissions.RequireModuleAsync(Modules.Work, AccessLevel.View, ct);
        var m = await db.InboundMailboxes.AsNoTracking().FirstOrDefaultAsync(ct);
        return m is null
            ? new InboundMailboxDto(false, false, null, null, null, Priority.Medium, 0, null, null, IsAdmin)
            : new InboundMailboxDto(true, m.Enabled, AddressOf(m.Token), IsAdmin ? WebhookOf(m.Token) : null, m.WorkTypeId, m.Priority, m.Received, m.LastReceivedAt, m.LastError, IsAdmin);
    }

    public async Task<InboundMailboxDto> SaveAsync(SaveInboundMailboxRequest req, CancellationToken ct = default)
    {
        if (!IsAdmin) throw new ForbiddenException("Only owners and admins can set up the work mailbox.", "PERMISSION_DENIED");
        var tid = ctx.RequireTenantId();
        if (req.WorkTypeId is { } wt && !await db.WorkTypes.AnyAsync(t => t.Id == wt && t.IsActive, ct)) throw new ValidationException("workTypeId", "Choose an active work type.");
        var m = await db.InboundMailboxes.FirstOrDefaultAsync(ct);
        if (m is null) { m = new InboundMailbox { TenantId = tid, Token = NewToken(), CreatedAt = clock.Now, CreatedBy = ctx.UserId }; db.InboundMailboxes.Add(m); }
        m.Enabled = req.Enabled; m.WorkTypeId = req.WorkTypeId; m.Priority = req.Priority ?? Priority.Medium; m.UpdatedAt = clock.Now;
        recorder.Audit("inbound_mailbox.saved", "InboundMailbox", m.Id, null, new { m.Enabled, m.WorkTypeId, m.Priority });
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    /// <summary>A new address: mail to the old one is refused from now on.</summary>
    public async Task<InboundMailboxDto> ResetAsync(CancellationToken ct = default)
    {
        if (!IsAdmin) throw new ForbiddenException("Only owners and admins can set up the work mailbox.", "PERMISSION_DENIED");
        var m = await db.InboundMailboxes.FirstOrDefaultAsync(ct) ?? throw new NotFoundException("Set up the mailbox first.");
        m.Token = NewToken(); m.UpdatedAt = clock.Now;
        recorder.Audit("inbound_mailbox.reset", "InboundMailbox", m.Id);
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    private static readonly Regex PlusToken = new(@"\+([0-9a-f]{24})@", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex Prefixes = new(@"^\s*((re|fw|fwd|aw|wg)\s*:\s*)+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>The mailbox token from a recipient such as "work+0123abcd...@inbound.example.com".</summary>
    public static string? TokenFromRecipient(string? to) => to is null ? null : PlusToken.Match(to) is { Success: true } m ? m.Groups[1].Value.ToLowerInvariant() : null;

    public static string? EmailOf(string? from)
    {
        if (string.IsNullOrWhiteSpace(from)) return null;
        try { return new MailAddress(from.Trim()).Address; } catch (FormatException) { return null; }
    }

    /// <summary>
    /// Handles one received email (anonymous request; the token picks the workspace). Returns the new work task's key, or throws with the reason
    /// it was refused - which the provider logs; nothing is sent back to the sender.
    /// </summary>
    public static async Task<string> ReceiveAsync(IServiceProvider sp, string? token, string? key, InboundEmail email, CancellationToken ct)
    {
        var opts = sp.GetRequiredService<IOptions<InboundEmailOptions>>().Value;
        if (!string.IsNullOrEmpty(opts.Key) && !CryptographicOperations.FixedTimeEquals(System.Text.Encoding.UTF8.GetBytes(key ?? ""), System.Text.Encoding.UTF8.GetBytes(opts.Key)))
            throw new UnauthorizedException("The inbound key is missing or wrong.", "INBOUND_KEY");
        token = (token ?? TokenFromRecipient(email.To))?.ToLowerInvariant();
        if (string.IsNullOrEmpty(token)) throw new NotFoundException("No mailbox in the address.", "MAILBOX_NOT_FOUND");

        var db = sp.GetRequiredService<IAppDbContext>();
        var clock = sp.GetRequiredService<AppClock>();
        var log = sp.GetRequiredService<ILogger<InboundEmailService>>();
        var box = await db.InboundMailboxes.IgnoreQueryFilters().FirstOrDefaultAsync(m => m.Token == token, ct) ?? throw new NotFoundException("Unknown mailbox.", "MAILBOX_NOT_FOUND");
        async Task<Exception> Refuse(Exception ex)
        {
            box.LastError = $"{clock.Now:dd MMM HH:mm} UTC: {ex.Message}";
            await db.SaveChangesAsync(ct);
            log.LogInformation("Inbound email to mailbox {Mailbox} refused: {Reason}", box.Id, ex.Message);
            return ex;
        }
        if (!box.Enabled) throw await Refuse(new ForbiddenException("The mailbox is switched off.", "MAILBOX_DISABLED"));
        var tenant = await db.Tenants.AsNoTracking().FirstOrDefaultAsync(t => t.Id == box.TenantId && t.Status == TenantStatus.Active, ct);
        if (tenant is null) throw await Refuse(new ForbiddenException("The workspace is not active.", "WORKSPACE_INACTIVE"));
        var today = DateOnly.FromDateTime(clock.Now);
        if (box.Day == today && box.DayCount >= MaxPerDay) throw await Refuse(new ConflictException($"The mailbox already received {MaxPerDay} emails today.", "MAILBOX_LIMIT"));

        var sender = EmailOf(email.From);
        if (sender is null) throw await Refuse(new ValidationException("from", "The sender's address could not be read."));
        var normalized = Text.NormalizeEmail(sender);
        var member = await db.TenantMembers.IgnoreQueryFilters().AsNoTracking().Include(m => m.User)
            .FirstOrDefaultAsync(m => m.TenantId == box.TenantId && m.User!.NormalizedEmail == normalized && m.User.IsActive && m.Role != TenantRole.Guest, ct);
        if (member is null) throw await Refuse(new ForbiddenException($"{sender} is not a member of this workspace.", "SENDER_NOT_MEMBER"));

        // Act as the sender, with their own rights in the workspace.
        var cc = sp.GetRequiredService<CurrentContext>();
        cc.UserId = member.UserId; cc.TenantId = box.TenantId; cc.Role = member.Role; cc.WorkspaceType = tenant.Type; cc.IsPlatformAdmin = false;

        var title = Prefixes.Replace(email.Subject ?? "", "").Trim();
        if (title.Length == 0) title = "Email without a subject";
        if (title.Length > 200) title = title[..199] + "…";
        var text = (email.Text ?? "").Replace("\r\n", "\n").Trim();
        var footer = $"\n\n— Raised by email from {sender} on {clock.Now:dd MMM yyyy HH:mm} UTC";
        if (text.Length + footer.Length > 8000) text = text[..(8000 - footer.Length - 1)] + "…";

        var types = sp.GetRequiredService<WorkTypeService>();
        await types.EnsureDefaultsAsync(ct);
        var typeId = box.WorkTypeId is { } chosen && await db.WorkTypes.AnyAsync(t => t.Id == chosen && t.IsActive, ct) ? chosen
            : await db.WorkTypes.Where(t => t.IsActive).OrderBy(t => t.Order).Select(t => (Guid?)t.Id).FirstOrDefaultAsync(ct);
        try
        {
            var created = await sp.GetRequiredService<WorkTaskService>().CreateAsync(new CreateWorkTaskRequest(title, text + footer, typeId, null, null, box.Priority, WorkTaskStatus.ToDo, null, null), ct);
            box.Received++; box.LastReceivedAt = clock.Now; box.LastError = null;
            if (box.Day == today) box.DayCount++; else { box.Day = today; box.DayCount = 1; }
            await db.SaveChangesAsync(ct);
            return created.Key;
        }
        catch (AppException ex) { throw await Refuse(ex); }
    }
}
