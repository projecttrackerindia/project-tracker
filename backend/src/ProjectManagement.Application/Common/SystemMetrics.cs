using System.Collections.Concurrent;

namespace ProjectManagement.Application.Common;

/// <summary>Counters since the server started, for the platform health page. Kept in memory: they reset on restart by design.</summary>
public class SystemMetrics
{
    private long _requests, _serverErrors, _clientErrors;
    private long _lastServerErrorTicks;

    public DateTime StartedAt { get; } = DateTime.UtcNow;
    public long Requests => Interlocked.Read(ref _requests);
    public long ServerErrors => Interlocked.Read(ref _serverErrors);
    public long ClientErrors => Interlocked.Read(ref _clientErrors);
    public DateTime? LastServerErrorAt => Interlocked.Read(ref _lastServerErrorTicks) is > 0 and var t ? new DateTime(t, DateTimeKind.Utc) : null;

    public void Record(int status)
    {
        Interlocked.Increment(ref _requests);
        if (status >= 500) { Interlocked.Increment(ref _serverErrors); Interlocked.Exchange(ref _lastServerErrorTicks, DateTime.UtcNow.Ticks); }
        else if (status is >= 400 and not 401 and not 404) Interlocked.Increment(ref _clientErrors);
    }
}

public record WorkerBeat(string Name, DateTime LastRunAt, int IntervalSeconds, string? LastError);

/// <summary>Each background worker reports here after every round, so the health page can tell a stopped worker from a quiet one.</summary>
public class WorkerHeartbeats
{
    private readonly ConcurrentDictionary<string, WorkerBeat> _beats = new();

    public void Beat(string name, int intervalSeconds, string? error = null) =>
        _beats[name] = new WorkerBeat(name, DateTime.UtcNow, intervalSeconds, error);

    public IReadOnlyList<WorkerBeat> All => _beats.Values.OrderBy(b => b.Name).ToList();
}
