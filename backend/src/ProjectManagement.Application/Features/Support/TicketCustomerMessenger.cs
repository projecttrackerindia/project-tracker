using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Support;

/// <summary>What happened when the Desk told a ticket's customer something: on which channel, whether it went out, and why not.</summary>
public record TicketTellResultDto(string Channel, bool Sent, string Note);
public record TicketTellRequest(string? Text);
/// <summary>A saved reply for the Desk: built in, or one of a WhatsApp number's saved replies. Text may hold {name}, {key}, {title}, {status}, {eta}, {account}, {agent}.</summary>
public record DeskReplyTemplateDto(string Id, string Title, string Text, string Source);
public record DeskFillRequest(string? Text);
/// <summary>The template with what the ticket knows filled in; <see cref="Missing"/> lists the placeholders nothing could fill (left for the AI or the agent).</summary>
public record DeskFillDto(string Text, IReadOnlyList<string> Missing);

/// <summary>
/// Tells a Desk ticket's customer something on the channel the ticket came from: the WhatsApp chat that raised it (through
/// <see cref="SupportChannelService"/>, honouring the number's switch and WhatsApp's 24-hour rule) or the e-mail address that raised it
/// (through the workspace's mail sender, while the work mailbox is switched on). What was told - or why it was not - is kept on the ticket as
/// a comment. Tickets from anywhere else have no customer channel: callers fall back to a comment. Nothing here saves; the caller does.
/// </summary>
public class TicketCustomerMessenger(IAppDbContext db, ICurrentContext ctx, AppClock clock, IServiceProvider services, IEmailSender email,
    ILogger<TicketCustomerMessenger> log)
{
    public const string EmailFooter = "— Raised by email from ";
    private static readonly Regex Address = new(@"[\w.+'-]+@[\w-]+(?:\.[\w-]+)+", RegexOptions.Compiled);

    /// <summary>The address an e-mailed ticket came from (from the line the mailbox adds to its description), or null.</summary>
    public static string? EmailOf(string? description)
    {
        if (string.IsNullOrEmpty(description)) return null;
        var i = description.LastIndexOf(EmailFooter, StringComparison.Ordinal);
        if (i < 0) return null;
        var m = Address.Match(description, i + EmailFooter.Length);
        return m.Success ? m.Value : null;
    }

    public static string Label(string channel) => channel == "whatsapp" ? "WhatsApp" : channel == "email" ? "e-mail" : channel;

    /// <summary>"whatsapp", "email", or null when the ticket has no customer channel.</summary>
    public async Task<string?> ChannelOfAsync(WorkTask t, CancellationToken ct)
    {
        if (await db.SupportConversations.AsNoTracking().AnyAsync(c => c.WorkTaskId == t.Id, ct)) return "whatsapp";
        return EmailOf(t.Description) is null ? null : "email";
    }

    /// <summary>
    /// Sends <paramref name="text"/> to the ticket's customer and records it on the ticket. Null when the ticket has no customer channel
    /// (nothing is recorded then). <paramref name="by"/> names who is speaking in the WhatsApp chat (an agent, an automation).
    /// </summary>
    public async Task<TicketTellResultDto?> TellAsync(WorkTask t, string text, string by, CancellationToken ct, string? subject = null)
    {
        var line = text.Trim();
        if (line.Length == 0) return null;
        TicketTellResultDto? result = null;
        if (await db.SupportConversations.AsNoTracking().AnyAsync(c => c.WorkTaskId == t.Id, ct))
        {
            var wa = await services.GetRequiredService<SupportChannelService>().TellTicketCustomerAsync(t.Id, line, by, ct);
            if (wa is { } w) result = new TicketTellResultDto("whatsapp", w.Sent, w.Note);
        }
        else if (EmailOf(t.Description) is { } to)
        {
            var box = await db.InboundMailboxes.AsNoTracking().FirstOrDefaultAsync(ct);
            if (box is null || !box.Enabled) result = new TicketTellResultDto("email", false, "the work mailbox is switched off");
            else
            {
                var key = DeskReplies.KeyOf(t.Number);
                var body = $"{line}\n\n— {key} · {t.Title}";
                var ok = await email.TrySendAsync(new EmailMessage(to, subject ?? $"[{key}] {t.Title}", Html(body), body, "ticket-update"), log, ct);
                result = new TicketTellResultDto("email", ok, ok ? "sent" : "the mail server did not take it");
            }
        }
        if (result is null) return null;
        var shown = line.Length > 3500 ? line[..3500] + "…" : line;
        db.WorkTaskComments.Add(new WorkTaskComment
        {
            TenantId = t.TenantId, WorkTaskId = t.Id, AuthorId = ctx.UserId ?? t.AssigneeId ?? t.ReporterId, CreatedAt = clock.Now, CreatedBy = ctx.UserId,
            Body = result.Sent ? $"📣 Told the customer on {Label(result.Channel)}: {shown}" : $"📣 Not sent on {Label(result.Channel)} ({result.Note}): {shown}",
        });
        return result;
    }

    /// <summary>
    /// The ticket's status changed: tell an e-mail customer what that means for them (raised tickets from WhatsApp are told by the support
    /// worker, which also knows WhatsApp's 24-hour rule). Only changes a customer cares about: picked up, on hold, resolved, closed.
    /// </summary>
    public async Task<TicketTellResultDto?> StatusChangedAsync(WorkTask t, WorkTaskStatus was, CancellationToken ct)
    {
        if (was == t.Status || EmailOf(t.Description) is null) return null;
        if (await db.SupportConversations.AsNoTracking().AnyAsync(c => c.WorkTaskId == t.Id, ct)) return null;
        var key = DeskReplies.KeyOf(t.Number);
        var what = t.Status switch
        {
            WorkTaskStatus.Completed => $"Your request {key} is resolved. Reply to this mail if anything is still not right.",
            WorkTaskStatus.Cancelled => $"Your request {key} is closed. Reply to this mail if you still need help.",
            WorkTaskStatus.OnHold => $"Your request {key} is on hold for now. We will write again when work resumes.",
            WorkTaskStatus.InProgress when was == WorkTaskStatus.ToDo => $"We are working on your request {key}.",
            _ => null,
        };
        if (what is null) return null;
        try { return await TellAsync(t, what, "Ticket update", ct, $"[{key}] {DeskReplies.StatusWord(t.Status)}: {t.Title}"); }
        catch (Exception e) when (e is not OperationCanceledException) { log.LogWarning("Ticket {Key}: the customer was not told about the status ({Kind})", key, e.GetType().Name); return null; }
    }

    private static string Html(string text) =>
        "<div style=\"font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.5\">"
        + string.Join("<br>", text.Split('\n').Select(System.Net.WebUtility.HtmlEncode)) + "</div>";
}

/// <summary>
/// The Desk's saved replies: a few built-in ones and every WhatsApp number's saved replies, with placeholders the ticket fills in - the
/// customer's first name, the ticket key and title, its status, the ETA (resolution target or due date), account facts from what they wrote,
/// and the agent's first name.
/// </summary>
public class DeskReplies(IAppDbContext db, ICurrentContext ctx, PermissionService permissions, AppClock clock)
{
    public static string KeyOf(int number) => $"WT-{number}";
    public static readonly string[] Placeholders = ["name", "key", "title", "status", "eta", "account", "agent"];
    private static readonly Regex Slot = new(@"\{(\w+)\}", RegexOptions.Compiled);
    private static readonly Regex Account = new(@"\b(?:loan|a/c|account|acct|agreement)\s*(?:no\.?|number|#|:)?\s*([A-Z]{0,5}-?\d{5,})\b|\b([A-Z]{2,5}-\d{5,})\b",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    public static readonly DeskReplyTemplateDto[] BuiltIn =
    [
        new("ack", "Acknowledge", "Hi {name}, thanks for reaching out. We have logged this as {key} and will update you by {eta}.", "built-in"),
        new("info", "Need more info", "Hi {name}, could you share a screenshot, the time it happened and the steps to reproduce? That helps us fix {key} faster.", "built-in"),
        new("account", "Account check", "Hi {name}, we are checking account {account} for you under {key}. You will hear from us by {eta}.", "built-in"),
        new("fixed", "Fixed, please confirm", "Hi {name}, we have deployed a fix for {key}. Could you check on your side and confirm it works?", "built-in"),
        new("status", "Status update", "Hi {name}, {key} is now {status}. Next update by {eta}. — {agent}", "built-in"),
    ];

    public static string StatusWord(WorkTaskStatus s) => s switch
    {
        WorkTaskStatus.ToDo => "open", WorkTaskStatus.InProgress => "in progress", WorkTaskStatus.OnHold => "on hold",
        WorkTaskStatus.Completed => "resolved", _ => "closed",
    };

    public async Task<IReadOnlyList<DeskReplyTemplateDto>> TemplatesAsync(CancellationToken ct)
    {
        ctx.RequireTenantId();
        await permissions.RequireModuleAsync(Modules.Work, AccessLevel.View, ct);
        var list = BuiltIn.ToList();
        var channels = await db.SupportChannels.AsNoTracking().Where(c => c.SavedReplies != null).OrderBy(c => c.Name).Select(c => new { c.Name, c.SavedReplies }).ToListAsync(ct);
        foreach (var c in channels)
        {
            List<SupportSavedReplyDto>? saved = null;
            try { saved = System.Text.Json.JsonSerializer.Deserialize<List<SupportSavedReplyDto>>(c.SavedReplies!, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web)); }
            catch (System.Text.Json.JsonException) { }
            foreach (var (r, i) in (saved ?? []).Select((r, i) => (r, i)))
                if (!string.IsNullOrWhiteSpace(r.Title) && !string.IsNullOrWhiteSpace(r.Text) && !list.Any(x => string.Equals(x.Title, r.Title, StringComparison.OrdinalIgnoreCase)))
                    list.Add(new DeskReplyTemplateDto($"wa-{list.Count}-{i}", r.Title.Trim(), r.Text.Trim(), c.Name));
        }
        return list.Take(60).ToList();
    }

    /// <summary>Fills a template's placeholders from the ticket (the caller has already been allowed to see it).</summary>
    public async Task<DeskFillDto> FillAsync(WorkTask t, string? text, CancellationToken ct)
    {
        var template = (text ?? "").Trim();
        if (template.Length == 0) throw new ValidationException("text", "Choose a saved reply first.");
        if (template.Length > 4000) throw new ValidationException("text", "A reply can be at most 4,000 characters.");
        var chatName = await db.SupportConversations.AsNoTracking().Where(c => c.WorkTaskId == t.Id).Select(c => c.ContactName).FirstOrDefaultAsync(ct);
        var reporter = await db.Users.AsNoTracking().Where(u => u.Id == t.ReporterId).Select(u => u.DisplayName).FirstOrDefaultAsync(ct);
        var agent = ctx.UserId is { } me ? await db.Users.AsNoTracking().Where(u => u.Id == me).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) : null;
        // The customer's own words: what raised the ticket and the first comments on it (account numbers are often there, not in the title).
        var said = string.Join("\n", await db.WorkTaskComments.AsNoTracking().Where(c => c.WorkTaskId == t.Id).OrderBy(c => c.CreatedAt).Select(c => c.Body).Take(10).ToListAsync(ct));
        var values = Values(t, chatName ?? reporter, agent, clock.Now, said);
        var missing = new List<string>();
        var filled = Slot.Replace(template, m =>
        {
            var k = m.Groups[1].Value.ToLowerInvariant();
            if (values.TryGetValue(k, out var v) && !string.IsNullOrEmpty(v)) return v;
            if (!missing.Contains(k)) missing.Add(k);
            return m.Value;
        });
        return new DeskFillDto(filled, missing);
    }

    /// <summary>What a ticket can fill in by itself. The ETA is the resolution target, else the due date (null when there is neither).</summary>
    public static Dictionary<string, string?> Values(WorkTask t, string? customer, string? agent, DateTime now, string? more = null)
    {
        var eta = t.ResolutionDueAt is { } due && due > now ? due.ToString("d MMM, HH:mm", CultureInfo.InvariantCulture) + " UTC"
            : t.DueDate is { } d ? d.ToString("d MMM", CultureInfo.InvariantCulture) : null;
        var acct = Account.Match($"{t.Title}\n{t.Description}\n{more}");
        return new Dictionary<string, string?>
        {
            ["name"] = First(customer) ?? "there",
            ["key"] = KeyOf(t.Number),
            ["title"] = t.Title,
            ["status"] = StatusWord(t.Status),
            ["eta"] = eta,
            ["account"] = acct.Success ? (acct.Groups[1].Success && acct.Groups[1].Length > 0 ? acct.Groups[1].Value : acct.Groups[2].Value) : null,
            ["agent"] = First(agent),
        };
    }

    /// <summary>Fills what the ticket knows in an automation's line; unknown placeholders are dropped rather than sent as braces.</summary>
    public static string FillLine(string text, WorkTask t, string? customer, DateTime now)
    {
        var values = Values(t, customer, null, now);
        return Slot.Replace(text, m => values.TryGetValue(m.Groups[1].Value.ToLowerInvariant(), out var v) && !string.IsNullOrEmpty(v) ? v : m.Groups[1].Value == "eta" ? "soon" : "");
    }

    private static string? First(string? name) => string.IsNullOrWhiteSpace(name) ? null : name.Trim().Split(' ')[0];
}
