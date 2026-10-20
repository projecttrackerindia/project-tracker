using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MailKit;
using MailKit.Net.Imap;
using MailKit.Net.Smtp;
using MailKit.Search;
using MailKit.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using MimeKit;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Mailbox;

public record MailPreset(string Id, string Name, string ImapHost, int ImapPort, string SmtpHost, int SmtpPort, string Domain);
public record MailImapAccountDto(Guid Id, string Provider, string Name, string Email, DateTime ConnectedAt, DateTime? LastSyncedAt, string? LastError);
public record CompanyMailDto(string Provider, string Name, IReadOnlyList<string> Domains);
public record MailAccountsDto(IReadOnlyList<MailImapAccountDto> Imap, IReadOnlyList<MailPreset> Presets, CompanyMailDto? Company = null, bool CanManageCompany = false, string? MyEmail = null);
public record SaveCompanyMailRequest(string Provider, string Domains);
public record ConnectImapRequest(string Provider, string Email, string Password);
public record MailMessageDto(string Id, string ThreadId, string Subject, string From, string To, string Cc, DateTimeOffset? Date, bool Unread, bool HasAttachments, string? Body = null, bool BodyTruncated = false);
public record MailListDto(string Account, string Email, string Folder, IReadOnlyList<MailMessageDto> Messages, string? Cursor);
public record MailThreadDto(string Account, string Email, string Folder, string ThreadId, IReadOnlyList<MailMessageDto> Messages, bool Truncated);
public record MailSendRequest(string Account, string? ReplyToId, string? Folder, bool ReplyAll, string? To, string? Cc, string? Subject, string Body, bool Confirmed);
public record MailSendResultDto(bool Accepted, string To, string Cc, string Subject);

/// <summary>
/// The Mailbox: one place to read and answer the person's own mail - Gmail and Outlook through their existing private grants, and
/// IMAP/SMTP providers such as Rediffmail through a stored, encrypted app password. Mail content is never logged or audited.
/// </summary>
public class MailboxService(IAppDbContext db, ICurrentContext ctx, PersonalInboxService inbox, GoogleCalendarAuthService google,
    MicrosoftProductivityAuthService microsoft, IHttpClientFactory http, ISecretProtector secrets, AppClock clock, Recorder recorder, PermissionService permissions)
{
    // Only well-known providers: the person never supplies a host, so the server cannot be pointed at internal addresses.
    public static readonly MailPreset[] Presets =
    [
        // Gmail with an app password: no Google app approval needed (Google account › Security › 2-Step Verification › App passwords).
        new("gmail", "Gmail (app password)", "imap.gmail.com", 993, "smtp.gmail.com", 465, "gmail.com"),
        new("rediff", "Rediffmail", "imap.rediffmail.com", 993, "smtp.rediffmail.com", 465, "rediffmail.com"),
        new("rediffpro", "Rediffmail Pro", "imap.rediffmailpro.com", 993, "smtp.rediffmailpro.com", 465, ""),
        new("yahoo", "Yahoo Mail", "imap.mail.yahoo.com", 993, "smtp.mail.yahoo.com", 465, "yahoo.com"),
        new("zoho", "Zoho Mail", "imap.zoho.com", 993, "smtp.zoho.com", 465, "zoho.com"),
    ];
    private const int PageSize = 25;
    private IQueryable<MailAccount> Mine => db.MailAccounts.Where(a => a.UserId == ctx.RequireUserId());

    private static MailImapAccountDto Dto(MailAccount a) =>
        new(a.Id, a.Provider, Presets.FirstOrDefault(p => p.Id == a.Provider)?.Name ?? a.Provider, a.Email, a.CreatedAt, a.LastSyncedAt, a.LastError);

    public async Task<MailAccountsDto> AccountsAsync(CancellationToken ct)
    {
        ctx.RequireTenantId();
        var rows = await Mine.AsNoTracking().OrderBy(a => a.CreatedAt).ToListAsync(ct);
        var company = await db.CompanyMailSettings.AsNoTracking().FirstOrDefaultAsync(ct);
        var me = await db.Users.AsNoTracking().Where(u => u.Id == ctx.RequireUserId()).Select(u => u.Email).FirstOrDefaultAsync(ct);
        return new(rows.Select(Dto).ToArray(), Presets, company is null ? null : CompanyDto(company), await permissions.HasAsync(Permissions.OrgManage, ct), me);
    }

    private static CompanyMailDto CompanyDto(CompanyMailSettings c) =>
        new(c.Provider, Presets.FirstOrDefault(p => p.Id == c.Provider)?.Name ?? c.Provider, c.Domains.Split(',', StringSplitOptions.RemoveEmptyEntries));

    /// <summary>
    /// An administrator names the company's mail system once (for example Rediffmail Pro on fivestargroup.in): everyone with an address on
    /// those domains then connects with just their password, the server already chosen. Empty domains switch it off.
    /// </summary>
    public async Task<CompanyMailDto?> SaveCompanyAsync(SaveCompanyMailRequest req, CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.OrgManage, ct);
        var tid = ctx.RequireTenantId();
        var row = await db.CompanyMailSettings.FirstOrDefaultAsync(ct);
        var domains = (req.Domains ?? "").Split([',', ' ', ';', '\n'], StringSplitOptions.RemoveEmptyEntries)
            .Select(d => d.Trim().TrimStart('@').ToLowerInvariant()).Distinct().ToList();
        if (domains.Count == 0)
        {
            if (row is not null) { db.CompanyMailSettings.Remove(row); await db.SaveChangesAsync(ct); }
            return null;
        }
        if (domains.Count > 10 || domains.Any(d => d.Length > 100 || !System.Text.RegularExpressions.Regex.IsMatch(d, @"^[a-z0-9-]+(\.[a-z0-9-]+)+$")))
            throw new ValidationException("domains", "Enter your company's mail domains, like fivestargroup.in.");
        if (Presets.All(p => p.Id != req.Provider)) throw new ValidationException("provider", "Choose your company's mail provider.");
        if (row is null) { row = new CompanyMailSettings { TenantId = tid, CreatedAt = clock.Now, CreatedBy = ctx.UserId }; db.CompanyMailSettings.Add(row); }
        row.Provider = req.Provider; row.Domains = string.Join(',', domains); row.UpdatedAt = clock.Now; row.UpdatedBy = ctx.UserId;
        recorder.Audit("mailbox.company_set", "CompanyMailSettings", row.Id, null, new { provider = req.Provider, domains = row.Domains });
        await db.SaveChangesAsync(ct);
        return CompanyDto(row);
    }

    public async Task<MailImapAccountDto> ConnectImapAsync(ConnectImapRequest req, CancellationToken ct)
    {
        var tid = ctx.RequireTenantId(); var uid = ctx.RequireUserId();
        var preset = Presets.FirstOrDefault(p => p.Id == req.Provider) ?? throw new ValidationException("provider", "Choose a supported mail provider.");
        var email = (req.Email ?? "").Trim().ToLowerInvariant();
        if (email.Length > 254 || email.Count(c => c == '@') != 1 || email.StartsWith('@') || !email[(email.IndexOf('@') + 1)..].Contains('.') || !System.Net.Mail.MailAddress.TryCreate(email, out var parsed) || parsed.Address != email)
            throw new ValidationException("email", "Enter your full email address.");
        if (string.IsNullOrEmpty(req.Password) || req.Password.Length > 500) throw new ValidationException("password", "Enter the mailbox password or app password.");
        if (await Mine.CountAsync(ct) >= 5) throw new ConflictException("You can connect up to five mail accounts.");
        if (await Mine.AnyAsync(a => a.Email == email, ct)) throw new ConflictException("This mailbox is already connected.");
        var account = new MailAccount { TenantId = tid, UserId = uid, Provider = preset.Id, Email = email, ImapHost = preset.ImapHost, ImapPort = preset.ImapPort,
            SmtpHost = preset.SmtpHost, SmtpPort = preset.SmtpPort, SecretProtected = secrets.Protect(preset.Id == "gmail" ? req.Password.Replace(" ", "") : req.Password) };
        // Prove the sign-in works before keeping anything.
        using (var client = await ImapAsync(account, ct)) await client.DisconnectAsync(true, ct);
        account.LastSyncedAt = clock.Now;
        db.MailAccounts.Add(account);
        recorder.Audit("mailbox.connected", "MailAccount", account.Id, null, new { provider = preset.Id });
        await db.SaveChangesAsync(ct);
        return Dto(account);
    }

    public async Task DisconnectImapAsync(Guid id, CancellationToken ct)
    {
        ctx.RequireTenantId();
        var row = await Mine.SingleOrDefaultAsync(a => a.Id == id, ct) ?? throw new NotFoundException("Mail account not found.");
        db.MailAccounts.Remove(row);
        recorder.Audit("mailbox.disconnected", "MailAccount", id, null, new { provider = row.Provider });
        await db.SaveChangesAsync(ct);
    }

    // ---------- reading ----------

    private static string Folder(string? folder) => folder switch { null or "" or "inbox" => "inbox", "sent" => "sent", _ => throw new ValidationException("folder", "Choose Inbox or Sent.") };
    private static string? OAuth(string? account) => account is "google" or "microsoft" ? account : null;

    private async Task<MailAccount> ImapAccountAsync(string account, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(account)) throw new ValidationException("account", "Choose a connected mail account.");
        if (!account.StartsWith("imap:", StringComparison.Ordinal) || !Guid.TryParse(account[5..], out var id))
            throw new ValidationException("account", "Choose a connected mail account.");
        ctx.RequireTenantId();
        return await Mine.SingleOrDefaultAsync(a => a.Id == id, ct) ?? throw new NotFoundException("Mail account not found.");
    }

    public async Task<MailListDto> ListAsync(string account, string? folder, string? cursor, string? search, CancellationToken ct)
    {
        var f = Folder(folder);
        if (OAuth(account) is { } provider)
        {
            var page = await inbox.ListAsync(provider, cursor, ct, f);
            return new(account, page.Account, f, page.Messages.Select(m => new MailMessageDto(m.Id, m.ThreadId, m.Subject, m.Sender, "", "", m.ReceivedAt, m.Unread, m.HasAttachments)).ToArray(), page.Cursor);
        }
        var row = await ImapAccountAsync(account, ct);
        var offset = int.TryParse(cursor, out var o) && o >= 0 && o < 100000 ? o : 0;
        return await RunImapAsync(row, async client =>
        {
            var box = await OpenAsync(client, f, FolderAccess.ReadOnly, ct);
            const MessageSummaryItems items = MessageSummaryItems.UniqueId | MessageSummaryItems.Envelope | MessageSummaryItems.Flags | MessageSummaryItems.BodyStructure | MessageSummaryItems.InternalDate;
            IList<IMessageSummary> found; string? next = null;
            if (!string.IsNullOrWhiteSpace(search))
            {
                var q = search.Trim(); if (q.Length > 100) q = q[..100];
                var ids = await box.SearchAsync(SearchQuery.SubjectContains(q).Or(SearchQuery.FromContains(q)).Or(SearchQuery.BodyContains(q)), ct);
                var pick = ids.AsEnumerable().Reverse().Skip(offset).Take(PageSize).ToList();
                found = pick.Count == 0 ? [] : await box.FetchAsync(pick, items, ct);
                if (ids.Count > offset + PageSize) next = (offset + PageSize).ToString();
            }
            else
            {
                var max = box.Count - 1 - offset; var min = Math.Max(0, max - PageSize + 1);
                found = max < 0 ? [] : await box.FetchAsync(min, max, items, ct);
                if (min > 0) next = (offset + PageSize).ToString();
            }
            var messages = found.OrderByDescending(m => m.Envelope?.Date ?? m.InternalDate).Select(m => new MailMessageDto(m.UniqueId.Id.ToString(), m.UniqueId.Id.ToString(),
                Clip(m.Envelope?.Subject, 500), Clip(m.Envelope?.From?.ToString(), 500), Clip(m.Envelope?.To?.ToString(), 1000), Clip(m.Envelope?.Cc?.ToString(), 1000),
                m.Envelope?.Date ?? m.InternalDate, m.Flags.HasValue && !m.Flags.Value.HasFlag(MessageFlags.Seen), m.Attachments?.Any() == true)).ToArray();
            return new MailListDto(account, row.Email, f, messages, next);
        }, ct);
    }

    public async Task<MailThreadDto> ThreadAsync(string account, string? folder, string messageId, CancellationToken ct)
    {
        var f = Folder(folder);
        if (string.IsNullOrWhiteSpace(messageId)) throw new ValidationException("messageId", "Choose a message.");
        if (OAuth(account) is { } provider)
        {
            var t = await inbox.ThreadAsync(provider, messageId, ct);
            return new(account, t.Account, f, t.ThreadId, t.Messages.Select(m => new MailMessageDto(m.Id, m.ThreadId, m.Subject, m.Sender, "", "", m.ReceivedAt, m.Unread, m.HasAttachments, m.Body, m.BodyTruncated)).ToArray(), t.Truncated);
        }
        var row = await ImapAccountAsync(account, ct);
        if (!uint.TryParse(messageId, out var uidValue) || uidValue == 0) throw new ValidationException("messageId", "Invalid mailbox message reference.");
        return await RunImapAsync(row, async client =>
        {
            var box = await OpenAsync(client, f, FolderAccess.ReadWrite, ct);
            var uid = new UniqueId(uidValue);
            var message = await box.GetMessageAsync(uid, ct);
            try { await box.StoreAsync(uid, new StoreFlagsRequest(StoreAction.Add, MessageFlags.Seen) { Silent = true }, ct); } catch (Exception e) when (e is ImapCommandException or ImapProtocolException) { /* reading still works */ }
            var dto = ToDto(message, messageId);
            return new MailThreadDto(account, row.Email, f, messageId, [dto], dto.BodyTruncated);
        }, ct);
    }

    private static MailMessageDto ToDto(MimeMessage m, string id)
    {
        var body = m.TextBody;
        if (string.IsNullOrWhiteSpace(body) && m.HtmlBody is { } html) body = HtmlToText(html);
        body ??= "";
        var truncated = body.Length > 20000; if (truncated) body = body[..20000];
        return new(id, id, Clip(m.Subject, 500), Clip(m.From?.ToString(), 500), Clip(m.To?.ToString(), 1000), Clip(m.Cc?.ToString(), 1000), m.Date, false, m.Attachments.Any(), body, truncated);
    }

    public static string HtmlToText(string html)
    {
        var s = Regex.Replace(html, @"<(script|style)[^>]*>.*?</\1>", "", RegexOptions.Singleline | RegexOptions.IgnoreCase);
        s = Regex.Replace(s, @"<br\s*/?>|</p>|</div>|</tr>|</li>|</h\d>", "\n", RegexOptions.IgnoreCase);
        s = Regex.Replace(s, "<[^>]+>", "");
        s = WebUtility.HtmlDecode(s);
        s = Regex.Replace(s, @"[ \t]+\n", "\n");
        return Regex.Replace(s, @"\n{3,}", "\n\n").Trim();
    }

    private static string Clip(string? text, int max) => text is null ? "" : text.Length > max ? text[..max] : text;

    private static async Task<IMailFolder> OpenAsync(ImapClient client, string folder, FolderAccess access, CancellationToken ct)
    {
        IMailFolder? box = client.Inbox;
        if (folder == "sent")
        {
            box = null;
            try { if ((client.Capabilities & (ImapCapabilities.SpecialUse | ImapCapabilities.XList)) != 0) box = client.GetFolder(SpecialFolder.Sent); } catch (NotSupportedException) { }
            if (box == null)
            {
                var personal = client.GetFolder(client.PersonalNamespaces[0]);
                foreach (var candidate in await personal.GetSubfoldersAsync(false, ct))
                    if (candidate.Name is "Sent" or "Sent Items" or "Sent Mail" or "Sent Messages") { box = candidate; break; }
            }
            if (box == null) throw new NotFoundException("This mailbox has no Sent folder.");
        }
        await box.OpenAsync(access, ct);
        return box;
    }

    private async Task<ImapClient> ImapAsync(MailAccount a, CancellationToken ct)
    {
        var client = new ImapClient { Timeout = 20000 };
        try
        {
            await client.ConnectAsync(a.ImapHost, a.ImapPort, SecureSocketOptions.SslOnConnect, ct);
            await client.AuthenticateAsync(a.Email, secrets.Unprotect(a.SecretProtected), ct);
            return client;
        }
        catch (AuthenticationException)
        {
            client.Dispose();
            throw new ConflictException("The mail provider rejected the sign-in. Check the password - many providers need an app password with IMAP switched on.", "MAILBOX_AUTH_FAILED");
        }
        catch (Exception e) when (e is IOException or System.Net.Sockets.SocketException or ImapProtocolException or SslHandshakeException or TimeoutException)
        {
            client.Dispose();
            throw new AppException(502, "MAILBOX_UNREACHABLE", "The mail server could not be reached. Try again.");
        }
    }

    private async Task<T> RunImapAsync<T>(MailAccount row, Func<ImapClient, Task<T>> work, CancellationToken ct)
    {
        try
        {
            using var client = await ImapAsync(row, ct);
            var result = await work(client);
            try { await client.DisconnectAsync(true, ct); } catch (Exception e) when (e is IOException or ImapProtocolException) { }
            await Mine.Where(a => a.Id == row.Id).ExecuteUpdateAsync(s => s.SetProperty(a => a.LastSyncedAt, clock.Now).SetProperty(a => a.LastError, (string?)null), ct);
            return result;
        }
        catch (AppException e)
        {
            await Mine.Where(a => a.Id == row.Id).ExecuteUpdateAsync(s => s.SetProperty(a => a.LastError, Clip(e.Message, 300)), CancellationToken.None);
            throw;
        }
        catch (Exception e) when (e is IOException or ImapProtocolException or ImapCommandException or MessageNotFoundException or FolderNotFoundException)
        {
            throw new AppException(502, "MAILBOX_PROVIDER_ERROR", "The mailbox could not be read. Try again.");
        }
    }

    // ---------- sending ----------

    private static InternetAddressList Addresses(string? text, string field)
    {
        var list = new InternetAddressList();
        if (string.IsNullOrWhiteSpace(text)) return list;
        if (text.Length > 4000 || !InternetAddressList.TryParse(text, out var parsed)) throw new ValidationException(field, "Enter valid email addresses separated by commas.");
        foreach (var m in parsed.Mailboxes) list.Add(m);
        if (list.Count > 50) throw new ValidationException(field, "Send to at most 50 people at once.");
        return list;
    }

    private static string Raw(MimeMessage message)
    {
        using var stream = new MemoryStream();
        message.WriteTo(stream);
        return Convert.ToBase64String(stream.ToArray()).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    /// <summary>The reply's recipients and threading headers, built from the original message's headers.</summary>
    private static (InternetAddressList To, InternetAddressList Cc, string Subject) ReplyHeaders(MimeMessage reply, string self, InternetAddressList from, InternetAddressList replyTo,
        InternetAddressList to, InternetAddressList cc, string subject, string? messageId, IEnumerable<string> references, bool replyAll)
    {
        var target = new InternetAddressList();
        foreach (var m in (replyTo.Mailboxes.Any() ? replyTo : from).Mailboxes) target.Add(m);
        var copies = new InternetAddressList();
        if (replyAll)
        {
            var seen = new HashSet<string>(target.Mailboxes.Select(m => m.Address.ToLowerInvariant())) { self.ToLowerInvariant() };
            foreach (var m in to.Mailboxes.Concat(cc.Mailboxes)) if (seen.Add(m.Address.ToLowerInvariant())) copies.Add(m);
        }
        // Replying to your own sent message goes back to its recipients.
        if (target.Mailboxes.All(m => m.Address.Equals(self, StringComparison.OrdinalIgnoreCase)))
        {
            target.Clear(); foreach (var m in to.Mailboxes) target.Add(m);
        }
        var title = subject.StartsWith("Re:", StringComparison.OrdinalIgnoreCase) ? subject : "Re: " + subject;
        static string Bare(string id) => id.Trim().Trim('<', '>');
        if (!string.IsNullOrWhiteSpace(messageId))
        {
            try
            {
                reply.InReplyTo = Bare(messageId);
                foreach (var r in references) if (Bare(r).Length > 0) reply.References.Add(Bare(r));
                reply.References.Add(Bare(messageId));
            }
            catch (ArgumentException) { /* a malformed header only loses threading */ }
        }
        return (target, copies, title);
    }

    public async Task<MailSendResultDto> SendAsync(MailSendRequest req, CancellationToken ct)
    {
        ctx.RequireTenantId();
        if (!req.Confirmed) throw new ValidationException("confirmed", "Review the message and confirm sending.");
        var body = req.Body ?? "";
        if (string.IsNullOrWhiteSpace(body) || body.Length > 50000) throw new ValidationException("body", "Write a message of up to 50,000 characters.");
        var isReply = !string.IsNullOrWhiteSpace(req.ReplyToId);
        var message = new MimeMessage();
        InternetAddressList to, cc; string subject;
        string? threadId = null;

        if (req.Account == "microsoft")
        {
            var grant = await microsoft.GetMailGrantAsync(ct);
            using var client = http.CreateClient("microsoft-productivity");
            HttpRequestMessage request;
            if (isReply)
            {
                var id = SafeId(req.ReplyToId!);
                request = new HttpRequestMessage(HttpMethod.Post, $"https://graph.microsoft.com/v1.0/me/messages/{Uri.EscapeDataString(id)}/{(req.ReplyAll ? "replyAll" : "reply")}")
                { Content = new StringContent(JsonSerializer.Serialize(new { comment = body }), Encoding.UTF8, "application/json") };
                to = new InternetAddressList(); cc = new InternetAddressList(); subject = "";
            }
            else
            {
                to = Addresses(req.To, "to"); cc = Addresses(req.Cc, "cc"); subject = Subject(req.Subject);
                if (to.Count == 0) throw new ValidationException("to", "Add at least one recipient.");
                object Recipients(InternetAddressList l) => l.Mailboxes.Select(m => new { emailAddress = new { address = m.Address, name = m.Name } }).ToArray();
                request = new HttpRequestMessage(HttpMethod.Post, "https://graph.microsoft.com/v1.0/me/sendMail")
                {
                    Content = new StringContent(JsonSerializer.Serialize(new { message = new { subject, body = new { contentType = "Text", content = body }, toRecipients = Recipients(to), ccRecipients = Recipients(cc) }, saveToSentItems = true }), Encoding.UTF8, "application/json")
                };
            }
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", grant.AccessToken);
            using (request)
            using (var response = await client.SendAsync(request, ct))
                if (!response.IsSuccessStatusCode) throw new AppException(502, "MAILBOX_SEND_FAILED", "Outlook did not accept the message. Reconnect Outlook or try again.");
            await AuditAsync(req, "microsoft");
            return new(true, to.ToString(), cc.ToString(), subject);
        }

        if (req.Account == "google")
        {
            var send = await google.GetAccessGrantAsync(ctx.RequireUserId(), ct, GoogleCalendarAuthService.MailScope);
            var self = send.Account;
            message.From.Add(MailboxAddress.Parse(self));
            using var client = http.CreateClient("google-calendar");
            if (isReply)
            {
                var read = await google.GetAccessGrantAsync(ctx.RequireUserId(), ct, GoogleCalendarAuthService.InboxScope);
                var id = SafeId(req.ReplyToId!);
                if (!id.All(Uri.IsHexDigit)) throw new ValidationException("replyToId", "Invalid mailbox message reference.");
                using var get = new HttpRequestMessage(HttpMethod.Get, $"https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Reply-To");
                get.Headers.Authorization = new AuthenticationHeaderValue("Bearer", read.AccessToken);
                using var got = await client.SendAsync(get, ct);
                if (!got.IsSuccessStatusCode) throw new AppException(502, "MAILBOX_PROVIDER_ERROR", "The original message could not be read from Gmail.");
                using var doc = JsonDocument.Parse(await got.Content.ReadAsStringAsync(ct));
                threadId = doc.RootElement.TryGetProperty("threadId", out var t) ? t.GetString() : null;
                var h = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                if (doc.RootElement.TryGetProperty("payload", out var p) && p.TryGetProperty("headers", out var hs) && hs.ValueKind == JsonValueKind.Array)
                    foreach (var x in hs.EnumerateArray()) h[x.GetProperty("name").GetString() ?? ""] = x.GetProperty("value").GetString() ?? "";
                static InternetAddressList L(string? v) => !string.IsNullOrWhiteSpace(v) && InternetAddressList.TryParse(v, out var l) ? l : new InternetAddressList();
                var refs = (h.GetValueOrDefault("References") ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries).Take(20);
                (to, cc, subject) = ReplyHeaders(message, self, L(h.GetValueOrDefault("From")), L(h.GetValueOrDefault("Reply-To")), L(h.GetValueOrDefault("To")), L(h.GetValueOrDefault("Cc")),
                    h.GetValueOrDefault("Subject") ?? "", h.GetValueOrDefault("Message-ID"), refs, req.ReplyAll);
            }
            else { to = Addresses(req.To, "to"); cc = Addresses(req.Cc, "cc"); subject = Subject(req.Subject); }
            if (to.Count == 0) throw new ValidationException("to", "Add at least one recipient.");
            message.To.AddRange(to); message.Cc.AddRange(cc); message.Subject = subject;
            message.Body = new TextPart("plain") { Text = body };
            using var post = new HttpRequestMessage(HttpMethod.Post, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
            { Content = new StringContent(JsonSerializer.Serialize(new { raw = Raw(message), threadId }), Encoding.UTF8, "application/json") };
            post.Headers.Authorization = new AuthenticationHeaderValue("Bearer", send.AccessToken);
            using (var response = await client.SendAsync(post, ct))
                if (!response.IsSuccessStatusCode) throw new AppException(502, "MAILBOX_SEND_FAILED", "Gmail did not accept the message. Reconnect Gmail with sending allowed, or try again.");
            await AuditAsync(req, "google");
            return new(true, to.ToString(), cc.ToString(), subject);
        }

        var row = await ImapAccountAsync(req.Account, ct);
        message.From.Add(MailboxAddress.Parse(row.Email));
        if (isReply)
        {
            if (!uint.TryParse(req.ReplyToId, out var uidValue) || uidValue == 0) throw new ValidationException("replyToId", "Invalid mailbox message reference.");
            var original = await RunImapAsync(row, async client => { var box = await OpenAsync(client, Folder(req.Folder), FolderAccess.ReadOnly, ct); return await box.GetMessageAsync(new UniqueId(uidValue), ct); }, ct);
            (to, cc, subject) = ReplyHeaders(message, row.Email, original.From, original.ReplyTo, original.To, original.Cc, original.Subject ?? "", original.MessageId, original.References, req.ReplyAll);
        }
        else { to = Addresses(req.To, "to"); cc = Addresses(req.Cc, "cc"); subject = Subject(req.Subject); }
        if (to.Count == 0) throw new ValidationException("to", "Add at least one recipient.");
        message.To.AddRange(to); message.Cc.AddRange(cc); message.Subject = subject;
        message.Body = new TextPart("plain") { Text = body };
        try
        {
            using var smtp = new SmtpClient { Timeout = 20000 };
            await smtp.ConnectAsync(row.SmtpHost, row.SmtpPort, row.SmtpPort == 465 ? SecureSocketOptions.SslOnConnect : SecureSocketOptions.StartTls, ct);
            await smtp.AuthenticateAsync(row.Email, secrets.Unprotect(row.SecretProtected), ct);
            await smtp.SendAsync(message, ct);
            await smtp.DisconnectAsync(true, ct);
        }
        catch (AuthenticationException) { throw new ConflictException("The mail provider rejected the sign-in. Reconnect this mailbox.", "MAILBOX_AUTH_FAILED"); }
        catch (Exception e) when (e is IOException or System.Net.Sockets.SocketException or SmtpCommandException or SmtpProtocolException or SslHandshakeException)
        { throw new AppException(502, "MAILBOX_SEND_FAILED", "The mail server did not accept the message. Try again."); }
        // Keep a copy in Sent, as mail apps do; the message is already on its way if this fails.
        try { await RunImapAsync(row, async client => { var box = await OpenAsync(client, "sent", FolderAccess.ReadWrite, ct); await box.AppendAsync(message, MessageFlags.Seen, ct); return true; }, ct); }
        catch (Exception e) when (e is AppException or NotFoundException or ConflictException) { }
        await AuditAsync(req, row.Provider);
        return new(true, to.ToString(), cc.ToString(), subject);
    }

    private async Task AuditAsync(MailSendRequest req, string provider)
    {
        recorder.Audit("mailbox.sent", "Mailbox", null, null, new { provider, reply = !string.IsNullOrWhiteSpace(req.ReplyToId), replyAll = req.ReplyAll });
        await db.SaveChangesAsync(CancellationToken.None);
    }

    private static string Subject(string? subject)
    {
        var s = (subject ?? "").Trim();
        if (s.Length > 300) throw new ValidationException("subject", "Keep the subject under 300 characters.");
        return s.Replace("\r", " ").Replace("\n", " ");
    }

    private static string SafeId(string id)
    {
        if (id.Length > 500 || id.Any(c => !char.IsAsciiLetterOrDigit(c) && !"_-+/=".Contains(c))) throw new ValidationException("replyToId", "Invalid mailbox message reference.");
        return id;
    }
}
