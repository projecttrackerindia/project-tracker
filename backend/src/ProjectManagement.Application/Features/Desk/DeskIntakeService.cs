using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Support;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Desk;

/// <summary>
/// Handles one queued WhatsApp message inside its workspace: matches the sender to a member (by their verified WhatsApp link), raises the
/// chat's ticket when it has none, records what the Desk understood, routes it, copies the photo, document, voice note or video onto the
/// ticket and acknowledges the customer. Re-entrant: a retry never raises a second ticket or copies a file twice. When the number's AI
/// employee is answering the chat, it owns the conversation: no acknowledgement or ticket from here, only routing once it raised one.
/// </summary>
public class DeskIntakeService(IAppDbContext db, AppClock clock, SupportChannelService support, DeskSettingsService settings, DeskClassifier classifier,
    DeskRoutingService routing, WorkTaskService workTasks, ISecretProtector secrets, ILogger<DeskIntakeService> log)
{
    private static readonly HashSet<string> Copyable = ["image", "document", "video", "voice"];

    public async Task<Guid?> HandleAsync(DeskInboundEvent e, CancellationToken ct)
    {
        var s = await settings.CurrentAsync(ct);
        if (!s.IntakeEnabled || e.ConversationId is not { } chatId) return null;
        var chat = await db.SupportConversations.FirstOrDefaultAsync(c => c.Id == chatId, ct);
        if (chat is null) return null;
        var channel = await db.SupportChannels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == chat.ChannelId, ct);
        if (channel is null || !channel.Enabled) return null;
        var messages = support.MessagesFor(chat);
        var message = messages.LastOrDefault(m => m.ProviderId == e.ProviderMessageId);
        var aiOwns = channel.AutoReply && chat.Mode == "ai";
        var said = string.Join("\n", messages.Where(m => m.From == "contact").TakeLast(10).Select(m => m.Text));
        var (contactUser, organization) = await MatchAsync(support.NumberOf(chat), ct);

        DeskClassification? c = null;
        var created = false;
        if (chat.WorkTaskId is null && s.AutoCreateTicket && !aiOwns)
        {
            c = await classifier.ClassifyAsync(said, ct);
            var first = messages.FirstOrDefault(m => m.From == "contact")?.Text ?? "WhatsApp request";
            var title = c.Category != "General" && first.Length < 12 ? $"{c.Category}: {first}" : first;
            var confident = !DeskRules.NeedsReview(c.Confidence, s.ConfidenceThreshold);
            await support.EnsureDeskTicketAsync(chat, title.Length > 80 ? title[..80] + "…" : title, c.Summary, confident ? c.Priority : Priority.Medium, ct);
            created = true;
        }

        if (chat.WorkTaskId is { } taskId)
        {
            var task = await db.WorkTasks.FirstAsync(t => t.Id == taskId, ct);
            if (!await db.DeskTicketInsights.AnyAsync(i => i.WorkTaskId == taskId, ct))
            {
                c ??= await classifier.ClassifyAsync(said, ct);
                await routing.RecordInsightAsync(task, c, "whatsapp", contactUser, organization, ct);
            }
            if (!await db.DeskAssignments.AnyAsync(a => a.WorkTaskId == taskId, ct)) await routing.RouteAsync(taskId, ct);
            if (message?.Media is { } media && Copyable.Contains(media.Kind)) await CopyAsync(chat, task, media, ct);
        }

        if (s.AutoAcknowledge && !aiOwns && (created || chat.WorkTaskId is null && !RecentlyAcknowledged(messages)))
        {
            var key = chat.WorkTaskId is { } t ? await db.WorkTasks.AsNoTracking().Where(x => x.Id == t).Select(x => (int?)x.Number).FirstOrDefaultAsync(ct) : null;
            var text = (s.AckMessage.Length > 0 ? s.AckMessage : DeskSettingsService.DefaultAck).Replace("{ticket}", key is { } n ? $" (ticket {WorkTaskService.KeyOf(n)})" : "");
            try { await support.SendDeskMessageAsync(chat, text, "Desk", ct); }
            catch (Exception x) when (x is AppException or HttpRequestException) { log.LogWarning("Desk acknowledgement not sent for chat {Chat} ({Kind})", chat.Id, x.GetType().Name); }
        }
        return chat.WorkTaskId;
    }

    private bool RecentlyAcknowledged(List<SupportMessageDto> messages) =>
        messages.Any(m => m.From == "update" && m.By == "Desk" && m.At > clock.Now.AddHours(-12));

    /// <summary>The member whose verified WhatsApp link is this number, and their first team as the organisation.</summary>
    private async Task<(Guid? User, string? Organization)> MatchAsync(string number, CancellationToken ct)
    {
        var digits = new string(number.Where(char.IsDigit).ToArray());
        if (digits.Length < 8) return (null, null);
        var links = await db.WhatsAppContactLinks.AsNoTracking().Where(l => l.VerifiedAt != null).Select(l => new { l.UserId, l.PhoneProtected }).Take(2000).ToListAsync(ct);
        foreach (var l in links)
        {
            string phone;
            try { phone = new string(secrets.Unprotect(l.PhoneProtected).Where(char.IsDigit).ToArray()); }
            catch (Exception x) when (x is not OperationCanceledException) { continue; }
            if (phone.Length < 8 || !string.Equals(phone[^Math.Min(10, phone.Length)..], digits[^Math.Min(10, digits.Length)..], StringComparison.Ordinal)) continue;
            var team = await (from m in db.TeamMembers.AsNoTracking() join t in db.Teams.AsNoTracking() on m.TeamId equals t.Id where m.UserId == l.UserId select t.Name).FirstOrDefaultAsync(ct);
            return (l.UserId, team);
        }
        return (null, null);
    }

    private async Task CopyAsync(SupportConversation chat, WorkTask task, SupportMediaDto media, CancellationToken ct)
    {
        try
        {
            var (bytes, _, name) = await support.DeskMediaAsync(chat, media, ct);
            if (await db.WorkTaskAttachments.AnyAsync(a => a.WorkTaskId == task.Id && a.FileName == name, ct)) return;
            await workTasks.UploadAsync(task.Id, name, new MemoryStream(bytes), bytes.Length, ct);
        }
        // A type the ticket does not accept, or a file Meta no longer has: it stays in the chat to open from there.
        catch (Exception x) when (x is AppException or HttpRequestException) { log.LogWarning("Desk: WhatsApp {Kind} not copied to the ticket ({Error})", media.Kind, x.GetType().Name); }
    }
}

/// <summary>
/// The Desk's background work across workspaces: takes inbound messages off the queue (claimed with a lease, so two servers never handle the
/// same one), retries failures with back-off and parks them as dead letters after the last try; checks unaccepted and overdue tickets; and
/// deletes voice recordings past their retention date. Scheduling reads only ids, workspace ids and status; the work runs inside each workspace.
/// </summary>
public class DeskQueueProcessor(IServiceScopeFactory scopes, TimeProvider time, ILogger<DeskQueueProcessor> log)
{
    private int rounds;
    private DateTime UtcNow => time.GetUtcNow().UtcDateTime;

    public async Task<int> RunAsync(CancellationToken ct = default)
    {
        var handled = await ProcessAsync(ct);
        if (Interlocked.Increment(ref rounds) % 6 == 1) { await EscalateAsync(ct); await RetentionAsync(ct); }
        return handled;
    }

    public async Task<int> ProcessAsync(CancellationToken ct = default)
    {
        List<Guid> due;
        var now = UtcNow;
        using (var scan = scopes.CreateScope())
        {
            var db = scan.ServiceProvider.GetRequiredService<IAppDbContext>();
            due = await db.DeskInboundEvents.IgnoreQueryFilters().AsNoTracking()
                .Where(e => (e.Status == "pending" && e.NextAttemptAt <= now) || (e.Status == "processing" && e.LeaseUntil < now))
                .OrderBy(e => e.NextAttemptAt).Select(e => e.Id).Take(20).ToListAsync(ct);
        }
        var done = 0;
        foreach (var id in due) if (await HandleOneAsync(id, ct)) done++;
        return done;
    }

    private async Task<bool> HandleOneAsync(Guid id, CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var sp = scope.ServiceProvider;
        var db = sp.GetRequiredService<IAppDbContext>();
        var now = UtcNow;
        var lease = now.AddMinutes(2);
        // The claim: only one server moves it to processing.
        var claimed = await db.DeskInboundEvents.IgnoreQueryFilters()
            .Where(e => e.Id == id && ((e.Status == "pending" && e.NextAttemptAt <= now) || (e.Status == "processing" && e.LeaseUntil < now)))
            .ExecuteUpdateAsync(x => x.SetProperty(e => e.Status, "processing").SetProperty(e => e.LeaseUntil, (DateTime?)lease).SetProperty(e => e.Attempts, e => e.Attempts + 1), ct);
        if (claimed == 0) return false;
        var head = await db.DeskInboundEvents.IgnoreQueryFilters().AsNoTracking().Where(e => e.Id == id).Select(e => new { e.TenantId, e.ChannelId, e.Attempts }).FirstAsync(ct);
        var context = sp.GetRequiredService<CurrentContext>();
        context.TenantId = head.TenantId;
        // Acts as the person who connected the number (tickets carry a real reporter and that person's permissions), like the AI employee.
        var connectedBy = await db.SupportChannels.AsNoTracking().Where(c => c.Id == head.ChannelId).Select(c => (Guid?)c.ConnectedBy).FirstOrDefaultAsync(ct);
        var role = connectedBy is { } u ? await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == head.TenantId && m.UserId == u).Select(m => (TenantRole?)m.Role).FirstOrDefaultAsync(ct) : null;
        context.UserId = role is null ? null : connectedBy;
        context.Role = role;
        context.WorkspaceType = await db.Tenants.AsNoTracking().Where(t => t.Id == head.TenantId).Select(t => (WorkspaceType?)t.Type).FirstOrDefaultAsync(ct);
        try
        {
            if (context.UserId is null) throw new ConflictException("The person who connected this WhatsApp number is no longer in the workspace.");
            var row = await db.DeskInboundEvents.AsNoTracking().FirstAsync(e => e.Id == id, ct);
            var ticket = await sp.GetRequiredService<DeskIntakeService>().HandleAsync(row, ct);
            await db.DeskInboundEvents.Where(e => e.Id == id).ExecuteUpdateAsync(x => x.SetProperty(e => e.Status, "done").SetProperty(e => e.ProcessedAt, (DateTime?)UtcNow)
                .SetProperty(e => e.WorkTaskId, ticket).SetProperty(e => e.LeaseUntil, (DateTime?)null).SetProperty(e => e.LastError, (string?)null), ct);
            return true;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            var next = DeskRules.NextAttempt(head.Attempts, UtcNow);
            var error = e is AppException ? e.Message : e.GetType().Name;
            if (error.Length > 500) error = error[..500];
            log.LogWarning("Desk inbound {Event}: attempt {Attempt} failed ({Kind}){Dead}", id, head.Attempts, e.GetType().Name, next is null ? ", moved to dead letters" : "");
            var status = next is null ? "dead" : "pending";
            var at = next ?? UtcNow;
            await db.DeskInboundEvents.Where(x => x.Id == id).ExecuteUpdateAsync(x => x.SetProperty(r => r.Status, status)
                .SetProperty(r => r.NextAttemptAt, at).SetProperty(r => r.LeaseUntil, (DateTime?)null).SetProperty(r => r.LastError, error), ct);
            return false;
        }
    }

    /// <summary>Unaccepted and overdue tickets, in each workspace that turned routing on.</summary>
    public async Task<int> EscalateAsync(CancellationToken ct = default)
    {
        List<(Guid Tenant, Guid? Supervisor)> tenants;
        using (var scan = scopes.CreateScope())
        {
            var db = scan.ServiceProvider.GetRequiredService<IAppDbContext>();
            tenants = (await db.DeskSettings.IgnoreQueryFilters().AsNoTracking().Where(s => s.RoutingEnabled).Select(s => new { s.TenantId, s.SupervisorId }).Take(500).ToListAsync(ct))
                .Select(x => (x.TenantId, x.SupervisorId)).ToList();
        }
        var moved = 0;
        foreach (var (tenant, supervisor) in tenants)
        {
            using var scope = scopes.CreateScope();
            var context = scope.ServiceProvider.GetRequiredService<CurrentContext>();
            context.TenantId = tenant; context.UserId = supervisor;
            try { moved += await scope.ServiceProvider.GetRequiredService<DeskRoutingService>().EscalateAsync(ct); }
            catch (Exception e) when (e is not OperationCanceledException) { log.LogWarning("Desk escalation failed for a workspace ({Kind})", e.GetType().Name); }
        }
        return moved;
    }

    /// <summary>Recordings past their retention date are deleted (the transcript and summary stay on the ticket).</summary>
    public async Task<int> RetentionAsync(CancellationToken ct = default)
    {
        List<(Guid Id, Guid Tenant)> due;
        var now = UtcNow;
        using (var scan = scopes.CreateScope())
        {
            var db = scan.ServiceProvider.GetRequiredService<IAppDbContext>();
            due = (await db.DeskVoiceSessions.IgnoreQueryFilters().AsNoTracking().Where(v => v.RetainUntil != null && v.RetainUntil < now && v.RecordingKey != null)
                .Select(v => new { v.Id, v.TenantId }).Take(50).ToListAsync(ct)).Select(x => (x.Id, x.TenantId)).ToList();
        }
        foreach (var (id, tenant) in due)
        {
            using var scope = scopes.CreateScope();
            scope.ServiceProvider.GetRequiredService<CurrentContext>().TenantId = tenant;
            try { await scope.ServiceProvider.GetRequiredService<DeskVoiceService>().ExpireRecordingAsync(id, ct); }
            catch (Exception e) when (e is not OperationCanceledException) { log.LogWarning("Desk recording {Session} not removed ({Kind})", id, e.GetType().Name); }
        }
        return due.Count;
    }
}
