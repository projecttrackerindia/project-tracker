using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ProjectManagement.Application.Exceptions;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>Immutable approval identity plus persistent execution metadata, stored with each existing proposal.</summary>
public sealed record AiActionExecution(Guid PlanId, int Version, Guid TenantId, Guid UserId, string PayloadHash,
    IReadOnlyList<string> DependsOn, DateTime ProposedAt, DateTime ExpiresAt, DateTime? ApprovedAt = null,
    DateTime? StartedAt = null, DateTime? CompletedAt = null, long? DurationMs = null, int Attempts = 0, Guid? ExecutionId = null,
    AiDatabaseTiming? Database = null);
public sealed record AiActionLifecycleDto(Guid PlanId, int Version, IReadOnlyList<string> DependsOn, DateTime ProposedAt,
    DateTime ExpiresAt, DateTime? ApprovedAt, DateTime? StartedAt, DateTime? CompletedAt, long? DurationMs, int Attempts);

public static class AiActionPlan
{
    private static string Hash(string payload) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(payload)));
    public static Guid Identity(Guid tenant, Guid user, Guid message, AiProposal action)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes($"{tenant:N}:{user:N}:{message:N}:{action.Id}:{action.Kind}"));
        return new Guid(hash.AsSpan(0, 16));
    }
    public static AiProposal Bind(AiProposal action, Guid plan, Guid tenant, Guid user, DateTime now, IReadOnlyList<AiProposal> previous)
    {
        using var payload = JsonDocument.Parse(action.PayloadJson);
        var a = payload.RootElement;
        var dependencies = new List<string>();
        // Only an actual reference to a proposed new project creates a dependency; independent actions stay independent.
        if (a.TryGetProperty("projectName", out var name) && name.ValueKind == JsonValueKind.String
            && (!a.TryGetProperty("projectId", out var id) || id.ValueKind == JsonValueKind.Null))
        {
            foreach (var p in previous.Where(p => p.Kind == "create_project"))
            {
                using var project = JsonDocument.Parse(p.PayloadJson);
                if (project.RootElement.TryGetProperty("name", out var n) && n.GetString()?.Equals(name.GetString(), StringComparison.OrdinalIgnoreCase) == true)
                    dependencies.Add(p.Id);
            }
        }
        return action with { Execution = new(plan, 1, tenant, user, Hash(action.PayloadJson), dependencies, now, now.AddHours(24)) };
    }
    public static void ValidateBinding(AiProposal action, Guid tenant, Guid user)
    {
        if (action.Execution is { } e && (e.Version != 1 || e.TenantId != tenant || e.UserId != user || e.PayloadHash != Hash(action.PayloadJson)))
            throw new ConflictException("The approved plan does not match this action. Create and review a new proposal.", "AI_PLAN_MISMATCH");
    }
    public static string Outcome(IReadOnlyList<AiProposal> actions) => actions.Any(a => a.Status == "running") ? "executing"
        : actions.Any(a => a.Status == "failed") ? actions.Any(a => a.Status == "done") ? "partial" : "failed"
        : actions.Any(a => a.Status == "proposed") ? "awaiting_confirmation" : actions.All(a => a.Status == "dismissed") ? "cancelled" : "succeeded";
    public static IReadOnlyList<AiActionTiming> Timings(IReadOnlyList<AiProposal> actions) => actions.Select(a => new AiActionTiming(a.Id, a.Kind, a.Status,
        a.Execution?.DurationMs, a.Execution?.ApprovedAt is { } approved ? Math.Max(0, (long)(approved - a.Execution.ProposedAt).TotalMilliseconds) : null,
        a.Execution?.Attempts ?? 0, a.Execution?.Database)).ToList();
    public static void Validate(AiProposal action, IReadOnlyList<AiProposal> all, Guid tenant, Guid user, DateTime now)
    {
        ValidateBinding(action, tenant, user);
        if (action.Execution is not { } e) return; // Existing saved cards retain their original confirmation safeguards.
        if (e.ExpiresAt <= now) throw new ConflictException("This plan expired. Create and review a new proposal.", "AI_ACTION_EXPIRED");
        if (e.DependsOn.Any(id => all.FirstOrDefault(p => p.Id == id)?.Status != "done"))
            throw new ConflictException("Confirm and complete the prerequisite action first.", "AI_ACTION_DEPENDENCY");
    }
    public static AiActionLifecycleDto? ToDto(AiActionExecution? e) => e is null ? null : new(e.PlanId, e.Version, e.DependsOn,
        e.ProposedAt, e.ExpiresAt, e.ApprovedAt, e.StartedAt, e.CompletedAt, e.DurationMs, e.Attempts);
}
