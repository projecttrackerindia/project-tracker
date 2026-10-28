using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Today's "Team &amp; portfolio signals" (GET /api/v1/today/signals): projects at risk with their reason and owner, the team's overdue work for a
/// manager only, pages out of date in the caller's reach and Desk SLA breaches - each with one action the caller may take, scoped per person.
/// </summary>
[Collection("api")]
public class TodaySignalsTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static JsonNode? Group(JsonNode data, string kind) => data["groups"]!.AsArray().FirstOrDefault(g => S(g!["kind"]) == kind);

    [Fact]
    public async Task Signals_are_scoped_to_what_the_caller_watches_and_carry_one_action()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olive Orchard");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var manager = await owner.AddMemberAsync(factory, TenantRole.Manager, "Mira Mehta");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Devan Rao");
        var peer = await owner.AddMemberAsync(factory, TenantRole.Member, "Pia Quill");
        Assert.True((await owner.Put($"/api/v1/org/members/{dev.UserId}/reports-to", new { reportsToUserId = manager.UserId })).Ok);

        var project = await owner.CreateProjectAsync("Harbor Rollout");
        var health = await owner.Put($"/api/v1/projects/{project}/health", new { health = "AtRisk", note = "Vendor slipped the gateway drop" });
        Assert.True(health.Ok, health.ToString());
        var task = Guid.Parse(S((await owner.CreateTaskAsync(project, "Wire the gateway", new { title = "Wire the gateway", priority = "High", assigneeId = dev.UserId }))["id"]));

        var type = S((await owner.Get("/api/v1/document-types")).Data!.AsArray()[0]!["id"]);
        var doc = await owner.Post("/api/v1/documents", new { title = "Gateway runbook", typeId = type, visibility = "Organization" });
        Assert.True(doc.Ok, doc.ToString());
        var docId = Guid.Parse(S(doc.Data!["item"]!["id"]));

        var types = (await owner.Get("/api/v1/work-types?includeInactive=true")).Data!.AsArray();
        var ticket = await owner.Post("/api/v1/work-tasks", new { title = "Payments down for a branch", priority = "Critical", workTypeId = S(types[0]!["id"]) });
        Assert.True(ticket.Ok, ticket.ToString());
        var ticketId = Guid.Parse(S(ticket.Data!["id"]));

        factory.WithDb(db =>
        {
            var today = DateOnly.FromDateTime(DateTime.UtcNow);
            db.Tasks.IgnoreQueryFilters().First(t => t.Id == task).DueDate = today.AddDays(-3);
            var d = db.Documents.IgnoreQueryFilters().First(x => x.Id == docId);
            d.OwnerId = dev.UserId; d.StaleSince = DateTime.UtcNow.AddDays(-2); d.StaleReason = "HAR-1 “Wire the gateway” changed after this page was last edited.";
            var w = db.WorkTasks.IgnoreQueryFilters().First(x => x.Id == ticketId);
            w.AssigneeId = dev.UserId; w.ResolutionDueAt = DateTime.UtcNow.AddHours(-5); w.ResponseDueAt = DateTime.UtcNow.AddHours(-6); w.RespondedAt = DateTime.UtcNow.AddHours(-5.5);
            return db.SaveChanges();
        });

        // The owner: the project at risk with the reason given by hand; theirs, so the action opens it.
        var mine = await owner.Get("/api/v1/today/signals");
        Assert.True(mine.Ok, mine.ToString());
        var risk = Group(mine.Data!, "risk");
        Assert.NotNull(risk);
        var card = risk!["items"]!.AsArray().First(i => S(i!["title"]).Contains("Harbor Rollout"))!;
        Assert.Contains("Vendor slipped", S(card["reason"]));
        Assert.Equal("open", S(card["action"]!["verb"]));
        Assert.Equal("Olive Orchard", S(card["owner"]!["name"]));
        Assert.Null(Group(mine.Data!, "team"));   // nobody reports to the owner

        // The manager: Devan's overdue work, Devan's page out of date and Devan's breached ticket, each asking Devan.
        var lead = (await manager.Get("/api/v1/today/signals")).Data!;
        var team = Group(lead, "team")!;
        Assert.Equal(1, team["count"]!.GetValue<int>());
        var devCard = team["items"]!.AsArray()[0]!;
        Assert.Equal("Devan Rao", S(devCard["owner"]!["name"]));
        Assert.Equal("ask", S(devCard["action"]!["verb"]));
        Assert.Equal(dev.UserId.ToString(), S(devCard["action"]!["userId"]));
        Assert.Contains("1 overdue", S(devCard["reason"]));
        var docs = Group(lead, "docs")!;
        Assert.Contains("Gateway runbook", S(docs["items"]!.AsArray()[0]!["title"]));
        Assert.Equal("Ask Devan to review", S(docs["items"]!.AsArray()[0]!["action"]!["label"]));
        var sla = Group(lead, "sla")!;
        Assert.Contains("resolution target missed", S(sla["items"]!.AsArray()[0]!["reason"]));
        Assert.True(lead["total"]!.GetValue<int>() >= 3);

        // Devan: their own page is theirs to review (no "ask"), their ticket opens.
        var self = (await dev.Get("/api/v1/today/signals")).Data!;
        Assert.Equal("review", S(Group(self, "docs")!["items"]!.AsArray()[0]!["action"]!["verb"]));
        Assert.Null(Group(self, "team"));

        // A peer outside the line and the project: none of it.
        var other = (await peer.Get("/api/v1/today/signals")).Data!;
        Assert.Null(Group(other, "team"));
        Assert.Null(Group(other, "docs"));
        Assert.Null(Group(other, "sla"));
        Assert.DoesNotContain(Group(other, "risk")?["items"]?.AsArray() ?? new JsonArray(), i => S(i!["title"]).Contains("Harbor Rollout"));
    }
}
