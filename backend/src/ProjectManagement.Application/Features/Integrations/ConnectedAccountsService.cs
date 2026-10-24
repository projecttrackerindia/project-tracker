using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.ProjectMeetings;
using ProjectManagement.Application.Features.Sso;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Integrations;

public record ConnectedSlackDto(bool Available, bool WorkspaceConnected, string? TeamName, bool Linked, string? Name, string Messages, string? Problem);
public record ConnectedGitHubDto(bool Available, bool Linked, string? Email, bool AppInstalled);
/// <param name="Meetings">Where this person's next meeting goes and why; null with <paramref name="MeetingProblem"/> when nothing can hold one.</param>
public record ConnectedAccountsDto(GoogleConnectionStatusDto Google, MicrosoftStatusDto Microsoft, ConnectedSlackDto Slack, ConnectedGitHubDto GitHub,
    string MeetingService, MeetingServiceChoiceDto? Meetings, string? MeetingProblem);
public record SaveConnectionChoicesRequest(string? MeetingService, string? SlackMessages);
public record SlackLinkStart(string Url, string BrowserProof);

/// <summary>
/// My account > Connected accounts: every account a person has connected (Google, Microsoft, Slack, GitHub) in one answer, and their two
/// choices - which service their meetings use, and whether notifications also come to them in Slack.
/// </summary>
public class ConnectedAccountsService(IAppDbContext db, ICurrentContext ctx, AppClock clock, GoogleCalendarAuthService google, MicrosoftProductivityAuthService microsoft,
    MeetingCalendar meetings, IOptions<SlackOptions> slack, IOptions<ExternalAuthOptions> sso, Recorder recorder)
{
    public static readonly string[] SlackChoices = ["off", "needs", "all"];

    public async Task<ConnectedAccountsDto> GetAsync(CancellationToken ct = default)
    {
        var tenant = ctx.RequireTenantId(); var me = ctx.RequireUserId();
        var settings = await db.PersonalConnectionSettings.AsNoTracking().FirstOrDefaultAsync(s => s.UserId == me, ct);
        MeetingServiceChoiceDto? choice = null; string? problem = null;
        try { choice = await meetings.ChooseAsync(me, null, ct); }
        catch (ConflictException ex) { problem = ex.Message; }
        return new ConnectedAccountsDto(await google.StatusAsync(ct), await microsoft.StatusAsync(ct), await SlackAsync(tenant, me, settings, ct), await GitHubAsync(me, ct),
            settings?.MeetingService ?? MeetingCalendar.Auto, choice, problem);
    }

    private async Task<ConnectedSlackDto> SlackAsync(Guid tenant, Guid me, PersonalConnectionSettings? settings, CancellationToken ct)
    {
        var install = await db.SlackConnections.AsNoTracking().Where(c => c.TenantId == tenant && c.Active).Select(c => new { c.TeamName }).FirstOrDefaultAsync(ct);
        var link = await db.SlackUserLinks.AsNoTracking().FirstOrDefaultAsync(l => l.UserId == me, ct);
        var available = slack.Value.Configured;
        var problem = !available ? "Slack is not set up on this installation." : install is null ? "Your workspace administrator connects Slack first (Settings > Slack)." : null;
        return new ConnectedSlackDto(available, install is not null, install?.TeamName, link is not null, link?.Name ?? link?.Email, link is null ? "off" : settings?.SlackMessages ?? "off", problem ?? link?.LastError);
    }

    private async Task<ConnectedGitHubDto> GitHubAsync(Guid me, CancellationToken ct)
    {
        var login = await db.UserLogins.AsNoTracking().Where(l => l.UserId == me && l.Provider == "github").Select(l => new { l.Email }).FirstOrDefaultAsync(ct);
        var installed = await db.GitHubInstallations.AsNoTracking().AnyAsync(ct);
        return new ConnectedGitHubDto(sso.Value.GitHub.Configured, login is not null, login?.Email, installed);
    }

    /// <summary>Saves the person's choices. A meeting service they cannot use yet is refused with what to connect.</summary>
    public async Task<ConnectedAccountsDto> SaveAsync(SaveConnectionChoicesRequest req, CancellationToken ct = default)
    {
        var tenant = ctx.RequireTenantId(); var me = ctx.RequireUserId();
        var row = await db.PersonalConnectionSettings.FirstOrDefaultAsync(s => s.UserId == me, ct);
        if (row is null) { row = new PersonalConnectionSettings { TenantId = tenant, UserId = me, CreatedAt = clock.Now, CreatedBy = me }; db.PersonalConnectionSettings.Add(row); }
        if (req.MeetingService is { } service)
        {
            var key = MeetingCalendar.Normalize(service) ?? throw new ValidationException("meetingService", "Choose automatic, Google Meet, Microsoft Teams or Project Tracker calls.");
            if (key != MeetingCalendar.Auto) await meetings.ChooseAsync(me, key, ct);   // throws with what to connect
            row.MeetingService = key;
        }
        if (req.SlackMessages is { } messages)
        {
            if (!SlackChoices.Contains(messages)) throw new ValidationException("slackMessages", "Choose off, things that need you, or everything.");
            if (messages != "off" && !await db.SlackUserLinks.AnyAsync(l => l.UserId == me, ct))
                throw new ConflictException("Link your Slack account first.", "SLACK_NOT_LINKED");
            row.SlackMessages = messages;
        }
        row.UpdatedAt = clock.Now; row.UpdatedBy = me;
        recorder.Audit("connected_accounts.choices_saved", "PersonalConnectionSettings", row.Id, newValue: new { row.MeetingService, row.SlackMessages });
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }
}

/// <summary>
/// "Sign in with Slack" for one person, through the workspace's own Slack app (OpenID Connect: openid, profile, email): it only tells us who
/// they are in the workspace's Slack, so the bot can send them direct messages. No Slack token of theirs is kept. The Slack app needs this
/// address among its redirect URLs: the install redirect with the path /api/v1/integrations/slack/me/callback.
/// </summary>
public class SlackUserLinkService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, IServiceProvider services,
    IOptions<SlackOptions> options, IHttpClientFactory http, ILogger<SlackUserLinkService> log)
{
    public const string CallbackPath = "/api/v1/integrations/slack/me/callback";
    private const string Provider = "slack-user";
    private static string Hash(string v) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(v)));
    private SlackOptions O => options.Value;

    public string RedirectUri => new UriBuilder(O.RedirectUri!) { Path = CallbackPath, Query = "" }.Uri.ToString();

    public async Task<SlackLinkStart> StartAsync(CancellationToken ct = default)
    {
        var tenant = ctx.RequireTenantId(); var me = ctx.RequireUserId();
        if (!O.Configured) throw new ConflictException("Slack is not set up on this installation.", "SLACK_NOT_CONFIGURED");
        var team = await db.SlackConnections.AsNoTracking().Where(c => c.TenantId == tenant && c.Active).Select(c => c.TeamId).FirstOrDefaultAsync(ct)
            ?? throw new ConflictException("Your workspace administrator connects Slack first (Settings > Slack).", "SLACK_NOT_CONNECTED");
        var state = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)); var proof = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        await db.ProviderOAuthAttempts.Where(a => a.ExpiresAt < clock.Now).Take(100).ExecuteDeleteAsync(ct);
        if (await db.ProviderOAuthAttempts.CountAsync(a => a.Provider == Provider && a.UserId == me && a.ConsumedAt == null && a.ExpiresAt > clock.Now, ct) >= 5)
            throw new ConflictException("Finish the Slack sign-in you already started, or wait ten minutes.");
        db.ProviderOAuthAttempts.Add(new ProviderOAuthAttempt { Provider = Provider, TenantId = tenant, UserId = me, StateHash = Hash(state), BrowserHash = Hash(proof),
            RequestedScopes = "openid profile email", ReturnPath = "/account/integrations", ExpiresAt = clock.Now.AddMinutes(10) });
        await db.SaveChangesAsync(ct);
        var q = new Dictionary<string, string> { ["response_type"] = "code", ["scope"] = "openid profile email", ["client_id"] = O.ClientId!, ["state"] = state,
            ["redirect_uri"] = RedirectUri, ["team"] = team, ["nonce"] = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)) };
        return new SlackLinkStart("https://slack.com/openid/connect/authorize?" + string.Join('&', q.Select(p => $"{Uri.EscapeDataString(p.Key)}={Uri.EscapeDataString(p.Value)}")), proof);
    }

    /// <summary>Slack's redirect back. Who started it comes from the saved attempt (this request has no session); returns where the browser lands.</summary>
    public async Task<string> CompleteAsync(string? code, string? state, string? error, string? proof, CancellationToken ct = default)
    {
        if (state is not { Length: 64 } || proof is not { Length: 64 }) throw new UnauthorizedException("Start linking Slack again in this browser.", "SLACK_STATE_INVALID");
        var hash = Hash(state); var browser = Hash(proof);
        var attempt = await db.ProviderOAuthAttempts.AsNoTracking().SingleOrDefaultAsync(a => a.Provider == Provider && a.StateHash == hash && a.BrowserHash == browser && a.ConsumedAt == null && a.ExpiresAt > clock.Now, ct)
            ?? throw new UnauthorizedException("This Slack sign-in expired or belongs to another browser.", "SLACK_STATE_INVALID");
        if (await db.ProviderOAuthAttempts.Where(a => a.Id == attempt.Id && a.ConsumedAt == null).ExecuteUpdateAsync(s => s.SetProperty(a => a.ConsumedAt, clock.Now), ct) != 1)
            throw new UnauthorizedException("This Slack sign-in was already used.", "SLACK_STATE_INVALID");
        await WorkspaceExecutionPrincipal.ConfigureAsync(services, attempt.UserId, attempt.TenantId, null, ct);
        string Landing(string outcome) => attempt.ReturnPath + "?slack=" + outcome;
        if (!string.IsNullOrEmpty(error) || string.IsNullOrWhiteSpace(code)) return Landing("declined");
        try
        {
            using var form = new FormUrlEncodedContent(new Dictionary<string, string> { ["client_id"] = O.ClientId!, ["client_secret"] = O.ClientSecret!, ["code"] = code, ["redirect_uri"] = RedirectUri });
            using var tokenResponse = await http.CreateClient("slack").PostAsync("https://slack.com/api/openid.connect.token", form, ct);
            using var token = JsonDocument.Parse(await tokenResponse.Content.ReadAsStringAsync(ct));
            if (!token.RootElement.TryGetProperty("ok", out var ok) || !ok.GetBoolean() || token.RootElement.GetProperty("access_token").GetString() is not { Length: > 0 } access) return Landing("error");
            using var request = new HttpRequestMessage(HttpMethod.Get, "https://slack.com/api/openid.connect.userInfo");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access);
            using var infoResponse = await http.CreateClient("slack").SendAsync(request, ct);
            using var info = JsonDocument.Parse(await infoResponse.Content.ReadAsStringAsync(ct));
            var r = info.RootElement;
            string? S(string name) => r.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            if (!r.TryGetProperty("ok", out var ok2) || !ok2.GetBoolean()) return Landing("error");
            var userId = S("https://slack.com/user_id") ?? S("sub"); var teamId = S("https://slack.com/team_id");
            if (string.IsNullOrWhiteSpace(userId) || userId.Length > 32 || string.IsNullOrWhiteSpace(teamId)) return Landing("error");
            var team = await db.SlackConnections.AsNoTracking().Where(c => c.TenantId == attempt.TenantId && c.Active).Select(c => c.TeamId).FirstOrDefaultAsync(ct);
            if (team != teamId) return Landing("team");   // signed in to another Slack workspace than the one connected here
            if (await db.SlackUserLinks.AnyAsync(l => l.SlackUserId == userId && l.UserId != attempt.UserId, ct)) return Landing("taken");
            var link = await db.SlackUserLinks.FirstOrDefaultAsync(l => l.UserId == attempt.UserId, ct);
            if (link is null) { link = new SlackUserLink { TenantId = attempt.TenantId, UserId = attempt.UserId, CreatedAt = clock.Now, CreatedBy = attempt.UserId }; db.SlackUserLinks.Add(link); }
            link.SlackTeamId = teamId; link.SlackUserId = userId; link.ConnectedAt = clock.Now; link.LastError = null;
            link.Name = Cut(S("name"), 200); link.Email = Cut(S("email"), 254);
            // Linking Slack is asking for it: things that need the person start arriving there, until they choose otherwise.
            var settings = await db.PersonalConnectionSettings.FirstOrDefaultAsync(s => s.UserId == attempt.UserId, ct);
            if (settings is null) db.PersonalConnectionSettings.Add(new PersonalConnectionSettings { TenantId = attempt.TenantId, UserId = attempt.UserId, SlackMessages = "needs", CreatedAt = clock.Now });
            else if (settings.SlackMessages == "off") settings.SlackMessages = "needs";
            recorder.Audit("slack_user.linked", "SlackUserLink", link.Id, tenantId: attempt.TenantId, userId: attempt.UserId);
            await db.SaveChangesAsync(ct);
            return Landing("connected");
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or KeyNotFoundException or InvalidOperationException || ex is OperationCanceledException && !ct.IsCancellationRequested)
        {
            log.LogWarning("Linking a Slack user failed: {Error}", ex.GetType().Name);
            return Landing("error");
        }
    }

    public async Task UnlinkAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var link = await db.SlackUserLinks.FirstOrDefaultAsync(l => l.UserId == me, ct);
        if (link is null) return;
        db.SlackUserLinks.Remove(link);
        var settings = await db.PersonalConnectionSettings.FirstOrDefaultAsync(s => s.UserId == me, ct);
        if (settings is not null) settings.SlackMessages = "off";
        recorder.Audit("slack_user.unlinked", "SlackUserLink", link.Id);
        await db.SaveChangesAsync(ct);
    }

    private static string? Cut(string? s, int max) => s is null ? null : s.Length <= max ? s : s[..max];
}

/// <summary>
/// Sends waiting notifications to people as Slack direct messages from the workspace's Project Tracker bot. Like push, each is claimed before
/// it is sent (several servers never send it twice) and waits through quiet hours, do-not-disturb and the digest like e-mail does.
/// </summary>
public class SlackMessageDispatcher(IServiceScopeFactory scopes, ILogger<SlackMessageDispatcher> log)
{
    private const int Batch = 50;

    public async Task<int> RunAsync(CancellationToken ct = default)
    {
        using var scope = scopes.CreateScope();
        var sp = scope.ServiceProvider;
        var db = sp.GetRequiredService<IAppDbContext>();
        var now = sp.GetRequiredService<AppClock>().Now;
        var waiting = await db.Notifications.IgnoreQueryFilters().Where(n => n.SlackPending && (n.DeliverAfter == null || n.DeliverAfter <= now))
            .OrderBy(n => n.CreatedAt).Take(Batch).Select(n => new { n.Id, n.TenantId, n.UserId, n.Title, n.Body, n.Link, n.ReadAt, n.DeliverAfter }).ToListAsync(ct);
        if (waiting.Count == 0) return 0;
        var tenants = waiting.Select(w => w.TenantId).Distinct().ToList();
        var bots = await db.SlackConnections.IgnoreQueryFilters().Where(c => tenants.Contains(c.TenantId) && c.Active).ToDictionaryAsync(c => c.TenantId, c => c.BotTokenProtected, ct);
        var users = waiting.Select(w => w.UserId).Distinct().ToList();
        var links = await db.SlackUserLinks.IgnoreQueryFilters().Where(l => users.Contains(l.UserId) && tenants.Contains(l.TenantId)).ToListAsync(ct);
        var slugs = await db.Tenants.IgnoreQueryFilters().Where(t => tenants.Contains(t.Id)).ToDictionaryAsync(t => t.Id, t => t.Slug, ct);
        var web = sp.GetRequiredService<IOptions<AppOptions>>().Value.WebBaseUrl.TrimEnd('/');
        var secrets = sp.GetRequiredService<ISecretProtector>();
        var client = sp.GetRequiredService<IHttpClientFactory>().CreateClient("slack");
        var sent = 0;
        foreach (var n in waiting)
        {
            if (await db.Notifications.IgnoreQueryFilters().Where(x => x.Id == n.Id && x.SlackPending).ExecuteUpdateAsync(u => u.SetProperty(x => x.SlackPending, false), ct) != 1) continue;
            // Held through quiet hours and already read in the app since: nothing to send.
            if (n.DeliverAfter is not null && n.ReadAt is not null) continue;
            var link = links.FirstOrDefault(l => l.UserId == n.UserId && l.TenantId == n.TenantId);
            if (link is null || !bots.TryGetValue(n.TenantId, out var bot)) continue;
            var url = web + NotificationEmailService.OrgLink(slugs.GetValueOrDefault(n.TenantId), n.Link);
            var text = $"*{Escape(n.Title)}*" + (string.IsNullOrWhiteSpace(n.Body) ? "" : "\n" + Escape(n.Body)) + $"\n<{url}|Open in Project Tracker>";
            try
            {
                var token = secrets.Unprotect(bot);
                var channel = await CallAsync(client, token, "conversations.open", new { users = link.SlackUserId }, ct) is { } open && open.TryGetProperty("channel", out var c) ? c.GetProperty("id").GetString() : null;
                if (channel is null || await CallAsync(client, token, "chat.postMessage", new { channel, text, unfurl_links = false, unfurl_media = false }, ct) is null)
                { await NoteAsync(db, link.Id, "Slack did not accept a message. Ask your administrator to check the Slack app.", ct); continue; }
                await db.Notifications.IgnoreQueryFilters().Where(x => x.Id == n.Id).ExecuteUpdateAsync(u => u.SetProperty(x => x.SlackSentAt, DateTime.UtcNow), ct);
                if (link.LastError is not null) await NoteAsync(db, link.Id, null, ct);
                sent++;
            }
            catch (Exception ex) when (ex is HttpRequestException or JsonException || ex is OperationCanceledException && !ct.IsCancellationRequested)
            {
                log.LogWarning("A Slack message was not sent: {Error}", ex.GetType().Name);
            }
        }
        return sent;
    }

    private static string Escape(string s) => s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");

    private static Task NoteAsync(IAppDbContext db, Guid linkId, string? error, CancellationToken ct) =>
        db.SlackUserLinks.IgnoreQueryFilters().Where(l => l.Id == linkId).ExecuteUpdateAsync(u => u.SetProperty(l => l.LastError, error), ct);

    /// <summary>One Slack Web API call; the answer when Slack said ok, otherwise null.</summary>
    private static async Task<JsonElement?> CallAsync(HttpClient client, string token, string method, object body, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, "https://slack.com/api/" + method)
        { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var res = await client.SendAsync(req, ct);
        var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
        var root = doc.RootElement.Clone();
        doc.Dispose();
        return root.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True ? root : null;
    }
}
