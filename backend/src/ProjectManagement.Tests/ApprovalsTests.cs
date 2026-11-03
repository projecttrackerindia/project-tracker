using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Approvals (/api/v1/approvals): a request walks its chain one approver at a time; only the approver whose turn it is decides; every step is on
/// the timeline; the requester and approvers are told (links under /approvals, the Approvals tab's badge); requests stay inside their workspace
/// and are seen only by the people on them (and owners/admins); workspace policies set the default chain; approved leave becomes planned leave.
/// </summary>
[Collection("api")]
public class ApprovalsTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<(TestClient Owner, TestClient Admin, TestClient Member)> TeamAsync(string name)
    {
        var owner = await TestClient.RegisterAsync(factory, $"{name} Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var admin = await owner.AddMemberAsync(factory, TenantRole.Admin, $"{name} Ops");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, $"{name} Dev");
        return (owner, admin, member);
    }

    [Fact]
    public async Task A_request_walks_its_chain_and_only_the_current_approver_decides()
    {
        var (owner, admin, member) = await TeamAsync("Chain");
        var created = await member.Post("/api/v1/approvals", new
        {
            type = "Deployment", title = "Ship Payments API v2.4.0 to production", risk = "High", impact = "All card refunds · 30 min window",
            payload = new Dictionary<string, string> { ["service"] = "payments-api", ["environment"] = "Production", ["version"] = "2.4.0" },
            links = new[] { new { kind = "pr", label = "PR #815", href = "/projects" }, new { kind = "bad", label = "Evil", href = "javascript:alert(1)" } },
            chain = new object[] { new { role = "Ops", userId = admin.UserId }, new { role = "Owner" } },
        });
        Assert.True(created.Status == HttpStatusCode.Created, created.ToString());
        var id = S(created.Data!["id"]);
        Assert.Equal("Pending", S(created.Data["status"]));
        Assert.Equal(2, created.Data["steps"]!.AsArray().Count);
        Assert.Equal("Pending", S(created.Data["steps"]![0]!["status"]));
        Assert.Equal("Waiting", S(created.Data["steps"]![1]!["status"]));
        Assert.Null(created.Data["links"]![1]!["href"]);   // links stay inside the app

        // The first approver is told, and it shows under "needs me" for them only.
        var adminList = await admin.Get("/api/v1/approvals?view=needs");
        Assert.Equal(1, adminList.Data!["counts"]!["needsMe"]!.GetValue<int>());
        Assert.Equal(1, (await admin.Get("/api/v1/approvals/counts")).Data!["needsMe"]!.GetValue<int>());
        Assert.Contains((await admin.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), n => S(n!["link"]) == $"/approvals?open={id}");
        Assert.Equal(0, (await owner.Get("/api/v1/approvals/counts")).Data!["needsMe"]!.GetValue<int>());
        Assert.Single((await member.Get("/api/v1/approvals?view=mine")).Data!["items"]!.AsArray());

        // Not the owner's turn yet; the requester cannot approve their own.
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.Post($"/api/v1/approvals/{id}/decide", new { action = "approve" })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Post($"/api/v1/approvals/{id}/decide", new { action = "approve" })).Status);

        var first = await admin.Post($"/api/v1/approvals/{id}/decide", new { action = "approve", comment = "Window booked." });
        Assert.True(first.Ok, first.ToString());
        Assert.Equal("Pending", S(first.Data!["status"]));
        Assert.Equal(2, first.Data["currentStep"]!.GetValue<int>());
        Assert.Equal(1, (await owner.Get("/api/v1/approvals/counts")).Data!["needsMe"]!.GetValue<int>());

        var asked = await member.Post($"/api/v1/approvals/{id}/decide", new { action = "comment", comment = "Rollback is 2.3.7." });
        Assert.True(asked.Ok, asked.ToString());

        var rejected = await owner.Post($"/api/v1/approvals/{id}/decide", new { action = "reject", comment = "Contoso still uses v1. Wait for Friday." });
        Assert.True(rejected.Ok, rejected.ToString());
        Assert.Equal("Rejected", S(rejected.Data!["status"]));
        var actions = rejected.Data["events"]!.AsArray().Select(e => S(e!["action"])).ToList();
        Assert.Equal(new[] { "Requested", "Approved", "Commented", "Rejected" }, actions);
        Assert.Contains("Contoso", rejected.Data["events"]!.AsArray().Last()!["comment"]!.GetValue<string>());
        Assert.Equal(HttpStatusCode.Conflict, (await owner.Post($"/api/v1/approvals/{id}/decide", new { action = "approve" })).Status);

        // The requester hears the outcome, and it moves to history.
        Assert.Contains((await member.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), n => S(n!["title"]).StartsWith("Rejected:"));
        var history = await member.Get("/api/v1/approvals?view=history");
        Assert.Single(history.Data!["items"]!.AsArray());
        Assert.Equal(0, (await member.Get("/api/v1/approvals?view=mine")).Data!["items"]!.AsArray().Count);
    }

    [Fact]
    public async Task Requests_are_seen_only_by_the_people_on_them_and_never_across_workspaces()
    {
        var (owner, admin, member) = await TeamAsync("Seen");
        var other = await owner.AddMemberAsync(factory, TenantRole.Member, "Seen Bystander");
        var created = await member.Post("/api/v1/approvals", new { type = "Access", title = "Prod read access for Priya", chain = new object[] { new { role = "Admin", userId = admin.UserId } } });
        var id = S(created.Data!["id"]);

        Assert.Equal(HttpStatusCode.NotFound, (await other.Get($"/api/v1/approvals/{id}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await other.Post($"/api/v1/approvals/{id}/decide", new { action = "comment", comment = "hi" })).Status);
        Assert.True((await owner.Get($"/api/v1/approvals/{id}")).Ok);   // owners see everything in their workspace

        var outsider = await TestClient.RegisterAsync(factory, "Seen Outsider");
        await outsider.CreateOrgAsync();
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Get($"/api/v1/approvals/{id}")).Status);
        Assert.Empty((await outsider.Get("/api/v1/approvals?view=all")).Data!["items"]!.AsArray());

        Assert.Equal(HttpStatusCode.Forbidden, (await admin.Post($"/api/v1/approvals/{id}/decide", new { action = "withdraw" })).Status);
        var withdrawn = await member.Post($"/api/v1/approvals/{id}/decide", new { action = "withdraw" });
        Assert.Equal("Withdrawn", S(withdrawn.Data!["status"]));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await member.Post("/api/v1/approvals", new { type = "Coffee", title = "x" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await member.Post("/api/v1/approvals", new { type = "Incident", title = " " })).Status);
    }

    [Fact]
    public async Task Workspace_policies_set_the_default_chain()
    {
        var (owner, admin, member) = await TeamAsync("Policy");
        var defaults = await member.Get("/api/v1/approvals/policies");
        Assert.Equal(8, defaults.Data!.AsArray().Count);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Put("/api/v1/approvals/policies/Expense", new { steps = new[] { new { role = "Finance" } } })).Status);

        var saved = await owner.Put("/api/v1/approvals/policies/Expense", new { steps = new object[] { new { role = "Finance", userId = admin.UserId } }, expiryHours = 48 });
        Assert.True(saved.Ok, saved.ToString());
        var preview = await member.Get("/api/v1/approvals/chain?type=Expense");
        Assert.True(preview.Data!["custom"]!.GetValue<bool>());
        Assert.Equal(admin.UserId.ToString(), S(preview.Data["steps"]![0]!["approver"]!["id"]));

        var req = await member.Post("/api/v1/approvals", new { type = "Expense", title = "Design tool seats · ₹12,400" });
        Assert.Equal(admin.UserId.ToString(), S(req.Data!["steps"]![0]!["approver"]!["id"]));

        var reset = await owner.Put("/api/v1/approvals/policies/Expense", new { steps = Array.Empty<object>() });
        Assert.False(reset.Data!["custom"]!.GetValue<bool>());
        Assert.Equal(2, reset.Data["steps"]!.AsArray().Count);
    }

    [Fact]
    public async Task Approved_leave_becomes_planned_leave_linked_to_the_request()
    {
        var (owner, _, member) = await TeamAsync("Leave");
        var from = DateTime.UtcNow.Date.AddDays(20);
        var to = from.AddDays(2);
        var req = await member.Post("/api/v1/approvals", new
        {
            type = "Leave", title = "Leave · 3 days",
            payload = new Dictionary<string, string> { ["from"] = from.ToString("yyyy-MM-dd"), ["to"] = to.ToString("yyyy-MM-dd"), ["kind"] = "Annual leave", ["note"] = "Family visit" },
            chain = new object[] { new { role = "Owner" } },
        });
        Assert.True(req.Status == HttpStatusCode.Created, req.ToString());
        var id = S(req.Data!["id"]);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await member.Post("/api/v1/approvals", new { type = "Leave", title = "No dates" })).Status);

        var approved = await owner.Post($"/api/v1/approvals/{id}/decide", new { action = "approve" });
        Assert.True(approved.Ok, approved.ToString());
        Assert.Equal("Approved", S(approved.Data!["status"]));
        Assert.Equal($"PlannedLeave:{id}", S(approved.Data["outcome"]));
        var leave = await owner.Get($"/api/v1/time/leave?from={from:yyyy-MM-dd}&to={to:yyyy-MM-dd}&userId={member.UserId}");
        Assert.True(leave.Ok, leave.ToString());
        Assert.Equal(3, leave.Data!.AsArray().Count);
    }
}
