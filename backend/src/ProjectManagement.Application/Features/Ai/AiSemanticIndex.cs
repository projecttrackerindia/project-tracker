using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>Turns text into meaning vectors. <c>query</c> is true for a search question, false for the text being indexed.</summary>
public interface IAiEmbedder
{
    bool Configured { get; }
    string Model { get; }
    Task<IReadOnlyList<float[]>> EmbedAsync(IReadOnlyList<string> texts, bool query, CancellationToken ct);
}

/// <summary>No embedding model: meaning-based search is off and search falls back to words alone.</summary>
public sealed class NoEmbedder : IAiEmbedder
{
    public bool Configured => false;
    public string Model => "";
    public Task<IReadOnlyList<float[]>> EmbedAsync(IReadOnlyList<string> texts, bool query, CancellationToken ct) => Task.FromResult<IReadOnlyList<float[]>>([]);
}

public sealed record AiSemanticHit(string SourceKind, Guid SourceId, Guid? ProjectId, string Title, string Text, double Score);

/// <summary>
/// Meaning-based search over pages, tasks, operational work and action items. A background pass embeds what changed (titles and text,
/// personal data masked first; confidential and restricted pages never leave the database for this). A search embeds the question and
/// compares it with the workspace's vectors held in memory, so a question costs one small call to the model plus arithmetic. The caller
/// checks every hit against the reader's own access; this class never decides who may see what.
/// </summary>
public class AiSemanticIndex(IAppDbContext db, ICurrentContext ctx, IAiEmbedder embedder, AppClock clock, ILogger<AiSemanticIndex> log)
{
    public const int MaxChunkChars = 1000, MaxParts = 6, MaxPerTenant = 20000, EmbedBatch = 32;

    public bool Enabled => embedder.Configured;

    // ------------------------------------------------------------------ indexing

    private sealed record Source(string Kind, Guid Id, Guid TenantId, Guid? ProjectId, string Title, string Text);

    /// <summary>
    /// Embeds up to <paramref name="budget"/> changed sources across all workspaces and drops the pieces of deleted or now-confidential ones.
    /// Returns how many sources were (re)indexed.
    /// </summary>
    public async Task<int> IndexPendingAsync(int budget = 200, CancellationToken ct = default)
    {
        if (!embedder.Configured) return 0;
        var share = Math.Max(10, budget / 4);
        var docs = await db.Documents.IgnoreQueryFilters().AsNoTracking()
            .Where(d => !d.IsDeleted && d.Classification <= DocumentClassification.Internal && d.SearchText != null
                && !db.AiSearchChunks.IgnoreQueryFilters().Any(c => c.SourceKind == "document" && c.SourceId == d.Id && c.IndexedAt >= (d.SearchIndexedAt ?? d.UpdatedAt ?? d.CreatedAt)))
            .OrderByDescending(d => d.UpdatedAt ?? d.CreatedAt).Take(share)
            .Select(d => new Source("document", d.Id, d.TenantId, d.ProjectId, d.Title, d.SearchText!)).ToListAsync(ct);
        var tasks = await db.Tasks.IgnoreQueryFilters().AsNoTracking()
            .Where(t => !t.IsDeleted && !db.AiSearchChunks.IgnoreQueryFilters().Any(c => c.SourceKind == "task" && c.SourceId == t.Id && c.IndexedAt >= (t.UpdatedAt ?? t.CreatedAt)))
            .OrderByDescending(t => t.UpdatedAt ?? t.CreatedAt).Take(share)
            .Select(t => new Source("task", t.Id, t.TenantId, t.ProjectId, t.Project!.Key + "-" + t.Number + " " + t.Title, t.Title + "\n" + (t.Description ?? ""))).ToListAsync(ct);
        var work = await db.WorkTasks.IgnoreQueryFilters().AsNoTracking()
            .Where(w => !w.IsDeleted && !db.AiSearchChunks.IgnoreQueryFilters().Any(c => (c.SourceKind == "work" || c.SourceKind == "actionitem") && c.SourceId == w.Id && c.IndexedAt >= (w.UpdatedAt ?? w.CreatedAt)))
            .OrderByDescending(w => w.UpdatedAt ?? w.CreatedAt).Take(share)
            .Select(w => new Source(w.Kind == WorkTaskKind.ActionItem ? "actionitem" : "work", w.Id, w.TenantId, w.RelatedProjectId, w.Title, w.Title + "\n" + (w.Description ?? ""))).ToListAsync(ct);
        var sources = docs.Concat(tasks).Concat(work).ToList();
        var removed = await DropStaleAsync(ct);
        if (sources.Count == 0) return 0;

        var masker = new PiiMasker();
        var ids = sources.Select(s => s.Id).ToList();
        var existing = await db.AiSearchChunks.IgnoreQueryFilters().Where(c => ids.Contains(c.SourceId)).ToListAsync(ct);
        var pending = new List<(Source Source, List<string> Parts, string Hash)>();
        foreach (var s in sources)
        {
            var parts = Split(s.Title, masker.MaskText(s.Text));
            var hash = Hash(embedder.Model + "\n" + s.Title + "\n" + string.Join("\n", parts));
            var mine = existing.Where(c => c.SourceId == s.Id).ToList();
            if (mine.Count > 0 && mine.All(c => c.ContentHash == hash)) { foreach (var c in mine) c.IndexedAt = clock.Now; continue; }   // nothing new to embed
            pending.Add((s, parts, hash));
        }
        var done = 0;
        for (var i = 0; i < pending.Count;)
        {
            // Fill one call with up to EmbedBatch pieces, whole sources only.
            var group = new List<(Source Source, List<string> Parts, string Hash)>(); var pieces = 0;
            while (i < pending.Count && (group.Count == 0 || pieces + pending[i].Parts.Count <= EmbedBatch)) { group.Add(pending[i]); pieces += pending[i].Parts.Count; i++; }
            IReadOnlyList<float[]> vectors;
            try { vectors = await embedder.EmbedAsync(group.SelectMany(g => g.Parts).ToList(), false, ct); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogWarning(ex, "Embedding failed; meaning-based search will catch up on the next pass");
                break;
            }
            if (vectors.Count != pieces) { log.LogWarning("The embedding model returned {Got} vectors for {Asked} pieces", vectors.Count, pieces); break; }
            var v = 0;
            foreach (var (s, parts, hash) in group)
            {
                db.AiSearchChunks.RemoveRange(existing.Where(c => c.SourceId == s.Id));
                for (var p = 0; p < parts.Count; p++, v++)
                {
                    var (bytes, scale) = Quantize(vectors[v]);
                    db.AiSearchChunks.Add(new AiSearchChunk
                    {
                        TenantId = s.TenantId, SourceKind = s.Kind, SourceId = s.Id, ProjectId = s.ProjectId, Part = p, Title = Clip(s.Title, 200), Text = parts[p],
                        Vector = bytes, Scale = scale, Model = Clip(embedder.Model, 64), ContentHash = hash, IndexedAt = clock.Now, CreatedAt = clock.Now,
                    });
                }
                done++;
            }
        }
        await db.SaveChangesAsync(ct);
        if (done > 0 || removed > 0) Invalidate();
        return done;
    }

    /// <summary>Pieces of work that was deleted, and of pages now confidential, restricted or deleted.</summary>
    private async Task<int> DropStaleAsync(CancellationToken ct)
    {
        var stale = await db.AiSearchChunks.IgnoreQueryFilters()
            .Where(c => (c.SourceKind == "document" && !db.Documents.IgnoreQueryFilters().Any(d => d.Id == c.SourceId && !d.IsDeleted && d.Classification <= DocumentClassification.Internal))
                || (c.SourceKind == "task" && !db.Tasks.IgnoreQueryFilters().Any(t => t.Id == c.SourceId && !t.IsDeleted))
                || ((c.SourceKind == "work" || c.SourceKind == "actionitem") && !db.WorkTasks.IgnoreQueryFilters().Any(w => w.Id == c.SourceId && !w.IsDeleted)))
            .Take(500).ToListAsync(ct);
        if (stale.Count == 0) return 0;
        db.AiSearchChunks.RemoveRange(stale);
        await db.SaveChangesAsync(ct);
        return stale.Count;
    }

    /// <summary>The title first, then the text in pieces of about a thousand characters, cut at paragraph or sentence ends.</summary>
    public static List<string> Split(string title, string text)
    {
        var body = (text ?? "").Replace("\r", "").Trim();
        var parts = new List<string>();
        var sb = new StringBuilder();
        foreach (var para in body.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var p = para;
            while (p.Length > MaxChunkChars)
            {
                var cut = p.LastIndexOf(". ", MaxChunkChars, StringComparison.Ordinal);
                if (cut < MaxChunkChars / 2) cut = MaxChunkChars - 1;
                Flush(); parts.Add(p[..(cut + 1)].Trim()); p = p[(cut + 1)..].Trim();
            }
            if (sb.Length + p.Length + 1 > MaxChunkChars) Flush();
            sb.Append(p).Append('\n');
        }
        Flush();
        if (parts.Count == 0) parts.Add("");
        return parts.Take(MaxParts).Select(x => Clip($"{title}\n{x}".Trim(), MaxChunkChars + 220)).ToList();

        void Flush() { if (sb.Length > 0) { parts.Add(sb.ToString().Trim()); sb.Clear(); } }
    }

    // ------------------------------------------------------------------ searching

    private sealed record Entry(Guid Id, string SourceKind, Guid SourceId, Guid? ProjectId, sbyte[] Vector, float Scale);
    private sealed record Snapshot(string Stamp, DateTime LoadedAt, Entry[] Entries);
    private static readonly ConcurrentDictionary<Guid, Snapshot> Cache = new();
    private static long _generation;
    private static void Invalidate() => Interlocked.Increment(ref _generation);

    /// <summary>The best matches for a question in the signed-in person's workspace, by meaning. Not yet checked against access.</summary>
    public async Task<IReadOnlyList<AiSemanticHit>> SearchAsync(string query, int take = 30, CancellationToken ct = default)
    {
        if (!embedder.Configured || string.IsNullOrWhiteSpace(query)) return [];
        var tenant = ctx.RequireTenantId();
        var snapshot = await SnapshotAsync(tenant, ct);
        if (snapshot.Entries.Length == 0) return [];
        float[] q;
        try { q = (await embedder.EmbedAsync([query.Trim()], true, ct)).FirstOrDefault() ?? []; }
        catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "Embedding the question failed; searching by words only"); return []; }
        if (q.Length == 0) return [];
        Normalize(q);
        var scored = new List<(Entry E, double Score)>(snapshot.Entries.Length);
        foreach (var e in snapshot.Entries)
        {
            if (e.Vector.Length != q.Length) continue;
            double dot = 0;
            for (var i = 0; i < q.Length; i++) dot += q[i] * e.Vector[i];
            scored.Add((e, dot * e.Scale));
        }
        // Best piece per source; a weak match is no match.
        var best = scored.Where(x => x.Score >= 0.45).GroupBy(x => x.E.SourceId).Select(g => g.MaxBy(x => x.Score)).OrderByDescending(x => x.Score).Take(take).ToList();
        if (best.Count == 0) return [];
        var ids = best.Select(b => b.E.Id).ToList();
        var texts = await db.AiSearchChunks.IgnoreQueryFilters().AsNoTracking().Where(c => c.TenantId == tenant && ids.Contains(c.Id)).Select(c => new { c.Id, c.Title, c.Text }).ToDictionaryAsync(c => c.Id, ct);
        return best.Where(b => texts.ContainsKey(b.E.Id)).Select(b => new AiSemanticHit(b.E.SourceKind, b.E.SourceId, b.E.ProjectId, texts[b.E.Id].Title, texts[b.E.Id].Text, Math.Round(b.Score, 3))).ToList();
    }

    private async Task<Snapshot> SnapshotAsync(Guid tenant, CancellationToken ct)
    {
        var stats = await db.AiSearchChunks.IgnoreQueryFilters().AsNoTracking().Where(c => c.TenantId == tenant)
            .GroupBy(c => c.TenantId).Select(g => new { Count = g.Count(), Last = g.Max(c => c.IndexedAt) }).FirstOrDefaultAsync(ct);
        var stamp = $"{stats?.Count ?? 0}:{stats?.Last.Ticks ?? 0}:{Interlocked.Read(ref _generation)}";
        if (Cache.TryGetValue(tenant, out var cached) && cached.Stamp == stamp && cached.LoadedAt > clock.Now.AddMinutes(-30)) return cached;
        var rows = await db.AiSearchChunks.IgnoreQueryFilters().AsNoTracking().Where(c => c.TenantId == tenant && c.Model == embedder.Model)
            .OrderByDescending(c => c.IndexedAt).Take(MaxPerTenant).Select(c => new { c.Id, c.SourceKind, c.SourceId, c.ProjectId, c.Vector, c.Scale }).ToListAsync(ct);
        var snapshot = new Snapshot(stamp, clock.Now, rows.Select(r => new Entry(r.Id, r.SourceKind, r.SourceId, r.ProjectId, (sbyte[])(Array)r.Vector, r.Scale)).ToArray());
        if (Cache.Count > 500) foreach (var old in Cache.OrderBy(x => x.Value.LoadedAt).Take(100).Select(x => x.Key).ToList()) Cache.TryRemove(old, out _);
        Cache[tenant] = snapshot;
        return snapshot;
    }

    // ------------------------------------------------------------------ vectors

    /// <summary>Unit length, then one signed byte per dimension with the scale that brings it back (dot products stay within about 1%).</summary>
    public static (byte[] Bytes, float Scale) Quantize(float[] v)
    {
        var copy = (float[])v.Clone();
        Normalize(copy);
        var max = copy.Length == 0 ? 0 : copy.Max(x => Math.Abs(x));
        if (max == 0) return (new byte[copy.Length], 0);
        var bytes = new byte[copy.Length];
        for (var i = 0; i < copy.Length; i++) bytes[i] = unchecked((byte)(sbyte)Math.Round(copy[i] / max * 127));
        return (bytes, max / 127f);
    }

    public static void Normalize(float[] v)
    {
        double sum = 0;
        foreach (var x in v) sum += x * x;
        var n = Math.Sqrt(sum);
        if (n == 0) return;
        for (var i = 0; i < v.Length; i++) v[i] = (float)(v[i] / n);
    }

    private static string Hash(string s) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s)))[..32];
    private static string Clip(string s, int max) => s.Length <= max ? s : s[..(max - 1)] + "…";
}
