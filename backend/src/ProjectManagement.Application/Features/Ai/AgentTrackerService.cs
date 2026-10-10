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
    IReadOnlyList<AgentPathSummaryDto>? SlowestPaths = null, IReadOnlyList<AgentErrorSummaryDto>? FrequentErrors = null);
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
            durations.Count == 0 ? 0 : durations[(int)Math.Ceiling(durations.Count * .5) - 1], runs.Sum(r => r.Trace.Models.Count), runs.Sum(r => (long)(r.Trace.Database?.Commands ?? 0)), paths, errors);
    }

    public void AuthorizeDiagnostics() => RequireAdmin();
}
