using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Notes;

public record NoteLinkDto(string Kind, string Id, string Label, string? Href = null);
public record NoteSummaryDto(Guid Id, string Title, string Snippet, string? Folder, IReadOnlyList<string> Tags, bool Pinned, string Sharing, UserRefDto Owner,
    Guid? ProjectId, Guid? MeetingId, bool Mine, DateTime CreatedAt, DateTime UpdatedAt);
public record NoteDto(Guid Id, string Title, JsonElement Content, string? Folder, IReadOnlyList<string> Tags, bool Pinned, string Sharing, UserRefDto Owner,
    IReadOnlyList<UserRefDto> SharedWith, IReadOnlyList<NoteLinkDto> Links, Guid? ProjectId, Guid? MeetingId, bool Mine, bool CanEdit,
    IReadOnlyList<UserRefDto> Editors, DateTime CreatedAt, DateTime UpdatedAt);
public record NoteFolderDto(string Name, int Count, Guid? ProjectId);
public record NoteTagDto(string Tag, int Count);
public record NoteCountsDto(int All, int Pinned, int Shared, int Meetings);
public record NoteListDto(IReadOnlyList<NoteSummaryDto> Items, NoteCountsDto Counts, IReadOnlyList<NoteFolderDto> Folders, IReadOnlyList<NoteTagDto> Tags);
/// <summary>Every field is optional on an update: only what is sent changes. <paramref name="ClearProject"/> unlinks the project.</summary>
public record SaveNoteRequest(string? Title = null, JsonElement? Content = null, string? Folder = null, IReadOnlyList<string>? Tags = null, bool? Pinned = null,
    Guid? ProjectId = null, Guid? MeetingId = null, IReadOnlyList<NoteLinkDto>? Links = null, bool ClearProject = false);
/// <param name="Sharing">private, people (only <paramref name="UserIds"/>) or workspace.</param>
public record ShareNoteRequest(string Sharing, IReadOnlyList<Guid>? UserIds);

/// <summary>
/// Notes: a person's notes in the current workspace, in folders with tags, pinned or not; private, shared with chosen people, or with the whole
/// workspace. Content is a list of blocks (JSON) and its text is kept beside it for search. People shared on a note can edit it; only its owner
/// shares, moves to another project or deletes it. Mentioning someone in a note tells them (a Mention notice that links to the note).
/// </summary>
public class NoteService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, NotificationService notifications)
{
    public const int MaxContent = 200_000, MaxTags = 12, MaxLinks = 30, MaxShare = 50, ListLimit = 300;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly string[] Sharings = ["private", "people", "workspace"];

    private IQueryable<Note> Visible()
    {
        var me = ctx.RequireUserId();
        var key = me.ToString();
        return db.Notes.Where(n => n.OwnerId == me || n.Sharing == "workspace" || (n.Sharing == "people" && n.SharedWithJson.Contains(key)));
    }

    /// <param name="view">all, pinned, shared (shared with me by others) or meetings.</param>
    public async Task<NoteListDto> ListAsync(string? view, string? folder, string? tag, string? q, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var all = await Visible().AsNoTracking().OrderByDescending(n => n.UpdatedAt ?? n.CreatedAt).Take(ListLimit)
            .Select(n => new { n.Id, n.Title, n.PlainText, n.Folder, n.Tags, n.Pinned, n.Sharing, n.OwnerId, n.ProjectId, n.MeetingId, n.CreatedAt, n.UpdatedAt })
            .ToListAsync(ct);
        var counts = new NoteCountsDto(all.Count, all.Count(n => n.Pinned), all.Count(n => n.OwnerId != me), all.Count(n => n.MeetingId != null || n.Folder == "Meeting notes"));
        var folders = all.Where(n => !string.IsNullOrEmpty(n.Folder)).GroupBy(n => n.Folder!, StringComparer.OrdinalIgnoreCase)
            .Select(g => new NoteFolderDto(g.First().Folder!, g.Count(), g.Select(x => x.ProjectId).FirstOrDefault(p => p != null))).OrderBy(f => f.Name).ToList();
        var tags = all.SelectMany(n => SplitTags(n.Tags)).GroupBy(t => t).Select(g => new NoteTagDto(g.Key, g.Count())).OrderByDescending(t => t.Count).ThenBy(t => t.Tag).Take(30).ToList();

        var picked = all.AsEnumerable();
        picked = (view ?? "all").ToLowerInvariant() switch
        {
            "pinned" => picked.Where(n => n.Pinned),
            "shared" => picked.Where(n => n.OwnerId != me),
            "meetings" => picked.Where(n => n.MeetingId != null || n.Folder == "Meeting notes"),
            _ => picked,
        };
        if (!string.IsNullOrWhiteSpace(folder)) picked = picked.Where(n => string.Equals(n.Folder, folder.Trim(), StringComparison.OrdinalIgnoreCase));
        if (!string.IsNullOrWhiteSpace(tag)) { var t = CleanTag(tag); picked = picked.Where(n => SplitTags(n.Tags).Contains(t)); }
        if (!string.IsNullOrWhiteSpace(q))
        {
            var words = q.Trim().ToLowerInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries);
            picked = picked.Where(n => words.All(w => n.Title.Contains(w, StringComparison.OrdinalIgnoreCase) || n.PlainText.Contains(w, StringComparison.OrdinalIgnoreCase)
                || SplitTags(n.Tags).Any(t => t.Contains(w.TrimStart('#'), StringComparison.Ordinal))));
        }
        var list = picked.OrderByDescending(n => n.Pinned).ThenByDescending(n => n.UpdatedAt ?? n.CreatedAt).ToList();
        var names = await NamesAsync(list.Select(n => n.OwnerId), ct);
        var items = list.Select(n => new NoteSummaryDto(n.Id, n.Title, Snippet(n.PlainText), n.Folder, SplitTags(n.Tags), n.Pinned, n.Sharing,
            Ref(names, n.OwnerId), n.ProjectId, n.MeetingId, n.OwnerId == me, n.CreatedAt, n.UpdatedAt ?? n.CreatedAt)).ToList();
        return new NoteListDto(items, counts, folders, tags);
    }

    public async Task<NoteDto> GetAsync(Guid id, CancellationToken ct = default)
    {
        var n = await Visible().AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Note not found.");
        return await DtoAsync(n, ct);
    }

    public async Task<NoteDto> CreateAsync(SaveNoteRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        if (ctx.Role == TenantRole.Guest) throw new ForbiddenException("Guests cannot write notes.");
        var n = new Note { TenantId = ctx.RequireTenantId(), OwnerId = me, CreatedAt = clock.Now, CreatedBy = me };
        await ApplyAsync(n, req, true, ct);
        db.Notes.Add(n);
        recorder.Activity("note.created", nameof(Note), n.Id, $"Wrote a note: {n.Title}", n.ProjectId);
        await MentionAsync(n, [], ct);
        await db.SaveChangesAsync(ct);
        return await DtoAsync(n, ct);
    }

    public async Task<NoteDto> UpdateAsync(Guid id, SaveNoteRequest req, CancellationToken ct = default)
    {
        var n = await Visible().FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("Note not found.");
        var mine = n.OwnerId == ctx.RequireUserId();
        if (!mine && (req.ProjectId is not null || req.ClearProject)) throw new ForbiddenException("Only the note's owner can move it to another project.");
        var before = MentionIds(n.ContentJson);
        await ApplyAsync(n, req, false, ct);
        await MentionAsync(n, before, ct);
        await db.SaveChangesAsync(ct);
        return await DtoAsync(n, ct);
    }

    public async Task<NoteDto> ShareAsync(Guid id, ShareNoteRequest req, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        var n = await db.Notes.FirstOrDefaultAsync(x => x.Id == id && x.OwnerId == me, ct) ?? throw new NotFoundException("Note not found.");
        var sharing = (req.Sharing ?? "").Trim().ToLowerInvariant();
        if (!Sharings.Contains(sharing)) throw new ValidationException("sharing", "Choose private, people or workspace.");
        var people = (req.UserIds ?? []).Where(u => u != me).Distinct().ToList();
        if (people.Count > MaxShare) throw new ValidationException("userIds", $"Share with at most {MaxShare} people.");
        if (people.Count > 0 && await db.TenantMembers.CountAsync(m => m.TenantId == tid && people.Contains(m.UserId), ct) != people.Count)
            throw new ValidationException("userIds", "Share only with members of this workspace.");
        if (sharing == "people" && people.Count == 0) throw new ValidationException("userIds", "Choose who to share with.");
        var already = ReadGuids(n.SharedWithJson);
        n.Sharing = sharing;
        n.SharedWithJson = JsonSerializer.Serialize(sharing == "people" ? people : new List<Guid>(), Json);
        var title = n.Title.Length > 0 ? n.Title : "Untitled note";
        if (sharing == "people")
            foreach (var u in people.Where(p => !already.Contains(p)))
                await notifications.AddAsync(u, NotificationType.Document, $"Shared with you: {title}", Snippet(n.PlainText), $"/notes?open={n.Id}", $"note-share:{n.Id:N}:{u:N}", ct: ct);
        recorder.Activity("note.shared", nameof(Note), n.Id, $"Note sharing set to {sharing}", n.ProjectId);
        await db.SaveChangesAsync(ct);
        return await DtoAsync(n, ct);
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var n = await db.Notes.FirstOrDefaultAsync(x => x.Id == id && x.OwnerId == me, ct) ?? throw new NotFoundException("Note not found.");
        n.IsDeleted = true; n.DeletedAt = clock.Now; n.DeletedBy = me;
        recorder.Activity("note.deleted", nameof(Note), n.Id, $"Deleted a note: {n.Title}", n.ProjectId);
        await db.SaveChangesAsync(ct);
    }

    // ------------------------------------------------------------------ helpers

    private async Task ApplyAsync(Note n, SaveNoteRequest req, bool creating, CancellationToken ct)
    {
        if (req.Title is not null || creating)
        {
            var title = (req.Title ?? "").Trim();
            if (title.Length > 200) throw new ValidationException("title", "Keep the title under 200 characters.");
            n.Title = title;
        }
        if (req.Content is { } content)
        {
            if (content.ValueKind != JsonValueKind.Array) throw new ValidationException("content", "Content is a list of blocks.");
            var raw = content.GetRawText();
            if (raw.Length > MaxContent) throw new ValidationException("content", "This note is too long. Split it into two.");
            n.ContentJson = raw;
            n.PlainText = TextOf(content);
        }
        if (req.Folder is not null)
        {
            var f = req.Folder.Trim();
            if (f.Length > 60) throw new ValidationException("folder", "Keep the folder name under 60 characters.");
            n.Folder = f.Length == 0 ? null : f;
        }
        if (req.Tags is not null)
        {
            var tags = req.Tags.Select(CleanTag).Where(t => t.Length > 0).Distinct().ToList();
            if (tags.Count > MaxTags || tags.Any(t => t.Length > 30)) throw new ValidationException("tags", $"Use up to {MaxTags} tags of up to 30 characters.");
            n.Tags = string.Join(',', tags);
        }
        if (req.Pinned is { } pinned) n.Pinned = pinned;
        if (req.ClearProject) n.ProjectId = null;
        else if (req.ProjectId is { } pid)
        {
            // The project must be one this person can see (the query filter answers for project access and the tenant).
            if (!await db.Projects.AnyAsync(p => p.Id == pid, ct)) throw new NotFoundException("Project not found.");
            n.ProjectId = pid;
        }
        if (req.MeetingId is { } mid) n.MeetingId = mid == Guid.Empty ? null : mid;
        if (req.Links is not null)
        {
            if (req.Links.Count > MaxLinks) throw new ValidationException("links", $"Link at most {MaxLinks} items.");
            var links = req.Links.Where(l => !string.IsNullOrWhiteSpace(l.Label) && !string.IsNullOrWhiteSpace(l.Id))
                .Select(l => new NoteLinkDto(Cut(l.Kind, 20), Cut(l.Id, 64), Cut(l.Label, 120), l.Href is { } h && h.StartsWith('/') && !h.StartsWith("//") ? Cut(h, 300) : null)).ToList();
            n.LinksJson = JsonSerializer.Serialize(links, Json);
        }
        static string Cut(string s, int max) { var t = s.Trim(); return t.Length > max ? t[..max] : t; }
    }

    /// <summary>People newly @mentioned in the note hear about it once.</summary>
    private async Task MentionAsync(Note n, HashSet<Guid> before, CancellationToken ct)
    {
        var now = MentionIds(n.ContentJson);
        now.ExceptWith(before);
        if (now.Count == 0) return;
        var tid = ctx.RequireTenantId();
        var members = await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && now.Contains(m.UserId)).Select(m => m.UserId).Take(20).ToListAsync(ct);
        var who = (await NamesAsync([ctx.RequireUserId()], ct)).Values.FirstOrDefault() ?? "Someone";
        foreach (var u in members)
            await notifications.AddAsync(u, NotificationType.Mention, $"{who} mentioned you in a note", n.Title.Length > 0 ? n.Title : Snippet(n.PlainText), $"/notes?open={n.Id}", $"note-mention:{n.Id:N}:{u:N}", ct: ct);
    }

    /// <summary>Mention blocks and inline marks carry {"type":"mention","userId":".."} anywhere in the content.</summary>
    private static HashSet<Guid> MentionIds(string json)
    {
        var set = new HashSet<Guid>();
        try
        {
            using var doc = JsonDocument.Parse(json);
            void Walk(JsonElement e)
            {
                if (e.ValueKind == JsonValueKind.Object)
                {
                    if (e.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String && t.GetString() == "mention"
                        && e.TryGetProperty("userId", out var u) && u.ValueKind == JsonValueKind.String && Guid.TryParse(u.GetString(), out var g)) set.Add(g);
                    foreach (var p in e.EnumerateObject()) Walk(p.Value);
                }
                else if (e.ValueKind == JsonValueKind.Array) foreach (var x in e.EnumerateArray()) Walk(x);
            }
            Walk(doc.RootElement);
        }
        catch (JsonException) { }
        return set;
    }

    /// <summary>The searchable text: every "text" string in the blocks, in order.</summary>
    private static string TextOf(JsonElement content)
    {
        var sb = new StringBuilder();
        void Walk(JsonElement e)
        {
            if (e.ValueKind == JsonValueKind.Object)
            {
                foreach (var p in e.EnumerateObject())
                    if (p.Value.ValueKind == JsonValueKind.String && p.Name is "text" or "label" or "name") { if (sb.Length > 0) sb.Append(' '); sb.Append(p.Value.GetString()); }
                    else Walk(p.Value);
            }
            else if (e.ValueKind == JsonValueKind.Array) foreach (var x in e.EnumerateArray()) Walk(x);
        }
        Walk(content);
        return sb.Length > 20_000 ? sb.ToString(0, 20_000) : sb.ToString();
    }

    private async Task<NoteDto> DtoAsync(Note n, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var shared = ReadGuids(n.SharedWithJson);
        var editors = new[] { n.CreatedBy, n.UpdatedBy }.Where(x => x != null).Select(x => x!.Value).Distinct().ToList();
        var names = await NamesAsync(shared.Append(n.OwnerId).Concat(editors), ct);
        List<NoteLinkDto> links;
        try { links = JsonSerializer.Deserialize<List<NoteLinkDto>>(n.LinksJson, Json) ?? []; } catch (JsonException) { links = []; }
        using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(n.ContentJson) ? "[]" : n.ContentJson);
        return new NoteDto(n.Id, n.Title, doc.RootElement.Clone(), n.Folder, SplitTags(n.Tags), n.Pinned, n.Sharing, Ref(names, n.OwnerId),
            shared.Select(u => Ref(names, u)).ToList(), links, n.ProjectId, n.MeetingId, n.OwnerId == me, true,
            editors.Select(u => Ref(names, u)).ToList(), n.CreatedAt, n.UpdatedAt ?? n.CreatedAt);
    }

    private static List<Guid> ReadGuids(string json)
    {
        try { return JsonSerializer.Deserialize<List<Guid>>(json, Json) ?? []; } catch (JsonException) { return []; }
    }

    private static string CleanTag(string t) => (t ?? "").Trim().TrimStart('#').ToLowerInvariant().Replace(",", "").Replace(" ", "-");
    private static List<string> SplitTags(string tags) => tags.Split(',', StringSplitOptions.RemoveEmptyEntries).ToList();
    private static string Snippet(string text) => text.Length > 140 ? text[..140] : text;
    private static UserRefDto Ref(IReadOnlyDictionary<Guid, string> names, Guid id) => new(id, names.GetValueOrDefault(id) ?? "Former member");

    private async Task<Dictionary<Guid, string>> NamesAsync(IEnumerable<Guid> ids, CancellationToken ct)
    {
        var list = ids.Distinct().ToList();
        return list.Count == 0 ? [] : await db.Users.AsNoTracking().Where(u => list.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
    }
}
