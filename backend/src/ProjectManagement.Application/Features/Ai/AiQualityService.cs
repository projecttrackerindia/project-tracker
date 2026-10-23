using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Ai;

public record AiQualityWeekDto(DateOnly Week, int Answers, int Down, int Up, int Reasked, int CardsProposed, int CardsConfirmed, int CardsDismissed, int CardsUndone, int ToolFailures);
public record AiQualityAreaDto(string Area, int Answers, double DownRate, double ReaskRate, double DismissRate, double ToolFailureRate, double Score);
public record AiQualityReasonDto(string Reason, int Count);
public record AiEvaluationDto(Guid Id, DateTime RanAt, string? Model, string? Mode, int Total, int Passed, double Rate, int Credits, JsonElement Summary);
public record AiQualityDto(DateTime From, DateTime To, int Answers, double DownRate, double ReaskRate, double DismissRate, double UndoRate, double ToolFailureRate,
    IReadOnlyList<AiQualityWeekDto> Weeks, IReadOnlyList<AiQualityAreaDto> Areas, IReadOnlyList<AiQualityReasonDto> DownReasons, IReadOnlyList<AiEvaluationDto> Evaluations, bool SampleLimited);
public record ReportEvaluationRequest(string? Model, string? Mode, int Total, int Passed, int Credits, JsonElement? ByArea, JsonElement? ByLang, DateTime? RanAt);

/// <summary>
/// How well the assistant is doing in this workspace, from what people did rather than what they said: answers marked not helpful, questions
/// asked again within two minutes (the answer did not land), cards dismissed or undone, and tool failures - by week and by area of the app
/// (worked out from the tools an answer used). Counts only: no question, answer or name is read for this. Owners and admins only.
/// Also the scenario gradings reported for this workspace, to see whether a change made things better or worse.
/// </summary>
public class AiQualityService(IAppDbContext db, ICurrentContext ctx, AppClock clock)
{
    public const int SampleCap = 20000;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private void RequireAdmin()
    {
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only workspace owners and admins can see assistant quality.", "PERMISSION_DENIED");
    }

    /// <summary>Which area of the app an answer was about, from the first tool it used that belongs to one.</summary>
    public static string AreaOf(IEnumerable<string> tools)
    {
        foreach (var t in tools)
        {
            var area = t switch
            {
                "needs_you" or "show_plan" or "my_schedule" or "propose_clear_notification" or "propose_decide_agent_proposal" => "day",
                "find_work" or "my_work_summary" or "propose_update_work" or "propose_create_task" or "propose_delete_work" or "propose_create_work" or "propose_create_action_item" => "tasks",
                "project_report" or "list_projects" or "propose_update_project" or "propose_update_stage_dates" or "propose_schedule_project" or "propose_create_project" => "projects",
                "portfolio_brief" or "portfolio_scenario" or "portfolio_decisions" or "propose_apply_portfolio_option" or "history_insights" => "portfolio",
                "team_workload" or "workload_balance" or "suggest_assignee" or "list_people" or "propose_invite_member" => "workload",
                "my_time" or "propose_log_time" or "propose_submit_week" or "propose_review_timesheet" or "propose_planned_leave" or "list_planned_leave" => "time",
                "chat_catch_up" or "chat_search" or "propose_send_message" or "propose_chat_reply" => "chat",
                "mail_inbox" or "mail_read" or "propose_mail_reply" or "propose_mail_forward" => "mail",
                "search_documents" or "read_document" or "search_knowledge" or "read_knowledge" or "propose_edit_page" or "propose_page_comment" or "propose_create_document" => "docs",
                "vault_find" or "propose_vault_request" or "propose_vault_share" => "vault",
                "list_reminders" or "propose_reminder" or "revise_reminder_proposal" or "propose_update_reminder" or "propose_watch" or "propose_stop_watch" or "list_watches" => "reminders",
                "list_project_meetings" or "propose_start_meeting" or "propose_schedule_meeting" => "meetings",
                "decision_log" or "propose_answer_check_in" => "agent",
                "propose_send_report" => "reports",
                _ => null,
            };
            if (area is not null) return area;
        }
        return "conversation";
    }

    private sealed record Row(Guid ConversationId, string Role, DateTime CreatedAt, string? ToolsJson, string? ActionsJson, string? Feedback, string? FeedbackReason);
    private sealed record ToolUse(string Name);
    private sealed record Card(string Kind, string Status);

    public async Task<AiQualityDto> GetAsync(DateTime? from, DateTime? to, CancellationToken ct = default)
    {
        RequireAdmin();
        var end = to ?? clock.Now;
        var start = from ?? end.AddDays(-56);
        if (end - start > TimeSpan.FromDays(366)) start = end.AddDays(-366);
        var rows = await db.AiMessages.AsNoTracking().Where(m => m.CreatedAt >= start && m.CreatedAt <= end)
            .OrderByDescending(m => m.CreatedAt).Take(SampleCap + 1)
            .Select(m => new Row(m.ConversationId, m.Role, m.CreatedAt, m.Role == "assistant" ? m.ToolsJson : null, m.Role == "assistant" ? m.ActionsJson : null, m.Feedback, m.FeedbackReason))
            .ToListAsync(ct);
        var limited = rows.Count > SampleCap;
        if (limited) rows = rows.Take(SampleCap).ToList();
        // Failed tool calls are kept in the sanitized operational trace; read only the counts from it.
        var failures = await db.AiMessages.AsNoTracking().Where(m => m.Role == "assistant" && m.CreatedAt >= start && m.CreatedAt <= end && m.ExecutionJson != null && m.ExecutionJson.Contains("\"succeeded\":false"))
            .Select(m => new { m.ConversationId, m.CreatedAt }).Take(SampleCap).ToListAsync(ct);
        var failed = failures.Select(f => (f.ConversationId, f.CreatedAt)).ToHashSet();

        var answers = new List<(DateTime At, string Area, bool Down, bool Up, bool Reasked, int Proposed, int Confirmed, int Dismissed, int Undone, bool ToolFailed, string? Reason)>();
        foreach (var conversation in rows.GroupBy(r => r.ConversationId))
        {
            var list = conversation.OrderBy(r => r.CreatedAt).ToList();
            for (var i = 0; i < list.Count; i++)
            {
                var r = list[i];
                if (r.Role != "assistant") continue;
                var tools = Parse<ToolUse>(r.ToolsJson).Select(t => t.Name).ToList();
                var cards = Parse<Card>(r.ActionsJson);
                // Asked again: the next thing in the conversation is the person asking within two minutes, and nothing was confirmed from this answer.
                var next = i + 1 < list.Count ? list[i + 1] : null;
                var reasked = next is { Role: "user" } && next.CreatedAt - r.CreatedAt <= TimeSpan.FromMinutes(2) && !cards.Any(c => c.Status is "done" or "undone");
                answers.Add((r.CreatedAt, AreaOf(tools), r.Feedback == "down", r.Feedback == "up", reasked, cards.Count, cards.Count(c => c.Status is "done" or "undone"),
                    cards.Count(c => c.Status == "dismissed"), cards.Count(c => c.Status == "undone"), failed.Contains((r.ConversationId, r.CreatedAt)), r.FeedbackReason));
            }
        }

        static double Rate(int part, int whole) => whole == 0 ? 0 : Math.Round((double)part / whole, 3);
        var weeks = answers.GroupBy(a => WeekOf(a.At)).OrderBy(g => g.Key).Select(g => new AiQualityWeekDto(g.Key, g.Count(), g.Count(a => a.Down), g.Count(a => a.Up), g.Count(a => a.Reasked),
            g.Sum(a => a.Proposed), g.Sum(a => a.Confirmed), g.Sum(a => a.Dismissed), g.Sum(a => a.Undone), g.Count(a => a.ToolFailed))).ToList();
        var areas = answers.GroupBy(a => a.Area).Select(g =>
        {
            var n = g.Count(); var proposed = g.Sum(a => a.Proposed);
            var down = Rate(g.Count(a => a.Down), n); var reask = Rate(g.Count(a => a.Reasked), n); var dismiss = Rate(g.Sum(a => a.Dismissed) + g.Sum(a => a.Undone), proposed); var tool = Rate(g.Count(a => a.ToolFailed), n);
            // One number to sort by: the share of answers that did not land, weighted towards the clearest signals.
            var score = Math.Round(1 - Math.Min(1, down * 2 + reask + dismiss * 0.5 + tool), 3);
            return new AiQualityAreaDto(g.Key, n, down, reask, dismiss, tool, score);
        }).OrderBy(a => a.Score).ThenByDescending(a => a.Answers).ToList();
        var reasons = answers.Where(a => a.Down).GroupBy(a => a.Reason ?? "unspecified").Select(g => new AiQualityReasonDto(g.Key, g.Count())).OrderByDescending(r => r.Count).ToList();

        var total = answers.Count; var proposedAll = answers.Sum(a => a.Proposed);
        var evaluations = await db.AiEvaluationRuns.AsNoTracking().OrderByDescending(e => e.RanAt).Take(20).ToListAsync(ct);
        return new AiQualityDto(start, end, total, Rate(answers.Count(a => a.Down), total), Rate(answers.Count(a => a.Reasked), total), Rate(answers.Sum(a => a.Dismissed), proposedAll),
            Rate(answers.Sum(a => a.Undone), Math.Max(1, answers.Sum(a => a.Confirmed))), Rate(answers.Count(a => a.ToolFailed), total), weeks, areas, reasons,
            evaluations.Select(ToDto).ToList(), limited);
    }

    /// <summary>Records a scenario grading for this workspace (from the grader, run by an owner or admin). Numbers only.</summary>
    public async Task<AiEvaluationDto> ReportAsync(ReportEvaluationRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        if (req.Total is < 1 or > 5000 || req.Passed < 0 || req.Passed > req.Total || req.Credits < 0) throw new ValidationException("total", "Give the number of scenarios run and how many passed.");
        var summary = new Dictionary<string, object?> { ["byArea"] = Shape(req.ByArea), ["byLang"] = Shape(req.ByLang) };
        var json = JsonSerializer.Serialize(summary, Json);
        if (json.Length > 8000) throw new ValidationException("byArea", "The summary is too large.");
        var run = new AiEvaluationRun
        {
            TenantId = ctx.RequireTenantId(), RanAt = req.RanAt is { } at && at <= clock.Now.AddMinutes(5) && at > clock.Now.AddDays(-30) ? at : clock.Now,
            Model = Clip(req.Model, 100), Mode = Clip(req.Mode, 16), Total = req.Total, Passed = req.Passed, Credits = req.Credits, SummaryJson = json, CreatedAt = clock.Now,
        };
        db.AiEvaluationRuns.Add(run);
        await db.SaveChangesAsync(ct);
        return ToDto(run);
    }

    /// <summary>Only {"name":{"pass":n,"total":n}} survives: no free text reaches the database from a report.</summary>
    private static Dictionary<string, object>? Shape(JsonElement? e)
    {
        if (e is not { ValueKind: JsonValueKind.Object } o) return null;
        var d = new Dictionary<string, object>();
        foreach (var p in o.EnumerateObject().Take(60))
        {
            if (p.Name.Length > 24 || !p.Name.All(c => char.IsLetterOrDigit(c) || c is '-' or '_')) continue;
            if (p.Value.ValueKind != JsonValueKind.Object) continue;
            var pass = p.Value.TryGetProperty("pass", out var a) && a.TryGetInt32(out var x) ? Math.Max(0, x) : 0;
            var tot = p.Value.TryGetProperty("total", out var b) && b.TryGetInt32(out var y) ? Math.Max(0, y) : 0;
            d[p.Name] = new { pass = Math.Min(pass, tot), total = tot };
        }
        return d;
    }

    private static AiEvaluationDto ToDto(AiEvaluationRun r)
    {
        using var doc = JsonDocument.Parse(string.IsNullOrEmpty(r.SummaryJson) ? "{}" : r.SummaryJson);
        return new(r.Id, r.RanAt, r.Model, r.Mode, r.Total, r.Passed, r.Total == 0 ? 0 : Math.Round((double)r.Passed / r.Total, 3), r.Credits, doc.RootElement.Clone());
    }

    private static List<T> Parse<T>(string? json)
    {
        if (string.IsNullOrEmpty(json)) return [];
        try { return JsonSerializer.Deserialize<List<T>>(json, Json) ?? []; }
        catch (JsonException) { return []; }
    }

    private static DateOnly WeekOf(DateTime at)
    {
        var d = DateOnly.FromDateTime(at);
        return d.AddDays(-(((int)d.DayOfWeek + 6) % 7));
    }

    private static string? Clip(string? s, int max) => s is null ? null : s.Length <= max ? s : s[..max];
}
