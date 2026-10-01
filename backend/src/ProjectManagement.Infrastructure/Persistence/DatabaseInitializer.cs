using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Features.Admin;
using ProjectManagement.Application.Features.Billing;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Features.Organization;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Features.Teams;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using IPasswordHasher = ProjectManagement.Application.Abstractions.IPasswordHasher;

namespace ProjectManagement.Infrastructure.Persistence;

public static class DatabaseInitializer
{
    /// <summary>Creates / migrates the schema, seeds plans, then optional platform admin and demo data.</summary>
    public static async Task InitializeAsync(IServiceProvider services, CancellationToken ct = default)
    {
        using var scope = services.CreateScope();
        var sp = scope.ServiceProvider;
        var config = sp.GetRequiredService<IConfiguration>();
        var log = sp.GetRequiredService<ILoggerFactory>().CreateLogger("DatabaseInitializer");
        var db = sp.GetRequiredService<AppDbContext>();

        if (db.Database.IsSqlite())
        {
            await db.Database.EnsureCreatedAsync(ct);
            await db.Database.ExecuteSqlRawAsync("PRAGMA journal_mode=WAL;", ct);
        }
        else if (config.GetValue("Database:AutoMigrate", true))
            await db.Database.MigrateAsync(ct);

        await SeedPlansAsync(db, ct, config, log);
        await BackfillProjectGroupsAsync(db, log, ct);

        // Platform administrators to bootstrap: the single Seed:AdminEmail / Seed:AdminPassword pair, and/or a list under
        // Seed:Admins (Seed__Admins__0__Email, __Password and optionally __Name, then __1__..., as environment variables).
        // Existing accounts are left alone, so this is safe to leave configured, but the passwords do not need to stay there.
        var admins = new List<(string Email, string Password, string Name)>();
        if (!string.IsNullOrWhiteSpace(config["Seed:AdminEmail"]) && !string.IsNullOrWhiteSpace(config["Seed:AdminPassword"]))
            admins.Add((config["Seed:AdminEmail"]!, config["Seed:AdminPassword"]!, "Platform Admin"));
        foreach (var a in config.GetSection("Seed:Admins").GetChildren())
            if (!string.IsNullOrWhiteSpace(a["Email"]) && !string.IsNullOrWhiteSpace(a["Password"]))
                admins.Add((a["Email"]!, a["Password"]!, string.IsNullOrWhiteSpace(a["Name"]) ? "Platform Admin" : a["Name"]!.Trim()));
        foreach (var (email, password, name) in admins)
            await SeedAdminAsync(sp, email, password, name, ct);

        if (config.GetValue("Seed:Demo", false))
        {
            try { await DemoSeeder.SeedAsync(services, ct); }
            catch (Exception ex) { log.LogError(ex, "Demo data seeding failed"); }
        }
    }

    // name, description, monthly price (null = custom), sort, features
    private static readonly (string Code, string Name, string Description, decimal? Price, int Sort, Dictionary<string, long> Features)[] PlanCatalog =
    [
        ("FREE", "Free", "For individuals getting started.", 0m, 0, new()
        {
            [FeatureKeys.ProjectLimit] = 5, [FeatureKeys.TaskLimit] = 500, [FeatureKeys.MaxMembers] = 1, [FeatureKeys.MaxTeams] = 1,
            [FeatureKeys.ActivityRetentionDays] = 30, [FeatureKeys.AdvancedReports] = 0, [FeatureKeys.CustomWorkflows] = 0,
            [FeatureKeys.ApiAccess] = 0, [FeatureKeys.CustomFields] = 0, [FeatureKeys.Automation] = 0, [FeatureKeys.AdvancedPermissions] = 0, [FeatureKeys.AuditLog] = 0,
            [FeatureKeys.StorageLimitMb] = 500, [FeatureKeys.MaxFileSizeMb] = 10, [FeatureKeys.AdvancedSecurity] = 0,
            [FeatureKeys.ResourceManagement] = 0, [FeatureKeys.ServiceLevels] = 0,
        }),
        ("PRO", "Pro", "For freelancers and small teams.", 999m, 1, new()
        {
            [FeatureKeys.ProjectLimit] = -1, [FeatureKeys.TaskLimit] = -1, [FeatureKeys.MaxMembers] = 10, [FeatureKeys.MaxTeams] = 5,
            [FeatureKeys.ActivityRetentionDays] = 365, [FeatureKeys.AdvancedReports] = 1, [FeatureKeys.CustomWorkflows] = 1,
            [FeatureKeys.ApiAccess] = 0, [FeatureKeys.CustomFields] = 1, [FeatureKeys.Automation] = 1, [FeatureKeys.AdvancedPermissions] = 0, [FeatureKeys.AuditLog] = 0,
            [FeatureKeys.StorageLimitMb] = 10240, [FeatureKeys.MaxFileSizeMb] = 100, [FeatureKeys.AdvancedSecurity] = 0,
            [FeatureKeys.ResourceManagement] = 0, [FeatureKeys.ServiceLevels] = 0,
        }),
        ("BUSINESS", "Business", "For growing teams and departments.", 2499m, 2, new()
        {
            [FeatureKeys.ProjectLimit] = -1, [FeatureKeys.TaskLimit] = -1, [FeatureKeys.MaxMembers] = 100, [FeatureKeys.MaxTeams] = -1,
            [FeatureKeys.ActivityRetentionDays] = 730, [FeatureKeys.AdvancedReports] = 1, [FeatureKeys.CustomWorkflows] = 1,
            [FeatureKeys.ApiAccess] = 1, [FeatureKeys.CustomFields] = 1, [FeatureKeys.Automation] = 1, [FeatureKeys.AdvancedPermissions] = 1, [FeatureKeys.AuditLog] = 1,
            [FeatureKeys.StorageLimitMb] = 51200, [FeatureKeys.MaxFileSizeMb] = 250, [FeatureKeys.AdvancedSecurity] = 1,
            [FeatureKeys.ResourceManagement] = 1, [FeatureKeys.ServiceLevels] = 1,
        }),
        ("ENTERPRISE", "Enterprise", "Custom pricing, unlimited scale and advanced governance.", null, 3, new()
        {
            [FeatureKeys.ProjectLimit] = -1, [FeatureKeys.TaskLimit] = -1, [FeatureKeys.MaxMembers] = -1, [FeatureKeys.MaxTeams] = -1,
            [FeatureKeys.ActivityRetentionDays] = -1, [FeatureKeys.AdvancedReports] = 1, [FeatureKeys.CustomWorkflows] = 1,
            [FeatureKeys.ApiAccess] = 1, [FeatureKeys.CustomFields] = 1, [FeatureKeys.Automation] = 1, [FeatureKeys.AdvancedPermissions] = 1, [FeatureKeys.AuditLog] = 1,
            [FeatureKeys.StorageLimitMb] = -1, [FeatureKeys.MaxFileSizeMb] = 512, [FeatureKeys.AdvancedSecurity] = 1,
            [FeatureKeys.ResourceManagement] = 1, [FeatureKeys.ServiceLevels] = 1,
        }),
    ];

    /// <summary>
    /// The monthly price a new plan starts with: the built-in default, or Billing:Plans:{CODE}:PriceMonthly when the deployment sets one
    /// (an empty value means custom pricing). Only used when the plan is first created; after that the administrator owns the price.
    /// </summary>
    private static decimal? StartingPrice(string code, decimal? builtIn, IConfiguration? config)
    {
        var raw = config?.GetSection($"Billing:Plans:{code}")["PriceMonthly"];
        if (raw is null) return builtIn;
        if (string.IsNullOrWhiteSpace(raw)) return null;
        return decimal.TryParse(raw, System.Globalization.NumberStyles.Number, System.Globalization.CultureInfo.InvariantCulture, out var v) && v >= 0 ? v : builtIn;
    }

    /// <summary>Idempotent. Existing plans keep whatever an administrator configured; only missing rows are added.</summary>
    /// <summary>Every workspace needs a project group, and every project a group: workspaces and projects that predate groups get the default one.</summary>
    private static async Task BackfillProjectGroupsAsync(AppDbContext db, ILogger log, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var tenants = await db.Tenants.IgnoreQueryFilters().Select(t => t.Id).ToListAsync(ct);
        var touched = 0;
        foreach (var id in tenants)
            if (await ProjectManagement.Application.Features.Projects.ProjectGroupService.EnsureAsync(db, id, now, ct)) touched++;
        if (touched > 0)
        {
            await db.SaveChangesAsync(ct);
            log.LogInformation("Project groups: set up the default group in {Count} workspace(s)", touched);
        }
    }

    public static async Task SeedPlansAsync(AppDbContext db, CancellationToken ct, IConfiguration? config = null, ILogger? log = null)
    {
        var currency = await EnsureBillingCurrencyAsync(db, config, ct);
        var existing = await db.Plans.Include(p => p.Features).ToListAsync(ct);
        foreach (var def in PlanCatalog)
        {
            var plan = existing.FirstOrDefault(p => p.Code == def.Code);
            if (plan is null)
            {
                plan = new Plan { Code = def.Code, Name = def.Name, Description = def.Description, PriceMonthly = StartingPrice(def.Code, def.Price, config), Currency = currency, SortOrder = def.Sort };
                db.Plans.Add(plan);
            }
            else if (plan.Currency != currency && IsLegacyDollarSeed(plan))
            {
                // A database from before the billing currency existed: the untouched USD starter prices become the INR ones.
                log?.LogInformation("Plan {Code}: moving the starter price {Old} USD to {New} {Currency}.", plan.Code, plan.PriceMonthly, StartingPrice(def.Code, def.Price, config), currency);
                plan.PriceMonthly = StartingPrice(def.Code, def.Price, config); plan.Currency = currency;
            }
            foreach (var (key, value) in def.Features)
                if (plan.Features.All(f => f.FeatureKey != key))
                    db.PlanFeatures.Add(new PlanFeature { PlanId = plan.Id, FeatureKey = key, Value = value });
        }
        await db.SaveChangesAsync(ct);

        // Any plan still in another currency (an administrator's own price from before the switch) gets the platform currency label;
        // its price is left alone for the administrator to review, since amounts are never converted automatically.
        foreach (var p in await db.Plans.Where(p => p.Currency != currency).ToListAsync(ct))
        {
            if (p.PriceMonthly is > 0) log?.LogWarning("Plan {Code} is now priced in {Currency} but its amount ({Price}) was not converted. Review it in Admin → Plans.", p.Code, currency, p.PriceMonthly);
            p.Currency = currency;
        }
        await db.SaveChangesAsync(ct);
    }

    /// <summary>The untouched starter prices of the versions that priced plans in US dollars (Pro 12, Business 29).</summary>
    private static bool IsLegacyDollarSeed(Plan p) => p.Currency == "USD" && ((p.Code == "PRO" && p.PriceMonthly == 12m) || (p.Code == "BUSINESS" && p.PriceMonthly == 29m));

    /// <summary>
    /// The platform's billing currency, created on first start from Billing:Currency (INR when not set or not one of the supported codes).
    /// After that the setting in the database - which the platform administrator can change - is the truth.
    /// </summary>
    public static async Task<string> EnsureBillingCurrencyAsync(AppDbContext db, IConfiguration? config, CancellationToken ct)
    {
        var row = await db.PlatformSettings.FirstOrDefaultAsync(s => s.Key == PlatformService.KeyBillingCurrency, ct);
        if (row is not null && Currencies.IsSupported(row.Value)) return Currencies.Normalize(row.Value);
        var currency = Currencies.Normalize(config?["Billing:Currency"]);
        if (row is null) db.PlatformSettings.Add(new PlatformSetting { Key = PlatformService.KeyBillingCurrency, Value = currency, CreatedAt = DateTime.UtcNow });
        else row.Value = currency;
        await db.SaveChangesAsync(ct);
        return currency;
    }

    private static async Task SeedAdminAsync(IServiceProvider sp, string email, string password, string displayName, CancellationToken ct)
    {
        var db = sp.GetRequiredService<AppDbContext>();
        var normalized = email.Trim().ToLowerInvariant();
        if (await db.Users.AnyAsync(u => u.NormalizedEmail == normalized, ct)) return;

        var user = new User
        {
            Email = email.Trim(), NormalizedEmail = normalized, DisplayName = displayName, EmailVerified = true, IsPlatformAdmin = true,
            PasswordHash = sp.GetRequiredService<IPasswordHasher>().Hash(password),
        };
        db.Users.Add(user);
        await sp.GetRequiredService<WorkspaceProvisioner>().CreateAsync("Personal Workspace", WorkspaceType.Personal, user.Id, null, "platform admin personal", ct);
        await db.SaveChangesAsync(ct);
    }
}

/// <summary>Development sample data. Goes through the real application services so it also exercises their rules.</summary>
internal static class DemoSeeder
{
    private const string Password = "Demo@12345";

    private record TaskSeed(string Title, string Status, Priority Priority, string? Assignee, int? DueOffset, decimal? Hours = null, string? Description = null, string[]? Labels = null);

    public static async Task SeedAsync(IServiceProvider services, CancellationToken ct)
    {
        using var scope = services.CreateScope();
        var sp = scope.ServiceProvider;
        var db = sp.GetRequiredService<AppDbContext>();
        if (await db.Users.AnyAsync(u => u.NormalizedEmail == "demo@example.com", ct)) return;

        var hasher = sp.GetRequiredService<IPasswordHasher>();
        var provisioner = sp.GetRequiredService<WorkspaceProvisioner>();
        var clock = sp.GetRequiredService<AppClock>();

        // ---- people
        var people = new (string Name, string Email)[]
        {
            ("Ravi Kumar", "demo@example.com"), ("Arun S", "arun@example.com"), ("Priya M", "priya@example.com"),
            ("Kumar R", "kumar@example.com"), ("Sridhar P", "sridhar@example.com"), ("Umar F", "umar@example.com"),
        };
        var users = new Dictionary<string, User>();
        var personal = new Dictionary<string, Tenant>();
        foreach (var (name, email) in people)
        {
            var u = new User
            {
                Email = email, NormalizedEmail = email, DisplayName = name, EmailVerified = true,
                PasswordHash = hasher.Hash(Password), CreatedAt = clock.Now.AddDays(-60),
            };
            db.Users.Add(u);
            users[name] = u;
            personal[name] = await provisioner.CreateAsync("Personal Workspace", WorkspaceType.Personal, u.Id, null, $"{name} personal", ct);
        }

        // ---- organization on the Pro plan
        var org = await provisioner.CreateAsync("Qruize Technologies", WorkspaceType.Organization, users["Ravi Kumar"].Id,
            "Product engineering — web, mobile and platform.", null, ct);
        var roles = new Dictionary<string, TenantRole>
        {
            ["Arun S"] = TenantRole.Admin, ["Priya M"] = TenantRole.Manager, ["Kumar R"] = TenantRole.Member,
            ["Sridhar P"] = TenantRole.Member, ["Umar F"] = TenantRole.Guest,
        };
        foreach (var (name, role) in roles)
            db.TenantMembers.Add(new TenantMember { TenantId = org.Id, UserId = users[name].Id, Role = role, CreatedAt = clock.Now.AddDays(-45) });

        await db.SaveChangesAsync(ct); // persist users / tenants / memberships before adjusting the subscription
        var pro = await db.Plans.FirstAsync(p => p.Code == "PRO", ct);
        var sub = await db.Subscriptions.FirstAsync(s => s.TenantId == org.Id, ct);
        sub.PlanId = pro.Id; sub.Status = SubscriptionStatus.Active; sub.CurrentPeriodStart = clock.Now.AddDays(-12); sub.CurrentPeriodEnd = clock.Now.AddDays(18);
        db.Invoices.Add(new Invoice
        {
            TenantId = org.Id, Number = "INV-DEMO-0001", PlanCode = "PRO", Amount = 12m, Description = "Pro plan — monthly subscription",
            IssuedAt = clock.Now.AddDays(-12), ProviderReference = "mock_seed",
        });
        await db.SaveChangesAsync(ct);

        // ---- organization content, created as the owner
        using (var orgScope = services.CreateScope())
        {
            var s = orgScope.ServiceProvider;
            var ctx = s.GetRequiredService<CurrentContext>();
            ctx.UserId = users["Ravi Kumar"].Id; ctx.TenantId = org.Id; ctx.Role = TenantRole.Owner; ctx.WorkspaceType = WorkspaceType.Organization;
            await SeedOrganizationAsync(s, users, ct);
        }

        // ---- personal workspace content for the demo user
        using (var pScope = services.CreateScope())
        {
            var s = pScope.ServiceProvider;
            var ctx = s.GetRequiredService<CurrentContext>();
            ctx.UserId = users["Ravi Kumar"].Id; ctx.TenantId = personal["Ravi Kumar"].Id; ctx.Role = TenantRole.Owner; ctx.WorkspaceType = WorkspaceType.Personal;
            var projects = s.GetRequiredService<ProjectService>();
            var personalGroup = await s.GetRequiredService<ProjectGroupService>().DefaultGroupIdAsync(ct);
            var project = await projects.CreateAsync(new CreateProjectRequest("Learn Rust", "RUST", "Weekend learning plan.", Priority.Medium,
                ProjectStatus.Active, null, null, clock.Today.AddDays(-7), clock.Today.AddDays(60), null, ProjectGroupId: personalGroup,
                ProjectType: ProjectType.Other, DeliveryMethod: DeliveryMethod.Agile), ct);
            await AddTasksAsync(s, project.Project.Id, users,
            [
                new("Finish the Rust book — chapters 1-6", "Done", Priority.Medium, "Ravi Kumar", -3),
                new("Build a CLI todo app", "In Progress", Priority.High, "Ravi Kumar", 7, 6),
                new("Read about async / await", "Yet To Start", Priority.Low, "Ravi Kumar", 21),
            ], ct);
        }
    }

    private static async Task SeedOrganizationAsync(IServiceProvider s, Dictionary<string, User> users, CancellationToken ct)
    {
        var teams = s.GetRequiredService<TeamService>();
        var projects = s.GetRequiredService<ProjectService>();
        var db = s.GetRequiredService<AppDbContext>();
        var clock = s.GetRequiredService<AppClock>();
        var today = clock.Today;
        var groupId = await s.GetRequiredService<ProjectGroupService>().DefaultGroupIdAsync(ct);

        var dev = await teams.CreateAsync(new UpsertTeamRequest("Development", "Web and platform engineers"), ct);
        var qa = await teams.CreateAsync(new UpsertTeamRequest("QA", "Quality and release"), ct);
        foreach (var n in new[] { "Ravi Kumar", "Arun S", "Kumar R", "Sridhar P" })
            await teams.AddMemberAsync(dev.Team.Id, new AddTeamMemberRequest(users[n].Id, n == "Arun S"), ct);
        await teams.AddMemberAsync(qa.Team.Id, new AddTeamMemberRequest(users["Priya M"].Id, true), ct);

        // ---- organization chart: the software-company template, with the demo people placed on it
        var org = s.GetRequiredService<OrgService>();
        await org.ApplyTemplateAsync(new ApplyOrgTemplateRequest("software"), ct);
        var chart = (await org.GetAsync(ct)).Roles.ToDictionary(r => r.Name, r => r.Id);
        foreach (var (person, role, boss) in new (string, string, string?)[]
        {
            ("Ravi Kumar", "CTO", null), ("Arun S", "Project Lead", "Ravi Kumar"), ("Kumar R", "Developer", "Arun S"),
            ("Sridhar P", "Developer", "Arun S"), ("Priya M", "Tester (QA)", "Arun S"), ("Umar F", "Business User", "Ravi Kumar"),
        })
        {
            await org.AssignRoleAsync(users[person].Id, new AssignOrgRoleRequest(chart[role]), ct);
            if (boss is not null) await org.SetReportsToAsync(users[person].Id, new SetReportsToRequest(users[boss].Id), ct);
        }

        foreach (var (name, color) in new[] { ("Bug", "#fb7185"), ("Feature", "#8b5cf6"), ("Backend", "#38bdf8"), ("Frontend", "#c084fc"), ("Security", "#fbbf24") })
            await projects.CreateLabelAsync(new UpsertLabelRequest(name, color), ct);

        var portal = await projects.CreateAsync(new CreateProjectRequest("Customer Portal Revamp", "CPR",
            "Rebuild the customer portal with the new design system, SSO and a faster dashboard.", Priority.High, ProjectStatus.Active,
            users["Ravi Kumar"].Id, dev.Team.Id, today.AddDays(-25), today.AddDays(35),
            [users["Arun S"].Id, users["Kumar R"].Id, users["Priya M"].Id, users["Umar F"].Id], ProjectGroupId: groupId,
            ProjectType: ProjectType.Enhancement, DeliveryMethod: DeliveryMethod.Hybrid), ct);
        await AddTasksAsync(s, portal.Project.Id, users,
        [
            new("Design system tokens", "Done", Priority.Medium, "Arun S", -10, 8, Labels: ["Frontend"]),
            new("Login & SSO screens", "Done", Priority.High, "Kumar R", -5, 12, Labels: ["Frontend", "Feature"]),
            new("Dashboard API endpoints", "In Progress", Priority.High, "Arun S", 3, 16, "Aggregate endpoints powering the new dashboard.", ["Backend"]),
            new("Notification centre UI", "In Progress", Priority.Medium, "Kumar R", 0, 10, Labels: ["Frontend"]),
            new("Role-based navigation", "Review", Priority.Medium, "Ravi Kumar", 0, 6, Labels: ["Feature"]),
            new("Accessibility audit", "Testing", Priority.Medium, "Priya M", 5, 8),
            new("Migrate legacy reports", "In Progress", Priority.Critical, "Arun S", -2, 20, "Waiting for read access to the legacy warehouse.", ["Backend"]),
            new("Performance budget", "Yet To Start", Priority.Low, null, 14),
            new("Fix pagination bug on invoices", "Yet To Start", Priority.High, "Kumar R", -1, 3, Labels: ["Bug"]),
            new("Write release notes", "Yet To Start", Priority.Low, "Ravi Kumar", 30),
        ], ct);
        await SeedSubtasksAndCommentsAsync(s, portal.Project.Id, users, ct);
        await SetStagesAsync(db, portal.Project.Id, completed: 2, inProgress: 2, today);

        var mobile = await projects.CreateAsync(new CreateProjectRequest("Mobile App v2", "MOB", "Native mobile client for tasks and notifications.",
            Priority.Medium, ProjectStatus.Active, users["Priya M"].Id, null, today.AddDays(-10), today.AddDays(60),
            [users["Kumar R"].Id, users["Sridhar P"].Id], ProjectGroupId: groupId, ProjectType: ProjectType.NewProject, DeliveryMethod: DeliveryMethod.Agile), ct);
        await AddTasksAsync(s, mobile.Project.Id, users,
        [
            new("Choose cross-platform stack", "Done", Priority.High, "Sridhar P", -6),
            new("Prototype task list screen", "In Progress", Priority.Medium, "Sridhar P", 6, 12, Labels: ["Frontend"]),
            new("Push notification service", "Yet To Start", Priority.Medium, "Kumar R", 20, 10, Labels: ["Backend"]),
            new("Offline sync design", "Yet To Start", Priority.High, null, 25),
        ], ct);
        await SetStagesAsync(db, mobile.Project.Id, completed: 1, inProgress: 1, today);

        var payments = await projects.CreateAsync(new CreateProjectRequest("Payments API Migration", "PAY", "Move billing to the new payments platform.",
            Priority.Critical, ProjectStatus.Active, users["Ravi Kumar"].Id, dev.Team.Id, today.AddDays(-40), today.AddDays(6),
            [users["Arun S"].Id, users["Kumar R"].Id], ProjectGroupId: groupId, ProjectType: ProjectType.Migration, DeliveryMethod: DeliveryMethod.Phased), ct);
        await AddTasksAsync(s, payments.Project.Id, users,
        [
            new("Inventory existing billing endpoints", "Done", Priority.Medium, "Arun S", -30),
            new("Sandbox integration", "Done", Priority.High, "Kumar R", -20, Labels: ["Backend"]),
            new("Webhook signature verification", "Testing", Priority.Critical, "Arun S", 1, 6, Labels: ["Backend", "Security"]),
            new("Refund flow", "In Progress", Priority.High, "Kumar R", 3, 14, Labels: ["Backend"]),
            new("Reconcile historical invoices", "In Progress", Priority.High, "Arun S", -3, 18, "Finance export is delayed."),
            new("Cut-over runbook", "Yet To Start", Priority.Critical, "Ravi Kumar", 5, 4),
            new("Review payments contract", "In Progress", Priority.High, "Ravi Kumar", -1, 2),
        ], ct);
        await SetStagesAsync(db, payments.Project.Id, completed: 3, inProgress: 3, today);

        var web = await projects.CreateAsync(new CreateProjectRequest("Website Refresh", "WEB", "Marketing site refresh — shipped.",
            Priority.Low, ProjectStatus.Completed, users["Priya M"].Id, null, today.AddDays(-90), today.AddDays(-20), null, ProjectGroupId: groupId,
            ProjectType: ProjectType.Enhancement, DeliveryMethod: DeliveryMethod.Phased), ct);
        await AddTasksAsync(s, web.Project.Id, users,
        [
            new("New landing page", "Done", Priority.Medium, "Kumar R", -50),
            new("Pricing page copy", "Done", Priority.Low, "Priya M", -45),
            new("Launch checklist", "Done", Priority.Medium, "Priya M", -22),
        ], ct);
        await SetStagesAsync(db, web.Project.Id, completed: 8, inProgress: null, today);
    }

    private static async Task AddTasksAsync(IServiceProvider s, Guid projectId, Dictionary<string, User> users, TaskSeed[] seeds, CancellationToken ct)
    {
        var projects = s.GetRequiredService<ProjectService>();
        var tasks = s.GetRequiredService<TaskService>();
        var today = s.GetRequiredService<AppClock>().Today;
        var statuses = (await projects.GetStatusesAsync(projectId, ct)).ToDictionary(x => x.Name, x => x.Id);
        var labels = (await projects.GetLabelsAsync(ct)).ToDictionary(x => x.Name, x => x.Id);

        foreach (var t in seeds)
        {
            await tasks.CreateAsync(projectId, new CreateTaskRequest(t.Title, t.Description, statuses[t.Status], t.Priority,
                t.Assignee is null ? null : users[t.Assignee].Id, t.DueOffset is { } d ? today.AddDays(d - 10) : null,
                t.DueOffset is { } due ? today.AddDays(due) : null, t.Hours, t.Labels?.Select(l => labels[l]).ToList(), null), ct);
        }
    }

    private static async Task SeedSubtasksAndCommentsAsync(IServiceProvider s, Guid projectId, Dictionary<string, User> users, CancellationToken ct)
    {
        var tasks = s.GetRequiredService<TaskService>();
        var projects = s.GetRequiredService<ProjectService>();
        var statuses = (await projects.GetStatusesAsync(projectId, ct)).ToDictionary(x => x.Name, x => x.Id);
        var list = (await tasks.ListAsync(new TaskQuery(projectId), ct)).Items;
        var api = list.First(t => t.Title.StartsWith("Dashboard API"));
        var legacy = list.First(t => t.Title.StartsWith("Migrate legacy"));

        foreach (var (title, status) in new[] { ("Design endpoints", "Done"), ("Implement handlers", "In Progress"), ("Write integration tests", "Yet To Start") })
            await tasks.CreateAsync(projectId, new CreateTaskRequest(title, null, statuses[status], Priority.Medium, users["Arun S"].Id,
                null, null, null, null, api.Id), ct);

        await tasks.AddCommentAsync(api.Id, new CreateCommentRequest("Endpoints are drafted — @Ravi Kumar can you review the response shape?", null, [users["Ravi Kumar"].Id]), ct);
        await tasks.AddCommentAsync(legacy.Id, new CreateCommentRequest("Still waiting on warehouse access. Escalated to IT.", null, null), ct);
    }

    /// <summary>Leaves the first <paramref name="completed"/> stages completed and the next one in progress.</summary>
    private static async Task SetStagesAsync(AppDbContext db, Guid projectId, int completed, int? inProgress, DateOnly today)
    {
        var stages = await db.ProjectStages.Where(x => x.ProjectId == projectId).OrderBy(x => x.Order).ToListAsync();
        for (var i = 0; i < stages.Count; i++)
        {
            var st = stages[i];
            if (i < completed) { st.Status = StageStatus.Completed; st.ActualStart = st.PlannedStart ?? today; st.ActualEnd = st.PlannedEnd ?? today; }
            else if (i == inProgress) { st.Status = StageStatus.InProgress; st.ActualStart = st.PlannedStart ?? today; }
            else { st.Status = StageStatus.Pending; st.ActualStart = null; st.ActualEnd = null; }
        }
        await db.SaveChangesAsync();
    }
}
