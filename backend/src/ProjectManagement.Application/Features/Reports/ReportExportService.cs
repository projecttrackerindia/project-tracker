using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Insights;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Reports;

public record ReportExportDto(Guid Id, ReportKind Kind, ReportFormat Format, ReportExportStatus Status, Guid? ProjectId, Guid? TargetUserId, int Days,
    string? FileName, long SizeBytes, string? Error, DateTime CreatedAt, DateTime? CompletedAt, DateTime? ExpiresAt);
public record RequestExportRequest(ReportKind Kind, ReportFormat Format, Guid? ProjectId, Guid? TargetUserId, int? Days);

/// <summary>
/// Asking for, listing and downloading generated reports. The file itself is produced later by <see cref="ReportExportProcessor"/>, so a
/// large report never holds a web request open.
/// </summary>
public class ReportExportService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions,
    EntitlementService entitlements, ProjectAccess access, IFileStorage storage, ILogger<ReportExportService> log,
    ProjectManagement.Application.Features.Organization.ReportingLineService reporting)
{
    public static readonly TimeSpan Retention = TimeSpan.FromDays(7);
    private const int MaxPending = 3;
    private const int KeepListed = 25;

    private static ReportExportDto ToDto(ReportExport e) =>
        new(e.Id, e.Kind, e.Format, e.Status, e.ProjectId, e.TargetUserId, e.Days, e.FileName, e.SizeBytes, e.Error, e.CreatedAt, e.CompletedAt, e.ExpiresAt);

    public async Task<ReportExportDto> RequestAsync(RequestExportRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.ReportsView, ct);
        var tid = ctx.RequireTenantId(); var uid = ctx.RequireUserId();
        if (!Enum.IsDefined(req.Kind) || !Enum.IsDefined(req.Format)) throw new ValidationException("kind", "Unknown report type or format.");
        if (req.Kind == ReportKind.WorkTasks && await permissions.LevelAsync(Modules.Work, ct) == AccessLevel.None)
            throw new ForbiddenException("Your role does not have access to Work management.", "MODULE_ACCESS_DENIED");
        var whole = req.Kind == ReportKind.WorkspaceExport;
        if (whole && ctx.Role != TenantRole.Owner) throw new ForbiddenException("Only the workspace owner can export all of its data.", "PERMISSION_DENIED");
        if (whole != (req.Format == ReportFormat.Zip)) throw new ValidationException("format", whole ? "A workspace export is a zip file." : "Choose CSV, Excel or PDF.");
        // CSV stays available on every plan; spreadsheets and PDFs are part of the advanced reports feature. The workspace export is every plan's right.
        if (!whole && req.Format != ReportFormat.Csv) await entitlements.EnsureFeatureAsync(FeatureKeys.AdvancedReports, ct);
        if (req.ProjectId is { } pid)
        {
            if (req.Kind == ReportKind.Workload) throw new ValidationException("projectId", "A workload report is not limited to one project.");
            await access.GetProjectAsync(pid, ct);
        }
        if (req.TargetUserId is { } target)
        {
            if (req.Kind == ReportKind.Project) throw new ValidationException("targetUserId", "A project report is not limited to one person.");
            if (target != uid && !await reporting.IsInMyLineAsync(target, ct) && !await permissions.HasBroadReportsAccessAsync(ct))
                throw new ValidationException("targetUserId", "You can only report on people in your reporting line.");
        }
        var days = Math.Clamp(req.Days ?? 30, 1, 90);

        var pending = await db.ReportExports.CountAsync(e => e.UserId == uid && (e.Status == ReportExportStatus.Queued || e.Status == ReportExportStatus.Running), ct);
        if (pending >= MaxPending) throw new ConflictException("You already have reports being prepared. Wait for one to finish.", "TOO_MANY_PENDING");

        var export = new ReportExport
        {
            TenantId = tid, UserId = uid, Kind = req.Kind, Format = req.Format, ProjectId = req.ProjectId, TargetUserId = req.TargetUserId,
            Days = days, CreatedAt = clock.Now, CreatedBy = uid,
        };
        db.ReportExports.Add(export);
        recorder.Audit("report.export_requested", "ReportExport", export.Id, newValue: new { req.Kind, req.Format, req.ProjectId, req.TargetUserId });
        await db.SaveChangesAsync(ct);
        return ToDto(export);
    }

    public async Task<IReadOnlyList<ReportExportDto>> ListAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var rows = await db.ReportExports.AsNoTracking().Where(e => e.UserId == uid).OrderByDescending(e => e.CreatedAt).Take(KeepListed).ToListAsync(ct);
        return rows.Select(ToDto).ToList();
    }

    public async Task<ReportExportDto> GetAsync(Guid id, CancellationToken ct = default) => ToDto(await FindMineAsync(id, ct));

    private async Task<ReportExport> FindMineAsync(Guid id, CancellationToken ct)
    {
        var uid = ctx.RequireUserId();
        return await db.ReportExports.FirstOrDefaultAsync(e => e.Id == id && e.UserId == uid, ct) ?? throw new NotFoundException("Report not found.");
    }

    public async Task<(Stream Content, string FileName, string ContentType)> OpenAsync(Guid id, CancellationToken ct = default)
    {
        var e = await FindMineAsync(id, ct);
        if (e.Status != ReportExportStatus.Ready || e.StorageKey is null) throw new ConflictException("This report is not ready yet.", "NOT_READY");
        if (e.ExpiresAt is { } exp && exp < clock.Now) throw new NotFoundException("This report has expired. Request it again.");
        var stream = await storage.OpenReadAsync(e.StorageKey, ct) ?? throw new NotFoundException("The report file is no longer available. Request it again.");
        return (stream, e.FileName ?? "report", ContentTypeOf(e.Format));
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        var e = await FindMineAsync(id, ct);
        if (e.StorageKey is not null) { try { await storage.DeleteAsync(e.StorageKey, ct); } catch (Exception ex) { log.LogWarning(ex, "Could not delete report file {Key}", e.StorageKey); } }
        db.ReportExports.Remove(e);
        await db.SaveChangesAsync(ct);
    }

    public static string ContentTypeOf(ReportFormat f) => f switch
    {
        ReportFormat.Csv => "text/csv",
        ReportFormat.Zip => "application/zip",
        ReportFormat.Xlsx => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        _ => "application/pdf",
    };

    /// <summary>Removes expired report files and their rows (called by the maintenance job, across all workspaces).</summary>
    public async Task<int> PurgeExpiredAsync(int batch = 200, CancellationToken ct = default)
    {
        var now = clock.Now;
        var old = await db.ReportExports.IgnoreQueryFilters().Where(e => e.ExpiresAt != null && e.ExpiresAt < now).Take(batch).ToListAsync(ct);
        foreach (var e in old)
        {
            if (e.StorageKey is not null) { try { await storage.DeleteAsync(e.StorageKey, ct); } catch (Exception ex) { log.LogWarning(ex, "Could not delete report file {Key}", e.StorageKey); continue; } }
            db.ReportExports.Remove(e);
        }
        // Failed requests never get an expiry; drop them after the same period.
        var failed = await db.ReportExports.IgnoreQueryFilters().Where(e => e.Status == ReportExportStatus.Failed && e.CreatedAt < now - Retention).Take(batch).ToListAsync(ct);
        db.ReportExports.RemoveRange(failed);
        await db.SaveChangesAsync(ct);
        return old.Count + failed.Count;
    }
}

/// <summary>
/// Turns queued report requests into files. Runs from a background worker (never inside a web request). Each report is built with the
/// requester's own identity, so it can only contain what that person is allowed to see at the moment it is generated.
/// </summary>
public class ReportExportProcessor(IServiceScopeFactory scopes, TimeProvider time, ILogger<ReportExportProcessor> log)
{
    // The processor is a singleton (it opens its own scopes), so it reads the clock directly instead of the scoped AppClock.
    private DateTime Now => time.GetUtcNow().UtcDateTime;
    private static readonly TimeSpan StuckAfter = TimeSpan.FromMinutes(15);

    /// <summary>Builds every queued report. Returns how many were finished (successfully or not).</summary>
    public async Task<int> ProcessPendingAsync(int max = 5, CancellationToken ct = default)
    {
        var claimed = new List<Guid>();
        using (var scope = scopes.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IAppDbContext>();
            // A report stuck in "running" (the server stopped mid-way) is failed so the person can simply ask again.
            var cutoff = Now - StuckAfter;
            foreach (var stuck in await db.ReportExports.IgnoreQueryFilters().Where(e => e.Status == ReportExportStatus.Running && e.StartedAt < cutoff).ToListAsync(ct))
            { stuck.Status = ReportExportStatus.Failed; stuck.Error = "Generation was interrupted. Please request the report again."; stuck.CompletedAt = Now; }
            await db.SaveChangesAsync(ct);

            var queued = await db.ReportExports.IgnoreQueryFilters().Where(e => e.Status == ReportExportStatus.Queued).OrderBy(e => e.CreatedAt).Take(max).Select(e => e.Id).ToListAsync(ct);
            foreach (var id in queued)
            {
                // Claim atomically so two servers never build the same report.
                var now = Now;
                var won = await db.ReportExports.IgnoreQueryFilters().Where(e => e.Id == id && e.Status == ReportExportStatus.Queued)
                    .ExecuteUpdateAsync(s => s.SetProperty(e => e.Status, ReportExportStatus.Running).SetProperty(e => e.StartedAt, now), ct);
                if (won == 1) claimed.Add(id);
            }
        }
        foreach (var id in claimed)
        {
            using var span = AppTelemetry.Source.StartActivity("report.export");
            try { await RunOneAsync(id, ct); AppTelemetry.Count(AppTelemetry.ReportExports, "ready"); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                AppTelemetry.Count(AppTelemetry.ReportExports, "failed");
                log.LogError(ex, "Report {Id} failed", id);
                await FailAsync(id, ex is AppException ? ex.Message : "The report could not be generated.", ct);
            }
        }
        return claimed.Count;
    }

    private async Task FailAsync(Guid id, string message, CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IAppDbContext>();
        var e = await db.ReportExports.IgnoreQueryFilters().FirstOrDefaultAsync(x => x.Id == id, ct);
        if (e is null) return;
        e.Status = ReportExportStatus.Failed; e.Error = message.Length > 300 ? message[..300] : message; e.CompletedAt = Now;
        await db.SaveChangesAsync(ct);
    }

    private async Task RunOneAsync(Guid id, CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var sp = scope.ServiceProvider;
        var db = sp.GetRequiredService<IAppDbContext>();
        var export = await db.ReportExports.IgnoreQueryFilters().FirstAsync(e => e.Id == id, ct);

        // Act as the requester, in their workspace, with the role they have right now.
        var member = await db.TenantMembers.FirstOrDefaultAsync(m => m.TenantId == export.TenantId && m.UserId == export.UserId, ct)
            ?? throw new ForbiddenException("You are no longer a member of this workspace.", "NOT_A_MEMBER");
        var tenant = await db.Tenants.FirstOrDefaultAsync(t => t.Id == export.TenantId, ct) ?? throw new NotFoundException("This workspace no longer exists.");
        var cc = sp.GetRequiredService<CurrentContext>();
        cc.UserId = export.UserId; cc.TenantId = export.TenantId; cc.Role = member.Role; cc.WorkspaceType = tenant.Type; cc.IsPlatformAdmin = false;

        var storage = sp.GetRequiredService<IFileStorage>();
        string extension; long size;
        if (export.Kind == ReportKind.WorkspaceExport)
        {
            // Everything the workspace holds: written to a temporary zip on disk (it can be large), then stored like any report.
            var temp = await sp.GetRequiredService<ProjectManagement.Application.Features.Compliance.WorkspaceExporter>().WriteAsync(tenant.Name, ct);
            try
            {
                extension = "zip"; size = new FileInfo(temp).Length;
                await using var fs = File.OpenRead(temp);
                await storage.SaveAsync($"{export.TenantId:N}/exports/{export.Id:N}.zip", fs, ct);
            }
            finally { try { File.Delete(temp); } catch (IOException) { /* best effort */ } }
        }
        else
        {
            var doc = await sp.GetRequiredService<ReportBuilder>().BuildAsync(export, tenant.Name, ct);
            var file = ReportWriter.Write(doc, export.Format);
            extension = file.Extension; size = file.Content.Length;
            using var ms = new MemoryStream(file.Content);
            await storage.SaveAsync($"{export.TenantId:N}/exports/{export.Id:N}.{extension}", ms, ct);
        }
        var key = $"{export.TenantId:N}/exports/{export.Id:N}.{extension}";

        var name = export.Kind == ReportKind.WorkspaceExport ? $"workspace-export-{Now:yyyyMMdd-HHmm}.zip" : $"{export.Kind.ToString().ToLowerInvariant()}-{Now:yyyyMMdd-HHmm}.{extension}";
        export.StorageKey = key; export.FileName = name; export.SizeBytes = size;
        export.Status = ReportExportStatus.Ready; export.CompletedAt = Now; export.ExpiresAt = Now + ReportExportService.Retention; export.Error = null;
        var label = export.Kind switch { ReportKind.WorkTasks => "Work tasks report", ReportKind.WorkspaceExport => "workspace data export", _ => $"{export.Kind} report" };
        await sp.GetRequiredService<NotificationService>().AddAsync(export.UserId, NotificationType.ReportReady, $"Your {label} is ready",
            $"{name} ({size / 1024 + 1:N0} KB) can be downloaded for {ReportExportService.Retention.Days} days.", "/reports", toSelf: true, ct: ct);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Test / maintenance helper: expire and remove old reports.</summary>
    public async Task<int> PurgeExpiredAsync(CancellationToken ct = default)
    {
        using var scope = scopes.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<ReportExportService>().PurgeExpiredAsync(ct: ct);
    }
}

/// <summary>Collects the data of a report into a format-neutral document. Uses the current (requester's) access rights throughout.</summary>
public class ReportBuilder(IAppDbContext db, ICurrentContext ctx, AppClock clock, ProjectAccess access, ReportService reports, TimeService time,
    PermissionService permissions, ProjectManagement.Application.Features.Organization.ReportingLineService reporting,
    ProjectManagement.Application.Features.Configuration.PriorityService priorities, ProjectManagement.Application.Features.Work.WorkTaskService workTasks)
{
    public async Task<ReportDocument> BuildAsync(ReportExport e, string workspaceName, CancellationToken ct)
    {
        var scope = e.ProjectId is { } pid ? $"Project {(await access.GetProjectAsync(pid, ct)).Key}" : "All projects you can see";
        var subtitle = $"{workspaceName} · {scope} · generated {clock.Now:yyyy-MM-dd HH:mm} UTC";
        return e.Kind switch
        {
            ReportKind.Project => await ProjectReportAsync(e, subtitle, ct),
            ReportKind.Workload => await WorkloadReportAsync(e, subtitle, ct),
            ReportKind.WorkTasks => await WorkTasksReportAsync(e, subtitle, ct),
            _ => await TimesheetReportAsync(e, subtitle, ct),
        };
    }

    /// <summary>Operational work tasks (optionally those related to one project, or assigned to one person): the same columns as the instant export.</summary>
    private async Task<ReportDocument> WorkTasksReportAsync(ReportExport e, string subtitle, CancellationToken ct)
    {
        var section = await workTasks.ExportSectionAsync(new ProjectManagement.Application.Features.Work.WorkTaskQuery(RelatedProjectId: e.ProjectId, AssigneeId: e.TargetUserId, Sort: "due"), ct);
        return new ReportDocument("Work tasks", subtitle, [section]);
    }

    private async Task<ReportDocument> ProjectReportAsync(ReportExport e, string subtitle, CancellationToken ct)
    {
        var s = await reports.GetSummaryAsync(e.Days, ct);
        var t = s.Totals;
        var overview = new ReportSection("Overview", ["Measure", "Value"],
        [
            new object?[] { "Total tasks", t.Total }, new object?[] { "Completed", t.Completed }, new object?[] { "In progress", t.InProgress }, new object?[] { "To do", t.Pending },
            new object?[] { "Overdue", t.Overdue }, new object?[] { "Cancelled", t.Cancelled }, new object?[] { "Completion rate (%)", t.CompletionRate },
            new object?[] { "Completed in the last 7 days", s.CompletedThisWeek }, new object?[] { "Completed in the last 30 days", s.CompletedThisMonth },
        ]);
        var projects = new ReportSection("Projects", ["Key", "Project", "Progress %", "Health", "Due", "Tasks", "Done"],
            s.ProjectProgress.Where(p => e.ProjectId is null || p.Id == e.ProjectId).Select(p => (IReadOnlyList<object?>)new object?[] { p.Key, p.Name, p.Progress, p.Health.ToString(), p.DueDate, p.Total, p.Done }).ToList());
        return new ReportDocument("Project report", subtitle, [overview, projects, await TasksAsync(e.ProjectId, ct)]);
    }

    private async Task<ReportSection> TasksAsync(Guid? projectId, CancellationToken ct)
    {
        var q = access.VisibleTasks().AsNoTracking();
        if (projectId is { } pid) q = q.Where(t => t.ProjectId == pid);
        var names = await priorities.NamesAsync(ct);
        var rows = await q.OrderBy(t => t.ProjectId).ThenBy(t => t.Number).Take(10_000)
            .Select(t => new
            {
                t.Id, ProjectKey = t.Project!.Key, t.Number, t.Title, Status = t.Status!.Name, t.Priority, Assignee = t.Assignee!.DisplayName, Reporter = t.Reporter!.DisplayName,
                t.StartDate, t.DueDate, t.EstimatedHours, t.ActualHours, t.CreatedAt, t.CompletedAt, Sprint = db.Sprints.Where(s => s.Id == t.SprintId).Select(s => s.Name).FirstOrDefault(),
            }).ToListAsync(ct);
        var defs = await db.CustomFieldDefinitions.AsNoTracking().OrderBy(d => d.SortOrder).ThenBy(d => d.CreatedAt).ToListAsync(ct);
        var fieldValues = defs.Count == 0 ? new Dictionary<(Guid, Guid), string>()
            : (await db.CustomFieldValues.AsNoTracking().Where(v => q.Select(t => t.Id).Contains(v.TaskId)).Select(v => new { v.TaskId, v.FieldId, v.Value }).ToListAsync(ct))
                .ToDictionary(v => (v.TaskId, v.FieldId), v => v.Value);
        return new ReportSection("Tasks",
            new[] { "Key", "Title", "Status", "Priority", "Assignee", "Reporter", "Sprint", "Start date", "Due date", "Estimated h", "Actual h", "Created", "Completed" }.Concat(defs.Select(d => d.Name)).ToList(),
            rows.Select(r => (IReadOnlyList<object?>)new object?[]
            {
                $"{r.ProjectKey}-{r.Number}", r.Title, r.Status, names.GetValueOrDefault(r.Priority, r.Priority.ToString()), r.Assignee, r.Reporter, r.Sprint, r.StartDate, r.DueDate, r.EstimatedHours, r.ActualHours, DateOnly.FromDateTime(r.CreatedAt), r.CompletedAt is { } done ? DateOnly.FromDateTime(done) : null,
            }.Concat(defs.Select(d => fieldValues.TryGetValue((r.Id, d.Id), out var v) ? CustomFieldService.ForExport(d, v) : null)).ToArray()).ToList());
    }

    /// <summary>Everyone the requester may report on: one chosen person, their own reporting line, or (with broad
    /// reports access) nobody in particular - <c>null</c> means "everyone visible", same rule Calendar and
    /// Timesheet's live pages use.</summary>
    private async Task<IReadOnlySet<Guid>?> AudienceAsync(ReportExport e, CancellationToken ct)
    {
        if (e.TargetUserId is { } target) return new HashSet<Guid> { target };
        if (await permissions.HasBroadReportsAccessAsync(ct)) return null;
        var me = ctx.RequireUserId();
        var team = (await reporting.ReportsOfAsync(me, ctx.RequireTenantId(), ct)).Keys.ToHashSet();
        team.Add(me);
        return team;
    }

    private async Task<ReportDocument> WorkloadReportAsync(ReportExport e, string subtitle, CancellationToken ct)
    {
        var workload = await reports.BuildWorkloadAsync(await AudienceAsync(e, ct), ct);
        return new ReportDocument("Team workload", subtitle,
            [new ReportSection("Workload", ["Person", "Open", "Overdue", "Done"], workload.Select(w => (IReadOnlyList<object?>)new object?[] { w.Name, w.Open, w.Overdue, w.Done }).ToList())]);
    }

    private async Task<ReportDocument> TimesheetReportAsync(ReportExport e, string subtitle, CancellationToken ct)
    {
        var to = clock.Today; var from = to.AddDays(-(e.Days - 1));
        var range = $"{from:yyyy-MM-dd} to {to:yyyy-MM-dd}";

        if (e.TargetUserId is { } target)
        {
            var sheet = await time.TimesheetAsync(from, to, target, ct);
            return new ReportDocument($"Timesheet: {sheet.User.Name}", $"{subtitle} · {range}",
            [
                new ReportSection("By day", ["Date", "Hours"], sheet.ByDay.Select(d => (IReadOnlyList<object?>)new object?[] { d.Date, Math.Round(d.Minutes / 60m, 2) }).ToList()),
                new ReportSection("Entries", ["Date", "Task", "Title", "Hours", "Note"],
                    sheet.Entries.Where(x => !x.IsRunning).Select(x => (IReadOnlyList<object?>)new object?[] { x.WorkDate, x.TaskKey, x.TaskTitle, Math.Round(x.Minutes / 60m, 2), x.Note }).ToList()),
            ]);
        }

        // No one person chosen: everyone the requester may see (own reporting line, or everyone with broad access).
        var entries = await time.TeamEntriesAsync(from, to, e.ProjectId, await AudienceAsync(e, ct), ct);
        var live = entries.Where(x => !x.IsRunning).ToList();
        var byPerson = live.GroupBy(x => x.User.Name)
            .Select(g => (Name: g.Key, Hours: Math.Round(g.Sum(x => x.Minutes) / 60m, 2)))
            .OrderByDescending(r => r.Hours)
            .Select(r => (IReadOnlyList<object?>)new object?[] { r.Name, r.Hours }).ToList();
        return new ReportDocument("Timesheet", $"{subtitle} · {range}",
        [
            new ReportSection("By person", ["Person", "Hours"], byPerson),
            new ReportSection("Entries", ["Person", "Date", "Task", "Title", "Hours", "Note"],
                live.Select(x => (IReadOnlyList<object?>)new object?[] { x.User.Name, x.WorkDate, x.TaskKey, x.TaskTitle, Math.Round(x.Minutes / 60m, 2), x.Note }).ToList()),
        ]);
    }
}
