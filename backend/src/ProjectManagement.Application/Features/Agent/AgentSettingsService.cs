using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Agent;

/// <summary>
/// Switching the project agent on for a project (anyone who may edit the project), the workspace's meeting-bot key (Owners and Admins), and a
/// person's own opt-in to let the agent look in their inbox.
/// </summary>
public class AgentSettingsService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, ProjectAccess access, ISecretProtector secrets,
    IAiClient ai, EntitlementService entitlements, IOptions<InboundEmailOptions> inbound, IOptions<GoogleCalendarOptions> google,
    IOptions<MicrosoftProductivityOptions> microsoft)
{
    public static readonly string[] Regions = ["us-east-1", "us-west-2", "eu-central-1", "ap-northeast-1"];
    private bool IsAdmin => ctx.Role is TenantRole.Owner or TenantRole.Admin;

    internal static string NewToken(int bytes) => Convert.ToHexString(RandomNumberGenerator.GetBytes(bytes)).ToLowerInvariant();

    public string? MailboxAddress(string token) =>
        string.IsNullOrWhiteSpace(inbound.Value.Domain) ? null : $"agent+{token}@{inbound.Value.Domain!.Trim().TrimStart('@')}";

    public async Task<bool> CanManageAsync(Project project, CancellationToken ct)
    {
        try { await access.RequireProjectEditAsync(project, ct); return ctx.Role != TenantRole.Guest; }
        catch (ForbiddenException) { return false; }
    }

    public async Task<bool> AiAvailableAsync(CancellationToken ct)
    {
        if (!ai.Configured) return false;
        if (await entitlements.GetValueAsync(FeatureKeys.AiAssistant, ct) <= 0) return false;
        var tid = ctx.RequireTenantId();
        return !await db.Tenants.Where(t => t.Id == tid).Select(t => t.AiDisabled).FirstOrDefaultAsync(ct);
    }

    private static AgentRunDto Run(AgentRun r) => new(r.Id, r.Trigger, r.Status, r.SignalCount, r.FindingCount, r.Credits, r.Summary, r.Error, r.StartedAt, r.FinishedAt);

    // ---------------------------------------------------------------- one project

    public async Task<ProjectAgentDto> GetAsync(Guid projectId, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        var s = await db.ProjectAgentSettings.AsNoTracking().FirstOrDefaultAsync(x => x.ProjectId == projectId, ct);
        var canManage = await CanManageAsync(project, ct);
        var pending = await db.AgentFindings.CountAsync(f => f.ProjectId == projectId && f.Status == AgentFindingStatus.Proposed, ct);
        var runs = await db.AgentRuns.AsNoTracking().Where(r => r.ProjectId == projectId).OrderByDescending(r => r.StartedAt).Take(8).ToListAsync(ct);
        var botReady = await db.AgentWorkspaceSettings.AsNoTracking().AnyAsync(w => w.RecallApiKeyProtected != null, ct);
        var uid = ctx.RequireUserId();
        var transcripts = await db.GoogleConnections.AsNoTracking().Where(c => c.UserId == uid).Select(c => c.Scopes).FirstOrDefaultAsync(ct) is { } scopes
            && scopes.Split(' ', StringSplitOptions.RemoveEmptyEntries).Contains(GoogleCalendarAuthService.TranscriptScope);
        string? acting = null;
        if (s is not null) acting = await db.Users.AsNoTracking().Where(u => u.Id == s.ActingUserId).Select(u => u.DisplayName).FirstOrDefaultAsync(ct);
        var month = clock.Now.ToString("yyyy-MM");
        return new ProjectAgentDto(projectId, s?.Enabled ?? false, s?.ReadMailbox ?? true, s?.ReadChat ?? true, s?.ReadMeetings ?? true, s?.LiveBot ?? false,
            s?.DailyUpdates ?? true, s is null || !canManage ? null : MailboxAddress(s.MailboxToken), botReady, await AiAvailableAsync(ct), pending, s?.LastRunAt,
            s?.LastError, s?.RunMonth == month ? s.RunsThisMonth : 0, s?.MonthlyRunLimit ?? 300, canManage, acting,
            // Summaries describe what was read (mail, meetings, members' inboxes): only for the people who decide on it.
            runs.Select(Run).Select(r => canManage ? r : r with { Summary = null }).ToList(), transcripts);
    }

    public async Task<ProjectAgentDto> SaveAsync(Guid projectId, SaveProjectAgentRequest req, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        if (!await CanManageAsync(project, ct)) throw new ForbiddenException("Only people who may edit this project can set up its agent.", "PERMISSION_DENIED");
        ProjectAccess.EnsureNotArchived(project, "set up its agent");
        if (req.Enabled && !await AiAvailableAsync(ct))
            throw new ConflictException("The project agent needs the AI assistant, which is not available in this workspace.", "AI_UNAVAILABLE");
        var tid = ctx.RequireTenantId(); var uid = ctx.RequireUserId();
        var s = await db.ProjectAgentSettings.FirstOrDefaultAsync(x => x.ProjectId == projectId, ct);
        if (s is null)
        {
            s = new ProjectAgentSettings { TenantId = tid, ProjectId = projectId, MailboxToken = NewToken(12), ActingUserId = uid, CreatedAt = clock.Now, CreatedBy = uid,
                ChatReadUntil = clock.Now };
            db.ProjectAgentSettings.Add(s);
        }
        // Whoever switches it on is the person it acts as in the background (their rights; the workspace's AI credits).
        if (req.Enabled && !s.Enabled) { s.ActingUserId = uid; s.ChatReadUntil = clock.Now; s.LastError = null; }   // chat from while it was off is not read
        s.Enabled = req.Enabled;
        s.ReadMailbox = req.ReadMailbox ?? s.ReadMailbox; s.ReadChat = req.ReadChat ?? s.ReadChat; s.ReadMeetings = req.ReadMeetings ?? s.ReadMeetings;
        s.LiveBot = req.LiveBot ?? s.LiveBot; s.DailyUpdates = req.DailyUpdates ?? s.DailyUpdates;
        s.UpdatedAt = clock.Now; s.UpdatedBy = uid;
        recorder.Audit("agent.settings_saved", "Project", projectId, null, new { s.Enabled, s.ReadMailbox, s.ReadChat, s.ReadMeetings, s.LiveBot, s.DailyUpdates });
        recorder.Activity(req.Enabled ? "agent.enabled" : "agent.disabled", "Project", projectId, req.Enabled ? $"Project agent switched on for \"{project.Name}\"" : $"Project agent switched off for \"{project.Name}\"", projectId);
        await db.SaveChangesAsync(ct);
        return await GetAsync(projectId, ct);
    }

    /// <summary>A new mailbox address for the project: mail to the old one is refused from now on.</summary>
    public async Task<ProjectAgentDto> ResetMailboxAsync(Guid projectId, CancellationToken ct = default)
    {
        var project = await access.GetProjectAsync(projectId, ct);
        if (!await CanManageAsync(project, ct)) throw new ForbiddenException("Only people who may edit this project can set up its agent.", "PERMISSION_DENIED");
        var s = await db.ProjectAgentSettings.FirstOrDefaultAsync(x => x.ProjectId == projectId, ct) ?? throw new NotFoundException("Switch the agent on first.");
        s.MailboxToken = NewToken(12); s.UpdatedAt = clock.Now;
        recorder.Audit("agent.mailbox_reset", "Project", projectId);
        await db.SaveChangesAsync(ct);
        return await GetAsync(projectId, ct);
    }

    // ---------------------------------------------------------------- the workspace's meeting bot

    public async Task<AgentWorkspaceDto> GetWorkspaceAsync(CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var w = await db.AgentWorkspaceSettings.AsNoTracking().FirstOrDefaultAsync(ct);
        var enabled = await db.ProjectAgentSettings.CountAsync(s => s.Enabled, ct);
        return new AgentWorkspaceDto(w?.RecallApiKeyProtected is not null, w?.RecallRegion ?? "us-west-2", w?.BotName ?? "Project Tracker Agent", w?.InCallReminders ?? true, IsAdmin, enabled);
    }

    public async Task<AgentWorkspaceDto> SaveWorkspaceAsync(SaveAgentWorkspaceRequest req, CancellationToken ct = default)
    {
        if (!IsAdmin) throw new ForbiddenException("Only owners and admins can set up the meeting bot.", "PERMISSION_DENIED");
        var tid = ctx.RequireTenantId();
        if (req.RecallRegion is { } region && !Regions.Contains(region)) throw new ValidationException("recallRegion", "Choose one of the meeting-bot regions.");
        var key = req.RecallApiKey?.Trim();
        if (key is { Length: > 0 } && (key.Length < 20 || key.Length > 200 || key.Any(char.IsWhiteSpace)))
            throw new ValidationException("recallApiKey", "That does not look like a Recall.ai API key.");
        var name = req.BotName?.Trim();
        if (name is not null && (name.Length is < 2 or > 60)) throw new ValidationException("botName", "Give the bot a name of 2 to 60 characters.");
        var w = await db.AgentWorkspaceSettings.FirstOrDefaultAsync(ct);
        if (w is null) { w = new AgentWorkspaceSettings { TenantId = tid, CreatedAt = clock.Now, CreatedBy = ctx.UserId }; db.AgentWorkspaceSettings.Add(w); }
        if (req.ClearRecallKey == true) w.RecallApiKeyProtected = null;
        else if (key is { Length: > 0 }) w.RecallApiKeyProtected = secrets.Protect(key);
        w.RecallRegion = req.RecallRegion ?? w.RecallRegion;
        w.BotName = name ?? w.BotName;
        w.InCallReminders = req.InCallReminders ?? w.InCallReminders;
        w.UpdatedAt = clock.Now; w.UpdatedBy = ctx.UserId;
        recorder.Audit("agent.workspace_saved", "AgentWorkspaceSettings", w.Id, null, new { keySet = w.RecallApiKeyProtected is not null, w.RecallRegion, w.BotName, w.InCallReminders });
        await db.SaveChangesAsync(ct);
        return await GetWorkspaceAsync(ct);
    }

    // ---------------------------------------------------------------- a person's own inbox

    private async Task<(bool Google, bool Microsoft)> InboxesAsync(Guid uid, CancellationToken ct)
    {
        var g = google.Value.InboxEnabled && google.Value.Configured
            && await db.GoogleConnections.AsNoTracking().Where(c => c.UserId == uid).Select(c => c.Scopes).FirstOrDefaultAsync(ct) is { } gs
            && gs.Split(' ', StringSplitOptions.RemoveEmptyEntries).Contains(GoogleCalendarAuthService.InboxScope);
        var m = microsoft.Value.Enabled && microsoft.Value.InboxEnabled
            && await db.MicrosoftConnections.AsNoTracking().Where(c => c.UserId == uid).Select(c => c.Scopes).FirstOrDefaultAsync(ct) is { } ms
            && ms.Split(' ', StringSplitOptions.RemoveEmptyEntries).Any(s => s.Split('/').Last().Equals("Mail.Read", StringComparison.OrdinalIgnoreCase));
        return (g, m);
    }

    public async Task<AgentInboxOptInDto> GetInboxAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId(); ctx.RequireTenantId();
        var (g, m) = await InboxesAsync(uid, ct);
        var o = await db.AgentInboxOptIns.AsNoTracking().FirstOrDefaultAsync(x => x.UserId == uid, ct);
        return new AgentInboxOptInDto(g, m, o?.Provider, o?.Enabled ?? false, o?.ScannedUntil, o?.Found ?? 0, o?.LastError);
    }

    public async Task<AgentInboxOptInDto> SaveInboxAsync(SaveAgentInboxOptInRequest req, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        if (ctx.Role == TenantRole.Guest) throw new ForbiddenException("Guests cannot share their inbox with the project agent.", "PERMISSION_DENIED");
        var o = await db.AgentInboxOptIns.FirstOrDefaultAsync(x => x.UserId == uid, ct);
        if (req.Enabled)
        {
            var (g, m) = await InboxesAsync(uid, ct);
            if (req.Provider is not ("google" or "microsoft")) throw new ValidationException("provider", "Choose Gmail or Outlook.");
            if (req.Provider == "google" && !g || req.Provider == "microsoft" && !m)
                throw new ConflictException("Connect that mailbox with inbox access first (Account › Connected accounts).", "INBOX_NOT_CONNECTED");
            if (o is null) { o = new AgentInboxOptIn { TenantId = tid, UserId = uid, CreatedAt = clock.Now, CreatedBy = uid }; db.AgentInboxOptIns.Add(o); }
            if (!o.Enabled || o.Provider != req.Provider) { o.OptedInAt = clock.Now; o.ScannedUntil = clock.Now.AddDays(-2); o.LastError = null; }
            o.Provider = req.Provider!; o.Enabled = true;
        }
        else if (o is not null) o.Enabled = false;
        if (o is not null) { o.UpdatedAt = clock.Now; recorder.Audit(req.Enabled ? "agent.inbox_opt_in" : "agent.inbox_opt_out", "AgentInboxOptIn", o.Id, null, new { o.Provider }); }
        await db.SaveChangesAsync(ct);
        return await GetInboxAsync(ct);
    }
}
