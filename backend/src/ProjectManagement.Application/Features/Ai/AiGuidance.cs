using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Ai;

public record AiStarterDto(string Label, string Prompt, string? Hint);
public record AiStartersDto(string Greeting, IReadOnlyList<AiStarterDto> Starters);
public record AiProfileDto(int DetailLevel, string DetailLabel, string? Notes, IReadOnlyList<string> Learned, DateTime? LearnedAt);
public record AiFeedbackRequest(string Rating, string? Reason);
public record SetAiProfileRequest(string? Notes);

/// <summary>
/// How the assistant gets to know the person it works with, without spending a token on it: starter questions built from their live work,
/// their thumbs up or down on answers, and a short profile (the answer length they prefer, what they asked it to keep in mind, which kinds of
/// suggestions they keep declining). The profile is plain facts the person can read, edit and erase; it only ever shapes the assistant's tone
/// and what it offers, never what it is allowed to see.
/// </summary>
public class AiGuidance(IAppDbContext db, ICurrentContext ctx, AppClock clock, WorkItemService workItems)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly HashSet<string> Reasons = ["too_long", "too_short", "wrong", "off_topic"];
    private static readonly string[] Labels = ["Much shorter", "Shorter", "Normal length", "More detailed", "Much more detailed"];

    private sealed class Counters
    {
        public int Up { get; set; }
        public int Down { get; set; }
        public Dictionary<string, KindCount> Kinds { get; set; } = [];
    }
    private sealed class KindCount { public int Done { get; set; } public int Dismissed { get; set; } }

    private static Counters ReadCounters(AiUserProfile? p) =>
        string.IsNullOrEmpty(p?.CountersJson) ? new() : JsonSerializer.Deserialize<Counters>(p.CountersJson, Json) ?? new();

    private async Task<AiUserProfile> ProfileRowAsync(CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var row = await db.AiUserProfiles.FirstOrDefaultAsync(p => p.UserId == me, ct);
        if (row is null) { row = new AiUserProfile { UserId = me }; db.AiUserProfiles.Add(row); }
        return row;
    }

    /// <summary>Things the person has taught the assistant, as short sentences. Kept stable between answers so the provider's cache is not broken.</summary>
    private static List<string> Lines(AiUserProfile? p)
    {
        var lines = new List<string>();
        if (p is null) return lines;
        if (p.DetailLevel <= -1) lines.Add("They prefer short answers: lead with the answer and keep detail to what matters.");
        if (p.DetailLevel >= 1) lines.Add("They prefer thorough answers: include the evidence and the reasoning.");
        if (!string.IsNullOrWhiteSpace(p.Notes)) lines.Add("In their own words: " + p.Notes.Trim());
        foreach (var (kind, c) in ReadCounters(p).Kinds.OrderBy(k => k.Key))
            if (c.Dismissed >= 3 && c.Done == 0) lines.Add($"They have turned down {c.Dismissed} suggested '{Kind(kind)}' proposals and accepted none: only propose one when they ask.");
        return lines;
    }

    private static string Kind(string kind) => kind switch
    {
        "send_report" => "report",
        "create_task" or "create_work" => "new work",
        "create_action_item" => "action item",
        "create_reminder" or "reminder" => "reminder",
        _ => kind.Replace('_', ' '),
    };

    /// <summary>The lines given to the model about this person.</summary>
    public async Task<IReadOnlyList<string>> ForModelAsync(CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        return Lines(await db.AiUserProfiles.AsNoTracking().FirstOrDefaultAsync(p => p.UserId == me, ct));
    }

    // ------------------------------------------------------------------ profile

    public async Task<AiProfileDto> ProfileAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var p = await db.AiUserProfiles.AsNoTracking().FirstOrDefaultAsync(x => x.UserId == me, ct);
        return new AiProfileDto(p?.DetailLevel ?? 0, Labels[(p?.DetailLevel ?? 0) + 2], p?.Notes, Lines(p), p?.LearnedAt);
    }

    public async Task<AiProfileDto> SetNotesAsync(string? notes, CancellationToken ct = default)
    {
        notes = string.IsNullOrWhiteSpace(notes) ? null : notes.Trim();
        if (notes is { Length: > 500 }) throw new ValidationException("notes", "Keep it under 500 characters.");
        var row = await ProfileRowAsync(ct);
        row.Notes = notes;
        await db.SaveChangesAsync(ct);
        return await ProfileAsync(ct);
    }

    public async Task<AiProfileDto> ResetAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var row = await db.AiUserProfiles.FirstOrDefaultAsync(p => p.UserId == me, ct);
        if (row is not null) { db.AiUserProfiles.Remove(row); await db.SaveChangesAsync(ct); }
        return await ProfileAsync(ct);
    }

    // ------------------------------------------------------------------ learning

    public async Task FeedbackAsync(Guid messageId, string rating, string? reason, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        if (rating is not ("up" or "down" or "none")) throw new ValidationException("rating", "Rating must be up or down.");
        if (reason is not null && !Reasons.Contains(reason)) throw new ValidationException("reason", "Unknown reason.");
        var msg = await db.AiMessages.FirstOrDefaultAsync(m => m.Id == messageId && m.UserId == me && m.Role == "assistant", ct) ?? throw new NotFoundException("Answer not found.");
        var row = await ProfileRowAsync(ct);
        var counters = ReadCounters(row);

        // Taking back an earlier verdict first, so changing your mind does not count twice.
        if (msg.Feedback == "up") counters.Up = Math.Max(0, counters.Up - 1);
        if (msg.Feedback == "down") counters.Down = Math.Max(0, counters.Down - 1);
        if (msg.FeedbackReason == "too_long") row.DetailLevel = Math.Min(2, row.DetailLevel + 1);
        if (msg.FeedbackReason == "too_short") row.DetailLevel = Math.Max(-2, row.DetailLevel - 1);

        msg.Feedback = rating == "none" ? null : rating;
        msg.FeedbackReason = rating == "down" ? reason : null;
        if (rating == "up") counters.Up++;
        if (rating == "down") counters.Down++;
        if (msg.FeedbackReason == "too_long") row.DetailLevel = Math.Max(-2, row.DetailLevel - 1);
        if (msg.FeedbackReason == "too_short") row.DetailLevel = Math.Min(2, row.DetailLevel + 1);
        row.CountersJson = JsonSerializer.Serialize(counters, Json);
        row.LearnedAt = clock.Now;
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Called when the person confirms or dismisses something the assistant proposed.</summary>
    public async Task SuggestionOutcomeAsync(string kind, bool accepted, CancellationToken ct = default)
    {
        var row = await ProfileRowAsync(ct);
        var counters = ReadCounters(row);
        if (!counters.Kinds.TryGetValue(kind, out var c)) counters.Kinds[kind] = c = new KindCount();
        if (accepted) c.Done++; else c.Dismissed++;
        row.CountersJson = JsonSerializer.Serialize(counters, Json);
        row.LearnedAt = clock.Now;
        await db.SaveChangesAsync(ct);
    }

    // ------------------------------------------------------------------ starters (no model involved)

    public async Task<AiStartersDto> StartersAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var name = await db.Users.AsNoTracking().Where(u => u.Id == me).Select(u => u.DisplayName).FirstAsync(ct);
        var first = name.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? name;
        var hour = clock.Now.Hour;
        var greeting = $"{(hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening")}, {first}";
        var list = new List<AiStarterDto>();

        var counts = (await workItems.CountsAsync([me], WorkItemScope.Caller, ct)).GetValueOrDefault(me);
        if (counts is { Overdue: > 0 }) list.Add(new("What should I do first?", "Which of my overdue and due-soon items should I do first, and why?", $"{counts.Overdue} overdue"));
        else if (counts is { DueThisWeek: > 0 }) list.Add(new("Plan my week", "Help me plan my week around what is due.", $"{counts.DueThisWeek} due this week"));

        var last = await db.AiConversations.AsNoTracking().Where(c => c.UserId == me && !c.IsDeleted).OrderByDescending(c => c.LastMessageAt).Select(c => new { c.Title }).FirstOrDefaultAsync(ct);
        if (last is not null && last.Title != "New conversation") list.Add(new("Pick up where we left off", $"Continue from our last conversation: {last.Title}", last.Title));

        if (ctx.Role is not (TenantRole.Guest or TenantRole.Member))
            list.Add(new("Who is overloaded?", "Who on the team has too much on their plate, and who has room?", "Team workload"));
        list.Add(new("Brief me", "Give me a short briefing on my projects: what is on track and what is at risk.", "Across your projects"));
        list.Add(new("Draft a status report", "Write a status report I can send to my stakeholders this week.", "Ready to send"));
        return new AiStartersDto(greeting, list.Take(4).ToList());
    }
}
