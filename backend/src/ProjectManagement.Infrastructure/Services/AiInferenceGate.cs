using Microsoft.Extensions.Options;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Infrastructure.Services;

/// <summary>One process-wide capacity limit shared by streamed and one-shot local inference.</summary>
public sealed class AiInferenceGate(IOptions<AiOptions> options) : IDisposable
{
    private readonly SemaphoreSlim slots = new(Math.Clamp(options.Value.Fallback.MaxConcurrentRequests, 1, 16));
    private int waiting;
    public int QueueDepth => Volatile.Read(ref waiting);
    public int MaxConcurrentRequests { get; } = Math.Clamp(options.Value.Fallback.MaxConcurrentRequests, 1, 16);
    public int ActiveRequests => MaxConcurrentRequests - slots.CurrentCount;
    public int MaxQueuedRequests => Math.Clamp(options.Value.Fallback.MaxQueuedRequests, 0, 64);
    public int QueueTimeoutSeconds => Math.Clamp(options.Value.Fallback.QueueTimeoutSeconds, 1, 60);

    public async Task<IDisposable> EnterAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (slots.Wait(0)) return new Lease(slots);
        if (Interlocked.Increment(ref waiting) > MaxQueuedRequests)
        {
            Interlocked.Decrement(ref waiting);
            throw new AppException(503, "AI_BUSY", "The local model is busy. Try again shortly.");
        }
        try
        {
            if (!await slots.WaitAsync(TimeSpan.FromSeconds(QueueTimeoutSeconds), ct))
                throw new AppException(503, "AI_QUEUE_TIMEOUT", "The local model did not become available within the waiting limit. Try again shortly.");
            return new Lease(slots);
        }
        finally { Interlocked.Decrement(ref waiting); }
    }
    public void Dispose() => slots.Dispose();
    private sealed class Lease(SemaphoreSlim slots) : IDisposable
    {
        private int released;
        public void Dispose() { if (Interlocked.Exchange(ref released, 1) == 0) slots.Release(); }
    }
}
