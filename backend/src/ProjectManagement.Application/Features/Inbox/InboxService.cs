using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Application.Features.Vault;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Inbox;

/// <summary>The one thing a row asks for. With an endpoint it is done in place (POST); otherwise it opens <see cref="InboxRowDto.Href"/>.</summary>
public record InboxActionDto(string Label, string Verb, string? Endpoint = null);

/// <summary>
/// One row of the Home inbox. Kind: ticket, task, decision, approval, access, review, mention or reminder. Group: assigned, decisions or
/// mentions (what the filter chips select). Id is stable across reads ("work:…", "finding:…") so "Later" can hide exactly this row.
/// </summary>
public record InboxRowDto(string Id, string Kind, string Group, string Title, string Sub, InboxActionDto Action, string? Href, DateTime At, bool Urgent);

public record InboxDto(IReadOnlyList<InboxRowDto> Rows, InboxCountsDto Counts, int Later);
public record InboxCountsDto(int All, int Assigned, int Decisions, int Mentions);

/// <summary>The briefing above the inbox: found by rules, worded plainly, no model call (so it works with AI off and costs no credits).</summary>
public record InboxBriefingDto(int Count, string Headline, IReadOnlyList<string> Reasons, string Sources, InboxStatsDto Stats);
public record InboxStatsDto(int Overdue, int DueToday, int Decisions, int Approvals, int Mentions, int Reminders);

/// <summary>
/// Home's inbox: everything that waits on the signed-in person, from the places it already lives - their late and due work and urgent tickets,
/// the project agent's proposals they may decide, timesheets and vault access to approve, documents to review, mentions and reminders that
/// went off, and what the other AI agents put here at "Ask first" (Settings › AI). Each source is read through the service that owns it, with
/// its own visibility rules; a source the person cannot use simply adds nothing. Nothing here changes data, except "Later", which hides a row
/// for this person until the next morning.
/// </summary>
public class InboxService(IAppDbContext db, ICurrentContext ctx, AppClock clock, WorkItemService work, AgentReviewService agent,
    TimesheetApprovalService timesheets, VaultService vault, DocumentInboxService documents, ReminderService reminders, AiAgentGate gate)
{
    public const int MaxRows = 60;

    public async Task<InboxDto> GetAsync(string? filter, CancellationToken ct = default)
    {
        var all = await CollectAsync(ct);
        var later = await LaterAsync(ct);
        var now = clock.Now;
        var visible = all.Where(r => !(later.TryGetValue(r.Id, out var until) && until > now)).ToList();
        var counts = new InboxCountsDto(visible.Count, visible.Count(r => r.Group == "assigned"), visible.Count(r => r.Group == "decisions"), visible.Count(r => r.Group == "mentions"));
        var group = (filter ?? "all").Trim().ToLowerInvariant();
        var rows = group is "assigned" or "decisions" or "mentions" ? visible.Where(r => r.Group == group).ToList() : visible;
        return new InboxDto(rows.Take(MaxRows).ToList(), counts, all.Count - visible.Count);
    }

    public async Task<InboxBriefingDto> BriefingAsync(CancellationToken ct = default)
    {
        var rows = (await GetAsync("all", ct)).Rows;
        var today = clock.Today;
        var stats = new InboxStatsDto(
            rows.Count(r => r.Kind is "task" or "ticket" && r.Sub.Contains("overdue", StringComparison.OrdinalIgnoreCase)),
            rows.Count(r => r.Kind is "task" or "ticket" && r.Sub.Contains("due today", StringComparison.OrdinalIgnoreCase)),
            rows.Count(r => r.Kind == "decision"), rows.Count(r => r.Kind is "approval" or "access" or "review"),
            rows.Count(r => r.Kind == "mention"), rows.Count(r => r.Kind == "reminder"));
        // The briefing names the first rows of the inbox itself (urgent first, as the inbox orders them), so the count in the headline and the
        // sentences below always describe the same things; whatever is not named is counted as "+N more below".
        const int Named = 3;
        var reasons = rows.Take(Named).Select(r => $"{r.Title} — {r.Sub}.").ToList();
        if (rows.Count > Named) reasons.Add($"+{rows.Count - Named} more below.");
        var headline = rows.Count switch { 0 => "You're all caught up.", 1 => "1 thing needs you.", var n => $"{n} things need you." };
        var sources = $"read your work, {(stats.Decisions > 0 ? "project agent, " : "")}approvals, mentions and reminders · {today:d MMM}";
        return new InboxBriefingDto(rows.Count, headline, reasons, sources, stats);
    }

    /// <summary>Hides one row until tomorrow morning (06:00 in the person's own time zone).</summary>
    public async Task LaterAsync(string id, CancellationToken ct = default)
    {
        id = (id ?? "").Trim();
        if (id.Length is < 3 or > 80 || !id.Contains(':')) throw new ValidationException("id", "Pick a row of the inbox.");
        var until = ZoneTime.ToUtc(ZoneTime.At(clock.Today.AddDays(1), new TimeOnly(6, 0)), clock.Zone);
        var map = await LaterAsync(ct);
        var now = clock.Now;
        foreach (var gone in map.Where(kv => kv.Value <= now).Select(kv => kv.Key).ToList()) map.Remove(gone);
        map[id] = until;
        while (map.Count > 200) map.Remove(map.OrderBy(kv => kv.Value).First().Key);
        var uid = ctx.RequireUserId();
        var key = LaterKey();
        var row = await db.UserUiPreferences.FirstOrDefaultAsync(p => p.UserId == uid && p.Key == key, ct);
        if (row is null) { row = new UserUiPreference { UserId = uid, Key = key }; db.UserUiPreferences.Add(row); }
        row.Value = JsonSerializer.Serialize(map); row.UpdatedAt = now;
        await db.SaveChangesAsync(ct);
    }

    // ------------------------------------------------------------------ sources

    private async Task<List<InboxRowDto>> CollectAsync(CancellationToken ct)
    {
        var rows = new List<InboxRowDto>();
        await Safe(() => WorkAsync(rows, ct));
        await Safe(() => DecisionsAsync(rows, ct));
        await Safe(() => AiAsksAsync(rows, ct));
        await Safe(() => TimesheetsAsync(rows, ct));
        await Safe(() => VaultAsync(rows, ct));
        await Safe(() => DocumentsAsync(rows, ct));
        await Safe(() => MentionsAsync(rows, ct));
        await Safe(() => RemindersAsync(rows, ct));
        // Urgent first (critical tickets, late work), then the rest newest first.
        return rows.GroupBy(r => r.Id).Select(g => g.First()).OrderByDescending(r => r.Urgent).ThenByDescending(r => r.At).ToList();
    }

    /// <summary>A source the person cannot use (a module switched off, nobody to review) adds nothing instead of failing the whole inbox.</summary>
    private static async Task Safe(Func<Task> read)
    {
        try { await read(); }
        catch (AppException) { }
    }

    private async Task WorkAsync(List<InboxRowDto> rows, CancellationToken ct)
    {
        var today = clock.Today;
        var mine = await work.ListAsync(new WorkItemQuery(Mine: true, OpenOnly: true, Limit: 200), ct: ct);
        foreach (var w in mine)
        {
            var late = w.DueDate is { } d && d < today;
            var dueToday = w.DueDate == today;
            var ticket = w.Kind == WorkItemKind.Operational;
            var urgentTicket = ticket && w.Priority is Priority.Critical or Priority.High;
            if (!late && !dueToday && !urgentTicket) continue;
            var when = late ? $"overdue since {w.DueDate:d MMM}" : dueToday ? "due today" : w.DueDate is { } due ? $"due {due:d MMM}" : "no due date";
            var parts = new List<string>();
            if (ticket || w.Priority >= Priority.High) parts.Add(w.Priority.ToString());
            if (w.ProjectKey is { Length: > 0 } pk) parts.Add(pk);
            parts.Add(when);
            rows.Add(new InboxRowDto($"work:{w.Id:N}", ticket ? "ticket" : "task", "assigned", $"{w.Key} {w.Title}", string.Join(" · ", parts),
                new InboxActionDto("Open", "open"), $"/work?item={w.Id}", w.UpdatedAt, late || (ticket && w.Priority == Priority.Critical)));
        }
    }

    private async Task DecisionsAsync(List<InboxRowDto> rows, CancellationToken ct)
    {
        var page = await agent.InboxAsync(ct);
        foreach (var f in page.Items.Take(20))
        {
            var sub = f.ProjectName is { Length: > 0 } ? $"Project agent · {f.ProjectName}" : "Project agent";
            rows.Add(new InboxRowDto($"finding:{f.Id:N}", "decision", "decisions", f.Title, sub,
                new InboxActionDto("Accept", "accept", $"/api/v1/agent/findings/{f.Id}/approve"), $"/work/projects/{f.ProjectId}?finding={f.Id}", f.CreatedAt, false));
        }
    }

    /// <summary>
    /// The other agents' "Ask first" work for this person: ticket triage, tasks from meeting minutes, tasks from mail, a drafted timesheet day.
    /// One action each (approve carries it out); a row whose agent was since turned down below Ask first is not shown.
    /// </summary>
    private async Task AiAsksAsync(List<InboxRowDto> rows, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var asks = await db.AiAgentActions.AsNoTracking().Where(a => a.ForUserId == me && (a.Status == "proposed" || a.Status == "failed"))
            .OrderByDescending(a => a.CreatedAt).Take(40).ToListAsync(ct);
        foreach (var a in asks)
        {
            if (await gate.LevelAsync(a.Agent, ct) < AiAgentLevel.AskFirst) continue;
            var timesheet = a.Agent == AiAgents.Timesheet;
            var sub = a.Status == "failed" && a.Error is { Length: > 0 } e ? $"{AiAgents.Name(a.Agent)} · could not be done: {Clip(e, 120)}" : AiAgents.Name(a.Agent);
            rows.Add(new InboxRowDto($"ai:{a.Id:N}", timesheet ? "approval" : "decision", "decisions", a.Title, sub,
                new InboxActionDto(timesheet ? "Approve" : "Accept", timesheet ? "approve" : "accept", $"/api/v1/ai/actions/{a.Id}/approve"), a.Link, a.CreatedAt, false));
        }
    }

    private async Task TimesheetsAsync(List<InboxRowDto> rows, CancellationToken ct)
    {
        var approvals = await timesheets.ApprovalsAsync(null, ct);
        foreach (var a in approvals.Pending.Where(a => a.Id is not null).Take(20))
            rows.Add(new InboxRowDto($"timesheet:{a.Id:N}", "approval", "decisions", $"{a.User.Name} · timesheet {a.WeekStart:d MMM}",
                $"{Hours(a.TotalMinutes)} logged", new InboxActionDto("Approve", "approve", $"/api/v1/time/approvals/{a.Id}/approve"),
                $"/insights?tab=time&review={a.User.Id}", a.WeekStart.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc), false));
    }

    private async Task VaultAsync(List<InboxRowDto> rows, CancellationToken ct)
    {
        var requests = await vault.RequestsAsync(ct);
        foreach (var r in requests.ToDecide.Take(20))
        {
            var what = r.ItemTitle ?? r.CollectionName;
            rows.Add(new InboxRowDto($"vault:{r.Id:N}", "access", "decisions", $"{r.Requester.Name} requests vault: {what}", r.Reason,
                new InboxActionDto("Approve", "approve", $"/api/v1/vault/requests/{r.Id}/approve"), $"/library/vault?request={r.Id}", r.CreatedAt, false));
        }
    }

    private async Task DocumentsAsync(List<InboxRowDto> rows, CancellationToken ct)
    {
        var inbox = await documents.GetAsync(ct);
        foreach (var r in inbox.ToReview.Take(20))
            rows.Add(new InboxRowDto($"review:{r.ApprovalId:N}", "review", "decisions", $"Review {r.Document.Title}",
                $"{r.Step} · from {r.SubmittedBy.Name}{(r.Overdue ? " · overdue" : "")}", new InboxActionDto("Review", "open"),
                $"/library/docs/{r.Document.Id}", r.SubmittedAt, r.Overdue));
        foreach (var a in inbox.AccessToDecide.Take(20))
            rows.Add(new InboxRowDto($"docaccess:{a.Id:N}", "access", "decisions", $"{a.Requester.Name} asks to open {a.DocumentTitle}", a.Reason,
                new InboxActionDto("Review", "open"), $"/library/docs/{a.DocumentId}", a.CreatedAt, false));
    }

    private async Task MentionsAsync(List<InboxRowDto> rows, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var since = clock.Now.AddDays(-14);
        var notes = await db.Notifications.AsNoTracking()
            .Where(n => n.UserId == me && n.Type == NotificationType.Mention && n.ReadAt == null && n.ArchivedAt == null && n.CreatedAt >= since)
            .OrderByDescending(n => n.CreatedAt).Take(20).ToListAsync(ct);
        foreach (var n in notes)
            rows.Add(new InboxRowDto($"mention:{n.Id:N}", "mention", "mentions", n.Title, n.Body is { Length: > 0 } b ? Clip(b, 140) : "Mention",
                new InboxActionDto("Reply", "open"), n.Link, n.CreatedAt, false));
    }

    private async Task RemindersAsync(List<InboxRowDto> rows, CancellationToken ct)
    {
        var list = await reminders.ListAsync(ct);
        foreach (var r in list.Open.Where(r => r.State == ReminderState.Fired && r.CompletedAt is null).Take(20))
        {
            // A reminder about a work item already in the inbox is folded into that item's row (one row per real thing), not shown twice.
            if (r.TargetKey is { Length: > 0 } tk)
            {
                var i = rows.FindIndex(x => x.Kind is "task" or "ticket" && x.Title.StartsWith(tk + " ", StringComparison.OrdinalIgnoreCase));
                if (i >= 0)
                {
                    var row = rows[i];
                    if (!row.Sub.Contains("reminder", StringComparison.OrdinalIgnoreCase)) rows[i] = row with { Sub = $"{row.Sub} · reminder" };
                    continue;
                }
            }
            var sub = r.TargetKey is { Length: > 0 } key ? $"{key}{(r.TargetTitle is { Length: > 0 } t ? " · " + t : "")}" : r.RecurrenceText ?? "Reminder";
            rows.Add(new InboxRowDto($"reminder:{r.Id:N}", "reminder", "assigned", r.Title, sub,
                new InboxActionDto("Done", "done", $"/api/v1/reminders/{r.Id}/done"), CurrentLink(r.Link), r.LastFiredAt ?? r.CreatedAt, false));
        }
    }

    // ------------------------------------------------------------------ "Later"

    private string LaterKey() => $"il:{ctx.RequireTenantId():N}";

    private async Task<Dictionary<string, DateTime>> LaterAsync(CancellationToken ct)
    {
        var uid = ctx.RequireUserId();
        var key = LaterKey();
        var value = await db.UserUiPreferences.AsNoTracking().Where(p => p.UserId == uid && p.Key == key).Select(p => p.Value).FirstOrDefaultAsync(ct);
        if (string.IsNullOrEmpty(value)) return [];
        try { return JsonSerializer.Deserialize<Dictionary<string, DateTime>>(value) ?? []; }
        catch (JsonException) { return []; }
    }

    /// <summary>Links saved before v2 point at retired pages (/operations?task=…, /tasks?task=…); open the item's panel in Work instead.</summary>
    internal static string? CurrentLink(string? link)
    {
        if (string.IsNullOrEmpty(link)) return link;
        foreach (var old in new[] { "/operations?task=", "/tasks?task=", "/operations?item=" })
        {
            var at = link.IndexOf(old, StringComparison.OrdinalIgnoreCase);
            if (at >= 0) return string.Concat(link.AsSpan(0, at), "/work?item=", link.AsSpan(at + old.Length));
        }
        return link;
    }

    private static string Hours(int minutes) => minutes % 60 == 0 ? $"{minutes / 60}h" : $"{minutes / 60}h {minutes % 60}m";
    private static string Clip(string s, int max) => s.Length <= max ? s : s[..(max - 1)] + "…";
}
