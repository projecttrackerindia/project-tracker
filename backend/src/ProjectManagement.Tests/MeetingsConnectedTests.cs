using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.ProjectMeetings;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Meetings connected everywhere and action items as work: recurring meetings expanded on the server (and changed one session, this and
/// following, or all), free/busy, the post-meeting "Log 45m?" prompt that only logs on a tap, one-line capture into work items with the
/// meeting as their source, and the review of a series' action items (decisions, undo, minutes) - with who may do what.
/// </summary>
[Collection("api")]
public class MeetingsConnectedTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n?.GetValue<string>() ?? "";
    private static string Q(DateTimeOffset d) => Uri.EscapeDataString(d.ToString("o"));

    private async Task<(TestClient Owner, TestClient Mate, Guid Project)> TeamAsync(string name)
    {
        var owner = await TestClient.RegisterAsync(factory, "Asha Rao");
        await owner.CreateOrgAsync(); await owner.UpgradeAsync("PRO");
        var project = await owner.CreateProjectAsync(name);
        var mate = await owner.AddMemberAsync(factory, TenantRole.Member, "Ravi Menon");
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = mate.UserId })).Ok);
        return (owner, mate, project);
    }

    /// <summary>A weekly series (our own call) from a week day at 06:00 UTC, invited: the mate.</summary>
    private static async Task<Guid> WeeklyAsync(TestClient owner, Guid project, DateTimeOffset start, int sessions = 6, string title = "Bank sandbox sync")
    {
        var made = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", new { title, startTime = start, endTime = start.AddMinutes(45), timeZone = "UTC",
            repeat = new { frequency = "Weekly", occurrences = sessions }, video = "inapp", description = "1. Sandbox date\n2. Review action items since last" });
        Assert.Equal(HttpStatusCode.Created, made.Status);
        return Guid.Parse(S(made.Data!["id"]));
    }

    private static DateTimeOffset NextWeekAt(int hourUtc) =>
        new(DateTime.UtcNow.Date.AddDays(7).AddHours(hourUtc), TimeSpan.Zero);

    // ------------------------------------------------------------------ recurrence on the server

    [Fact]
    public void Rules_cover_monthly_custom_days_and_an_end_date()
    {
        var start = DateTimeOffset.Parse("2030-01-07T09:00:00Z");   // a Monday
        Assert.Equal("RRULE:FREQ=MONTHLY;COUNT=3", MeetingRecurrence.Rule(new("Monthly", 3), start, "UTC"));
        Assert.Equal("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=4", MeetingRecurrence.Rule(new("Custom", 4, null, 2, ["mon", "WE"]), start, "UTC"));
        var until = MeetingRecurrence.Rule(new("Weekly", 0, new DateOnly(2030, 1, 28)), start, "UTC")!;
        Assert.Equal("RRULE:FREQ=WEEKLY;UNTIL=20300128T235959Z", until);
        var all = DateTime.SpecifyKind(DateTime.MinValue, DateTimeKind.Utc); var end = DateTime.SpecifyKind(new DateTime(2031, 1, 1), DateTimeKind.Utc);
        Assert.Equal(4, MeetingRecurrence.Occurrences(until, start.UtcDateTime, "UTC", all, end).Count());                       // 7, 14, 21, 28 Jan
        var custom = MeetingRecurrence.Occurrences("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=4", start.UtcDateTime, "UTC", all, end).Select(d => d.Day).ToList();
        Assert.Equal(new[] { 7, 9, 21, 23 }, custom);
        Assert.Equal(new[] { 7, 7, 7 }, MeetingRecurrence.Occurrences("RRULE:FREQ=MONTHLY;COUNT=3", start.UtcDateTime, "UTC", all, end).Select(d => d.Day).ToList());
        Assert.Equal("Weekly", MeetingRecurrence.Cadence("RRULE:FREQ=WEEKLY;COUNT=4"));
        Assert.Equal("Daily", MeetingRecurrence.Cadence("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10"));
        Assert.Equal("Monthly", MeetingRecurrence.Cadence("RRULE:FREQ=MONTHLY;COUNT=3"));
        Assert.Equal("Ad hoc", MeetingRecurrence.Cadence(null));
        Assert.Equal("Every Mon · until 28 Jan", MeetingRecurrence.Describe(until, start.UtcDateTime, "UTC"));
        // The start must be one of the chosen days, and a monthly series cannot start on a day some months lack.
        Assert.Throws<ProjectManagement.Application.Exceptions.ValidationException>(() => MeetingRecurrence.Rule(new("Custom", 4, null, 1, ["TU"]), start, "UTC"));
        Assert.Throws<ProjectManagement.Application.Exceptions.ValidationException>(() => MeetingRecurrence.Rule(new("Monthly", 4), DateTimeOffset.Parse("2030-01-30T09:00:00Z"), "UTC"));
        Assert.Throws<ProjectManagement.Application.Exceptions.ValidationException>(() => MeetingRecurrence.Rule(new("Weekly", 0), start, "UTC"));
    }

    [Fact]
    public async Task A_recurring_meeting_is_expanded_and_one_session_or_the_following_ones_can_change()
    {
        var (owner, mate, project) = await TeamAsync("UPI AutoPay");
        var start = NextWeekAt(6);
        var id = await WeeklyAsync(owner, project, start);
        var sessions = await mate.Get($"/api/v1/meet/p/{id}/sessions?from={Q(start.AddHours(-1))}&to={Q(start.AddDays(60))}");
        Assert.True(sessions.Ok, sessions.ToString());
        Assert.Equal("Weekly", S(sessions.Data!["cadence"]));
        Assert.Equal(6, sessions.Data["sessions"]!.AsArray().Count);

        // This occurrence: the second session moves an hour later; the others stay. Only the organizer (or an editor) may.
        var second = start.AddDays(7);
        Assert.Equal(HttpStatusCode.Forbidden, (await mate.Post($"/api/v1/meet/p/{id}/occurrence", new { occurrenceStart = second, scope = "this", startTime = second.AddHours(1), endTime = second.AddHours(1).AddMinutes(45) })).Status);
        var moved = await owner.Post($"/api/v1/meet/p/{id}/occurrence", new { occurrenceStart = second, scope = "this", startTime = second.AddHours(1), endTime = second.AddHours(1).AddMinutes(45) });
        Assert.True(moved.Ok, moved.ToString());
        var after = (await mate.Get($"/api/v1/meet/p/{id}/sessions?from={Q(start.AddHours(-1))}&to={Q(start.AddDays(60))}")).Data!["sessions"]!.AsArray();
        Assert.Equal(6, after.Count);
        Assert.Equal(second.AddHours(1), DateTimeOffset.Parse(S(after[1]!["start"])));
        Assert.True(after[1]!["changed"]!.GetValue<bool>());
        // Meet and the Calendar show the moved session too.
        var feed = (await mate.Get($"/api/v1/meet?from={Q(start.AddHours(-1))}&to={Q(start.AddDays(60))}")).Data!["items"]!.AsArray().Where(i => S(i!["id"]) == id.ToString()).ToList();
        Assert.Equal(6, feed.Count);
        Assert.Contains(feed, i => DateTimeOffset.Parse(S(i!["start"])) == second.AddHours(1));
        Assert.Equal("Weekly", S(feed[0]!["cadence"]));

        // Cancel one: it is gone everywhere.
        var third = start.AddDays(14);
        Assert.True((await owner.Post($"/api/v1/meet/p/{id}/occurrence", new { occurrenceStart = third, scope = "this", cancel = true })).Ok);
        Assert.Equal(5, (await mate.Get($"/api/v1/meet/p/{id}/sessions?from={Q(start.AddHours(-1))}&to={Q(start.AddDays(60))}")).Data!["sessions"]!.AsArray().Count);

        // This and following: from the fourth session it moves to 08:00; the first series ends before it and a new one carries on (same series).
        var fourth = start.AddDays(21);
        var split = await owner.Post($"/api/v1/meet/p/{id}/occurrence", new { occurrenceStart = fourth, scope = "following", startTime = fourth.AddHours(2), endTime = fourth.AddHours(2).AddMinutes(45) });
        Assert.True(split.Ok, split.ToString());
        var newRef = S(split.Data!["newSeriesRef"]);
        Assert.StartsWith("p:", newRef);
        Assert.Equal(2, (await mate.Get($"/api/v1/meet/p/{id}/sessions?from={Q(start.AddHours(-1))}&to={Q(start.AddDays(60))}")).Data!["sessions"]!.AsArray().Count);   // 1st and moved 2nd
        var rest = await mate.Get($"/api/v1/meet/{newRef.Replace(":", "/")}/sessions?from={Q(start.AddHours(-1))}&to={Q(start.AddDays(60))}");
        Assert.Equal(3, rest.Data!["sessions"]!.AsArray().Count);   // 4th, 5th, 6th at the new time
        Assert.Equal(fourth.AddHours(2), DateTimeOffset.Parse(S(rest.Data["sessions"]![0]!["start"])));
        Assert.Equal($"p:{id}", S(rest.Data["seriesRef"]));

        // Not one of its sessions: refused.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"/api/v1/meet/p/{id}/occurrence", new { occurrenceStart = start.AddDays(3), scope = "this", cancel = true })).Status);
    }

    [Fact]
    public async Task Teams_are_invited_as_their_members_and_free_busy_shows_only_times()
    {
        var (owner, mate, project) = await TeamAsync("Card Vault");
        var team = Guid.NewGuid();
        factory.WithDb(db =>
        {
            db.Teams.Add(new Team { Id = team, TenantId = owner.WorkspaceId, Name = "AutoPay", CreatedAt = DateTime.UtcNow });
            db.TeamMembers.Add(new TeamMember { TenantId = owner.WorkspaceId, TeamId = team, UserId = mate.UserId, CreatedAt = DateTime.UtcNow });
            return db.SaveChanges();
        });
        var start = NextWeekAt(9);
        var made = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", new { title = "Vault stand-up", startTime = start, endTime = start.AddMinutes(30), timeZone = "UTC",
            participantUserIds = Array.Empty<Guid>(), teamIds = new[] { team }, video = "zoho", videoUrl = "https://meeting.zoho.in/join/abc" });
        Assert.Equal(HttpStatusCode.Created, made.Status);
        var id = Guid.Parse(S(made.Data!["id"]));
        Assert.Contains(made.Data["participants"]!.AsArray(), p => S(p!["userId"]) == mate.UserId.ToString());
        var item = (await mate.Get("/api/v1/meet")).Data!["items"]!.AsArray().Single(i => S(i!["id"]) == id.ToString())!;
        Assert.Equal("https://meeting.zoho.in/join/abc", S(item["joinUrl"]));
        Assert.Equal("zoho", S(item["video"]));
        // Zoho without a link cannot be scheduled.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"/api/v1/projects/{project}/meetings/schedule", new { title = "x", startTime = start, endTime = start.AddMinutes(30), timeZone = "UTC", video = "zoho" })).Status);

        var busy = await owner.Get($"/api/v1/meet/free-busy?userIds={mate.UserId},{owner.UserId}&from={Q(start.AddHours(-2))}&to={Q(start.AddHours(4))}&slotStart={Q(start.AddMinutes(10))}&slotEnd={Q(start.AddMinutes(40))}");
        Assert.True(busy.Ok, busy.ToString());
        Assert.False(busy.Data!["everyoneFree"]!.GetValue<bool>());
        var ravi = busy.Data["people"]!.AsArray().Single(p => S(p!["userId"]) == mate.UserId.ToString())!;
        Assert.False(ravi["freeAtSlot"]!.GetValue<bool>());
        Assert.Single(ravi["busy"]!.AsArray());
        Assert.DoesNotContain("Vault", busy.Json!.ToJsonString());   // times only, never what the meeting is
        var later = await owner.Get($"/api/v1/meet/free-busy?teamIds={team}&from={Q(start.AddHours(-2))}&to={Q(start.AddHours(4))}&slotStart={Q(start.AddHours(2))}&slotEnd={Q(start.AddHours(3))}");
        Assert.True(later.Data!["everyoneFree"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Get($"/api/v1/meet/free-busy?from={Q(start)}&to={Q(start.AddDays(20))}")).Status);
    }

    // ------------------------------------------------------------------ time: proposed after a session, logged only on a tap

    /// <summary>A one-off meeting of the project that happened yesterday 10:00–10:45 in the workspace's day (India), for both of them.</summary>
    private Guid PastMeeting(TestClient owner, TestClient mate, Guid project, string title)
    {
        var yesterday = AppDay.Today.AddDays(-1);
        var startUtc = DateTime.SpecifyKind(yesterday.ToDateTime(new TimeOnly(10, 0)).AddMinutes(-AppDay.OffsetMinutes), DateTimeKind.Utc);
        var id = Guid.NewGuid();
        factory.WithDb(db =>
        {
            var m = new ProjectMeeting { Id = id, TenantId = owner.WorkspaceId, ProjectId = project, OrganizerUserId = owner.UserId, Title = title, StartTimeUtc = startUtc, EndTimeUtc = startUtc.AddMinutes(45),
                TimeZone = "Asia/Kolkata", Provider = MeetingProvider.ProjectTracker, GoogleCalendarEventId = $"pt-{id:N}", Status = MeetingStatus.Scheduled, CreatedAt = DateTime.UtcNow };
            db.ProjectMeetings.Add(m);
            db.MeetingParticipants.Add(new MeetingParticipant { TenantId = owner.WorkspaceId, ProjectId = project, MeetingId = id, UserId = owner.UserId, Email = owner.Email, Role = MeetingParticipantRole.Organizer, RsvpStatus = AttendeeRsvpStatus.Accepted, CreatedAt = DateTime.UtcNow });
            db.MeetingParticipants.Add(new MeetingParticipant { TenantId = owner.WorkspaceId, ProjectId = project, MeetingId = id, UserId = mate.UserId, Email = mate.Email, CreatedAt = DateTime.UtcNow });
            return db.SaveChanges();
        });
        return id;
    }

    [Fact]
    public async Task When_a_session_ends_its_time_is_proposed_and_only_logged_when_confirmed()
    {
        var (owner, mate, project) = await TeamAsync("Merchant Portal");
        var id = PastMeeting(owner, mate, project, "Settlement sync");

        var proposals = await mate.Get("/api/v1/meet/time-proposals");
        Assert.True(proposals.Ok, proposals.ToString());
        var p = Assert.Single(proposals.Data!.AsArray())!;
        Assert.Equal(45, p["minutes"]!.GetValue<int>());
        Assert.Equal("Merchant Portal", S(p["projectName"]));
        Assert.Equal($"p:{id}", S(p["meetingRef"]));
        // Nothing is logged by itself, and the bell says it once.
        Assert.False(factory.WithDb(db => db.TimeEntries.IgnoreQueryFilters().Any(e => e.UserId == mate.UserId)));
        Assert.Single((await mate.Get("/api/v1/meet/time-proposals")).Data!.AsArray());
        Assert.Single(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == mate.UserId && n.Title.StartsWith("Log 45m")).ToList()));

        // Somebody else's prompt is not theirs to log.
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Post($"/api/v1/meet/time-proposals/{S(p["id"])}/log", new { })).Status);

        // Log, as 40 minutes: one entry on the project, placed where the session was, kind "meeting".
        var logged = await mate.Post($"/api/v1/meet/time-proposals/{S(p["id"])}/log", new { minutes = 40, note = "Sandbox date agreed" });
        Assert.True(logged.Ok, logged.ToString());
        Assert.Equal("meeting", S(logged.Data!["kind"]));
        Assert.Equal(40, logged.Data["minutes"]!.GetValue<int>());
        Assert.Equal("Settlement sync", S(logged.Data["taskTitle"]));
        var entry = factory.WithDb(db => db.TimeEntries.IgnoreQueryFilters().Single(e => e.UserId == mate.UserId));
        Assert.Equal(project, entry.ProjectId);
        Assert.Null(entry.TaskId); Assert.Null(entry.WorkTaskId);
        Assert.Equal($"p:{id}", entry.MeetingRef);
        Assert.Equal(40, (int)(entry.EndedAt!.Value - entry.StartedAt!.Value).TotalMinutes);
        Assert.Empty((await mate.Get("/api/v1/meet/time-proposals")).Data!.AsArray());
        Assert.Equal("TIME_PROPOSAL_DECIDED", (await mate.Post($"/api/v1/meet/time-proposals/{S(p["id"])}/log", new { })).ErrorCode);
        // It is on their timesheet, and the overlap rules see it like any placed entry.
        var sheet = await mate.Get($"/api/v1/time?from={AppDay.Today.AddDays(-2):yyyy-MM-dd}&to={AppDay.Today:yyyy-MM-dd}");
        Assert.Contains(sheet.Data!["entries"]!.AsArray(), e => S(e!["kind"]) == "meeting");

        // The organizer: Later hides it for now, Didn't attend for good.
        var mine = Assert.Single((await owner.Get("/api/v1/meet/time-proposals")).Data!.AsArray())!;
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Post($"/api/v1/meet/time-proposals/{S(mine["id"])}/later")).Status);
        Assert.Empty((await owner.Get("/api/v1/meet/time-proposals")).Data!.AsArray());
        factory.WithDb(db => { db.MeetingTimeProposals.IgnoreQueryFilters().Single(x => x.UserId == owner.UserId).SnoozedUntil = DateTime.UtcNow.AddMinutes(-1); return db.SaveChanges(); });
        Assert.Single((await owner.Get("/api/v1/meet/time-proposals")).Data!.AsArray());
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Post($"/api/v1/meet/time-proposals/{S(mine["id"])}/dismiss", new { reason = "didnt_attend" })).Status);
        Assert.Empty((await owner.Get("/api/v1/meet/time-proposals")).Data!.AsArray());
        Assert.False(factory.WithDb(db => db.TimeEntries.IgnoreQueryFilters().Any(e => e.UserId == owner.UserId)));
    }

    // ------------------------------------------------------------------ action items are work items with a source meeting

    [Fact]
    public void The_capture_line_reads_owner_and_date_words()
    {
        var monday = new DateOnly(2026, 11, 2);
        var r = QuickLine.Parse("Confirm bank sandbox date @Ravi fri", monday);
        Assert.Equal("Confirm bank sandbox date", r.Title);
        Assert.Equal("Ravi", r.OwnerToken);
        Assert.Equal(new DateOnly(2026, 11, 6), r.Due);
        Assert.Equal(new DateOnly(2026, 11, 7), QuickLine.Parse("Book PCI assessor call @mira 7 nov", monday).Due);
        Assert.Equal(new DateOnly(2026, 11, 9), QuickLine.Parse("Draft comms due mon", monday).Due);   // "mon" on a Monday is next Monday
        Assert.Equal("Draft comms", QuickLine.Parse("Draft comms due mon", monday).Title);
        Assert.Equal(new DateOnly(2026, 11, 5), QuickLine.Parse("Deploy +3d @kiran", monday).Due);
        Assert.Equal(new DateOnly(2026, 11, 3), QuickLine.Parse("Ping NPCI tomorrow", monday).Due);
        Assert.Null(QuickLine.Parse("Review the monitoring dashboard", monday).Due);   // "monitoring" is not "mon"
        var people = new[] { (Guid.NewGuid(), "Ravi Menon"), (Guid.NewGuid(), "Mira Okafor"), (Guid.NewGuid(), "Ravi Shah") };
        Assert.Null(QuickLine.ResolveOwner("ravi", people, out var ambiguous));
        Assert.True(ambiguous);
        Assert.Equal(people[0].Item1, QuickLine.ResolveOwner("ravim", people, out _));
        Assert.Equal(people[1].Item1, QuickLine.ResolveOwner("@Mira", people, out _));
    }

    [Fact]
    public async Task A_line_typed_in_a_meeting_becomes_a_work_item_from_that_meeting()
    {
        var (owner, mate, project) = await TeamAsync("Retry Rules");
        var id = await WeeklyAsync(owner, project, NextWeekAt(5), title: "AutoPay weekly");
        var preview = await owner.Post($"/api/v1/meet/p/{id}/capture/preview", new { text = "Confirm bank sandbox date @ravi fri" });
        Assert.True(preview.Ok, preview.ToString());
        Assert.Equal("Ravi Menon", S(preview.Data!["owner"]!["name"]));
        Assert.Equal("Confirm bank sandbox date", S(preview.Data["title"]));

        var made = await owner.Post($"/api/v1/meet/p/{id}/capture", new { text = "Confirm bank sandbox date @ravi fri" });
        Assert.Equal(HttpStatusCode.Created, made.Status);
        var itemId = Guid.Parse(S(made.Data!["item"]!["id"]));
        Assert.Equal(mate.UserId.ToString(), S(made.Data["item"]!["assignee"]!["id"]));
        Assert.Equal($"p:{id}", S(made.Data["seriesRef"]));
        var row = factory.WithDb(db => db.WorkTasks.IgnoreQueryFilters().Single(w => w.Id == itemId));
        Assert.Equal(WorkTaskKind.ActionItem, row.Kind);
        Assert.Equal($"p:{id}", row.SourceMeetingRef);
        Assert.Equal("AutoPay weekly", row.SourceMeetingTitle);
        Assert.Equal(DayOfWeek.Friday, row.DueDate!.Value.DayOfWeek);
        Assert.NotNull(row.SourceOccurrenceStartUtc);

        // An "@" that is nobody here, or more than one person: refused, never guessed.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"/api/v1/meet/p/{id}/capture", new { text = "Do it @zed" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"/api/v1/meet/p/{id}/capture", new { text = "@ravi fri" })).Status);   // nothing to do

        // In My Work it carries its source; "From meetings" narrows to such items; the item opens with it too.
        var mine = await mate.Get("/api/v1/work-items?mine=true&fromMeetings=true");
        var listed = Assert.Single(mine.Data!["items"]!.AsArray())!;
        Assert.Equal("AutoPay weekly", S(listed["source"]!["title"]));
        Assert.Equal($"p:{id}", S(listed["source"]!["seriesRef"]));
        Assert.Equal("AutoPay weekly", S((await mate.Get($"/api/v1/work-items/{itemId}")).Data!["source"]!["title"]));
        // The old action-item endpoints read the same row.
        Assert.Contains((await owner.Get($"/api/v1/projects/{project}/action-items")).Data!.AsArray(), a => S(a!["id"]) == itemId.ToString());
        // The meeting lists what was made in it.
        var items = await owner.Get($"/api/v1/meet/p/{id}/items");
        Assert.Single(items.Data!["createdHere"]!.AsArray());
        Assert.Equal(1, items.Data["openInSeries"]!.GetValue<int>());

        // Someone who cannot see the project (a guest not on it) cannot capture into its meeting.
        var outsider = await owner.AddMemberAsync(factory, TenantRole.Guest, "Nisha Hegde");
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Post($"/api/v1/meet/p/{id}/capture", new { text = "Sneak in @ravi" })).Status);
    }

    [Fact]
    public async Task Action_items_added_before_meetings_had_sources_still_work_and_show_under_other()
    {
        var (owner, mate, project) = await TeamAsync("Legacy");
        // A project action item as the old screen made it: the same work-item row, with no source meeting.
        var old = await owner.Post($"/api/v1/projects/{project}/action-items", new { title = "Collect the signed SOW", assigneeId = mate.UserId, dueDate = AppDay.Today.AddDays(2) });
        Assert.Equal(HttpStatusCode.Created, old.Status);
        var oldId = S(old.Data!["id"]);
        Assert.Null(factory.WithDb(db => db.WorkTasks.IgnoreQueryFilters().Single(w => w.Id == Guid.Parse(oldId)).SourceMeetingRef));
        Assert.Empty((await mate.Get("/api/v1/work-items?mine=true&fromMeetings=true")).Data!["items"]!.AsArray());
        Assert.Single((await mate.Get("/api/v1/work-items?mine=true&kind=action")).Data!["items"]!.AsArray());
        // In the all-projects review it is listed, with no source (the screen puts it under "Other").
        var all = await owner.Post("/api/v1/meet/review", new { scope = "all" });
        Assert.True(all.Ok, all.ToString());
        var row = all.Data!["items"]!.AsArray().Single(i => S(i!["id"]) == oldId)!;
        Assert.Null(row["sourceTitle"]);
        // The old status endpoint still changes it.
        Assert.True((await owner.Put($"/api/v1/projects/{project}/action-items/{oldId}/status", new { status = "Completed" })).Ok);
    }

    // ------------------------------------------------------------------ review over work items

    [Fact]
    public async Task A_series_review_decides_each_item_with_reasons_undo_and_minutes()
    {
        var (owner, mate, project) = await TeamAsync("UPI Review");
        var mira = await owner.AddMemberAsync(factory, TenantRole.Member, "Mira Okafor");
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = mira.UserId })).Ok);
        var start = NextWeekAt(6);
        var id = await WeeklyAsync(owner, project, start, title: "AutoPay weekly review");
        async Task<Guid> Capture(string line) => Guid.Parse(S((await owner.Post($"/api/v1/meet/p/{id}/capture", new { text = line })).Data!["item"]!["id"]));
        var sandbox = await Capture("Get bank sandbox date @ravi tomorrow");
        var fraud = await Capture("Draft fraud rule thresholds @ravi +2d");
        var tokens = await Capture("Share tokenisation results @mira tomorrow");
        var sms = await Capture("Weekly SMS report @mira +3d");
        var load = await Capture("Load test mandate API @ravi +4d");

        var open = await owner.Post("/api/v1/meet/review", new { scope = "series", seriesRef = $"p:{id}" });
        Assert.True(open.Ok, open.ToString());
        var session = S(open.Data!["sessionId"]);
        Assert.Equal(5, open.Data["counts"]!["total"]!.GetValue<int>());
        Assert.Equal(0, open.Data["counts"]!["reviewed"]!.GetValue<int>());
        Assert.Equal("Weekly", S(open.Data["cadence"]));
        Assert.Equal(start.AddDays(7), DateTimeOffset.Parse(S(open.Data["nextSession"])));
        async Task<ApiResult> Decide(object body) => await owner.Post($"/api/v1/meet/review/{session}/decide", body);

        // Done.
        Assert.True((await Decide(new { workItemId = tokens, decision = "done" })).Ok);
        Assert.Equal(WorkTaskStatus.Completed, factory.WithDb(db => db.WorkTasks.IgnoreQueryFilters().Single(w => w.Id == tokens).Status));
        // Carry: due moves to the next session's day, recorded as "carried".
        var carried = await Decide(new { workItemId = fraud, decision = "carry" });
        Assert.True(carried.Ok, carried.ToString());
        Assert.Equal(DateOnly.FromDateTime(start.AddDays(7).UtcDateTime), factory.WithDb(db => db.WorkTasks.IgnoreQueryFilters().Single(w => w.Id == fraud).DueDate));
        Assert.True(factory.WithDb(db => db.Activities.IgnoreQueryFilters().Any(a => a.EntityId == fraud && a.Action == "actionitem.carried")));
        // Re-plan needs a reason; with one, the owner changes and the new owner is told.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Decide(new { workItemId = sandbox, decision = "replan", ownerId = mira.UserId })).Status);
        var replanned = await Decide(new { workItemId = sandbox, decision = "replan", ownerId = mira.UserId, dueDate = AppDay.Today.AddDays(5), reason = "Mira owns the NPCI relationship now" });
        Assert.True(replanned.Ok, replanned.ToString());
        Assert.Equal(mira.UserId, factory.WithDb(db => db.WorkTasks.IgnoreQueryFilters().Single(w => w.Id == sandbox).AssigneeId));
        Assert.Contains(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == mira.UserId).Select(n => n.Title).ToList()), t => t.Contains("Get bank sandbox date"));
        // Drop needs a reason; it is cancelled, not deleted.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Decide(new { workItemId = sms, decision = "drop" })).Status);
        Assert.True((await Decide(new { workItemId = sms, decision = "drop", reason = "Replaced by dashboard" })).Ok);
        Assert.Equal(WorkTaskStatus.Cancelled, factory.WithDb(db => db.WorkTasks.IgnoreQueryFilters().Single(w => w.Id == sms).Status));
        // Convert: a project task keeping the meeting as its source; the action item is closed.
        var converted = await Decide(new { workItemId = load, decision = "convert" });
        Assert.True(converted.Ok, converted.ToString());
        var task = factory.WithDb(db => db.Tasks.IgnoreQueryFilters().Single(t => t.ProjectId == project && t.Title == "Load test mandate API"));
        Assert.Equal($"p:{id}", task.SourceSeriesRef);
        Assert.Equal(WorkTaskStatus.Completed, factory.WithDb(db => db.WorkTasks.IgnoreQueryFilters().Single(w => w.Id == load).Status));
        Assert.Equal(5, converted.Data!["counts"]!["reviewed"]!.GetValue<int>());

        // Undo the last one: the task goes, the action item is open again.
        var undone = await owner.Post($"/api/v1/meet/review/{session}/undo", new { });
        Assert.True(undone.Ok, undone.ToString());
        Assert.Equal(WorkTaskStatus.ToDo, factory.WithDb(db => db.WorkTasks.IgnoreQueryFilters().Single(w => w.Id == load).Status));
        Assert.True(factory.WithDb(db => db.Tasks.IgnoreQueryFilters().Single(t => t.Id == task.Id).IsDeleted));
        Assert.Equal(4, undone.Data!["counts"]!["reviewed"]!.GetValue<int>());

        // Minutes from the decisions, then sent to the attendees; after that the review is closed.
        var minutes = await owner.Post($"/api/v1/meet/review/{session}/finish");
        Assert.True(minutes.Ok, minutes.ToString());
        Assert.Equal(1, minutes.Data!["done"]!.GetValue<int>());
        Assert.Equal(1, minutes.Data["carried"]!.GetValue<int>());
        Assert.Equal(1, minutes.Data["replanned"]!.GetValue<int>());
        Assert.Equal(1, minutes.Data["dropped"]!.GetValue<int>());
        Assert.Contains("Replaced by dashboard", S(minutes.Data["text"]));
        Assert.Contains(minutes.Data["lines"]!.AsArray(), l => S(l!["group"]) == "replanned" && S(l["text"]).Contains("Ravi → Mira"));
        var sent = await owner.Post($"/api/v1/meet/review/{session}/send", new { text = S(minutes.Data["text"]) + "\nNext: sandbox." });
        Assert.True(sent.Ok, sent.ToString());
        Assert.Contains(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == mate.UserId).Select(n => n.Title).ToList()), t => t.StartsWith("Minutes: AutoPay weekly review"));
        Assert.Equal("REVIEW_SENT", (await Decide(new { workItemId = load, decision = "done" })).ErrorCode);
        Assert.Equal("REVIEW_SENT", (await owner.Post($"/api/v1/meet/review/{session}/undo", new { })).ErrorCode);
    }

    [Fact]
    public async Task Owners_give_one_line_updates_others_nudge_and_outsiders_cannot_review()
    {
        var (owner, mate, project) = await TeamAsync("Steering");
        var id = await WeeklyAsync(owner, project, NextWeekAt(7), title: "Steering committee");
        var item = Guid.Parse(S((await owner.Post($"/api/v1/meet/p/{id}/capture", new { text = "Q4 budget variance note @ravi fri" })).Data!["item"]!["id"]));

        var mine = await mate.Get("/api/v1/meet/my-action-items");
        Assert.True(mine.Ok, mine.ToString());
        Assert.Contains(mine.Data!["needsUpdate"]!.AsArray(), i => S(i!["id"]) == item.ToString());
        Assert.Contains(mine.Data["series"]!.AsArray(), s => S(s!["title"]) == "Steering committee");
        Assert.Contains((await owner.Get("/api/v1/meet/my-action-items")).Data!["waitingOnOthers"]!.AsArray(), i => S(i!["id"]) == item.ToString());

        // Nudge: the owner is asked (once in a while); nobody nudges themselves.
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Post($"/api/v1/meet/action-items/{item}/nudge")).Status);
        Assert.Contains(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == mate.UserId && n.Type == NotificationType.Nudge).Select(n => n.Title).ToList()), t => t.Contains("Q4 budget variance note"));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await mate.Post($"/api/v1/meet/action-items/{item}/nudge")).Status);

        // The owner's update shows in everyone's review; "Need help" tells the person who added it.
        var update = await mate.Post($"/api/v1/meet/action-items/{item}/update", new { note = "Asked Lena for final copy", signal = "need_help" });
        Assert.True(update.Ok, update.ToString());
        var review = await owner.Post("/api/v1/meet/review", new { scope = "series", seriesRef = $"p:{id}" });
        var row = review.Data!["items"]!.AsArray().Single(i => S(i!["id"]) == item.ToString())!;
        Assert.Equal("Asked Lena for final copy · Need help", S(row["latestNote"]));
        Assert.Equal("blocked", S(row["state"]));
        Assert.False(row["noUpdate"]!.GetValue<bool>());
        Assert.Contains(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == owner.UserId).Select(n => n.Title).ToList()), t => t.StartsWith("Ravi Menon needs help"));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await mate.Post($"/api/v1/meet/action-items/{item}/update", new { note = "x", signal = "whatever" })).Status);

        // Someone outside the project sees neither the meeting nor its review.
        var outsider = await owner.AddMemberAsync(factory, TenantRole.Guest, "Kiran Das");
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Post("/api/v1/meet/review", new { scope = "series", seriesRef = $"p:{id}" })).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Get($"/api/v1/meet/p/{id}/items")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Post($"/api/v1/meet/action-items/{item}/update", new { note = "hi", signal = "on_track" })).Status);
        // Done from My action items completes it.
        Assert.True((await mate.Post($"/api/v1/meet/action-items/{item}/update", new { note = "", signal = "done" })).Ok);
        Assert.Equal(WorkTaskStatus.Completed, factory.WithDb(db => db.WorkTasks.IgnoreQueryFilters().Single(w => w.Id == item).Status));
    }
}
