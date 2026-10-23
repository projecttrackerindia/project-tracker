using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Settings as one place: setup health with fixes and "not needed here"; who changed each setting (from the audit log) with undo of the last
/// change; who a stricter rule or a shorter retention would affect before saving; and notification defaults that reach members who have not
/// chosen for themselves.
/// </summary>
[Collection("api")]
public class SettingsCenterTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<TestClient> Owner(string plan = "BUSINESS")
    {
        var c = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await c.CreateOrgAsync();
        await c.UpgradeAsync(plan);
        return c;
    }

    private static JsonNode Check(JsonNode health, string id) => health["checks"]!.AsArray().Single(c => S(c!["id"]) == id)!;

    [Fact]
    public async Task Setup_health_lists_what_is_missing_with_fixes_and_checks_can_be_marked_not_needed()
    {
        var c = await Owner();
        var health = (await c.Get("/api/v1/settings/health")).Data!;
        var twoStep = Check(health, "two-step");
        Assert.False(twoStep["ok"]!.GetValue<bool>());
        Assert.Equal("/settings/security#s-security.requireMfa", S(twoStep["fix"]!["to"]));
        Assert.False(Check(health, "backup-admin")["ok"]!.GetValue<bool>());
        Assert.Equal("/settings/members", S(Check(health, "backup-admin")["fix"]!["to"]));
        Assert.False(Check(health, "whatsapp")["ok"]!.GetValue<bool>());
        Assert.True(Check(health, "audit-chain")["ok"]!.GetValue<bool>());
        Assert.True(Check(health, "webhook-signing")["ok"]!.GetValue<bool>());   // no webhooks yet
        var score = health["score"]!.GetValue<int>();
        Assert.InRange(score, 0, 99);

        // A backup admin closes that gap; the reminder fix reaches members without two-step sign-in.
        var admin = await c.AddMemberAsync(factory, TenantRole.Admin, "Ada Admin");
        health = (await c.Get("/api/v1/settings/health")).Data!;
        Assert.True(Check(health, "backup-admin")["ok"]!.GetValue<bool>());
        Assert.Equal("remind-two-step", S(Check(health, "two-step")["action"]));
        var reminded = await c.Post("/api/v1/settings/health/two-step/remind");
        Assert.True(reminded.Ok, reminded.ToString());
        Assert.True(reminded.Data!["sent"]!.GetValue<int>() >= 1);
        Assert.Contains("two-step", (await admin.Get("/api/v1/notifications")).Data!.ToJsonString());

        // "We do not use WhatsApp": it stops counting, and can be brought back.
        var dismissed = (await c.Post("/api/v1/settings/health/whatsapp/dismiss", new { reason = "We do not use WhatsApp" })).Data!;
        Assert.True(Check(dismissed, "whatsapp")["dismissed"]!.GetValue<bool>());
        Assert.Equal("We do not use WhatsApp", S(Check(dismissed, "whatsapp")["dismissReason"]));
        Assert.True(dismissed["score"]!.GetValue<int>() > score);
        Assert.Equal(422, (int)(await c.Post("/api/v1/settings/health/audit-chain/dismiss")).Status);
        Assert.False(Check((await c.Delete("/api/v1/settings/health/whatsapp/dismiss")).Data!, "whatsapp")["dismissed"]!.GetValue<bool>());

        // An incoming address without a secret is a signing gap.
        Assert.True((await c.Post("/api/v1/incoming-webhooks", new { name = "Form", target = "ticket", requireSecret = false, mapping = new { title = "{{name}}" } })).Ok);
        var signing = Check((await c.Get("/api/v1/settings/health")).Data!, "webhook-signing");
        Assert.False(signing["ok"]!.GetValue<bool>());
        Assert.Contains("without a secret", S(signing["detail"]));

        // Members do not see it.
        var member = await c.AddMemberAsync(factory, TenantRole.Member, "Mo Member");
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get("/api/v1/settings/health")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get("/api/v1/settings/changes?section=general")).Status);
    }

    [Fact]
    public async Task Each_setting_shows_its_last_change_and_who_made_it_and_the_last_change_can_be_undone()
    {
        var c = await Owner();
        Assert.True((await c.Put("/api/v1/workspace", new { name = "Acme Payments", description = "Cards and UPI" })).Ok);
        Assert.True((await c.Put("/api/v1/workspace", new { name = "Acme Payments Ltd", description = "Cards and UPI" })).Ok);

        var general = (await c.Get("/api/v1/settings/changes?section=general")).Data!;
        var change = general["items"]!.AsArray().Single(i => S(i!["key"]) == "workspace.name")!;
        Assert.Equal("“Acme Payments” → “Acme Payments Ltd”", S(change["summary"]));
        Assert.Equal("Olivia Owner", S(change["byName"]));
        Assert.True(change["canUndo"]!.GetValue<bool>());
        Assert.Equal("“Acme Payments”", S(change["undoTo"]));
        // The description did not change in the second save, so its last change is the first one.
        var desc = general["items"]!.AsArray().Single(i => S(i!["key"]) == "workspace.description")!;
        Assert.NotEqual(S(change["auditId"]), S(desc["auditId"]));

        var undone = await c.Post($"/api/v1/settings/changes/{S(change["auditId"])}/undo", new { key = "workspace.name" });
        Assert.True(undone.Ok, undone.ToString());
        Assert.Contains("back to “Acme Payments”", S(undone.Data!["message"]));
        Assert.Equal("Acme Payments", S((await c.Get("/api/v1/workspaces")).Data!.AsArray().First(w => S(w!["id"]) == c.WorkspaceId.ToString())!["name"]));
        Assert.True(undone.Data["latest"]!["wasUndo"]!.GetValue<bool>());
        // That change is no longer the last one: it cannot be undone twice.
        var again = await c.Post($"/api/v1/settings/changes/{S(change["auditId"])}/undo", new { key = "workspace.name" });
        Assert.Equal(HttpStatusCode.Conflict, again.Status);

        // Field by field inside a shared save: changing the session length does not show as a change to two-step sign-in.
        var security = await c.Put("/api/v1/workspace/security", new { requireMfa = false, ipAllowlistEnabled = false, ipRanges = Array.Empty<string>(), sessionHours = 24 });
        Assert.True(security.Ok, security.ToString());
        var sec = (await c.Get("/api/v1/settings/changes?section=security")).Data!["items"]!.AsArray();
        var session = sec.Single(i => S(i!["key"]) == "security.sessionHours")!;
        Assert.Equal("the platform's session length → 1 day", S(session["summary"]));
        Assert.DoesNotContain(sec, i => S(i!["key"]) == "security.requireMfa");
        Assert.True((await c.Post($"/api/v1/settings/changes/{S(session["auditId"])}/undo", new { key = "security.sessionHours" })).Ok);
        Assert.Equal(0, (await c.Get("/api/v1/workspace/security")).Data!["sessionHours"]!.GetValue<int>());

        // Retention, and something that is listed but cannot be undone from here (an API key).
        Assert.True((await c.Put("/api/v1/workspace/data-policy", new { activityRetentionDays = 90, notificationRetentionDays = (int?)null, chatRetentionDays = (int?)null, auditRetentionDays = (int?)null })).Ok);
        var data = (await c.Get("/api/v1/settings/changes?section=data")).Data!["items"]!.AsArray().Single(i => S(i!["key"]) == "data.activity")!;
        Assert.Equal("kept forever → 90 days", S(data["summary"]));
        Assert.True((await c.Post($"/api/v1/settings/changes/{S(data["auditId"])}/undo", new { key = "data.activity" })).Ok);
        Assert.Null((await c.Get("/api/v1/workspace/data-policy")).Data!["activityRetentionDays"]);

        var recent = (await c.Get("/api/v1/settings/changes/recent?take=20")).Data!["items"]!.AsArray();
        Assert.Contains(recent, i => S(i!["key"]) == "data.activity");
        Assert.Contains(recent, i => S(i!["key"]) == "workspace.name");
        Assert.Equal(HttpStatusCode.Conflict, (await c.Post($"/api/v1/settings/changes/{S(recent[0]!["auditId"])}/undo", new { key = "integrations.apiKeys" })).Status);
    }

    [Fact]
    public async Task A_risky_switch_shows_who_it_affects_before_saving()
    {
        var c = await Owner();
        var member = await c.AddMemberAsync(factory, TenantRole.Member, "Mo Member");
        var mfa = (await c.Post("/api/v1/settings/impact", new { kind = "security", requireMfa = true })).Data!;
        Assert.Contains("Two-step sign-in becomes required.", mfa["changes"]!.AsArray().Select(x => S(x)));
        var people = mfa["affected"]!.AsArray();
        Assert.Contains(people, p => S(p!["userId"]) == member.UserId.ToString() && S(p["reasons"]![0]).Contains("no two-step"));
        Assert.True(mfa["includesYou"]!.GetValue<bool>());
        Assert.NotNull(mfa["warning"]);

        var ip = (await c.Post("/api/v1/settings/impact", new { kind = "security", ipAllowlistEnabled = true, ipRanges = new[] { "203.0.113.0/24" } })).Data!;
        Assert.Contains("Only 1 listed network may open the workspace.", ip["changes"]!.AsArray().Select(x => S(x)));

        var nothing = (await c.Post("/api/v1/settings/impact", new { kind = "security" })).Data!;
        Assert.Empty(nothing["changes"]!.AsArray());
        Assert.Equal(0, nothing["people"]!.GetValue<int>());

        var retention = (await c.Post("/api/v1/settings/impact", new { kind = "retention", notificationRetentionDays = 7, activityRetentionDays = 30 })).Data!;
        Assert.Contains(retention["records"]!.AsArray(), r => S(r!["label"]) == "Notifications");
        Assert.Contains(retention["records"]!.AsArray(), r => S(r!["label"]) == "Activity entries");
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Post("/api/v1/settings/impact", new { kind = "security", requireMfa = true })).Status);
        Assert.Equal(422, (int)(await c.Post("/api/v1/settings/impact", new { kind = "billing" })).Status);
    }

    [Fact]
    public async Task Notification_defaults_reach_members_who_have_not_chosen_and_their_own_choice_wins()
    {
        var c = await Owner();
        var member = await c.AddMemberAsync(factory, TenantRole.Member, "Mo Member");
        var before = (await c.Get("/api/v1/settings/notification-defaults")).Data!;
        Assert.Equal(2, before["members"]!.GetValue<int>());
        Assert.All(before["kinds"]!.AsArray(), k => Assert.False(k!["changed"]!.GetValue<bool>()));

        var saved = await c.Put("/api/v1/settings/notification-defaults", new
        {
            kinds = new[] { new { type = "TaskUpdated", inApp = true, email = false, browser = false }, new { type = "Security", inApp = false, email = false, browser = false } },
            quietCustom = true, quietStart = "22:00", quietEnd = "07:00", digestCustom = true, digestTime = "18:30",
        });
        Assert.True(saved.Ok, saved.ToString());
        var kinds = saved.Data!["kinds"]!.AsArray();
        var updated = kinds.Single(k => S(k!["type"]) == "TaskUpdated")!;
        Assert.True(updated["changed"]!.GetValue<bool>());
        Assert.False(updated["workspace"]!["email"]!.GetValue<bool>());
        Assert.Equal(2, updated["following"]!.GetValue<int>());
        Assert.False(kinds.Single(k => S(k!["type"]) == "Security")!["changed"]!.GetValue<bool>());   // security alerts cannot be switched off
        Assert.Equal("22:00", S(saved.Data["quietStart"]));
        Assert.Equal("18:30", S(saved.Data["digestTime"]));

        // The member who never chose sees the workspace's default as theirs.
        var mine = (await member.Get("/api/v1/me/notification-preferences")).Data!.AsArray().Single(p => S(p!["type"]) == "TaskUpdated")!;
        Assert.False(mine["email"]!.GetValue<bool>());
        Assert.Equal("workspace", S(mine["source"]));
        // Their own choice wins from then on.
        Assert.True((await member.Put("/api/v1/me/notification-preferences", new { items = new[] { new { type = "TaskUpdated", inApp = true, email = true, browser = false } } })).Ok);
        mine = (await member.Get("/api/v1/me/notification-preferences")).Data!.AsArray().Single(p => S(p!["type"]) == "TaskUpdated")!;
        Assert.True(mine["email"]!.GetValue<bool>());
        Assert.Equal("you", S(mine["source"]));
        Assert.Equal(1, (await c.Get("/api/v1/settings/notification-defaults")).Data!["kinds"]!.AsArray().Single(k => S(k!["type"]) == "TaskUpdated")!["following"]!.GetValue<int>());

        // Undo puts the platform's defaults back.
        var change = (await c.Get("/api/v1/settings/changes?section=notifications")).Data!["items"]!.AsArray().Single(i => S(i!["key"]) == "notifications.defaults")!;
        Assert.Contains("1 kind changed", S(change["summary"]));
        Assert.True((await c.Post($"/api/v1/settings/changes/{S(change["auditId"])}/undo", new { key = "notifications.defaults" })).Ok);
        var after = (await c.Get("/api/v1/settings/notification-defaults")).Data!;
        Assert.False(after["quietCustom"]!.GetValue<bool>());
        Assert.All(after["kinds"]!.AsArray(), k => Assert.False(k!["changed"]!.GetValue<bool>()));

        Assert.Equal(422, (int)(await c.Put("/api/v1/settings/notification-defaults", new { kinds = Array.Empty<object>(), quietCustom = true, quietStart = "22:00", quietEnd = (string?)null, digestCustom = false })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get("/api/v1/settings/notification-defaults")).Status);
    }
}
