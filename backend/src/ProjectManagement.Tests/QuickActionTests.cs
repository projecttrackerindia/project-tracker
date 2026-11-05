using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Buttons on notifications outside the app: a signed, short-lived, single-use key acts as the person in their workspace, through the same
/// services and permission checks as the app; expired, forged, reused or cross-workspace keys do nothing; every use is audited.
/// </summary>
[Collection("api")]
public class QuickActionTests(ApiFactory factory)
{
    private async Task<(TestClient Owner, TestClient Mia, Guid Project)> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var mia = await owner.AddMemberAsync(factory, TenantRole.Member, "Mia");
        return (owner, mia, await owner.CreateProjectAsync("Quick"));
    }

    private static async Task<(string TaskId, string NotificationId)> Assign(TestClient owner, Guid project, TestClient mia, string title)
    {
        var task = await owner.CreateTaskAsync(project, title, new { title, priority = "High", assigneeId = mia.UserId });
        var key = task["key"]!.GetValue<string>();
        var n = (await mia.Get("/api/v1/notifications")).Data!["items"]!.AsArray()
            .First(x => x!["type"]!.GetValue<string>() == "TaskAssigned" && x["title"]!.GetValue<string>().Contains(key))!;
        return (task["id"]!.GetValue<string>(), n["id"]!.GetValue<string>());
    }

    private static Task<ApiResult> Press(TestClient anyone, string token, object body) =>
        anyone.Send(HttpMethod.Post, $"/api/v1/notification-actions/{Uri.EscapeDataString(token)}", body, anonymous: true);

    private string Mint(Guid notification, Guid user, Guid tenant, TimeSpan? life = null)
    {
        using var scope = factory.Services.CreateScope();
        var tokens = scope.ServiceProvider.GetRequiredService<ITokenService>();
        return life is { } l
            ? tokens.Seal(QuickActionService.Purpose, $"{notification:N}.{user:N}.{tenant:N}.{Guid.NewGuid():N}", l)
            : QuickActionService.Issue(tokens, notification, user, tenant);
    }

    [Fact]
    public void Only_notices_that_ask_for_something_get_buttons()
    {
        var task = $"/projects/{Guid.NewGuid()}?task={Guid.NewGuid()}";
        Assert.Equal(new[] { "done", "snooze", "open" }, QuickActions.For(NotificationType.TaskAssigned, task, "You were assigned X-1"));
        Assert.Equal(new[] { "approve", "reject" }, QuickActions.For(NotificationType.Approval, $"/approvals?open={Guid.NewGuid()}", "Leave request"));
        Assert.Empty(QuickActions.For(NotificationType.Approval, $"/approvals?open={Guid.NewGuid()}", "Approved: Leave request"));
        Assert.Equal(new[] { "reply", "read" }, QuickActions.For(NotificationType.Message, $"/chat/{Guid.NewGuid()}", "Ravi"));
        Assert.Equal(new[] { "join", "late" }, QuickActions.For(NotificationType.Reminder, $"/calls/meeting/w/{Guid.NewGuid()}", "Starts in 5 minutes: Standup"));
        Assert.Equal(new[] { "accept", "decline", "maybe" }, QuickActions.For(NotificationType.Meeting, $"/calls/meeting/{Guid.NewGuid()}", "Asha invited you to a call"));
        Assert.Equal(new[] { "callback", "message" }, QuickActions.For(NotificationType.Call, "/calls/x", "Missed call from Ravi"));
        Assert.Empty(QuickActions.For(NotificationType.ProjectUpdated, "/projects", "Project renamed"));
        Assert.Empty(QuickActions.For(NotificationType.Reminder, "/r/abc", "Reminder"));   // reminder links keep their own key
    }

    [Fact]
    public async Task A_key_works_without_signing_in_once_and_is_audited()
    {
        var (owner, mia, project) = await Setup();
        var (taskId, nid) = await Assign(owner, project, mia, "Press done");
        var issued = await mia.Post($"/api/v1/notifications/{nid}/quick-key", new { });
        Assert.True(issued.Ok, issued.ToString());
        Assert.Equal(new[] { "done", "snooze", "open" }, issued.Data!["actions"]!.AsArray().Select(a => a!.GetValue<string>()).ToArray());
        var token = issued.Data["token"]!.GetValue<string>();

        var done = await Press(mia, token, new { action = "done" });
        Assert.True(done.Ok, done.ToString());
        Assert.False(done.Data!["alreadyDone"]!.GetValue<bool>());
        Assert.Equal("Done", (await owner.Get($"/api/v1/tasks/{taskId}")).Data!["task"]!["statusCategory"]!.GetValue<string>());

        // Single use and idempotent: pressing again (a retry, a second device) does nothing twice.
        var again = await Press(mia, token, new { action = "done" });
        Assert.True(again.Ok, again.ToString());
        Assert.True(again.Data!["alreadyDone"]!.GetValue<bool>());
        var audits = factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Count(a => a.Action == QuickActionService.AuditAction && a.UserId == mia.UserId));
        Assert.Equal(1, audits);

        // An action the notice does not offer is refused.
        var (_, nid2) = await Assign(owner, project, mia, "Wrong button");
        var t2 = (await mia.Post($"/api/v1/notifications/{nid2}/quick-key", new { })).Data!["token"]!.GetValue<string>();
        Assert.Equal(422, (int)(await Press(mia, t2, new { action = "approve" })).Status);
        // Snooze from the lock screen: the notice leaves the inbox for an hour.
        Assert.True((await Press(mia, t2, new { action = "snooze", preset = "1h" })).Ok);
    }

    [Fact]
    public async Task Expired_and_forged_keys_do_nothing()
    {
        var (owner, mia, project) = await Setup();
        var (taskId, nid) = await Assign(owner, project, mia, "Expired");
        var expired = Mint(Guid.Parse(nid), mia.UserId, mia.WorkspaceId, TimeSpan.FromSeconds(-5));
        var r = await Press(mia, expired, new { action = "done" });
        Assert.Equal(HttpStatusCode.Unauthorized, r.Status);
        Assert.Equal("QUICK_ACTION_EXPIRED", r.ErrorCode);

        var good = Mint(Guid.Parse(nid), mia.UserId, mia.WorkspaceId);
        var forged = good[..^3] + (good[^3] == 'A' ? "BBB" : "AAA");
        Assert.Equal("QUICK_ACTION_EXPIRED", (await Press(mia, forged, new { action = "done" })).ErrorCode);
        // A key made for something else (the sign-in challenge) is not a quick-action key.
        using (var scope = factory.Services.CreateScope())
        {
            var other = scope.ServiceProvider.GetRequiredService<ITokenService>().Seal("something-else", $"{Guid.Parse(nid):N}.{mia.UserId:N}.{mia.WorkspaceId:N}.{Guid.NewGuid():N}", TimeSpan.FromHours(1));
            Assert.Equal("QUICK_ACTION_EXPIRED", (await Press(mia, other, new { action = "done" })).ErrorCode);
        }
        Assert.NotEqual("Done", (await owner.Get($"/api/v1/tasks/{taskId}")).Data!["task"]!["statusCategory"]!.GetValue<string>());
    }

    [Fact]
    public async Task Permission_is_checked_again_when_the_key_is_used()
    {
        var (owner, mia, project) = await Setup();
        var (taskId, nid) = await Assign(owner, project, mia, "Suspended");
        var token = (await mia.Post($"/api/v1/notifications/{nid}/quick-key", new { })).Data!["token"]!.GetValue<string>();
        // Suspended after the notice went out: the key no longer gets in; the app must be opened.
        factory.WithDb(db =>
        {
            var m = db.TenantMembers.IgnoreQueryFilters().Single(x => x.UserId == mia.UserId && x.TenantId == mia.WorkspaceId);
            m.Status = MemberStatus.Suspended;
            return db.SaveChanges();
        });
        var r = await Press(mia, token, new { action = "done" });
        Assert.Equal(HttpStatusCode.Forbidden, r.Status);
        Assert.Equal("QUICK_ACTION_REAUTH", r.ErrorCode);
        Assert.NotEqual("Done", (await owner.Get($"/api/v1/tasks/{taskId}")).Data!["task"]!["statusCategory"]!.GetValue<string>());
    }

    [Fact]
    public async Task A_key_never_reaches_into_another_workspace()
    {
        var (owner, mia, project) = await Setup();
        var (taskId, nid) = await Assign(owner, project, mia, "Isolated");
        // Mia also has a workspace of her own. A key naming that workspace with the first workspace's notice finds nothing.
        var elsewhere = await TestClient.RegisterAsync(factory, "Other Owner");
        await elsewhere.CreateOrgAsync();
        await elsewhere.UpgradeAsync("BUSINESS");
        var other = await elsewhere.AddMemberAsync(factory, TenantRole.Member, "Mia elsewhere");
        var crossed = Mint(Guid.Parse(nid), other.UserId, other.WorkspaceId);
        Assert.Equal(HttpStatusCode.NotFound, (await Press(other, crossed, new { action = "done" })).Status);
        // Nor can another person's key be made to act on Mia's notice in her workspace (the person must be a member there).
        var foreign = Mint(Guid.Parse(nid), other.UserId, mia.WorkspaceId);
        Assert.Equal("QUICK_ACTION_REAUTH", (await Press(other, foreign, new { action = "done" })).ErrorCode);
        Assert.NotEqual("Done", (await owner.Get($"/api/v1/tasks/{taskId}")).Data!["task"]!["statusCategory"]!.GetValue<string>());
        // And a signed-in person cannot ask for a key to someone else's notice.
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Post($"/api/v1/notifications/{nid}/quick-key", new { })).Status);
    }

    [Fact]
    public async Task In_app_banners_use_the_same_actions_signed_in()
    {
        var (owner, mia, project) = await Setup();
        var (taskId, nid) = await Assign(owner, project, mia, "Banner");
        var r = await mia.Post($"/api/v1/notifications/{nid}/quick", new { action = "done" });
        Assert.True(r.Ok, r.ToString());
        Assert.Equal("Done", (await owner.Get($"/api/v1/tasks/{taskId}")).Data!["task"]!["statusCategory"]!.GetValue<string>());
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Post($"/api/v1/notifications/{nid}/quick", new { action = "read" })).Status);
    }
}
