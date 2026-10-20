using System.Net;
using System.Text.Json.Nodes;
using NodaTime;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Operations: routing rules, escalation settings, business-hours clocks, smart triage, bulk changes and analytics.</summary>
[Collection("api")]
public class OperationsTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static int I(JsonNode? n) => n!.GetValue<int>();

    private sealed record Team(TestClient Owner, TestClient A, TestClient B, TestClient C);

    private async Task<Team> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        return new Team(owner, await owner.AddMemberAsync(factory, TenantRole.Member, "Anil Agent"), await owner.AddMemberAsync(factory, TenantRole.Member, "Bina Agent"),
            await owner.AddMemberAsync(factory, TenantRole.Member, "Chen Lead"));
    }

    private static async Task<string> TypeId(TestClient c, string name) =>
        S((await c.Get("/api/v1/work-types?includeInactive=true")).Data!.AsArray().Single(t => S(t!["name"]) == name)!["id"]);

    private static async Task<JsonNode> Create(TestClient c, string title, string type, string priority = "Medium", Guid? assignee = null, string? description = null)
    {
        var r = await c.Post("/api/v1/work-tasks", new { title, description, workTypeId = await TypeId(c, type), priority, assigneeId = assignee });
        Assert.True(r.Ok, r.ToString());
        return r.Data!;
    }

    [Fact]
    public async Task New_work_without_an_assignee_is_routed_by_turns_or_least_open_work()
    {
        var t = await Setup();
        await Create(t.Owner, "warm up", "Production Support");   // makes sure the default work types exist
        var support = await TypeId(t.Owner, "Production Support");
        Assert.Equal(HttpStatusCode.Forbidden, (await t.A.Post("/api/v1/operations/routing", new { workTypeId = support, mode = "round_robin", memberIds = new[] { t.A.UserId } })).Status);
        var saved = await t.Owner.Post("/api/v1/operations/routing", new { workTypeId = support, mode = "round_robin", memberIds = new[] { t.A.UserId, t.B.UserId } });
        Assert.True(saved.Ok, saved.ToString());
        Assert.Equal(HttpStatusCode.Conflict, (await t.Owner.Post("/api/v1/operations/routing", new { workTypeId = support, mode = "round_robin", memberIds = new[] { t.A.UserId } })).Status);

        var first = await Create(t.Owner, "Printer down", "Production Support");
        var second = await Create(t.Owner, "VPN slow", "Production Support");
        var third = await Create(t.Owner, "Mail bounce", "Production Support");
        Assert.Equal(t.A.UserId.ToString(), S(first["assignee"]!["id"]));
        Assert.Equal(t.B.UserId.ToString(), S(second["assignee"]!["id"]));
        Assert.Equal(t.A.UserId.ToString(), S(third["assignee"]!["id"]));
        // Someone chosen by hand is kept.
        var manual = await Create(t.Owner, "Laptop request", "Production Support", assignee: t.C.UserId);
        Assert.Equal(t.C.UserId.ToString(), S(manual["assignee"]!["id"]));

        // Least open work: A has two open, B one, so B gets it.
        var rule = S(saved.Data!["rules"]![0]!["id"]);
        Assert.True((await t.Owner.Put($"/api/v1/operations/routing/{rule}", new { workTypeId = support, mode = "least_loaded", memberIds = new[] { t.A.UserId, t.B.UserId } })).Ok);
        var fourth = await Create(t.Owner, "Disk full", "Production Support");
        Assert.Equal(t.B.UserId.ToString(), S(fourth["assignee"]!["id"]));
        var settings = (await t.A.Get("/api/v1/operations/settings")).Data!;
        Assert.False(settings["canManage"]!.GetValue<bool>());
        Assert.Equal("least_loaded", S(settings["rules"]![0]!["mode"]));
    }

    [Fact]
    public void Business_hours_count_only_working_time()
    {
        var cal = new BusinessCalendar(31, 9 * 60, 18 * 60, DateTimeZone.Utc);   // Monday to Friday, 09:00-18:00 UTC
        var friday = new DateTime(2026, 10, 16, 17, 0, 0, DateTimeKind.Utc);
        Assert.Equal(new DateTime(2026, 10, 19, 10, 0, 0, DateTimeKind.Utc), cal.Add(friday, 120));     // an hour Friday, an hour Monday
        Assert.Equal(new DateTime(2026, 10, 19, 9, 30, 0, DateTimeKind.Utc), cal.Add(new DateTime(2026, 10, 17, 12, 0, 0, DateTimeKind.Utc), 30));   // from Saturday
        Assert.Equal(120, cal.Between(friday, new DateTime(2026, 10, 19, 10, 0, 0, DateTimeKind.Utc)));
        Assert.Equal(0, cal.Between(new DateTime(2026, 10, 17, 1, 0, 0, DateTimeKind.Utc), new DateTime(2026, 10, 18, 23, 0, 0, DateTimeKind.Utc)));
    }

    [Fact]
    public async Task Settings_triage_bulk_and_insights_work_together()
    {
        var t = await Setup();
        var bad = await t.Owner.Put("/api/v1/operations/settings", new { businessHoursOnly = true, dayStartMinutes = 600, dayEndMinutes = 620, workDays = new[] { 1, 2, 3, 4, 5 }, timeZone = "Asia/Kolkata", escalateOnBreach = false });
        Assert.Equal(422, (int)bad.Status);
        var ok = await t.Owner.Put("/api/v1/operations/settings", new { businessHoursOnly = true, dayStartMinutes = 540, dayEndMinutes = 1080, workDays = new[] { 1, 2, 3, 4, 5 }, timeZone = "Asia/Kolkata", escalateOnBreach = true, escalateToUserId = t.C.UserId });
        Assert.True(ok.Ok, ok.ToString());
        Assert.Equal(5, ok.Data!["workDays"]!.AsArray().Count);
        Assert.Equal("Chen Lead", S(ok.Data!["escalateTo"]!["name"]));

        // History: B resolves login problems.
        foreach (var title in new[] { "Login page error for customer portal", "Customer portal login fails with error", "Portal login error after reset" })
        {
            var w = await Create(t.Owner, title, "Bug Fix", "High", t.B.UserId);
            Assert.True((await t.B.Put($"/api/v1/work-tasks/{S(w["id"])}/status", new { status = "Completed" })).Ok);
        }
        var open = await Create(t.Owner, "Customer portal login error on mobile", "Bug Fix", "Medium", t.A.UserId);
        var triage = (await t.A.Post("/api/v1/operations/triage", new { title = "Customer portal login error", description = "Users cannot sign in, urgent" })).Data!;
        Assert.Equal(await TypeId(t.Owner, "Bug Fix"), S(triage["workTypeId"]));
        Assert.Equal("High", S(triage["priority"]));
        Assert.Equal(t.B.UserId.ToString(), S(triage["assignee"]!["id"]));
        Assert.Contains(triage["duplicates"]!.AsArray(), d => S(d!["id"]) == S(open["id"]));

        // Many at once: the owner may change everything; A only what is theirs.
        var x = await Create(t.Owner, "Rotate certificates", "Production Support", "Low");
        var y = await Create(t.Owner, "Renew domain", "Production Support", "Low");
        var bulk = await t.Owner.Post("/api/v1/operations/bulk", new { ids = new[] { S(x["id"]), S(y["id"]) }, priority = "High", assigneeId = t.A.UserId });
        Assert.True(bulk.Ok, bulk.ToString());
        Assert.Equal(2, I(bulk.Data!["updated"]));
        Assert.Equal("High", S((await t.Owner.Get($"/api/v1/work-tasks/{S(y["id"])}")).Data!["priority"]));
        var mixed = await t.B.Post("/api/v1/operations/bulk", new { ids = new[] { S(x["id"]), S(open["id"]) }, status = "InProgress" });
        Assert.Equal(0, I(mixed.Data!["updated"]));
        Assert.Equal(2, mixed.Data!["failed"]!.AsArray().Count);
        Assert.Equal(1, I((await t.A.Post("/api/v1/operations/bulk", new { ids = new[] { S(x["id"]) }, status = "InProgress" })).Data!["updated"]));

        var insights = (await t.A.Get("/api/v1/operations/insights?days=30")).Data!;
        Assert.Equal(3, I(insights["completedInPeriod"]));
        Assert.True(I(insights["open"]) >= 3);
        Assert.True(insights["businessHours"]!.GetValue<bool>());
        Assert.Equal(4, insights["byPriority"]!.AsArray().Count);
        Assert.Equal(4, insights["aging"]!.AsArray().Count);
    }
}
