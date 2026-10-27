using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>The five agents of the AI control centre, by the id they are stored and served under.</summary>
public static class AiAgents
{
    public const string Project = "project", Notetaker = "notetaker", Mail = "mail", Triage = "triage", Timesheet = "timesheet";

    public static string Name(string id) => id switch
    {
        Project => "Project agent", Notetaker => "Meeting notetaker", Mail => "Mail agent", Triage => "Ticket triage", Timesheet => "Timesheet helper", _ => "AI",
    };
}

/// <summary>
/// The one place every agent reads what the workspace lets it do (Settings › AI): Off, Suggest, Ask first or Auto. Read once per scope and
/// workspace. An agent that finds itself Off skips quietly; that is logged once (at debug level) per workspace and agent, not on every tick.
/// Existing per-project and per-person switches still narrow it: an agent's effective level is the lower of the workspace's and their own
/// (<see cref="Min"/>).
/// </summary>
public class AiAgentGate(IAppDbContext db, ICurrentContext ctx, ILogger<AiAgentGate> log)
{
    private static readonly ConcurrentDictionary<(Guid Tenant, string Agent), byte> LoggedOff = new();
    private readonly Dictionary<Guid, Dictionary<string, AiAgentLevel>> cache = [];

    /// <summary>The level of one agent in the current workspace.</summary>
    public Task<AiAgentLevel> LevelAsync(string agent, CancellationToken ct = default) => LevelAsync(ctx.RequireTenantId(), agent, ct);

    /// <summary>The level of one agent in a named workspace (background work that has not taken on a workspace yet).</summary>
    public async Task<AiAgentLevel> LevelAsync(Guid tenantId, string agent, CancellationToken ct = default)
    {
        if (!cache.TryGetValue(tenantId, out var levels))
        {
            var json = await db.Tenants.AsNoTracking().Where(t => t.Id == tenantId).Select(t => t.AiAgentLevels).FirstOrDefaultAsync(ct);
            cache[tenantId] = levels = AiControlCentre.Parse(json);
        }
        var level = levels.TryGetValue(agent, out var l) ? l : AiAgentLevel.Off;
        if (level == AiAgentLevel.Off)
        {
            if (LoggedOff.TryAdd((tenantId, agent), 0)) log.LogDebug("{Agent} is off in workspace {Tenant}; skipping its work", AiAgents.Name(agent), tenantId);
        }
        else LoggedOff.TryRemove((tenantId, agent), out _);
        return level;
    }

    /// <summary>Whether the agent may do anything at all here (not Off).</summary>
    public async Task<bool> OnAsync(string agent, CancellationToken ct = default) => await LevelAsync(agent, ct) != AiAgentLevel.Off;

    /// <summary>After the levels were changed in this scope.</summary>
    public void Forget(Guid tenantId) => cache.Remove(tenantId);

    public static AiAgentLevel Min(AiAgentLevel a, AiAgentLevel b) => a < b ? a : b;
}

/// <summary>
/// Writes the AI action log (<see cref="AiAgentAction"/>): what an agent applied, and what it puts in a person's inbox at "Ask first". Rows join
/// the caller's unit of work (the caller saves). Applying also writes an activity entry on the project, so the project's activity shows it.
/// </summary>
public class AiActionLog(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public record Target(string Type, Guid? Id, string? Key, Guid? ProjectId, string? Link = null);

    /// <summary>A change the agent made: by itself (<paramref name="approvedBy"/> null, Auto) or because a person approved it.</summary>
    public AiAgentAction Applied(string agent, string action, Target target, string title, Guid? approvedBy, Guid? findingId = null)
    {
        var now = clock.Now;
        var row = new AiAgentAction
        {
            TenantId = ctx.RequireTenantId(), Agent = agent, Action = Text.Truncate(action, 64)!, TargetType = target.Type, TargetId = target.Id,
            TargetKey = Text.Truncate(target.Key, 40), ProjectId = target.ProjectId, Title = Text.Truncate(title, 500)!, Status = "applied",
            ApprovedBy = approvedBy, At = now, FindingId = findingId, Link = Text.Truncate(target.Link, 300), CreatedAt = now, CreatedBy = ctx.UserId,
        };
        db.AiAgentActions.Add(row);
        Activity(row);
        return row;
    }

    /// <summary>"Ask first": the agent's work, waiting in <paramref name="forUserId"/>'s Home inbox as one row with one action and Later.</summary>
    public AiAgentAction Propose(string agent, string action, Target target, string title, Guid forUserId, object payload)
    {
        var now = clock.Now;
        var json = JsonSerializer.Serialize(payload, Json);
        if (json.Length > 8000) throw new InvalidOperationException("An AI proposal is too large to keep.");
        var row = new AiAgentAction
        {
            TenantId = ctx.RequireTenantId(), Agent = agent, Action = Text.Truncate(action, 64)!, TargetType = target.Type, TargetId = target.Id,
            TargetKey = Text.Truncate(target.Key, 40), ProjectId = target.ProjectId, Title = Text.Truncate(title, 500)!, Status = "proposed",
            ForUserId = forUserId, Payload = json, Link = Text.Truncate(target.Link, 300), CreatedAt = now, CreatedBy = ctx.UserId,
        };
        db.AiAgentActions.Add(row);
        return row;
    }

    public static T? Read<T>(AiAgentAction row) => row.Payload is null ? default : JsonSerializer.Deserialize<T>(row.Payload, Json);

    /// <summary>The project's activity shows every AI change made in it (the entry points at the log row, so the item's own stream lists it once).</summary>
    public void Activity(AiAgentAction row)
    {
        var who = row.ApprovedBy is null ? "on its own" : "approved";
        var on = row.TargetKey is { Length: > 0 } k ? $" ({k})" : "";
        recorder.Activity($"ai.{row.Agent}.{row.Action}", "AiAgentAction", row.Id, $"{AiAgents.Name(row.Agent)}{on}: {row.Title} · {who}", row.ProjectId);
    }
}
