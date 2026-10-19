using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Agent;

/// <summary>
/// Whether this installation has meeting-bot workers (apps/meetbot): they share Agent:MeetingBotSecret with the API and ask the API for
/// sessions themselves (see <see cref="MeetingBotQueue"/>), so nothing here calls them and any number of them can run.
/// </summary>
public class MeetingBotClient(IOptions<AgentOptions> options)
{
    public bool Configured => (options.Value.MeetingBotSecret?.Length ?? 0) >= 16;

    /// <summary>The bearer secret a worker sent, compared in constant time.</summary>
    public bool Authorized(string? bearer)
    {
        var want = options.Value.MeetingBotSecret ?? "";
        if (want.Length < 16 || string.IsNullOrEmpty(bearer)) return false;
        var a = Encoding.UTF8.GetBytes(bearer); var b = Encoding.UTF8.GetBytes(want);
        return a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
    }
}

/// <summary>What a worker needs to join one session (stored on the session when it is queued).</summary>
public record MeetingBotJoin(string MeetingUrl, string BotName, string? IntroMessage, string? AgendaMessage, string? CaptionLanguage);

public record BotWorkerBotReport(string? JobId, string? Status, string? Error, int Lines = 0);
/// <summary>A worker's report: who it is, how many meetings it can attend at once, whether it is shutting down, and its bots.</summary>
public record BotWorkerReport(string? WorkerId, string? Host, string? Version, int Capacity, bool Draining, IReadOnlyList<BotWorkerBotReport>? Bots);
public record BotJobDto(string JobId, string MeetingUrl, string BotName, DateTime JoinAt, DateTime LeaveAt, string WebhookUrl,
    string? IntroMessage, string? AgendaMessage, string? CaptionLanguage, bool Rejoin);
public record BotInstructionDto(string JobId, IReadOnlyList<string> Chat, bool Stop);
public record BotPollResponse(IReadOnlyList<BotJobDto> Jobs, IReadOnlyList<BotInstructionDto> Bots, int PollSeconds);

public record BotWorkerDto(string WorkerId, string? Host, string? Version, int Capacity, int Active, bool Draining, DateTime LastSeenAt, bool Online);
public record MeetingBotOverviewDto(bool Configured, int Capacity, int Active, int Waiting, int InCall, int FailedToday, IReadOnlyList<BotWorkerDto> Workers);

/// <summary>
/// Meeting bots as a queue. Each upcoming session is a row (AgentMeetingBot). Every few seconds each worker reports its bots and asks for as
/// many new sessions as it has room for:
/// - a session is handed to one worker at a time, with a lease the worker renews by reporting; if the worker stops reporting (crash,
///   redeploy), the lease runs out and another worker joins the call instead (without saying hello again);
/// - when every worker is busy, sessions wait in line (oldest start first) instead of failing, and are joined as soon as a worker is free;
/// - chat messages for a bot wait on its row until its worker collects them.
/// Workers only ever call the API, so they can run as any number of replicas behind one address.
/// </summary>
public class MeetingBotQueue(IAppDbContext db, ICurrentContext ctx, AppClock clock, MeetingBotClient bots, IOptions<AppOptions> app, ILogger<MeetingBotQueue> log)
{
    public static readonly TimeSpan Lease = TimeSpan.FromMinutes(2);
    /// <summary>A session can be picked up from shortly before it starts until a few minutes before it ends.</summary>
    public static readonly TimeSpan JoinEarly = TimeSpan.FromMinutes(2);
    public static readonly TimeSpan JoinLateCutoff = TimeSpan.FromMinutes(3);
    public static readonly TimeSpan Online = TimeSpan.FromMinutes(2);
    private const int MaxAttempts = 4;
    private static readonly Regex WorkerKey = new("^[A-Za-z0-9._:-]{4,100}$", RegexOptions.CultureInvariant);
    private static readonly string[] Finished = ["call_ended", "done", "fatal"];
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static string PayloadJson(MeetingBotJoin join) => JsonSerializer.Serialize(join, Json);

    public async Task<BotPollResponse> PollAsync(string? bearer, BotWorkerReport report, CancellationToken ct)
    {
        if (!bots.Authorized(bearer)) throw new UnauthorizedException("Not a meeting-bot worker.", "MEETBOT_UNAUTHORIZED");
        var workerId = (report.WorkerId ?? "").Trim();
        if (!WorkerKey.IsMatch(workerId)) throw new ValidationException("workerId", "A worker id of 4-100 letters, digits or . _ : - is required.");
        var capacity = Math.Clamp(report.Capacity, 0, 50);
        var reported = (report.Bots ?? []).Where(b => Guid.TryParse(b.JobId, out _)).Take(60).ToList();
        var now = clock.Now;
        var running = reported.Count(b => !Finished.Contains(b.Status ?? ""));
        await SeenAsync(workerId, report, capacity, running, now, ct);

        // 1. The bots it has: renew what it still holds, pass on chat, and tell it to stop what it no longer holds.
        var ids = reported.Select(b => Guid.Parse(b.JobId!)).ToList();
        var rows = await db.AgentMeetingBots.IgnoreQueryFilters().AsNoTracking().Where(b => ids.Contains(b.Id)).ToListAsync(ct);
        var instructions = new List<BotInstructionDto>();
        foreach (var r in reported)
        {
            var row = rows.FirstOrDefault(x => x.Id == Guid.Parse(r.JobId!));
            if (row is null || row.WorkerId != workerId || row.Status is "done" or "failed")
            {
                instructions.Add(new(r.JobId!, [], true));
                continue;
            }
            var status = Cut(r.Status, 32) ?? row.WorkerStatus;
            var error = status == "fatal" ? Cut(r.Error, 500) : null;
            var finished = Finished.Contains(status ?? "");
            await db.AgentMeetingBots.IgnoreQueryFilters().Where(b => b.Id == row.Id && b.WorkerId == workerId)
                .ExecuteUpdateAsync(u => u
                    .SetProperty(b => b.WorkerStatus, status)
                    .SetProperty(b => b.LeaseUntil, finished ? now : now + Lease)
                    .SetProperty(b => b.Error, b => error ?? b.Error)
                    .SetProperty(b => b.Status, b => status == "in_call_recording" && b.Status == "scheduled" ? "in_call" : b.Status), ct);
            instructions.Add(new(r.JobId!, finished ? [] : await TakeChatAsync(row.Id, ct), false));
        }

        // 2. New sessions, as many as it has room for (none while it is shutting down).
        var jobs = new List<BotJobDto>();
        var room = report.Draining ? 0 : capacity - running;
        if (room > 0 && bots.Configured)
        {
            var from = now + JoinEarly;
            var until = now + JoinLateCutoff;
            var candidates = await db.AgentMeetingBots.IgnoreQueryFilters().AsNoTracking()
                .Where(b => b.Kind == "bot" && (b.Status == "scheduled" || b.Status == "in_call") && b.JoinPayload != null
                    && b.SessionStartUtc <= from && b.SessionEndUtc > until && (b.LeaseUntil == null || b.LeaseUntil < now) && b.Attempts < MaxAttempts)
                .OrderBy(b => b.SessionStartUtc).ThenBy(b => b.Id).Take(Math.Min(50, room * 4)).ToListAsync(ct);
            foreach (var c in candidates)
            {
                if (jobs.Count >= room) break;
                // A bot the host refused, or one that ended normally, is not sent again; one whose worker went away is.
                if (c.WorkerStatus is "call_ended" or "done") continue;
                if (c.WorkerStatus == "fatal" && (c.Error ?? "").Contains("let", StringComparison.OrdinalIgnoreCase)) continue;
                var lease = c.LeaseUntil;
                var claimed = await db.AgentMeetingBots.IgnoreQueryFilters()
                    .Where(b => b.Id == c.Id && b.LeaseUntil == lease && (b.Status == "scheduled" || b.Status == "in_call"))
                    .ExecuteUpdateAsync(u => u.SetProperty(b => b.WorkerId, workerId).SetProperty(b => b.LeaseUntil, now + Lease)
                        .SetProperty(b => b.WorkerStatus, "joining").SetProperty(b => b.Attempts, b => b.Attempts + 1)
                        .SetProperty(b => b.LastAttemptAt, now), ct) == 1;
                if (!claimed) continue;   // another worker took it first
                MeetingBotJoin? join = null;
                try { join = JsonSerializer.Deserialize<MeetingBotJoin>(c.JoinPayload!, Json); } catch (JsonException) { }
                if (join is null || string.IsNullOrWhiteSpace(join.MeetingUrl))
                {
                    await db.AgentMeetingBots.IgnoreQueryFilters().Where(b => b.Id == c.Id)
                        .ExecuteUpdateAsync(u => u.SetProperty(b => b.Status, "failed").SetProperty(b => b.Error, "The meeting has no Google Meet address."), ct);
                    continue;
                }
                var rejoin = c.Attempts > 0;
                jobs.Add(new BotJobDto(c.Id.ToString(), join.MeetingUrl, join.BotName, c.SessionStartUtc, c.SessionEndUtc.AddMinutes(30),
                    $"{PublicUrls.Api(app.Value)}/api/v1/agent/bot/{c.WebhookToken}",
                    rejoin ? null : join.IntroMessage, rejoin ? null : join.AgendaMessage, join.CaptionLanguage, rejoin));
                log.LogInformation("Meeting bot session {Session} handed to worker {Worker}{Rejoin}", c.Id, workerId, rejoin ? " (rejoining)" : "");
            }
        }
        return new BotPollResponse(jobs, instructions, 5);
    }

    private async Task SeenAsync(string workerId, BotWorkerReport report, int capacity, int running, DateTime now, CancellationToken ct)
    {
        var host = Cut(report.Host, 200); var version = Cut(report.Version, 40);
        var updated = await db.AgentBotWorkers.Where(w => w.WorkerKey == workerId).ExecuteUpdateAsync(u => u
            .SetProperty(w => w.LastSeenAt, now).SetProperty(w => w.Capacity, capacity).SetProperty(w => w.Active, running)
            .SetProperty(w => w.Draining, report.Draining).SetProperty(w => w.Host, host).SetProperty(w => w.Version, version), ct);
        if (updated > 0) return;
        db.AgentBotWorkers.Add(new AgentBotWorker { WorkerKey = workerId, Host = host, Version = version, Capacity = capacity, Active = running,
            Draining = report.Draining, LastSeenAt = now, CreatedAt = now });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException) { }   // the same worker's other request added it first
        // Workers not heard from for a day are forgotten.
        await db.AgentBotWorkers.Where(w => w.LastSeenAt < now.AddDays(-1)).ExecuteDeleteAsync(ct);
    }

    /// <summary>Takes the chat messages waiting for a bot (each is handed out once, even with several API servers).</summary>
    private async Task<IReadOnlyList<string>> TakeChatAsync(Guid id, CancellationToken ct)
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            var pending = await db.AgentMeetingBots.IgnoreQueryFilters().AsNoTracking().Where(b => b.Id == id).Select(b => b.PendingChat).FirstOrDefaultAsync(ct);
            if (string.IsNullOrEmpty(pending)) return [];
            var taken = await db.AgentMeetingBots.IgnoreQueryFilters().Where(b => b.Id == id && b.PendingChat == pending)
                .ExecuteUpdateAsync(u => u.SetProperty(b => b.PendingChat, (string?)null), ct);
            if (taken == 1) return pending.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Take(10).ToList();
        }
        return [];
    }

    /// <summary>Queues a message for the bot's meeting chat; its worker posts it within a few seconds.</summary>
    public async Task<bool> QueueChatAsync(Guid botRowId, string message, CancellationToken ct)
    {
        var text = message.Replace('\r', ' ').Replace('\n', ' ').Trim();
        if (text.Length == 0) return false;
        if (text.Length > 500) text = text[..500];
        return await db.AgentMeetingBots.IgnoreQueryFilters().Where(b => b.Id == botRowId && b.Status == "in_call")
            .ExecuteUpdateAsync(u => u.SetProperty(b => b.PendingChat, b => b.PendingChat == null || b.PendingChat == "" ? text : b.PendingChat + "\n" + text), ct) == 1;
    }

    /// <summary>For platform administrators: the workers, how many meetings they can attend and the line of sessions.</summary>
    public async Task<MeetingBotOverviewDto> OverviewAsync(CancellationToken ct)
    {
        if (!ctx.IsPlatformAdmin) throw new ForbiddenException("Platform administrators only.", "PERMISSION_DENIED");
        var now = clock.Now;
        var workers = await db.AgentBotWorkers.AsNoTracking().OrderByDescending(w => w.LastSeenAt).Take(50).ToListAsync(ct);
        var online = workers.Where(w => now - w.LastSeenAt < Online).ToList();
        var q = db.AgentMeetingBots.IgnoreQueryFilters().AsNoTracking().Where(b => b.Kind == "bot");
        var waiting = await q.CountAsync(b => b.Status == "scheduled" && (b.LeaseUntil == null || b.LeaseUntil < now) && b.SessionStartUtc <= now + JoinEarly && b.SessionEndUtc > now, ct);
        var inCall = await q.CountAsync(b => (b.Status == "in_call" || b.Status == "scheduled") && b.LeaseUntil > now, ct);
        var failed = await q.CountAsync(b => b.Status == "failed" && b.SessionStartUtc > now.AddDays(-1), ct);
        return new MeetingBotOverviewDto(bots.Configured, online.Where(w => !w.Draining).Sum(w => w.Capacity), online.Sum(w => w.Active), waiting, inCall, failed,
            workers.Select(w => new BotWorkerDto(w.WorkerKey, w.Host, w.Version, w.Capacity, w.Active, w.Draining, w.LastSeenAt, now - w.LastSeenAt < Online)).ToList());
    }

    private static string? Cut(string? s, int max) => string.IsNullOrWhiteSpace(s) ? null : (s = s.Trim()).Length <= max ? s : s[..max];
}
