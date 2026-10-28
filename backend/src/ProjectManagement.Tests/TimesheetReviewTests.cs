using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The pre-submit review (GET /api/v1/time/review): where the week's target comes from (capacity set in People, less holidays and leave) and the
/// checks - missing days, entries without a work item, billable not set on a billable project, billable time without a comment, timer time
/// overlapping a call, days over 12 hours - as warnings, and the hard stops (running timer, nothing logged) as errors.
/// </summary>
[Collection("api")]
public class TimesheetReviewTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static int I(JsonNode? n) => n!.GetValue<int>();
    private static DateOnly Today => AppDay.Today;
    private static DateOnly LastMonday => Today.AddDays(-(((int)Today.DayOfWeek + 6) % 7)).AddDays(-7);
    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd");
    private static IEnumerable<JsonNode> Issues(JsonNode r, string code) => r["issues"]!.AsArray().Where(i => S(i!["code"]) == code)!;

    [Fact]
    public async Task The_review_explains_the_target_and_lists_what_to_fix()
    {
        var owner = await TestClient.RegisterAsync(factory, "Oren Ashby");
        var tid = await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Daria Fenn");
        var peer = await owner.AddMemberAsync(factory, TenantRole.Member, "Pell Yarrow");
        var project = await owner.CreateProjectAsync("Client Ledger");
        var task = Guid.Parse(S((await owner.CreateTaskAsync(project, "Reconcile the ledger", new { title = "Reconcile the ledger with a much longer name than fits", priority = "Medium", assigneeId = dev.UserId }))["id"]));
        Assert.True((await owner.Put($"/api/v1/resources/rates/{dev.UserId}", new { weeklyCapacityHours = 40m })).Ok);

        var mon = LastMonday;
        Assert.True((await dev.Post($"/api/v1/tasks/{task}/time", new { minutes = 60, workDate = Iso(mon) })).Ok);
        factory.WithDb(db =>
        {
            db.Projects.IgnoreQueryFilters().First(p => p.Id == project).IsBillable = true;   // after logging: the Monday entry is not billable
            db.Holidays.Add(new Holiday { TenantId = tid, Date = mon.AddDays(2), Name = "Harvest Day" });
            db.TimeEntries.Add(new TimeEntry { TenantId = tid, TaskId = task, ProjectId = project, UserId = dev.UserId, WorkDate = mon.AddDays(3), Minutes = 13 * 60, Billable = true, Note = "Cutover" });
            db.TimeEntries.Add(new TimeEntry { TenantId = tid, UserId = dev.UserId, WorkDate = mon.AddDays(4), Minutes = 30, Note = "Admin" });
            var fri = DateTime.SpecifyKind(mon.AddDays(4).ToDateTime(new TimeOnly(10, 0)), DateTimeKind.Utc);
            db.TimeEntries.Add(new TimeEntry { TenantId = tid, TaskId = task, ProjectId = project, UserId = dev.UserId, WorkDate = mon.AddDays(4), Minutes = 60, Billable = true, Note = "Pairing",
                StartedAt = fri, EndedAt = fri.AddHours(1) });
            var call = new CallRoom { TenantId = tid, Title = "Ledger sync", RoomName = $"pt-{Guid.NewGuid():N}", Kind = "project", ProjectId = project,
                StartedBy = dev.UserId, StartedAt = fri.AddMinutes(15), EndedAt = fri.AddMinutes(45), Status = "ended", PeakParticipants = 1 };
            db.CallRooms.Add(call);
            db.CallParticipants.Add(new CallParticipant { TenantId = tid, CallId = call.Id, UserId = dev.UserId, Role = "host", JoinedAt = call.StartedAt, LeftAt = call.EndedAt, Seconds = 1800 });
            return db.SaveChanges();
        });

        var res = await dev.Get($"/api/v1/time/review?weekStart={Iso(mon)}");
        Assert.True(res.Ok, res.ToString());
        var r = res.Data!;
        // 40h over 5 days, less the holiday: 32h, explained with who set the capacity.
        var target = r["target"]!;
        Assert.Equal(40 * 60, I(target["weeklyCapacityMinutes"]));
        Assert.False(target["isDefault"]!.GetValue<bool>());
        Assert.Equal("Oren Ashby", S(target["setBy"]));
        Assert.Equal(32 * 60, I(target["targetMinutes"]));
        Assert.Contains("Harvest Day", S(target["explanation"]));
        // The grid agrees on the target.
        Assert.Equal(32 * 60, I((await dev.Get($"/api/v1/time/grid?weekStart={Iso(mon)}")).Data!["targetMinutes"]));

        var missing = Issues(r, "missing-day").Select(i => S(i["date"])).ToList();
        Assert.Equal(new[] { Iso(mon.AddDays(1)) }, missing);   // Tuesday only: Wednesday is the holiday, Thursday and Friday hold time
        Assert.Single(Issues(r, "long-day"));
        Assert.Equal("link", S(Issues(r, "no-item").Single()["fix"]));
        var notBillable = Issues(r, "not-billable").Single();
        Assert.Equal("billable", S(notBillable["fix"]));
        Assert.Contains(Issues(r, "note-missing"), i => S(i["date"]) == Iso(mon));
        Assert.Contains("Ledger sync", S(Issues(r, "overlap").Single()["message"]));
        Assert.All(r["issues"]!.AsArray(), i => Assert.Equal("warning", S(i!["severity"])));
        Assert.Equal(0, I(r["errors"]));
        Assert.True(r["canSubmit"]!.GetValue<bool>());

        // A timer still running in the week is a hard stop.
        factory.WithDb(db =>
        {
            db.TimeEntries.Add(new TimeEntry { TenantId = tid, TaskId = task, ProjectId = project, UserId = dev.UserId, WorkDate = mon.AddDays(1), StartedAt = DateTime.UtcNow.AddMinutes(-20) });
            return db.SaveChanges();
        });
        var blocked = (await dev.Get($"/api/v1/time/review?weekStart={Iso(mon)}")).Data!;
        Assert.Equal("stop", S(Issues(blocked, "running").Single()["fix"]));
        Assert.False(blocked["canSubmit"]!.GetValue<bool>());

        // Nothing logged is a hard stop too; the standard week applies when no capacity was set.
        var empty = (await peer.Get($"/api/v1/time/review?weekStart={Iso(mon)}")).Data!;
        Assert.Single(Issues(empty, "empty"));
        Assert.True(empty["target"]!["isDefault"]!.GetValue<bool>());
        Assert.False(empty["canSubmit"]!.GetValue<bool>());
    }
}
