using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Npgsql;
using ProjectManagement.Api.Common;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Api.Middleware;

/// <summary>
/// Commits database writes and their retry receipt together. The unique user/key index owns a request for the entire transaction,
/// even when execution takes longer than a minute. A crash rolls both back; a completed receipt prevents the write being repeated.
/// External side effects need their own provider idempotency or outbox. Uploads and streams are not supported.
/// </summary>
public partial class IdempotencyMiddleware(RequestDelegate next)
{
    public const string Header = "Idempotency-Key";
    private const int MaxBody = 1_000_000, MaxKept = 256 * 1024;
    private static readonly TimeSpan Keep = TimeSpan.FromHours(24);

    [GeneratedRegex("^[A-Za-z0-9_\\-:.]{8,100}$")] private static partial Regex Valid();

    public async Task InvokeAsync(HttpContext http, CurrentContext ctx, IAppDbContext db, TimeProvider clock)
    {
        var method = http.Request.Method;
        var write = HttpMethods.IsPost(method) || HttpMethods.IsPut(method) || HttpMethods.IsPatch(method) || HttpMethods.IsDelete(method);
        var key = http.Request.Headers[Header].ToString();
        if (!write || key.Length == 0 || ctx.UserId is not { } userId) { await next(http); return; }
        if (!Valid().IsMatch(key))
        {
            await ErrorWriter.WriteAsync(http, 400, "The Idempotency-Key must be 8 to 100 letters, digits or - _ : . characters.",
                [new ApiError("INVALID_IDEMPOTENCY_KEY", "The Idempotency-Key must be 8 to 100 letters, digits or - _ : . characters.")]);
            return;
        }
        if ((http.Request.ContentType ?? "").StartsWith("multipart/", StringComparison.OrdinalIgnoreCase)
            || http.Request.Headers.Accept.Any(a => a?.Contains("text/event-stream", StringComparison.OrdinalIgnoreCase) == true))
        {
            await ErrorWriter.WriteAsync(http, 422, "Idempotency-Key is not supported for uploads or streams.",
                [new ApiError("IDEMPOTENCY_UNSUPPORTED", "Idempotency-Key is not supported for uploads or streams.")]);
            return;
        }

        // Bound chunked bodies too: Content-Length alone cannot enforce the limit.
        http.Request.EnableBuffering();
        using var buffer = new MemoryStream();
        var bytes = new byte[8192];
        int read;
        while ((read = await http.Request.Body.ReadAsync(bytes.AsMemory(0, (int)Math.Min(bytes.Length, MaxBody + 1 - buffer.Length)), http.RequestAborted)) > 0)
        {
            buffer.Write(bytes, 0, read);
            if (buffer.Length > MaxBody)
            {
                await ErrorWriter.WriteAsync(http, 413, "An idempotent request must be at most 1 MB.",
                    [new ApiError("IDEMPOTENCY_BODY_TOO_LARGE", "An idempotent request must be at most 1 MB.")]);
                return;
            }
        }
        http.Request.Body.Position = 0;
        // The same address in another workspace or team lens is a different request.
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            $"{ctx.TenantId} {ctx.TeamLens} {method} {http.Request.Path}{http.Request.QueryString}\n").Concat(buffer.ToArray()).ToArray()));

        var now = clock.GetUtcNow().UtcDateTime;
        var ct = http.RequestAborted;
        // Never expire unfinished legacy receipts: a previous version may have committed their business changes already.
        var existing = await db.IdempotencyRecords.AsNoTracking().FirstOrDefaultAsync(r => r.UserId == userId && r.Key == key, ct);
        if (existing is { Completed: true } && existing.CreatedAt < now - Keep)
        {
            await db.IdempotencyRecords.Where(r => r.Id == existing.Id && r.Completed && r.CreatedAt < now - Keep).ExecuteDeleteAsync(ct);
            existing = await db.IdempotencyRecords.AsNoTracking().FirstOrDefaultAsync(r => r.UserId == userId && r.Key == key, ct);
        }
        if (existing is not null) { await Replay(http, existing, hash); return; }

        await using var transaction = await BeginTransaction(db, ct);
        if (transaction is null) { await InProgress(http); return; }
        // Contention should answer 409 promptly rather than occupy a connection for the duration of a long write.
        if (db.Database.IsNpgsql()) await db.Database.ExecuteSqlRawAsync("SET LOCAL lock_timeout = '2s'", ct);
        var record = new IdempotencyRecord { UserId = userId, Key = key, RequestHash = hash, CreatedAt = now };
        db.IdempotencyRecords.Add(record);
        try { await db.SaveChangesAsync(ct); }
        catch (Exception ex) when (IsKeyContention(ex))
        {
            await transaction.RollbackAsync(CancellationToken.None);
            db.IdempotencyRecords.Entry(record).State = EntityState.Detached;
            await InProgress(http);
            return;
        }
        if (db.Database.IsNpgsql()) await db.Database.ExecuteSqlRawAsync("SET LOCAL lock_timeout = '0'", ct);

        // Do not send success until its receipt and the business changes have committed.
        var original = http.Response.Body;
        await using var capture = new MemoryStream();
        http.Response.Body = capture;
        try
        {
            await next(http);
            if (http.Response.StatusCode is >= 200 and < 300)
            {
                record.Completed = true;
                // Large responses still retain a receipt: never silently let the operation run again.
                record.ResponseStatus = capture.Length <= MaxKept ? http.Response.StatusCode : 0;
                record.ContentType = http.Response.ContentType;
                record.ResponseBody = capture.Length <= MaxKept ? "base64:" + Convert.ToBase64String(capture.ToArray()) : null;
                await db.SaveChangesAsync(CancellationToken.None);
                await transaction.CommitAsync(CancellationToken.None);
            }
            else await transaction.RollbackAsync(CancellationToken.None);
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
        finally { http.Response.Body = original; }
        capture.Position = 0;
        await capture.CopyToAsync(original, CancellationToken.None);
    }

    private static async Task<IDbContextTransaction?> BeginTransaction(IAppDbContext db, CancellationToken ct)
    {
        var sqlite = db.Database.GetDbConnection() as SqliteConnection;
        var previousTimeout = sqlite?.DefaultTimeout;
        try
        {
            // SQLite takes its writer lock when the transaction begins, rather than at the unique-key insert.
            if (sqlite is not null) sqlite.DefaultTimeout = 2;
            return await db.Database.BeginTransactionAsync(ct);
        }
        catch (SqliteException ex) when (ex.SqliteErrorCode is 5 or 6) { return null; }
        finally { if (sqlite is not null) sqlite.DefaultTimeout = previousTimeout!.Value; }
    }

    private static bool IsKeyContention(Exception exception)
    {
        // Npgsql's execution strategy wraps transient lock failures in InvalidOperationException, outside DbUpdateException.
        for (Exception? error = exception; error is not null; error = error.InnerException)
        {
            if (error is PostgresException { SqlState: PostgresErrorCodes.LockNotAvailable }
                or PostgresException { SqlState: PostgresErrorCodes.UniqueViolation, ConstraintName: "IX_IdempotencyRecords_UserId_Key" }
                or SqliteException { SqliteErrorCode: 5 or 6 }) return true;
            if (error is SqliteException { SqliteExtendedErrorCode: 2067 } sqlite
                && sqlite.Message.Contains("IdempotencyRecords.UserId", StringComparison.Ordinal)) return true;
        }
        return false;
    }

    private static Task InProgress(HttpContext http)
    {
        http.Response.Headers.RetryAfter = "2";
        return ErrorWriter.WriteAsync(http, 409, "The first request with this Idempotency-Key is still being processed.",
            [new ApiError("IDEMPOTENCY_IN_PROGRESS", "The first request with this Idempotency-Key is still being processed.")]);
    }

    private static async Task Replay(HttpContext http, IdempotencyRecord existing, string hash)
    {
        if (existing.RequestHash != hash)
        {
            await ErrorWriter.WriteAsync(http, 422, "This Idempotency-Key was already used for a different request.",
                [new ApiError("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different request.")]);
            return;
        }
        if (!existing.Completed) { await InProgress(http); return; }
        if (existing.ResponseStatus == 0)
        {
            await ErrorWriter.WriteAsync(http, 409, "The write completed, but its response was too large to replay. Read the resource to check its result.",
                [new ApiError("IDEMPOTENCY_RESPONSE_UNAVAILABLE", "The write completed. Read the resource to check its result; do not repeat it with a new key.")]);
            return;
        }
        http.Response.StatusCode = existing.ResponseStatus;
        http.Response.Headers["Idempotent-Replayed"] = "true";
        if (existing.ContentType is not null) http.Response.ContentType = existing.ContentType;
        if (existing.ResponseBody is { } body)
        {
            if (body.StartsWith("base64:", StringComparison.Ordinal))
                await http.Response.Body.WriteAsync(Convert.FromBase64String(body[7..]), http.RequestAborted);
            else await http.Response.WriteAsync(body, http.RequestAborted); // receipts from before this change
        }
    }
}
