using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Sso;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Integrations;

public record GitConnectionDto(Guid Id, GitProvider Provider, string Name, string WebhookUrl, bool CloseOnKeyword, int Received, DateTime? LastReceivedAt, string? LastError, DateTime CreatedAt);
public record CreatedGitConnectionDto(GitConnectionDto Connection, string Secret);
public record SaveGitConnectionRequest(GitProvider Provider, string? Name, bool CloseOnKeyword = true);
public record DevLinkDto(Guid Id, GitProvider Provider, string Kind, string ExternalId, string Title, string Url, string? Repository, string? Author, string? State, DateTime OccurredAt);

/// <summary>One commit or pull request, whatever the provider.</summary>
public record GitChange(string Kind, string ExternalId, string Title, string Message, string Url, string? Repository, string? Author, string? AuthorEmail,
    string? State, bool Completes, DateTime OccurredAt);

/// <summary>
/// Commit and pull-request linking for GitHub and Azure DevOps. A repository (or organization) sends push and pull-request events to the
/// connection's URL; every commit or pull request that mentions a task key - a project task such as WEB-12, operational work WT-5, an
/// action item AI-7 - is linked to it and shows on the task. With "close on keyword", "fixes WEB-12" / "closes WT-5" in a commit pushed to
/// the default branch, or in a pull request that is merged, completes the task as the person who wrote it (when they are a member).
/// </summary>
public class GitLinkService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, EntitlementService entitlements, ISecretProtector protector, IOptions<AppOptions> app,
    ProjectAccess access, PermissionService permissions)
{
    private const int MaxConnections = 10;

    private string UrlOf(GitConnection c) => $"{PublicUrls.Api(app.Value)}/api/v1/inbound/git/{(c.Provider == GitProvider.GitHub ? "github" : "azure-devops")}/{c.Token}";
    private GitConnectionDto ToDto(GitConnection c) => new(c.Id, c.Provider, c.Name, UrlOf(c), c.CloseOnKeyword, c.Received, c.LastReceivedAt, c.LastError, c.CreatedAt);

    private void RequireAdmin()
    {
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only owners and admins can connect repositories.", "PERMISSION_DENIED");
    }

    public async Task<IReadOnlyList<GitConnectionDto>> ListAsync(CancellationToken ct = default)
    {
        RequireAdmin();
        return (await db.GitConnections.AsNoTracking().OrderBy(c => c.CreatedAt).ToListAsync(ct)).Select(ToDto).ToList();
    }

    public async Task<CreatedGitConnectionDto> CreateAsync(SaveGitConnectionRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        await entitlements.EnsureFeatureAsync(FeatureKeys.ApiAccess, ct);
        if (!Enum.IsDefined(req.Provider)) throw new ValidationException("provider", "Choose GitHub or Azure DevOps.");
        var name = (req.Name ?? "").Trim();
        if (name.Length is < 1 or > 60) throw new ValidationException("name", "Name the connection (up to 60 characters), e.g. the repository.");
        if (await db.GitConnections.CountAsync(ct) >= MaxConnections) throw new ConflictException($"A workspace can have at most {MaxConnections} repository connections.", "LIMIT_REACHED");
        var secret = Convert.ToBase64String(RandomNumberGenerator.GetBytes(24)).Replace('+', 'a').Replace('/', 'b').TrimEnd('=');
        var c = new GitConnection
        {
            TenantId = ctx.RequireTenantId(), Provider = req.Provider, Name = name, CloseOnKeyword = req.CloseOnKeyword,
            Token = Convert.ToHexString(RandomNumberGenerator.GetBytes(12)).ToLowerInvariant(), SecretProtected = protector.Protect(secret), CreatedAt = clock.Now, CreatedBy = ctx.UserId,
        };
        db.GitConnections.Add(c);
        recorder.Audit("git_connection.created", "GitConnection", c.Id, null, new { c.Provider, c.Name });
        await db.SaveChangesAsync(ct);
        return new CreatedGitConnectionDto(ToDto(c), secret);
    }

    public async Task<GitConnectionDto> UpdateAsync(Guid id, SaveGitConnectionRequest req, CancellationToken ct = default)
    {
        RequireAdmin();
        var c = await db.GitConnections.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Connection not found.");
        var name = (req.Name ?? "").Trim();
        if (name.Length is < 1 or > 60) throw new ValidationException("name", "Name the connection (up to 60 characters).");
        c.Name = name; c.CloseOnKeyword = req.CloseOnKeyword; c.UpdatedAt = clock.Now;
        await db.SaveChangesAsync(ct);
        return ToDto(c);
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        RequireAdmin();
        var c = await db.GitConnections.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Connection not found.");
        db.GitConnections.Remove(c);
        recorder.Audit("git_connection.deleted", "GitConnection", id, new { c.Provider, c.Name });
        await db.SaveChangesAsync(ct);
    }

    // ------------------------------------------------------------------ links on a task

    private static DevLinkDto ToDto(DevLink l) => new(l.Id, l.Provider, l.Kind, l.ExternalId, l.Title, l.Url, l.Repository, l.Author, l.State, l.OccurredAt);

    public async Task<IReadOnlyList<DevLinkDto>> ForTaskAsync(Guid taskId, CancellationToken ct = default)
    {
        if (!await access.VisibleTasks().AnyAsync(t => t.Id == taskId, ct)) throw new NotFoundException("Task not found.");
        return (await db.DevLinks.AsNoTracking().Where(l => l.TaskId == taskId).OrderByDescending(l => l.OccurredAt).Take(100).ToListAsync(ct)).Select(ToDto).ToList();
    }

    public async Task<IReadOnlyList<DevLinkDto>> ForWorkTaskAsync(Guid workTaskId, CancellationToken ct = default)
    {
        var w = await db.WorkTasks.AsNoTracking().Where(x => x.Id == workTaskId).Select(x => new { x.Kind, x.RelatedProjectId }).FirstOrDefaultAsync(ct) ?? throw new NotFoundException("Work task not found.");
        var visible = w.Kind == WorkTaskKind.Operational
            ? await permissions.LevelAsync(Modules.Work, ct) > 0
            : w.RelatedProjectId is { } pid && await access.VisibleProjects().AnyAsync(p => p.Id == pid, ct);
        if (!visible) throw new NotFoundException("Work task not found.");
        return (await db.DevLinks.AsNoTracking().Where(l => l.WorkTaskId == workTaskId).OrderByDescending(l => l.OccurredAt).Take(100).ToListAsync(ct)).Select(ToDto).ToList();
    }

    // ------------------------------------------------------------------ receiving events

    private static readonly Regex Keys = new(@"(?<![A-Za-z0-9])([A-Z][A-Z0-9]{0,9})-(\d{1,7})(?![A-Za-z0-9])", RegexOptions.CultureInvariant);
    private static readonly Regex Closing = new(@"\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?|complete[sd]?)\s*:?\s+#?([A-Z][A-Z0-9]{0,9}-\d{1,7})", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>The task keys a text mentions, and which of them it says it fixes.</summary>
    public static (IReadOnlyList<string> Mentioned, IReadOnlySet<string> Closed) KeysIn(string text)
    {
        var mentioned = Keys.Matches(text).Select(m => $"{m.Groups[1].Value}-{int.Parse(m.Groups[2].Value)}").Distinct().ToList();
        var closed = Closing.Matches(text).Select(m => m.Groups[1].Value.ToUpperInvariant()).Select(k => { var i = k.LastIndexOf('-'); return $"{k[..i]}-{int.Parse(k[(i + 1)..])}"; }).ToHashSet();
        return (mentioned, closed);
    }

    /// <summary>Checks the request really comes from the provider: GitHub signs the body with the secret; Azure DevOps sends it as the basic-auth password.</summary>
    public static bool Verify(GitProvider provider, string secret, string body, string? signatureHeader, string? authorizationHeader)
    {
        if (provider == GitProvider.GitHub)
        {
            if (signatureHeader is null || !signatureHeader.StartsWith("sha256=", StringComparison.Ordinal)) return false;
            var expected = "sha256=" + Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(body))).ToLowerInvariant();
            return CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(signatureHeader.Trim().ToLowerInvariant()));
        }
        if (authorizationHeader is null || !authorizationHeader.StartsWith("Basic ", StringComparison.OrdinalIgnoreCase)) return false;
        string decoded;
        try { decoded = Encoding.UTF8.GetString(Convert.FromBase64String(authorizationHeader[6..].Trim())); } catch (FormatException) { return false; }
        var password = decoded.Contains(':') ? decoded[(decoded.IndexOf(':') + 1)..] : decoded;
        return CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(password), Encoding.UTF8.GetBytes(secret));
    }

    /// <summary>Reads the changes out of a GitHub (push, pull_request) or Azure DevOps (git.push, git.pullrequest.*) event.</summary>
    public static IReadOnlyList<GitChange> Parse(GitProvider provider, string? eventName, JsonNode body)
    {
        var list = new List<GitChange>();
        string? S(JsonNode? n) => n?.GetValueKind() == System.Text.Json.JsonValueKind.String ? n.GetValue<string>() : n?.ToString();
        DateTime When(JsonNode? n) => DateTime.TryParse(S(n), null, System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out var d) ? d : DateTime.UtcNow;
        if (provider == GitProvider.GitHub)
        {
            var repo = S(body["repository"]?["full_name"]);
            if (eventName == "push")
            {
                var onDefault = S(body["ref"]) == $"refs/heads/{S(body["repository"]?["default_branch"])}";
                foreach (var c in body["commits"]?.AsArray() ?? [])
                {
                    var msg = S(c?["message"]) ?? "";
                    list.Add(new GitChange("commit", S(c?["id"]) ?? "", msg.Split('\n')[0], msg, S(c?["url"]) ?? "", repo,
                        S(c?["author"]?["name"]) ?? S(c?["author"]?["username"]), S(c?["author"]?["email"]), null, onDefault, When(c?["timestamp"])));
                }
            }
            else if (eventName == "pull_request" && body["pull_request"] is { } pr)
            {
                var merged = pr["merged"]?.GetValue<bool>() == true;
                var state = merged ? "merged" : S(pr["state"]) ?? "open";
                list.Add(new GitChange("pull_request", S(pr["number"]) ?? "", S(pr["title"]) ?? "", $"{S(pr["title"])}\n{S(pr["body"])}\n{S(pr["head"]?["ref"])}", S(pr["html_url"]) ?? "", repo,
                    S(pr["user"]?["login"]), null, state, merged, When(pr["updated_at"])));
            }
            return list;
        }

        // Azure DevOps service hooks
        var type = S(body["eventType"]) ?? eventName ?? "";
        var resource = body["resource"];
        var repoName = S(resource?["repository"]?["name"]);
        if (type == "git.push")
        {
            var defaultBranch = S(resource?["repository"]?["defaultBranch"]);
            var onDefault = (resource?["refUpdates"]?.AsArray() ?? []).Any(r => S(r?["name"]) == defaultBranch);
            var web = S(resource?["repository"]?["remoteUrl"]);
            foreach (var c in resource?["commits"]?.AsArray() ?? [])
            {
                var msg = S(c?["comment"]) ?? "";
                var id = S(c?["commitId"]) ?? "";
                list.Add(new GitChange("commit", id, msg.Split('\n')[0], msg, web is null ? S(c?["url"]) ?? "" : $"{web}/commit/{id}", repoName,
                    S(c?["author"]?["name"]), S(c?["author"]?["email"]), null, onDefault, When(c?["author"]?["date"])));
            }
        }
        else if (type.StartsWith("git.pullrequest", StringComparison.Ordinal) && resource is not null)
        {
            var status = S(resource["status"]) ?? "active";
            var merged = status == "completed";
            var number = S(resource["pullRequestId"]) ?? "";
            var web = S(resource["repository"]?["webUrl"]);
            list.Add(new GitChange("pull_request", number, S(resource["title"]) ?? "", $"{S(resource["title"])}\n{S(resource["description"])}\n{S(resource["sourceRefName"])}",
                web is null ? S(resource["url"]) ?? "" : $"{web}/pullrequest/{number}", repoName, S(resource["createdBy"]?["displayName"]), S(resource["createdBy"]?["uniqueName"]),
                merged ? "merged" : status == "abandoned" ? "closed" : "open", merged, When(resource["closedDate"] ?? resource["creationDate"])));
        }
        return list;
    }

    /// <summary>Handles one event for the connection with this token (anonymous request). Returns how many task links were made or updated.</summary>
    public static async Task<int> ReceiveAsync(IServiceProvider sp, GitProvider provider, string token, string body, string? eventName, string? signature, string? authorization, CancellationToken ct)
    {
        var db = sp.GetRequiredService<IAppDbContext>();
        var clock = sp.GetRequiredService<AppClock>();
        var log = sp.GetRequiredService<ILogger<GitLinkService>>();
        var conn = await db.GitConnections.IgnoreQueryFilters().FirstOrDefaultAsync(c => c.Token == token && c.Provider == provider, ct) ?? throw new NotFoundException("Unknown connection.");
        if (!Verify(provider, sp.GetRequiredService<ISecretProtector>().Unprotect(conn.SecretProtected), body, signature, authorization))
        {
            conn.LastError = $"{clock.Now:dd MMM HH:mm} UTC: a request with a wrong signature was refused."; await db.SaveChangesAsync(ct);
            throw new UnauthorizedException("The signature does not match.", "BAD_SIGNATURE");
        }
        conn.Received++; conn.LastReceivedAt = clock.Now;
        if (eventName == "ping") { conn.LastError = null; await db.SaveChangesAsync(ct); return 0; }

        var tenant = await db.Tenants.AsNoTracking().FirstOrDefaultAsync(t => t.Id == conn.TenantId && t.Status == TenantStatus.Active, ct);
        if (tenant is null) { await db.SaveChangesAsync(ct); return 0; }
        JsonNode? json;
        try { json = JsonNode.Parse(body); } catch (System.Text.Json.JsonException) { json = null; }
        if (json is null) { conn.LastError = "The request body was not JSON."; await db.SaveChangesAsync(ct); return 0; }

        var changes = Parse(provider, eventName, json).Take(100).ToList();
        var linked = 0;
        var cc = sp.GetRequiredService<CurrentContext>();
        foreach (var change in changes)
        {
            var (mentioned, closed) = KeysIn(change.Message);
            foreach (var key in mentioned.Take(20))
            {
                var dash = key.LastIndexOf('-');
                var prefix = key[..dash]; var number = int.Parse(key[(dash + 1)..]);
                Guid? taskId = null, workTaskId = null; Guid? projectId = null;
                if (prefix is "WT" or "AI")
                {
                    var kind = prefix == "WT" ? WorkTaskKind.Operational : WorkTaskKind.ActionItem;
                    workTaskId = await db.WorkTasks.IgnoreQueryFilters().Where(w => w.TenantId == conn.TenantId && !w.IsDeleted && w.Kind == kind && w.Number == number).Select(w => (Guid?)w.Id).FirstOrDefaultAsync(ct);
                }
                if (workTaskId is null)
                {
                    var hit = await db.Tasks.IgnoreQueryFilters()
                        .Where(t => t.TenantId == conn.TenantId && !t.IsDeleted && t.Number == number && db.Projects.IgnoreQueryFilters().Any(p => p.Id == t.ProjectId && !p.IsDeleted && p.Key == prefix))
                        .Select(t => new { t.Id, t.ProjectId }).FirstOrDefaultAsync(ct);
                    taskId = hit?.Id; projectId = hit?.ProjectId;
                }
                if (taskId is null && workTaskId is null) continue;

                var existing = await db.DevLinks.IgnoreQueryFilters().FirstOrDefaultAsync(l => l.TenantId == conn.TenantId && l.Provider == provider && l.Kind == change.Kind
                    && l.ExternalId == change.ExternalId && l.TaskId == taskId && l.WorkTaskId == workTaskId, ct);
                if (existing is null)
                {
                    db.DevLinks.Add(new DevLink
                    {
                        TenantId = conn.TenantId, TaskId = taskId, WorkTaskId = workTaskId, Provider = provider, Kind = change.Kind, ExternalId = Cut(change.ExternalId, 80)!,
                        Title = Cut(change.Title, 300) ?? "", Url = Cut(change.Url, 500) ?? "", Repository = Cut(change.Repository, 200), Author = Cut(change.Author, 120),
                        State = change.State, OccurredAt = change.OccurredAt, CreatedAt = clock.Now,
                    });
                    var label = change.Kind == "commit" ? $"commit {change.ExternalId[..Math.Min(7, change.ExternalId.Length)]}" : $"pull request #{change.ExternalId}";
                    db.Activities.Add(new Activity
                    {
                        TenantId = conn.TenantId, ProjectId = projectId, Action = workTaskId is null ? "task.dev_linked" : "worktask.dev_linked",
                        EntityType = workTaskId is null ? "Task" : "WorkTask", EntityId = taskId ?? workTaskId, CreatedAt = clock.Now,
                        Summary = Cut($"{key}: linked {label} “{change.Title}”{(change.Author is null ? "" : $" by {change.Author}")} ({(provider == GitProvider.GitHub ? "GitHub" : "Azure DevOps")})", 500)!,
                    });
                }
                else if (existing.State != change.State) { existing.State = change.State; existing.Title = Cut(change.Title, 300) ?? existing.Title; }
                linked++;
                await db.SaveChangesAsync(ct);

                if (conn.CloseOnKeyword && change.Completes && closed.Contains(key))
                {
                    try { await CompleteAsync(sp, db, cc, conn, tenant.Type, change.AuthorEmail, taskId, workTaskId, ct); }
                    catch (AppException ex) { conn.LastError = Cut($"{clock.Now:dd MMM HH:mm} UTC: {key} could not be completed: {ex.Message}", 300); log.LogInformation("Git close of {Key} refused: {Reason}", key, ex.Message); }
                }
            }
        }
        await db.SaveChangesAsync(ct);
        return linked;
    }

    private static string? Cut(string? s, int max) => s is null ? null : s.Length <= max ? s : s[..(max - 1)] + "…";

    /// <summary>Completes a task as the commit's author when they are a member (their own rights apply), otherwise as whoever connected the repository.</summary>
    private static async Task CompleteAsync(IServiceProvider sp, IAppDbContext db, CurrentContext cc, GitConnection conn, WorkspaceType type, string? authorEmail,
        Guid? taskId, Guid? workTaskId, CancellationToken ct)
    {
        var normalized = authorEmail is null ? null : Text.NormalizeEmail(authorEmail);
        var member = normalized is null ? null : await db.TenantMembers.IgnoreQueryFilters().AsNoTracking()
            .FirstOrDefaultAsync(m => m.TenantId == conn.TenantId && m.User!.NormalizedEmail == normalized && m.User.IsActive, ct);
        member ??= await db.TenantMembers.IgnoreQueryFilters().AsNoTracking().FirstOrDefaultAsync(m => m.TenantId == conn.TenantId && m.UserId == conn.CreatedBy, ct);
        if (member is null) return;
        cc.UserId = member.UserId; cc.TenantId = conn.TenantId; cc.Role = member.Role; cc.WorkspaceType = type; cc.IsPlatformAdmin = false;

        if (workTaskId is { } wid)
        {
            var kind = await db.WorkTasks.Where(w => w.Id == wid).Select(w => new { w.Kind, w.Status }).FirstAsync(ct);
            if (kind.Status is WorkTaskStatus.Completed or WorkTaskStatus.Cancelled) return;
            if (kind.Kind == WorkTaskKind.Operational) await sp.GetRequiredService<WorkTaskService>().SetStatusAsync(wid, new SetWorkTaskStatusRequest(WorkTaskStatus.Completed), ct);
            return;
        }
        if (taskId is { } tid)
        {
            var task = await db.Tasks.AsNoTracking().Where(t => t.Id == tid).Select(t => new { t.ProjectId, t.CompletedAt }).FirstAsync(ct);
            if (task.CompletedAt is not null) return;
            var done = await db.WorkflowStatuses.Where(s => s.ProjectId == task.ProjectId && s.Category == StatusCategory.Done).OrderBy(s => s.Order).Select(s => (Guid?)s.Id).FirstOrDefaultAsync(ct);
            if (done is { } statusId) await sp.GetRequiredService<TaskService>().MoveAsync(tid, new MoveTaskRequest(statusId, null), ct);
        }
    }
}
