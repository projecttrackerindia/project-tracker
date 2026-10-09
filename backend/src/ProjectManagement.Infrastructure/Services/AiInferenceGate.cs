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

    public async Task<IDisposable> EnterAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (slots.Wait(0)) return new Lease(slots);
        if (Interlocked.Increment(ref waiting) > Math.Clamp(options.Value.Fallback.MaxQueuedRequests, 0, 64))
        {
            Interlocked.Decrement(ref waiting);
            throw new AppException(503, "AI_BUSY", "The local model is busy. Try again shortly.");
        }
        try
        {
            if (!await slots.WaitAsync(TimeSpan.FromSeconds(Math.Clamp(options.Value.Fallback.QueueTimeoutSeconds, 1, 60)), ct))
                throw new AppException(503, "AI_BUSY", "The local model's queue is full. Try again shortly.");
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
