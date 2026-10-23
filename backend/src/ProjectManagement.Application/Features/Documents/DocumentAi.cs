using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Voice;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Documents;

/// <param name="Source">prompt (one line), meeting, tasks (a project's work), files, voice (a recording), template (fill a template's sections).</param>
/// <param name="Language">en, hi or te.</param>
public record DocDraftRequest(string Source, string? Prompt = null, Guid? ProjectId = null, Guid? MeetingId = null, Guid? TemplateTypeId = null, string? Language = null, string? Kind = null);
/// <param name="Body">The page's text as editor JSON, ready to save or insert.</param>
public record DocDraftDto(string Title, string Body, string Markdown, IReadOnlyList<string> Sources, string Model);
/// <param name="Action">rewrite, shorten, expand, fix, translate, simpler, formal, friendly.</param>
public record DocTransformRequest(string Text, string Action, string? Language = null, Guid? DocumentId = null);
/// <param name="Blocks">The answer as editor blocks (JSON array), formatting kept.</param>
/// <param name="Inline">One plain paragraph: it replaces the selection inside its line (the first block's content) rather than as new blocks.</param>
public record DocTransformDto(string Text, string? Blocks, string Model, bool Inline = false);
public record DocContinueRequest(Guid DocumentId, string? Before, string? Language = null);
public record AskSpaceRequest(string Question, Guid? ProjectId = null);
/// <param name="Block">Which top-level block of the page the passage is (0-based), for the link to the line.</param>
public record AskCitationDto(int N, Guid DocumentId, string Key, string Title, string? Icon, int Block, string Snippet);
public record AskSpaceDto(string Answer, IReadOnlyList<AskCitationDto> Citations, int PagesRead, string Model, bool Found);
public record DocSearchHitDto(Guid Id, string Key, string Title, string? Icon, Guid? ProjectId, string? ProjectName, string Line, int Block, double Score, DateTime UpdatedAt, string TypeCode);
public record DocSearchDto(IReadOnlyList<DocSearchHitDto> Hits, int Total);
public sealed record DraftUpload(string Name, string ContentType, byte[] Bytes);

/// <summary>
/// AI in the document workspace, because most people would rather review than write: a page from one line, a meeting, a project's tasks,
/// files or a voice note; rewrite, shorten, expand, fix or translate (Telugu, Hindi) selected text; continue writing; fill a template from
/// what the project already knows; and "ask the space" with answers cited to the lines they came from. Everything the model reads is what
/// the person may read, with personal data masked as on screen; the model is told to use only those facts and write TBD for the rest.
/// Every call spends the workspace's AI credits. Also: ranked search inside pages with the matching line.
/// </summary>
public partial class DocumentAiService(IAppDbContext db, ICurrentContext ctx, IAiClient ai, AiCreditService credits, IOptions<AiOptions> aiOptions,
    EntitlementService entitlements, DocumentMaskingService masking, ISecretProtector secrets, VoiceSpeechService speech, Recorder recorder, DocumentRankedSearch search)
{
    public const int MaxContext = 30_000, MaxQuestion = 500, MaxSelection = 8000;
    public static readonly string[] Actions = ["rewrite", "shorten", "expand", "fix", "translate", "simpler", "formal", "friendly"];

    private static string LanguageName(string? code) => (code ?? "en").Trim().ToLowerInvariant() switch
    {
        "hi" or "hindi" => "Hindi (Devanagari script)",
        "te" or "telugu" => "Telugu (Telugu script)",
        _ => "English",
    };

    private async Task EnsureAiAsync(CancellationToken ct)
    {
        if (!ai.Configured) throw new ConflictException("The AI assistant is not set up on this server.", "AI_NOT_CONFIGURED");
        await entitlements.EnsureFeatureAsync(FeatureKeys.AiAssistant, ct);
        var tid = ctx.RequireTenantId();
        if (await db.Tenants.AsNoTracking().Where(t => t.Id == tid).Select(t => t.AiDisabled).FirstAsync(ct))
            throw new ConflictException("The assistant is switched off in this workspace (Workspace settings → AI).", "AI_OFF");
    }

    private async Task<AiAnswer> AskModelAsync(string feature, string system, string user, int maxTokens, int weight, CancellationToken ct)
    {
        var cost = Math.Clamp(aiOptions.Value.Chat.Quick.Credits * weight, 1, 10000);
        await using var lease = await credits.ReserveAsync(Guid.NewGuid(), cost, feature, ct);
        var answer = await ai.CompleteAsync(system, user, maxTokens, ct);
        await lease.SettleAsync(cost, ct);
        return answer;
    }

    private static string Cut(string s, int max) => s.Length <= max ? s : s[..max];

    // ------------------------------------------------------------------ write a page

    public async Task<DocDraftDto> DraftAsync(DocDraftRequest req, IReadOnlyList<DraftUpload>? files = null, DraftUpload? voice = null, CancellationToken ct = default)
    {
        await EnsureAiAsync(ct);
        var source = (req.Source ?? "prompt").Trim().ToLowerInvariant();
        var facts = new StringBuilder();
        var sources = new List<string>();
        string? outline = null;
        var prompt = (req.Prompt ?? "").Trim();
        if (prompt.Length > 2000) throw new ValidationException("prompt", "Keep the request under 2,000 characters.");

        Project? project = null;
        if (req.ProjectId is { } pid)
        {
            project = await db.Projects.AsNoTracking().FirstOrDefaultAsync(p => p.Id == pid, ct) ?? throw new NotFoundException("Project not found.");
            facts.AppendLine($"Project {project.Key} “{project.Name}”: status {project.Status}{(project.DueDate is { } due ? $", due {due:d MMM yyyy}" : "")}.");
            if (!string.IsNullOrWhiteSpace(project.Description)) facts.AppendLine("About the project: " + Cut(project.Description, 1500));
            sources.Add($"Project {project.Key}");
        }

        switch (source)
        {
            case "prompt":
                if (prompt.Length < 3) throw new ValidationException("prompt", "Say in a line what the page should be about.");
                break;
            case "meeting":
                await MeetingFactsAsync(req.MeetingId ?? throw new ValidationException("meetingId", "Choose a meeting."), facts, sources, ct);
                break;
            case "tasks":
                if (project is null) throw new ValidationException("projectId", "Choose the project whose work the page is about.");
                await TaskFactsAsync(project, facts, sources, ct);
                break;
            case "files":
                if (files is not { Count: > 0 }) throw new ValidationException("files", "Add at least one file (PDF, Word, text or Markdown).");
                foreach (var f in files.Take(5))
                {
                    var text = await FileTextAsync(f, ct);
                    facts.AppendLine($"--- File “{f.Name}” ---").AppendLine(Cut(text, MaxContext / Math.Min(files.Count, 5)));
                    sources.Add($"File {f.Name}");
                }
                break;
            case "voice":
                if (voice is null || voice.Bytes.Length < 100) throw new ValidationException("voice", "Record a voice note first.");
                if (voice.Bytes.Length > 15 * 1024 * 1024) throw new ValidationException("voice", "Keep the recording under 15 MB (about 10 minutes).");
                var heard = await speech.TranscribeAsync(voice.Bytes, voice.ContentType, ct)
                    ?? throw new ValidationException("voice", "The recording could not be understood. Try again closer to the microphone.");
                facts.AppendLine("What the person said in their voice note (transcribed; it may be in Telugu, Hindi or English):").AppendLine(Cut(heard.Text, MaxContext));
                sources.Add($"Voice note ({heard.Language ?? "auto"})");
                break;
            case "template":
                var type = await db.DocumentTypes.AsNoTracking().FirstOrDefaultAsync(t => t.Id == (req.TemplateTypeId ?? Guid.Empty), ct) ?? throw new ValidationException("templateTypeId", "Choose a template.");
                var sections = DocumentTemplates.FromJson(type.TemplateJson);
                outline = string.Join("\n", sections.Select(s => $"## {s.Title}{(s.Hint is null ? "" : $" ({s.Hint})")}{(s.Columns is { Length: > 0 } cols ? $" — a table with columns: {string.Join(", ", cols)}" : "")}"));
                sources.Add($"Template {type.Name}");
                if (project is not null) await TaskFactsAsync(project, facts, sources, ct);
                break;
            default:
                throw new ValidationException("source", "Write from a line, a meeting, a project's tasks, files, a voice note or a template.");
        }
        if (facts.Length > MaxContext) { facts.Length = MaxContext; facts.AppendLine("…"); }

        var system = new StringBuilder()
            .Append("You write pages for a company's document workspace (like Notion or Confluence). Output Markdown only, nothing before or after it. ")
            .Append("The first line is '# ' and a short, specific title. Then a one-paragraph summary, then sections with '## ' headings, short paragraphs, bullet lists, ")
            .Append("'- [ ] ' to-do items for actions with an owner and a date when known, and tables where they help. Plain, direct words; no filler. ")
            .Append("Use only the facts given. Never invent names, numbers, dates or decisions: write TBD where something is unknown. ")
            .Append($"Write in {LanguageName(req.Language)}.");
        if (outline is not null) system.Append(" Use exactly these sections, in this order, and fill each one from the facts (TBD where nothing is known):\n" + outline);
        if (!string.IsNullOrWhiteSpace(req.Kind)) system.Append($" The page is a {Cut(req.Kind.Trim(), 60)}.");
        var user = new StringBuilder();
        if (prompt.Length > 0) user.AppendLine("What the page should be: " + prompt);
        if (facts.Length > 0) user.AppendLine("Facts:").Append(facts);
        var answer = await AskModelAsync("document_draft", system.ToString(), user.ToString(), 2500, 3, ct);
        var md = StripFence(answer.Text);
        var (title, body) = SplitTitle(md, prompt.Length > 0 ? prompt : sources.FirstOrDefault() ?? "New page");
        recorder.Audit("ai.used", "Document", req.ProjectId, null, new { feature = "document_draft", source, length = body.Length });
        await db.SaveChangesAsync(ct);
        return new DocDraftDto(title, MarkdownDoc.ToJson(body), body, sources, answer.Model);
    }

    private async Task MeetingFactsAsync(Guid meetingId, StringBuilder facts, List<string> sources, CancellationToken ct)
    {
        var meeting = await db.ProjectMeetings.AsNoTracking().FirstOrDefaultAsync(m => m.Id == meetingId, ct) ?? throw new NotFoundException("Meeting not found.");
        if (!await db.Projects.AnyAsync(p => p.Id == meeting.ProjectId, ct)) throw new NotFoundException("Meeting not found.");
        facts.AppendLine($"Meeting “{meeting.Title}” on {meeting.StartTimeUtc:d MMM yyyy}.");
        if (!string.IsNullOrWhiteSpace(meeting.Description)) facts.AppendLine("Agenda: " + Cut(meeting.Description, 2000));
        var runIds = db.AgentRuns.AsNoTracking().Where(r => r.MeetingId == meetingId).Select(r => r.Id);
        var findings = await db.AgentFindings.AsNoTracking().Where(f => runIds.Contains(f.RunId) && f.Status != AgentFindingStatus.Dismissed)
            .OrderBy(f => f.CreatedAt).Take(80).Select(f => new { f.Kind, f.Title, f.Detail, f.DueDate }).ToListAsync(ct);
        foreach (var f in findings.Where(x => x.Kind == AgentFindingKind.Decision)) facts.AppendLine($"Decision: {f.Title}{(f.Detail is null ? "" : " — " + Cut(f.Detail, 300))}");
        foreach (var f in findings.Where(x => x.Kind is AgentFindingKind.CreateTask or AgentFindingKind.CreateActionItem))
            facts.AppendLine($"Action: {f.Title}{(f.DueDate is { } d ? $" (due {d:d MMM})" : "")}");
        var bot = await db.AgentMeetingBots.AsNoTracking().Where(b => b.MeetingId == meetingId && b.TranscriptProtected != null).OrderByDescending(b => b.SessionStartUtc).FirstOrDefaultAsync(ct);
        if (bot?.TranscriptProtected is { } protectedText)
        {
            var transcript = secrets.Unprotect(protectedText);
            facts.AppendLine("Transcript:").AppendLine(Cut(transcript, MaxContext - Math.Min(facts.Length, MaxContext / 2)));
        }
        if (findings.Count == 0 && bot is null) throw new ValidationException("meetingId", "This meeting has no transcript or notes yet.");
        sources.Add($"Meeting {meeting.Title}");
    }

    private async Task TaskFactsAsync(Project project, StringBuilder facts, List<string> sources, CancellationToken ct)
    {
        var tasks = await db.Tasks.AsNoTracking().Where(t => t.ProjectId == project.Id && t.ParentTaskId == null)
            .OrderBy(t => t.Status!.Category).ThenBy(t => t.DueDate).Take(120)
            .Select(t => new { t.Number, t.Title, t.Description, Status = t.Status!.Name, t.Priority, t.DueDate, Assignee = t.Assignee != null ? t.Assignee.DisplayName : null })
            .ToListAsync(ct);
        foreach (var t in tasks)
            facts.AppendLine($"Task {project.Key}-{t.Number} “{t.Title}”: {t.Status}, {t.Priority}{(t.Assignee is null ? "" : $", {t.Assignee}")}{(t.DueDate is { } d ? $", due {d:d MMM}" : "")}"
                + (string.IsNullOrWhiteSpace(t.Description) ? "" : $". {Cut(t.Description.Replace('\n', ' '), 200)}"));
        var milestones = await db.Milestones.AsNoTracking().Where(m => m.ProjectId == project.Id).OrderBy(m => m.DueDate).Take(20).Select(m => new { m.Name, m.DueDate }).ToListAsync(ct);
        foreach (var m in milestones) facts.AppendLine($"Milestone {m.Name}{(m.DueDate is { } d ? $", due {d:d MMM yyyy}" : "")}");
        sources.Add($"{tasks.Count} tasks of {project.Key}");
    }

    private static async Task<string> FileTextAsync(DraftUpload f, CancellationToken ct)
    {
        var ext = Path.GetExtension(f.Name).ToLowerInvariant();
        if (f.Bytes.Length > 2 * 1024 * 1024) throw new ValidationException("files", $"“{f.Name}” is larger than 2 MB.");
        if (ext is ".txt" or ".md" or ".csv" or ".json" or ".log") return Encoding.UTF8.GetString(f.Bytes);
        if (ext is ".pdf" or ".docx")
        {
            using var s = new MemoryStream(f.Bytes);
            return (await ProjectManagement.Application.Features.Resumes.ResumeFiles.ExtractAsync(f.Name, s, ct)).Text;
        }
        throw new ValidationException("files", $"“{f.Name}”: use PDF, Word (.docx), text or Markdown files.");
    }

    [GeneratedRegex(@"^\s*```(?:markdown|md)?\s*\n(.*)\n```\s*$", RegexOptions.Singleline)] private static partial Regex Fence();

    private static string StripFence(string text)
    {
        var t = text.Trim();
        return Fence().Match(t) is { Success: true } m ? m.Groups[1].Value.Trim() : t;
    }

    private static (string Title, string Body) SplitTitle(string md, string fallback)
    {
        var lines = md.Split('\n').ToList();
        var first = lines.FindIndex(l => !string.IsNullOrWhiteSpace(l));
        if (first >= 0 && lines[first].TrimStart().StartsWith("# "))
        {
            var title = lines[first].Trim()[2..].Trim().Trim('*');
            lines.RemoveAt(first);
            return (Cut(title.Length == 0 ? fallback : title, 200), string.Join("\n", lines).Trim());
        }
        return (Cut(fallback, 200), md.Trim());
    }

    // ------------------------------------------------------------------ selected text, continue writing

    public async Task<DocTransformDto> TransformAsync(DocTransformRequest req, CancellationToken ct = default)
    {
        await EnsureAiAsync(ct);
        var action = (req.Action ?? "").Trim().ToLowerInvariant();
        if (!Actions.Contains(action)) throw new ValidationException("action", "Choose rewrite, shorten, expand, fix, translate or a tone.");
        var text = (req.Text ?? "").Trim();
        if (text.Length == 0) throw new ValidationException("text", "Select some text first.");
        if (text.Length > MaxSelection) throw new ValidationException("text", $"Select at most {MaxSelection:N0} characters at a time.");
        if (action == "translate" && string.IsNullOrWhiteSpace(req.Language)) throw new ValidationException("language", "Choose the language to translate into.");
        var language = LanguageName(req.Language);
        var instruction = action switch
        {
            "rewrite" => "Rewrite it more clearly, keeping every fact and the meaning.",
            "shorten" => "Make it about half as long, keeping every important fact.",
            "expand" => "Expand it with more explanation and structure, without adding facts that are not there (write TBD where detail is missing).",
            "fix" => "Fix spelling, grammar and punctuation only. Change nothing else.",
            "translate" => $"Translate it into {language}. Keep names, numbers, codes and task keys as they are.",
            "simpler" => "Rewrite it in simpler words that anyone can follow.",
            "formal" => "Rewrite it in a formal, professional tone.",
            _ => "Rewrite it in a warm, friendly tone.",
        };
        var system = "You edit text in a company document. " + instruction + (action == "translate" ? "" : $" Answer in the same language as the text unless told otherwise ({language} if unsure).")
            + " Keep Markdown formatting (lists, bold, links) where it exists. Output only the new text: no quotes, no preface, no explanation.";
        var answer = await AskModelAsync("document_edit", system, text, Math.Clamp(text.Length / 2 + 600, 400, 3000), 1, ct);
        var result = StripFence(answer.Text);
        var blocks = MarkdownDoc.Blocks(result);
        var multi = blocks.Count > 1 || blocks.Any(b => b?["type"]?.GetValue<string>() is not "paragraph");
        return new DocTransformDto(result, blocks.ToJsonString(), answer.Model, !multi);
    }

    public async Task<DocTransformDto> ContinueAsync(DocContinueRequest req, CancellationToken ct = default)
    {
        await EnsureAiAsync(ct);
        var doc = await db.Documents.AsNoTracking().FirstOrDefaultAsync(d => d.Id == req.DocumentId, ct) ?? throw new NotFoundException("Document not found.");
        var before = (req.Before ?? "").Trim();
        if (before.Length > MaxContext) before = before[^MaxContext..];
        var system = "You continue writing a page in a company's document workspace, in the same voice, language and format as what is already written. " +
                     "Write the next one to three paragraphs (or list items, if the text ends in a list). Do not repeat what is there, do not invent facts, names or numbers: " +
                     $"write TBD where something is unknown. Output Markdown only. If the page is empty, write in {LanguageName(req.Language)}.";
        var answer = await AskModelAsync("document_edit", system, $"Page title: {doc.Title}\n\nWritten so far:\n{(before.Length == 0 ? "(nothing yet)" : before)}", 700, 1, ct);
        var result = StripFence(answer.Text);
        return new DocTransformDto(result, MarkdownDoc.Blocks(result).ToJsonString(), answer.Model);
    }

    // ------------------------------------------------------------------ ask the space

    public async Task<AskSpaceDto> AskAsync(AskSpaceRequest req, CancellationToken ct = default)
    {
        await EnsureAiAsync(ct);
        var question = (req.Question ?? "").Trim();
        if (question.Length < 3) throw new ValidationException("question", "Ask a question.");
        if (question.Length > MaxQuestion) throw new ValidationException("question", $"Keep the question under {MaxQuestion} characters.");
        var terms = DocumentRankedSearch.Terms(question);
        var pages = terms.Count == 0 ? [] : await search.CandidatesAsync(terms, req.ProjectId, 6, ct);
        var masker = await masking.MaskerAsync(ct);
        var passages = new List<(DocumentRankedSearch.Candidate Page, int Block, string Text)>();
        foreach (var p in pages)
        {
            var blocks = await search.BlocksAsync(p, masker, ct);
            var ranked = blocks.Select((b, i) => (i, b, score: terms.Count(t => b.Contains(t, StringComparison.OrdinalIgnoreCase))))
                .Where(x => x.score > 0).OrderByDescending(x => x.score).Take(6).ToList();
            // A heading alone says little: take the block after it too.
            foreach (var (i, b, _) in ranked)
            {
                var text = b.StartsWith('#') && i + 1 < blocks.Count ? b + "\n" + blocks[i + 1] : b;
                passages.Add((p, i, Cut(text, 1500)));
            }
        }
        if (passages.Count == 0)
            return new AskSpaceDto("Nothing in the pages you can open answers that. Try other words, or ask the page's owner.", [], pages.Count, ai.Model, false);
        passages = passages.Take(30).ToList();
        var sb = new StringBuilder();
        for (var n = 0; n < passages.Count; n++)
            sb.AppendLine($"[{n + 1}] From “{passages[n].Page.Title}” ({DocumentService.KeyOf(passages[n].Page.Number)}):").AppendLine(passages[n].Text).AppendLine();
        var system = "You answer questions about a company's own documents, using only the numbered passages given. Answer in two to six sentences or a short list, " +
                     "in the language of the question. After every statement put the number of the passage it comes from, like [2]. " +
                     "If the passages do not answer the question, say so plainly and do not guess.";
        var answer = await AskModelAsync("document_ask", system, $"Question: {question}\n\nPassages:\n{sb}", 900, 2, ct);
        var used = Regex.Matches(answer.Text, @"\[(\d{1,2})\]").Select(m => int.Parse(m.Groups[1].Value)).Where(n => n >= 1 && n <= passages.Count).Distinct().OrderBy(n => n).ToList();
        var citations = used.Select(n => { var p = passages[n - 1]; return new AskCitationDto(n, p.Page.Id, DocumentService.KeyOf(p.Page.Number), p.Page.Title, p.Page.Icon, p.Block, DocumentRankedSearch.Snip(p.Text, terms)); }).ToList();
        recorder.Audit("ai.used", "Document", req.ProjectId, null, new { feature = "document_ask", pages = pages.Count, cited = citations.Count });
        await db.SaveChangesAsync(ct);
        return new AskSpaceDto(answer.Text.Trim(), citations, pages.Count, answer.Model, citations.Count > 0);
    }
}

/// <summary>
/// Ranked search inside pages and documents the person may read (the document filter applies): a word in the title counts most, then how many
/// of the words appear and how often, then how recently the page changed. Each hit carries its best-matching line, masked like the screen.
/// </summary>
public class DocumentRankedSearch(IAppDbContext db, AppClock clock, DocumentMaskingService masking)
{
    private static readonly HashSet<string> Stop = ["the", "and", "for", "are", "was", "what", "when", "where", "which", "who", "why", "how", "did", "does", "with", "that", "this",
        "from", "have", "has", "had", "our", "you", "your", "about", "into", "can", "will", "would", "should", "could", "there", "their", "they", "them", "been", "were", "any", "all",
        "agree", "agreed", "say", "said", "tell", "please", "page", "pages", "doc", "docs", "document"];

    public static List<string> Terms(string q) => Regex.Matches(q.ToLowerInvariant(), @"[\p{L}\p{N}][\p{L}\p{N}\-]{1,}")
        .Select(m => m.Value).Where(w => w.Length >= 3 && !Stop.Contains(w)).Distinct().Take(8).ToList();

    public sealed record Candidate(Guid Id, int Number, string Title, string? Icon, Guid? ProjectId, string? ProjectName, Guid? VersionId, DateTime Updated, string TypeCode, double Score);

    /// <summary>
    /// Pages and documents the person may read that contain the words, best first: a word in the title counts most, then how many of the
    /// words appear and how often, then how recently it changed. Each hit carries its best-matching line.
    /// </summary>
    public async Task<DocSearchDto> SearchAsync(string query, Guid? projectId = null, int take = 20, CancellationToken ct = default)
    {
        var terms = Terms(query);
        if (terms.Count == 0) terms = query.Trim().ToLowerInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries).Where(w => w.Length >= 2).Take(6).ToList();
        if (terms.Count == 0) return new DocSearchDto([], 0);
        var found = await CandidatesAsync(terms, projectId, Math.Clamp(take, 1, 50) * 2, ct);
        var masker = await masking.MaskerAsync(ct);
        var hits = new List<DocSearchHitDto>();
        foreach (var c in found.Take(Math.Clamp(take, 1, 50)))
        {
            var (line, block) = await BestLineAsync(c, terms, masker, ct);
            hits.Add(new DocSearchHitDto(c.Id, DocumentService.KeyOf(c.Number), c.Title, c.Icon, c.ProjectId, c.ProjectName, line, block, Math.Round(c.Score, 2), c.Updated, c.TypeCode));
        }
        return new DocSearchDto(hits, found.Count);
    }

    public async Task<List<Candidate>> CandidatesAsync(List<string> terms, Guid? projectId, int take, CancellationToken ct)
    {
        var scores = new Dictionary<Guid, double>();
        var now = clock.Now;
        foreach (var term in terms)
        {
            var pattern = "%" + term.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";
            var q = db.Documents.AsNoTracking().Where(d => d.Status != DocumentStatus.Archived && EF.Functions.Like(d.SearchText!, pattern, "\\"));
            if (projectId is { } pid) q = q.Where(d => d.ProjectId == pid);
            var rows = await q.Select(d => new { d.Id, d.Title, d.SearchText }).Take(400).ToListAsync(ct);
            foreach (var r in rows)
            {
                var inTitle = r.Title.Contains(term, StringComparison.OrdinalIgnoreCase);
                var count = Math.Min(10, Regex.Matches(r.SearchText ?? "", Regex.Escape(term)).Count);
                scores[r.Id] = scores.GetValueOrDefault(r.Id) + 10 + (inTitle ? 25 : 0) + count;
            }
        }
        if (scores.Count == 0) return [];
        var ids = scores.Keys.ToList();
        var rowsInfo = await (from d in db.Documents.AsNoTracking()
                              join t in db.DocumentTypes.AsNoTracking() on d.TypeId equals t.Id
                              where ids.Contains(d.Id)
                              select new { d.Id, d.Number, d.Title, d.Icon, d.ProjectId, ProjectName = d.Project != null ? d.Project.Name : null, VersionId = d.PublishedVersionId ?? d.DraftVersionId, Updated = d.UpdatedAt ?? d.CreatedAt, t.Code })
            .ToListAsync(ct);
        return rowsInfo.Select(r => new Candidate(r.Id, r.Number, r.Title, r.Icon, r.ProjectId, r.ProjectName, r.VersionId, r.Updated, r.Code,
                scores[r.Id] + Math.Max(0, 5 - (now - r.Updated).TotalDays / 30)))
            .OrderByDescending(c => c.Score).ThenByDescending(c => c.Updated).Take(take).ToList();
    }

    /// <summary>The page's blocks in Markdown, masked like the screen, in reading order.</summary>
    public async Task<List<string>> BlocksAsync(Candidate c, PiiMasker? masker, CancellationToken ct)
    {
        if (c.VersionId is not { } vid) return [];
        var sections = await db.DocumentSections.AsNoTracking().Where(s => s.VersionId == vid).OrderBy(s => s.SortOrder).Select(s => new { s.Title, s.Kind, s.ContentJson }).ToListAsync(ct);
        var blocks = new List<string>();
        foreach (var s in sections)
        {
            var content = masker is null ? s.ContentJson : masker.MaskSection(s.Kind.ToString(), s.ContentJson);
            if (s.Kind == SectionKind.Table) { blocks.Add($"{s.Title}: {SectionContent.PlainText(s.Kind, content)}"); continue; }
            if (sections.Count > 1 && s.Title.Length > 0) blocks.Add("## " + s.Title);
            blocks.AddRange(MarkdownDoc.ToBlocks(content));
        }
        return blocks;
    }

    private async Task<(string Line, int Block)> BestLineAsync(Candidate c, List<string> terms, PiiMasker? masker, CancellationToken ct)
    {
        var blocks = await BlocksAsync(c, masker, ct);
        var best = -1; var bestScore = 0;
        for (var i = 0; i < blocks.Count; i++)
        {
            var lower = blocks[i].ToLowerInvariant();
            var score = terms.Count(t => lower.Contains(t)) * 10 + terms.Sum(t => Math.Min(3, Regex.Matches(lower, Regex.Escape(t)).Count));
            if (score > bestScore) { bestScore = score; best = i; }
        }
        if (best < 0) return (blocks.Count > 0 ? Snip(blocks[0], terms) : "", 0);
        return (Snip(blocks[best], terms), best);
    }

    public static string Snip(string block, List<string> terms)
    {
        var plain = Regex.Replace(block, @"[#*`>|\[\]]+", " ").Replace("  ", " ").Trim();
        var at = terms.Select(t => plain.IndexOf(t, StringComparison.OrdinalIgnoreCase)).Where(i => i >= 0).DefaultIfEmpty(0).Min();
        var start = Math.Max(0, at - 60);
        var s = plain.Substring(start, Math.Min(200, plain.Length - start));
        return (start > 0 ? "…" : "") + s + (start + s.Length < plain.Length ? "…" : "");
    }

}
