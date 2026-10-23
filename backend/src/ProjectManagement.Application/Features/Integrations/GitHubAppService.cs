using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.Sso;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Integrations;

public record GitHubStatusRules(string? Opened = "In Review", string? Approved = "Ready", string? Merged = "Done", bool ReopenOnRevert = true);
public record GitHubAppStatusDto(bool Configured, bool Installed, string? Account, string? AccountType, string? Selection, IReadOnlyList<string> Repositories,
    GitHubStatusRules Rules, IReadOnlyList<string> RiskyPaths, bool CloseOnKeyword, int Received, DateTime? LastEventAt, string? LastError, string? ManageUrl, bool Suspended);
public record GitHubInstallStartDto(string Url);
public record GitHubInstallCompleteRequest(long InstallationId, string? SetupAction, string? Code, string State);
public record SaveGitHubSettingsRequest(GitHubStatusRules? Rules, IReadOnlyList<string>? RiskyPaths, bool? CloseOnKeyword);
public record CreateBranchRequest(string Repository, string? Base);
public record BranchDto(string Name, string Url, string Repository);
public record PullReviewItemDto(Guid LinkId, string Repository, string Number, string Title, string Url, string? Author, DateTime WaitingSince, int Days, string? TaskKey,
    string? ChecksState, int? RiskScore, string Role);
public record ReviewQueueDto(int WaitingOnMe, int? OldestDays, IReadOnlyList<PullReviewItemDto> Items, bool GitHubLinked);
public record ReleaseNoteTask(string Key, string Title, IReadOnlyList<ReleaseNotePr> PullRequests);
public record ReleaseNotePr(string Repository, string Number, string Title, string Url, string? Author, DateTime MergedAt);
public record ReleaseNotesDto(DateOnly From, DateOnly To, IReadOnlyList<ReleaseNoteTask> Tasks, IReadOnlyList<ReleaseNotePr> Unlinked, string Markdown);
public record DeliveryWeekDto(DateOnly WeekStart, int Deploys, int Failed, decimal? LeadTimeHours, int Merged);
public record DeliveryMetricsDto(int Days, decimal? LeadTimeHours, string LeadTimeBasis, decimal DeploysPerWeek, decimal? ChangeFailureRate, decimal? RestoreHours,
    IReadOnlyList<DeliveryWeekDto> Weeks, IReadOnlyList<string> Notes, IReadOnlyList<string> Repositories);

/// <summary>
/// The ProjectTracker GitHub App for a workspace: install it with one click (no secrets to paste), start a branch from a task, let status
/// follow the code, see each pull request's checks, reviews and risk on the task, a review queue on Home, release notes written from merged
/// pull requests, and delivery metrics. Everything here reads only what the app's webhook brought in and what the person may see.
/// </summary>
public class GitHubAppService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, GitHubAppClient github, IOptions<GitHubAppOptions> options,
    ISecretProtector secrets, ProjectAccess access, IServiceProvider services, PermissionService permissions)
{
    private GitHubAppOptions O => options.Value;
    public const int MaxRepositories = 300;

    private void RequireAdmin()
    {
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only owners and admins can connect GitHub.", "PERMISSION_DENIED");
    }

    public static GitHubStatusRules RulesOf(GitHubInstallation? i)
    {
        if (string.IsNullOrWhiteSpace(i?.StatusRules)) return new();
        try { return JsonSerializer.Deserialize<GitHubStatusRules>(i.StatusRules, new JsonSerializerOptions(JsonSerializerDefaults.Web)) ?? new(); } catch (JsonException) { return new(); }
    }

    public static IReadOnlyList<string> Lines(string? s) => (s ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    public async Task<GitHubAppStatusDto> StatusAsync(CancellationToken ct = default)
    {
        var i = await db.GitHubInstallations.AsNoTracking().OrderByDescending(x => x.CreatedAt).FirstOrDefaultAsync(ct);
        return new GitHubAppStatusDto(O.Configured, i is not null, i?.AccountLogin, i?.AccountType, i?.RepositorySelection, Lines(i?.Repositories), RulesOf(i), Lines(i?.RiskyPaths),
            i?.CloseOnKeyword ?? true, i?.Received ?? 0, i?.LastEventAt, i?.LastError,
            i is null ? null : i.AccountType == "Organization" ? $"{O.WebBaseUrl.TrimEnd('/')}/organizations/{i.AccountLogin}/settings/installations/{i.InstallationId}"
                : $"{O.WebBaseUrl.TrimEnd('/')}/settings/installations/{i.InstallationId}", i?.SuspendedAt is not null);
    }

    private sealed record InstallState(Guid Tenant, Guid User, long Expires);

    /// <summary>Where to send the admin: GitHub's install page for the app, with a sealed state that only this workspace and person can complete.</summary>
    public GitHubInstallStartDto Start()
    {
        RequireAdmin();
        if (!O.Configured) throw new ConflictException("The GitHub App is not set up on this server yet.", "GITHUB_APP_NOT_CONFIGURED");
        var state = secrets.Protect(JsonSerializer.Serialize(new InstallState(ctx.RequireTenantId(), ctx.RequireUserId(), clock.Now.AddMinutes(30).Ticks)));
        return new GitHubInstallStartDto($"{O.WebBaseUrl.TrimEnd('/')}/apps/{O.Slug}/installations/new?state={Uri.EscapeDataString(state)}");
    }

    /// <summary>
    /// GitHub sends the admin back with the installation id and a one-time code. The code proves which GitHub user installed it, and that user
    /// must be able to reach this installation, so nobody can attach someone else's repositories to their workspace by guessing an id.
    /// </summary>
    public async Task<GitHubAppStatusDto> CompleteAsync(GitHubInstallCompleteRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        InstallState? state;
        try { state = JsonSerializer.Deserialize<InstallState>(secrets.Unprotect(req.State)); } catch (Exception e) when (e is not OperationCanceledException) { state = null; }   // forged, cut short or from another server
        if (state is null || state.Tenant != ctx.RequireTenantId() || state.User != ctx.RequireUserId() || state.Expires < clock.Now.Ticks)
            throw new ValidationException("state", "This install link expired or belongs to another workspace. Start again from Settings › Integrations.");
        if (string.IsNullOrWhiteSpace(req.Code)) throw new ValidationException("code", "GitHub did not confirm who installed the app. Turn on \"Request user authorization\" for the app and install again.");
        var reachable = await github.InstallationsOfUserAsync(req.Code, ct);
        if (!reachable.Contains(req.InstallationId)) throw new ForbiddenException("Your GitHub account cannot reach that installation.", "GITHUB_INSTALLATION_NOT_YOURS");
        var info = await github.AsAppAsync(HttpMethod.Get, $"app/installations/{req.InstallationId}", ct);
        var taken = await db.GitHubInstallations.IgnoreQueryFilters().AnyAsync(x => x.InstallationId == req.InstallationId && x.TenantId != ctx.TenantId, ct);
        if (taken) throw new ConflictException("This GitHub installation is already connected to another workspace.");
        var row = await db.GitHubInstallations.FirstOrDefaultAsync(x => x.InstallationId == req.InstallationId, ct);
        if (row is null) { row = new GitHubInstallation { TenantId = ctx.RequireTenantId(), InstallationId = req.InstallationId, InstalledBy = ctx.RequireUserId(), CreatedAt = clock.Now, CreatedBy = ctx.UserId }; db.GitHubInstallations.Add(row); }
        row.AccountLogin = Cut(info?["account"]?["login"]?.ToString(), 100) ?? "";
        row.AccountType = info?["account"]?["type"]?.ToString() == "User" ? "User" : "Organization";
        row.RepositorySelection = info?["repository_selection"]?.ToString() == "all" ? "all" : "selected";
        row.SuspendedAt = null; row.LastError = null; row.UpdatedAt = clock.Now;
        row.Repositories = await RepositoriesAsync(req.InstallationId, ct);
        recorder.Audit("github.app_installed", "GitHubInstallation", row.Id, null, new { row.AccountLogin, row.RepositorySelection });
        await db.SaveChangesAsync(ct);
        return await StatusAsync(ct);
    }

    internal async Task<string> RepositoriesAsync(long installationId, CancellationToken ct)
    {
        var names = new List<string>();
        for (var page = 1; page <= 3 && names.Count < MaxRepositories; page++)
        {
            var res = await github.AsInstallationAsync(installationId, HttpMethod.Get, $"installation/repositories?per_page=100&page={page}", null, ct);
            var batch = (res?["repositories"] as JsonArray ?? []).Select(r => r?["full_name"]?.ToString()).Where(n => n is { Length: > 0 }).Select(n => n!).ToList();
            names.AddRange(batch);
            if (batch.Count < 100) break;
        }
        var joined = string.Join('\n', names.Take(MaxRepositories));
        return joined.Length > 20000 ? joined[..20000] : joined;
    }

    public async Task<GitHubAppStatusDto> SaveSettingsAsync(SaveGitHubSettingsRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        var row = await db.GitHubInstallations.OrderByDescending(x => x.CreatedAt).FirstOrDefaultAsync(ct) ?? throw new NotFoundException("Install the GitHub App first.");
        if (req.Rules is { } rules)
        {
            static string? Clean(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim().Length > 60 ? s.Trim()[..60] : s.Trim();
            row.StatusRules = JsonSerializer.Serialize(new GitHubStatusRules(Clean(rules.Opened), Clean(rules.Approved), Clean(rules.Merged), rules.ReopenOnRevert), new JsonSerializerOptions(JsonSerializerDefaults.Web));
        }
        if (req.RiskyPaths is { } paths)
        {
            var clean = paths.Select(p => (p ?? "").Trim().Trim('/')).Where(p => p.Length is > 0 and <= 120).Distinct().Take(30).ToList();
            if (clean.Any(p => p.Contains("..", StringComparison.Ordinal))) throw new ValidationException("riskyPaths", "Write folders like db/migrations or src/payments.");
            row.RiskyPaths = string.Join('\n', clean);
        }
        if (req.CloseOnKeyword is { } close) row.CloseOnKeyword = close;
        row.UpdatedAt = clock.Now; row.UpdatedBy = ctx.UserId;
        recorder.Audit("github.settings_changed", "GitHubInstallation", row.Id, null, new { row.StatusRules, row.RiskyPaths, row.CloseOnKeyword });
        await db.SaveChangesAsync(ct);
        return await StatusAsync(ct);
    }

    /// <summary>Forgets the installation here (the app stays installed on GitHub until removed there; its events are then ignored).</summary>
    public async Task DisconnectAsync(CancellationToken ct = default)
    {
        RequireAdmin();
        var rows = await db.GitHubInstallations.ToListAsync(ct);
        foreach (var r in rows) { GitHubAppClient.Forget(r.InstallationId); db.GitHubInstallations.Remove(r); }
        recorder.Audit("github.app_disconnected", "Tenant", ctx.RequireTenantId(), null, new { count = rows.Count });
        await db.SaveChangesAsync(ct);
    }

    // ---------------------------------------------------------------- start from the task

    private static readonly Regex Slug = new("[^a-z0-9]+", RegexOptions.Compiled);

    /// <summary>The branch name for a task: its key and a short slug of its title (WEB-12-fix-portal-login).</summary>
    public static string BranchName(string key, string title)
    {
        var slug = Slug.Replace(title.ToLowerInvariant(), "-").Trim('-');
        if (slug.Length > 40) slug = slug[..40].TrimEnd('-');
        return slug.Length == 0 ? key : $"{key}-{slug}";
    }

    /// <summary>Creates a branch named after the task from the repository's default (or a chosen) branch. From then on everything on it links to the task.</summary>
    public async Task<BranchDto> CreateBranchAsync(Guid taskId, CreateBranchRequest req, CancellationToken ct = default)
    {
        var task = await access.VisibleTasks().AsNoTracking().Where(t => t.Id == taskId).Select(t => new { t.Id, t.Number, t.Title, Key = t.Project!.Key, t.ProjectId }).FirstOrDefaultAsync(ct)
            ?? throw new NotFoundException("Task not found.");
        await permissions.RequireAsync(Permissions.TasksEdit, ct);
        await access.EnsureWritableAsync(task.ProjectId, "start a branch", ct);
        var inst = await db.GitHubInstallations.AsNoTracking().OrderByDescending(x => x.CreatedAt).FirstOrDefaultAsync(ct) ?? throw new ConflictException("Install the GitHub App first (Settings › Integrations).", "GITHUB_NOT_INSTALLED");
        var repo = (req.Repository ?? "").Trim();
        if (!Lines(inst.Repositories).Contains(repo, StringComparer.OrdinalIgnoreCase)) throw new ValidationException("repository", "Choose one of the repositories the app can reach.");
        var key = $"{task.Key}-{task.Number}";
        var name = BranchName(key, task.Title);
        var baseBranch = req.Base?.Trim();
        if (string.IsNullOrEmpty(baseBranch))
            baseBranch = (await github.AsInstallationAsync(inst.InstallationId, HttpMethod.Get, $"repos/{repo}", null, ct))?["default_branch"]?.ToString() ?? "main";
        if (!Regex.IsMatch(baseBranch, @"^[A-Za-z0-9._/\-]{1,200}$")) throw new ValidationException("base", "That branch name cannot be used.");
        var head = await github.AsInstallationAsync(inst.InstallationId, HttpMethod.Get, $"repos/{repo}/git/ref/heads/{baseBranch}", null, ct);
        var sha = head?["object"]?["sha"]?.ToString() ?? throw new ValidationException("base", $"{baseBranch} was not found in {repo}.");
        try { await github.AsInstallationAsync(inst.InstallationId, HttpMethod.Post, $"repos/{repo}/git/refs", new { @ref = $"refs/heads/{name}", sha }, ct); }
        catch (ConflictException e) when (e.Message.Contains("422", StringComparison.Ordinal)) { /* already there: link it anyway */ }
        var url = $"{O.WebBaseUrl.TrimEnd('/')}/{repo}/tree/{name}";
        if (!await db.DevLinks.AnyAsync(l => l.TaskId == taskId && l.Kind == "branch" && l.ExternalId == name && l.Repository == repo, ct))
            db.DevLinks.Add(new DevLink { TenantId = ctx.RequireTenantId(), TaskId = taskId, Provider = GitProvider.GitHub, Kind = "branch", ExternalId = Cut(name, 80)!, Title = Cut(name, 300)!,
                Url = url, Repository = repo, Branch = name, OccurredAt = clock.Now, CreatedAt = clock.Now, CreatedBy = ctx.UserId });
        recorder.Audit("github.branch_created", "Task", taskId, null, new { repo, name, baseBranch });
        await db.SaveChangesAsync(ct);
        return new BranchDto(name, url, repo);
    }

    // ---------------------------------------------------------------- review queue

    /// <summary>The person's GitHub user id, when they connected GitHub to their account (Account › Connected accounts).</summary>
    private async Task<long?> MyGitHubIdAsync(CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var subject = await db.UserLogins.AsNoTracking().Where(l => l.UserId == me && l.Provider == "github").Select(l => l.Subject).FirstOrDefaultAsync(ct);
        return long.TryParse(subject, out var id) ? id : null;
    }

    /// <summary>Pull requests waiting on my review (oldest first), and my own waiting on others.</summary>
    public async Task<ReviewQueueDto> ReviewQueueAsync(CancellationToken ct = default)
    {
        var mine = await MyGitHubIdAsync(ct);
        if (mine is null) return new ReviewQueueDto(0, null, [], false);
        var id = mine.Value.ToString(CultureInfo.InvariantCulture);
        var open = await db.DevLinks.AsNoTracking().Where(l => l.Kind == "pull_request" && l.State == "open" && !l.Draft
                && (l.AuthorGitHubId == mine || (l.ReviewerIds != null && ("," + l.ReviewerIds + ",").Contains("," + id + ","))))
            .OrderBy(l => l.ReviewRequestedAt ?? l.OpenedAt ?? l.OccurredAt).Take(200).ToListAsync(ct);
        var keys = await TaskKeysAsync(open.Select(l => l.TaskId), open.Select(l => l.WorkTaskId), ct);
        var now = clock.Now;
        var items = open.GroupBy(l => (l.Repository, l.ExternalId)).Select(g =>
        {
            var l = g.First();
            var since = l.ReviewRequestedAt ?? l.OpenedAt ?? l.OccurredAt;
            var role = l.AuthorGitHubId == mine ? "author" : "reviewer";
            var key = g.Select(x => x.TaskId is { } t ? keys.GetValueOrDefault(t) : x.WorkTaskId is { } w ? keys.GetValueOrDefault(w) : null).FirstOrDefault(k => k is not null);
            return new PullReviewItemDto(l.Id, l.Repository ?? "", l.ExternalId, l.Title, l.Url, l.Author, since, (int)Math.Floor((now - since).TotalDays), key, l.ChecksState, l.RiskScore, role);
        }).OrderBy(x => x.Role == "reviewer" ? 0 : 1).ThenBy(x => x.WaitingSince).Take(30).ToList();
        var waiting = items.Where(i => i.Role == "reviewer").ToList();
        return new ReviewQueueDto(waiting.Count, waiting.Count == 0 ? null : waiting.Max(w => w.Days), items, true);
    }

    private async Task<Dictionary<Guid, string>> TaskKeysAsync(IEnumerable<Guid?> taskIds, IEnumerable<Guid?> workIds, CancellationToken ct)
    {
        var t = taskIds.Where(x => x is not null).Select(x => x!.Value).Distinct().ToList();
        var w = workIds.Where(x => x is not null).Select(x => x!.Value).Distinct().ToList();
        var keys = new Dictionary<Guid, string>();
        if (t.Count > 0)
            foreach (var x in await db.Tasks.AsNoTracking().Where(x => t.Contains(x.Id)).Select(x => new { x.Id, x.Number, Key = x.Project!.Key }).ToListAsync(ct)) keys[x.Id] = $"{x.Key}-{x.Number}";
        if (w.Count > 0)
            foreach (var x in await db.WorkTasks.AsNoTracking().Where(x => w.Contains(x.Id)).Select(x => new { x.Id, x.Number, x.Kind }).ToListAsync(ct)) keys[x.Id] = ProjectManagement.Application.Features.WorkItems.WorkItemService.KeyOf(x.Kind, x.Number);
        return keys;
    }

    // ---------------------------------------------------------------- release notes

    /// <summary>Merged pull requests of a project's tasks in a period, grouped by task, as a draft to approve and send.</summary>
    public async Task<ReleaseNotesDto> ReleaseNotesAsync(Guid projectId, DateOnly? fromDate, DateOnly? toDate, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        var end = toDate ?? DateOnly.FromDateTime(clock.Now);
        var start = fromDate ?? end.AddDays(-14);
        if (start > end) (start, end) = (end, start);
        var a = start.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc); var b = end.AddDays(1).ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
        var rows = await (from l in db.DevLinks.AsNoTracking()
                          join t in access.VisibleTasks().AsNoTracking() on l.TaskId equals (Guid?)t.Id
                          where t.ProjectId == projectId && l.Kind == "pull_request" && l.State == "merged" && (l.MergedAt ?? l.OccurredAt) >= a && (l.MergedAt ?? l.OccurredAt) < b
                          orderby t.Number
                          select new { t.Number, t.Title, l.Repository, l.ExternalId, PrTitle = l.Title, l.Url, l.Author, Merged = l.MergedAt ?? l.OccurredAt }).Take(1000).ToListAsync(ct);
        var key = project.Key;
        var tasks = rows.GroupBy(r => (r.Number, r.Title)).Select(g => new ReleaseNoteTask($"{key}-{g.Key.Number}", g.Key.Title,
            g.GroupBy(x => (x.Repository, x.ExternalId)).Select(x => x.First()).Select(x => new ReleaseNotePr(x.Repository ?? "", x.ExternalId, x.PrTitle, x.Url, x.Author, x.Merged)).ToList())).ToList();
        var md = new StringBuilder();
        md.Append($"# {project.Name}: release notes, {start:d MMM} to {end:d MMM yyyy}\n\n");
        if (tasks.Count == 0) md.Append("No merged pull requests in this period.\n");
        foreach (var t in tasks)
        {
            md.Append($"- **{t.Key}** {t.Title}\n");
            foreach (var pr in t.PullRequests) md.Append($"  - {pr.Title} ([{pr.Repository}#{pr.Number}]({pr.Url}){(pr.Author is null ? "" : $", {pr.Author}")})\n");
        }
        return new ReleaseNotesDto(start, end, tasks, [], md.ToString());
    }

    /// <summary>Saves release notes as a draft DocTracker page in the project's space, ready to review and publish.</summary>
    public async Task<Guid> ReleaseNotesPageAsync(Guid projectId, DateOnly? fromDate, DateOnly? toDate, CancellationToken ct = default)
    {
        var notes = await ReleaseNotesAsync(projectId, fromDate, toDate, ct);
        var type = await db.DocumentTypes.AsNoTracking().Where(t => t.Code == DocumentTemplates.PageCode).Select(t => t.Id).FirstOrDefaultAsync(ct);
        if (type == Guid.Empty) throw new ConflictException("Pages are not set up in this workspace.");
        var content = new JsonArray();
        JsonObject Text(string s) => new() { ["type"] = "text", ["text"] = s };
        JsonObject Para(params JsonNode[] parts) => new() { ["type"] = "paragraph", ["content"] = new JsonArray(parts) };
        content.Add(Para(Text($"What shipped from {notes.From:d MMM} to {notes.To:d MMM yyyy}, from merged pull requests. Review, then publish.")));
        foreach (var t in notes.Tasks)
        {
            content.Add(new JsonObject { ["type"] = "heading", ["attrs"] = new JsonObject { ["level"] = 3 }, ["content"] = new JsonArray(Text($"{t.Key} {t.Title}")) });
            var list = new JsonArray();
            foreach (var pr in t.PullRequests) list.Add(new JsonObject { ["type"] = "listItem", ["content"] = new JsonArray(Para(Text($"{pr.Title} ({pr.Repository}#{pr.Number})"))) });
            content.Add(new JsonObject { ["type"] = "bulletList", ["content"] = list });
        }
        if (notes.Tasks.Count == 0) content.Add(Para(Text("No merged pull requests in this period.")));
        var doc = new JsonObject { ["type"] = "doc", ["content"] = content }.ToJsonString();
        var documents = services.GetRequiredService<DocumentService>();
        var created = await documents.CreateAsync(new CreateDocumentRequest($"Release notes {notes.From:d MMM} – {notes.To:d MMM yyyy}", type, projectId,
            Sections: [new SectionInput(DocumentTemplates.PageBody, doc)], Icon: "🚀"), ct);
        return created.Item.Id;
    }

    // ---------------------------------------------------------------- delivery metrics

    public static bool IsProduction(string environment) =>
        environment.Equals("production", StringComparison.OrdinalIgnoreCase) || environment.Equals("prod", StringComparison.OrdinalIgnoreCase)
        || environment.Equals("live", StringComparison.OrdinalIgnoreCase) || environment.Contains("prod", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Lead time (first commit to production, or to merge when no deployments are reported), deploys a week, the share of production deploys
    /// that failed, and how long it took to restore after one, week by week. For one project (its tasks' repositories) or the whole workspace.
    /// </summary>
    public async Task<DeliveryMetricsDto> MetricsAsync(Guid? projectId, int days, CancellationToken ct = default)
    {
        days = Math.Clamp(days, 28, 180);
        var since = clock.Now.AddDays(-days);
        var prs = db.DevLinks.AsNoTracking().Where(l => l.Kind == "pull_request" && l.State == "merged" && l.MergedAt >= since);
        if (projectId is { } pid)
        {
            await access.GetProjectAsync(pid, ct);
            var taskIds = access.VisibleTasks().Where(t => t.ProjectId == pid).Select(t => t.Id);
            prs = prs.Where(l => l.TaskId != null && taskIds.Contains(l.TaskId.Value));
        }
        var merged = (await prs.Select(l => new { l.Repository, l.ExternalId, l.MergedAt, l.FirstCommitAt, l.OpenedAt }).ToListAsync(ct))
            .GroupBy(x => (x.Repository, x.ExternalId)).Select(g => g.First()).ToList();
        var repos = merged.Select(m => m.Repository).Where(r => r is not null).Select(r => r!).Distinct().ToList();
        var deployQuery = db.GitDeployments.AsNoTracking().Where(d => d.StartedAt >= since);
        if (projectId is not null) deployQuery = deployQuery.Where(d => repos.Contains(d.Repository));
        var deploys = (await deployQuery.OrderBy(d => d.StartedAt).ToListAsync(ct)).Where(d => IsProduction(d.Environment)).ToList();
        if (projectId is null) repos = repos.Union(deploys.Select(d => d.Repository)).Distinct().ToList();

        var notes = new List<string>();
        var successes = deploys.Where(d => d.State == "success").ToList();
        var failed = deploys.Where(d => d.State is "failure" or "error").ToList();
        // Lead time: each merged pull request to the first successful production deploy of its repository after the merge.
        var leads = new List<(DateTime Merged, double Hours)>();
        var basis = successes.Count > 0 ? "first commit to production" : "first commit to merge";
        foreach (var m in merged)
        {
            var start = m.FirstCommitAt ?? m.OpenedAt ?? m.MergedAt!.Value;
            var deploy = successes.FirstOrDefault(d => d.Repository == m.Repository && d.StartedAt >= m.MergedAt);
            var endAt = successes.Count > 0 ? deploy?.FinishedAt ?? deploy?.StartedAt : m.MergedAt;
            if (endAt is { } e && e >= start) leads.Add((m.MergedAt!.Value, (e - start).TotalHours));
        }
        if (successes.Count == 0) notes.Add("No production deployments were reported yet, so lead time stops at merge. Use GitHub deployments (or environments in Actions) named production.");
        // Time to restore: a failed production deploy until the next successful one of the same repository.
        var restores = failed.Select(f => successes.FirstOrDefault(s => s.Repository == f.Repository && s.StartedAt > f.StartedAt) is { } s ? ((s.FinishedAt ?? s.StartedAt) - f.StartedAt).TotalHours : (double?)null)
            .Where(h => h is not null).Select(h => h!.Value).ToList();

        var weeks = new List<DeliveryWeekDto>();
        var first = ProjectManagement.Application.Features.Time.TimesheetApprovalService.WeekOf(DateOnly.FromDateTime(since));
        for (var w = first; w <= DateOnly.FromDateTime(clock.Now); w = w.AddDays(7))
        {
            var a = w.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc); var b = a.AddDays(7);
            var inWeek = leads.Where(l => l.Merged >= a && l.Merged < b).Select(l => l.Hours).ToList();
            weeks.Add(new DeliveryWeekDto(w, successes.Count(d => d.StartedAt >= a && d.StartedAt < b), failed.Count(d => d.StartedAt >= a && d.StartedAt < b),
                Median(inWeek), merged.Count(m => m.MergedAt >= a && m.MergedAt < b)));
        }
        var production = successes.Count + failed.Count;
        return new DeliveryMetricsDto(days, Median(leads.Select(l => l.Hours).ToList()), basis, Math.Round(successes.Count / (decimal)days * 7m, 1),
            production == 0 ? null : Math.Round(failed.Count / (decimal)production, 4), Median(restores), weeks, notes, repos);
    }

    private static decimal? Median(List<double> xs)
    {
        if (xs.Count == 0) return null;
        xs.Sort();
        var mid = xs.Count / 2;
        var v = xs.Count % 2 == 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
        return Math.Round((decimal)v, 1);
    }

    // ---------------------------------------------------------------- who knows this code

    /// <summary>
    /// People who changed files whose path shares a word with the task's title in the last four months (from merged pull requests), most first,
    /// with the reason in plain words. Only members whose GitHub account is connected can be matched.
    /// </summary>
    public async Task<IReadOnlyList<(Guid UserId, string Name, string Why)>> CodeOwnersAsync(IReadOnlySet<string> words, CancellationToken ct)
    {
        if (words.Count == 0) return [];
        var since = clock.Now.AddDays(-120);
        var prs = await db.DevLinks.AsNoTracking().Where(l => l.Kind == "pull_request" && l.State == "merged" && l.MergedAt >= since && l.Files != null && l.AuthorGitHubId != null)
            .Select(l => new { l.AuthorGitHubId, l.Files, l.Repository, l.ExternalId }).Take(2000).ToListAsync(ct);
        var counts = new Dictionary<long, (int Count, string Path)>();
        foreach (var pr in prs.GroupBy(p => (p.Repository, p.ExternalId)).Select(g => g.First()))
        {
            var hit = Lines(pr.Files).FirstOrDefault(f => f.ToLowerInvariant().Split('/', '.', '-', '_').Any(words.Contains));
            if (hit is null) continue;
            var author = pr.AuthorGitHubId!.Value;
            counts[author] = counts.TryGetValue(author, out var c) ? (c.Count + 1, c.Path) : (1, hit);
        }
        if (counts.Count == 0) return [];
        var ids = counts.Keys.Select(k => k.ToString(CultureInfo.InvariantCulture)).ToList();
        var tenant = ctx.RequireTenantId();
        var people = await (from l in db.UserLogins.AsNoTracking()
                            join m in db.TenantMembers.AsNoTracking() on l.UserId equals m.UserId
                            join u in db.Users.AsNoTracking() on l.UserId equals u.Id
                            where l.Provider == "github" && ids.Contains(l.Subject) && m.TenantId == tenant && u.IsActive && m.Role != TenantRole.Guest
                            select new { l.Subject, u.Id, u.DisplayName }).ToListAsync(ct);
        return people.Select(p => (p.Id, p.DisplayName, Count: counts[long.Parse(p.Subject, CultureInfo.InvariantCulture)]))
            .OrderByDescending(p => p.Count.Count).Take(3)
            .Select(p => (p.Id, p.DisplayName, $"changed {p.Count.Path}{(p.Count.Count > 1 ? $" and related files in {p.Count.Count} pull requests" : "")} in the last four months")).ToList();
    }

    internal static string? Cut(string? s, int max) => s is null ? null : s.Length <= max ? s : s[..(max - 1)] + "…";
}
