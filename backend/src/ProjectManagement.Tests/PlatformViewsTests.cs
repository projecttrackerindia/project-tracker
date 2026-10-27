using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// History of every field (who, when, old → new), bulk edit through one endpoint, shared saved views, the public API status page, data
/// location with "Keep data in India", and public holidays in capacity. Made-up companies and people only.
/// </summary>
[Collection("api")]
public class PlatformViewsTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static int I(JsonNode? n) => n!.GetValue<int>();
    private static DateOnly Today => AppDay.Today;
    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd");

    private sealed record World(TestClient Owner, TestClient Dev, TestClient Other, Guid Project, string BugFix);

    private async Task<World> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Tara Tenali");
        await owner.CreateOrgAsync("Kestrel Lending");
        await owner.UpgradeAsync("BUSINESS");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Dorai");
        var other = await owner.AddMemberAsync(factory, TenantRole.Member, "Omi Outside");
        var project = await owner.CreateProjectAsync("Loan Ledger");
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = dev.UserId })).Ok);
        var types = (await owner.Get("/api/v1/work-types?includeInactive=true")).Data!.AsArray();
        var bugFix = S(types.First(t => S(t!["name"]) == "Bug Fix")!["id"]);
        return new World(owner, dev, other, project, bugFix);
    }

    private static async Task<JsonNode> New(TestClient c, object body)
    {
        var r = await c.Post("/api/v1/work-items", body);
        Assert.True(r.Status == HttpStatusCode.Created, r.ToString());
        return r.Data!;
    }

    // ------------------------------------------------------------------ history

    [Fact]
    public async Task Every_field_change_shows_in_the_history_with_who_when_and_old_to_new()
    {
        var w = await Setup();
        var task = await New(w.Owner, new { kind = "task", projectId = w.Project, title = "Reconcile EMI ledger", priority = "Medium" });
        var id = S(task["id"]);
        var patched = await w.Owner.Patch($"/api/v1/work-items/{id}", new { version = I(task["version"]), priority = "High", assigneeId = w.Dev.UserId, title = "Reconcile the EMI ledger" });
        Assert.True(patched.Ok, patched.ToString());

        var history = await w.Owner.Get($"/api/v1/work-items/{id}/history");
        Assert.True(history.Ok, history.ToString());
        var rows = history.Data!.AsArray();
        var priority = rows.Single(r => S(r!["field"]) == "Priority")!;
        Assert.Equal("Medium", S(priority["from"]));
        Assert.Equal("High", S(priority["to"]));
        Assert.Equal("Tara Tenali", S(priority["actor"]!["name"]));
        Assert.Contains(rows, r => S(r!["field"]) == "Assignee" && r["from"] is null && S(r["to"]) == "Dev Dorai");
        Assert.Contains(rows, r => S(r!["field"]) == "Title" && S(r["to"]) == "Reconcile the EMI ledger");

        // A ticket's changes too, and nobody outside the workspace (or who cannot see the item) reads them.
        var ticket = await New(w.Owner, new { kind = "ticket", workTypeId = w.BugFix, title = "Statement PDF blank", priority = "Low" });
        var tid = S(ticket["id"]);
        Assert.True((await w.Owner.Patch($"/api/v1/work-items/{tid}", new { version = I(ticket["version"]), status = "InProgress", dueDate = Iso(Today.AddDays(3)) })).Ok);
        var th = (await w.Owner.Get($"/api/v1/work-items/{tid}/history")).Data!.AsArray();
        Assert.Contains(th, r => S(r!["field"]) == "Status" && S(r["from"]) == "To Do");
        Assert.Contains(th, r => S(r!["field"]) == "Due date" && S(r["to"]) == Iso(Today.AddDays(3)));
        var stranger = await TestClient.RegisterAsync(factory, "Sid Stranger");
        await stranger.CreateOrgAsync();
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.Get($"/api/v1/work-items/{id}/history")).Status);

        // A project's history: its status set by hand.
        Assert.True((await w.Owner.Put($"/api/v1/projects/{w.Project}/health", new { health = "AtRisk", note = "Bank sandbox is down" })).Ok);
        var ph = (await w.Owner.Get($"/api/v1/projects/{w.Project}/history")).Data!.AsArray();
        Assert.Contains(ph, r => S(r!["field"]) == "Health" && S(r["to"]) == "AtRisk");
    }

    // ------------------------------------------------------------------ bulk edit

    [Fact]
    public async Task Bulk_edit_changes_what_each_person_may_change_and_reports_the_rest()
    {
        var w = await Setup();
        var a = S((await New(w.Owner, new { kind = "task", projectId = w.Project, title = "Bulk A" }))["id"]);
        var b = S((await New(w.Owner, new { kind = "task", projectId = w.Project, title = "Bulk B" }))["id"]);
        var t = S((await New(w.Owner, new { kind = "ticket", workTypeId = w.BugFix, title = "Bulk ticket" }))["id"]);

        var res = await w.Owner.Post("/api/v1/work-items/bulk", new { ids = new[] { a, b, t }, priority = "Critical", assigneeId = w.Dev.UserId, dueDate = Iso(Today.AddDays(5)) });
        Assert.True(res.Ok, res.ToString());
        Assert.Equal(3, I(res.Data!["changed"]));
        Assert.Empty(res.Data["failed"]!.AsArray());
        var row = (await w.Owner.Get($"/api/v1/work-items/{a}")).Data!;
        Assert.Equal("Critical", S(row["priority"]));
        Assert.Equal(w.Dev.UserId.ToString(), S(row["assignee"]!["id"]));

        // Status as a category, in each kind's own words; one audit entry per changed item.
        var done = await w.Owner.Post("/api/v1/work-items/bulk", new { ids = new[] { a, t }, status = "active" });
        Assert.Equal(2, I(done.Data!["changed"]));
        Assert.Equal("In Progress", S((await w.Owner.Get($"/api/v1/work-items/{t}")).Data!["status"]));
        var touched = new[] { Guid.Parse(a), Guid.Parse(b), Guid.Parse(t) };
        var audits = factory.WithDb(db => db.AuditLogs.Count(x => x.Action == "workitem.bulk_updated" && x.EntityId != null && touched.Contains(x.EntityId.Value)));
        Assert.Equal(5, audits);

        // Labels are for tasks; a ticket says why it was left out.
        var label = await w.Owner.Post("/api/v1/labels", new { name = "Regulatory", color = "#ff9500" });
        Assert.True(label.Ok, label.ToString());
        var labelled = await w.Owner.Post("/api/v1/work-items/bulk", new { ids = new[] { b, t }, labelIds = new[] { S(label.Data!["id"]) } });
        Assert.Equal(1, I(labelled.Data!["changed"]));
        Assert.Contains("Only tasks have labels", S(labelled.Data["failed"]![0]!["reason"]));

        // A guest who is not on the project cannot see its tasks, so changes nothing of them.
        var guest = await w.Owner.AddMemberAsync(factory, TenantRole.Guest, "Gita Guest");
        var outside = await guest.Post("/api/v1/work-items/bulk", new { ids = new[] { a, b }, priority = "Low" });
        Assert.True(outside.Ok, outside.ToString());
        Assert.Equal(0, I(outside.Data!["changed"]));
        Assert.Equal(2, outside.Data["failed"]!.AsArray().Count);

        // Limits and delete.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await w.Owner.Post("/api/v1/work-items/bulk", new { ids = Enumerable.Range(0, 201).Select(_ => Guid.NewGuid()).ToArray(), priority = "Low" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await w.Owner.Post("/api/v1/work-items/bulk", new { ids = new[] { a } })).Status);
        var deleted = await w.Owner.Post("/api/v1/work-items/bulk", new { ids = new[] { b, t }, delete = true });
        Assert.Equal(2, I(deleted.Data!["changed"]));
        Assert.Equal(HttpStatusCode.NotFound, (await w.Owner.Get($"/api/v1/work-items/{b}")).Status);
    }

    // ------------------------------------------------------------------ saved views

    [Fact]
    public async Task Saved_views_are_private_or_shared_and_only_their_owner_changes_them()
    {
        var w = await Setup();
        var mine = await w.Dev.Post("/api/v1/saved-views", new { scope = "work", name = "My critical", sharing = "private", config = new { group = "status", sort = "priority", kind = "task" } });
        Assert.True(mine.Status == HttpStatusCode.Created, mine.ToString());
        var shared = await w.Dev.Post("/api/v1/saved-views", new { scope = "work", name = "Loan Ledger overdue", sharing = "workspace", config = new { overdue = true } });
        Assert.True(shared.Ok, shared.ToString());
        Assert.Equal("workspace", S(shared.Data!["sharing"]));
        Assert.Equal("priority", S(mine.Data!["config"]!["sort"]));

        var seen = (await w.Other.Get("/api/v1/saved-views?scope=work")).Data!.AsArray();
        Assert.Single(seen);
        Assert.Equal("Loan Ledger overdue", S(seen[0]!["name"]));
        Assert.False(seen[0]!["mine"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.Forbidden, (await w.Other.Delete($"/api/v1/saved-views/{S(shared.Data["id"])}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await w.Other.Delete($"/api/v1/saved-views/{S(mine.Data["id"])}")).Status);
        Assert.Empty((await w.Other.Get("/api/v1/saved-views?scope=desk")).Data!.AsArray());

        // Team sharing needs a team the person is in; names and scopes are checked.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await w.Dev.Post("/api/v1/saved-views", new { scope = "work", name = new string('x', 81) })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await w.Dev.Post("/api/v1/saved-views", new { scope = "calendar", name = "Nope" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await w.Dev.Post("/api/v1/saved-views", new { scope = "desk", name = "Team", sharing = "team" })).Status);

        var renamed = await w.Dev.Put($"/api/v1/saved-views/{S(mine.Data["id"])}", new { name = "Critical tasks", sharing = "private", config = new { sort = "due" } });
        Assert.True(renamed.Ok, renamed.ToString());
        Assert.Equal("Critical tasks", S(renamed.Data!["name"]));
        Assert.True((await w.Dev.Delete($"/api/v1/saved-views/{S(mine.Data["id"])}")).Ok);
        Assert.True((await w.Owner.Delete($"/api/v1/saved-views/{S(shared.Data["id"])}")).Ok);   // an admin tidies shared views
    }

    // ------------------------------------------------------------------ public status page

    [Fact]
    public async Task The_status_page_shows_chosen_apis_with_incidents_and_never_hosts_or_secrets()
    {
        var w = await Setup();
        var docType = Guid.Parse(S((await w.Owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "API")!["id"]));
        var doc = await w.Owner.Post("/api/v1/documents", new { title = "Collections API", typeId = docType, visibility = "Organization" });
        Assert.True(doc.Ok, doc.ToString());
        var docId = S(doc.Data!["item"]!["id"]);
        var def = await w.Owner.Post($"/api/v1/documents/{docId}/api/definitions", new { name = "Collections", version = "v1", auth = "Bearer", servers = new[] { "https://collections.internal.kestrel.in" } });
        Assert.True(def.Ok, def.ToString());
        var apiId = S(def.Data!["definitions"]!.AsArray().First(d => S(d!["name"]) == "Collections")!["id"]);

        var settings = await w.Owner.Get("/api/v1/status-page");
        Assert.True(settings.Ok, settings.ToString());
        Assert.Contains(settings.Data!["available"]!.AsArray(), a => S(a!["apiId"]) == apiId);
        Assert.Equal(HttpStatusCode.Forbidden, (await w.Dev.Get("/api/v1/status-page")).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await w.Owner.Put("/api/v1/status-page", new { slug = "kestrel-status", title = "Kestrel status", published = true, components = Array.Empty<object>() })).Status);

        var slug = $"kestrel-{Guid.NewGuid():N}"[..20];
        var saved = await w.Owner.Put("/api/v1/status-page", new { slug, title = "Kestrel API status", published = false, components = new[] { new { apiId, name = "Collections API" } } });
        Assert.True(saved.Ok, saved.ToString());
        var anon = new TestClient(factory);
        Assert.Equal(HttpStatusCode.NotFound, (await anon.Get($"/api/v1/public/status/{slug}")).Status);   // not published yet

        Assert.True((await w.Owner.Put("/api/v1/status-page", new { slug, title = "Kestrel API status", published = true, components = new[] { new { apiId, name = "Collections API" } } })).Ok);
        var page = await anon.Get($"/api/v1/public/status/{slug}");
        Assert.True(page.Ok, page.ToString());
        Assert.Equal("operational", S(page.Data!["state"]));
        var component = page.Data["components"]![0]!;
        Assert.Equal("Collections API", S(component["name"]));
        Assert.Equal(90, component["days"]!.AsArray().Count);
        Assert.Equal(100m, component["uptime"]!.GetValue<decimal>());

        // A critical ticket naming the API is an outage; its title is shown without hosts, addresses or keys.
        await New(w.Owner, new { kind = "ticket", workTypeId = w.BugFix, priority = "Critical",
            title = "Collections API timeouts from collections.internal.kestrel.in 10.2.3.4 token=abcd1234 ops@kestrel.in" });
        var down = await anon.Get($"/api/v1/public/status/{slug}");
        Assert.Equal("outage", S(down.Data!["state"]));
        var text = down.Data.ToJsonString();
        Assert.DoesNotContain("kestrel.in", text);
        Assert.DoesNotContain("10.2.3.4", text);
        Assert.DoesNotContain("abcd1234", text);
        Assert.DoesNotContain("Dev Dorai", text);
        Assert.Equal("down", S(down.Data["components"]![0]!["days"]!.AsArray().Last()!["state"]));
        Assert.Contains("timeouts", S(down.Data["incidents"]![0]!["title"]));

        // A slug belongs to one workspace.
        var rival = await TestClient.RegisterAsync(factory, "Rita Rival");
        await rival.CreateOrgAsync();
        Assert.Equal(HttpStatusCode.Conflict, (await rival.Put("/api/v1/status-page", new { slug, title = "Mine", published = false, components = Array.Empty<object>() })).Status);
    }

    // ------------------------------------------------------------------ data location

    [Fact]
    public async Task Keep_data_in_India_blocks_turning_on_providers_that_work_elsewhere()
    {
        var w = await Setup();
        var info = await w.Dev.Get("/api/v1/settings/data-location");
        Assert.True(info.Ok, info.ToString());
        Assert.Equal("asia-south1", S(info.Data!["region"]));
        Assert.Contains("India", S(info.Data["regionName"]));
        Assert.False(info.Data["keepDataInIndia"]!.GetValue<bool>());
        Assert.False(info.Data["canManage"]!.GetValue<bool>());
        Assert.Contains(info.Data["providers"]!.AsArray(), p => S(p!["key"]) == "openai" && !p["inIndia"]!.GetValue<bool>());
        Assert.DoesNotContain("postgres", info.Data.ToJsonString(), StringComparison.OrdinalIgnoreCase);

        Assert.Equal(HttpStatusCode.Forbidden, (await w.Dev.Put("/api/v1/settings/data-location", new { keepDataInIndia = true })).Status);
        var on = await w.Owner.Put("/api/v1/settings/data-location", new { keepDataInIndia = true });
        Assert.True(on.Ok, on.ToString());
        Assert.True(on.Data!["keepDataInIndia"]!.GetValue<bool>());

        var ai = await w.Owner.Put("/api/v1/workspace/ai-provider", new { provider = "openai", apiKey = "sk-test-" + new string('a', 40), quickModel = "gpt-4o-mini", standardModel = "gpt-4o", deepModel = "gpt-4o", enabled = true, fallbackToPlatform = true });
        Assert.Equal(HttpStatusCode.Forbidden, ai.Status);
        Assert.Equal("DATA_LOCATION_INDIA", ai.ErrorCode);
        Assert.Contains("keeps its data in India", ai.ToString());
        Assert.True(factory.WithDb(db => db.AuditLogs.Any(a => a.Action == "org.data_location_changed" && a.TenantId == w.Owner.WorkspaceId)));
    }

    // ------------------------------------------------------------------ holidays and capacity

    [Fact]
    public async Task Public_holidays_are_days_off_in_the_capacity_plan()
    {
        var w = await Setup();
        Assert.Equal(HttpStatusCode.Forbidden, (await w.Dev.Post("/api/v1/holidays", new { date = Iso(Today), name = "Founders Day" })).Status);
        var preset = await w.Owner.Post("/api/v1/holidays/preset", new { country = "IN", year = 2026 });
        Assert.True(preset.Ok, preset.ToString());
        Assert.True(I(preset.Data!["added"]) >= 15);
        Assert.Contains(preset.Data["holidays"]!.AsArray(), h => S(h!["date"]) == "2026-08-15" && S(h["name"]) == "Independence Day");
        var again = await w.Owner.Post("/api/v1/holidays/preset", new { country = "IN", year = 2026 });
        Assert.Equal(0, I(again.Data!["added"]));

        // A workspace's own holiday on the Wednesday of the week after next.
        var monday = Today.AddDays(-(((int)Today.DayOfWeek + 6) % 7) + 14);
        var wednesday = monday.AddDays(2);
        var added = await w.Owner.Post("/api/v1/holidays", new { date = Iso(wednesday), name = "Kestrel Foundation Day", region = "Telangana" });
        Assert.True(added.Status == HttpStatusCode.Created, added.ToString());
        Assert.Equal(HttpStatusCode.Conflict, (await w.Owner.Post("/api/v1/holidays", new { date = Iso(wednesday), name = "Kestrel Foundation Day" })).Status);
        Assert.Contains((await w.Dev.Get($"/api/v1/holidays?year={wednesday.Year}")).Data!.AsArray(), h => S(h!["name"]) == "Kestrel Foundation Day");

        var plan = await w.Owner.Get($"/api/v1/resources/plan?from={Iso(monday)}&weeks=1");
        Assert.True(plan.Ok, plan.ToString());
        var cell = plan.Data!["people"]!.AsArray().Single(p => S(p!["userId"]) == w.Owner.UserId.ToString())!["weeks"]![0]!;
        var holidaysThatWeek = factory.WithDb(db => db.Holidays.IgnoreQueryFilters().Count(h => h.TenantId == w.Owner.WorkspaceId && h.Date >= monday && h.Date <= monday.AddDays(4)));
        Assert.Equal(holidaysThatWeek, I(cell["holidayDays"]));
        Assert.Equal(5 - holidaysThatWeek, I(cell["workingDays"]));
        Assert.Equal(40 * 60 * (5 - holidaysThatWeek) / 5, I(cell["capacityMinutes"]));
        Assert.True(I(plan.Data["totals"]!["publicHolidays"]) >= 1);

        var id = S(added.Data!["id"]);
        Assert.True((await w.Owner.Delete($"/api/v1/holidays/{id}")).Ok);
    }
}
