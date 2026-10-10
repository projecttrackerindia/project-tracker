namespace ProjectManagement.Application.Features.Ai;

public sealed record AiDatabaseTiming(int Commands, double DurationMs, int FailedCommands);

/// <summary>Request-local counters only. Never stores SQL, parameters, identities or business content.</summary>
public sealed class AiDatabaseTelemetry
{
    private readonly AsyncLocal<Measurement?> current = new();
    // Async iterator yield boundaries restore the caller's ExecutionContext. Keep the root on this DI request scope.
    private Measurement? root;
    public static AiDatabaseTiming Combine(AiDatabaseTiming timing, AiDatabaseTiming? other) => other is null ? timing
        : new(timing.Commands + other.Commands, timing.DurationMs + other.DurationMs, timing.FailedCommands + other.FailedCommands);
    public Measurement Begin()
    {
        var scope = new Measurement(this, current.Value ?? root);
        root ??= scope;
        current.Value = scope;
        return scope;
    }
    public void Record(TimeSpan duration, bool failed = false)
    {
        for (var scope = current.Value ?? root; scope is not null; scope = scope.Parent) scope.Record(duration, failed);
    }
    public sealed class Measurement(AiDatabaseTelemetry owner, Measurement? parent) : IDisposable
    {
        internal Measurement? Parent => parent;
        private int count, failed;
        private long ticks;
        private int disposed;
        internal void Record(TimeSpan duration, bool failure)
        {
            Interlocked.Increment(ref count);
            Interlocked.Add(ref ticks, duration.Ticks);
            if (failure) Interlocked.Increment(ref failed);
        }
        public AiDatabaseTiming Snapshot() => new(Volatile.Read(ref count), TimeSpan.FromTicks(Interlocked.Read(ref ticks)).TotalMilliseconds, Volatile.Read(ref failed));
        public void Dispose()
        {
            if (Interlocked.Exchange(ref disposed, 1) == 0)
            {
                owner.current.Value = parent;
                if (ReferenceEquals(owner.root, this)) owner.root = null;
            }
        }
    }
}
