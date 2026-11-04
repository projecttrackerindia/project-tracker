using System.Text.Json;
using MailKit;
using MailKit.Net.Imap;
using MailKit.Search;
using MailKit.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Mailbox;

/// <summary>Only what an alert needs: never the body.</summary>
public record MailHeader(uint Uid, string MessageId, string From, string Subject, DateTimeOffset Received);
/// <summary>The inbox's UIDVALIDITY, its highest UID now, and the headers of the messages newer than the last one seen (oldest first).</summary>
public record MailPollResult(uint UidValidity, uint HighestUid, IReadOnlyList<MailHeader> New);

/// <summary>Reads new message headers from a connected mailbox. Swapped for a fake in tests.</summary>
public interface IMailHeaderSource
{
    /// <param name="lastUid">The highest UID already seen (0 on the first look, which only sets the baseline).</param>
    Task<MailPollResult> PollAsync(MailAccount account, uint lastUid, int max, CancellationToken ct);
}

/// <summary>
/// IMAP UID polling: signs in with the stored (encrypted) password, opens the inbox read-only, asks for UIDs above the last one seen and
/// fetches only their envelopes. Nothing is marked read and no body is downloaded.
/// </summary>
public class ImapHeaderSource(ISecretProtector secrets) : IMailHeaderSource
{
    public async Task<MailPollResult> PollAsync(MailAccount a, uint lastUid, int max, CancellationToken ct)
    {
        using var client = new ImapClient { Timeout = 20000 };
        await client.ConnectAsync(a.ImapHost, a.ImapPort, SecureSocketOptions.SslOnConnect, ct);
        try { await client.AuthenticateAsync(a.Email, secrets.Unprotect(a.SecretProtected), ct); }
        catch (Exception e) when (e is ImapProtocolException or ImapCommandException)
        {
            // Some servers only accept the classic LOGIN command (see MailboxService.ImapAsync).
            client.Dispose();
            using var retry = new ImapClient { Timeout = 20000 };
            await retry.ConnectAsync(a.ImapHost, a.ImapPort, SecureSocketOptions.SslOnConnect, ct);
            retry.AuthenticationMechanisms.Clear();
            await retry.AuthenticateAsync(a.Email, secrets.Unprotect(a.SecretProtected), ct);
            return await ReadAsync(retry, lastUid, max, ct);
        }
        return await ReadAsync(client, lastUid, max, ct);
    }

    private static async Task<MailPollResult> ReadAsync(ImapClient client, uint lastUid, int max, CancellationToken ct)
    {
        var inbox = client.Inbox;
        await inbox.OpenAsync(FolderAccess.ReadOnly, ct);
        var validity = inbox.UidValidity;
        var next = inbox.UidNext?.Id ?? 0;
        var highest = next > 0 ? next - 1 : 0u;
        var headers = new List<MailHeader>();
        if (lastUid > 0 && highest > lastUid)
        {
            var uids = await inbox.SearchAsync(SearchQuery.Uids(new UniqueIdRange(new UniqueId(lastUid + 1), UniqueId.MaxValue)), ct);
            var pick = uids.Where(u => u.Id > lastUid).OrderBy(u => u.Id).TakeLast(max).ToList();
            if (pick.Count > 0)
                foreach (var s in await inbox.FetchAsync(pick, MessageSummaryItems.UniqueId | MessageSummaryItems.Envelope | MessageSummaryItems.InternalDate, ct))
                    headers.Add(new MailHeader(s.UniqueId.Id, s.Envelope?.MessageId ?? $"uid:{s.UniqueId.Id}",
                        s.Envelope?.From?.Mailboxes.FirstOrDefault() is { } f ? (string.IsNullOrWhiteSpace(f.Name) ? f.Address : f.Name) : "Someone",
                        s.Envelope?.Subject ?? "(no subject)", s.InternalDate ?? s.Envelope?.Date ?? DateTimeOffset.UtcNow));
            if (uids.Count > 0) highest = Math.Max(highest, uids.Max(u => u.Id));
        }
        await client.DisconnectAsync(true, ct);
        return new MailPollResult(validity, highest, headers.OrderBy(h => h.Uid).ToList());
    }
}

/// <summary>What the watcher remembers per mailbox (in UserUiPreferences, key "mw:{account}"): the last UID, never message content.</summary>
public class MailWatchState
{
    public uint UidValidity { get; set; }
    public uint LastUid { get; set; }
    public int Failures { get; set; }
    public DateTime NextAt { get; set; }
    /// <summary>The last few headers alerted on (from, subject, received, message id), so a repeat is never alerted twice.</summary>
    public List<string> Recent { get; set; } = [];
    /// <summary>Outlook: the Graph delta link of the inbox (an opaque address; it names no message content).</summary>
    public string? DeltaLink { get; set; }
}

/// <summary>Outlook through Microsoft Graph: the inbox's new messages since the last delta link, headers only.</summary>
public record GraphPollResult(string DeltaLink, IReadOnlyList<MailHeader> New);
public interface IGraphMailSource
{
    /// <param name="deltaLink">Null on the first look, which only sets the baseline (messages from now on).</param>
    Task<GraphPollResult> PollAsync(Guid tenantId, Guid userId, string? deltaLink, int max, CancellationToken ct);
}

/// <summary>
/// Graph delta query on the inbox: the first call asks only for messages received from now on (the baseline), later calls follow the delta
/// link and keep only created messages ($select of id, internetMessageId, from, subject, receivedDateTime - never the body).
/// </summary>
public class GraphMailSource(ProjectManagement.Application.Features.Integrations.MicrosoftProductivityAuthService microsoft, IHttpClientFactory http, AppClock clock) : IGraphMailSource
{
    private const string Select = "id,internetMessageId,from,subject,receivedDateTime";
    public async Task<GraphPollResult> PollAsync(Guid tenantId, Guid userId, string? deltaLink, int max, CancellationToken ct)
    {
        var grant = await microsoft.GetInboxGrantForAsync(tenantId, userId, ct);
        var url = deltaLink ?? $"https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$select={Select}&$filter=receivedDateTime+ge+{clock.Now:yyyy-MM-ddTHH:mm:ssZ}";
        if (!url.StartsWith("https://graph.microsoft.com/", StringComparison.Ordinal)) throw new InvalidOperationException("Unexpected delta link");
        var found = new List<MailHeader>();
        using var client = http.CreateClient();
        for (var page = 0; page < 10; page++)
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", grant.AccessToken);
            req.Headers.TryAddWithoutValidation("Prefer", $"odata.maxpagesize={Math.Clamp(max, 1, 50)}");
            using var res = await client.SendAsync(req, ct);
            if ((int)res.StatusCode == 410) return new GraphPollResult("", []);   // the delta link expired: a new baseline next time
            res.EnsureSuccessStatusCode();
            using var doc = await JsonDocument.ParseAsync(await res.Content.ReadAsStreamAsync(ct), cancellationToken: ct);
            var root = doc.RootElement;
            if (root.TryGetProperty("value", out var items) && items.ValueKind == JsonValueKind.Array && deltaLink is not null)
                foreach (var m in items.EnumerateArray())
                {
                    if (m.TryGetProperty("@removed", out _) || !m.TryGetProperty("receivedDateTime", out var rec)) continue;
                    var from = m.TryGetProperty("from", out var f) && f.ValueKind == JsonValueKind.Object && f.TryGetProperty("emailAddress", out var ea)
                        ? (ea.TryGetProperty("name", out var n) && n.GetString() is { Length: > 0 } name ? name : ea.TryGetProperty("address", out var ad) ? ad.GetString() ?? "Someone" : "Someone") : "Someone";
                    var id = m.TryGetProperty("internetMessageId", out var mid) && mid.GetString() is { Length: > 0 } x ? x : m.GetProperty("id").GetString() ?? "";
                    found.Add(new MailHeader(0, id, from, m.TryGetProperty("subject", out var sub) ? sub.GetString() ?? "(no subject)" : "(no subject)",
                        DateTimeOffset.TryParse(rec.GetString(), out var at) ? at : DateTimeOffset.UtcNow));
                }
            if (root.TryGetProperty("@odata.nextLink", out var next) && next.GetString() is { } nl) { url = nl; continue; }
            var link = root.TryGetProperty("@odata.deltaLink", out var d) ? d.GetString() ?? "" : "";
            return new GraphPollResult(link, found.OrderBy(h => h.Received).TakeLast(max).ToList());
        }
        return new GraphPollResult(url, found.OrderBy(h => h.Received).TakeLast(max).ToList());
    }
}

/// <summary>
/// The background mail watcher: every connected IMAP mailbox is looked at every couple of minutes (UID polling); a message newer than the
/// last one seen becomes a notification ("New mail from ..."), which then goes out like any other - bell and badge, live announce, sound,
/// desktop and push - under the person's own settings, quiet hours and Do not disturb. Each mailbox backs off after failures (up to an
/// hour), at most <see cref="MaxPerRun"/> mailboxes are polled per run, and a burst gives one summary instead of many alerts.
/// </summary>
public class MailWatchMonitor(IAppDbContext db, IMailHeaderSource source, IGraphMailSource graph, NotificationRouter router, AppClock clock, ILogger<MailWatchMonitor> log)
{
    public const int MaxPerRun = 50;
    public const int MaxAlertsPerPoll = 3;
    public static readonly TimeSpan Every = TimeSpan.FromMinutes(2);
    private const int PopPort = 995;
    public static string KeyOf(Guid accountId) => $"mw:{accountId:N}";

    public async Task<int> RunAsync(CancellationToken ct = default)
    {
        var now = clock.Now;
        // Background: no signed-in workspace, so every mailbox is listed with its own workspace and owner; each alert goes only to that owner.
        var accounts = await db.MailAccounts.IgnoreQueryFilters().Where(a => a.ImapPort != PopPort && a.SecretProtected != "")
            .ToListAsync(ct);
        var keys = accounts.Select(a => KeyOf(a.Id)).ToList();
        var states = await db.UserUiPreferences.Where(p => keys.Contains(p.Key)).ToListAsync(ct);
        var alerts = 0; var polled = 0;
        // The mailboxes that are due, the longest-waiting first, at most MaxPerRun of them.
        var due = accounts.Select(a => (a, row: states.FirstOrDefault(s => s.Key == KeyOf(a.Id) && s.UserId == a.UserId)))
            .Select(x => (x.a, x.row, state: Read(x.row))).Where(x => x.state.NextAt <= now).OrderBy(x => x.state.NextAt).Take(MaxPerRun).ToList();
        foreach (var (a, row, state) in due)
        {
            polled++;
            try
            {
                var r = await source.PollAsync(a, state.UidValidity == 0 ? 0 : state.LastUid, 25, ct);
                if (state.UidValidity != 0 && r.UidValidity != state.UidValidity) state.LastUid = 0; // the server renumbered: new baseline, no alerts
                var fresh = state.LastUid == 0 ? new List<MailHeader>() : r.New.Where(h => h.Uid > state.LastUid && !state.Recent.Contains(h.MessageId)).ToList();
                alerts += await AlertAsync(a.Id, a.TenantId, a.UserId, $"/mail?account=imap:{a.Id}", fresh, ct);
                state.UidValidity = r.UidValidity;
                state.LastUid = Math.Max(state.LastUid, r.HighestUid);
                state.Recent = [.. state.Recent.Concat(fresh.Select(h => h.MessageId)).TakeLast(50)];
                state.Failures = 0;
                state.NextAt = now.Add(Every);
                a.LastSyncedAt = now;
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                state.Failures++;
                state.NextAt = now.AddMinutes(Math.Min(60, 2 * Math.Pow(2, Math.Min(state.Failures, 5))));
                log.LogInformation("Mail watch for account {Account} failed ({Type}); next try {At}", a.Id, e.GetType().Name, state.NextAt);
            }
            Write(row, a.Id, a.UserId, state);
        }
        alerts += await OutlookAsync(now, MaxPerRun, ct);   // its own budget: busy IMAP mailboxes never starve Outlook ones
        await db.SaveChangesAsync(ct);
        return alerts;
    }

    /// <summary>Outlook mailboxes (people who gave Mail.Read): Graph delta polling, the same alerts, back-off and limits as IMAP.</summary>
    private async Task<int> OutlookAsync(DateTime now, int budget, CancellationToken ct)
    {
        if (budget <= 0) return 0;
        // Background: every Outlook connection with inbox access, each with its own workspace and owner.
        var connections = await db.MicrosoftConnections.IgnoreQueryFilters().Where(c => c.Scopes.Contains("Mail.Read"))
            .Select(c => new { c.Id, c.TenantId, c.UserId }).ToListAsync(ct);
        var keys = connections.Select(c => KeyOf(c.Id)).ToList();
        var states = await db.UserUiPreferences.Where(p => keys.Contains(p.Key)).ToListAsync(ct);
        var alerts = 0; var polled = 0;
        var due = connections.Select(c => (c, row: states.FirstOrDefault(s => s.Key == KeyOf(c.Id) && s.UserId == c.UserId)))
            .Select(x => (x.c, x.row, state: Read(x.row))).Where(x => x.state.NextAt <= now).OrderBy(x => x.state.NextAt).Take(budget).ToList();
        foreach (var (c, row, state) in due)
        {
            polled++;
            try
            {
                var baseline = string.IsNullOrEmpty(state.DeltaLink);
                var r = await graph.PollAsync(c.TenantId, c.UserId, baseline ? null : state.DeltaLink, 25, ct);
                var fresh = baseline ? new List<MailHeader>() : r.New.Where(h => !state.Recent.Contains(h.MessageId)).ToList();
                alerts += await AlertAsync(c.Id, c.TenantId, c.UserId, "/mail?account=microsoft", fresh, ct);
                state.DeltaLink = r.DeltaLink;
                state.Recent = [.. state.Recent.Concat(fresh.Select(h => h.MessageId)).TakeLast(50)];
                state.Failures = 0;
                state.NextAt = now.Add(Every);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                state.Failures++;
                state.NextAt = now.AddMinutes(Math.Min(60, 2 * Math.Pow(2, Math.Min(state.Failures, 5))));
                log.LogInformation("Outlook mail watch for connection {Connection} failed ({Type}); next try {At}", c.Id, e.GetType().Name, state.NextAt);
            }
            Write(row, c.Id, c.UserId, state);
        }
        return alerts;
    }

    private async Task<int> AlertAsync(Guid source, Guid tenantId, Guid userId, string link, List<MailHeader> fresh, CancellationToken ct)
    {
        if (fresh.Count == 0) return 0;
        var list = new List<Notification>();
        if (fresh.Count > MaxAlertsPerPoll)
            list.Add(Note(tenantId, userId, link, $"{fresh.Count} new emails", string.Join(" · ", fresh.TakeLast(3).Select(h => h.From)), $"mail:{source:N}:{fresh[^1].MessageId}"));
        else
            list.AddRange(fresh.Select(h => Note(tenantId, userId, link, $"New mail from {h.From}", h.Subject, $"mail:{source:N}:{h.MessageId}")));
        var keys = list.Select(n => n.DedupeKey!).ToList();
        var sent = (await db.Notifications.IgnoreQueryFilters().Where(n => n.TenantId == tenantId && n.UserId == userId && n.DedupeKey != null && keys.Contains(n.DedupeKey))
            .Select(n => n.DedupeKey!).ToListAsync(ct)).ToHashSet();
        var added = 0;
        foreach (var n in list)
            if (sent.Add(n.DedupeKey!) && await router.ApplyAsync(n, ct)) { db.Notifications.Add(n); added++; }
        return added;
    }

    private Notification Note(Guid tenantId, Guid userId, string link, string title, string body, string key) => new()
    {
        TenantId = tenantId, UserId = userId, Type = NotificationType.Message,
        Title = ProjectManagement.Application.Common.Text.Truncate(title, 200)!, Body = ProjectManagement.Application.Common.Text.Truncate(body, 500), Link = link,
        DedupeKey = key.Length > 190 ? key[..190] : key, CreatedAt = clock.Now,
    };

    private static MailWatchState Read(UserUiPreference? row)
    {
        if (row is null) return new MailWatchState();
        try { return JsonSerializer.Deserialize<MailWatchState>(row.Value) ?? new MailWatchState(); } catch (JsonException) { return new MailWatchState(); }
    }

    private void Write(UserUiPreference? row, Guid sourceId, Guid userId, MailWatchState state)
    {
        var json = JsonSerializer.Serialize(state);
        if (row is null) db.UserUiPreferences.Add(new UserUiPreference { UserId = userId, Key = KeyOf(sourceId), Value = json, UpdatedAt = clock.Now });
        else { row.Value = json; row.UpdatedAt = clock.Now; }
    }
}
