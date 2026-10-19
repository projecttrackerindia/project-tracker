using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Agent;

/// <summary>
/// The agent answering in the meeting chat. Someone addresses it ("agent, where is PAY-12?", "@bot what's overdue?") and it answers from the
/// tracker: status, owner and date of a task, what is late, due today or this week, what is blocked - by key and first name only, because
/// people from outside the company may be in the call. Rules over the tracker, so the answer is instant, exact and costs no credits; anything
/// it cannot answer it says so and leaves for the team (the question is in the transcript the agent reads afterwards). At autonomy level 3
/// and up, or when it attends for someone. Messages for the person it attends for are passed on to them.
/// </summary>
public class AgentChatAnswerService(IAppDbContext db, AppClock clock, MeetingBotQueue queue)
{
    private const int MaxAnswersPerSession = 30;
    private static readonly Regex Addressing = new(@"^\s*(@\s*)?(agent|bot|assistant|project ?ai|tracker)\b|^\s*[/?]", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public static bool AddressedTo(string text, string botName) =>
        Addressing.IsMatch(text) || botName.Length >= 3 && text.Contains(botName, StringComparison.OrdinalIgnoreCase);

    /// <summary>Handles one chat message from the meeting. Returns the answer queued for the chat, or null when the agent stays quiet.</summary>
    public async Task<string?> HandleAsync(Guid botRowId, string speaker, string text, CancellationToken ct)
    {
        var bot = await db.AgentMeetingBots.FirstOrDefaultAsync(b => b.Id == botRowId, ct);
        if (bot is null || bot.Status != "in_call" && bot.Status != "scheduled") return null;
        var s = await db.ProjectAgentSettings.AsNoTracking().FirstOrDefaultAsync(x => x.ProjectId == bot.ProjectId, ct);
        if (s is not { Enabled: true }) return null;
        var w = await db.AgentWorkspaceSettings.AsNoTracking().FirstOrDefaultAsync(ct);
        var botName = w?.BotName ?? "Project Tracker Agent";
        var delegations = await db.AgentDelegations.Where(d => d.MeetingId == bot.MeetingId && d.SessionStartUtc == bot.SessionStartUtc && d.Status != "cancelled").ToListAsync(ct);
        var delegatorIds = delegations.Select(d => d.UserId).ToList();
        var delegators = await db.Users.AsNoTracking().Where(u => delegatorIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => AgentSessions.FirstName(u.DisplayName), ct);

        // A message for someone the agent attends for: kept for their report.
        var forWhom = delegations.FirstOrDefault(d => delegators.TryGetValue(d.UserId, out var first) && first.Length >= 2
            && Regex.IsMatch(text, $@"(^|[\s@,]){Regex.Escape(first)}\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant));
        if (forWhom is not null && !AddressedTo(text, botName))
        {
            var line = AgentAnalysisService.Cut($"{speaker}: {text}", 240)!;
            forWhom.Note = AgentAnalysisService.Cut(string.IsNullOrEmpty(forWhom.Note) ? line : forWhom.Note + "\n" + line, 500);
            forWhom.UpdatedAt = clock.Now;
            await db.SaveChangesAsync(ct);
            return await SayAsync(bot, $"Noted - I'll pass that to {delegators[forWhom.UserId]}.", ct);
        }
        if (!AddressedTo(text, botName)) return null;
        if (!AgentAutonomy.Answers(s) && delegations.Count == 0) return null;
        if (bot.NudgeCount >= MaxAnswersPerSession + 8) return null;

        var project = await db.Projects.AsNoTracking().FirstAsync(p => p.Id == bot.ProjectId, ct);
        var zone = await db.Tenants.AsNoTracking().Where(t => t.Id == project.TenantId).Select(t => t.TimeZone).FirstOrDefaultAsync(ct);
        var today = clock.TodayIn(zone);
        var lower = text.ToLowerInvariant();
        var answer = await AnswerAsync(project, text, lower, today, ct);
        return await SayAsync(bot, answer, ct);
    }

    private async Task<string?> SayAsync(AgentMeetingBot bot, string answer, CancellationToken ct)
    {
        var said = $"🤖 {answer}";
        if (!await queue.QueueChatAsync(bot.Id, said, ct)) return null;
        await db.AgentMeetingBots.Where(b => b.Id == bot.Id).ExecuteUpdateAsync(u => u.SetProperty(b => b.NudgeCount, b => b.NudgeCount + 1), ct);
        return said;
    }

    private async Task<string> AnswerAsync(Project project, string text, string lower, DateOnly today, CancellationToken ct)
    {
        string K(int n) => $"{project.Key}-{n}";
        var open = db.Tasks.AsNoTracking().Where(t => t.ProjectId == project.Id && t.ParentTaskId == null
            && t.Status!.Category != StatusCategory.Done && t.Status.Category != StatusCategory.Cancelled);

        var numbers = Regex.Matches(text, $@"\b{Regex.Escape(project.Key)}-(\d{{1,6}})\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
            .Select(m => int.Parse(m.Groups[1].Value)).Distinct().Take(3).ToList();
        if (numbers.Count > 0)
        {
            var rows = await db.Tasks.AsNoTracking().Where(t => t.ProjectId == project.Id && numbers.Contains(t.Number))
                .Select(t => new { t.Id, t.Number, t.DueDate, Status = t.Status!.Name, Cat = t.Status.Category, Owner = t.Assignee != null ? t.Assignee.DisplayName : null })
                .ToListAsync(ct);
            if (rows.Count == 0) return $"I can't find {string.Join(", ", numbers.Select(K))} in {project.Key}.";
            var ids = rows.Select(r => r.Id).ToList();
            var waits = await db.TaskDependencies.AsNoTracking().Where(d => ids.Contains(d.TaskId)
                    && d.DependsOnTask!.Status!.Category != StatusCategory.Done && d.DependsOnTask.Status.Category != StatusCategory.Cancelled)
                .Select(d => new { d.TaskId, d.DependsOnTask!.Number }).ToListAsync(ct);
            return string.Join(" | ", rows.OrderBy(r => r.Number).Select(r =>
            {
                var closed = r.Cat is StatusCategory.Done or StatusCategory.Cancelled;
                var parts = new List<string> { $"{K(r.Number)}: {r.Status}", r.Owner is null ? "no owner" : AgentSessions.FirstName(r.Owner) };
                if (!closed) parts.Add(When(r.DueDate, today));
                var on = waits.Where(x => x.TaskId == r.Id).Select(x => K(x.Number)).ToList();
                if (!closed && on.Count > 0) parts.Add($"waits on {string.Join(", ", on.Take(3))}");
                return string.Join(", ", parts);
            }));
        }
        if (Regex.IsMatch(lower, @"\b(overdue|late|behind|slipping)\b"))
        {
            var late = await open.Where(t => t.DueDate != null && t.DueDate < today).OrderBy(t => t.DueDate).Take(6)
                .Select(t => new { t.Number, t.DueDate, Owner = t.Assignee != null ? t.Assignee.DisplayName : null }).ToListAsync(ct);
            return late.Count == 0 ? "Nothing is overdue right now."
                : "Overdue: " + string.Join(", ", late.Select(t => $"{K(t.Number)} ({AgentSessions.FirstName(t.Owner)}, {today.DayNumber - t.DueDate!.Value.DayNumber}d)")) + ".";
        }
        if (Regex.IsMatch(lower, @"\bblock(ed|er|ers|ing)?\b|\bstuck\b|\bwaiting\b"))
        {
            var stuck = await db.TaskDependencies.AsNoTracking().Where(d => d.Task!.ProjectId == project.Id
                    && d.Task.Status!.Category != StatusCategory.Done && d.Task.Status.Category != StatusCategory.Cancelled
                    && d.DependsOnTask!.Status!.Category != StatusCategory.Done && d.DependsOnTask.Status.Category != StatusCategory.Cancelled)
                .Select(d => new { Waiting = d.Task!.Number, On = d.DependsOnTask!.Number }).Take(8).ToListAsync(ct);
            return stuck.Count == 0 ? "Nothing is waiting on unfinished work."
                : "Waiting: " + string.Join(", ", stuck.Select(x => $"{K(x.Waiting)} on {K(x.On)}")) + ".";
        }
        if (Regex.IsMatch(lower, @"\b(this week|week)\b"))
        {
            var soon = await open.Where(t => t.DueDate != null && t.DueDate >= today && t.DueDate <= today.AddDays(7)).OrderBy(t => t.DueDate).Take(8)
                .Select(t => new { t.Number, t.DueDate, Owner = t.Assignee != null ? t.Assignee.DisplayName : null }).ToListAsync(ct);
            return soon.Count == 0 ? "Nothing is due in the next 7 days."
                : "Due this week: " + string.Join(", ", soon.Select(t => $"{K(t.Number)} ({AgentSessions.FirstName(t.Owner)}, {t.DueDate:ddd})")) + ".";
        }
        if (Regex.IsMatch(lower, @"\b(today|due)\b"))
        {
            var due = await open.Where(t => t.DueDate == today).Take(8).Select(t => new { t.Number, Owner = t.Assignee != null ? t.Assignee.DisplayName : null }).ToListAsync(ct);
            return due.Count == 0 ? "Nothing is due today." : "Due today: " + string.Join(", ", due.Select(t => $"{K(t.Number)} ({AgentSessions.FirstName(t.Owner)})")) + ".";
        }
        return $"I can answer from the tracker: a task's status, owner and date (\"agent, {project.Key}-12?\"), what is overdue, due today or this week, and what is blocked. " +
               "Anything else I'll leave for the team - it's in my notes.";
    }

    private static string When(DateOnly? due, DateOnly today) => due switch
    {
        null => "no due date",
        { } d when d == today => "due today",
        { } d when d < today => $"{today.DayNumber - d.DayNumber}d late (was due {d:d MMM})",
        { } d => $"due {d:d MMM} (in {d.DayNumber - today.DayNumber}d)",
    };
}
