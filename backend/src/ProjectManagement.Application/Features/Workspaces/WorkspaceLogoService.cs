using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Workspaces;

public record LogoDto(bool HasLogo, int? Width, int? Height);

/// <summary>The workspace's logo, printed on the cover and pages of document PDFs. A PNG or JPEG up to 1 MB; owners and admins change it.</summary>
public class WorkspaceLogoService(IAppDbContext db, ICurrentContext ctx, IFileStorage storage, Recorder recorder)
{
    public const long MaxBytes = 1_048_576;

    private void RequireManage()
    {
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only owners and admins can change the logo.", "PERMISSION_DENIED");
    }

    public async Task<LogoDto> GetAsync(CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var key = await db.Tenants.AsNoTracking().Where(t => t.Id == tid).Select(t => t.LogoKey).FirstOrDefaultAsync(ct);
        if (key is null) return new LogoDto(false, null, null);
        var bytes = await ReadAsync(key, ct);
        try { var img = PdfImage.Read(bytes); return new LogoDto(true, img.Width, img.Height); } catch (FormatException) { return new LogoDto(true, null, null); }
    }

    public async Task<LogoDto> SetAsync(Stream content, long length, CancellationToken ct = default)
    {
        RequireManage();
        var tid = ctx.RequireTenantId();
        if (length is <= 0 or > MaxBytes) throw new ValidationException("file", "The logo can be up to 1 MB.");
        using var ms = new MemoryStream(); await content.CopyToAsync(ms, ct);
        var bytes = ms.ToArray();
        var kind = PdfImage.Kind(bytes) ?? throw new ValidationException("file", "Use a PNG or JPEG picture.");
        PdfImage img;
        try { img = PdfImage.Read(bytes); } catch (FormatException e) { throw new ValidationException("file", e.Message); }
        var tenant = await db.Tenants.FirstAsync(t => t.Id == tid, ct);
        var old = tenant.LogoKey;
        var key = $"{tid:N}/branding/logo-{Guid.NewGuid():N}";
        ms.Position = 0;
        await storage.SaveAsync(key, ms, ct);
        tenant.LogoKey = key; tenant.LogoContentType = kind;
        recorder.Audit("workspace.logo_changed", "Tenant", tid, null, new { kind, img.Width, img.Height, size = length }, tenantId: tid);
        await db.SaveChangesAsync(ct);
        if (old is not null) await storage.DeleteAsync(old, ct);
        return new LogoDto(true, img.Width, img.Height);
    }

    public async Task<LogoDto> RemoveAsync(CancellationToken ct = default)
    {
        RequireManage();
        var tid = ctx.RequireTenantId();
        var tenant = await db.Tenants.FirstAsync(t => t.Id == tid, ct);
        if (tenant.LogoKey is { } old) { await storage.DeleteAsync(old, ct); tenant.LogoKey = null; tenant.LogoContentType = null; recorder.Audit("workspace.logo_removed", "Tenant", tid, null, null, tenantId: tid); await db.SaveChangesAsync(ct); }
        return new LogoDto(false, null, null);
    }

    public async Task<(byte[] Bytes, string ContentType)?> OpenAsync(CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        var t = await db.Tenants.AsNoTracking().Where(x => x.Id == tid).Select(x => new { x.LogoKey, x.LogoContentType }).FirstOrDefaultAsync(ct);
        return t?.LogoKey is null ? null : (await ReadAsync(t.LogoKey, ct), t.LogoContentType ?? "image/png");
    }

    /// <summary>The logo of a workspace for a PDF, or null when there is none or it cannot be read.</summary>
    public async Task<PdfImage?> ForPdfAsync(Guid tenantId, CancellationToken ct = default)
    {
        var key = await db.Tenants.AsNoTracking().Where(t => t.Id == tenantId).Select(t => t.LogoKey).FirstOrDefaultAsync(ct);
        if (key is null) return null;
        try { return PdfImage.Read(await ReadAsync(key, ct)); } catch (Exception e) when (e is FormatException or IOException) { return null; }
    }

    private async Task<byte[]> ReadAsync(string key, CancellationToken ct)
    {
        await using var s = await storage.OpenReadAsync(key, ct) ?? throw new NotFoundException("Logo not found.");
        using var ms = new MemoryStream(); await s.CopyToAsync(ms, ct); return ms.ToArray();
    }
}
