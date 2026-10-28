using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Integrations;

/// <summary>
/// Events from the ProjectTracker GitHub App (one webhook for every workspace, signed with the app's secret). The installation in the event
/// picks the workspace; from then on everything runs in that workspace only. Pushes, pull requests, reviews, checks, deployments and new
/// branches that mention a task key are linked to the task; status follows the code by the workspace's rules; each pull request gets a risk
/// score with its reasons.
/// </summary>
public class GitHubAppWebhook(IAppDbContext db, CurrentContext ctx, AppClock clock, GitHubAppClient github, IServiceProvider services, ILogger<GitHubAppWebhook> log)
{
    private sealed record Linked(DevLink Link, string Key, Guid? TaskId, Guid? WorkTaskId, bool Closes);

    /// <summary>Returns false when the signature is wrong (the caller answers 401).</summary>
    public async Task<bool> ReceiveAsync(byte[] body, string? signature, string? eventName, CancellationToken ct)
    {
        if (!github.SignatureValid(body, signature)) return false;
        JsonNode? root;
        try { root = JsonNode.Parse(body); } catch (System.Text.Json.JsonException) { return true; }
        if (root is null) return true;
        var action = root["action"]?.ToString();
        var installationId = root["installation"]?["id"]?.GetValue<long>();
        if (installationId is not { } iid) return true;

        // Only the installation's routing row is read across workspaces, after the app's signature was checked.
        var inst = await db.GitHubInstallations.IgnoreQueryFilters().FirstOrDefaultAsync(i => i.InstallationId == iid, ct);
        if (inst is null) return true;   // not connected to a workspace (yet): the install callback does that
        if (eventName == "installation" && action == "deleted")
        {
            GitHubAppClient.Forget(iid);
            db.GitHubInstallations.Remove(inst);
            await db.SaveChangesAsync(ct);
            return true;
        }
        if (!await db.Tenants.IgnoreQueryFilters().AnyAsync(t => t.Id == inst.TenantId && t.Status == TenantStatus.Active, ct)) return true;
        var original = (ctx.TenantId, ctx.UserId, ctx.Role, ctx.WorkspaceType);
        ctx.TenantId = inst.TenantId; ctx.UserId = null; ctx.Role = null;
        ctx.WorkspaceType = await db.Tenants.AsNoTracking().Where(t => t.Id == inst.TenantId).Select(t => (WorkspaceType?)t.Type).FirstOrDefaultAsync(ct);
        try
        {
            inst.Received++; inst.LastEventAt = clock.Now;
            switch (eventName)
            {
                case "installation" when action is "suspend": inst.SuspendedAt = clock.Now; break;
                case "installation" when action is "unsuspend" or "new_permissions_accepted": inst.SuspendedAt = null; break;
                case "installation_repositories": inst.Repositories = await services.GetRequiredService<GitHubAppService>().RepositoriesAsync(iid, ct); break;
                case "push": await PushAsync(inst, root, ct); break;
                case "pull_request": await PullRequestAsync(inst, root, action, ct); break;
                case "pull_request_review": await ReviewAsync(inst, root, ct); break;
                case "check_suite": await ChecksAsync(root["check_suite"]?["head_sha"]?.ToString(), Conclusion(root["check_suite"]), ct); break;
                case "check_run": await ChecksAsync(root["check_run"]?["head_sha"]?.ToString(), Conclusion(root["check_run"]), ct); break;
                case "deployment_status": await DeploymentAsync(root, ct); break;
                case "create" when root["ref_type"]?.ToString() == "branch": await BranchAsync(inst, root, ct); break;
            }
            inst.LastError = null;
        }
        catch (Exception e) when (e is AppException or HttpRequestException or TaskCanceledException)
        {
            inst.LastError = GitHubAppService.Cut($"{clock.Now:dd MMM HH:mm} UTC: {eventName}: {e.Message}", 300);
            log.LogInformation("GitHub {Event} for installation {Installation}: {Reason}", eventName, iid, e.Message);
        }
        finally
        {
            await db.SaveChangesAsync(CancellationToken.None);
            (ctx.TenantId, ctx.UserId, ctx.Role, ctx.WorkspaceType) = original;
        }
        return true;
    }

    private static string? S(JsonNode? n) => n?.GetValueKind() == System.Text.Json.JsonValueKind.String ? n.GetValue<string>() : n?.ToString();
    private static DateTime? When(JsonNode? n) => DateTime.TryParse(S(n), CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var d) ? d : null;

    private static string? Conclusion(JsonNode? run) => S(run?["status"]) != "completed" ? "pending"
        : S(run?["conclusion"]) switch { "success" or "neutral" or "skipped" => "success", null => "pending", _ => "failure" };

    /// <summary>The tasks a text mentions in this workspace, as links of one kind for one change (created or updated).</summary>
    private async Task<List<Linked>> LinkAsync(string text, string kind, string externalId, string title, string url, string? repo, string? author, string? state,
        DateTime occurredAt, Action<DevLink>? fill, CancellationToken ct)
    {
        var (mentioned, closed) = GitLinkService.KeysIn(text);
        var linked = new List<Linked>();
        foreach (var key in mentioned.Take(20))
        {
            var dash = key.LastIndexOf('-');
            var prefix = key[..dash]; var number = int.Parse(key[(dash + 1)..], CultureInfo.InvariantCulture);
            Guid? taskId = null, workTaskId = null; Guid? projectId = null;
            if (prefix is "WT" or "AI")
            {
                var wk = prefix == "WT" ? WorkTaskKind.Operational : WorkTaskKind.ActionItem;
                workTaskId = await db.WorkTasks.Where(w => w.Kind == wk && w.Number == number).Select(w => (Guid?)w.Id).FirstOrDefaultAsync(ct);
            }
            if (workTaskId is null)
            {
                var hit = await db.Tasks.Where(t => t.Number == number && t.Project!.Key == prefix).Select(t => new { t.Id, t.ProjectId }).FirstOrDefaultAsync(ct);
                taskId = hit?.Id; projectId = hit?.ProjectId;
            }
            if (taskId is null && workTaskId is null) continue;
            var link = await db.DevLinks.FirstOrDefaultAsync(l => l.Provider == GitProvider.GitHub && l.Kind == kind && l.ExternalId == externalId && l.Repository == repo
                && l.TaskId == taskId && l.WorkTaskId == workTaskId, ct);
            if (link is null)
            {
                link = new DevLink { TenantId = ctx.TenantId!.Value, TaskId = taskId, WorkTaskId = workTaskId, Provider = GitProvider.GitHub, Kind = kind, ExternalId = GitHubAppService.Cut(externalId, 80)!,
                    Repository = GitHubAppService.Cut(repo, 200), CreatedAt = clock.Now, OccurredAt = occurredAt };
                db.DevLinks.Add(link);
                var label = kind switch { "commit" => $"commit {externalId[..Math.Min(7, externalId.Length)]}", "branch" => $"branch {externalId}", _ => $"pull request #{externalId}" };
                db.Activities.Add(new Activity
                {
                    TenantId = ctx.TenantId!.Value, ProjectId = projectId, Action = workTaskId is null ? "task.dev_linked" : "worktask.dev_linked",
                    EntityType = workTaskId is null ? "Task" : "WorkTask", EntityId = taskId ?? workTaskId, CreatedAt = clock.Now,
                    Summary = GitHubAppService.Cut($"{key}: linked {label} “{title}”{(author is null ? "" : $" by {author}")} (GitHub)", 500)!,
                });
            }
            link.Title = GitHubAppService.Cut(title, 300) ?? link.Title; link.Url = GitHubAppService.Cut(url, 500) ?? link.Url; link.Author = GitHubAppService.Cut(author, 120) ?? link.Author;
            if (state is not null) link.State = state;
            fill?.Invoke(link);
            linked.Add(new Linked(link, key, taskId, workTaskId, closed.Contains(key)));
        }
        return linked;
    }

    private async Task PushAsync(GitHubInstallation inst, JsonNode root, CancellationToken ct)
    {
        var changes = GitLinkService.Parse(GitProvider.GitHub, "push", root).Take(100).ToList();
        foreach (var c in changes)
        {
            var links = await LinkAsync(c.Message, "commit", c.ExternalId, c.Title, c.Url, c.Repository, c.Author, null, c.OccurredAt, null, ct);
            await db.SaveChangesAsync(ct);
            if (inst.CloseOnKeyword && c.Completes)
                foreach (var l in links.Where(l => l.Closes)) await CompleteAsync(inst, l, c.AuthorEmail, null, ct);
        }
    }

    private async Task BranchAsync(GitHubInstallation inst, JsonNode root, CancellationToken ct)
    {
        var name = S(root["ref"]) ?? "";
        var repo = S(root["repository"]?["full_name"]);
        await LinkAsync(name, "branch", name, name, $"{S(root["repository"]?["html_url"])}/tree/{name}", repo, S(root["sender"]?["login"]), null, clock.Now, l => l.Branch = name, ct);
    }

    private async Task PullRequestAsync(GitHubInstallation inst, JsonNode root, string? action, CancellationToken ct)
    {
        if (root["pull_request"] is not JsonObject pr) return;
        var repo = S(root["repository"]?["full_name"]);
        var number = S(pr["number"]) ?? "";
        var merged = pr["merged"]?.GetValue<bool>() == true;
        var state = merged ? "merged" : S(pr["state"]) ?? "open";
        var title = S(pr["title"]) ?? "";
        var branch = S(pr["head"]?["ref"]);
        var text = $"{title}\n{S(pr["body"])}\n{branch}";
        var reviewers = (pr["requested_reviewers"] as JsonArray ?? []).Select(r => r?["id"]?.GetValue<long>()).Where(x => x is not null).Select(x => x!.Value.ToString(CultureInfo.InvariantCulture)).ToList();
        var files = action is "opened" or "synchronize" or "ready_for_review" or "reopened" || (action == "closed" && merged) ? await FilesAsync(inst, repo, number, ct) : null;
        DateTime? firstCommit = merged && action == "closed" ? await FirstCommitAsync(inst, repo, number, ct) : null;
        var links = await LinkAsync(text, "pull_request", number, title, S(pr["html_url"]) ?? "", repo, S(pr["user"]?["login"]), state, When(pr["updated_at"]) ?? clock.Now, l =>
        {
            l.Branch = GitHubAppService.Cut(branch, 200); l.HeadSha = S(pr["head"]?["sha"]); l.Draft = pr["draft"]?.GetValue<bool>() == true;
            l.AuthorGitHubId = pr["user"]?["id"]?.GetValue<long>();
            l.OpenedAt ??= When(pr["created_at"]);
            l.MergedAt = When(pr["merged_at"]) ?? l.MergedAt;
            if (pr["additions"] is not null) { l.Additions = pr["additions"]?.GetValue<int>(); l.Deletions = pr["deletions"]?.GetValue<int>(); l.ChangedFiles = pr["changed_files"]?.GetValue<int>(); }
            var joined = string.Join(',', reviewers);
            if (joined != (l.ReviewerIds ?? "")) { l.ReviewerIds = joined.Length == 0 ? null : GitHubAppService.Cut(joined, 400); if (joined.Length > 0) l.ReviewRequestedAt = clock.Now; }
            if (action == "review_requested" && l.ReviewRequestedAt is null) l.ReviewRequestedAt = clock.Now;
            if (files is not null) l.Files = files.Count == 0 ? l.Files : GitHubAppService.Cut(string.Join('\n', files.Take(60).Select(f => f.Path)), 8000);
            if (firstCommit is { } fc) l.FirstCommitAt = fc;
        }, ct);
        // A merged revert ("Reverts owner/repo#42", as GitHub writes it) reopens the tasks of the pull request it reverts, and does not itself complete anything.
        var revert = merged && action == "closed" && Regex.Match(S(pr["body"]) ?? "", @"Reverts\s+[\w.\-]+/[\w.\-]+#(\d+)") is { Success: true } rev ? rev.Groups[1].Value : null;
        if (links.Count == 0 && revert is null) return;
        // Risk: a reason to look twice, never a gate.
        if (files is not null)
            foreach (var l in links)
            {
                var (score, reasons) = await RiskAsync(inst, l.Link, files, ct);
                l.Link.RiskScore = score; l.Link.RiskReasons = reasons.Count == 0 ? null : GitHubAppService.Cut(string.Join('\n', reasons), 600);
            }
        await db.SaveChangesAsync(ct);

        var rules = GitHubAppService.RulesOf(inst);
        var authorUser = await MemberOfAsync(pr["user"]?["id"]?.GetValue<long>(), ct);
        if (action is "opened" or "ready_for_review" or "reopened" && !(pr["draft"]?.GetValue<bool>() == true))
            foreach (var l in links) await MoveAsync(inst, l, rules.Opened, StatusCategory.Active, WorkTaskStatus.InProgress, authorUser, ct);
        if (action == "closed" && merged && revert is null)
            foreach (var l in links)
            {
                if (inst.CloseOnKeyword && l.Closes) await CompleteAsync(inst, l, null, authorUser, ct);
                else await MoveAsync(inst, l, rules.Merged, StatusCategory.Done, WorkTaskStatus.Completed, authorUser, ct);
            }
        if (revert is not null && rules.ReopenOnRevert)
        {
            var reverted = await db.DevLinks.Where(x => x.Kind == "pull_request" && x.Repository == repo && x.ExternalId == revert && x.State == "merged").ToListAsync(ct);
            foreach (var r in reverted.Where(r => r.TaskId is not null || r.WorkTaskId is not null).GroupBy(r => (r.TaskId, r.WorkTaskId)).Select(g => g.First()))
                await MoveAsync(inst, new Linked(r, "", r.TaskId, r.WorkTaskId, false), null, StatusCategory.Active, WorkTaskStatus.InProgress, authorUser, ct, reopen: true);
        }
    }

    private async Task ReviewAsync(GitHubInstallation inst, JsonNode root, CancellationToken ct)
    {
        var state = S(root["review"]?["state"])?.ToLowerInvariant();
        var repo = S(root["repository"]?["full_name"]);
        var number = S(root["pull_request"]?["number"]);
        if (number is null || state is not ("approved" or "changes_requested")) return;
        var links = await db.DevLinks.Where(l => l.Kind == "pull_request" && l.Repository == repo && l.ExternalId == number).ToListAsync(ct);
        foreach (var l in links) l.ReviewState = state;
        await db.SaveChangesAsync(ct);
        if (state != "approved") return;
        var rules = GitHubAppService.RulesOf(inst);
        var reviewer = await MemberOfAsync(root["review"]?["user"]?["id"]?.GetValue<long>(), ct);
        foreach (var l in links.Where(l => l.State == "open"))
            await MoveAsync(inst, new Linked(l, "", l.TaskId, l.WorkTaskId, false), rules.Approved, null, null, reviewer, ct);
    }

    private async Task ChecksAsync(string? sha, string? conclusion, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(sha) || conclusion is null) return;
        var links = await db.DevLinks.Where(l => l.HeadSha == sha).ToListAsync(ct);
        // One failing suite keeps the pull request red until a later run passes.
        foreach (var l in links) if (!(l.ChecksState == "failure" && conclusion == "pending")) l.ChecksState = conclusion;
    }

    private async Task DeploymentAsync(JsonNode root, CancellationToken ct)
    {
        var deployment = root["deployment"];
        var id = deployment?["id"]?.GetValue<long>();
        if (id is null) return;
        var state = S(root["deployment_status"]?["state"])?.ToLowerInvariant() ?? "queued";
        var row = await db.GitDeployments.FirstOrDefaultAsync(d => d.DeploymentId == id, ct);
        if (row is null)
        {
            row = new GitDeployment { TenantId = ctx.TenantId!.Value, DeploymentId = id.Value, Repository = GitHubAppService.Cut(S(root["repository"]?["full_name"]), 200) ?? "",
                Environment = GitHubAppService.Cut(S(deployment?["environment"]), 100) ?? "", Sha = GitHubAppService.Cut(S(deployment?["sha"]), 64) ?? "",
                StartedAt = When(deployment?["created_at"]) ?? clock.Now, CreatedAt = clock.Now };
            db.GitDeployments.Add(row);
        }
        row.State = state is "success" or "failure" or "error" or "in_progress" or "queued" or "pending" ? state : "queued";
        if (state is "success" or "failure" or "error") row.FinishedAt = When(root["deployment_status"]?["updated_at"]) ?? clock.Now;
        row.Url = GitHubAppService.Cut(S(root["deployment_status"]?["environment_url"]) ?? S(root["deployment_status"]?["target_url"]), 500);
    }

    private sealed record ChangedFile(string Path, int Additions, int Deletions);

    private async Task<List<ChangedFile>?> FilesAsync(GitHubInstallation inst, string? repo, string number, CancellationToken ct)
    {
        if (repo is null) return null;
        try
        {
            var res = await github.AsInstallationAsync(inst.InstallationId, HttpMethod.Get, $"repos/{repo}/pulls/{number}/files?per_page=100", null, ct);
            return (res as JsonArray ?? []).Select(f => new ChangedFile(S(f?["filename"]) ?? "", f?["additions"]?.GetValue<int>() ?? 0, f?["deletions"]?.GetValue<int>() ?? 0))
                .Where(f => f.Path.Length > 0).ToList();
        }
        catch (Exception e) when (e is AppException or HttpRequestException or TaskCanceledException) { log.LogInformation("GitHub files of {Repo}#{Number}: {Reason}", repo, number, e.Message); return null; }
    }

    private async Task<DateTime?> FirstCommitAsync(GitHubInstallation inst, string? repo, string number, CancellationToken ct)
    {
        if (repo is null) return null;
        try
        {
            var res = await github.AsInstallationAsync(inst.InstallationId, HttpMethod.Get, $"repos/{repo}/pulls/{number}/commits?per_page=100", null, ct);
            return (res as JsonArray ?? []).Select(c => When(c?["commit"]?["author"]?["date"])).Where(d => d is not null).Min();
        }
        catch (Exception e) when (e is AppException or HttpRequestException or TaskCanceledException) { return null; }
    }

    private static readonly Regex TestFile = new(@"(^|/)(tests?|spec|specs|__tests__)/|[._-](test|spec|tests)\.[a-z]+$|Tests?\.cs$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex NotCode = new(@"\.(md|txt|json|ya?ml|lock|svg|png|jpg|gif|css)$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>
    /// 0-100 and the reasons: a large change, many files, code changed with no test changed, a first change by this author to one of the
    /// workspace's risky folders, and a merge outside working hours.
    /// </summary>
    private async Task<(int Score, List<string> Reasons)> RiskAsync(GitHubInstallation inst, DevLink link, List<ChangedFile> files, CancellationToken ct)
    {
        var reasons = new List<string>(); var score = 0;
        var lines = files.Sum(f => f.Additions + f.Deletions);
        if (lines > 1000) { score += 35; reasons.Add($"{lines:N0} lines changed"); }
        else if (lines > 400) { score += 20; reasons.Add($"{lines:N0} lines changed"); }
        if (files.Count > 30) { score += 15; reasons.Add($"{files.Count} files"); }
        var code = files.Where(f => !NotCode.IsMatch(f.Path)).ToList();
        if (code.Count > 0 && !files.Any(f => TestFile.IsMatch(f.Path))) { score += 20; reasons.Add("Code changed with no test changed"); }
        foreach (var folder in GitHubAppService.Lines(inst.RiskyPaths))
        {
            var touched = files.FirstOrDefault(f => f.Path.StartsWith(folder + "/", StringComparison.OrdinalIgnoreCase) || f.Path.Equals(folder, StringComparison.OrdinalIgnoreCase));
            if (touched is null) continue;
            var before = link.AuthorGitHubId is { } author && await db.DevLinks.AnyAsync(l => l.Id != link.Id && l.AuthorGitHubId == author && l.State == "merged" && l.Files != null && l.Files.Contains(folder + "/"), ct);
            if (!before) { score += 25; reasons.Add($"First change to {folder} by {link.Author ?? "this author"}"); break; }
        }
        if (link.MergedAt is { } merged)
        {
            var zone = await db.Tenants.AsNoTracking().Where(t => t.Id == inst.TenantId).Select(t => t.TimeZone).FirstOrDefaultAsync(ct);
            var local = ProjectManagement.Application.Features.Reminders.ZoneTime.ToLocal(merged, ProjectManagement.Application.Features.Reminders.ZoneTime.Find(zone));
            if (local.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday || local.Hour < 8 || local.Hour >= 20)
            { score += 15; reasons.Add($"Merged at {local:HH:mm} on {local:dddd}"); }
        }
        return (Math.Min(100, score), reasons);
    }

    /// <summary>The workspace member whose connected GitHub account has this id.</summary>
    private async Task<Guid?> MemberOfAsync(long? gitHubId, CancellationToken ct)
    {
        if (gitHubId is null) return null;
        var subject = gitHubId.Value.ToString(CultureInfo.InvariantCulture);
        var tenant = ctx.TenantId!.Value;
        return await (from l in db.UserLogins.AsNoTracking()
                      join m in db.TenantMembers.AsNoTracking() on l.UserId equals m.UserId
                      where l.Provider == "github" && l.Subject == subject && m.TenantId == tenant
                      select (Guid?)l.UserId).FirstOrDefaultAsync(ct);
    }

    private async Task CompleteAsync(GitHubInstallation inst, Linked l, string? authorEmail, Guid? acting, CancellationToken ct)
    {
        try
        {
            await GitLinkService.CompleteAsync(services, db, ctx, inst.TenantId, inst.InstalledBy, ctx.WorkspaceType ?? WorkspaceType.Organization, authorEmail, l.TaskId, l.WorkTaskId, ct, acting);
        }
        catch (AppException e) { inst.LastError = GitHubAppService.Cut($"{clock.Now:dd MMM HH:mm} UTC: {l.Key} could not be completed: {e.Message}", 300); }
        finally { ctx.UserId = null; ctx.Role = null; ctx.TenantId = inst.TenantId; }
    }

    /// <summary>
    /// Moves a linked task to the status the rule names (matched by name in its project; for Done, any done status), never backwards out of
    /// Done unless it is a revert. Done as the person on GitHub when they are a member, otherwise as whoever installed the app.
    /// </summary>
    private async Task MoveAsync(GitHubInstallation inst, Linked l, string? statusName, StatusCategory? category, WorkTaskStatus? workStatus, Guid? acting, CancellationToken ct, bool reopen = false)
    {
        if (statusName is null && !reopen && category is null) return;
        // Membership of this installation's organization only: the same person's role in another workspace means nothing here.
        var member = await db.TenantMembers.AsNoTracking().FirstOrDefaultAsync(m => m.TenantId == inst.TenantId && m.UserId == (acting ?? inst.InstalledBy), ct)
            ?? await db.TenantMembers.AsNoTracking().FirstOrDefaultAsync(m => m.TenantId == inst.TenantId && m.UserId == inst.InstalledBy, ct);
        if (member is null) return;
        ctx.UserId = member.UserId; ctx.Role = member.Role;
        try
        {
            if (l.WorkTaskId is { } wid && workStatus is { } ws)
            {
                var current = await db.WorkTasks.AsNoTracking().Where(w => w.Id == wid).Select(w => new { w.Status, w.Kind }).FirstOrDefaultAsync(ct);
                if (current is null || current.Kind != WorkTaskKind.Operational || current.Status == ws) return;
                if (!reopen && current.Status is WorkTaskStatus.Completed or WorkTaskStatus.Cancelled) return;
                await services.GetRequiredService<WorkTaskService>().SetStatusAsync(wid, new SetWorkTaskStatusRequest(ws), ct);
                return;
            }
            if (l.TaskId is not { } tid) return;
            var task = await db.Tasks.AsNoTracking().Where(t => t.Id == tid).Select(t => new { t.ProjectId, t.StatusId, Category = t.Status!.Category }).FirstOrDefaultAsync(ct);
            if (task is null) return;
            if (!reopen && task.Category is StatusCategory.Done or StatusCategory.Cancelled) return;
            if (reopen && task.Category is not (StatusCategory.Done or StatusCategory.Cancelled)) return;
            var statuses = await db.WorkflowStatuses.AsNoTracking().Where(s => s.ProjectId == task.ProjectId).OrderBy(s => s.Order).Select(s => new { s.Id, s.Name, s.Category }).ToListAsync(ct);
            var wanted = statusName?.Trim();
            // The status by its name, or one whose name is part of it ("In Review" finds a status called "Review").
            var target = wanted is null ? null : statuses.FirstOrDefault(s => s.Name.Equals(wanted, StringComparison.OrdinalIgnoreCase))
                ?? statuses.FirstOrDefault(s => wanted.Contains(s.Name, StringComparison.OrdinalIgnoreCase) || s.Name.Contains(wanted, StringComparison.OrdinalIgnoreCase));
            target ??= category is { } cat && (statusName is null || cat == StatusCategory.Done) ? statuses.FirstOrDefault(s => s.Category == cat) : null;
            if (target is null || target.Id == task.StatusId) return;
            await services.GetRequiredService<TaskService>().MoveAsync(tid, new MoveTaskRequest(target.Id, null), ct);
        }
        catch (AppException e) { inst.LastError = GitHubAppService.Cut($"{clock.Now:dd MMM HH:mm} UTC: {l.Key} could not move: {e.Message}", 300); }
        finally { ctx.UserId = null; ctx.Role = null; }
    }
}
