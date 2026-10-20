using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Ai;

public record AgentDefinitionDto(string Id, string Name, string Version, bool Enabled, string Provider, string Model,
    IReadOnlyList<string> Capabilities, int MaxToolCalls, int TimeoutSeconds);
public record AgentRunDto(Guid Id, DateTime CreatedAt, string Status, int InputTokens, int OutputTokens, string? Feedback, AiExecutionTrace Trace);
public record AgentTrackerDto(AgentDefinitionDto Agent, int Total, int Succeeded, int Failed, int Partial, int AwaitingConfirmation,
    double AverageMs, long P95Ms, long InputTokens, long OutputTokens, bool SampleLimited, int Page, int PageSize, IReadOnlyList<AgentRunDto> Runs, long P50Ms = 0, int ModelCalls = 0, long DatabaseCommands = 0,
    IReadOnlyList<AgentPathSummaryDto>? SlowestPaths = null, IReadOnlyList<AgentErrorSummaryDto>? FrequentErrors = null, AgentInsightsDto? Insights = null);
/// <summary>Charts for the Agent Tracker, computed from the same filtered sample as the totals (never conversation content).</summary>
public record AgentInsightsDto(IReadOnlyList<AgentTimeBucketDto> Timeline, string BucketUnit, IReadOnlyList<AgentLatencyBucketDto> Latency, AgentPhasesDto Phases,
    IReadOnlyList<AgentToolStatDto> Tools, IReadOnlyList<AgentModelStatDto> Models, int FeedbackUp, int FeedbackDown, long CacheReadTokens, long? FirstTokenP50Ms,
    IReadOnlyList<AgentActionStatDto> Actions);
public record AgentTimeBucketDto(DateTime At, int Succeeded, int Failed, int Partial, int Awaiting, long P50Ms, long P95Ms);
public record AgentLatencyBucketDto(string Label, long UpToMs, int Count);
/// <summary>Average milliseconds per run spent in each phase.</summary>
public record AgentPhasesDto(double ContextMs, double RoutingMs, double ModelMs, double ToolMs, double OtherMs);
public record AgentToolStatDto(string Name, int Calls, int Failures, double AverageMs);
public record AgentModelStatDto(string Model, int Runs, double AverageMs, long InputTokens, long OutputTokens);
public record AgentActionStatDto(string Kind, int Count, int Failed, int Confirmed);

/// <summary>
/// Every agent in the workspace over a period: the project agent (readings, proposals and how people decided on them), the meeting bot
/// (sessions attended, transcripts, minutes, delegations) and follow-ups (commitments kept, check-ins answered, change requests).
/// </summary>
public record AgentFleetDto(DateTime From, DateTime To, AgentFleetProjectAgentDto ProjectAgent, AgentFleetMeetingsDto Meetings, AgentFleetFollowUpsDto FollowUps,
    IReadOnlyList<AgentFleetDayDto> Days, IReadOnlyList<AgentFleetProjectDto> Projects, IReadOnlyList<AgentFleetReasonDto>? DismissReasons = null);
/// <summary>Why proposals were dismissed (reason code, or "unspecified").</summary>
public record AgentFleetReasonDto(string Reason, int Count);
public record AgentFleetProjectAgentDto(int ProjectsOn, int Readings, int FailedReadings, int Findings, int Approved, int AutoApplied, int Dismissed, int Pending, int Credits,
    double? AverageDecisionHours, IReadOnlyList<AgentFleetKindDto> Kinds, IReadOnlyList<AgentFleetSourceDto> Sources, int AtLevel1, int AtLevel2, int AtLevel3, int AtLevel4);
public record AgentFleetKindDto(string Kind, int Found, int Approved, int Dismissed, int Pending, int Auto);
public record AgentFleetSourceDto(string Source, int Signals);
public record AgentFleetMeetingsDto(int Sessions, int Attended, int Failed, int MeetTranscripts, int MinutesSent, int Delegations, int DelegationsReported, int CaptionLines);
public record AgentFleetFollowUpsDto(int Commitments, int Kept, int Missed, int Moved, int Open, int CheckInsSent, int Answered, int ChangeRequests);
public record AgentFleetDayDto(DateOnly Day, int Readings, int Findings, int Decided, int Meetings);
public record AgentFleetProjectDto(Guid ProjectId, string Key, string Name, int Level, int Readings, int Findings, int Approved, int Dismissed, int Pending);

public record AgentPathSummaryDto(string Intent, int Requests, int Failures, long P50Ms, long P95Ms, double? AverageQueueMs, double AverageModelMs, double AverageToolMs);
public record AgentErrorSummaryDto(string Code, int Count);
public record AiDiagnosticsDto(bool Configured, bool Reachable, bool ModelAvailable, string Provider, string Model, int QueueDepth, string? ErrorCode,
    int? ActiveRequests = null, int? MaxConcurrentRequests = null, int? MaxQueuedRequests = null, int? QueueTimeoutSeconds = null);
public interface IAiDiagnostics { Task<AiDiagnosticsDto> CheckAsync(CancellationToken ct); }

/// <summary>Workspace admins see counts and sanitized operational traces, never private conversation content.</summary>
public sealed class AgentTrackerService(IAppDbContext db, ICurrentContext ctx, AppClock clock, IAiChat chat, IOptions<AiOptions> options)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private Guid RequireAdmin()
    {
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only workspace owners and admins can view Agent Tracker.", "PERMISSION_DENIED");
        return ctx.RequireTenantId();
    }

    public async Task<AgentTrackerDto> ListAsync(DateTime? from, DateTime? to, string? status, string? model, int page = 1, int pageSize = 25, CancellationToken ct = default, string? intent = null)
    {
        var tenant = RequireAdmin();
        var end = to?.ToUniversalTime() ?? clock.Now;
        var start = from?.ToUniversalTime() ?? end.AddDays(-7);
        if (end <= start || end - start > TimeSpan.FromDays(31)) throw new ValidationException("from", "Select a date range of up to 31 days.");
        if (page < 1 || page > 400 || pageSize < 1 || pageSize > 100) throw new ValidationException("page", "Use a positive page and a page size from 1 to 100.");
        if (status is not (null or "" or "succeeded" or "failed" or "timeout" or "cancelled" or "partial" or "awaiting_confirmation" or "executing"))
            throw new ValidationException("status", "Select a valid execution status.");
        var query = db.AiMessages.AsNoTracking().Where(m => m.TenantId == tenant && m.Role == "assistant" && m.ExecutionJson != null && m.CreatedAt >= start && m.CreatedAt <= end);
        if (!string.IsNullOrEmpty(model)) query = query.Where(m => m.Model == model);
        // JSON traces are portable to SQLite and PostgreSQL. Explicit sample cap bounds memory on Hobby deployments.
        var rows = await query.OrderByDescending(m => m.CreatedAt).ThenByDescending(m => m.Id)
            .Select(m => new { m.Id, m.CreatedAt, m.InputTokens, m.OutputTokens, m.Feedback, m.ExecutionJson }).Take(10001).ToListAsync(ct);
        var limited = rows.Count > 10000;
        var runs = rows.Take(10000).Select(m =>
        {
            AiExecutionTrace? trace;
            try { trace = JsonSerializer.Deserialize<AiExecutionTrace>(m.ExecutionJson!, Json); } catch (JsonException) { return null; }
            return trace is null ? null : new AgentRunDto(m.Id, m.CreatedAt, trace.Outcome, m.InputTokens, m.OutputTokens, m.Feedback, trace);
        }).Where(r => r is not null).Select(r => r!).Where(r => string.IsNullOrEmpty(status) || r.Status == status).Where(r => string.IsNullOrEmpty(intent) || r.Trace.Intent == intent).ToList();
        var durations = runs.Select(r => r.Trace.DurationMs).Order().ToList();
        // Summaries use the same authorized, filtered sample as totals, before pagination. No conversation text is exposed.
        var paths = runs.GroupBy(r => r.Trace.Intent ?? "reasoning").Select(g =>
        {
            var times = g.Select(r => r.Trace.DurationMs).Order().ToList();
            return new AgentPathSummaryDto(g.Key, g.Count(), g.Count(r => r.Status is "failed" or "timeout" or "partial"),
                times[(int)Math.Ceiling(times.Count * .5) - 1], times[(int)Math.Ceiling(times.Count * .95) - 1],
                g.SelectMany(r => r.Trace.Models).Average(m => m.Runtime?.QueueMs),
                g.Average(r => r.Trace.Models.Sum(m => m.DurationMs)), g.Average(r => r.Trace.Tools.Sum(t => t.DurationMs)));
        }).OrderByDescending(p => p.P95Ms).ThenBy(p => p.Intent, StringComparer.Ordinal).Take(10).ToList();
        var errors = runs.Select(r => r.Trace.ErrorCode ?? (r.Trace.Tools.Any(t => !t.Succeeded) ? "tool_failed"
            : r.Trace.Actions?.Any(a => a.Status == "failed") == true ? "action_failed" : null))
            .Where(code => code is not null).GroupBy(code => code!).Select(g => new AgentErrorSummaryDto(g.Key, g.Count()))
            .OrderByDescending(e => e.Count).ThenBy(e => e.Code, StringComparer.Ordinal).Take(10).ToList();
        var disabled = await db.Tenants.Where(t => t.Id == tenant).Select(t => t.AiDisabled).FirstAsync(ct);
        var definition = new AgentDefinitionDto("project-assistant", "Project Assistant", "2", !disabled, chat.Provider, chat.ModelFor(options.Value.Chat.Standard.Model),
            ["project and task retrieval", "workload and risk analysis", "confirmation-based actions", "meeting scheduling"], options.Value.Chat.MaxToolCalls, options.Value.Fallback.TimeoutSeconds);
        return new(definition, runs.Count, runs.Count(r => r.Status == "succeeded"), runs.Count(r => r.Status is "failed" or "timeout"), runs.Count(r => r.Status == "partial"), runs.Count(r => r.Status == "awaiting_confirmation"),
            durations.Count == 0 ? 0 : durations.Average(), durations.Count == 0 ? 0 : durations[(int)Math.Ceiling(durations.Count * .95) - 1],
            runs.Sum(r => (long)r.InputTokens), runs.Sum(r => (long)r.OutputTokens), limited, page, pageSize, runs.Skip((page - 1) * pageSize).Take(pageSize).ToList(),
            durations.Count == 0 ? 0 : durations[(int)Math.Ceiling(durations.Count * .5) - 1], runs.Sum(r => r.Trace.Models.Count), runs.Sum(r => (long)(r.Trace.Database?.Commands ?? 0)), paths, errors,
            Insights(runs, start, end));
    }

    private static long Percentile(List<long> sorted, double p) => sorted.Count == 0 ? 0 : sorted[Math.Max(0, (int)Math.Ceiling(sorted.Count * p) - 1)];

    private static readonly (string Label, long UpTo)[] LatencyBuckets = [("< 1s", 1000), ("1-2s", 2000), ("2-5s", 5000), ("5-10s", 10_000), ("10-20s", 20_000), ("20-40s", 40_000), ("40s+", long.MaxValue)];

    private static AgentInsightsDto Insights(List<AgentRunDto> runs, DateTime start, DateTime end)
    {
        // Hours for a day or two, days otherwise; every bucket is present (an empty one is a real "nothing happened").
        var hourly = end - start <= TimeSpan.FromDays(2);
        var step = hourly ? TimeSpan.FromHours(1) : TimeSpan.FromDays(1);
        var first = hourly ? new DateTime(start.Year, start.Month, start.Day, start.Hour, 0, 0, DateTimeKind.Utc) : start.Date;
        var buckets = new List<AgentTimeBucketDto>();
        for (var at = first; at < end && buckets.Count < 800; at += step)
        {
            var until = at + step;
            var inBucket = runs.Where(r => r.CreatedAt >= at && r.CreatedAt < until).ToList();
            var times = inBucket.Select(r => r.Trace.DurationMs).Order().ToList();
            buckets.Add(new AgentTimeBucketDto(DateTime.SpecifyKind(at, DateTimeKind.Utc), inBucket.Count(r => r.Status == "succeeded"), inBucket.Count(r => r.Status is "failed" or "timeout" or "cancelled"),
                inBucket.Count(r => r.Status == "partial"), inBucket.Count(r => r.Status is "awaiting_confirmation" or "executing"), Percentile(times, .5), Percentile(times, .95)));
        }
        var latency = new List<AgentLatencyBucketDto>();
        long lower = -1;
        foreach (var (label, upTo) in LatencyBuckets)
        {
            latency.Add(new AgentLatencyBucketDto(label, upTo == long.MaxValue ? -1 : upTo, runs.Count(r => r.Trace.DurationMs > lower && r.Trace.DurationMs <= upTo)));
            lower = upTo;
        }
        double Avg(Func<AgentRunDto, double> f) => runs.Count == 0 ? 0 : runs.Average(f);
        var context = Avg(r => r.Trace.ContextMs); var routing = Avg(r => r.Trace.IntentMs ?? 0);
        var model = Avg(r => r.Trace.Models.Sum(m => m.DurationMs)); var tool = Avg(r => r.Trace.Tools.Sum(t => t.DurationMs));
        var other = Math.Max(0, Avg(r => r.Trace.DurationMs) - context - routing - model - tool);
        var tools = runs.SelectMany(r => r.Trace.Tools).GroupBy(t => t.Name)
            .Select(g => new AgentToolStatDto(g.Key, g.Count(), g.Count(t => !t.Succeeded), g.Average(t => (double)t.DurationMs)))
            .OrderByDescending(t => t.Calls).ThenBy(t => t.Name, StringComparer.Ordinal).Take(12).ToList();
        var models = runs.GroupBy(r => string.IsNullOrEmpty(r.Trace.Model) ? "unknown" : r.Trace.Model)
            .Select(g => new AgentModelStatDto(g.Key, g.Count(), g.Average(r => (double)r.Trace.DurationMs), g.Sum(r => (long)r.InputTokens), g.Sum(r => (long)r.OutputTokens)))
            .OrderByDescending(m => m.Runs).Take(8).ToList();
        var firstTokens = runs.Where(r => r.Trace.FirstTokenMs is not null).Select(r => r.Trace.FirstTokenMs!.Value).Order().ToList();
        var actions = runs.SelectMany(r => r.Trace.Actions ?? []).GroupBy(a => a.Kind)
            .Select(g => new AgentActionStatDto(g.Key, g.Count(), g.Count(a => a.Status == "failed"), g.Count(a => a.ConfirmationWaitMs is not null)))
            .OrderByDescending(a => a.Count).Take(10).ToList();
        return new AgentInsightsDto(buckets, hourly ? "hour" : "day", latency, new AgentPhasesDto(context, routing, model, tool, other), tools, models,
            runs.Count(r => r.Feedback == "up"), runs.Count(r => r.Feedback == "down"), runs.Sum(r => r.Trace.Models.Sum(m => (long)m.CacheReadTokens)),
            firstTokens.Count == 0 ? null : Percentile(firstTokens, .5), actions);
    }

    /// <summary>The project agent, the meeting bot and follow-ups in this workspace over a period (owners and admins).</summary>
    public async Task<AgentFleetDto> FleetAsync(DateTime? from, DateTime? to, CancellationToken ct = default)
    {
        RequireAdmin();
        var end = to?.ToUniversalTime() ?? clock.Now;
        var start = from?.ToUniversalTime() ?? end.AddDays(-7);
        if (end <= start || end - start > TimeSpan.FromDays(92)) throw new ValidationException("from", "Select a date range of up to 92 days.");
        var settings = await db.ProjectAgentSettings.AsNoTracking().Where(s => s.Enabled).Select(s => new { s.ProjectId, s.AutonomyLevel }).ToListAsync(ct);
        var runs = await db.AgentRuns.AsNoTracking().Where(r => r.StartedAt >= start && r.StartedAt <= end)
            .Select(r => new { r.Id, r.ProjectId, r.Status, r.FindingCount, r.Credits, r.StartedAt, r.MinutesSentAt, r.Trigger }).Take(20_000).ToListAsync(ct);
        var findings = await db.AgentFindings.AsNoTracking().Where(f => f.CreatedAt >= start && f.CreatedAt <= end)
            .Select(f => new { f.ProjectId, f.Kind, f.Status, f.AutoApplied, f.CreatedAt, f.DecidedAt, f.DismissReason }).Take(50_000).ToListAsync(ct);
        var signals = await db.AgentSignals.AsNoTracking().Where(x => x.CreatedAt >= start && x.CreatedAt <= end).GroupBy(x => x.Source)
            .Select(g => new { g.Key, Count = g.Count() }).ToListAsync(ct);
        var sessions = await db.AgentMeetingBots.AsNoTracking().Where(b => b.SessionStartUtc >= start && b.SessionStartUtc <= end)
            .Select(b => new { b.Kind, b.Status, b.TranscriptLength, b.SessionStartUtc }).Take(20_000).ToListAsync(ct);
        var delegations = await db.AgentDelegations.AsNoTracking().Where(d => d.SessionStartUtc >= start && d.SessionStartUtc <= end && d.Status != "cancelled")
            .Select(d => d.Status).ToListAsync(ct);
        var startDay = DateOnly.FromDateTime(start); var endDay = DateOnly.FromDateTime(end);
        var commitments = await db.AgentCommitments.AsNoTracking().Where(c => c.DueDate >= startDay && c.DueDate <= endDay)
            .Select(c => new { c.Status, c.CheckInSentAt, c.AnsweredAt, c.ChangeFindingId }).Take(20_000).ToListAsync(ct);

        var decided = findings.Where(f => f.DecidedAt is not null && f.Status != AgentFindingStatus.Proposed).ToList();
        var kinds = findings.GroupBy(f => f.Kind).Select(g => new AgentFleetKindDto(g.Key.ToString(), g.Count(), g.Count(f => f.Status == AgentFindingStatus.Applied),
            g.Count(f => f.Status == AgentFindingStatus.Dismissed), g.Count(f => f.Status == AgentFindingStatus.Proposed), g.Count(f => f.AutoApplied))).OrderByDescending(k => k.Found).ToList();
        var agent = new AgentFleetProjectAgentDto(settings.Count, runs.Count, runs.Count(r => r.Status == "failed"), findings.Count,
            findings.Count(f => f.Status == AgentFindingStatus.Applied), findings.Count(f => f.AutoApplied), findings.Count(f => f.Status == AgentFindingStatus.Dismissed),
            findings.Count(f => f.Status == AgentFindingStatus.Proposed), runs.Sum(r => r.Credits),
            decided.Count == 0 ? null : Math.Round(decided.Average(f => (f.DecidedAt!.Value - f.CreatedAt).TotalHours), 1), kinds,
            signals.Select(x => new AgentFleetSourceDto(x.Key.ToString(), x.Count)).OrderByDescending(x => x.Signals).ToList(),
            settings.Count(s => AgentLevel(s.AutonomyLevel) == 1), settings.Count(s => AgentLevel(s.AutonomyLevel) == 2), settings.Count(s => AgentLevel(s.AutonomyLevel) == 3),
            settings.Count(s => AgentLevel(s.AutonomyLevel) == 4));
        var bots = sessions.Where(b => b.Kind == "bot").ToList();
        var meetings = new AgentFleetMeetingsDto(bots.Count, bots.Count(b => b.Status == "done"), bots.Count(b => b.Status == "failed"),
            sessions.Count(b => b.Kind == "meet" && b.Status == "done"), runs.Count(r => r.MinutesSentAt is not null), delegations.Count, delegations.Count(d => d == "reported"),
            0);
        var follow = new AgentFleetFollowUpsDto(commitments.Count, commitments.Count(c => c.Status == "kept"), commitments.Count(c => c.Status == "missed"),
            commitments.Count(c => c.Status == "moved"), commitments.Count(c => c.Status == "open"), commitments.Count(c => c.CheckInSentAt is not null),
            commitments.Count(c => c.AnsweredAt is not null), commitments.Count(c => c.ChangeFindingId is not null));
        var days = new List<AgentFleetDayDto>();
        for (var d = startDay; d <= endDay && days.Count < 100; d = d.AddDays(1))
        {
            var day = d;
            days.Add(new AgentFleetDayDto(day, runs.Count(r => DateOnly.FromDateTime(r.StartedAt) == day), findings.Count(f => DateOnly.FromDateTime(f.CreatedAt) == day),
                decided.Count(f => DateOnly.FromDateTime(f.DecidedAt!.Value) == day), sessions.Count(b => DateOnly.FromDateTime(b.SessionStartUtc) == day)));
        }
        var projectIds = settings.Select(s => s.ProjectId).Concat(findings.Select(f => f.ProjectId)).Distinct().ToList();
        var projects = await db.Projects.AsNoTracking().Where(p => projectIds.Contains(p.Id)).Select(p => new { p.Id, p.Key, p.Name }).ToListAsync(ct);
        var perProject = projects.Select(p => new AgentFleetProjectDto(p.Id, p.Key, p.Name, AgentLevel(settings.FirstOrDefault(s => s.ProjectId == p.Id)?.AutonomyLevel ?? 0),
                runs.Count(r => r.ProjectId == p.Id), findings.Count(f => f.ProjectId == p.Id), findings.Count(f => f.ProjectId == p.Id && f.Status == AgentFindingStatus.Applied),
                findings.Count(f => f.ProjectId == p.Id && f.Status == AgentFindingStatus.Dismissed), findings.Count(f => f.ProjectId == p.Id && f.Status == AgentFindingStatus.Proposed)))
            .OrderByDescending(p => p.Findings).ThenBy(p => p.Name, StringComparer.Ordinal).Take(12).ToList();
        var reasons = findings.Where(f => f.Status == AgentFindingStatus.Dismissed).GroupBy(f => f.DismissReason ?? "unspecified")
            .Select(g => new AgentFleetReasonDto(g.Key, g.Count())).OrderByDescending(r => r.Count).ToList();
        return new AgentFleetDto(start, end, agent, meetings, follow, days, perProject, reasons);
    }

    private static int AgentLevel(int value) => value == 0 ? 0 : Math.Clamp(value, 1, 4);

    public void AuthorizeDiagnostics() => RequireAdmin();
}
