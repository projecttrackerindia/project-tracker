using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Api.Common;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Infrastructure.Services;

namespace ProjectManagement.Api.Middleware;

/// <summary>
/// Makes a retried write safe. A client that sends <c>Idempotency-Key: &lt;unique value&gt;</c> with a POST, PUT, PATCH or DELETE gets the very same answer
/// if it sends the request again (a phone that lost its connection before the reply arrived), and the work is done once. The key belongs to the
/// signed-in person; reusing it for a different request is refused; a request still running answers 409; keys are forgotten after a day.
/// Only successful answers are kept, so a request that failed can simply be corrected and sent again. File uploads are not covered.
/// </summary>
public partial class IdempotencyMiddleware(RequestDelegate next)
{
    public const string Header = "Idempotency-Key";
    private const int MaxBody = 1_000_000, MaxKept = 256 * 1024;
    private static readonly TimeSpan Keep = TimeSpan.FromHours(24), Running = TimeSpan.FromSeconds(60);

    [GeneratedRegex("^[A-Za-z0-9_\\-:.]{8,100}$")] private static partial Regex Valid();

    public async Task InvokeAsync(HttpContext http, CurrentContext ctx, IAppDbContext db, TimeProvider clock)
    {
        var method = http.Request.Method;
        var write = HttpMethods.IsPost(method) || HttpMethods.IsPut(method) || HttpMethods.IsPatch(method) || HttpMethods.IsDelete(method);
        var key = http.Request.Headers[Header].ToString();
        if (!write || key.Length == 0 || ctx.UserId is not { } userId) { await next(http); return; }
        if (!Valid().IsMatch(key))
        {
            await ErrorWriter.WriteAsync(http, 400, "The Idempotency-Key must be 8 to 100 letters, digits or - _ : . characters.", [new ApiError("INVALID_IDEMPOTENCY_KEY", "The Idempotency-Key must be 8 to 100 letters, digits or - _ : . characters.")]);
            return;
        }
        if ((http.Request.ContentType ?? "").StartsWith("multipart/", StringComparison.OrdinalIgnoreCase) || http.Request.ContentLength > MaxBody) { await next(http); return; }

        // What was asked: the method, the address and the exact body.
        http.Request.EnableBuffering();
        using var buffer = new MemoryStream();
        await http.Request.Body.CopyToAsync(buffer, http.RequestAborted);
        http.Request.Body.Position = 0;
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{method} {http.Request.Path}{http.Request.QueryString}\n").Concat(buffer.ToArray()).ToArray()));

        var now = clock.GetUtcNow().UtcDateTime;
        var ct = http.RequestAborted;
        var existing = await db.IdempotencyRecords.FirstOrDefaultAsync(r => r.UserId == userId && r.Key == key, ct);
        if (existing is not null && existing.CreatedAt < now - Keep) { db.IdempotencyRecords.Remove(existing); await db.SaveChangesAsync(ct); existing = null; }
        if (existing is not null && !existing.Completed && existing.CreatedAt < now - Running) { db.IdempotencyRecords.Remove(existing); await db.SaveChangesAsync(ct); existing = null; }
        if (existing is not null)
        {
            if (existing.RequestHash != hash)
            {
                await ErrorWriter.WriteAsync(http, 422, "This Idempotency-Key was already used for a different request.", [new ApiError("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different request.")]);
                return;
            }
            if (!existing.Completed)
            {
                http.Response.Headers.RetryAfter = "2";
                await ErrorWriter.WriteAsync(http, 409, "The first request with this Idempotency-Key is still being processed.", [new ApiError("IDEMPOTENCY_IN_PROGRESS", "The first request with this Idempotency-Key is still being processed.")]);
                return;
            }
            http.Response.StatusCode = existing.ResponseStatus;
            http.Response.Headers["Idempotent-Replayed"] = "true";
            if (existing.ContentType is not null) http.Response.ContentType = existing.ContentType;
            if (existing.ResponseBody is not null) await http.Response.WriteAsync(existing.ResponseBody, ct);
            return;
        }

        var record = new IdempotencyRecord { UserId = userId, Key = key, RequestHash = hash, CreatedAt = now };
        db.IdempotencyRecords.Add(record);
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException)
        {   // someone else registered the same key a moment ago
            db.IdempotencyRecords.Entry(record).State = EntityState.Detached;
            http.Response.Headers.RetryAfter = "2";
            await ErrorWriter.WriteAsync(http, 409, "The first request with this Idempotency-Key is still being processed.", [new ApiError("IDEMPOTENCY_IN_PROGRESS", "The first request with this Idempotency-Key is still being processed.")]);
            return;
        }
        await db.IdempotencyRecords.Where(r => r.CreatedAt < now - Keep).ExecuteDeleteAsync(ct);   // old keys are forgotten as new ones arrive

        // Run the request, keeping a copy of the answer.
        var original = http.Response.Body;
        await using var capture = new MemoryStream();
        http.Response.Body = capture;
        try { await next(http); }
        catch
        {
            http.Response.Body = original;
            await Forget(db, record);
            throw;
        }
        http.Response.Body = original;
        capture.Position = 0;
        var status = http.Response.StatusCode;
        if (status is >= 200 and < 300 && capture.Length <= MaxKept)
        {
            record.Completed = true; record.ResponseStatus = status; record.ContentType = http.Response.ContentType;
            record.ResponseBody = capture.Length == 0 ? null : Encoding.UTF8.GetString(capture.ToArray());
            try { await db.SaveChangesAsync(CancellationToken.None); } catch (DbUpdateException) { /* the answer still goes out */ }
        }
        else await Forget(db, record);
        await capture.CopyToAsync(original, CancellationToken.None);
    }

    private static async Task Forget(IAppDbContext db, IdempotencyRecord record)
    {
        try { db.IdempotencyRecords.Remove(record); await db.SaveChangesAsync(CancellationToken.None); } catch { /* it expires on its own */ }
    }
}
