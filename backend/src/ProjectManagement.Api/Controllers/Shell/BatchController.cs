using System.Text;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Api.Batch;
using ProjectManagement.Api.Filters;

namespace ProjectManagement.Api.Controllers.Shell;

/// <param name="Path">The path asked for, echoed so the caller can match answers to questions without relying on order.</param>
/// <param name="Status">What that read answered, exactly as a direct call would have.</param>
/// <param name="Body">The answer's body, or null when it had none.</param>
public record BatchAnswer(string Path, int Status, object? Body);

/// <summary>
/// Several reads in one round trip. Every screen starts by asking the same two dozen questions - which features are on, what the badges
/// say, who is on call - and on a phone each one costs its own connection and its own wait. This answers them together.
///
/// It is not a way around anything. Each read is run through the app's own pipeline from routing onwards, so it reaches the same
/// controller with the same authorization filters it would have on its own: a person who may not read something is refused here exactly
/// as they would be directly, and the answer says so. What the batch does save is the repetition - one sign-in check, one tenant
/// resolution, one database context for the lot.
///
/// Reads only, and only this API's own paths. A write has side effects and an order that matters, and belongs in a request of its own
/// where its idempotency and rate limits apply.
/// </summary>
[Route("api/v1/batch"), RequireWorkspace]
public class BatchController(BatchPipeline pipeline, ILogger<BatchController> log) : ApiControllerBase
{
    /// <summary>At most this many reads in one batch: enough for a screen's worth, few enough that one request cannot become a flood.</summary>
    public const int MaxReads = 25;
    private const int MaxBodyBytes = 2_000_000;

    /// <param name="read">The read paths to answer, in order, each as it would be called on its own ("/api/v1/dashboard").</param>
    [HttpGet]
    public async Task<IActionResult> Get([FromQuery] string[]? read, CancellationToken ct)
    {
        var reads = (IReadOnlyList<string>)(read ?? []);
        if (reads.Count == 0) return Ok(Array.Empty<BatchAnswer>());
        if (reads.Count > MaxReads) throw new ValidationException("reads", $"A batch may ask for at most {MaxReads} reads at once.");
        if (!pipeline.Ready) throw new AppException(503, "BATCH_UNAVAILABLE", "Batched reads are not available on this server.");

        var answers = new List<BatchAnswer>(reads.Count);
        foreach (var raw in reads)
        {
            ct.ThrowIfCancellationRequested();
            answers.Add(await OneAsync(raw, ct));
        }
        return Ok(answers);
    }

    private async Task<BatchAnswer> OneAsync(string raw, CancellationToken ct)
    {
        var path = (raw ?? "").Trim();
        // Only this API's own reads, and never a batch inside a batch: nesting would let one request fan out without limit.
        if (!path.StartsWith("/api/v1/", StringComparison.Ordinal) || path.StartsWith("/api/v1/batch", StringComparison.OrdinalIgnoreCase)
            || path.Contains("..", StringComparison.Ordinal))
            return new BatchAnswer(path, 400, new { error = new { code = "BATCH_PATH_NOT_ALLOWED", message = "Only this API's own reads can be batched." } });

        var split = path.IndexOf('?');
        var onlyPath = split < 0 ? path : path[..split];
        var query = split < 0 ? "" : path[split..];

        var outer = HttpContext;
        var body = new MemoryStream();
        var inner = new DefaultHttpContext
        {
            // The same request services, so the batch shares one database context and one resolved tenant with every read in it, and the
            // same person, so each read decides for whoever is signed in rather than for nobody.
            RequestServices = outer.RequestServices,
            User = outer.User,
        };
        inner.Request.Method = HttpMethods.Get;
        inner.Request.Scheme = outer.Request.Scheme;
        inner.Request.Host = outer.Request.Host;
        inner.Request.Path = onlyPath;
        inner.Request.QueryString = new QueryString(query);
        foreach (var h in outer.Request.Headers) inner.Request.Headers[h.Key] = h.Value;
        inner.Request.Headers.Remove("Content-Length");
        inner.Request.Headers.Remove("Content-Type");
        inner.Response.Body = body;
        inner.RequestAborted = ct;
        inner.Features.Set<IHttpResponseFeature>(new HttpResponseFeature { Body = body });

        try { await pipeline.Handler(inner); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // One read failing is that read's answer, not the batch's: the others are still worth having.
            log.LogWarning(ex, "A batched read failed: {Path}", onlyPath);
            return new BatchAnswer(path, 500, new { error = new { code = "BATCH_READ_FAILED", message = "This read could not be answered." } });
        }

        if (body.Length > MaxBodyBytes)
            return new BatchAnswer(path, 413, new { error = new { code = "BATCH_ANSWER_TOO_LARGE", message = "This answer is too large to batch; ask for it on its own." } });
        body.Position = 0;
        var text = Encoding.UTF8.GetString(body.ToArray());
        object? parsed = null;
        if (text.Length > 0)
        {
            try { parsed = System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>(text); }
            catch (System.Text.Json.JsonException) { parsed = null; }   // not JSON: the status alone is the answer
        }
        return new BatchAnswer(path, inner.Response.StatusCode, parsed);
    }
}
