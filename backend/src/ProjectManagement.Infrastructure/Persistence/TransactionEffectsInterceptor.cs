using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Logging;

namespace ProjectManagement.Infrastructure.Persistence;

/// <summary>Do not announce changes or invalidate cached plans until an explicit transaction has committed.</summary>
public sealed class TransactionEffectsInterceptor(ILogger<TransactionEffectsInterceptor> log) : DbTransactionInterceptor
{
    public override async Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default)
    {
        if (eventData.Context is not AppDbContext db) return;
        try { await db.PublishCommittedEffectsAsync(CancellationToken.None); }
        catch (Exception ex)
        {
            // The database is already committed: a notification failure must not turn it into a reported rollback.
            log.LogError(ex, "Failed to publish effects of a committed database transaction");
        }
    }

    public override Task TransactionRolledBackAsync(DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default)
    {
        if (eventData.Context is AppDbContext db) db.DiscardTransactionEffects();
        return Task.CompletedTask;
    }

    public override Task TransactionFailedAsync(DbTransaction transaction, TransactionErrorEventData eventData, CancellationToken cancellationToken = default)
    {
        if (eventData.Context is AppDbContext db) db.DiscardTransactionEffects();
        return Task.CompletedTask;
    }
}
