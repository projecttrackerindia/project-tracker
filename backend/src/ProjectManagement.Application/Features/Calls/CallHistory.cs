using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Calls;

/// <summary>One of my past (or live) calls, as Meetings › Past lists it: who was in it, how long it ran, whether I missed it, whether it has notes.</summary>
public record CallHistoryDto(Guid Id, string Title, string Kind, Guid? ProjectId, string? ProjectKey, Guid? ConversationId, string Status, DateTime StartedAt, DateTime? EndedAt,
    int Minutes, bool Missed, bool StartedByMe, string StartedByName, IReadOnlyList<string> People, bool HasNotes);
/// <summary>One line of a call's transcript: who spoke and what they said.</summary>
public record CallLineDto(string Speaker, string Text);
/// <summary>What the notetaker kept of a call: the summary and action items of its minutes, and the transcript while it is still kept.</summary>
public record CallNotesDto(Guid CallId, string Status, string? Summary, IReadOnlyList<MinutesActionItem> Actions, IReadOnlyList<string> Decisions,
    IReadOnlyList<CallLineDto> Transcript, Guid? SessionId);

/// <summary>
/// The call log behind Meetings: ad-hoc, chat and project calls I started, was invited to or joined, newest first, with missed calls marked;
/// and a call's notes (the agent's minutes and transcript) for anyone who may see the call. Read-only, scoped to the workspace.
/// </summary>
public class CallHistoryService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ProjectAccess access, ISecretProtector secrets)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public const int MaxDays = 90, MaxCalls = 200;

    public async Task<IReadOnlyList<CallHistoryDto>> HistoryAsync(int days, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var since = clock.Now.AddDays(-Math.Clamp(days, 1, MaxDays));
        var calls = await db.CallRooms.AsNoTracking()
            .Where(c => c.StartedAt >= since && (c.StartedBy == me || db.CallParticipants.Any(p => p.CallId == c.Id && p.UserId == me)))
            .OrderByDescending(c => c.StartedAt).Take(MaxCalls).ToListAsync(ct);
        if (calls.Count == 0) return [];
        var ids = calls.Select(c => c.Id).ToList();
        var people = await db.CallParticipants.AsNoTracking().Where(p => ids.Contains(p.CallId))
            .Join(db.Users.AsNoTracking(), p => p.UserId, u => u.Id, (p, u) => new { p.CallId, p.UserId, u.DisplayName, p.InvitedAt, p.JoinedAt })
            .ToListAsync(ct);
        var starters = calls.Select(c => c.StartedBy).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => starters.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var projectIds = calls.Where(c => c.ProjectId != null).Select(c => c.ProjectId!.Value).Distinct().ToList();
        var keys = await db.Projects.AsNoTracking().Where(p => projectIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => p.Key, ct);
        var sessions = calls.Where(c => c.AgentSessionId != null).Select(c => c.AgentSessionId!.Value).ToList();
        var withMinutes = (await db.MeetingMinutes.AsNoTracking().Where(m => sessions.Contains(m.BotRowId)).Select(m => m.BotRowId).ToListAsync(ct)).ToHashSet();
        var withWords = (await db.AgentMeetingBots.AsNoTracking().Where(b => sessions.Contains(b.Id) && b.TranscriptLength > 0).Select(b => b.Id).ToListAsync(ct)).ToHashSet();
        var now = clock.Now;
        return calls.Select(c =>
        {
            var mine = people.FirstOrDefault(p => p.CallId == c.Id && p.UserId == me);
            var missed = c.StartedBy != me && c.Status != "live" && mine is { InvitedAt: not null, JoinedAt: null };
            var who = people.Where(p => p.CallId == c.Id && (p.JoinedAt != null || p.UserId == c.StartedBy)).Select(p => p.DisplayName).ToList();
            var starter = names.GetValueOrDefault(c.StartedBy) ?? "Someone";
            if (!who.Contains(starter)) who.Insert(0, starter);
            var minutes = (int)Math.Round(((c.EndedAt ?? now) - c.StartedAt).TotalMinutes);
            var notes = c.AgentSessionId is { } sid && (withMinutes.Contains(sid) || withWords.Contains(sid));
            return new CallHistoryDto(c.Id, c.Title, c.Kind, c.ProjectId, c.ProjectId is { } pid ? keys.GetValueOrDefault(pid) : null, c.ConversationId, c.Status, c.StartedAt, c.EndedAt,
                Math.Max(0, minutes), missed, c.StartedBy == me, starter, who.Distinct().Take(12).ToList(), notes);
        }).ToList();
    }

    public async Task<CallNotesDto> NotesAsync(Guid id, CancellationToken ct = default)
    {
        var call = await VisibleAsync(id, ct);
        if (call.AgentSessionId is not { } sid) return new CallNotesDto(call.Id, "none", null, [], [], [], null);
        var bot = await db.AgentMeetingBots.AsNoTracking().FirstOrDefaultAsync(b => b.Id == sid, ct);
        if (bot is null) return new CallNotesDto(call.Id, "none", null, [], [], [], null);
        var lines = new List<CallLineDto>();
        if (bot.TranscriptProtected is { Length: > 0 } words)
        {
            string text;
            try { text = secrets.Unprotect(words); } catch (System.Security.Cryptography.CryptographicException) { text = ""; }
            foreach (var raw in text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Take(2000))
            {
                var at = raw.IndexOf(':');
                lines.Add(at > 0 && at < 60 ? new CallLineDto(raw[..at].Trim(), raw[(at + 1)..].Trim()) : new CallLineDto("", raw));
            }
        }
        var row = await db.MeetingMinutes.AsNoTracking().FirstOrDefaultAsync(m => m.BotRowId == sid, ct);
        MinutesContent? content = null;
        if (row is not null)
        {
            try { content = JsonSerializer.Deserialize<MinutesContent>(secrets.Unprotect(row.ContentProtected), Json); }
            catch (Exception e) when (e is JsonException or System.Security.Cryptography.CryptographicException) { content = null; }
        }
        var status = content is not null ? "ready" : bot.Status is "done" or "failed" ? (lines.Count > 0 ? "transcript" : "none") : "writing";
        return new CallNotesDto(call.Id, status, content?.Summary, content?.ActionItems ?? [], content?.Decisions ?? [], lines, sid);
    }

    /// <summary>The same rule as CallService: the person started it or was in it, or it belongs to a project they can open or a chat they are in.</summary>
    private async Task<CallRoom> VisibleAsync(Guid id, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var call = await db.CallRooms.AsNoTracking().FirstOrDefaultAsync(c => c.Id == id, ct) ?? throw new NotFoundException("Call not found.");
        if (call.StartedBy == me || await db.CallParticipants.AnyAsync(p => p.CallId == id && p.UserId == me, ct)) return call;
        if (call.ProjectId is { } pid && ctx.Role != TenantRole.Guest && await access.VisibleProjects().AnyAsync(p => p.Id == pid, ct)) return call;
        if (call.ConversationId is { } cid && await db.ConversationMembers.AnyAsync(m => m.ConversationId == cid && m.UserId == me, ct)) return call;
        throw new NotFoundException("Call not found.");
    }
}
