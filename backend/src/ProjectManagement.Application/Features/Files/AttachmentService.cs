using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Issues;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Files;

public record AttachmentDto(Guid Id, Guid ProjectId, Guid? TaskId, string? TaskKey, string? TaskTitle, string FileName, string ContentType, long SizeBytes,
    UserRefDto? UploadedBy, DateTime CreatedAt, bool CanDelete, bool IsImage, Guid? IssueId = null);

public record AttachmentLimitsDto(long MaxFileBytes, long StorageLimitBytes, long StorageUsedBytes, IReadOnlyList<string> AllowedExtensions);

public enum FileKind { Png, Jpeg, Gif, Webp, Pdf, Zip, Ole, Text }

/// <summary>What may be uploaded. The extension decides the type, and the first bytes of the file must agree with it.</summary>
public static class FileRules
{
    public const long Mb = 1024 * 1024;
    /// <summary>Hard ceiling regardless of plan (the plan's own limit is usually lower).</summary>
    public const long AbsoluteMaxBytes = 512 * Mb;
    public const int MaxPerTask = 50;

    private static readonly Dictionary<string, (string ContentType, FileKind Kind)> Allowed = new(StringComparer.OrdinalIgnoreCase)
    {
        ["pdf"] = ("application/pdf", FileKind.Pdf),
        ["png"] = ("image/png", FileKind.Png), ["jpg"] = ("image/jpeg", FileKind.Jpeg), ["jpeg"] = ("image/jpeg", FileKind.Jpeg),
        ["gif"] = ("image/gif", FileKind.Gif), ["webp"] = ("image/webp", FileKind.Webp),
        ["docx"] = ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", FileKind.Zip),
        ["xlsx"] = ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", FileKind.Zip),
        ["pptx"] = ("application/vnd.openxmlformats-officedocument.presentationml.presentation", FileKind.Zip),
        ["zip"] = ("application/zip", FileKind.Zip),
        ["doc"] = ("application/msword", FileKind.Ole), ["xls"] = ("application/vnd.ms-excel", FileKind.Ole), ["ppt"] = ("application/vnd.ms-powerpoint", FileKind.Ole),
        ["csv"] = ("text/csv", FileKind.Text), ["txt"] = ("text/plain", FileKind.Text), ["md"] = ("text/markdown", FileKind.Text),
    };

    public static IReadOnlyList<string> Extensions => Allowed.Keys.OrderBy(k => k).ToList();

    /// <summary>File name without any path, control characters or trailing dots/spaces; at most 150 characters (extension kept).</summary>
    public static string CleanName(string? raw)
    {
        var name = (raw ?? "").Replace('\\', '/');
        name = name[(name.LastIndexOf('/') + 1)..];
        var sb = new StringBuilder();
        foreach (var c in name.Normalize()) if (!char.IsControl(c) && c != '"' && c != ':' && c != '*' && c != '?' && c != '<' && c != '>' && c != '|') sb.Append(c);
        name = sb.ToString().Trim().TrimEnd('.', ' ');
        if (name.Length > 150)
        {
            var ext = Path.GetExtension(name);
            name = name[..(150 - ext.Length)].TrimEnd() + ext;
        }
        return name;
    }

    public static bool TryDescribe(string fileName, out string contentType, out FileKind kind)
    {
        var ext = Path.GetExtension(fileName).TrimStart('.');
        if (ext.Length > 0 && Allowed.TryGetValue(ext, out var t)) { (contentType, kind) = t; return true; }
        (contentType, kind) = ("", default);
        return false;
    }

    public static bool IsImage(string contentType) => contentType is "image/png" or "image/jpeg" or "image/gif" or "image/webp";

    /// <summary>True when the first bytes fit what the extension claims (so an .exe cannot pass as a .png).</summary>
    public static bool LooksLike(FileKind kind, ReadOnlySpan<byte> h) => kind switch
    {
        FileKind.Png => h.StartsWith((ReadOnlySpan<byte>)[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        FileKind.Jpeg => h.StartsWith((ReadOnlySpan<byte>)[0xFF, 0xD8, 0xFF]),
        FileKind.Gif => h.StartsWith("GIF8"u8),
        FileKind.Webp => h.Length >= 12 && h[..4].SequenceEqual("RIFF"u8) && h[8..12].SequenceEqual("WEBP"u8),
        FileKind.Pdf => h.StartsWith("%PDF"u8),
        FileKind.Zip => h.StartsWith((ReadOnlySpan<byte>)[0x50, 0x4B, 0x03, 0x04]) || h.StartsWith((ReadOnlySpan<byte>)[0x50, 0x4B, 0x05, 0x06]),
        FileKind.Ole => h.StartsWith((ReadOnlySpan<byte>)[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]),
        FileKind.Text => !h.Contains((byte)0),
        _ => false,
    };
}

/// <summary>Read-only wrapper that hashes and counts what passes through while it is being stored.</summary>
internal sealed class HashingReadStream(Stream inner) : Stream
{
    private readonly IncrementalHash _hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
    public long Total { get; private set; }
    public string Hex() => Convert.ToHexString(_hash.GetHashAndReset()).ToLowerInvariant();

    public override int Read(byte[] buffer, int offset, int count) => Track(buffer.AsSpan(offset, inner.Read(buffer, offset, count)));
    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
    {
        var n = await inner.ReadAsync(buffer, ct);
        Track(buffer.Span[..n]);
        return n;
    }
    private int Track(Span<byte> read) { _hash.AppendData(read); Total += read.Length; return read.Length; }

    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    protected override void Dispose(bool disposing) { if (disposing) _hash.Dispose(); base.Dispose(disposing); }
}

/// <summary>
/// Files on projects and tasks. Enforced here (never in the browser): who may see / add / remove a file, allowed types, the plan's file-size and
/// storage limits, and tenant isolation. The bytes go to <see cref="IFileStorage"/>; the database only keeps metadata.
/// </summary>
public class AttachmentService(IAppDbContext db, ICurrentContext ctx, PermissionService permissions, EntitlementService entitlements,
    ProjectAccess access, IFileStorage storage, Recorder recorder, AppClock clock, IssueService issues, ILogger<AttachmentService> log)
{
    private static string Mb(long bytes) => bytes % FileRules.Mb == 0 ? $"{bytes / FileRules.Mb} MB" : $"{bytes / (double)FileRules.Mb:0.#} MB";

    // ---------------------------------------------------------------- read

    public async Task<AttachmentLimitsDto> LimitsAsync(CancellationToken ct = default)
    {
        var (file, total) = (await entitlements.GetValueAsync(FeatureKeys.MaxFileSizeMb, ct), await entitlements.GetValueAsync(FeatureKeys.StorageLimitMb, ct));
        return new AttachmentLimitsDto(file < 0 ? FileRules.AbsoluteMaxBytes : Math.Min(file * FileRules.Mb, FileRules.AbsoluteMaxBytes),
            total < 0 ? -1 : total * FileRules.Mb, await entitlements.StorageUsedBytesAsync(ct), FileRules.Extensions);
    }

    /// <summary>
    /// Files of a project. With <paramref name="taskId"/>, only that task's files; with <paramref name="issueId"/>, only the supporting documents of that test issue;
    /// otherwise project-level files and (if the role can open tasks) task files. Issue documents are never mixed into the project's own list.
    /// </summary>
    public async Task<IReadOnlyList<AttachmentDto>> ListAsync(Guid projectId, Guid? taskId, Guid? issueId = null, CancellationToken ct = default)
    {
        await access.GetProjectAsync(projectId, ct);
        var seesTasks = await permissions.LevelAsync(Modules.Tasks, ct) > 0;
        var q = db.Attachments.AsNoTracking().Where(a => a.ProjectId == projectId);
        if (issueId is { } iid)
        {
            await issues.RequireVisibleAsync(projectId, iid, ct);
            var docs = await q.Where(a => a.IssueId == iid).OrderByDescending(a => a.CreatedAt).Take(500).ToListAsync(ct);
            return await ToDtosAsync(docs, ct);
        }
        q = q.Where(a => a.IssueId == null);
        if (taskId is { } t)
        {
            if (!seesTasks) throw new ForbiddenException("Your role does not have access to Tasks.", "MODULE_ACCESS_DENIED");
            if (!await access.VisibleTasks().AnyAsync(x => x.Id == t && x.ProjectId == projectId, ct)) throw new NotFoundException("Task not found.");
            q = q.Where(a => a.TaskId == t);
        }
        else if (!seesTasks) q = q.Where(a => a.TaskId == null);
        else q = q.Where(a => a.TaskId == null || access.VisibleTasks().Any(x => x.Id == a.TaskId)); // guests only see files of tasks they can see

        var rows = await q.OrderByDescending(a => a.CreatedAt).Take(500).ToListAsync(ct);
        return await ToDtosAsync(rows, ct);
    }

    private async Task<IReadOnlyList<AttachmentDto>> ToDtosAsync(List<Attachment> rows, CancellationToken ct)
    {
        var people = rows.Where(r => r.CreatedBy != null).Select(r => r.CreatedBy!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var taskIds = rows.Where(r => r.TaskId != null).Select(r => r.TaskId!.Value).Distinct().ToList();
        var tasks = await db.Tasks.AsNoTracking().Where(t => taskIds.Contains(t.Id)).Select(t => new { t.Id, t.Title, t.Number, Key = t.Project!.Key }).ToDictionaryAsync(t => t.Id, ct);
        var manager = await permissions.HasAsync(Permissions.ProjectsEdit, ct);
        var taskManager = await permissions.HasAsync(Permissions.TasksDelete, ct);
        return rows.Select(r => new AttachmentDto(r.Id, r.ProjectId, r.TaskId,
            r.TaskId is { } t && tasks.TryGetValue(t, out var task) ? $"{task.Key}-{task.Number}" : null,
            r.TaskId is { } t2 && tasks.TryGetValue(t2, out var task2) ? task2.Title : null,
            r.FileName, r.ContentType, r.SizeBytes,
            r.CreatedBy is { } u && names.TryGetValue(u, out var n) ? new UserRefDto(u, n) : null, r.CreatedAt,
            CanDelete(r, manager, taskManager), FileRules.IsImage(r.ContentType), r.IssueId)).ToList();
    }

    private bool CanDelete(Attachment a, bool projectManager, bool taskManager) =>
        a.CreatedBy == ctx.UserId || (a.TaskId is null ? projectManager : taskManager);

    // ---------------------------------------------------------------- upload

    /// <summary>Adds a file to a task (<paramref name="taskId"/>), to a test issue (<paramref name="issueId"/>) or, when both are null, to the project itself.</summary>
    public async Task<AttachmentDto> UploadAsync(Guid projectId, Guid? taskId, string? fileName, Stream content, long length, CancellationToken ct = default, Guid? issueId = null)
    {
        var tid = ctx.RequireTenantId();
        var project = await access.GetProjectAsync(projectId, ct);
        StageIssue? issue = null;
        if (issueId is { } iid) issue = await issues.RequireCanAttachAsync(project, iid, ct);
        else if (taskId is { } t)
        {
            await permissions.RequireModuleAsync(Modules.Tasks, AccessLevel.Edit, ct);
            var taskEntity = await access.VisibleTasks().FirstOrDefaultAsync(x => x.Id == t && x.ProjectId == projectId, ct) ?? throw new NotFoundException("Task not found.");
            await permissions.RequireTaskEditAsync(taskEntity, ct);
            if (await db.Attachments.CountAsync(a => a.TaskId == t, ct) >= FileRules.MaxPerTask)
                throw new ValidationException("file", $"A task can have up to {FileRules.MaxPerTask} files.");
        }
        else await access.RequireProjectEditAsync(project, ct);

        var stored = await StoreAsync(fileName, content, length, ct);
        var (name, contentType, key) = (stored.Name, stored.ContentType, stored.Key);

        var attachment = new Attachment
        {
            TenantId = tid, ProjectId = projectId, TaskId = taskId, IssueId = issueId, FileName = name, ContentType = contentType, SizeBytes = length,
            StorageKey = key, Sha256 = stored.Sha256, CreatedAt = clock.Now, CreatedBy = ctx.UserId,
        };
        db.Attachments.Add(attachment);
        var where = project.Key;
        if (taskId is { } tk)
        {
            var info = await db.Tasks.Where(x => x.Id == tk).Select(x => new { x.Project!.Key, x.Number }).FirstAsync(ct);
            where = $"{info.Key}-{info.Number}";
        }
        if (issue is not null) where = IssueService.KeyOf(project.Key, issue.Number);
        recorder.Activity("attachment.added", issue is not null ? "Issue" : taskId is null ? "Project" : "Task", issueId ?? taskId ?? projectId, $"Attached “{name}” to {where}", projectId);
        try { await db.SaveChangesAsync(ct); }
        catch { await storage.DeleteAsync(key, CancellationToken.None); throw; }
        return (await ToDtosAsync([attachment], ct))[0];
    }

    /// <summary>What was saved: the cleaned name, the type decided from the extension, where the bytes are, and their hash.</summary>
    public sealed record StoredFile(string Name, string ContentType, string Key, string Sha256);

    /// <summary>
    /// Checks a file (type by extension, content that agrees with it, the plan's size and storage limits) and saves its bytes. Whoever calls this adds the
    /// metadata row, and must delete the stored bytes again if that fails.
    /// </summary>
    public async Task<StoredFile> StoreAsync(string? fileName, Stream content, long length, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        // ---- what kind of file, and does it fit the plan?
        var name = FileRules.CleanName(fileName);
        if (name.Length == 0) throw new ValidationException("file", "The file has no name.");
        if (!FileRules.TryDescribe(name, out var contentType, out var kind))
            throw new ValidationException("file", $"“{Path.GetExtension(name)}” files are not allowed. Allowed: {string.Join(", ", FileRules.Extensions)}.");
        if (length <= 0) throw new ValidationException("file", "The file is empty.");
        if (length > FileRules.AbsoluteMaxBytes) throw new AppException(413, "FILE_TOO_LARGE", $"Files can be at most {Mb(FileRules.AbsoluteMaxBytes)}.");

        var limits = await LimitsAsync(ct);
        if (length > limits.MaxFileBytes)
            throw new AppException(403, "PLAN_LIMIT_REACHED", $"This file is {Mb(length)}. Your plan allows files up to {Mb(limits.MaxFileBytes)}. Upgrade your plan to upload larger files.");
        if (limits.StorageLimitBytes >= 0 && limits.StorageUsedBytes + length > limits.StorageLimitBytes)
            throw new AppException(403, "PLAN_LIMIT_REACHED", $"Not enough storage left on your plan ({Mb(Math.Max(0, limits.StorageLimitBytes - limits.StorageUsedBytes))} free of {Mb(limits.StorageLimitBytes)}). Delete files or upgrade your plan.");

        // ---- does the content match the extension?
        if (!content.CanSeek) throw new InvalidOperationException("Uploads must be seekable streams.");
        var header = new byte[8192];
        var read = 0;
        for (int n; read < header.Length && (n = await content.ReadAsync(header.AsMemory(read), ct)) > 0;) read += n;
        content.Position = 0;
        if (!FileRules.LooksLike(kind, header.AsSpan(0, read)))
            throw new ValidationException("file", $"The content of “{name}” does not look like a {Path.GetExtension(name).TrimStart('.').ToUpperInvariant()} file.");

        // ---- store the bytes, then the metadata; never leave an orphan file behind
        var key = $"{tid:N}/{clock.Now:yyyyMM}/{Guid.NewGuid():N}";
        using var hashing = new HashingReadStream(content);
        await storage.SaveAsync(key, hashing, ct);
        if (hashing.Total != length)
        {
            await storage.DeleteAsync(key, ct);
            throw new ValidationException("file", "The upload was incomplete. Please try again.");
        }
        return new StoredFile(name, contentType, key, hashing.Hex());
    }

    // ---------------------------------------------------------------- download / delete

    private async Task<Attachment> FindVisibleAsync(Guid id, CancellationToken ct)
    {
        var a = await db.Attachments.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new NotFoundException("File not found.");
        await access.GetProjectAsync(a.ProjectId, ct); // hides files of projects the person cannot see (guests, deleted projects)
        if (a.TaskId is { } t)
        {
            await permissions.RequireModuleAsync(Modules.Tasks, AccessLevel.View, ct);
            if (!await access.VisibleTasks().AnyAsync(x => x.Id == t, ct)) throw new NotFoundException("File not found.");
        }
        else if (a.IssueId is { } issue)
        {
            await permissions.RequireModuleAsync(Modules.Tasks, AccessLevel.View, ct);
            await issues.RequireVisibleAsync(a.ProjectId, issue, ct);
        }
        else await permissions.RequireModuleAsync(Modules.Projects, AccessLevel.View, ct);
        return a;
    }

    /// <summary>Opens the file for download. The caller disposes the stream.</summary>
    public async Task<(Attachment File, Stream Content)> OpenAsync(Guid id, CancellationToken ct = default)
    {
        var a = await FindVisibleAsync(id, ct);
        var stream = await storage.OpenReadAsync(a.StorageKey, ct);
        if (stream is null)
        {
            log.LogError("Attachment {Id} is missing from storage ({Key})", id, a.StorageKey);
            throw new NotFoundException("This file is no longer available.");
        }
        return (a, stream);
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        var a = await FindVisibleAsync(id, ct);
        var manager = await permissions.HasAsync(Permissions.ProjectsEdit, ct);
        var taskManager = await permissions.HasAsync(Permissions.TasksDelete, ct);
        if (!CanDelete(a, manager, taskManager)) throw new ForbiddenException("You can only remove files you uploaded.", "PERMISSION_DENIED");

        db.Attachments.Remove(a);
        recorder.Audit("attachment.deleted", "Attachment", a.Id, new { a.FileName, a.SizeBytes, a.ProjectId, a.TaskId });
        recorder.Activity("attachment.deleted", a.IssueId is not null ? "Issue" : a.TaskId is null ? "Project" : "Task", a.IssueId ?? a.TaskId ?? a.ProjectId, $"Removed “{a.FileName}”", a.ProjectId);
        await db.SaveChangesAsync(ct);
        try { await storage.DeleteAsync(a.StorageKey, ct); }
        catch (Exception ex) { log.LogWarning(ex, "Could not delete stored file {Key}; it will be picked up by the next clean-up", a.StorageKey); }
    }
}

/// <summary>Background clean-up: files of deleted projects / tasks are removed for good once they have been gone for a while.</summary>
public class AttachmentJanitor(IAppDbContext db, IFileStorage storage, AppClock clock, ILogger<AttachmentJanitor> log)
{
    public async Task<int> PurgeOrphansAsync(TimeSpan olderThan, int batch = 200, CancellationToken ct = default)
    {
        var cutoff = clock.Now - olderThan;
        var stale = await db.Attachments.IgnoreQueryFilters()
            .Where(a => db.Projects.IgnoreQueryFilters().Any(p => p.Id == a.ProjectId && p.IsDeleted && p.DeletedAt != null && p.DeletedAt <= cutoff)
                     || (a.TaskId != null && db.Tasks.IgnoreQueryFilters().Any(t => t.Id == a.TaskId && t.IsDeleted && t.DeletedAt != null && t.DeletedAt <= cutoff)))
            .Take(batch).ToListAsync(ct);
        foreach (var a in stale)
        {
            try { await storage.DeleteAsync(a.StorageKey, ct); }
            catch (Exception ex) { log.LogWarning(ex, "Could not delete stored file {Key}", a.StorageKey); continue; }
            db.Attachments.Remove(a);
        }
        await db.SaveChangesAsync(ct);
        return stale.Count;
    }
}
