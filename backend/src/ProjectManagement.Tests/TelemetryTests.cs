using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Api.Logging;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Error relay and real-user speed: off without a DSN, kept per workspace, readable only by its admins.</summary>
[Collection("api")]
public class TelemetryTests(ApiFactory factory)
{
    private static object Beacon(string page, string device, double lcp) => new
    {
        page, device,
        metrics = new object[] { new { name = "LCP", value = lcp }, new { name = "CLS", value = 0.02 }, new { name = "bogus", value = 1 }, new { name = "INP", value = -5 } },
    };

    [Fact]
    public async Task Config_and_errors_work_signed_out_and_report_nothing_without_a_dsn()
    {
        var c = new TestClient(factory);
        var cfg = await c.Get("/api/v1/telemetry/config");
        Assert.True(cfg.Ok, cfg.ToString());
        Assert.False(cfg.Data!["errors"]!.GetValue<bool>());

        var sent = await c.Post("/api/v1/telemetry/errors", new { type = "TypeError", message = "x is undefined", stack = "at a (app.js:1:2)", page = "/tasks", app = "web" });
        Assert.Equal(HttpStatusCode.Accepted, sent.Status);
        Assert.False(sent.Data!["reported"]!.GetValue<bool>());

        var empty = await c.Post("/api/v1/telemetry/errors", new { page = "/" });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, empty.Status);
    }

    [Fact]
    public async Task Vitals_are_kept_per_workspace_and_only_admins_read_them()
    {
        var owner = await TestClient.RegisterAsync(factory, "Vitals Owner");
        var page = $"/projects/{Guid.NewGuid()}/board?view=1";
        var kept = await owner.Post("/api/v1/telemetry/vitals", Beacon(page, "mobile", 1800));
        Assert.Equal(HttpStatusCode.Accepted, kept.Status);
        Assert.Equal(2, kept.Data!["kept"]!.GetValue<int>());   // the unknown metric and the negative value are dropped

        var report = await owner.Get("/api/v1/telemetry/vitals");
        Assert.True(report.Ok, report.ToString());
        var rows = report.Data!["rows"]!.AsArray();
        var lcp = Assert.Single(rows, r => r!["metric"]!.GetValue<string>() == "LCP");
        Assert.Equal("/projects/:id/board", lcp!["page"]!.GetValue<string>());
        Assert.Equal("mobile", lcp["device"]!.GetValue<string>());
        Assert.Equal("good", lcp["rating"]!.GetValue<string>());

        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Vitals Member");
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get("/api/v1/telemetry/vitals")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.Get("/api/v1/telemetry/vitals?all=true")).Status);

        var other = await TestClient.RegisterAsync(factory, "Other Owner");
        var theirs = await other.Get("/api/v1/telemetry/vitals");
        Assert.True(theirs.Ok, theirs.ToString());
        Assert.Empty(theirs.Data!["rows"]!.AsArray());

        factory.WithDb(db => { db.Users.First(u => u.Id == other.UserId).IsPlatformAdmin = true; db.SaveChanges(); return 0; });
        var all = await other.Get("/api/v1/telemetry/vitals?all=true");
        Assert.True(all.Ok, all.ToString());
        Assert.Contains(all.Data!["rows"]!.AsArray(), r => r!["page"]!.GetValue<string>() == "/projects/:id/board");

        Assert.Equal(HttpStatusCode.Unauthorized, (await new TestClient(factory).Post("/api/v1/telemetry/vitals", Beacon("/", "desktop", 1))).Status);
    }

    [Fact]
    public void Store_normalizes_pages_rates_and_computes_p75()
    {
        var now = new DateTime(2026, 11, 5, 10, 0, 0, DateTimeKind.Utc);
        var store = new WebVitalsStore(() => now);
        var t = Guid.NewGuid();
        Assert.Equal("/tasks/:id", WebVitalsStore.NormalizePage("/Tasks/12345?q=secret#x"));
        Assert.Equal("/", WebVitalsStore.NormalizePage(null));
        for (var i = 1; i <= 100; i++) store.Record(t, new WebVitalsBeacon("/inbox", "desktop", [new WebVitalSample("LCP", i * 50)]));
        var row = Assert.Single(store.Report(t).Rows);
        Assert.Equal(3750, row.P75);
        Assert.Equal("needs-improvement", row.Rating);
        Assert.Empty(store.Report(Guid.NewGuid()).Rows);
        now = now.AddDays(8);
        Assert.Empty(store.Report(t).Rows);
    }
}
