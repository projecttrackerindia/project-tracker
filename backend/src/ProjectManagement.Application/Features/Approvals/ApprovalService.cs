using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Organization;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Approvals;

public record ApprovalLinkDto(string Kind, string Label, string? Id = null, string? Href = null);
public record ApprovalChainStepDto(int Order, string Role, UserRefDto Approver, string Status, DateTime? DecidedAt, string? Comment);
public record ApprovalEventDto(Guid Id, UserRefDto? User, string Action, int? Step, string? Comment, DateTime At);
/// <param name="NeedsMe">The current step is the caller's.</param>
public record ApprovalRequestDto(Guid Id, string Type, string Title, string? Summary, IReadOnlyDictionary<string, string> Payload, string Risk, string? Impact,
    IReadOnlyList<ApprovalLinkDto> Links, UserRefDto Requester, string Status, int CurrentStep, IReadOnlyList<ApprovalChainStepDto> Steps, bool NeedsMe,
    bool Mine, DateTime CreatedAt, DateTime? ExpiresAt, DateTime? DecidedAt, string? Outcome, IReadOnlyList<ApprovalEventDto>? Events = null);
public record ApprovalCountsDto(int NeedsMe, int Mine, int All, int History);
public record ApprovalWeekDto(int Approved, int Rejected, int Expired, int? MedianMinutes);
/// <summary>Approvals that live elsewhere in the app (release sign-offs, timesheets to review), linked rather than copied.</summary>
public record ApprovalElsewhereDto(string Kind, string Label, int Count, string Href);
public record ApprovalListDto(IReadOnlyList<ApprovalRequestDto> Items, ApprovalCountsDto Counts, ApprovalWeekDto Week, IReadOnlyDictionary<string, int> ByType,
    int ExpiringToday, IReadOnlyList<ApprovalElsewhereDto> Elsewhere);
public record ChainStepInput(string Role, Guid? UserId = null);
public record ChainPreviewDto(string Type, IReadOnlyList<ApprovalChainStepDto> Steps, string Rule, bool Custom);
public record CreateApprovalRequest(string Type, string Title, string? Summary, IReadOnlyDictionary<string, string>? Payload, string? Risk, string? Impact,
    IReadOnlyList<ApprovalLinkDto>? Links, IReadOnlyList<ChainStepInput>? Chain, int? ExpiresInHours);
/// <param name="Action">approve, reject, comment, withdraw or remind.</param>
public record DecideApprovalRequest(string Action, string? Comment);
public record ApprovalPolicyDto(string Type, IReadOnlyList<ChainStepInput> Steps, int? ExpiryHours, bool Custom);
public record SaveApprovalPolicyRequest(IReadOnlyList<ChainStepInput> Steps, int? ExpiryHours);

/// <summary>
/// Approvals: requests for a decision (deploys, config changes, leave, attendance corrections, access, expenses ...) that walk a chain of
/// approvers one step at a time. Each workspace keeps a default chain per type (<see cref="ApprovalPolicy"/>, Settings › Approvals); roles in
/// it ("Lead", "Owner") become people when a request is made. Approvers are told in the bell and by e-mail (the Approval notification kind);
/// the notices link to /approvals, which is the Approvals tab's badge. A request is seen by its requester, its approvers, and the workspace's
/// owners and admins. Release sign-offs and timesheet reviews stay where they are and are linked from the list (<see cref="ApprovalElsewhereDto"/>).
/// </summary>
public class ApprovalService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, NotificationService notifications,
    PlannedLeaveService leave)
{
    public const int MaxSteps = 6, MaxLinks = 12, MaxPayload = 30, ListLimit = 200;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>The built-in chains, used until a workspace saves its own.</summary>
    public static IReadOnlyList<ChainStepInput> DefaultChain(string type) => type switch
    {
        ApprovalTypes.Deployment => [new("Lead"), new("Ops"), new("Owner")],
        ApprovalTypes.ConfigChange => [new("Lead"), new("Owner")],
        ApprovalTypes.ChangeRequest => [new("Lead"), new("Owner")],
        ApprovalTypes.Incident => [new("Lead")],
        ApprovalTypes.AttendanceCorrection => [new("Lead")],
        ApprovalTypes.Leave => [new("Lead"), new("People ops")],
        ApprovalTypes.Access => [new("Lead"), new("Admin")],
        ApprovalTypes.Expense => [new("Lead"), new("Finance")],
        _ => [new("Owner")],
    };

    public static string TypeLabel(string type) => type switch
    {
        ApprovalTypes.ConfigChange => "Configuration change", ApprovalTypes.ChangeRequest => "Change request",
        ApprovalTypes.AttendanceCorrection => "Attendance correction", ApprovalTypes.Access => "Access request", _ => type,
    };

    private static string NormalizeType(string? type)
    {
        var t = ApprovalTypes.All.FirstOrDefault(x => string.Equals(x, type?.Trim().Replace(" ", ""), StringComparison.OrdinalIgnoreCase));
        return t ?? throw new ValidationException("type", "Choose a request type.");
    }

    private bool Broad => ctx.Role is TenantRole.Owner or TenantRole.Admin;

    // ------------------------------------------------------------------ list, detail

    /// <param name="view">needs (waiting on me), mine (I asked), all (everything I can see) or history (decided).</param>
    public async Task<ApprovalListDto> ListAsync(string? view, string? type, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        await ExpireDueAsync(ct);
        var t = string.IsNullOrWhiteSpace(type) || type == "all" ? null : NormalizeType(type);
        var visible = Visible();
        var all = await visible.OrderByDescending(r => r.CreatedAt).Take(ListLimit).ToListAsync(ct);
        var ids = all.Select(r => r.Id).ToList();
        var steps = await db.ApprovalRequestSteps.AsNoTracking().Where(s => ids.Contains(s.RequestId)).ToListAsync(ct);
        var byReq = steps.GroupBy(s => s.RequestId).ToDictionary(g => g.Key, g => g.OrderBy(s => s.Order).ToList());
        bool NeedsMe(ApprovalRequest r) => r.Status == ApprovalStatuses.Pending && byReq.TryGetValue(r.Id, out var ss) && ss.Any(s => s.Status == "Pending" && s.ApproverId == me);
        bool Final(ApprovalRequest r) => r.Status != ApprovalStatuses.Pending;

        var counts = new ApprovalCountsDto(all.Count(NeedsMe), all.Count(r => r.RequesterId == me && !Final(r)), all.Count(r => !Final(r)), all.Count(Final));
        IEnumerable<ApprovalRequest> picked = (view ?? "needs").ToLowerInvariant() switch
        {
            "mine" => all.Where(r => r.RequesterId == me && !Final(r)),
            "all" => all.Where(r => !Final(r)),
            "history" => all.Where(Final).OrderByDescending(r => r.DecidedAt ?? r.CreatedAt),
            _ => all.Where(NeedsMe).OrderBy(r => r.ExpiresAt ?? DateTime.MaxValue).ThenByDescending(r => RiskRank(r.Risk)),
        };
        if (t is not null) picked = picked.Where(r => r.Type == t);
        var list = picked.ToList();

        var weekAgo = clock.Now.AddDays(-7);
        var decided = all.Where(r => r.DecidedAt >= weekAgo).ToList();
        var minutes = decided.Where(r => r.Status is ApprovalStatuses.Approved or ApprovalStatuses.Rejected)
            .Select(r => (int)Math.Round((r.DecidedAt!.Value - r.CreatedAt).TotalMinutes)).OrderBy(x => x).ToList();
        var week = new ApprovalWeekDto(decided.Count(r => r.Status == ApprovalStatuses.Approved), decided.Count(r => r.Status == ApprovalStatuses.Rejected),
            decided.Count(r => r.Status == ApprovalStatuses.Expired), minutes.Count == 0 ? null : minutes[minutes.Count / 2]);
        var byType = all.Where(r => !Final(r) || r.CreatedAt >= weekAgo).GroupBy(r => r.Type).ToDictionary(g => g.Key, g => g.Count());
        var endOfDay = clock.Now.Date.AddDays(1);
        var expiring = all.Count(r => r.Status == ApprovalStatuses.Pending && r.ExpiresAt is { } e && e < endOfDay);

        var names = await NamesAsync(list.Select(r => r.RequesterId).Concat(list.SelectMany(r => byReq.GetValueOrDefault(r.Id) ?? []).Select(s => s.ApproverId)), ct);
        var gone = await GoneLinkTargetsAsync(list, ct);
        var items = list.Select(r => Dto(r, byReq.GetValueOrDefault(r.Id) ?? [], names, me, null, gone)).ToList();
        return new ApprovalListDto(items, counts, week, byType, expiring, await ElsewhereAsync(ct));
    }

    /// <summary>The sidebar badge: requests waiting on the caller.</summary>
    public async Task<int> NeedsMeCountAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var now = clock.Now;
        return await db.ApprovalRequestSteps.AsNoTracking().Where(s => s.ApproverId == me && s.Status == "Pending")
            .Join(db.ApprovalRequests.AsNoTracking().Where(r => r.Status == ApprovalStatuses.Pending && (r.ExpiresAt == null || r.ExpiresAt > now)),
                s => s.RequestId, r => r.Id, (s, r) => r.Id).Distinct().CountAsync(ct);
    }

    public async Task<ApprovalRequestDto> GetAsync(Guid id, CancellationToken ct = default)
    {
        await ExpireDueAsync(ct);
        var r = await Visible().FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Request not found.");
        return await DetailAsync(r, ct);
    }

    private async Task<ApprovalRequestDto> DetailAsync(ApprovalRequest r, CancellationToken ct)
    {
        var steps = await db.ApprovalRequestSteps.AsNoTracking().Where(s => s.RequestId == r.Id).OrderBy(s => s.Order).ToListAsync(ct);
        var events = await db.ApprovalRequestEvents.AsNoTracking().Where(e => e.RequestId == r.Id).OrderBy(e => e.CreatedAt).ThenBy(e => e.Id).ToListAsync(ct);
        var names = await NamesAsync(steps.Select(s => s.ApproverId).Append(r.RequesterId).Concat(events.Where(e => e.UserId != null).Select(e => e.UserId!.Value)), ct);
        return Dto(r, steps, names, ctx.RequireUserId(), events, await GoneLinkTargetsAsync([r], ct));
    }

    private IQueryable<ApprovalRequest> Visible()
    {
        var me = ctx.RequireUserId();
        var q = db.ApprovalRequests.AsNoTracking();
        if (Broad) return q;
        var mineAsApprover = db.ApprovalRequestSteps.Where(s => s.ApproverId == me).Select(s => s.RequestId);
        return q.Where(r => r.RequesterId == me || mineAsApprover.Contains(r.Id));
    }

    // ------------------------------------------------------------------ create

    public async Task<ApprovalRequestDto> CreateAsync(CreateApprovalRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        if (ctx.Role == TenantRole.Guest) throw new ForbiddenException("Guests cannot request approvals.");
        var type = NormalizeType(req.Type);
        var title = req.Title?.Trim() ?? "";
        if (title.Length is < 1 or > 200) throw new ValidationException("title", "Give the request a title of up to 200 characters.");
        var summary = string.IsNullOrWhiteSpace(req.Summary) ? null : req.Summary.Trim();
        if (summary?.Length > 2000) throw new ValidationException("summary", "Keep the description under 2000 characters.");
        var risk = (req.Risk ?? "Low").Trim() switch { var x when x.Equals("high", StringComparison.OrdinalIgnoreCase) => "High", var x when x.Equals("medium", StringComparison.OrdinalIgnoreCase) => "Medium", _ => "Low" };
        var impact = string.IsNullOrWhiteSpace(req.Impact) ? null : req.Impact.Trim();
        if (impact?.Length > 300) throw new ValidationException("impact", "Keep the impact under 300 characters.");
        var payload = CleanPayload(req.Payload);
        var links = CleanLinks(req.Links);
        var expires = req.ExpiresInHours;
        var policy = await db.ApprovalPolicies.AsNoTracking().FirstOrDefaultAsync(p => p.Type == type, ct);
        expires ??= policy?.ExpiryHours ?? (type is ApprovalTypes.Incident ? 4 : type is ApprovalTypes.Deployment ? 24 : 72);
        if (expires is < 1 or > 24 * 30) throw new ValidationException("expiresInHours", "Choose between one hour and 30 days.");
        if (type == ApprovalTypes.Leave) LeaveDates(payload);

        var chain = req.Chain is { Count: > 0 } ? req.Chain : await PolicyStepsAsync(type, ct);
        var resolved = await ResolveAsync(chain, me, tid, ct);

        var r = new ApprovalRequest
        {
            TenantId = tid, Type = type, Title = title, Summary = summary, PayloadJson = JsonSerializer.Serialize(payload, Json), Risk = risk, Impact = impact,
            LinksJson = JsonSerializer.Serialize(links, Json), RequesterId = me, Status = ApprovalStatuses.Pending, CurrentStep = 1,
            ExpiresAt = clock.Now.AddHours(expires.Value), CreatedAt = clock.Now, CreatedBy = me,
        };
        db.ApprovalRequests.Add(r);
        for (var i = 0; i < resolved.Count; i++)
            db.ApprovalRequestSteps.Add(new ApprovalRequestStep
            {
                TenantId = tid, RequestId = r.Id, Order = i + 1, Role = resolved[i].Role, ApproverId = resolved[i].UserId, Status = i == 0 ? "Pending" : "Waiting",
            });
        db.ApprovalRequestEvents.Add(new ApprovalRequestEvent { TenantId = tid, RequestId = r.Id, UserId = me, Action = "Requested", CreatedAt = clock.Now });
        recorder.Activity("approval.requested", nameof(ApprovalRequest), r.Id, $"Asked for approval: {title}");
        await NotifyTurnAsync(r, resolved[0].UserId, ct);
        await db.SaveChangesAsync(ct);
        return await DetailAsync(r, ct);
    }

    // ------------------------------------------------------------------ decide

    public async Task<ApprovalRequestDto> DecideAsync(Guid id, DecideApprovalRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        await ExpireDueAsync(ct);
        if (!await Visible().AnyAsync(x => x.Id == id, ct)) throw new NotFoundException("Request not found.");
        var r = await db.ApprovalRequests.FirstAsync(x => x.Id == id, ct);
        var steps = await db.ApprovalRequestSteps.Where(s => s.RequestId == id).OrderBy(s => s.Order).ToListAsync(ct);
        var comment = string.IsNullOrWhiteSpace(req.Comment) ? null : req.Comment.Trim();
        if (comment?.Length > 2000) throw new ValidationException("comment", "Keep the comment under 2000 characters.");
        var action = (req.Action ?? "").Trim().ToLowerInvariant();
        var current = steps.FirstOrDefault(s => s.Status == "Pending");
        void Event(string what, int? step = null) => db.ApprovalRequestEvents.Add(new ApprovalRequestEvent { TenantId = tid, RequestId = id, UserId = me, Action = what, StepOrder = step, Comment = comment, CreatedAt = clock.Now });
        var link = $"/approvals?open={id}";
        var leaveToPlan = false;
        var (wasStatus, wasStep) = (r.Status, r.CurrentStep);

        switch (action)
        {
            case "approve" or "reject":
                if (r.Status != ApprovalStatuses.Pending || current is null) throw new ConflictException("This request has already been decided.", "APPROVAL_DECIDED");
                if (current.ApproverId != me) throw new ForbiddenException("It is not your turn to decide on this request.", "APPROVAL_NOT_YOUR_TURN");
                current.Status = action == "approve" ? "Approved" : "Rejected";
                current.DecidedAt = clock.Now; current.Comment = comment;
                Event(action == "approve" ? "Approved" : "Rejected", current.Order);
                if (action == "reject")
                {
                    foreach (var s in steps.Where(s => s.Status == "Waiting")) s.Status = "Skipped";
                    r.Status = ApprovalStatuses.Rejected; r.DecidedAt = clock.Now;
                    await notifications.AddAsync(r.RequesterId, NotificationType.Approval, $"Rejected: {r.Title}", comment is null ? "Your request was rejected." : $"“{Short(comment)}”", link, $"approval:{id:N}:final", ct: ct);
                }
                else if (steps.FirstOrDefault(s => s.Status == "Waiting") is { } next)
                {
                    next.Status = "Pending"; r.CurrentStep = next.Order;
                    await NotifyTurnAsync(r, next.ApproverId, ct);
                    await notifications.AddAsync(r.RequesterId, NotificationType.Approval, $"Step {current.Order} of {steps.Count} approved: {r.Title}",
                        $"{current.Role} approved. Now waiting on {next.Role}.", link, $"approval:{id:N}:step:{current.Order}", ct: ct);
                }
                else
                {
                    r.Status = ApprovalStatuses.Approved; r.DecidedAt = clock.Now; r.CurrentStep = steps.Count;
                    await notifications.AddAsync(r.RequesterId, NotificationType.Approval, $"Approved: {r.Title}", comment is null ? "Every approver said yes." : $"“{Short(comment)}”", link, $"approval:{id:N}:final", ct: ct);
                    leaveToPlan = r.Type == ApprovalTypes.Leave;
                }
                recorder.Activity($"approval.{action}d", nameof(ApprovalRequest), id, $"{(action == "approve" ? "Approved" : "Rejected")} step {current.Order}: {r.Title}");
                break;
            case "comment":
                if (comment is null) throw new ValidationException("comment", "Write a comment or question.");
                Event("Commented", current?.Order);
                if (r.RequesterId != me) await notifications.AddAsync(r.RequesterId, NotificationType.Approval, $"Question on {r.Title}", Short(comment), link, ct: ct);
                if (current is not null && current.ApproverId != me) await notifications.AddAsync(current.ApproverId, NotificationType.Approval, $"Comment on {r.Title}", Short(comment), link, ct: ct);
                break;
            case "withdraw":
                if (r.RequesterId != me) throw new ForbiddenException("Only the person who asked can withdraw a request.");
                if (r.Status != ApprovalStatuses.Pending) throw new ConflictException("This request has already been decided.", "APPROVAL_DECIDED");
                foreach (var s in steps.Where(s => s.Status is "Waiting" or "Pending")) s.Status = "Skipped";
                r.Status = ApprovalStatuses.Withdrawn; r.DecidedAt = clock.Now;
                Event("Withdrawn");
                break;
            case "remind":
                if (r.Status != ApprovalStatuses.Pending || current is null) throw new ConflictException("This request has already been decided.", "APPROVAL_DECIDED");
                if (r.RequesterId != me && !Broad) throw new ForbiddenException("Only the person who asked can send a reminder.");
                var expiresLocal = r.ExpiresAt is { } e ? await InZoneOfAsync(current.ApproverId, e, ct) : null;
                await notifications.AddAsync(current.ApproverId, NotificationType.Approval, $"Waiting on you: {r.Title}",
                    expiresLocal is not null ? $"Expires {expiresLocal} if nobody decides." : "A decision is needed.", link, $"approval:{id:N}:remind:{clock.Now:yyyyMMddHH}", ct: ct);
                break;
            default:
                throw new ValidationException("action", "Choose approve, reject, comment, withdraw or remind.");
        }
        // History: the request's status and step, old → new (the activity API reads it).
        new ProjectManagement.Application.Features.Platform.FieldDiff().Add("Status", wasStatus, r.Status).Add("Step", wasStep.ToString(), r.CurrentStep.ToString())
            .Record(recorder, "approval", nameof(ApprovalRequest), id);
        await db.SaveChangesAsync(ct);
        if (leaveToPlan) await PlanLeaveAsync(r, ct);
        return await DetailAsync(r, ct);
    }

    /// <summary>
    /// Approvers who let a request's deadline pass: anything waiting past its expiry ends as Expired (and the requester is told). Runs on every
    /// read in this workspace, so no scheduler is needed for it.
    /// </summary>
    public async Task<int> ExpireDueAsync(CancellationToken ct = default)
    {
        var now = clock.Now; var tid = ctx.RequireTenantId();
        var due = await db.ApprovalRequests.Where(r => r.Status == ApprovalStatuses.Pending && r.ExpiresAt != null && r.ExpiresAt < now).Take(50).ToListAsync(ct);
        if (due.Count == 0) return 0;
        var ids = due.Select(r => r.Id).ToList();
        var steps = await db.ApprovalRequestSteps.Where(s => ids.Contains(s.RequestId) && (s.Status == "Pending" || s.Status == "Waiting")).ToListAsync(ct);
        foreach (var s in steps) s.Status = "Skipped";
        foreach (var r in due)
        {
            r.Status = ApprovalStatuses.Expired; r.DecidedAt = r.ExpiresAt;
            db.ApprovalRequestEvents.Add(new ApprovalRequestEvent { TenantId = tid, RequestId = r.Id, Action = "Expired", Comment = "No decision in time.", CreatedAt = now });
            await notifications.AddAsync(r.RequesterId, NotificationType.Approval, $"Expired: {r.Title}", "Nobody decided in time. Ask again if it is still needed.", $"/approvals?open={r.Id}", $"approval:{r.Id:N}:final", ct: ct);
        }
        await db.SaveChangesAsync(ct);
        return due.Count;
    }

    /// <summary>Approved leave becomes planned leave on the timesheet, under the request's id (so the two stay linked and it never doubles).</summary>
    private async Task PlanLeaveAsync(ApprovalRequest r, CancellationToken ct)
    {
        var payload = Payload(r);
        string outcome;
        try
        {
            var (from, to) = LeaveDates(payload);
            await leave.CreateAsync(new PlanLeaveRequest([r.RequesterId], from, to, payload.GetValueOrDefault("note") ?? payload.GetValueOrDefault("kind"), r.Id), ct);
            outcome = $"PlannedLeave:{r.Id}";
        }
        catch (AppException ex) { outcome = Text(ex.Message); }
        var row = await db.ApprovalRequests.FirstAsync(x => x.Id == r.Id, ct);
        row.Outcome = outcome; r.Outcome = outcome;
        await db.SaveChangesAsync(ct);
        static string Text(string s) => s.Length > 120 ? s[..120] : s;
    }

    private static (DateOnly From, DateOnly To) LeaveDates(IReadOnlyDictionary<string, string> payload)
    {
        if (!DateOnly.TryParse(payload.GetValueOrDefault("from"), out var from)) throw new ValidationException("payload.from", "Choose the first day of leave.");
        var to = DateOnly.TryParse(payload.GetValueOrDefault("to"), out var t) ? t : from;
        if (to < from || to.DayNumber - from.DayNumber > 30) throw new ValidationException("payload.to", "Choose up to 31 consecutive days.");
        return (from, to);
    }

    // ------------------------------------------------------------------ chains and policies

    /// <summary>The chain a new request of this type would get, with its people (the request sheet's "suggested chain").</summary>
    public async Task<ChainPreviewDto> PreviewAsync(string type, CancellationToken ct = default)
    {
        var t = NormalizeType(type);
        var me = ctx.RequireUserId();
        var policy = await db.ApprovalPolicies.AsNoTracking().FirstOrDefaultAsync(p => p.Type == t, ct);
        var steps = await ResolveAsync(await PolicyStepsAsync(t, ct), me, ctx.RequireTenantId(), ct);
        var names = await NamesAsync(steps.Select(s => s.UserId), ct);
        var dto = steps.Select((s, i) => new ApprovalChainStepDto(i + 1, s.Role, new UserRefDto(s.UserId, names.GetValueOrDefault(s.UserId) ?? "Unknown"), "Waiting", null, null)).ToList();
        var rule = $"{TypeLabel(t)} needs {string.Join(" → ", steps.Select(s => s.Role))}.";
        return new ChainPreviewDto(t, dto, rule, policy is not null);
    }

    public async Task<IReadOnlyList<ApprovalPolicyDto>> PoliciesAsync(CancellationToken ct = default)
    {
        ctx.RequireUserId();
        var saved = await db.ApprovalPolicies.AsNoTracking().ToListAsync(ct);
        return ApprovalTypes.All.Select(t => saved.FirstOrDefault(p => p.Type == t) is { } p
            ? new ApprovalPolicyDto(t, ReadSteps(p.StepsJson), p.ExpiryHours, true)
            : new ApprovalPolicyDto(t, DefaultChain(t), null, false)).ToList();
    }

    /// <summary>Settings › Approvals: a workspace's default chain for one type (owners and admins). An empty list goes back to the built-in chain.</summary>
    public async Task<ApprovalPolicyDto> SavePolicyAsync(string type, SaveApprovalPolicyRequest req, CancellationToken ct = default)
    {
        if (!Broad) throw new ForbiddenException("Only owners and admins can change approval chains.");
        var t = NormalizeType(type); var tid = ctx.RequireTenantId();
        var steps = CleanChain(req.Steps ?? []);
        if (req.ExpiryHours is < 1 or > 24 * 30) throw new ValidationException("expiryHours", "Choose between one hour and 30 days.");
        foreach (var s in steps.Where(s => s.UserId is not null))
            if (!await db.TenantMembers.AnyAsync(m => m.TenantId == tid && m.UserId == s.UserId, ct)) throw new ValidationException("steps", "Every approver must be a member of this workspace.");
        var row = await db.ApprovalPolicies.FirstOrDefaultAsync(p => p.Type == t, ct);
        if (steps.Count == 0)
        {
            if (row is not null) db.ApprovalPolicies.Remove(row);
            recorder.Audit("approval.policy_reset", nameof(ApprovalPolicy), row?.Id, newValue: new { Type = t });
            await db.SaveChangesAsync(ct);
            return new ApprovalPolicyDto(t, DefaultChain(t), null, false);
        }
        if (row is null) { row = new ApprovalPolicy { TenantId = tid, Type = t }; db.ApprovalPolicies.Add(row); }
        var before = row.StepsJson;
        row.StepsJson = JsonSerializer.Serialize(steps, Json); row.ExpiryHours = req.ExpiryHours;
        recorder.Audit("approval.policy_saved", nameof(ApprovalPolicy), row.Id, oldValue: before, newValue: row.StepsJson);
        await db.SaveChangesAsync(ct);
        return new ApprovalPolicyDto(t, steps, row.ExpiryHours, true);
    }

    private async Task<IReadOnlyList<ChainStepInput>> PolicyStepsAsync(string type, CancellationToken ct)
    {
        var p = await db.ApprovalPolicies.AsNoTracking().FirstOrDefaultAsync(x => x.Type == type, ct);
        var steps = p is null ? [] : ReadSteps(p.StepsJson);
        return steps.Count > 0 ? steps : DefaultChain(type);
    }

    private static IReadOnlyList<ChainStepInput> ReadSteps(string json)
    {
        try { return JsonSerializer.Deserialize<List<ChainStepInput>>(json, Json) ?? []; } catch (JsonException) { return []; }
    }

    private static List<ChainStepInput> CleanChain(IReadOnlyList<ChainStepInput> steps)
    {
        if (steps.Count > MaxSteps) throw new ValidationException("chain", $"A chain has at most {MaxSteps} approvers.");
        var out_ = new List<ChainStepInput>();
        foreach (var s in steps)
        {
            var role = (s.Role ?? "").Trim();
            if (role.Length is < 1 or > 60) throw new ValidationException("chain", "Every step needs a role of up to 60 characters.");
            out_.Add(new ChainStepInput(role, s.UserId));
        }
        return out_;
    }

    /// <summary>
    /// Roles become people: Lead / Manager = the requester's manager; Owner = a workspace owner; Admin and the other named roles (Ops, People
    /// ops, Finance ...) = an admin, else an owner; a step with a person is that person. Nobody approves their own request unless nobody else can.
    /// </summary>
    private async Task<List<(string Role, Guid UserId)>> ResolveAsync(IReadOnlyList<ChainStepInput> chain, Guid requester, Guid tid, CancellationToken ct)
    {
        var steps = CleanChain(chain);
        if (steps.Count == 0) throw new ValidationException("chain", "Add at least one approver.");
        var members = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid)
            .Select(m => new { m.UserId, m.Role, m.ReportsToUserId }).ToListAsync(ct);
        var mine = members.FirstOrDefault(m => m.UserId == requester);
        Guid? Pick(params TenantRole[] roles)
        {
            foreach (var role in roles)
            {
                var other = members.Where(m => m.Role == role && m.UserId != requester).Select(m => (Guid?)m.UserId).FirstOrDefault();
                if (other is not null) return other;
            }
            return null;
        }
        var fallback = Pick(TenantRole.Owner, TenantRole.Admin) ?? requester;
        var result = new List<(string, Guid)>();
        foreach (var s in steps)
        {
            Guid who;
            if (s.UserId is { } u)
            {
                if (members.All(m => m.UserId != u)) throw new ValidationException("chain", "Every approver must be a member of this workspace.");
                who = u;
            }
            else
            {
                var role = s.Role.ToLowerInvariant();
                who = role switch
                {
                    "lead" or "manager" or "team lead" => mine?.ReportsToUserId is { } boss && members.Any(m => m.UserId == boss) ? boss : fallback,
                    "owner" => Pick(TenantRole.Owner) ?? fallback,
                    _ => Pick(TenantRole.Admin, TenantRole.Owner) ?? fallback,
                };
            }
            result.Add((s.Role, who));
        }
        return result;
    }

    // ------------------------------------------------------------------ elsewhere

    private async Task<IReadOnlyList<ApprovalElsewhereDto>> ElsewhereAsync(CancellationToken ct)
    {
        var me = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        var list = new List<ApprovalElsewhereDto>();
        var signOffs = await db.ReleaseSignOffs.AsNoTracking().CountAsync(s => s.UserId == me && s.Status == "Pending", ct);
        if (signOffs > 0) list.Add(new ApprovalElsewhereDto("release", "Release sign-offs", signOffs, "/quality"));
        var reports = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.ReportsToUserId == me).Select(m => m.UserId).ToListAsync(ct);
        if (reports.Count > 0)
        {
            var sheets = await db.TimesheetApprovals.AsNoTracking().CountAsync(a => reports.Contains(a.UserId) && a.Status == TimesheetStatus.Submitted, ct);
            if (sheets > 0) list.Add(new ApprovalElsewhereDto("timesheet", "Timesheets to review", sheets, "/insights?tab=time&s=approvals"));
        }
        return list;
    }

    // ------------------------------------------------------------------ helpers

    private async Task NotifyTurnAsync(ApprovalRequest r, Guid approver, CancellationToken ct)
    {
        var who = (await NamesAsync([r.RequesterId], ct)).GetValueOrDefault(r.RequesterId) ?? "Someone";
        var by = r.ExpiresAt is { } e ? await InZoneOfAsync(approver, e, ct) : null;
        await notifications.AddAsync(approver, NotificationType.Approval, $"{who} asks you to approve: {r.Title}",
            $"{TypeLabel(r.Type)}{(r.Risk == "High" ? " · high risk" : "")}{(by is null ? "" : $" · decide by {by}")}",
            $"/approvals?open={r.Id}", $"approval:{r.Id:N}:turn:{approver:N}", ct: ct);
    }

    /// <summary>
    /// A moment as the recipient reads it ("12 Nov 17:30 IST"): their own zone, else the workspace's, else the platform's - the same order
    /// reminders use - so an approver in another region is not handed a UTC time in the bell or the e-mail.
    /// </summary>
    private async Task<string> InZoneOfAsync(Guid userId, DateTime utc, CancellationToken ct)
    {
        var tid = ctx.RequireTenantId();
        var userZone = await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.TimeZone).FirstOrDefaultAsync(ct);
        var settings = await db.ReminderSettings.AsNoTracking().FirstOrDefaultAsync(s => s.UserId == userId, ct);
        var orgZone = await db.Tenants.AsNoTracking().Where(t => t.Id == tid).Select(t => t.TimeZone).FirstOrDefaultAsync(ct);
        var tz = ProjectManagement.Application.Features.Reminders.ZoneTime.Find(clock.ZoneIdFor(userZone, settings, orgZone));
        var local = ProjectManagement.Application.Features.Reminders.ZoneTime.ToLocal(utc, tz);
        var abbr = tz.GetZoneInterval(NodaTime.Instant.FromDateTimeUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc))).Name;
        return $"{local.ToString("dd MMM HH:mm", System.Globalization.CultureInfo.InvariantCulture)} {abbr}";
    }

    private static int RiskRank(string risk) => risk switch { "High" => 2, "Medium" => 1, _ => 0 };
    private static string Short(string s) => s.Length > 180 ? s[..180] + "…" : s;

    private static Dictionary<string, string> CleanPayload(IReadOnlyDictionary<string, string>? payload)
    {
        var d = new Dictionary<string, string>(StringComparer.Ordinal);
        if (payload is null) return d;
        if (payload.Count > MaxPayload) throw new ValidationException("payload", $"Keep the details to {MaxPayload} fields.");
        foreach (var (k, v) in payload)
        {
            var key = (k ?? "").Trim();
            if (key.Length is < 1 or > 40) throw new ValidationException("payload", "Field names are 1 to 40 characters.");
            var value = (v ?? "").Trim();
            if (value.Length > 1000) throw new ValidationException("payload", "Keep each detail under 1000 characters.");
            if (value.Length > 0) d[key] = value;
        }
        return d;
    }

    private static List<ApprovalLinkDto> CleanLinks(IReadOnlyList<ApprovalLinkDto>? links)
    {
        var list = (links ?? []).Where(l => !string.IsNullOrWhiteSpace(l.Label)).ToList();
        if (list.Count > MaxLinks) throw new ValidationException("links", $"Link at most {MaxLinks} items.");
        return list.Select(l =>
        {
            var href = string.IsNullOrWhiteSpace(l.Href) ? null : l.Href.Trim();
            // Links stay inside the app: a relative path only (never a script or another site).
            if (href is not null && (!href.StartsWith('/') || href.StartsWith("//"))) href = null;
            return new ApprovalLinkDto(Cut(l.Kind, 20) ?? "item", Cut(l.Label, 80)!, Cut(l.Id, 64), Cut(href, 300));
        }).ToList();
        static string? Cut(string? s, int n) => s is null ? null : (s.Trim().Length > n ? s.Trim()[..n] : s.Trim());
    }

    private static Dictionary<string, string> Payload(ApprovalRequest r)
    {
        try { return JsonSerializer.Deserialize<Dictionary<string, string>>(r.PayloadJson, Json) ?? []; } catch (JsonException) { return []; }
    }

    private static readonly System.Text.RegularExpressions.Regex LinkGuid = new("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");

    /// <summary>The projects and work a link points at: its id and any id in its address.</summary>
    private static IEnumerable<Guid> LinkTargets(ApprovalLinkDto l)
    {
        if (Guid.TryParse(l.Id, out var id)) yield return id;
        if (l.Href is { } h) foreach (System.Text.RegularExpressions.Match m in LinkGuid.Matches(h)) yield return Guid.Parse(m.Value);
    }

    /// <summary>
    /// Link targets that name a project or a piece of work this person can no longer open (deleted, or in a deleted project): such links are
    /// left out of the request entirely rather than shown as a dead link. Ids that are neither a project nor work (documents, deploys) are kept.
    /// </summary>
    private async Task<IReadOnlySet<Guid>> GoneLinkTargetsAsync(IEnumerable<ApprovalRequest> requests, CancellationToken ct)
    {
        var ids = requests.SelectMany(r => Links(r)).SelectMany(LinkTargets).Distinct().ToList();
        if (ids.Count == 0) return new HashSet<Guid>();
        var tid = ctx.RequireTenantId();
        // Every project and work item of this workspace with one of those ids, deleted or not (ids only), then the ones still visible.
        var known = await db.Projects.IgnoreQueryFilters().Where(p => p.TenantId == tid && ids.Contains(p.Id)).Select(p => p.Id)
            .Concat(db.WorkItems.IgnoreQueryFilters().Where(w => w.TenantId == tid && ids.Contains(w.Id)).Select(w => w.Id)).ToListAsync(ct);
        if (known.Count == 0) return new HashSet<Guid>();
        var live = await db.Projects.Where(p => known.Contains(p.Id)).Select(p => p.Id)
            .Concat(db.WorkItems.Where(w => known.Contains(w.Id)).Select(w => w.Id)).ToListAsync(ct);
        return known.Except(live).ToHashSet();
    }

    private static List<ApprovalLinkDto> Links(ApprovalRequest r)
    {
        try { return JsonSerializer.Deserialize<List<ApprovalLinkDto>>(r.LinksJson, Json) ?? []; } catch (JsonException) { return []; }
    }

    private ApprovalRequestDto Dto(ApprovalRequest r, IReadOnlyList<ApprovalRequestStep> steps, IReadOnlyDictionary<Guid, string> names, Guid me, IReadOnlyList<ApprovalRequestEvent>? events, IReadOnlySet<Guid>? gone = null)
    {
        UserRefDto Ref(Guid id) => new(id, names.GetValueOrDefault(id) ?? "Former member");
        var needs = r.Status == ApprovalStatuses.Pending && steps.Any(s => s.Status == "Pending" && s.ApproverId == me);
        return new ApprovalRequestDto(r.Id, r.Type, r.Title, r.Summary, Payload(r), r.Risk, r.Impact, Links(r).Where(l => gone is null || !LinkTargets(l).Any(gone.Contains)).ToList(), Ref(r.RequesterId), r.Status, r.CurrentStep,
            steps.Select(s => new ApprovalChainStepDto(s.Order, s.Role, Ref(s.ApproverId), s.Status, s.DecidedAt, s.Comment)).ToList(), needs, r.RequesterId == me,
            r.CreatedAt, r.ExpiresAt, r.DecidedAt, r.Outcome,
            events?.Select(e => new ApprovalEventDto(e.Id, e.UserId is { } u ? Ref(u) : null, e.Action, e.StepOrder, e.Comment, e.CreatedAt)).ToList());
    }

    private async Task<Dictionary<Guid, string>> NamesAsync(IEnumerable<Guid> ids, CancellationToken ct)
    {
        var list = ids.Distinct().ToList();
        return list.Count == 0 ? [] : await db.Users.AsNoTracking().Where(u => list.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
    }
}
