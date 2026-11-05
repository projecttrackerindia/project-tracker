using System.Net;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.Insights;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The admin's audit-log viewer: filters, CSV export (itself audited, formula-safe) and strict workspace isolation.</summary>
[Collection("api")]
public class AuditViewerTests(ApiFactory factory)
{
    private static void Seed(ApiFactory f, Guid tenantId, Guid? userId, string action, string entityType, DateTime at, string? newValue = null) =>
        f.WithDb(db =>
        {
            db.AuditLogs.Add(new AuditLog { TenantId = tenantId, UserId = userId, Action = action, EntityType = entityType, EntityId = Guid.NewGuid(), CreatedAt = at, NewValue = newValue, IpAddress = "203.0.113.7" });
            return db.SaveChanges();
        });

    private async Task<(TestClient Owner, TestClient Admin, TestClient Member)> OrgAsync()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var admin = await owner.AddMemberAsync(factory, TenantRole.Admin, "Audit Admin");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Plain Member");
        return (owner, admin, member);
    }

    [Fact]
    public async Task Admins_filter_by_kind_person_resource_and_dates()
    {
        var (owner, admin, member) = await OrgAsync();
        var t = owner.WorkspaceId;
        var now = DateTime.UtcNow;
        Seed(factory, t, admin.UserId, "vault.revealed", "VaultItem", now.AddMinutes(-5));
        Seed(factory, t, admin.UserId, "portfolio.exported", "Project", now.AddMinutes(-4));
        Seed(factory, t, owner.UserId, "project.updated", "Project", now.AddMinutes(-3));
        Seed(factory, t, member.UserId, "user.login", "User", now.AddMinutes(-2));
        Seed(factory, t, owner.UserId, "project.updated", "Project", now.AddDays(-40));

        async Task<List<string>> Actions(string query) =>
            (await admin.Get($"/api/v1/audit?{query}")).Data!["items"]!.AsArray().Select(i => i!["action"]!.GetValue<string>()).ToList();

        Assert.Contains("vault.revealed", await Actions("kind=viewed"));
        Assert.DoesNotContain("portfolio.exported", await Actions("kind=viewed"));
        Assert.Equal(["portfolio.exported"], await Actions("kind=exported"));
        Assert.Contains("user.login", await Actions("kind=signin"));
        var changed = await Actions("kind=changed");
        Assert.Contains("project.updated", changed);
        Assert.DoesNotContain("vault.revealed", changed);
        Assert.DoesNotContain("user.login", changed);

        var byAdmin = await Actions($"userId={admin.UserId}");
        Assert.Contains("vault.revealed", byAdmin);
        Assert.DoesNotContain("project.updated", byAdmin);
        Assert.All(await Actions("entityType=Project"), a => Assert.True(a.StartsWith("project.") || a == "portfolio.exported", a));
        var from = DateOnly.FromDateTime(now.AddDays(-1)).ToString("yyyy-MM-dd");
        Assert.Single((await Actions($"entityType=Project&kind=changed&from={from}")).Where(a => a == "project.updated"));
        Assert.Equal(2, (await Actions("entityType=Project&kind=changed")).Count(a => a == "project.updated"));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await admin.Get("/api/v1/audit?kind=nonsense")).Status);

        var facets = (await admin.Get("/api/v1/audit/facets")).Data!;
        Assert.Contains(facets["people"]!.AsArray(), p => p!["name"]!.GetValue<string>() == "Audit Admin");
        Assert.Contains(facets["entityTypes"]!.AsArray(), e => e!.GetValue<string>() == "VaultItem");
    }

    [Fact]
    public async Task Members_cannot_read_the_audit_log()
    {
        var (_, _, member) = await OrgAsync();
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get("/api/v1/audit")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get("/api/v1/audit/export")).Status);
    }

    [Fact]
    public async Task Another_workspace_never_appears_in_the_list_facets_or_export()
    {
        var (owner, admin, _) = await OrgAsync();
        var other = await TestClient.RegisterAsync(factory, "Zebra Outsider");
        await other.CreateOrgAsync();
        Seed(factory, other.WorkspaceId, other.UserId, "project.updated", "ZebraSecretThing", DateTime.UtcNow, "zebra-marker");
        Seed(factory, owner.WorkspaceId, owner.UserId, "project.updated", "Project", DateTime.UtcNow, "ours-marker");

        var list = (await admin.Get("/api/v1/audit?pageSize=200")).Data!.ToJsonString();
        Assert.Contains("ours-marker", list);
        Assert.DoesNotContain("zebra-marker", list);
        Assert.DoesNotContain("ZebraSecretThing", (await admin.Get("/api/v1/audit/facets")).Data!.ToJsonString());
        Assert.DoesNotContain("Zebra Outsider", (await admin.Get("/api/v1/audit/facets")).Data!.ToJsonString());
        var csv = await (await admin.Raw("/api/v1/audit/export")).Content.ReadAsStringAsync();
        Assert.Contains("ours-marker", csv);
        Assert.DoesNotContain("zebra-marker", csv);
    }

    [Fact]
    public async Task The_csv_export_is_formula_safe_and_leaves_its_own_trace()
    {
        var (owner, admin, _) = await OrgAsync();
        Seed(factory, owner.WorkspaceId, owner.UserId, "project.updated", "Project", DateTime.UtcNow, "=HYPERLINK(\"http://evil\")");
        var res = await admin.Raw("/api/v1/audit/export?kind=changed");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("text/csv", res.Content.Headers.ContentType!.MediaType);
        var text = await res.Content.ReadAsStringAsync();
        Assert.StartsWith("When (UTC),Who,Email,Action", text.TrimStart('﻿'));
        Assert.Contains("\"'=HYPERLINK(\"\"http://evil\"\")\"", text);
        var tenant = owner.WorkspaceId;
        Assert.Equal(1, factory.WithDb(db => db.AuditLogs.Count(a => a.TenantId == tenant && a.Action == "audit.exported" && a.UserId == admin.UserId)));
    }

    [Theory]
    [InlineData(null, "")]
    [InlineData("plain", "plain")]
    [InlineData("a,b", "\"a,b\"")]
    [InlineData("-1+2", "'-1+2")]
    [InlineData("@cmd", "'@cmd")]
    public void Cells_are_quoted_and_defused(string? value, string expected) => Assert.Equal(expected, AuditViewerService.Cell(value));
}
