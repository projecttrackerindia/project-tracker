using System.Data.Common;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;

namespace ProjectManagement.Infrastructure.Persistence;

/// <summary>
/// Where reads that may lag a moment go (ConnectionStrings:ReadOnly). Unset: nowhere special - <see cref="ReadReplicaDb"/> hands out the
/// request's own primary context. Mutable so a test can point it at a guarded copy of the primary and back.
/// </summary>
public sealed class ReadReplicaSettings(string provider, string? connectionString)
{
    private readonly object gate = new();
    private string? connection = string.IsNullOrWhiteSpace(connectionString) ? null : connectionString;
    private DbContextOptions<AppDbContext>? options;

    public bool Sqlite { get; } = provider.Equals("Sqlite", StringComparison.OrdinalIgnoreCase);
    public bool Enabled => connection is not null;

    public string? ConnectionString
    {
        get => connection;
        set { lock (gate) { connection = string.IsNullOrWhiteSpace(value) ? null : value; options = null; } }
    }

    /// <summary>A new read-only context on the replica: nothing tracked, every save and every write statement refused.</summary>
    public AppDbContext Create(ICurrentContext current, TimeProvider clock)
    {
        DbContextOptions<AppDbContext> built;
        lock (gate)
        {
            var cs = connection ?? throw new InvalidOperationException("No read replica is configured.");
            if (options is null)
            {
                var b = new DbContextOptionsBuilder<AppDbContext>();
                if (Sqlite) b.UseSqlite(cs); else b.UseNpgsql(cs);
                b.UseQueryTrackingBehavior(QueryTrackingBehavior.NoTracking);
                b.AddInterceptors(ReadOnlySaveGuard.Instance, ReadOnlyCommandGuard.Instance);
                options = b.Options;
            }
            built = options;
        }
        // No change feed, no entitlement cache, no notification feed: a replica context never saves, so it never has anything to announce.
        return new AppDbContext(built, current, clock);
    }
}

/// <summary>The request's read database: the replica when configured, else the primary (the same instance the request writes through).</summary>
public sealed class ReadReplicaDb(IServiceProvider services, ReadReplicaSettings settings) : IReadDb, IAsyncDisposable, IDisposable
{
    private AppDbContext? replica;
    private IAppDbContext? primary;
    private readonly bool enabled = settings.Enabled;

    public bool IsReplica => enabled;

    public IAppDbContext Db => enabled
        ? replica ??= settings.Create(services.GetRequiredService<ICurrentContext>(), services.GetRequiredService<TimeProvider>())
        : primary ??= services.GetRequiredService<IAppDbContext>();

    public void Dispose() => replica?.Dispose();
    public ValueTask DisposeAsync() => replica?.DisposeAsync() ?? ValueTask.CompletedTask;
}

/// <summary>Thrown when something tries to write through the read replica (always a bug: writes belong on the primary).</summary>
public sealed class ReadReplicaWriteException(string what) : InvalidOperationException($"The read replica is read-only: {what} must go to the primary database.");

public sealed class ReadOnlySaveGuard : SaveChangesInterceptor
{
    public static readonly ReadOnlySaveGuard Instance = new();
    public override InterceptionResult<int> SavingChanges(DbContextEventData eventData, InterceptionResult<int> result) => throw new ReadReplicaWriteException("SaveChanges");
    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default) =>
        throw new ReadReplicaWriteException("SaveChanges");
}

/// <summary>Refuses write statements (ExecuteUpdate / ExecuteDelete / raw SQL) on the replica connection.</summary>
public sealed class ReadOnlyCommandGuard : DbCommandInterceptor
{
    public static readonly ReadOnlyCommandGuard Instance = new();
    private static readonly string[] Writes = ["INSERT", "UPDATE", "DELETE", "MERGE", "CREATE", "ALTER", "DROP", "TRUNCATE", "GRANT", "REVOKE"];

    public static bool IsWrite(string? sql)
    {
        if (string.IsNullOrWhiteSpace(sql)) return false;
        var text = sql.AsSpan().TrimStart();
        // Skip leading comments (EF tags queries with "-- ..." lines).
        while (text.StartsWith("--"))
        {
            var nl = text.IndexOf('\n');
            if (nl < 0) return false;
            text = text[(nl + 1)..].TrimStart();
        }
        foreach (var w in Writes)
            if (text.Length >= w.Length && text[..w.Length].Equals(w, StringComparison.OrdinalIgnoreCase) && (text.Length == w.Length || !char.IsLetter(text[w.Length])))
                return true;
        return false;
    }

    private static void Check(DbCommand command) { if (IsWrite(command.CommandText)) throw new ReadReplicaWriteException("a write statement"); }

    public override InterceptionResult<DbDataReader> ReaderExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result) { Check(command); return result; }
    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default) { Check(command); return ValueTask.FromResult(result); }
    public override InterceptionResult<int> NonQueryExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<int> result) { Check(command); return result; }
    public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command, CommandEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default) { Check(command); return ValueTask.FromResult(result); }
    public override InterceptionResult<object> ScalarExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<object> result) { Check(command); return result; }
    public override ValueTask<InterceptionResult<object>> ScalarExecutingAsync(DbCommand command, CommandEventData eventData, InterceptionResult<object> result, CancellationToken cancellationToken = default) { Check(command); return ValueTask.FromResult(result); }
}
