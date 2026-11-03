using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Desk;

/// <summary>
/// Puts a signed inbound WhatsApp message on the Desk's durable queue, once. The webhook only stores and enqueues (fast, no calls out);
/// the worker does the rest. Called inside the channel's workspace after the signature checked.
/// </summary>
public class DeskInboundQueue(IAppDbContext db)
{
    public const string Index = "IX_DeskInboundEvents_TenantId_Provider_ProviderMessageId";

    /// <summary>True when the message was queued now; false when intake is off or Meta delivered the same message before.</summary>
    public async Task<bool> EnqueueAsync(Guid tenantId, Guid channelId, Guid conversationId, string providerMessageId, string messageType, DateTime now, CancellationToken ct)
    {
        if (!await db.DeskSettings.AsNoTracking().AnyAsync(s => s.TenantId == tenantId && s.IntakeEnabled, ct)) return false;
        var id = providerMessageId.Length > 200 ? providerMessageId[..200] : providerMessageId;
        if (await db.DeskInboundEvents.AsNoTracking().AnyAsync(e => e.TenantId == tenantId && e.Provider == "whatsapp" && e.ProviderMessageId == id, ct)) return false;
        var row = new DeskInboundEvent
        {
            TenantId = tenantId, Provider = "whatsapp", ProviderMessageId = id, ChannelId = channelId, ConversationId = conversationId,
            MessageType = messageType.Length > 30 ? messageType[..30] : messageType, Status = "pending", NextAttemptAt = now, CreatedAt = now,
        };
        db.DeskInboundEvents.Add(row);
        try { await db.SaveChangesAsync(ct); return true; }
        catch (DbUpdateException e) when (DbErrors.IsUniqueViolation(e, Index, "DeskInboundEvents", "TenantId", "Provider", "ProviderMessageId"))
        {
            db.DeskInboundEvents.Entry(row).State = EntityState.Detached;   // a parallel delivery of the same message won the race
            return false;
        }
    }
}
