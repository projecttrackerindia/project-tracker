using System.Text;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Support;

/// <summary>A DocTracker page the AI employee may answer from, cut down to the passages that match the customer's question.</summary>
public record KnowledgePage(string Ref, Guid DocumentId, string Key, string Title, string Text);
/// <summary>One of the customer's own tickets, as the AI employee may describe it to them.</summary>
public record CustomerTicket(string Key, string Title, string Status, string? With, DateTime UpdatedAt, DateOnly? Due);

/// <summary>
/// What the WhatsApp AI employee may ground an answer in. Pages: only DocTracker pages that are approved or published and classified Public
/// (internal, confidential and restricted pages are never read), optionally only one project's space, with personal data masked by the
/// built-in rules whatever the workspace's own masking setting, and only the passages that share words with what the customer asked.
/// Tickets: only the ones raised from this customer's own WhatsApp number.
/// </summary>
public class SupportKnowledge(IAppDbContext db, AppClock clock, DocumentMaskingService masking)
{
    public const int MaxPages = 3, MaxCharsPerPage = 2200, MaxTerms = 8;

    private static readonly HashSet<string> Stop = new(StringComparer.OrdinalIgnoreCase)
    {
        "the", "and", "for", "you", "your", "are", "was", "with", "this", "that", "have", "has", "can", "how", "what", "when", "where", "why", "who",
        "will", "would", "could", "should", "please", "pls", "plz", "hello", "hai", "hi", "thanks", "thank", "sir", "madam", "ok", "okay", "yes", "not",
        "any", "about", "from", "there", "they", "them", "our", "out", "get", "got", "want", "need", "know", "tell", "me", "my", "is", "it", "do", "does",
        "did", "i", "a", "an", "to", "of", "in", "on", "at", "be", "or", "if", "so", "we", "us", "am", "kya", "hai", "hain", "ka", "ki", "ke", "ko",
        "mera", "meri", "mujhe", "aap", "nahi", "naa", "ela", "enti", "ledu", "undi", "cheppandi", "kavali",
    };
    private static readonly Regex Word = new(@"[\p{L}\p{N}]{3,}", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));

    /// <summary>The words worth searching for in what the customer wrote (most recent first, no small talk).</summary>
    public static IReadOnlyList<string> Terms(IEnumerable<string> customerMessages)
    {
        var terms = new List<string>();
        try
        {
            foreach (var m in customerMessages)
                foreach (Match w in Word.Matches(m))
                {
                    var t = w.Value.ToLowerInvariant();
                    if (Stop.Contains(t) || terms.Contains(t) || t.All(char.IsDigit)) continue;
                    terms.Add(t);
                    if (terms.Count == MaxTerms) return terms;
                }
        }
        catch (RegexMatchTimeoutException) { }
        return terms;
    }

    /// <summary>The best few pages for these words: the ones matching the most words, with the passages around the matches.</summary>
    public async Task<IReadOnlyList<KnowledgePage>> PagesAsync(IReadOnlyList<string> terms, Guid? projectId, CancellationToken ct)
    {
        if (terms.Count == 0) return [];
        var allowed = db.Documents.AsNoTracking().Where(d => !d.IsDeleted && d.Classification == DocumentClassification.Public && d.PublishedVersionId != null
            && (d.Status == DocumentStatus.Approved || d.Status == DocumentStatus.Published) && (projectId == null || d.ProjectId == projectId));
        var hits = new Dictionary<Guid, int>();
        foreach (var term in terms)
        {
            var pattern = "%" + term.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";
            foreach (var id in await allowed.Where(d => EF.Functions.Like(d.SearchText!, pattern, "\\")).OrderByDescending(d => d.UpdatedAt).Select(d => d.Id).Take(50).ToListAsync(ct))
                hits[id] = hits.GetValueOrDefault(id) + 1;
        }
        // A page has to match at least two of the words (or the only word asked about) to be worth reading.
        var need = Math.Min(2, terms.Count);
        var best = hits.Where(h => h.Value >= need).OrderByDescending(h => h.Value).Take(MaxPages).Select(h => h.Key).ToList();
        if (best.Count == 0) return [];
        var docs = await db.Documents.AsNoTracking().Where(d => best.Contains(d.Id)).Select(d => new { d.Id, d.Number, d.Title, Version = d.PublishedVersionId!.Value }).ToListAsync(ct);
        var versions = docs.Select(d => d.Version).ToList();
        var sections = await db.DocumentSections.AsNoTracking().Where(s => versions.Contains(s.VersionId)).OrderBy(s => s.SortOrder)
            .Select(s => new { s.VersionId, s.Title, s.Kind, s.ContentJson }).ToListAsync(ct);
        var masker = await masking.MaskerAsync(ct) ?? new PiiMasker();
        var pages = new List<KnowledgePage>();
        foreach (var id in best)
        {
            var d = docs.First(x => x.Id == id);
            var lines = new List<string>();
            foreach (var s in sections.Where(s => s.VersionId == d.Version))
            {
                lines.Add($"## {masker.MaskText(s.Title)}");
                var content = masker.MaskSection(s.Kind.ToString(), s.ContentJson);
                if (s.Kind == SectionKind.Table) { var (cols, rows) = DocumentDiff.ReadTable(content); lines.Add(string.Join(" | ", cols)); lines.AddRange(rows.Select(r => string.Join(" | ", r))); }
                else lines.AddRange(DocumentDiff.TextLines(content).Select(l => l.Text).Where(t => !string.IsNullOrWhiteSpace(t)));
            }
            pages.Add(new KnowledgePage($"D{pages.Count + 1}", d.Id, $"DOC-{d.Number}", d.Title, Passages(lines, terms)));
        }
        return pages;
    }

    /// <summary>The lines that mention the words, with the line before and after (and the heading they sit under), up to the page budget.</summary>
    public static string Passages(IReadOnlyList<string> lines, IReadOnlyList<string> terms)
    {
        var keep = new SortedSet<int>();
        for (var i = 0; i < lines.Count; i++)
        {
            var l = lines[i].ToLowerInvariant();
            if (!terms.Any(t => l.Contains(t, StringComparison.Ordinal))) continue;
            for (var k = Math.Max(0, i - 1); k <= Math.Min(lines.Count - 1, i + 1); k++) keep.Add(k);
            for (var h = i; h >= 0; h--) if (lines[h].StartsWith("## ", StringComparison.Ordinal)) { keep.Add(h); break; }
        }
        if (keep.Count == 0) for (var i = 0; i < Math.Min(lines.Count, 12); i++) keep.Add(i);   // matched on the title or tags: the start of the page
        var sb = new StringBuilder();
        var last = -2;
        foreach (var i in keep)
        {
            if (i > last + 1 && sb.Length > 0) sb.Append("…\n");
            var line = lines[i].Length > 600 ? lines[i][..600] + "…" : lines[i];
            if (sb.Length + line.Length > MaxCharsPerPage) { sb.Append('…'); break; }
            sb.Append(line).Append('\n');
            last = i;
        }
        return sb.ToString().TrimEnd();
    }

    /// <summary>The tickets raised from this WhatsApp number (any of the workspace's numbers): open ones, and ones closed in the last 30 days.</summary>
    public async Task<IReadOnlyList<CustomerTicket>> TicketsAsync(string contactKey, CancellationToken ct)
    {
        var ids = await db.SupportConversations.AsNoTracking().Where(c => c.ContactKey == contactKey && c.WorkTaskId != null).Select(c => c.WorkTaskId!.Value).ToListAsync(ct);
        if (ids.Count == 0) return [];
        var since = clock.Now.AddDays(-30);
        var rows = await db.WorkTasks.AsNoTracking().Where(t => ids.Contains(t.Id) && !t.IsDeleted
                && (t.Status == WorkTaskStatus.ToDo || t.Status == WorkTaskStatus.InProgress || t.Status == WorkTaskStatus.OnHold || (t.UpdatedAt ?? t.CreatedAt) >= since))
            .OrderByDescending(t => t.UpdatedAt ?? t.CreatedAt).Take(8)
            .Select(t => new { t.Kind, t.Number, t.Title, t.Status, t.AssigneeId, Updated = t.UpdatedAt ?? t.CreatedAt, t.DueDate }).ToListAsync(ct);
        var people = rows.Where(r => r.AssigneeId != null).Select(r => r.AssigneeId!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName.Split(' ', StringSplitOptions.RemoveEmptyEntries)[0], ct);
        return rows.Select(r => new CustomerTicket(WorkItemService.KeyOf(r.Kind, r.Number), r.Title, r.Status switch
        {
            WorkTaskStatus.ToDo => "received, waiting to be picked up",
            WorkTaskStatus.InProgress => "being worked on",
            WorkTaskStatus.OnHold => "on hold",
            WorkTaskStatus.Completed => "resolved",
            _ => "closed",
        }, r.AssigneeId is { } a ? names.GetValueOrDefault(a) : null, r.Updated, r.DueDate)).ToList();
    }
}
