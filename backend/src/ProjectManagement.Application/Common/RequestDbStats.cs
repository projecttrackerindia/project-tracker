namespace ProjectManagement.Application.Common;

/// <summary>
/// How many database commands one request ran and how long they took together, so a slow save can be told apart: many small round trips,
/// one heavy query, or no database time at all. Counted by the database interceptor, read by the request timing (Server-Timing), and never
/// holds SQL or data.
/// </summary>
public sealed class RequestDbStats
{
    private static readonly AsyncLocal<RequestDbStats?> Current = new();
    private int count;
    private long ticks;

    /// <summary>Starts counting for the request that is running now.</summary>
    public static RequestDbStats Begin() { var s = new RequestDbStats(); Current.Value = s; return s; }

    /// <summary>Called for every command that finished; does nothing outside a request that began counting.</summary>
    public static void Add(TimeSpan duration)
    {
        if (Current.Value is not { } s) return;
        Interlocked.Increment(ref s.count);
        Interlocked.Add(ref s.ticks, duration.Ticks);
    }

    public int Queries => Volatile.Read(ref count);
    public double Milliseconds => TimeSpan.FromTicks(Interlocked.Read(ref ticks)).TotalMilliseconds;
}
