using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>What an agent may do: nothing, suggest in place, put its work in the inbox for one-tap approval, or act on its own.</summary>
public enum AiAgentLevel { Off = 0, Suggest = 1, AskFirst = 2, Auto = 3 }

public record AiAgentLevelDto(string Id, string Name, string Description, string Level);
public record AiControlDto(IReadOnlyList<AiAgentLevelDto> Agents, int ContextLength, int ContextLimit, int Automations, int People, bool AiOn, bool CanEdit);
public record AiContextDraftDto(string Text);
public record SetAiAgentLevelRequest(string Level);

/// <summary>
/// The AI control centre (Settings › AI): per-agent levels for the workspace, and the figures that sit beside them that are not already served
/// elsewhere (context length, automations, people). Credits, answer success, the model and the organisation context itself come from their own
/// endpoints. Owners and admins change levels; everyone in the workspace may read them, so features can respect them.
/// </summary>
public class AiControlCentre(IAppDbContext db, ICurrentContext ctx, Recorder recorder)
{
    public const int ContextLimit = 4000;

    private sealed record Agent(string Id, string Name, string Description, AiAgentLevel Default);

    /// <summary>The five agents of v2, in the order the control centre lists them, with their level when nobody has chosen one.</summary>
    private static readonly Agent[] Agents =
    [
        new("project", "Project agent", "Reads email, chat and meetings; proposes dates, tasks, risks", AiAgentLevel.Suggest),
        new("notetaker", "Meeting notetaker", "Joins calls, writes notes and action items", AiAgentLevel.AskFirst),
        new("mail", "Mail agent", "Summarises threads and drafts replies", AiAgentLevel.AskFirst),
        new("triage", "Ticket triage", "Sets priority, SLA and assignee on new tickets", AiAgentLevel.Suggest),
        new("timesheet", "Timesheet helper", "Drafts your week from tasks and meetings", AiAgentLevel.Suggest),
    ];

    private static readonly Dictionary<string, AiAgentLevel> Names = new(StringComparer.OrdinalIgnoreCase)
    {
        ["off"] = AiAgentLevel.Off, ["suggest"] = AiAgentLevel.Suggest, ["askfirst"] = AiAgentLevel.AskFirst, ["ask first"] = AiAgentLevel.AskFirst,
        ["ask-first"] = AiAgentLevel.AskFirst, ["auto"] = AiAgentLevel.Auto,
    };

    public static string Wire(AiAgentLevel l) => l switch { AiAgentLevel.Off => "off", AiAgentLevel.AskFirst => "askFirst", AiAgentLevel.Auto => "auto", _ => "suggest" };

    /// <summary>The stored levels; anything unreadable or unknown falls back to the defaults, so a bad value never switches an agent on.</summary>
    public static Dictionary<string, AiAgentLevel> Parse(string? json)
    {
        var levels = Agents.ToDictionary(a => a.Id, a => a.Default);
        if (string.IsNullOrWhiteSpace(json)) return levels;
        try
        {
            var stored = JsonSerializer.Deserialize<Dictionary<string, int>>(json) ?? [];
            foreach (var (k, v) in stored)
                if (levels.ContainsKey(k) && Enum.IsDefined(typeof(AiAgentLevel), v)) levels[k] = (AiAgentLevel)v;
        }
        catch (JsonException) { /* keep the defaults */ }
        return levels;
    }

    /// <summary>The level of one agent in the current workspace (for agents deciding whether to act, suggest or ask).</summary>
    public async Task<AiAgentLevel> LevelAsync(string agent, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var json = await db.Tenants.AsNoTracking().Where(t => t.Id == tid).Select(t => t.AiAgentLevels).FirstOrDefaultAsync(ct);
        return Parse(json).TryGetValue(agent, out var l) ? l : AiAgentLevel.Off;
    }

    private bool Admin => ctx.Role is TenantRole.Owner or TenantRole.Admin;

    public async Task<AiControlDto> GetAsync(CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var t = await db.Tenants.AsNoTracking().Where(x => x.Id == tid).Select(x => new { x.AiAgentLevels, x.AiInstructions, x.AiDisabled }).FirstAsync(ct);
        var levels = Parse(t.AiAgentLevels);
        var automations = await db.AutomationRules.AsNoTracking().CountAsync(r => r.TenantId == tid && r.IsEnabled, ct);
        var people = await db.TenantMembers.AsNoTracking().CountAsync(m => m.TenantId == tid, ct);
        return new AiControlDto(Agents.Select(a => new AiAgentLevelDto(a.Id, a.Name, a.Description, Wire(levels[a.Id]))).ToList(),
            t.AiInstructions?.Length ?? 0, ContextLimit, automations, people, !t.AiDisabled, Admin);
    }

    public async Task<AiControlDto> SetLevelAsync(string agent, string level, CancellationToken ct = default)
    {
        if (!Admin) throw new ForbiddenException("Only owners and admins can change what the AI may do.", "PERMISSION_DENIED");
        var def = Agents.FirstOrDefault(a => string.Equals(a.Id, agent, StringComparison.OrdinalIgnoreCase)) ?? throw new NotFoundException("That agent does not exist.");
        if (!Names.TryGetValue((level ?? "").Trim(), out var next)) throw new ValidationException("level", "Choose Off, Suggest, Ask first or Auto.");
        var tid = ctx.RequireTenantId();
        var tenant = await db.Tenants.FirstAsync(t => t.Id == tid, ct);
        var levels = Parse(tenant.AiAgentLevels);
        var before = levels[def.Id];
        if (before != next)
        {
            levels[def.Id] = next;
            tenant.AiAgentLevels = JsonSerializer.Serialize(levels.ToDictionary(x => x.Key, x => (int)x.Value));
            recorder.Audit("ai.agent_level_changed", "Tenant", tid, new { agent = def.Id, level = Wire(before) }, new { agent = def.Id, level = Wire(next) });
            await db.SaveChangesAsync(ct);
        }
        return await GetAsync(ct);
    }

    /// <summary>
    /// "Draft it from my projects": a first version of the organisation context, written from the workspace's own records (no AI, no credits):
    /// its name, teams and active projects. The admin edits it before saving; nothing is saved here.
    /// </summary>
    public async Task<AiContextDraftDto> DraftContextAsync(CancellationToken ct = default)
    {
        if (!Admin) throw new ForbiddenException("Only owners and admins can tell the assistant about the organization.", "PERMISSION_DENIED");
        var tid = ctx.RequireTenantId();
        var tenant = await db.Tenants.AsNoTracking().Where(t => t.Id == tid).Select(t => new { t.Name, t.Description }).FirstAsync(ct);
        var projects = await db.Projects.AsNoTracking()
            .Where(p => p.TenantId == tid && p.ArchivedAt == null && (p.Status == ProjectStatus.Active || p.Status == ProjectStatus.Planning || p.Status == ProjectStatus.OnHold))
            .OrderBy(p => p.Key).Select(p => new { p.Key, p.Name, p.Description, p.DueDate }).Take(40).ToListAsync(ct);
        var teams = await db.Teams.AsNoTracking().Where(t => t.TenantId == tid).OrderBy(t => t.Name).Select(t => t.Name).Take(20).ToListAsync(ct);

        var sb = new StringBuilder();
        sb.Append($"We are {tenant.Name}.");
        if (!string.IsNullOrWhiteSpace(tenant.Description)) sb.Append(' ').Append(OneLine(tenant.Description, 300));
        sb.AppendLine();
        if (teams.Count > 0) sb.AppendLine($"Teams: {string.Join(", ", teams)}.");
        if (projects.Count > 0)
        {
            sb.AppendLine("Active projects:");
            foreach (var p in projects)
            {
                var line = $"- {p.Key} {p.Name}";
                if (p.DueDate is { } due) line += $" (due {due:d MMM yyyy})";
                if (!string.IsNullOrWhiteSpace(p.Description)) line += $": {OneLine(p.Description, 120)}";
                if (sb.Length + line.Length + 1 > ContextLimit - 200) break;
                sb.AppendLine(line);
            }
        }
        sb.AppendLine("Add your rules here: release freezes, what P1 means, who gets which reports and when.");
        var text = sb.ToString().Trim();
        return new AiContextDraftDto(text.Length > ContextLimit ? text[..ContextLimit] : text);
    }

    private static string OneLine(string s, int max)
    {
        var flat = string.Join(' ', s.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return flat.Length > max ? flat[..(max - 1)] + "…" : flat;
    }
}
