using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Calls;

public record CallsStatusDto(bool Available, int MaxParticipants);
public record StartCallRequest(string? Title, Guid? ProjectId, Guid? MeetingId, Guid? ConversationId, IReadOnlyList<Guid>? Invite, bool Agent = false, Guid? WorkspaceMeetingId = null);
public record CallPersonDto(Guid UserId, string Name, string Role, bool InCall, DateTime? JoinedAt);
public record CallDto(Guid Id, string Title, string Kind, Guid? ProjectId, string? ProjectKey, Guid? ConversationId, string Status, DateTime StartedAt, DateTime? EndedAt,
    Guid StartedBy, string StartedByName, bool AgentEnabled, string? AgentStatus, bool CanEnd, IReadOnlyList<CallPersonDto> People);
public record CallJoinDto(Guid CallId, string Url, string Token, string Room, string Identity, string Title, bool AgentEnabled, DateTime ExpiresAt);

/// <summary>
/// Our own video calls. Starting one opens a room on our media server and invites people (they get a notification with a Join link);
/// joining hands out a short-lived pass for that room only, to people allowed in: those invited, and - for a call in a project or a chat -
/// anyone who may open that project or is in that chat. The project agent can be asked along: our server lets it in itself (no one has to
/// admit it), it hears each person separately, and its notes, minutes and follow-ups arrive like those of any other meeting.
/// </summary>
public class CallService(IAppDbContext db, ICurrentContext ctx, AppClock clock, IOptions<CallsOptions> options, ILiveKitRooms rooms, ProjectAccess access,
    NotificationService notifications, Recorder recorder, AgentMeetingService agentMeetings, ILogger<CallService> log)
{
    private CallsOptions O => options.Value;
    public const int MaxInvite = 100, MaxLiveHours = 12;

    public CallsStatusDto Status() => new(O.Configured, O.MaxParticipants);

    private void RequireConfigured()
    {
        if (!O.Configured) throw new ConflictException("Video calls are not set up on this installation yet.", "CALLS_UNAVAILABLE");
    }

    public static string Identity(Guid userId) => $"user:{userId:N}";
    public static string AgentIdentity(Guid sessionId) => $"agent:{sessionId:N}";

    public Task<CallDto> StartAsync(StartCallRequest req, CancellationToken ct = default) => StartCoreAsync(req, null, ct);

    /// <summary>The meeting session a call is held for, so the notetaker files its notes under that meeting, in the mode the meeting chose.</summary>
    private sealed record MeetingSession(Guid MeetingId, DateTime Start, string? Mode);

    private async Task<CallDto> StartCoreAsync(StartCallRequest req, MeetingSession? session, CancellationToken ct)
    {
        RequireConfigured();
        var me = ctx.RequireUserId(); var tenant = ctx.RequireTenantId();
        if (ctx.Role == TenantRole.Guest && req.ProjectId is null && req.ConversationId is null) throw new ForbiddenException("Guests can join calls they are invited to.", "PERMISSION_DENIED");
        string kind = "adhoc"; string? title = string.IsNullOrWhiteSpace(req.Title) ? null : req.Title.Trim();
        Guid? projectId = null, meetingId = null, conversationId = null;
        if (req.MeetingId is { } mid)
        {
            var meeting = await db.ProjectMeetings.AsNoTracking().FirstOrDefaultAsync(m => m.Id == mid, ct) ?? throw new NotFoundException("Meeting not found.");
            meetingId = mid; projectId = meeting.ProjectId; title ??= meeting.Title;
        }
        if ((req.ProjectId ?? projectId) is { } pid)
        {
            var project = await access.VisibleProjects().AsNoTracking().Where(p => p.Id == pid).Select(p => new { p.Id, p.Name }).FirstOrDefaultAsync(ct) ?? throw new NotFoundException("Project not found.");
            projectId = project.Id; kind = "project"; title ??= $"{project.Name} call";
        }
        else if (req.ConversationId is { } cid)
        {
            if (!await db.ConversationMembers.AnyAsync(m => m.ConversationId == cid && m.UserId == me, ct)) throw new NotFoundException("Conversation not found.");
            conversationId = cid; kind = "chat";
            var conversation = await db.Conversations.AsNoTracking().Where(c => c.Id == cid).Select(c => new { c.Type, c.Name }).FirstAsync(ct);
            if (conversation.Type == ConversationType.Direct)
            {
                // One-to-one: the call is named after the two people in it.
                var names = await db.ConversationMembers.AsNoTracking().Where(m => m.ConversationId == cid).Select(m => m.User!.DisplayName).Take(2).ToListAsync(ct);
                title ??= names.Count == 2 ? $"{names[0]} and {names[1]}" : "Call";
            }
            else title ??= conversation.Name is { Length: > 0 } n ? $"{n} call" : "Group call";
        }
        title ??= "Call";
        if (title.Length > 200) title = title[..200];

        // Who is invited: the people named (members of this workspace only), plus everyone in the chat for a chat call. A project call with
        // nobody named (the assistant's "call the team") invites the project's people; an empty list from the start screen means nobody.
        var invite = (req.Invite ?? []).Distinct().Take(MaxInvite).ToList();
        if (req.Invite is null && kind == "project" && projectId is { } team)
            invite.AddRange(await db.ProjectMembers.AsNoTracking().Where(m => m.ProjectId == team).Select(m => m.UserId).Take(MaxInvite).ToListAsync(ct));
        if (conversationId is { } conv) invite.AddRange(await db.ConversationMembers.AsNoTracking().Where(m => m.ConversationId == conv).Select(m => m.UserId).Take(MaxInvite).ToListAsync(ct));
        invite = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tenant && invite.Contains(m.UserId) && m.User!.IsActive).Select(m => m.UserId).Distinct().ToListAsync(ct);
        invite.Remove(me);

        var now = clock.Now;
        var room = $"pt-{tenant.ToString("N")[..8]}-{Convert.ToHexString(RandomNumberGenerator.GetBytes(12)).ToLowerInvariant()}";
        try { await rooms.CreateAsync(room, O.MaxParticipants, 600, ct); }
        catch (HttpRequestException ex) { log.LogWarning(ex, "The media server did not open a room"); throw new AppException(502, "CALLS_SERVER_UNREACHABLE", "The call server could not be reached. Try again in a moment."); }

        var call = new CallRoom { TenantId = tenant, Title = title, RoomName = room, Kind = kind, ProjectId = projectId, MeetingId = meetingId, ConversationId = conversationId, WorkspaceMeetingId = req.WorkspaceMeetingId,
            StartedBy = me, StartedAt = now, Status = "live", CreatedAt = now };
        db.CallRooms.Add(call);
        db.CallParticipants.Add(new CallParticipant { TenantId = tenant, CallId = call.Id, UserId = me, Role = "host", CreatedAt = now });
        foreach (var u in invite) db.CallParticipants.Add(new CallParticipant { TenantId = tenant, CallId = call.Id, UserId = u, Role = "member", InvitedAt = now, CreatedAt = now });
        var starter = await db.Users.AsNoTracking().Where(u => u.Id == me).Select(u => u.DisplayName).FirstAsync(ct);
        foreach (var u in invite)
            await notifications.AddAsync(u, NotificationType.Meeting, $"{starter} is calling: {title}", "Tap to join the call.", $"/calls/{call.Id}", $"call:{call.Id:N}:{u:N}", ct: ct);
        recorder.Audit("call.started", "CallRoom", call.Id, new { kind, invited = invite.Count, agent = req.Agent });
        await db.SaveChangesAsync(ct);

        if (req.Agent)
        {
            if (projectId is not { } agentProject) throw new ValidationException("agent", "The project agent can join calls in a project. Start the call from the project.");
            try
            {
                var bot = await agentMeetings.JoinCallAsync(agentProject, call.Id, room, title, now.AddHours(MaxLiveHours), ct, session?.MeetingId, session?.Start, session?.Mode);
                call.AgentEnabled = true; call.AgentSessionId = bot.Id;
                await db.SaveChangesAsync(ct);
            }
            catch (AppException ex)
            {
                // The call goes ahead without the agent; the person is told why.
                log.LogInformation("The agent could not join call {Call}: {Reason}", call.Id, ex.Message);
                return (await GetAsync(call.Id, ct)) with { AgentStatus = ex.Message };
            }
        }
        return await GetAsync(call.Id, ct);
    }

    /// <summary>
    /// The call for a meeting held as a Project Tracker call (no Google Meet or Teams): whoever opens it first starts it - the meeting's people
    /// are invited, and in a project with its agent on, the agent comes along - and everyone after joins that same call.
    /// </summary>
    public async Task<CallDto> OpenMeetingAsync(Guid meetingId, bool workspaceMeeting, CancellationToken ct = default)
    {
        RequireConfigured();
        var me = ctx.RequireUserId();
        string title; List<Guid> invite; Guid? projectId = null; bool agent = false; MeetingSession? session = null;
        if (workspaceMeeting)
        {
            var m = await db.WorkspaceMeetings.AsNoTracking().FirstOrDefaultAsync(x => x.Id == meetingId, ct) ?? throw new NotFoundException("Meeting not found.");
            var people = await db.WorkspaceMeetingAttendees.AsNoTracking().Where(a => a.MeetingId == meetingId && a.RsvpStatus != AttendeeRsvpStatus.Declined).Select(a => a.UserId).ToListAsync(ct);
            if (!people.Contains(me) && ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new NotFoundException("Meeting not found.");
            if (m.Status == MeetingStatus.Cancelled) throw new ConflictException("This meeting was cancelled.", "MEETING_CANCELLED");
            if (m.Provider != MeetingProvider.ProjectTracker) throw new ConflictException("This meeting is held in another service. Use its own join link.", "MEETING_NOT_OURS");
            title = m.Title; invite = people;
        }
        else
        {
            var m = await db.ProjectMeetings.AsNoTracking().Include(x => x.Participants).FirstOrDefaultAsync(x => x.Id == meetingId, ct) ?? throw new NotFoundException("Meeting not found.");
            var invited = m.Participants.Any(p => p.UserId == me);
            if (!invited && !(ctx.Role != TenantRole.Guest && await access.VisibleProjects().AnyAsync(p => p.Id == m.ProjectId, ct))) throw new NotFoundException("Meeting not found.");
            if (m.Status == MeetingStatus.Cancelled) throw new ConflictException("This meeting was cancelled.", "MEETING_CANCELLED");
            if (m.Provider != MeetingProvider.ProjectTracker) throw new ConflictException("This meeting is held in another service. Use its own join link.", "MEETING_NOT_OURS");
            title = m.Title; projectId = m.ProjectId;
            invite = m.Participants.Where(p => p.UserId != null && p.RsvpStatus != AttendeeRsvpStatus.Declined).Select(p => p.UserId!.Value).ToList();
            // The notetaker comes when the meeting asked for it (or, for a meeting that made no choice, when the project's agent reads meetings);
            // "no notetaker" keeps it out.
            agent = m.Notetaker switch
            {
                MeetingNotetaker.Off => false,
                MeetingNotetaker.Transcript or MeetingNotetaker.TranscriptAndVoice => true,
                _ => await db.ProjectAgentSettings.AsNoTracking().AnyAsync(x => x.ProjectId == m.ProjectId && x.Enabled && x.ReadMeetings, ct),
            };
            var now = clock.Now;
            var start = ProjectManagement.Application.Features.ProjectMeetings.MeetingRecurrence.Occurrences(m.RecurrenceRule, m.StartTimeUtc, m.TimeZone, now.AddHours(-12), now.AddHours(12))
                .OrderBy(at => Math.Abs((at - now).TotalMinutes)).Cast<DateTime?>().FirstOrDefault() ?? now;
            session = new MeetingSession(m.Id, start, ProjectManagement.Application.Features.ProjectMeetings.MeetNotetaker.BotMode(m.Notetaker));
        }
        var live = await LiveForMeetingAsync(meetingId, workspaceMeeting, ct);
        if (live is not null) return await GetAsync(live.Id, ct);
        var started = await StartCoreAsync(new StartCallRequest(title, null, workspaceMeeting ? null : meetingId, null, invite, agent, workspaceMeeting ? meetingId : null), session, ct);
        // Two people opening it at the same moment: everyone ends up in the earliest call, the other one is closed again.
        var first = await LiveForMeetingAsync(meetingId, workspaceMeeting, ct);
        if (first is not null && first.Id != started.Id)
        {
            var mine = await db.CallRooms.FirstAsync(c => c.Id == started.Id, ct);
            try { await rooms.DeleteAsync(mine.RoomName, ct); } catch (HttpRequestException ex) { log.LogInformation(ex, "Could not close a duplicate meeting call"); }
            await MarkEndedAsync(mine, clock.Now, ct);
            await db.SaveChangesAsync(ct);
            return await GetAsync(first.Id, ct);
        }
        return started;
    }

    private Task<CallRoom?> LiveForMeetingAsync(Guid meetingId, bool workspaceMeeting, CancellationToken ct) =>
        db.CallRooms.AsNoTracking().Where(c => c.Status == "live" && (workspaceMeeting ? c.WorkspaceMeetingId == meetingId : c.MeetingId == meetingId))
            .OrderBy(c => c.StartedAt).ThenBy(c => c.Id).FirstOrDefaultAsync(ct);

    /// <summary>A call the person may see: one they are invited to or started, or one in a project or chat they belong to.</summary>
    private async Task<CallRoom> VisibleAsync(Guid id, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var call = await db.CallRooms.FirstOrDefaultAsync(c => c.Id == id, ct) ?? throw new NotFoundException("Call not found.");
        if (call.StartedBy == me || await db.CallParticipants.AnyAsync(p => p.CallId == id && p.UserId == me, ct)) return call;
        if (call.ProjectId is { } pid && ctx.Role != TenantRole.Guest && await access.VisibleProjects().AnyAsync(p => p.Id == pid, ct)) return call;
        if (call.ConversationId is { } cid && await db.ConversationMembers.AnyAsync(m => m.ConversationId == cid && m.UserId == me, ct)) return call;
        throw new NotFoundException("Call not found.");
    }

    public async Task<CallDto> GetAsync(Guid id, CancellationToken ct = default)
    {
        var call = await VisibleAsync(id, ct);
        var people = await db.CallParticipants.AsNoTracking().Where(p => p.CallId == id)
            .Join(db.Users.AsNoTracking(), p => p.UserId, u => u.Id, (p, u) => new { p.UserId, u.DisplayName, p.Role, p.JoinedAt, p.LeftAt }).ToListAsync(ct);
        var starter = await db.Users.AsNoTracking().Where(u => u.Id == call.StartedBy).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "Someone";
        var key = call.ProjectId is { } pid ? await db.Projects.AsNoTracking().Where(p => p.Id == pid).Select(p => p.Key).FirstOrDefaultAsync(ct) : null;
        string? agentStatus = null;
        if (call.AgentSessionId is { } sid)
            agentStatus = await db.AgentMeetingBots.AsNoTracking().Where(b => b.Id == sid).Select(b => b.WorkerStatus ?? b.Status).FirstOrDefaultAsync(ct);
        return new CallDto(call.Id, call.Title, call.Kind, call.ProjectId, key, call.ConversationId, call.Status, call.StartedAt, call.EndedAt, call.StartedBy, starter,
            call.AgentEnabled, agentStatus, await CanEndAsync(call, ct),
            people.OrderByDescending(p => p.Role == "host").ThenBy(p => p.DisplayName).Select(p => new CallPersonDto(p.UserId, p.DisplayName, p.Role, p.JoinedAt is not null && p.LeftAt is null, p.JoinedAt)).ToList());
    }

    private async Task<bool> CanEndAsync(CallRoom call, CancellationToken ct) =>
        call.Status == "live" && (call.StartedBy == ctx.UserId || ctx.Role is TenantRole.Owner or TenantRole.Admin
            || await db.CallParticipants.AnyAsync(p => p.CallId == call.Id && p.UserId == ctx.UserId && p.Role == "host", ct));

    /// <summary>A pass into the call's room for the signed-in person: their own name, their own identity, good for a few hours.</summary>
    public async Task<CallJoinDto> JoinAsync(Guid id, CancellationToken ct = default)
    {
        RequireConfigured();
        var call = await VisibleAsync(id, ct);
        if (call.Status != "live") throw new ConflictException("This call has ended.", "CALL_ENDED");
        var me = ctx.RequireUserId(); var now = clock.Now;
        var person = await db.Users.AsNoTracking().Where(u => u.Id == me).Select(u => new { u.DisplayName }).FirstAsync(ct);
        var row = await db.CallParticipants.FirstOrDefaultAsync(p => p.CallId == id && p.UserId == me, ct);
        if (row is null) db.CallParticipants.Add(row = new CallParticipant { TenantId = call.TenantId, CallId = id, UserId = me, Role = "member", CreatedAt = now });
        row.JoinedAt ??= now;
        await db.SaveChangesAsync(ct);
        var ttl = TimeSpan.FromHours(Math.Clamp(O.TokenHours, 1, 12));
        var metadata = JsonSerializer.Serialize(new { userId = me, role = row.Role });
        var token = LiveKitTokens.Mint(O.ApiKey!, O.ApiSecret!, Identity(me), person.DisplayName, new LiveKitGrant(Room: call.RoomName, RoomJoin: true), ttl, new DateTimeOffset(now, TimeSpan.Zero), metadata);
        return new CallJoinDto(call.Id, O.Url!, token, call.RoomName, Identity(me), call.Title, call.AgentEnabled, now.Add(ttl));
    }

    /// <summary>Ends the call for everyone (its host, whoever started it, or an owner/admin). The agent leaves with it and writes up its notes.</summary>
    public async Task<CallDto> EndAsync(Guid id, CancellationToken ct = default)
    {
        var call = await VisibleAsync(id, ct);
        if (call.Status != "live") return await GetAsync(id, ct);
        if (!await CanEndAsync(call, ct)) throw new ForbiddenException("Only the host can end the call for everyone. You can leave it.", "PERMISSION_DENIED");
        await rooms.DeleteAsync(call.RoomName, ct);
        await MarkEndedAsync(call, clock.Now, ct);
        recorder.Audit("call.ended", "CallRoom", call.Id, new { call.PeakParticipants });
        await db.SaveChangesAsync(ct);
        return await GetAsync(id, ct);
    }

    private async Task MarkEndedAsync(CallRoom call, DateTime now, CancellationToken ct)
    {
        call.Status = "ended"; call.EndedAt = now;
        foreach (var p in await db.CallParticipants.IgnoreQueryFilters().Where(p => p.CallId == call.Id && p.JoinedAt != null && p.LeftAt == null).ToListAsync(ct))
        { p.LeftAt = now; p.Seconds += (int)Math.Max(0, (now - p.JoinedAt!.Value).TotalSeconds); }
        // The agent's session ends with the call, so its notes are written up straight away.
        if (call.AgentSessionId is { } sid)
            await db.AgentMeetingBots.IgnoreQueryFilters().Where(b => b.Id == sid && (b.Status == "scheduled" || b.Status == "in_call"))
                .ExecuteUpdateAsync(u => u.SetProperty(b => b.SessionEndUtc, now).SetProperty(b => b.WorkerStatus, b => b.WorkerStatus == "done" || b.WorkerStatus == "fatal" ? b.WorkerStatus : "call_ended"), ct);
    }

    /// <summary>Live calls the person can join now: invited to, or in their projects and chats.</summary>
    public async Task<IReadOnlyList<CallDto>> LiveAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var since = clock.Now.AddHours(-MaxLiveHours);
        List<Guid> projectIds = ctx.Role == TenantRole.Guest ? [] : await access.VisibleProjects().Select(p => p.Id).ToListAsync(ct);
        var chats = await db.ConversationMembers.AsNoTracking().Where(m => m.UserId == me).Select(m => m.ConversationId).ToListAsync(ct);
        var ids = await db.CallRooms.AsNoTracking().Where(c => c.Status == "live" && c.StartedAt >= since
                && (c.StartedBy == me || db.CallParticipants.Any(p => p.CallId == c.Id && p.UserId == me)
                    || (c.ProjectId != null && projectIds.Contains(c.ProjectId.Value)) || (c.ConversationId != null && chats.Contains(c.ConversationId.Value))))
            .OrderByDescending(c => c.StartedAt).Select(c => c.Id).Take(20).ToListAsync(ct);
        var list = new List<CallDto>();
        foreach (var id in ids) list.Add(await GetAsync(id, ct));
        return list;
    }

    /// <summary>
    /// Events from the media server (signed with our secret): who joined and left, and when a room closed (everyone left, or it was ended).
    /// Unknown rooms and unsigned requests are ignored.
    /// </summary>
    public static async Task<bool> WebhookAsync(IServiceProvider sp, string? authorization, string body, CancellationToken ct)
    {
        var o = sp.GetRequiredService<IOptions<CallsOptions>>().Value;
        var clock = sp.GetRequiredService<AppClock>();
        if (!o.Configured || !LiveKitTokens.VerifyWebhook(o.ApiKey!, o.ApiSecret!, authorization, body, new DateTimeOffset(clock.Now, TimeSpan.Zero))) return false;
        using var doc = JsonDocument.Parse(body);
        var e = doc.RootElement;
        var name = e.TryGetProperty("event", out var ev) ? ev.GetString() : null;
        var roomName = e.TryGetProperty("room", out var r) && r.TryGetProperty("name", out var rn) ? rn.GetString() : null;
        if (name is null || string.IsNullOrEmpty(roomName)) return true;
        var db = sp.GetRequiredService<IAppDbContext>();
        var call = await db.CallRooms.IgnoreQueryFilters().FirstOrDefaultAsync(c => c.RoomName == roomName, ct);
        if (call is null) return true;
        var now = clock.Now;
        var identity = e.TryGetProperty("participant", out var p) && p.TryGetProperty("identity", out var id) ? id.GetString() : null;
        Guid? userId = identity is { Length: 37 } && identity.StartsWith("user:", StringComparison.Ordinal) && Guid.TryParseExact(identity[5..], "N", out var g) ? g : null;
        switch (name)
        {
            case "participant_joined" when userId is { } uid:
            {
                var row = await db.CallParticipants.IgnoreQueryFilters().FirstOrDefaultAsync(x => x.CallId == call.Id && x.UserId == uid, ct);
                if (row is null) db.CallParticipants.Add(row = new CallParticipant { TenantId = call.TenantId, CallId = call.Id, UserId = uid, CreatedAt = now });
                row.JoinedAt = now; row.LeftAt = null;
                var inCall = await db.CallParticipants.IgnoreQueryFilters().CountAsync(x => x.CallId == call.Id && x.JoinedAt != null && x.LeftAt == null && x.UserId != uid, ct) + 1;
                call.PeakParticipants = Math.Max(call.PeakParticipants, inCall);
                break;
            }
            case "participant_left" when userId is { } uid:
            {
                var row = await db.CallParticipants.IgnoreQueryFilters().FirstOrDefaultAsync(x => x.CallId == call.Id && x.UserId == uid, ct);
                if (row?.JoinedAt is { } joined && row.LeftAt is null) { row.LeftAt = now; row.Seconds += (int)Math.Max(0, (now - joined).TotalSeconds); }
                break;
            }
            case "room_finished" when call.Status == "live":
            {
                call.Status = "ended"; call.EndedAt = now;
                foreach (var x in await db.CallParticipants.IgnoreQueryFilters().Where(x => x.CallId == call.Id && x.JoinedAt != null && x.LeftAt == null).ToListAsync(ct))
                { x.LeftAt = now; x.Seconds += (int)Math.Max(0, (now - x.JoinedAt!.Value).TotalSeconds); }
                if (call.AgentSessionId is { } sid)
                    await db.AgentMeetingBots.IgnoreQueryFilters().Where(b => b.Id == sid && (b.Status == "scheduled" || b.Status == "in_call"))
                        .ExecuteUpdateAsync(u => u.SetProperty(b => b.SessionEndUtc, now).SetProperty(b => b.WorkerStatus, b => b.WorkerStatus == "done" || b.WorkerStatus == "fatal" ? b.WorkerStatus : "call_ended"), ct);
                break;
            }
        }
        await db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>Calls still marked live long after anyone could be in them (a missed webhook): ended. Returns how many.</summary>
    private static long _lastSweep;

    public static async Task<int> SweepAsync(IServiceProvider sp, CancellationToken ct)
    {
        var db = sp.GetRequiredService<IAppDbContext>();
        var now = sp.GetRequiredService<AppClock>().Now;
        if (now.Ticks - Interlocked.Read(ref _lastSweep) < TimeSpan.FromMinutes(10).Ticks) return 0;
        Interlocked.Exchange(ref _lastSweep, now.Ticks);
        var stale = await db.CallRooms.IgnoreQueryFilters().Where(c => c.Status == "live" && c.StartedAt < now.AddHours(-MaxLiveHours)).Take(200).ToListAsync(ct);
        foreach (var c in stale) { c.Status = "ended"; c.EndedAt = now; }
        if (stale.Count > 0) await db.SaveChangesAsync(ct);
        return stale.Count;
    }
}
