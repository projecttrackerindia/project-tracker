using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MailKit;
using MailKit.Net.Imap;
using MailKit.Net.Pop3;
using MailKit.Net.Smtp;
using MailKit.Search;
using MailKit.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using MimeKit;
using MimeKit.Utils;
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
/// <summary>The company's mail system as everyone connects to it: the preset's servers, or the ones the administrator entered.</summary>
public record CompanyMailDto(string Provider, string Name, IReadOnlyList<string> Domains, string Incoming = "imap", string IncomingHost = "", int IncomingPort = 993,
    string SmtpHost = "", int SmtpPort = 465, bool Custom = false);
public record MailAccountsDto(IReadOnlyList<MailImapAccountDto> Imap, IReadOnlyList<MailPreset> Presets, CompanyMailDto? Company = null, bool CanManageCompany = false, string? MyEmail = null);
public record SaveCompanyMailRequest(string Provider, string Domains, string? Incoming = null, string? IncomingHost = null, int? IncomingPort = null, string? SmtpHost = null, int? SmtpPort = null);
/// <summary>Tries the servers with one person's sign-in before saving; the password is used once and never kept.</summary>
public record TestCompanyMailRequest(SaveCompanyMailRequest Settings, string Email, string Password);
public record MailServerCheck(string Server, bool Ok, string Detail);
public record TestCompanyMailDto(bool Ok, IReadOnlyList<MailServerCheck> Checks);
public record ConnectImapRequest(string Provider, string Email, string Password);
public record MailMessageDto(string Id, string ThreadId, string Subject, string From, string To, string Cc, DateTimeOffset? Date, bool Unread, bool HasAttachments, string? Body = null, bool BodyTruncated = false);
public record MailListDto(string Account, string Email, string Folder, IReadOnlyList<MailMessageDto> Messages, string? Cursor);
public record MailThreadDto(string Account, string Email, string Folder, string ThreadId, IReadOnlyList<MailMessageDto> Messages, bool Truncated);
public record MailSendRequest(string Account, string? ReplyToId, string? Folder, bool ReplyAll, string? To, string? Cc, string? Subject, string Body, bool Confirmed);
public record MailSendResultDto(bool Accepted, string To, string Cc, string Subject);
/// <summary>Forward one message to new recipients, with the person's own note above it and the original's attachments.</summary>
public record MailForwardRequest(string Account, string? Folder, string MessageId, string To, string? Cc, string? Note, bool Confirmed);

/// <summary>
/// The Mailbox: one place to read and answer the person's own mail - Gmail and Outlook through their existing private grants, and
/// IMAP/SMTP providers such as Rediffmail through a stored, encrypted app password. Mail content is never logged or audited.
/// </summary>
public class MailboxService(IAppDbContext db, ICurrentContext ctx, PersonalInboxService inbox, GoogleCalendarAuthService google,
    MicrosoftProductivityAuthService microsoft, IHttpClientFactory http, ISecretProtector secrets, AppClock clock, Recorder recorder, PermissionService permissions,
    Microsoft.Extensions.Logging.ILogger<MailboxService>? log = null)
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
        new("outlook", "Outlook / Microsoft 365", "outlook.office365.com", 993, "smtp.office365.com", 587, ""),
        new("custom", "Other (enter the servers)", "", 993, "", 465, ""),
    ];
    private static readonly int[] IncomingPorts = [993, 995];
    private static readonly int[] SmtpPorts = [465, 587];
    /// <summary>
    /// The POP servers of the same providers. Some company mailboxes (Rediffmail Pro among them) have only POP switched on, the way Outlook
    /// is often set up; when IMAP sign-in fails, the same password is tried over POP and the inbox is read from there.
    /// </summary>
    private static readonly Dictionary<string, string> PopHosts = new()
    {
        ["rediffpro"] = "pop.rediffmailpro.com", ["rediff"] = "pop.rediffmail.com", ["gmail"] = "pop.gmail.com", ["yahoo"] = "pop.mail.yahoo.com", ["zoho"] = "pop.zoho.com",
    };
    private const int PopPort = 995;
    private static bool IsPop(MailAccount a) => a.ImapPort == PopPort;
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

    private static CompanyMailDto CompanyDto(CompanyMailSettings c)
    {
        var p = Presets.FirstOrDefault(x => x.Id == c.Provider);
        var (incoming, host, port, smtp, smtpPort) = Servers(c);
        return new(c.Provider, p?.Name ?? c.Provider, c.Domains.Split(',', StringSplitOptions.RemoveEmptyEntries), incoming, host, port, smtp, smtpPort, c.IncomingHost is not null);
    }

    /// <summary>The servers people on the company's domains connect to: the administrator's own, or the preset's IMAP and SMTP.</summary>
    private static (string Incoming, string Host, int Port, string Smtp, int SmtpPort) Servers(CompanyMailSettings c)
    {
        var p = Presets.FirstOrDefault(x => x.Id == c.Provider);
        var incoming = c.IncomingProtocol ?? "imap";
        return (incoming, c.IncomingHost ?? p?.ImapHost ?? "", c.IncomingPort ?? (incoming == "pop" ? PopPort : p?.ImapPort ?? 993), c.SmtpHost ?? p?.SmtpHost ?? "", c.SmtpPort ?? p?.SmtpPort ?? 465);
    }

    /// <summary>
    /// Checks servers an administrator typed: a plain host name (not an address), a standard secure mail port, and a host that resolves only to
    /// public addresses, so this setting can never be used to reach the server's own network.
    /// </summary>
    private static async Task<(string Incoming, string Host, int Port, string Smtp, int SmtpPort)?> CheckServersAsync(SaveCompanyMailRequest req, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.IncomingHost) && string.IsNullOrWhiteSpace(req.SmtpHost))
        {
            if (req.Provider == "custom") throw new ValidationException("incomingHost", "Enter the incoming and outgoing mail servers.");
            return null;   // the preset's servers
        }
        var incoming = (req.Incoming ?? "imap").ToLowerInvariant();
        if (incoming is not ("imap" or "pop")) throw new ValidationException("incoming", "Choose IMAP or POP for incoming mail.");
        var host = Host(req.IncomingHost, "incomingHost", "incoming");
        var smtp = Host(req.SmtpHost, "smtpHost", "outgoing (SMTP)");
        var port = req.IncomingPort ?? (incoming == "pop" ? PopPort : 993);
        var smtpPort = req.SmtpPort ?? 465;
        if (!IncomingPorts.Contains(port) || (incoming == "pop") != (port == PopPort))
            throw new ValidationException("incomingPort", incoming == "pop" ? "POP over SSL/TLS uses port 995." : "IMAP over SSL/TLS uses port 993.");
        if (!SmtpPorts.Contains(smtpPort)) throw new ValidationException("smtpPort", "Outgoing mail uses port 465 (SSL/TLS) or 587 (STARTTLS).");
        foreach (var (h, field) in new[] { (host, "incomingHost"), (smtp, "smtpHost") })
        {
            System.Net.IPAddress[] addrs;
            try { addrs = await System.Net.Dns.GetHostAddressesAsync(h, ct); }
            catch (System.Net.Sockets.SocketException) { throw new ValidationException(field, $"{h} could not be found. Check the server name."); }
            if (addrs.Length == 0 || addrs.Any(PrivateAddress)) throw new ValidationException(field, $"{h} points to a private network address, which is not allowed.");
        }
        return (incoming, host, port, smtp, smtpPort);

        static string Host(string? value, string field, string what)
        {
            var h = (value ?? "").Trim().ToLowerInvariant();
            if (h.Length is 0 or > 200 || System.Net.IPAddress.TryParse(h, out _) || !Regex.IsMatch(h, @"^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$"))
                throw new ValidationException(field, $"Enter the {what} server name, like pop.rediffmailpro.com.");
            return h;
        }
    }

    private static bool PrivateAddress(System.Net.IPAddress a)
    {
        if (System.Net.IPAddress.IsLoopback(a)) return true;
        if (a.IsIPv4MappedToIPv6) a = a.MapToIPv4();
        if (a.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6) return a.IsIPv6LinkLocal || a.IsIPv6SiteLocal || a.IsIPv6UniqueLocal;
        var b = a.GetAddressBytes();
        return b[0] is 10 or 127 or 0 || (b[0] == 172 && b[1] is >= 16 and <= 31) || (b[0] == 192 && b[1] == 168) || (b[0] == 169 && b[1] == 254) || (b[0] == 100 && b[1] is >= 64 and <= 127);
    }

    /// <summary>
    /// Owners and admins try the servers with their own mailbox before saving: incoming sign-in (IMAP or POP) and outgoing sign-in (SMTP).
    /// The password is used for this check only and is never stored or logged.
    /// </summary>
    public async Task<TestCompanyMailDto> TestCompanyAsync(TestCompanyMailRequest req, CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.OrgManage, ct);
        if (string.IsNullOrEmpty(req.Password) || req.Password.Length > 500) throw new ValidationException("password", "Enter the mailbox password.");
        var email = (req.Email ?? "").Trim().ToLowerInvariant();
        if (!System.Net.Mail.MailAddress.TryCreate(email, out _)) throw new ValidationException("email", "Enter a full email address on the company's mail.");
        var preset = Presets.FirstOrDefault(p => p.Id == req.Settings.Provider) ?? throw new ValidationException("provider", "Choose your company's mail provider.");
        var custom = await CheckServersAsync(req.Settings, ct);
        var (incoming, host, port, smtp, smtpPort) = custom ?? ("imap", preset.ImapHost, preset.ImapPort, preset.SmtpHost, preset.SmtpPort);
        var secret = secrets.Protect(req.Password);
        var probe = new MailAccount { Email = email, ImapHost = host, ImapPort = port, SmtpHost = smtp, SmtpPort = smtpPort, SecretProtected = secret };
        var checks = new List<MailServerCheck>();
        try
        {
            if (incoming == "pop") { using var pop = await PopAsync(probe, ct); await pop.DisconnectAsync(true, ct); }
            else { using var imap = await ImapAsync(probe, ct); await imap.DisconnectAsync(true, ct); }
            checks.Add(new($"{(incoming == "pop" ? "POP" : "IMAP")} {host}:{port}", true, "Signed in."));
        }
        catch (AppException e) { checks.Add(new($"{(incoming == "pop" ? "POP" : "IMAP")} {host}:{port}", false, e.Message)); }
        try
        {
            using var client = new SmtpClient { Timeout = 20000 };
            await client.ConnectAsync(smtp, smtpPort, smtpPort == 465 ? SecureSocketOptions.SslOnConnect : SecureSocketOptions.StartTls, ct);
            await client.AuthenticateAsync(email, req.Password, ct);
            await client.DisconnectAsync(true, ct);
            checks.Add(new($"SMTP {smtp}:{smtpPort}", true, "Signed in; mail can be sent."));
        }
        catch (AuthenticationException) { checks.Add(new($"SMTP {smtp}:{smtpPort}", false, "The server rejected the sign-in.")); }
        catch (Exception e) when (e is IOException or System.Net.Sockets.SocketException or SmtpCommandException or SmtpProtocolException or SslHandshakeException or TimeoutException)
        {
            log?.LogInformation("SMTP test to {Host}:{Port} failed with {Type}: {Message}", smtp, smtpPort, e.GetType().Name, e.Message);
            checks.Add(new($"SMTP {smtp}:{smtpPort}", false, "The server could not be reached on this port."));
        }
        return new(checks.All(c => c.Ok), checks);
    }

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
        var servers = await CheckServersAsync(req, ct);
        if (row is null) { row = new CompanyMailSettings { TenantId = tid, CreatedAt = clock.Now, CreatedBy = ctx.UserId }; db.CompanyMailSettings.Add(row); }
        row.Provider = req.Provider; row.Domains = string.Join(',', domains); row.UpdatedAt = clock.Now; row.UpdatedBy = ctx.UserId;
        row.IncomingProtocol = servers?.Incoming; row.IncomingHost = servers?.Host; row.IncomingPort = servers?.Port; row.SmtpHost = servers?.Smtp; row.SmtpPort = servers?.SmtpPort;
        recorder.Audit("mailbox.company_set", "CompanyMailSettings", row.Id, null, new { provider = req.Provider, domains = row.Domains, row.IncomingProtocol, row.IncomingHost, row.IncomingPort, row.SmtpHost, row.SmtpPort });
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
        // An address on the company's domains uses the servers the administrator set (IMAP or POP), whatever was picked.
        var company = await db.CompanyMailSettings.AsNoTracking().FirstOrDefaultAsync(ct);
        var companyDomain = company is not null && company.Domains.Split(',', StringSplitOptions.RemoveEmptyEntries).Any(d => email.EndsWith("@" + d, StringComparison.Ordinal));
        if (companyDomain)
        {
            var (_, host, port, smtp, smtpPort) = Servers(company!);
            account.Provider = company!.Provider; account.ImapHost = host; account.ImapPort = port; account.SmtpHost = smtp; account.SmtpPort = smtpPort;
        }
        else if (preset.Id == "custom") throw new ValidationException("provider", "Choose your mail provider, or ask an administrator to set up the company's mail servers.");
        // Prove the sign-in works before keeping anything: IMAP first, then POP with the same password (mailboxes with only POP switched on).
        if (IsPop(account)) { using (var popClient = await PopAsync(account, ct)) await popClient.DisconnectAsync(true, ct); }
        else try { using (var client = await ImapAsync(account, ct)) await client.DisconnectAsync(true, ct); }
        catch (AppException imapFailure) when (imapFailure.Code is "MAILBOX_AUTH_FAILED" or "MAILBOX_SIGNIN_FAILED" && !companyDomain && PopHosts.TryGetValue(preset.Id, out var popHost))
        {
            var pop = new MailAccount { Email = email, ImapHost = popHost, ImapPort = PopPort, SecretProtected = account.SecretProtected };
            try { using (var client = await PopAsync(pop, ct)) await client.DisconnectAsync(true, ct); }
            catch (AppException) { throw imapFailure; }
            account.ImapHost = popHost; account.ImapPort = PopPort;
            log?.LogInformation("Mailbox for {Provider} connected over POP (IMAP sign-in was refused)", preset.Id);
        }
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
        if (IsPop(row)) return await PopListAsync(row, account, f, offset, search, ct);
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
        if (IsPop(row))
        {
            var popMessage = await PopMessageAsync(row, messageId, ct);
            var popDto = ToDto(popMessage, messageId);
            return new MailThreadDto(account, row.Email, f, messageId, [popDto], popDto.BodyTruncated);
        }
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
        // Some servers (Rediffmail Pro among them) offer only AUTH=PLAIN and answer it in a way the SASL exchange does not accept, so the
        // sign-in never reaches the password check. Then the classic IMAP LOGIN command is tried once on a fresh connection.
        try { return await SignInAsync(a, plainLogin: false, ct); }
        catch (Exception e) when (e is ImapProtocolException or ImapCommandException or IOException)
        {
            log?.LogInformation("IMAP sign-in to {Host} failed with {Type}: {Message}; trying LOGIN", a.ImapHost, e.GetType().Name, e.Message);
            return await SignInAsync(a, plainLogin: true, ct);
        }
    }

    private async Task<ImapClient> SignInAsync(MailAccount a, bool plainLogin, CancellationToken ct)
    {
        var client = new ImapClient { Timeout = 20000 };
        try
        {
            await client.ConnectAsync(a.ImapHost, a.ImapPort, SecureSocketOptions.SslOnConnect, ct);
        }
        catch (Exception e) when (e is IOException or System.Net.Sockets.SocketException or ImapProtocolException or SslHandshakeException or TimeoutException)
        {
            client.Dispose();
            log?.LogWarning("IMAP connection to {Host}:{Port} failed with {Type}: {Message}", a.ImapHost, a.ImapPort, e.GetType().Name, e.Message);
            throw new AppException(502, "MAILBOX_UNREACHABLE", e is SslHandshakeException
                ? "The mail server's secure connection could not be verified. Try again later."
                : "The mail server could not be reached. Try again.");
        }
        try
        {
            if (plainLogin) client.AuthenticationMechanisms.Clear();   // MailKit then sends LOGIN user password
            await client.AuthenticateAsync(a.Email, secrets.Unprotect(a.SecretProtected), ct);
            return client;
        }
        catch (AuthenticationException)
        {
            client.Dispose();
            throw new ConflictException("The mail provider rejected the sign-in. Check the email address and password - for company mail, use the password you sign in to webmail with; some providers need IMAP switched on by your mail admin.", "MAILBOX_AUTH_FAILED");
        }
        catch (Exception e) when (plainLogin && e is ImapProtocolException or ImapCommandException or IOException)
        {
            client.Dispose();
            log?.LogWarning("IMAP LOGIN to {Host} failed with {Type}: {Message}", a.ImapHost, e.GetType().Name, e.Message);
            throw new AppException(502, "MAILBOX_SIGNIN_FAILED", "The mail server did not accept the sign-in method. Ask your mail admin to allow IMAP access for your mailbox.");
        }
        catch { client.Dispose(); throw; }
    }

    // ------------------------------------------------------------------ POP (inbox only, newest first, read without removing anything)

    private async Task<Pop3Client> PopAsync(MailAccount a, CancellationToken ct)
    {
        var client = new Pop3Client { Timeout = 20000 };
        try
        {
            await client.ConnectAsync(a.ImapHost, a.ImapPort, SecureSocketOptions.SslOnConnect, ct);
            await client.AuthenticateAsync(a.Email, secrets.Unprotect(a.SecretProtected), ct);
            return client;
        }
        catch (AuthenticationException)
        {
            client.Dispose();
            throw new ConflictException("The mail provider rejected the sign-in. Check the email address and password - for company mail, use the password you sign in to webmail or Outlook with.", "MAILBOX_AUTH_FAILED");
        }
        catch (Exception e) when (e is IOException or System.Net.Sockets.SocketException or Pop3ProtocolException or Pop3CommandException or SslHandshakeException or TimeoutException)
        {
            client.Dispose();
            log?.LogWarning("POP connection to {Host}:{Port} failed with {Type}: {Message}", a.ImapHost, a.ImapPort, e.GetType().Name, e.Message);
            throw new AppException(502, "MAILBOX_UNREACHABLE", "The mail server could not be reached. Try again.");
        }
    }

    private async Task<T> RunPopAsync<T>(MailAccount row, Func<Pop3Client, Task<T>> work, CancellationToken ct)
    {
        try
        {
            using var client = await PopAsync(row, ct);
            var result = await work(client);
            try { await client.DisconnectAsync(true, ct); } catch (Exception e) when (e is IOException or Pop3ProtocolException) { }
            await Mine.Where(a => a.Id == row.Id).ExecuteUpdateAsync(x => x.SetProperty(a => a.LastSyncedAt, clock.Now).SetProperty(a => a.LastError, (string?)null), ct);
            return result;
        }
        catch (AppException e)
        {
            await Mine.Where(a => a.Id == row.Id).ExecuteUpdateAsync(x => x.SetProperty(a => a.LastError, Clip(e.Message, 300)), CancellationToken.None);
            throw;
        }
    }

    /// <summary>POP message references are the server's unique ids (UIDL), carried as "pop-" plus URL-safe base64.</summary>
    private static string PopId(string uid) => "pop-" + Convert.ToBase64String(Encoding.UTF8.GetBytes(uid)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static string? PopUid(string id)
    {
        if (!id.StartsWith("pop-", StringComparison.Ordinal) || id.Length > 200) return null;
        var b = id[4..].Replace('-', '+').Replace('_', '/');
        b = b.PadRight(b.Length + (4 - b.Length % 4) % 4, '=');
        try { return Encoding.UTF8.GetString(Convert.FromBase64String(b)); } catch (FormatException) { return null; }
    }

    private Task<MailListDto> PopListAsync(MailAccount row, string account, string folder, int offset, string? search, CancellationToken ct) => RunPopAsync(row, async client =>
    {
        if (folder != "inbox") return new MailListDto(account, row.Email, folder, [], null);   // POP only has the inbox
        var count = await client.GetMessageCountAsync(ct);
        var uids = client.SupportsUids ? await client.GetMessageUidsAsync(ct) : null;
        var q = (search ?? "").Trim();
        var list = new List<MailMessageDto>(); string? next = null;
        // Newest first; a search looks through the latest 300 messages' headers.
        var scan = string.IsNullOrEmpty(q) ? PageSize : 300;
        var hi = count - 1 - offset; var lo = Math.Max(0, hi - scan + 1);
        for (var i = hi; i >= lo && list.Count < PageSize; i--)
        {
            var h = await client.GetMessageHeadersAsync(i, ct);
            var subject = h[HeaderId.Subject] ?? ""; var from = h[HeaderId.From] ?? "";
            if (q.Length > 0 && !subject.Contains(q, StringComparison.OrdinalIgnoreCase) && !from.Contains(q, StringComparison.OrdinalIgnoreCase)) continue;
            DateTimeOffset? date = DateUtils.TryParse(h[HeaderId.Date] ?? "", out var d) ? d : null;
            var id = uids is not null ? PopId(uids[i]) : PopId("#" + i);
            list.Add(new MailMessageDto(id, id, Clip(Decode(subject), 500), Clip(Decode(from), 500), Clip(Decode(h[HeaderId.To] ?? ""), 1000), Clip(Decode(h[HeaderId.Cc] ?? ""), 1000),
                date, false, (h[HeaderId.ContentType] ?? "").Contains("multipart/mixed", StringComparison.OrdinalIgnoreCase)));
        }
        if (lo > 0 && string.IsNullOrEmpty(q)) next = (offset + PageSize).ToString();
        return new MailListDto(account, row.Email, folder, list, next);
    }, ct);

    private static string Decode(string header) { try { return Rfc2047.DecodeText(Encoding.UTF8.GetBytes(header)); } catch (Exception) { return header; } }

    private Task<MimeMessage> PopMessageAsync(MailAccount row, string id, CancellationToken ct) => RunPopAsync(row, async client =>
    {
        var uid = PopUid(id) ?? throw new ValidationException("messageId", "Invalid mailbox message reference.");
        int index;
        if (uid.StartsWith('#') && int.TryParse(uid[1..], out var n)) index = n;
        else
        {
            var uids = client.SupportsUids ? await client.GetMessageUidsAsync(ct) : [];
            index = uids.ToList().IndexOf(uid);
        }
        if (index < 0 || index >= await client.GetMessageCountAsync(ct)) throw new NotFoundException("That message is no longer in the mailbox.");
        return await client.GetMessageAsync(index, ct);
    }, ct);

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
            MimeMessage original;
            if (IsPop(row)) original = await PopMessageAsync(row, req.ReplyToId ?? "", ct);
            else
            {
                if (!uint.TryParse(req.ReplyToId, out var uidValue) || uidValue == 0) throw new ValidationException("replyToId", "Invalid mailbox message reference.");
                original = await RunImapAsync(row, async client => { var box = await OpenAsync(client, Folder(req.Folder), FolderAccess.ReadOnly, ct); return await box.GetMessageAsync(new UniqueId(uidValue), ct); }, ct);
            }
            (to, cc, subject) = ReplyHeaders(message, row.Email, original.From, original.ReplyTo, original.To, original.Cc, original.Subject ?? "", original.MessageId, original.References, req.ReplyAll);
        }
        else { to = Addresses(req.To, "to"); cc = Addresses(req.Cc, "cc"); subject = Subject(req.Subject); }
        if (to.Count == 0) throw new ValidationException("to", "Add at least one recipient.");
        message.To.AddRange(to); message.Cc.AddRange(cc); message.Subject = subject;
        message.Body = new TextPart("plain") { Text = body };
        await SmtpSendAsync(row, message, ct);
        await AuditAsync(req, row.Provider);
        return new(true, to.ToString(), cc.ToString(), subject);
    }

    /// <summary>Largest total of attachments forwarded with a message; above it the person forwards from their mail app.</summary>
    public const long ForwardAttachmentLimit = 20L * 1024 * 1024;

    /// <summary>
    /// Forwards a message from the person's own mailbox: their note, then the original (who sent it, when, to whom, its subject and text), with
    /// the original's attachments. Outlook forwards natively; Gmail and company mail rebuild the message from the original.
    /// </summary>
    public async Task<MailSendResultDto> ForwardAsync(MailForwardRequest req, CancellationToken ct)
    {
        ctx.RequireTenantId();
        if (!req.Confirmed) throw new ValidationException("confirmed", "Review the message and confirm forwarding.");
        if (string.IsNullOrWhiteSpace(req.MessageId)) throw new ValidationException("messageId", "Choose the message to forward.");
        var note = (req.Note ?? "").Trim();
        if (note.Length > 20000) throw new ValidationException("note", "Keep the note under 20,000 characters.");
        var to = Addresses(req.To, "to"); var cc = Addresses(req.Cc, "cc");
        if (to.Count == 0) throw new ValidationException("to", "Add at least one recipient.");

        if (req.Account == "microsoft")
        {
            var grant = await microsoft.GetMailGrantAsync(ct);
            using var client = http.CreateClient("microsoft-productivity");
            object Recipients(InternetAddressList l) => l.Mailboxes.Select(m => new { emailAddress = new { address = m.Address, name = m.Name } }).ToArray();
            var id = SafeId(req.MessageId);
            using var request = new HttpRequestMessage(HttpMethod.Post, $"https://graph.microsoft.com/v1.0/me/messages/{Uri.EscapeDataString(id)}/forward")
            {
                Content = new StringContent(JsonSerializer.Serialize(new { comment = note, toRecipients = Recipients(to), ccRecipients = Recipients(cc) }), Encoding.UTF8, "application/json"),
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", grant.AccessToken);
            using (var response = await client.SendAsync(request, ct))
                if (!response.IsSuccessStatusCode) throw new AppException(502, "MAILBOX_SEND_FAILED", "Outlook did not forward the message. Reconnect Outlook or try again.");
            await AuditForwardAsync("microsoft", to.Count + cc.Count);
            return new(true, to.ToString(), cc.ToString(), "");
        }

        if (req.Account == "google")
        {
            var read = await google.GetAccessGrantAsync(ctx.RequireUserId(), ct, GoogleCalendarAuthService.InboxScope);
            var send = await google.GetAccessGrantAsync(ctx.RequireUserId(), ct, GoogleCalendarAuthService.MailScope);
            var id = SafeId(req.MessageId);
            if (!id.All(Uri.IsHexDigit)) throw new ValidationException("messageId", "Invalid mailbox message reference.");
            using var client = http.CreateClient("google-calendar");
            using var get = new HttpRequestMessage(HttpMethod.Get, $"https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=raw");
            get.Headers.Authorization = new AuthenticationHeaderValue("Bearer", read.AccessToken);
            MimeMessage original;
            using (var got = await client.SendAsync(get, ct))
            {
                if (!got.IsSuccessStatusCode) throw new AppException(502, "MAILBOX_PROVIDER_ERROR", "The original message could not be read from Gmail.");
                using var doc = JsonDocument.Parse(await got.Content.ReadAsStringAsync(ct));
                var raw = doc.RootElement.TryGetProperty("raw", out var r) ? r.GetString() ?? "" : "";
                original = LoadRaw(raw);
            }
            var forward = ForwardMessage(original, MailboxAddress.Parse(send.Account), to, cc, note);
            using var post = new HttpRequestMessage(HttpMethod.Post, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
            { Content = new StringContent(JsonSerializer.Serialize(new { raw = Raw(forward) }), Encoding.UTF8, "application/json") };
            post.Headers.Authorization = new AuthenticationHeaderValue("Bearer", send.AccessToken);
            using (var response = await client.SendAsync(post, ct))
                if (!response.IsSuccessStatusCode) throw new AppException(502, "MAILBOX_SEND_FAILED", "Gmail did not accept the message. Reconnect Gmail with sending allowed, or try again.");
            await AuditForwardAsync("google", to.Count + cc.Count);
            return new(true, to.ToString(), cc.ToString(), forward.Subject ?? "");
        }

        var row = await ImapAccountAsync(req.Account, ct);
        MimeMessage source;
        if (IsPop(row)) source = await PopMessageAsync(row, req.MessageId, ct);
        else
        {
            if (!uint.TryParse(req.MessageId, out var uidValue) || uidValue == 0) throw new ValidationException("messageId", "Invalid mailbox message reference.");
            source = await RunImapAsync(row, async client => { var box = await OpenAsync(client, Folder(req.Folder), FolderAccess.ReadOnly, ct); return await box.GetMessageAsync(new UniqueId(uidValue), ct); }, ct);
        }
        var message = ForwardMessage(source, MailboxAddress.Parse(row.Email), to, cc, note);
        await SmtpSendAsync(row, message, ct);
        await AuditForwardAsync(row.Provider, to.Count + cc.Count);
        return new(true, to.ToString(), cc.ToString(), message.Subject ?? "");
    }

    private static MimeMessage LoadRaw(string base64Url)
    {
        if (string.IsNullOrEmpty(base64Url)) throw new AppException(502, "MAILBOX_PROVIDER_ERROR", "The original message could not be read.");
        var b = base64Url.Replace('-', '+').Replace('_', '/');
        b = b.PadRight(b.Length + (4 - b.Length % 4) % 4, '=');
        using var stream = new MemoryStream(Convert.FromBase64String(b));
        return MimeMessage.Load(stream);
    }

    /// <summary>
    /// The forwarded message: "Fwd:" subject, the note, the usual "Forwarded message" block with the original's sender, date, subject and
    /// recipients and its text, and the original's attachments (refused above <see cref="ForwardAttachmentLimit"/>).
    /// </summary>
    public static MimeMessage ForwardMessage(MimeMessage original, MailboxAddress from, InternetAddressList to, InternetAddressList cc, string? note)
    {
        var subject = original.Subject ?? "";
        var message = new MimeMessage();
        message.From.Add(from);
        message.To.AddRange(to); message.Cc.AddRange(cc);
        message.Subject = (subject.StartsWith("Fwd:", StringComparison.OrdinalIgnoreCase) || subject.StartsWith("Fw:", StringComparison.OrdinalIgnoreCase) ? subject : "Fwd: " + subject).Replace("\r", " ").Replace("\n", " ");
        var text = original.TextBody ?? (original.HtmlBody is { } html ? HtmlToText(html) : "");
        var header = new StringBuilder();
        if (!string.IsNullOrWhiteSpace(note)) header.Append(note.Trim()).Append("\n\n");
        header.Append("---------- Forwarded message ---------\n");
        header.Append("From: ").Append(original.From.ToString()).Append('\n');
        if (original.Date != DateTimeOffset.MinValue) header.Append("Date: ").Append(original.Date.ToString("ddd, d MMM yyyy HH:mm zzz", System.Globalization.CultureInfo.InvariantCulture)).Append('\n');
        header.Append("Subject: ").Append(subject).Append('\n');
        header.Append("To: ").Append(original.To.ToString()).Append('\n');
        if (original.Cc.Count > 0) header.Append("Cc: ").Append(original.Cc.ToString()).Append('\n');
        header.Append('\n').Append(text);
        var builder = new BodyBuilder { TextBody = header.ToString() };
        long total = 0;
        foreach (var part in original.Attachments)
        {
            if (part is MimePart mime)
            {
                using var buffer = new MemoryStream();
                mime.Content?.DecodeTo(buffer);
                total += buffer.Length;
                if (total > ForwardAttachmentLimit) throw new ValidationException("attachments", "The attachments are too large to forward from here. Forward it from your mail app.");
                var name = mime.FileName ?? "attachment";
                builder.Attachments.Add(name, buffer.ToArray(), mime.ContentType);
            }
            else if (part is MessagePart inner && inner.Message is { } attached)
            {
                using var buffer = new MemoryStream();
                attached.WriteTo(buffer);
                total += buffer.Length;
                if (total > ForwardAttachmentLimit) throw new ValidationException("attachments", "The attachments are too large to forward from here. Forward it from your mail app.");
                builder.Attachments.Add(new MessagePart { Message = attached });
            }
        }
        message.Body = builder.ToMessageBody();
        if (!string.IsNullOrWhiteSpace(original.MessageId)) message.References.Add(original.MessageId);
        return message;
    }

    /// <summary>Sends through the account's own mail server and keeps a copy in Sent (IMAP), as mail apps do.</summary>
    private async Task SmtpSendAsync(MailAccount row, MimeMessage message, CancellationToken ct)
    {
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
        if (!IsPop(row)) try { await RunImapAsync(row, async client => { var box = await OpenAsync(client, "sent", FolderAccess.ReadWrite, ct); await box.AppendAsync(message, MessageFlags.Seen, ct); return true; }, ct); }
        catch (Exception e) when (e is AppException or NotFoundException or ConflictException) { }
    }

    private async Task AuditForwardAsync(string provider, int recipients)
    {
        recorder.Audit("mailbox.forwarded", "Mailbox", null, null, new { provider, recipients });
        await db.SaveChangesAsync(CancellationToken.None);
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
