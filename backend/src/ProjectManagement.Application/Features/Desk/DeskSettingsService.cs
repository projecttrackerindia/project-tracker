using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Desk;

public class DeskOptions
{
    public const string Section = "Desk";
    /// <summary>How often the Desk worker takes inbound messages off the queue and checks unaccepted tickets.</summary>
    public int WorkerIntervalSeconds { get; set; } = 5;
}

/// <summary>Desk › Integrations. Keys are write-only: the API says whether one is set, never what it is.</summary>
public record DeskSettingsDto(bool IntakeEnabled, bool AutoAcknowledge, bool AutoCreateTicket, string AckMessage, bool RoutingEnabled, int ConfidenceThreshold, int AcceptMinutes,
    int MaxReassignments, UserRefDto? Supervisor, bool NotifyOnWhatsApp, bool VoiceEnabled, bool HasSarvamKey, bool SarvamFromServer, IReadOnlyList<string> VoiceLanguages,
    string ConsentPrompt, bool RecordCalls, int RetentionDays, string TelephonyProvider, bool HasTelephonyKey, bool TelephonyReady, int WhatsAppNumbers, bool CanManage);

/// <summary>Leave a key null to keep it; send "" to remove it.</summary>
public record SaveDeskSettingsRequest(bool IntakeEnabled, bool AutoAcknowledge, bool AutoCreateTicket, string? AckMessage, bool RoutingEnabled, int ConfidenceThreshold,
    int AcceptMinutes, int MaxReassignments, Guid? SupervisorId, bool NotifyOnWhatsApp, bool VoiceEnabled, string? SarvamApiKey, IReadOnlyList<string>? VoiceLanguages,
    string? ConsentPrompt, bool RecordCalls, int RetentionDays, string? TelephonyProvider, string? TelephonyKey);

public record DeskEngineerDto(Guid UserId, string Name, string Status, DateTime? StatusChangedAt, IReadOnlyList<string> Skills, string Department, int MaxActive,
    int? ShiftStartMinutes, int? ShiftEndMinutes, bool OnCall, int Active, bool Configured);
public record SaveDeskEngineerRequest(string Status, IReadOnlyList<string>? Skills, string? Department, int MaxActive, int? ShiftStartMinutes, int? ShiftEndMinutes);
public record DeskStatusRequest(string Status);
public record DeskQueueItemDto(Guid Id, string Provider, string MessageType, string Status, int Attempts, DateTime CreatedAt, DateTime NextAttemptAt, string? LastError, Guid? WorkTaskId);
public record DeskQueueDto(int Pending, int Done, int Dead, IReadOnlyList<DeskQueueItemDto> Recent);

/// <summary>The Desk's settings, its engineers (availability, skills, capacity, shift) and the inbound queue's health and dead letters.</summary>
public class DeskSettingsService(IAppDbContext db, ICurrentContext ctx, AppClock clock, PermissionService permissions, ISecretProtector secrets, Recorder recorder,
    Microsoft.Extensions.Options.IOptions<ProjectManagement.Application.Features.Voice.VoiceOptions> voice)
{
    public const string DefaultConsent = "Hello, this is an automated assistant. This call may be recorded to help us resolve your request. Do you agree?";
    public const string DefaultAck = "Thanks for writing to us. We have received your request{ticket} and will update you here.";
    private static readonly HashSet<string> Telephony = ["none", "exotel", "plivo", "twilio"];

    /// <summary>The workspace's settings row, or the defaults (everything off) when it has none yet. Not tracked.</summary>
    public async Task<DeskSettings> CurrentAsync(CancellationToken ct) =>
        await db.DeskSettings.AsNoTracking().FirstOrDefaultAsync(ct) ?? new DeskSettings { TenantId = ctx.TenantId ?? Guid.Empty };

    public async Task<DeskSettingsDto> GetAsync(CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.WorkEdit, ct);
        return await DtoAsync(await CurrentAsync(ct), ct);
    }

    private async Task<DeskSettingsDto> DtoAsync(DeskSettings s, CancellationToken ct)
    {
        var sup = s.SupervisorId is { } sid ? await db.Users.AsNoTracking().Where(u => u.Id == sid).Select(u => new UserRefDto(u.Id, u.DisplayName)).FirstOrDefaultAsync(ct) : null;
        var numbers = await db.SupportChannels.AsNoTracking().CountAsync(c => c.Enabled, ct);
        return new(s.IntakeEnabled, s.AutoAcknowledge, s.AutoCreateTicket, s.AckMessage.Length > 0 ? s.AckMessage : DefaultAck, s.RoutingEnabled, s.ConfidenceThreshold, s.AcceptMinutes,
            s.MaxReassignments, sup, s.NotifyOnWhatsApp, s.VoiceEnabled, !string.IsNullOrEmpty(s.SarvamApiKeyProtected), !string.IsNullOrWhiteSpace(voice.Value.SarvamApiKey),
            Languages(s.VoiceLanguages), s.ConsentPrompt.Length > 0 ? s.ConsentPrompt : DefaultConsent, s.RecordCalls, s.RetentionDays, s.TelephonyProvider,
            !string.IsNullOrEmpty(s.TelephonyKeyProtected), false, numbers, await permissions.HasAsync(Permissions.WorkTypesManage, ct));
    }

    public static IReadOnlyList<string> Languages(string? csv) =>
        (csv ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Where(l => ProjectManagement.Application.Features.Voice.VoiceLanguages.Names.ContainsKey(l)).Distinct().ToList();

    public async Task<DeskSettingsDto> SaveAsync(SaveDeskSettingsRequest req, CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.WorkTypesManage, ct);
        var tid = ctx.RequireTenantId();
        if (req.ConfidenceThreshold is < 0 or > 100) throw new ValidationException("confidenceThreshold", "The confidence threshold is 0 to 100.");
        if (req.AcceptMinutes is < 1 or > 1440) throw new ValidationException("acceptMinutes", "The acceptance window is 1 minute to 24 hours.");
        if (req.MaxReassignments is < 0 or > 10) throw new ValidationException("maxReassignments", "Move a ticket on 0 to 10 times before the supervisor is asked.");
        if (req.RetentionDays is < 1 or > 3650) throw new ValidationException("retentionDays", "Keep recordings 1 day to 10 years.");
        var ack = (req.AckMessage ?? "").Trim();
        if (ack.Length > 500) throw new ValidationException("ackMessage", "The acknowledgement is up to 500 characters.");
        var consent = (req.ConsentPrompt ?? "").Trim();
        if (consent.Length > 600) throw new ValidationException("consentPrompt", "The consent prompt is up to 600 characters.");
        if (consent.Length > 0 && !(consent.Contains("automated", StringComparison.OrdinalIgnoreCase) && consent.Contains("record", StringComparison.OrdinalIgnoreCase)))
            throw new ValidationException("consentPrompt", "The prompt must say the assistant is automated and ask before recording.");
        var langs = (req.VoiceLanguages ?? ["en"]).Select(l => l.Trim()).Where(l => l.Length > 0).Distinct().ToList();
        if (langs.Count == 0 || langs.Any(l => !ProjectManagement.Application.Features.Voice.VoiceLanguages.Names.ContainsKey(l)))
            throw new ValidationException("voiceLanguages", "Choose one or more supported languages.");
        var telephony = (req.TelephonyProvider ?? "none").Trim().ToLowerInvariant();
        if (!Telephony.Contains(telephony)) throw new ValidationException("telephonyProvider", "Choose none, Exotel, Plivo or Twilio.");
        if (req.SupervisorId is { } sup && !await db.TenantMembers.AnyAsync(m => m.TenantId == tid && m.UserId == sup, ct))
            throw new ValidationException("supervisorId", "Choose someone in this workspace.");
        if (req.SarvamApiKey is { Length: > 0 } key && (key.Trim().Length is < 16 or > 200 || key.Trim().Any(char.IsWhiteSpace)))
            throw new ValidationException("sarvamApiKey", "That does not look like a Sarvam API subscription key.");
        if (req.TelephonyKey is { Length: > 0 } tk && tk.Trim().Length > 500) throw new ValidationException("telephonyKey", "The telephony key is too long.");

        var row = await db.DeskSettings.FirstOrDefaultAsync(ct);
        if (row is null) { row = new DeskSettings { TenantId = tid, CreatedAt = clock.Now, CreatedBy = ctx.UserId }; db.DeskSettings.Add(row); }
        else { row.UpdatedAt = clock.Now; row.UpdatedBy = ctx.UserId; }
        var before = new { row.IntakeEnabled, row.RoutingEnabled, row.VoiceEnabled, row.ConfidenceThreshold, row.RecordCalls, row.RetentionDays, row.TelephonyProvider };
        row.IntakeEnabled = req.IntakeEnabled; row.AutoAcknowledge = req.AutoAcknowledge; row.AutoCreateTicket = req.AutoCreateTicket;
        row.AckMessage = ack == DefaultAck ? "" : ack;
        row.RoutingEnabled = req.RoutingEnabled; row.ConfidenceThreshold = req.ConfidenceThreshold; row.AcceptMinutes = req.AcceptMinutes; row.MaxReassignments = req.MaxReassignments;
        row.SupervisorId = req.SupervisorId; row.NotifyOnWhatsApp = req.NotifyOnWhatsApp; row.VoiceEnabled = req.VoiceEnabled;
        row.VoiceLanguages = string.Join(",", langs); row.ConsentPrompt = consent == DefaultConsent ? "" : consent; row.RecordCalls = req.RecordCalls; row.RetentionDays = req.RetentionDays;
        row.TelephonyProvider = telephony;
        if (req.SarvamApiKey is not null) row.SarvamApiKeyProtected = req.SarvamApiKey.Trim().Length == 0 ? null : secrets.Protect(req.SarvamApiKey.Trim());
        if (req.TelephonyKey is not null) row.TelephonyKeyProtected = req.TelephonyKey.Trim().Length == 0 ? null : secrets.Protect(req.TelephonyKey.Trim());
        // The audit says which keys changed, never their values.
        recorder.Audit("desk.settings_saved", "DeskSettings", row.Id, before, new { row.IntakeEnabled, row.RoutingEnabled, row.VoiceEnabled, row.ConfidenceThreshold, row.RecordCalls,
            row.RetentionDays, row.TelephonyProvider, sarvamKeyChanged = req.SarvamApiKey is not null, telephonyKeyChanged = req.TelephonyKey is not null });
        await db.SaveChangesAsync(ct);
        return await DtoAsync(row, ct);
    }

    // ------------------------------------------------------------------ engineers

    public async Task<IReadOnlyList<DeskEngineerDto>> EngineersAsync(CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.WorkEdit, ct);
        var tid = ctx.RequireTenantId();
        var members = await (from m in db.TenantMembers.AsNoTracking() join u in db.Users.AsNoTracking() on m.UserId equals u.Id
                             where m.TenantId == tid && u.IsActive select new { u.Id, u.DisplayName }).Take(500).ToListAsync(ct);
        var rows = await db.DeskEngineers.AsNoTracking().ToDictionaryAsync(e => e.UserId, ct);
        var load = await DeskRoutingService.OpenLoadAsync(db, ct);
        return members.Select(m =>
        {
            var e = rows.GetValueOrDefault(m.Id);
            return new DeskEngineerDto(m.Id, m.DisplayName, e?.Status ?? "offline", e?.StatusChangedAt, DeskRules.SplitSkills(e?.Skills), e?.Department ?? "", e?.MaxActive ?? 8,
                e?.ShiftStartMinutes, e?.ShiftEndMinutes, e?.OnCall ?? false, load.GetValueOrDefault(m.Id), e is not null);
        }).OrderByDescending(e => e.Configured).ThenBy(e => e.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>A supervisor sets anyone's profile; an engineer may set their own.</summary>
    public async Task<DeskEngineerDto> SaveEngineerAsync(Guid userId, SaveDeskEngineerRequest req, CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.WorkEdit, ct);
        if (userId != ctx.UserId && !await permissions.HasAsync(Permissions.WorkTypesManage, ct)) throw new ForbiddenException("Only a supervisor can change someone else's Desk profile.");
        var tid = ctx.RequireTenantId();
        if (!await db.TenantMembers.AnyAsync(m => m.TenantId == tid && m.UserId == userId, ct)) throw new NotFoundException("Person not found in this workspace.");
        if (!DeskRules.Statuses.Contains(req.Status)) throw new ValidationException("status", "Use available, busy, away or offline.");
        if (req.MaxActive is < 1 or > 100) throw new ValidationException("maxActive", "Up to 1-100 open tickets at a time.");
        if (req.ShiftStartMinutes is < 0 or >= 1440 || req.ShiftEndMinutes is < 0 or > 1440 || (req.ShiftStartMinutes is null) != (req.ShiftEndMinutes is null))
            throw new ValidationException("shiftStartMinutes", "Give both shift times, or neither.");
        var skills = string.Join(",", DeskRules.SplitSkills(string.Join(",", req.Skills ?? [])));
        if (skills.Length > 1000) throw new ValidationException("skills", "Too many skills.");
        var dept = (req.Department ?? "").Trim();
        if (dept.Length > 80) throw new ValidationException("department", "The department name is up to 80 characters.");
        var row = await RowAsync(tid, userId, ct);
        if (row.Status != req.Status) { row.Status = req.Status; row.StatusChangedAt = clock.Now; }
        row.Skills = skills; row.Department = dept; row.MaxActive = req.MaxActive; row.ShiftStartMinutes = req.ShiftStartMinutes; row.ShiftEndMinutes = req.ShiftEndMinutes;
        row.UpdatedAt = clock.Now; row.UpdatedBy = ctx.UserId;
        recorder.Audit("desk.engineer_saved", "DeskEngineer", row.Id, null, new { userId, row.Status, row.Department, row.MaxActive });
        await db.SaveChangesAsync(ct);
        return (await EngineersAsync(ct)).First(e => e.UserId == userId);
    }

    /// <summary>The signed-in engineer's own availability (the Desk's status switch).</summary>
    public async Task<DeskEngineerDto> SetMyStatusAsync(DeskStatusRequest req, CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.WorkEdit, ct);
        if (!DeskRules.Statuses.Contains(req.Status)) throw new ValidationException("status", "Use available, busy, away or offline.");
        var me = ctx.RequireUserId();
        var row = await RowAsync(ctx.RequireTenantId(), me, ct);
        if (row.Status != req.Status) { row.Status = req.Status; row.StatusChangedAt = clock.Now; row.UpdatedAt = clock.Now; row.UpdatedBy = me; }
        await db.SaveChangesAsync(ct);
        return (await EngineersAsync(ct)).First(e => e.UserId == me);
    }

    private async Task<DeskEngineer> RowAsync(Guid tid, Guid userId, CancellationToken ct)
    {
        var row = await db.DeskEngineers.FirstOrDefaultAsync(e => e.UserId == userId, ct);
        if (row is not null) return row;
        row = new DeskEngineer { TenantId = tid, UserId = userId, CreatedAt = clock.Now, CreatedBy = ctx.UserId };
        db.DeskEngineers.Add(row);
        return row;
    }

    // ------------------------------------------------------------------ inbound queue

    public async Task<DeskQueueDto> QueueAsync(CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.WorkTypesManage, ct);
        var counts = await db.DeskInboundEvents.AsNoTracking().GroupBy(e => e.Status).Select(g => new { g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.N, ct);
        var recent = await db.DeskInboundEvents.AsNoTracking().OrderByDescending(e => e.CreatedAt).Take(50)
            .Select(e => new DeskQueueItemDto(e.Id, e.Provider, e.MessageType, e.Status, e.Attempts, e.CreatedAt, e.NextAttemptAt, e.LastError, e.WorkTaskId)).ToListAsync(ct);
        return new(counts.GetValueOrDefault("pending") + counts.GetValueOrDefault("processing"), counts.GetValueOrDefault("done"), counts.GetValueOrDefault("dead"), recent);
    }

    /// <summary>Puts a dead letter back on the queue for one more round of tries.</summary>
    public async Task<DeskQueueDto> RetryAsync(Guid id, CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.WorkTypesManage, ct);
        var e = await db.DeskInboundEvents.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Queued message not found.");
        if (e.Status != "dead") throw new ConflictException("Only failed messages can be retried.");
        e.Status = "pending"; e.Attempts = 0; e.NextAttemptAt = clock.Now; e.LeaseUntil = null; e.UpdatedAt = clock.Now; e.UpdatedBy = ctx.UserId;
        recorder.Audit("desk.queue_retry", "DeskInboundEvent", e.Id);
        await db.SaveChangesAsync(ct);
        return await QueueAsync(ct);
    }
}
