using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Distributed;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Ai;

public class AiOptions
{
    public const string Section = "Ai";
    /// <summary>The Anthropic API key. Empty = the assistant is off and nothing is ever sent anywhere.</summary>
    public string? AnthropicApiKey { get; set; }
    public string Model { get; set; } = "claude-sonnet-5";
    public string BaseUrl { get; set; } = "https://api.anthropic.com";
    public int MaxTokens { get; set; } = 2000;
    /// <summary>Requests per person per hour.</summary>
    public int HourlyLimit { get; set; } = 60;
}

/// <summary>A language model behind one call: a system prompt and a user message in, text out.</summary>
public interface IAiClient
{
    bool Configured { get; }
    string Model { get; }
    Task<string> CompleteAsync(string system, string user, int maxTokens, CancellationToken ct);
}

public record AiStatusDto(bool Enabled, bool Configured, bool Entitled, bool AllowedHere, string? Model);
public record AiSummaryDto(string Summary, DateTime GeneratedAt);
public record AiRiskDto(string Risk, int Score, string Headline, IReadOnlyList<string> Reasons, IReadOnlyList<string> Actions, DateTime GeneratedAt);
public record AiSearchRequest(string? Query);
public record AiSearchDto(string Interpretation, IReadOnlyList<WorkItemDto> Items);
public record AiTriageRequest(string? Title, string? Description);
public record AiTriageDto(Guid? WorkTypeId, string? WorkType, Priority? Priority, Guid? AssigneeId, string? Assignee, string Reason);
public record AiNotesRequest(string? Notes);
public record AiActionItemDto(string Title, Guid? AssigneeId, string? Assignee, DateOnly? DueDate);
public record AiNotesDto(IReadOnlyList<AiActionItemDto> Items);

/// <summary>
/// The AI assistant (Claude). Every feature gathers only what the caller may already see, through the same services the pages use, and
/// sends that - names, titles, statuses and dates - with a narrow instruction. Answers that must drive the app (filters, suggestions,
/// action items) come back as JSON and every id in them is checked against the workspace before it is used. Nothing is sent when no key
/// is configured, when the plan does not include it, or when the workspace has switched it off. Each person has an hourly allowance.
/// </summary>
public class AiAssistant(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, IAiClient ai, EntitlementService entitlements,
    IDistributedCache cache, Microsoft.Extensions.Options.IOptions<AiOptions> options, ProjectStatusService status, WorkItemService workItems,
    PermissionService permissions, ProjectAccess access)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task<AiStatusDto> StatusAsync(CancellationToken ct = default)
    {
        var entitled = await entitlements.GetValueAsync(FeatureKeys.AiAssistant, ct) > 0;
        var tid = ctx.RequireTenantId();
        var allowed = !await db.Tenants.Where(t => t.Id == tid).Select(t => t.AiDisabled).FirstOrDefaultAsync(ct);
        return new AiStatusDto(ai.Configured && entitled && allowed, ai.Configured, entitled, allowed, ai.Configured ? ai.Model : null);
    }

    private async Task GateAsync(string feature, CancellationToken ct)
    {
        if (!ai.Configured) throw new ConflictException("The AI assistant is not set up on this installation.", "AI_NOT_CONFIGURED");
        await entitlements.EnsureFeatureAsync(FeatureKeys.AiAssistant, ct);
        var tid = ctx.RequireTenantId();
        if (await db.Tenants.Where(t => t.Id == tid).Select(t => t.AiDisabled).FirstOrDefaultAsync(ct))
            throw new ForbiddenException("The AI assistant is switched off for this workspace.", "AI_DISABLED");
        var uid = ctx.RequireUserId();
        var key = $"ai:{uid:N}:{clock.Now:yyyyMMddHH}";
        var used = int.TryParse(await cache.GetStringAsync(key, ct), out var n) ? n : 0;
        if (used >= options.Value.HourlyLimit) throw new ConflictException("You have used the assistant a lot in the last hour. Try again later.", "AI_LIMIT");
        await cache.SetStringAsync(key, (used + 1).ToString(), new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromHours(1) }, ct);
        // Which feature was used, never what was sent or answered.
        recorder.Audit("ai.used", "AiAssistant", null, null, new { feature, model = ai.Model });
        await db.SaveChangesAsync(ct);
    }

    private const string Voice = "You are the assistant inside Project Tracker, a project and work management app. Be concise, concrete and factual. " +
        "Use only the data given; never invent projects, people, dates or numbers. Write in plain English for busy managers.";

    /// <summary>The first JSON object in a model answer (models sometimes wrap it in prose or a code fence).</summary>
    public static JsonNode? JsonIn(string text)
    {
        var start = text.IndexOf('{'); var end = text.LastIndexOf('}');
        if (start < 0 || end <= start) return null;
        try { return JsonNode.Parse(text[start..(end + 1)]); } catch (JsonException) { return null; }
    }

    private static string? Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s) ? s.Trim() : null;

    // ------------------------------------------------------------------ portfolio summary

    public async Task<AiSummaryDto> PortfolioSummaryAsync(CancellationToken ct = default)
    {
        await permissions.RequireModuleAsync(Modules.Projects, AccessLevel.View, ct);
        await GateAsync("portfolio_summary", ct);
        var groups = await status.GroupsAsync(ct);
        var projects = groups.SelectMany(g => g.Projects.Select(p => new { group = g.Name, p.Key, p.Name, status = p.Status.ToString(), health = p.Health.ToString(), progress = p.Progress }))
            .Where(p => p.status is not ("Completed" or "Archived" or "Cancelled")).Take(80).ToList();
        if (projects.Count == 0) return new AiSummaryDto("There are no active projects to summarise.", clock.Now);
        var overdue = await workItems.ListAsync(new WorkItemQuery(Overdue: true, Limit: 60), WorkItemScope.Caller, ct);
        var data = JsonSerializer.Serialize(new
        {
            today = clock.Today, projects,
            overdue = overdue.Select(i => new { i.Key, i.Title, project = i.ProjectName, i.DueDate, assignee = i.Assignee?.Name, priority = i.Priority.ToString() }),
        }, Json);
        var text = await ai.CompleteAsync(Voice,
            "Write an executive portfolio summary from this data. Structure: one-sentence overall picture; then '## Needs attention' with up to 5 bullets " +
            "(project or item, why, suggested next step); then '## Going well' with up to 3 bullets. Mention project keys. Under 250 words.\n\nDATA:\n" + data, 900, ct);
        return new AiSummaryDto(text, clock.Now);
    }

    // ------------------------------------------------------------------ delay risk of a project

    public async Task<AiRiskDto> ProjectRiskAsync(Guid projectId, CancellationToken ct = default)
    {
        var report = await status.ReportAsync(projectId, ct);
        await GateAsync("project_risk", ct);
        var p = report.Project;
        var weeks = Enumerable.Range(0, 4).Select(i => clock.Today.AddDays(-7 * (i + 1))).ToList();
        var done = await db.Tasks.AsNoTracking().Where(t => t.ProjectId == projectId && t.CompletedAt != null && t.CompletedAt >= clock.Now.AddDays(-28))
            .Select(t => t.CompletedAt!.Value).ToListAsync(ct);
        var data = JsonSerializer.Serialize(new
        {
            today = clock.Today,
            project = new { p.Key, p.Name, status = p.Status.ToString(), health = p.Health.ToString(), p.Progress, p.StartDate, p.DueDate, p.OriginalDueDate, p.DelayedDays, p.Stats },
            completedPerWeekOldestFirst = weeks.AsEnumerable().Reverse().Select(w => done.Count(d => DateOnly.FromDateTime(d) >= w && DateOnly.FromDateTime(d) < w.AddDays(7))),
            delayedTasks = report.DelayedTasks, blockedTasks = report.BlockedTasks,
            lateOrBlocked = report.Tasks.Where(t => t.OverdueDays > 0 || t.DelayedDays > 0 || t.BlockedBy.Count > 0).Take(25)
                .Select(t => new { t.Key, t.Title, status = t.StatusName, t.DueDate, t.OverdueDays, t.DelayedDays, t.Revisions, assignee = t.Assignee?.Name, blockedBy = t.BlockedBy.Select(b => b.Key) }),
            dateChanges = report.Changes.Take(15).Select(c => new { c.Scope, c.TaskKey, c.Previous, c.Revised, c.DaysShifted, c.Reason }),
        }, Json);
        var text = await ai.CompleteAsync(Voice,
            "Assess the risk that this project misses its due date. Answer with JSON only, no prose: " +
            "{\"risk\":\"low|medium|high\",\"score\":0-100,\"headline\":\"one sentence\",\"reasons\":[\"up to 4, each citing data\"],\"actions\":[\"up to 4 concrete next steps\"]}\n\nDATA:\n" + data, 700, ct);
        var j = JsonIn(text) ?? throw new AppException(502, "AI_FAILED", "The assistant's answer could not be read. Try again.");
        var risk = Str(j["risk"])?.ToLowerInvariant() is "low" or "medium" or "high" ? Str(j["risk"])!.ToLowerInvariant() : "medium";
        var score = j["score"] is JsonValue sv && sv.TryGetValue<int>(out var sc) ? Math.Clamp(sc, 0, 100) : risk == "high" ? 75 : risk == "low" ? 20 : 50;
        static IReadOnlyList<string> List(JsonNode? n) => (n as JsonArray ?? []).Select(Str).Where(s => s is not null).Select(s => s!).Take(4).ToList();
        return new AiRiskDto(risk, score, Str(j["headline"]) ?? "Risk assessed from the project's dates and progress.", List(j["reasons"]), List(j["actions"]), clock.Now);
    }

    // ------------------------------------------------------------------ natural-language search

    public async Task<AiSearchDto> SearchAsync(AiSearchRequest req, CancellationToken ct = default)
    {
        var q = (req.Query ?? "").Trim();
        if (q.Length is < 3 or > 300) throw new ValidationException("query", "Ask in a few words, e.g. “overdue high priority bugs assigned to Priya”.");
        await GateAsync("search", ct);
        var tid = ctx.RequireTenantId();
        var people = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.Role != TenantRole.Guest).Select(m => new { id = m.UserId, name = m.User!.DisplayName }).Take(300).ToListAsync(ct);
        var projects = await access.VisibleProjects().AsNoTracking().Select(p => new { id = p.Id, p.Key, p.Name }).Take(300).ToListAsync(ct);
        var text = await ai.CompleteAsync(Voice,
            "Turn the request into a filter for work items. Answer with JSON only: {\"interpretation\":\"what you understood, one short sentence\"," +
            "\"kinds\":[subset of \"Task\",\"Issue\",\"ActionItem\",\"Operational\" or empty for all],\"assigneeId\":\"id from PEOPLE, or 'me', or null\"," +
            "\"projectId\":\"id from PROJECTS or null\",\"openOnly\":true|false,\"overdue\":true|false,\"dueFrom\":\"yyyy-mm-dd or null\",\"dueTo\":\"yyyy-mm-dd or null\"," +
            "\"priority\":\"Low|Medium|High|Critical or null\",\"text\":\"words to search titles for, or null\"}\n" +
            $"TODAY: {clock.Today:yyyy-MM-dd} ({clock.Today.DayOfWeek})\nPEOPLE: {JsonSerializer.Serialize(people, Json)}\nPROJECTS: {JsonSerializer.Serialize(projects, Json)}\nREQUEST: {q}", 500, ct);
        var j = JsonIn(text) ?? throw new AppException(502, "AI_FAILED", "The assistant's answer could not be read. Try again.");

        Guid? assignee = Str(j["assigneeId"]) is { } a ? a == "me" ? ctx.UserId : Guid.TryParse(a, out var g) && people.Any(x => x.id == g) ? g : null : null;
        Guid? project = Str(j["projectId"]) is { } ps && Guid.TryParse(ps, out var pg) && projects.Any(x => x.id == pg) ? pg : null;
        var kinds = (j["kinds"] as JsonArray ?? []).Select(Str).Select(k => Enum.TryParse<WorkItemKind>(k, true, out var kk) ? (WorkItemKind?)kk : null).Where(k => k is not null).Select(k => k!.Value).Distinct().ToList();
        DateOnly? Date(string name) => DateOnly.TryParse(Str(j[name]), out var d) ? d : null;
        var priority = Enum.TryParse<Priority>(Str(j["priority"]), true, out var pr) ? pr : (Priority?)null;
        var items = await workItems.ListAsync(new WorkItemQuery(kinds.Count > 0 ? kinds : null, assignee, false, j["openOnly"]?.GetValue<bool?>() ?? true, project,
            Date("dueFrom"), Date("dueTo"), j["overdue"]?.GetValue<bool?>() ?? false, Str(j["text"]), 100), WorkItemScope.Caller, ct);
        if (priority is { } want) items = items.Where(i => i.Priority == want).ToList();
        return new AiSearchDto(Str(j["interpretation"]) ?? $"Work matching “{q}”", items.Take(50).ToList());
    }

    // ------------------------------------------------------------------ triage of new operational work

    public async Task<AiTriageDto> TriageAsync(AiTriageRequest req, CancellationToken ct = default)
    {
        var title = (req.Title ?? "").Trim();
        if (title.Length < 3) throw new ValidationException("title", "Write a title first.");
        await permissions.RequireModuleAsync(Modules.Work, AccessLevel.Edit, ct);
        await GateAsync("triage", ct);
        var tid = ctx.RequireTenantId();
        var types = await db.WorkTypes.AsNoTracking().Where(t => t.IsActive).OrderBy(t => t.Order).Select(t => new { id = t.Id, t.Name, t.Description }).ToListAsync(ct);
        var people = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.Role != TenantRole.Guest)
            .Select(m => new { id = m.UserId, name = m.User!.DisplayName, jobRole = db.OrgRoles.Where(r => r.Id == m.OrgRoleId).Select(r => r.Name).FirstOrDefault() }).Take(200).ToListAsync(ct);
        var counts = await workItems.CountsAsync(people.Select(p => p.id).ToList(), WorkItemScope.Caller, ct);
        var text = await ai.CompleteAsync(Voice,
            "Suggest how to triage this new piece of operational work. Prefer people whose job role fits and who have less open work. Answer with JSON only: " +
            "{\"workTypeId\":\"id from TYPES\",\"priority\":\"Low|Medium|High|Critical\",\"assigneeId\":\"id from PEOPLE or null\",\"reason\":\"one or two sentences\"}\n" +
            $"TYPES: {JsonSerializer.Serialize(types, Json)}\nPEOPLE: {JsonSerializer.Serialize(people.Select(p => new { p.id, p.name, p.jobRole, open = counts.GetValueOrDefault(p.id)?.Open ?? 0, overdue = counts.GetValueOrDefault(p.id)?.Overdue ?? 0 }), Json)}\n" +
            $"WORK: {JsonSerializer.Serialize(new { title, description = Trim(req.Description, 3000) }, Json)}", 400, ct);
        var j = JsonIn(text) ?? throw new AppException(502, "AI_FAILED", "The assistant's answer could not be read. Try again.");
        var type = Guid.TryParse(Str(j["workTypeId"]), out var wt) ? types.FirstOrDefault(t => t.id == wt) : null;
        var person = Guid.TryParse(Str(j["assigneeId"]), out var pid) ? people.FirstOrDefault(p => p.id == pid) : null;
        return new AiTriageDto(type?.id, type?.Name, Enum.TryParse<Priority>(Str(j["priority"]), true, out var pr) ? pr : null, person?.id, person?.name,
            Str(j["reason"]) ?? "Suggested from the work's description.");
    }

    // ------------------------------------------------------------------ meeting notes to action items

    public async Task<AiNotesDto> ActionItemsFromNotesAsync(Guid projectId, AiNotesRequest req, CancellationToken ct = default)
    {
        var notes = (req.Notes ?? "").Trim();
        if (notes.Length < 20) throw new ValidationException("notes", "Paste the meeting notes first.");
        if (notes.Length > 20_000) throw new ValidationException("notes", "Keep the notes under 20,000 characters.");
        var project = await access.GetProjectAsync(projectId, ct);
        await GateAsync("action_items", ct);
        var tid = ctx.RequireTenantId();
        var people = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.Role != TenantRole.Guest).Select(m => new { id = m.UserId, name = m.User!.DisplayName }).Take(300).ToListAsync(ct);
        var text = await ai.CompleteAsync(Voice,
            "Extract the action items agreed in these meeting notes. Only real commitments (someone will do something), not discussion. " +
            "Answer with JSON only: {\"items\":[{\"title\":\"imperative, under 120 characters\",\"assigneeId\":\"id from PEOPLE or null\",\"dueDate\":\"yyyy-mm-dd or null\"}]} (at most 20).\n" +
            $"TODAY: {clock.Today:yyyy-MM-dd}\nPROJECT: {project.Key} {project.Name}\nPEOPLE: {JsonSerializer.Serialize(people, Json)}\nNOTES:\n{notes}", 1500, ct);
        var j = JsonIn(text) ?? throw new AppException(502, "AI_FAILED", "The assistant's answer could not be read. Try again.");
        var items = (j["items"] as JsonArray ?? []).Select(i =>
        {
            var t = Str(i?["title"]);
            if (t is null) return null;
            var who = Guid.TryParse(Str(i?["assigneeId"]), out var g) ? people.FirstOrDefault(p => p.id == g) : null;
            DateOnly? due = DateOnly.TryParse(Str(i?["dueDate"]), out var d) && d >= clock.Today.AddDays(-1) ? d : null;
            return new AiActionItemDto(t.Length > 200 ? t[..200] : t, who?.id, who?.name, due);
        }).Where(x => x is not null).Select(x => x!).Take(20).ToList();
        return new AiNotesDto(items);
    }

    private static string? Trim(string? s, int max) => s is null ? null : s.Length <= max ? s : s[..max];

    // ------------------------------------------------------------------ workspace switch

    public async Task<AiStatusDto> SetAllowedAsync(bool allowed, CancellationToken ct = default)
    {
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only owners and admins can switch the assistant on or off.", "PERMISSION_DENIED");
        var tid = ctx.RequireTenantId();
        var tenant = await db.Tenants.FirstAsync(t => t.Id == tid, ct);
        tenant.AiDisabled = !allowed;
        recorder.Audit("ai.workspace_switch", "Tenant", tid, null, new { allowed });
        await db.SaveChangesAsync(ct);
        return await StatusAsync(ct);
    }
}
