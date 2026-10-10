using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Storage;

namespace ProjectManagement.Application.Common;

/// <summary>Services join a request transaction when present; otherwise they own and commit their own transaction.</summary>
public static class DatabaseTransactions
{
    public static async Task<IDbContextTransaction?> BeginOwnedTransactionAsync(this DatabaseFacade database, CancellationToken ct = default) =>
        database.CurrentTransaction is null ? await database.BeginTransactionAsync(ct) : null;

    public static Task CommitIfOwnedAsync(this IDbContextTransaction? transaction, CancellationToken ct = default) =>
        transaction?.CommitAsync(ct) ?? Task.CompletedTask;
}
