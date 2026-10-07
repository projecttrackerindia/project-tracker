using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Documents;

public record SecretDto(Guid Id, string Label, string? Note, SensitivityClass Class, DateTime CreatedAt, DateTime? ValueChangedAt, UserRefDto? By);
public record SecretListDto(IReadOnlyList<SecretDto> Items, bool CanReveal, bool CanEdit, bool ConfidentialAllowed, int RevealSeconds);
public record SaveSecretRequest(string Label, string? Value, string? Note, SensitivityClass Class = SensitivityClass.Secret);
public record RevealRequest(string? StepUp);
public record RevealDto(string Value, int RevealSeconds);
public record StepUpRequest(string Code);
public record StepUpDto(string Token, DateTime ExpiresAt);

/// <summary>
/// Secrets kept with a document (keys, passwords, connection strings). The value is written once and never comes back except through a reveal, which needs
/// a permission, is limited in rate, is recorded whether it succeeds or not (who, which field, where from), and for the confidential class needs a two-step
/// check made in the last few minutes. The document's text holds only a reference. The screen hides a revealed value again after the time the
/// organization chose; that protects an unattended screen, not a copy that was already made, which is why the record matters more than the timer.
/// </summary>
public class SecretService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions, EntitlementService entitlements,
    DocumentAccessService rights, EnvelopeCrypto crypto, StepUpService stepUp)
{
    public const int MaxPerDocument = 100, MaxValueChars = 4096, ReleasesPerMinute = 30, DefaultRevealSeconds = 15;

    private static string Aad(Guid tenant, Guid document, Guid id) => $"{tenant:N}|{document:N}|{id:N}";

    private async Task<(Document Doc, DocumentRights Rights)> OpenAsync(Guid documentId, bool write, CancellationToken ct)
    {
        var doc = await db.Documents.AsNoTracking().FirstOrDefaultAsync(d => d.Id == documentId, ct) ?? throw new NotFoundException("Document not found.");
        var r = await rights.RightsAsync(doc, ct);
        if (write && !r.Edit) throw new ForbiddenException("You can read this document but not change its secrets.", "PERMISSION_DENIED");
        return (doc, r);
    }

    public async Task<int> RevealSecondsAsync(CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var s = await db.TenantSecuritySettings.AsNoTracking().Where(t => t.TenantId == tid).Select(t => (int?)t.RevealSeconds).FirstOrDefaultAsync(ct);
        return s is > 0 ? s.Value : DefaultRevealSeconds;
    }

    // ------------------------------------------------------------------ the list (labels only)

    public async Task<SecretListDto> ListAsync(Guid documentId, CancellationToken ct = default)
    {
        var (_, r) = await OpenAsync(documentId, false, ct);
        var rows = await db.SensitiveValues.AsNoTracking().Where(v => v.DocumentId == documentId).OrderBy(v => v.Label).ToListAsync(ct);
        var ids = rows.Where(v => v.CreatedBy != null).Select(v => v.CreatedBy!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return new SecretListDto(rows.Select(v => new SecretDto(v.Id, v.Label, v.Note, v.Class, v.CreatedAt, v.ValueChangedAt, v.CreatedBy is { } c ? new UserRefDto(c, names.GetValueOrDefault(c) ?? "Former member") : null)).ToList(),
            await permissions.HasAsync(Permissions.DocsSecrets, ct), r.Edit, await entitlements.GetValueAsync(FeatureKeys.AdvancedSecurity, ct) != 0, await RevealSecondsAsync(ct));
    }

    // ------------------------------------------------------------------ writing

    public async Task<SecretListDto> SaveAsync(Guid documentId, Guid? id, SaveSecretRequest req, CancellationToken ct = default)
    {
        var (doc, _) = await OpenAsync(documentId, true, ct);
        var tid = ctx.RequireTenantId();
        var label = (req.Label ?? "").Trim();
        if (label.Length is 0 or > 80) throw new ValidationException("label", "Name the secret (up to 80 characters), for example \"Production API key\".");
        var note = string.IsNullOrWhiteSpace(req.Note) ? null : req.Note.Trim();
        if (note is { Length: > 200 }) throw new ValidationException("note", "Keep the note under 200 characters. It is shown to everyone who opens the document: never put the secret in it.");
        if (!Enum.IsDefined(req.Class)) throw new ValidationException("class", "Choose how the value is protected.");
        if (req.Class == SensitivityClass.Confidential) await entitlements.EnsureFeatureAsync(FeatureKeys.AdvancedSecurity, ct);
        if (req.Value is { Length: > MaxValueChars }) throw new ValidationException("value", $"A secret can be up to {MaxValueChars:N0} characters.");

        SensitiveValue row;
        var now = clock.Now;
        var changedValue = !string.IsNullOrEmpty(req.Value);
        var dataKey = changedValue ? await crypto.ActiveKeyAsync(tid, ct) : null;   // before anything is added: creating a first key saves
        if (id is { } sid)
        {
            row = await db.SensitiveValues.FirstOrDefaultAsync(v => v.Id == sid && v.DocumentId == documentId, ct) ?? throw new NotFoundException("Secret not found.");
            if (await db.SensitiveValues.AnyAsync(v => v.DocumentId == documentId && v.Label == label && v.Id != sid, ct)) throw new ConflictException("This document already has a secret with that name.", "SECRET_EXISTS");
        }
        else
        {
            if (string.IsNullOrEmpty(req.Value)) throw new ValidationException("value", "Enter the value to protect.");
            if (await db.SensitiveValues.CountAsync(v => v.DocumentId == documentId, ct) >= MaxPerDocument) throw new ValidationException("label", $"A document keeps at most {MaxPerDocument} secrets.");
            if (await db.SensitiveValues.AnyAsync(v => v.DocumentId == documentId && v.Label == label, ct)) throw new ConflictException("This document already has a secret with that name.", "SECRET_EXISTS");
            row = new SensitiveValue { TenantId = tid, DocumentId = documentId, CreatedAt = now, CreatedBy = ctx.UserId };
            db.SensitiveValues.Add(row);
        }
        var before = id is null ? null : new { row.Label, row.Class };
        row.Label = label; row.Note = note; row.Class = req.Class; row.UpdatedAt = now;
        if (changedValue)
        {
            row.Cipher = crypto.Encrypt(dataKey!, req.Value!, Aad(tid, documentId, row.Id)); row.KeyVersion = dataKey!.Version; row.ValueChangedAt = now; row.ReencryptedAt = null;
        }
        recorder.Activity(id is null ? "document.secret_added" : "document.secret_changed", "Document", doc.Id, $"{(id is null ? "Added" : "Changed")} the secret \"{label}\" in {DocumentService.KeyOf(doc.Number)}", doc.ProjectId);
        recorder.Audit(id is null ? "document.secret_added" : "document.secret_changed", "Document", doc.Id, before, new { label, row.Class, valueChanged = changedValue });   // never the value
        await db.SaveChangesAsync(ct);
        return await ListAsync(documentId, ct);
    }

    public async Task<SecretListDto> DeleteAsync(Guid documentId, Guid id, CancellationToken ct = default)
    {
        var (doc, _) = await OpenAsync(documentId, true, ct);
        var row = await db.SensitiveValues.FirstOrDefaultAsync(v => v.Id == id && v.DocumentId == documentId, ct) ?? throw new NotFoundException("Secret not found.");
        db.SensitiveValues.Remove(row);
        recorder.Activity("document.secret_removed", "Document", doc.Id, $"Removed the secret \"{row.Label}\" from {DocumentService.KeyOf(doc.Number)}", doc.ProjectId);
        recorder.Audit("document.secret_removed", "Document", doc.Id, new { row.Label, row.Class });
        await db.SaveChangesAsync(ct);
        return await ListAsync(documentId, ct);
    }

    // ------------------------------------------------------------------ revealing

    public async Task<RevealDto> RevealAsync(Guid documentId, Guid id, RevealRequest req, CancellationToken ct = default)
    {
        var (doc, _) = await OpenAsync(documentId, false, ct);
        var row = await db.SensitiveValues.AsNoTracking().FirstOrDefaultAsync(v => v.Id == id && v.DocumentId == documentId, ct) ?? throw new NotFoundException("Secret not found.");
        var me = ctx.RequireUserId();

        async Task<Exception> Deny(string reason, Exception e)
        {
            recorder.Audit("document.secret_reveal_denied", "Document", doc.Id, null, new { secret = row.Label, row.Class, reason });
            await db.SaveChangesAsync(ct);
            return e;
        }

        if (!await permissions.HasAsync(Permissions.DocsSecrets, ct))
            throw await Deny("no permission", new ForbiddenException("You do not have permission to reveal secrets. Ask an administrator.", "SECRET_REVEAL_DENIED"));
        var since = clock.Now.AddMinutes(-1);
        if (await db.AuditLogs.CountAsync(a => a.UserId == me && a.CreatedAt > since && (a.Action == "document.secret_revealed" || a.Action == "document.secret_reveal_denied"), ct) >= ReleasesPerMinute)
            throw new TooManyRequestsException("Too many reveals in a minute. Wait a moment.", "SECRET_REVEAL_LIMITED");
        if (row.Class == SensitivityClass.Confidential && !await stepUp.IsFreshAsync(me, req.StepUp, ct))
            throw await Deny("no fresh two-step check", new ForbiddenException("This value needs a fresh two-step check. Confirm with your authenticator or passkey first.", "STEP_UP_REQUIRED"));

        string value;
        try { value = crypto.Decrypt(await crypto.KeyAsync(row.TenantId, row.KeyVersion, ct), row.Cipher, Aad(row.TenantId, row.DocumentId, row.Id)); }
        catch (Exception e) when (e is CryptographicException or FormatException or InvalidOperationException)
        {
            recorder.Audit("document.secret_unreadable", "Document", doc.Id, null, new { secret = row.Label, row.KeyVersion });
            await db.SaveChangesAsync(ct);
            throw new ConflictException("This value cannot be read (its key or its data was damaged). Enter it again.", "SECRET_UNREADABLE");
        }
        recorder.Audit("document.secret_revealed", "Document", doc.Id, null, new { secret = row.Label, row.Class });   // who and from where come with every audit row
        recorder.Activity("document.secret_revealed", "Document", doc.Id, $"Revealed the secret \"{row.Label}\" of {DocumentService.KeyOf(doc.Number)}", doc.ProjectId);
        await db.SaveChangesAsync(ct);
        return new RevealDto(value, await RevealSecondsAsync(ct));
    }
}
