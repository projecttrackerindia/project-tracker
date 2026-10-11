using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Resumes;

public record CertificationRequest(string Name, string Issuer, DateOnly IssuedOn, DateOnly? ExpiresOn,
    string? CredentialId, string? VerificationUrl, bool ShowBadge, bool Archived, int Version, bool ExpiryReminders = true);
public record CertificationDto(Guid Id, string Name, string Issuer, DateOnly IssuedOn, DateOnly? ExpiresOn,
    string? CredentialId, string? VerificationUrl, bool ShowBadge, bool Archived, int Version,
    string VerificationStatus, bool ExpiryReminders, bool HasAttachment, string? AttachmentFormat);

public class CertificationService(IAppDbContext db, ICurrentContext ctx, Recorder recorder, IFileStorage storage, IResumeDocumentExtractor extractor, AppClock clock, PersonalFileCleanup cleanup, PersonalFileUpload uploads)
{
    private IQueryable<EmployeeCertification> Mine => db.EmployeeCertifications.Where(c => c.UserId == ctx.RequireUserId());
    private static CertificationDto Dto(EmployeeCertification c) => new(c.Id, c.Name, c.Issuer, c.IssuedOn, c.ExpiresOn,
        c.CredentialId, c.VerificationUrl, c.ShowBadge, c.Archived, c.Version, c.VerificationStatus,
        c.ExpiryReminders, c.AttachmentStorageKey is not null, c.AttachmentStorageKey is not null?Path.GetExtension(c.AttachmentFileName!).TrimStart((char)46):null);
    private async Task<EmployeeCertification> RequireAsync(Guid id, CancellationToken ct) =>
        await Mine.FirstOrDefaultAsync(c => c.Id == id, ct) ?? throw new NotFoundException("Certification not found.");

    public async Task<IReadOnlyList<CertificationDto>> ListAsync(CancellationToken ct) =>
        (await Mine.AsNoTracking().OrderBy(c => c.Archived).ThenBy(c => c.Name).Take(100).ToListAsync(ct)).Select(Dto).ToArray();

    public async Task<CertificationDto> SaveAsync(Guid? id, CertificationRequest req, CancellationToken ct)
    {
        var name = (req.Name ?? "").Trim(); var issuer = (req.Issuer ?? "").Trim();
        if (name.Length is 0 or > 200 || issuer.Length is 0 or > 200)
            throw new ValidationException("name", "Add a certification name and issuer, each up to 200 characters.");
        if(req.IssuedOn==default||req.IssuedOn>clock.Today)throw new ValidationException("issuedOn","Add the actual issue date, no later than today.");
        if (req.ExpiresOn < req.IssuedOn) throw new ValidationException("expiresOn", "Expiry cannot be earlier than issue date.");
        var url = req.VerificationUrl?.Trim();
        if (!string.IsNullOrEmpty(url) && (!Uri.TryCreate(url, UriKind.Absolute, out var parsed) || parsed.Scheme != "https" || parsed.UserInfo.Length > 0 || url.Length > 1000))
            throw new ValidationException("verificationUrl", "Use an HTTPS verification URL without embedded credentials.");
        if (req.CredentialId?.Length > 200) throw new ValidationException("credentialId", "Keep the credential identifier under 200 characters.");
        await using var tx=await db.Database.BeginOwnedTransactionAsync(ct);
        var uid=ctx.RequireUserId();
        var locked=await db.Users.Where(u=>u.Id==uid&&u.IsActive).ExecuteUpdateAsync(s=>s.SetProperty(u=>u.IsActive,u=>u.IsActive),ct);
        if(locked!=1)throw new ForbiddenException("Your account is unavailable.");
        EmployeeCertification row;
        if (id is null)
        {
            if (await Mine.CountAsync(ct) >= 100) throw new ConflictException("Keep at most 100 certification records.");
            row = new() { UserId = ctx.RequireUserId() }; db.EmployeeCertifications.Add(row);
        }
        else
        {
            row = await RequireAsync(id.Value, ct);
            if (row.Version != req.Version) throw new ConflictException("This certification changed. Reload before saving.");
            row.Version++;
        }
        if (row.ExpiresOn != req.ExpiresOn) { row.ReminderExpiry = null; row.ReminderStage = null; }
        row.ExpiryReminders = req.ExpiryReminders; row.Name = name; row.Issuer = issuer;
        row.IssuedOn = req.IssuedOn; row.ExpiresOn = req.ExpiresOn; row.CredentialId = req.CredentialId?.Trim();
        row.VerificationUrl = url; row.ShowBadge = req.ShowBadge; row.Archived = req.Archived;
        recorder.Audit("certification.saved", "EmployeeCertification", row.Id, null, new { row.Version });
        await db.SaveChangesAsync(ct);await tx.CommitIfOwnedAsync(ct); return Dto(row);
    }

    public async Task SetAttachmentAsync(Guid id, string fileName, Stream content, int version, CancellationToken ct)
    {
        var existing = await Mine.AsNoTracking().FirstOrDefaultAsync(c=>c.Id==id,ct)
            ?? throw new NotFoundException("Certification not found.");
        if (existing.Version != version) throw new ConflictException("This certification changed. Reload before attaching a file.");
        var ext = Path.GetExtension(fileName).ToLowerInvariant();
        if (ext is not (".pdf" or ".png" or ".jpg" or ".jpeg"))
            throw new ValidationException("file", "Use a PDF, PNG or JPEG certificate, up to 2 MB.");
        // Image/PDF parsing has the same process and managed-heap boundary as resume imports.
        var extracted=await extractor.ExtractAsync(fileName,content,ct,requireText:false);
        var bytes=extracted.Bytes;var type=extracted.ContentType;
        var key=$"certificates/{existing.UserId:N}/{id:N}/{Guid.NewGuid():N}";
        var uploadReceipt=await uploads.PrepareAsync(key,ct);
        await using(var stream=new MemoryStream(bytes))await storage.SaveAsync(key,stream,ct);

        // Parsing happens before acquiring a database lock. Recheck ownership, version and
        // the personal attachment cap inside the same transaction as the final update.
        await using var tx=await db.Database.BeginOwnedTransactionAsync(ct);
        var uid=ctx.RequireUserId();
        var locked=await db.Users.Where(u=>u.Id==uid&&u.IsActive)
            .ExecuteUpdateAsync(s=>s.SetProperty(u=>u.IsActive,u=>u.IsActive),ct);
        if(locked!=1)throw new ForbiddenException("Your account is unavailable.");
        var row=await RequireAsync(id,ct);
        if(row.Version!=version)throw new ConflictException("This certification changed. Reload before attaching a file.");
        if(row.AttachmentStorageKey is null&&await Mine.CountAsync(c=>c.AttachmentStorageKey!=null,ct)>=10)
            throw new ConflictException("Keep up to ten private certificate attachments. Remove an old attachment first.");
        var old = row.AttachmentStorageKey;
        await PersonalFileUpload.CompleteAsync(db,uploadReceipt,key,clock.Now,ct);
        row.AttachmentStorageKey = key; row.AttachmentContentType = type;
        row.AttachmentFileName = "certificate" + ext; row.Version++;
        recorder.Audit("certification.attachment_added", "EmployeeCertification", id, null, new { size = bytes.Length });
        if(old is not null)cleanup.Enqueue(old);
        await db.SaveChangesAsync(ct); await tx.CommitIfOwnedAsync(ct);

    }

    public async Task<(byte[] Bytes, string ContentType, string FileName)> OpenAttachmentAsync(Guid id, CancellationToken ct)
    {
        var row = await RequireAsync(id, ct);
        if (row.AttachmentStorageKey is not { } key) throw new NotFoundException("Attachment not found.");
        await using var stream = await storage.OpenReadAsync(key, ct) ?? throw new NotFoundException("Attachment not found.");
        using var buffer = new MemoryStream(); await stream.CopyToAsync(buffer, ct);
        return (buffer.ToArray(), row.AttachmentContentType!, row.AttachmentFileName!);
    }

    public async Task RemoveAttachmentAsync(Guid id, int version, CancellationToken ct)
    {
        var row = await RequireAsync(id, ct);
        if (row.Version != version) throw new ConflictException("This certification changed. Reload before removing a file.");
        if (row.AttachmentStorageKey is not { } key) return;
        cleanup.Enqueue(key);
        row.AttachmentStorageKey = null; row.AttachmentFileName = null; row.AttachmentContentType = null; row.Version++;
        recorder.Audit("certification.attachment_removed", "EmployeeCertification", id);
        await db.SaveChangesAsync(ct);
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct)
    {
        var row = await RequireAsync(id, ct);
        if (row.AttachmentStorageKey is { } key) cleanup.Enqueue(key);
        db.EmployeeCertifications.Remove(row); recorder.Audit("certification.deleted", "EmployeeCertification", id);
        await db.SaveChangesAsync(ct);
    }
}