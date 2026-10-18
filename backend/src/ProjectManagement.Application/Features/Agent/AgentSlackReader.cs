using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Agent;

/// <summary>
/// Reads a project's Slack channel like its chat: every couple of minutes the new messages become one signal (people's own messages only,
/// with their Slack names). Needs the workspace's Slack app installed with channel reading (Slack:AgentChannels) and invited to the channel.
/// Slack limits how often history may be read, so it is read in small, polite steps; nothing is read from before the channel was linked.
/// </summary>
public class AgentSlackReader(IAppDbContext db, AppClock clock, ISecretProtector secrets, IHttpClientFactory http, AgentSignalService signals,
    IOptions<AgentOptions> options, ILogger<AgentSlackReader> log)
{
    private static readonly ConcurrentDictionary<Guid, DateTime> LastLook = new();
    private static readonly ConcurrentDictionary<string, string> Names = new();

    /// <summary>Returns whether a signal was added (the caller saves).</summary>
    public async Task<bool> CollectAsync(ProjectAgentSettings s, CancellationToken ct)
    {
        if (s.SlackChannelId is not { Length: > 0 } channel) return false;
        var now = clock.Now;
        var gap = TimeSpan.FromMinutes(Math.Max(0, options.Value.SlackPollMinutes));
        if (gap > TimeSpan.Zero && LastLook.TryGetValue(s.Id, out var last) && now - last < gap) return false;
        LastLook[s.Id] = now;
        var c = await db.SlackConnections.AsNoTracking().FirstOrDefaultAsync(x => x.Active, ct);
        if (c is null || !c.Scopes.Split(',', StringSplitOptions.TrimEntries).Contains("channels:history"))
        {
            s.LastError = "The Slack channel cannot be read: connect the Slack app with channel reading again (Settings › Slack).";
            return false;
        }
        // Linked just now: start from the present, never from the channel's history.
        if (s.SlackReadUntil is null) { s.SlackReadUntil = Ts(now); return false; }

        var token = secrets.Unprotect(c.BotTokenProtected);
        var messages = new List<(string Ts, string User, string Text)>();
        string? cursor = null;
        for (var page = 0; page < 3; page++)
        {
            var url = $"https://slack.com/api/conversations.history?channel={Uri.EscapeDataString(channel)}&oldest={Uri.EscapeDataString(s.SlackReadUntil)}&inclusive=false&limit=15"
                + (cursor is null ? "" : "&cursor=" + Uri.EscapeDataString(cursor));
            var doc = await GetAsync(url, token, ct);
            if (doc is null) return false;   // rate limited or unreachable: next time
            var root = doc.Value;
            if (!root.TryGetProperty("ok", out var ok) || !ok.GetBoolean())
            {
                var error = root.TryGetProperty("error", out var e) ? e.GetString() : "unknown";
                s.LastError = error switch
                {
                    "not_in_channel" => "Invite the Slack app to the project's channel (in Slack: /invite and the app's name).",
                    "channel_not_found" => "The project's Slack channel was not found - check the channel ID in the Agent tab.",
                    "missing_scope" => "The Slack app cannot read channels yet: connect it again with channel reading (Settings › Slack).",
                    _ => $"Slack refused to read the channel ({AgentAnalysisService.Cut(error, 60)}).",
                };
                return false;
            }
            if (root.TryGetProperty("messages", out var list) && list.ValueKind == JsonValueKind.Array)
                foreach (var m in list.EnumerateArray())
                {
                    var ts = Str(m, "ts"); var user = Str(m, "user"); var text = Str(m, "text");
                    // People's own messages only: no bots, joins, topic changes.
                    if (ts is null || user is null || string.IsNullOrWhiteSpace(text) || Str(m, "subtype") is not null || Str(m, "bot_id") is not null) continue;
                    messages.Add((ts, user, text));
                }
            cursor = root.TryGetProperty("has_more", out var more) && more.ValueKind == JsonValueKind.True
                && root.TryGetProperty("response_metadata", out var meta) && Str(meta, "next_cursor") is { Length: > 0 } next ? next : null;
            if (cursor is null) break;
        }
        if (messages.Count == 0) return false;
        messages = messages.DistinctBy(m => m.Ts).OrderBy(m => decimal.TryParse(m.Ts, NumberStyles.Number, CultureInfo.InvariantCulture, out var d) ? d : 0).ToList();

        var lines = new List<string>();
        foreach (var (ts, user, text) in messages)
            lines.Add($"[{At(ts):dd MMM HH:mm}] {await NameAsync(c.TeamId, user, token, ct)}: {Plain(text)}");
        var added = await signals.AddAsync(s.TenantId, s.ProjectId, AgentSourceKind.Slack, $"slack:{channel}:{messages[0].Ts}", $"Slack · {At(messages[0].Ts):dd MMM}", null,
            string.Join("\n", lines), At(messages[^1].Ts), null, null, ct);
        s.SlackReadUntil = messages[^1].Ts;
        if (s.LastError?.Contains("Slack", StringComparison.Ordinal) == true) s.LastError = null;
        return added is not null;
    }

    private async Task<JsonElement?> GetAsync(string url, string token, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        try
        {
            using var res = await http.CreateClient("slack").SendAsync(req, ct);
            if (res.StatusCode == HttpStatusCode.TooManyRequests) return null;
            var body = await res.Content.ReadAsStringAsync(ct);
            if (!res.IsSuccessStatusCode) { log.LogInformation("Slack read failed: {Status}", (int)res.StatusCode); return null; }
            return JsonDocument.Parse(body).RootElement.Clone();
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException || ex is TaskCanceledException && !ct.IsCancellationRequested) { return null; }
    }

    private async Task<string> NameAsync(string team, string user, string token, CancellationToken ct)
    {
        var key = team + ":" + user;
        if (Names.TryGetValue(key, out var cached)) return cached;
        var doc = await GetAsync($"https://slack.com/api/users.info?user={Uri.EscapeDataString(user)}", token, ct);
        var name = doc is { } d && d.TryGetProperty("user", out var u)
            ? (u.TryGetProperty("profile", out var p) && Str(p, "real_name") is { Length: > 0 } real ? real : Str(u, "real_name") ?? Str(u, "name"))
            : null;
        name = string.IsNullOrWhiteSpace(name) ? "Someone" : name.Replace(":", "").Trim();
        if (name.Length > 80) name = name[..80];
        if (doc is not null) Names[key] = name;
        return name;
    }

    /// <summary>Slack's markup made readable: &lt;@U123|ravi&gt; → @ravi, &lt;https://x|label&gt; → label, entities decoded.</summary>
    public static string Plain(string text)
    {
        var t = System.Text.RegularExpressions.Regex.Replace(text, @"<([^>|]+)\|([^>]+)>", "$2");
        t = System.Text.RegularExpressions.Regex.Replace(t, @"<([^>]+)>", "$1");
        return t.Replace("&lt;", "<").Replace("&gt;", ">").Replace("&amp;", "&");
    }

    private static string? Str(JsonElement o, string key) =>
        o.ValueKind == JsonValueKind.Object && o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static string Ts(DateTime utc) => ((decimal)(utc - DateTime.UnixEpoch).TotalSeconds).ToString("0.000000", CultureInfo.InvariantCulture);

    private static DateTime At(string ts) =>
        decimal.TryParse(ts, NumberStyles.Number, CultureInfo.InvariantCulture, out var d) ? DateTime.UnixEpoch.AddSeconds((double)d) : DateTime.UtcNow;
}
