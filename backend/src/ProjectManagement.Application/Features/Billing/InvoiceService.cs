using System.Globalization;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Reports;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Billing;

/// <summary>Who issues the invoices (set once by the platform administrator). <c>Note</c> is free text printed under the total, e.g. "Amount includes GST at 18%".</summary>
public record InvoiceSellerDto(string LegalName, string Address, string TaxId, string Email, string Note);
/// <summary>Who the invoices are made out to (set by the workspace's billing owner). Empty = the workspace name.</summary>
public record InvoiceBuyerDto(string Name, string Address, string TaxId);
public record InvoiceFile(string FileName, byte[] Bytes);

/// <summary>Invoices people can keep: the seller and buyer details, and the PDF of a paid invoice. The app never works out tax: the PDF shows what was charged and any note the administrator wrote.</summary>
public class InvoiceService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, PermissionService permissions)
{
    private const string SellerKey = "billing.seller";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    // ------------------------------------------------------------------ the seller (platform administrator)

    private void RequireAdmin() { if (!ctx.IsPlatformAdmin) throw new ForbiddenException("Platform administrators only.", "PERMISSION_DENIED"); }

    private async Task<InvoiceSellerDto> ReadSellerAsync(CancellationToken ct)
    {
        var raw = await db.PlatformSettings.AsNoTracking().Where(s => s.Key == SellerKey).Select(s => s.Value).FirstOrDefaultAsync(ct);
        try { if (!string.IsNullOrWhiteSpace(raw) && JsonSerializer.Deserialize<InvoiceSellerDto>(raw, Json) is { } s) return s; } catch (JsonException) { /* start again */ }
        return new InvoiceSellerDto("", "", "", "", "");
    }

    public async Task<InvoiceSellerDto> GetSellerAsync(CancellationToken ct = default) { RequireAdmin(); return await ReadSellerAsync(ct); }

    public async Task<InvoiceSellerDto> SetSellerAsync(InvoiceSellerDto req, CancellationToken ct = default)
    {
        RequireAdmin();
        var s = new InvoiceSellerDto(Clean(req.LegalName, 120, "legalName"), Clean(req.Address, 400, "address"), Clean(req.TaxId, 40, "taxId"), Clean(req.Email, 120, "email"), Clean(req.Note, 200, "note"));
        var row = await db.PlatformSettings.FirstOrDefaultAsync(x => x.Key == SellerKey, ct);
        var json = JsonSerializer.Serialize(s, Json);
        if (row is null) db.PlatformSettings.Add(new PlatformSetting { Key = SellerKey, Value = json, CreatedAt = clock.Now, CreatedBy = ctx.UserId });
        else { row.Value = json; row.UpdatedAt = clock.Now; }
        recorder.Audit("admin.invoice_seller_changed", "Platform", null, newValue: new { s.LegalName, s.TaxId });
        await db.SaveChangesAsync(ct);
        return s;
    }

    private static string Clean(string? value, int max, string field)
    {
        var v = (value ?? "").Replace("\r", "").Trim();
        if (v.Length > max) throw new ValidationException(field, $"Keep this under {max} characters.");
        return v;
    }

    // ------------------------------------------------------------------ the buyer (the workspace)

    public async Task<InvoiceBuyerDto> GetBuyerAsync(CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.BillingManage, ct);
        var t = await db.Tenants.AsNoTracking().FirstAsync(x => x.Id == ctx.RequireTenantId(), ct);
        return new InvoiceBuyerDto(t.BillingName ?? "", t.BillingAddress ?? "", t.BillingTaxId ?? "");
    }

    public async Task<InvoiceBuyerDto> SetBuyerAsync(InvoiceBuyerDto req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.BillingManage, ct);
        var t = await db.Tenants.FirstAsync(x => x.Id == ctx.RequireTenantId(), ct);
        t.BillingName = Clean(req.Name, 120, "name"); t.BillingAddress = Clean(req.Address, 400, "address"); t.BillingTaxId = Clean(req.TaxId, 40, "taxId");
        recorder.Audit("billing.details_changed", "Tenant", t.Id, newValue: new { t.BillingName, t.BillingTaxId });
        await db.SaveChangesAsync(ct);
        return new InvoiceBuyerDto(t.BillingName, t.BillingAddress, t.BillingTaxId);
    }

    // ------------------------------------------------------------------ the PDF

    public async Task<InvoiceFile> RenderAsync(Guid invoiceId, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.BillingManage, ct);
        var inv = await db.Invoices.AsNoTracking().FirstOrDefaultAsync(i => i.Id == invoiceId, ct) ?? throw new NotFoundException("Invoice not found.");
        if (inv.Status != InvoiceStatus.Paid) throw new ConflictException("Only a paid invoice can be downloaded. A failed payment has no invoice.", "INVOICE_NOT_PAID");
        var tenant = await db.Tenants.AsNoTracking().FirstAsync(t => t.Id == inv.TenantId, ct);
        var seller = await ReadSellerAsync(ct);
        var buyer = new InvoiceBuyerDto(string.IsNullOrWhiteSpace(tenant.BillingName) ? tenant.Name : tenant.BillingName, tenant.BillingAddress ?? "", tenant.BillingTaxId ?? "");
        return new InvoiceFile($"Invoice-{inv.Number}.pdf", InvoicePdf.Write(inv, seller, buyer));
    }
}

/// <summary>A one-page A4 invoice in the standard Helvetica fonts (so no font files). Amounts use the currency code, because the rupee sign is not in those fonts.</summary>
internal static class InvoicePdf
{
    private const double W = 595, H = 842, M = 48;
    private static string F(double v) => v.ToString("0.##", CultureInfo.InvariantCulture);

    public static string Money(decimal amount, string currency) => $"{currency} {amount.ToString("#,##0.00", CultureInfo.InvariantCulture)}";

    public static byte[] Write(Invoice inv, InvoiceSellerDto seller, InvoiceBuyerDto buyer)
    {
        var c = new StringBuilder();
        void Text(string font, double size, double x, double y, string text, string color = "0.1 0.08 0.2 rg") =>
            c.Append($"BT {color} /{font} {F(size)} Tf {F(x)} {F(y)} Td ({PdfWriter.Pdf(text)}) Tj ET\n");
        void Right(string font, double size, double xRight, double y, string text, string color = "0.1 0.08 0.2 rg") => Text(font, size, xRight - PdfWriter.Width(text, size) * (font == "F2" ? 1.08 : 1), y, text, color);
        void Rect(double x, double y, double w, double h, string fill) => c.Append($"{fill} {F(x)} {F(y)} {F(w)} {F(h)} re f\n");
        IEnumerable<string> Lines(string text) => text.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0);

        // Header band
        Rect(0, H - 96, W, 96, "0.486 0.227 0.929 rg");
        Text("F2", 22, M, H - 52, "Invoice", "1 g");
        Text("F1", 10, M, H - 72, seller.LegalName.Length > 0 ? seller.LegalName : "Project Tracker", "0.93 0.9 1 rg");
        Right("F2", 12, W - M, H - 52, inv.Number, "1 g");
        Right("F1", 10, W - M, H - 72, inv.IssuedAt.ToString("dd MMM yyyy", CultureInfo.InvariantCulture), "0.93 0.9 1 rg");

        // From / To
        double y = H - 140;
        Text("F2", 8.5, M, y, "FROM", "0.45 g");
        Text("F2", 8.5, W / 2 + 10, y, "BILL TO", "0.45 g");
        double yl = y - 16, yr = y - 16;
        foreach (var l in new[] { seller.LegalName.Length > 0 ? seller.LegalName : "Project Tracker" }.Concat(Lines(seller.Address)).Concat(seller.TaxId.Length > 0 ? [$"GSTIN / Tax ID: {seller.TaxId}"] : []).Concat(seller.Email.Length > 0 ? [seller.Email] : []))
        { Text(l == (seller.LegalName.Length > 0 ? seller.LegalName : "Project Tracker") ? "F2" : "F1", 10, M, yl, PdfWriter.Fit(l, W / 2 - M - 10, 10)); yl -= 14; }
        foreach (var l in new[] { buyer.Name }.Concat(Lines(buyer.Address)).Concat(buyer.TaxId.Length > 0 ? [$"GSTIN / Tax ID: {buyer.TaxId}"] : []))
        { Text(l == buyer.Name ? "F2" : "F1", 10, W / 2 + 10, yr, PdfWriter.Fit(l, W - M - W / 2 - 10, 10)); yr -= 14; }
        y = Math.Min(yl, yr) - 26;

        // Line items
        Rect(M, y - 4, W - 2 * M, 22, "0.93 0.91 0.99 rg");
        Text("F2", 9, M + 8, y + 3, "Description"); Right("F2", 9, W - M - 8, y + 3, "Amount");
        y -= 26;
        Text("F1", 10.5, M + 8, y, PdfWriter.Fit(inv.Description, W - 2 * M - 150, 10.5));
        Right("F1", 10.5, W - M - 8, y, Money(inv.Amount, inv.Currency));
        y -= 10;
        c.Append($"0.85 g {F(M)} {F(y)} {F(W - 2 * M)} 0.6 re f\n");
        y -= 30;

        // Total
        Right("F2", 11, W - M - 150, y, "Total paid");
        Right("F2", 14, W - M - 8, y, Money(inv.Amount, inv.Currency));
        y -= 30;
        if (seller.Note.Length > 0) { Right("F1", 9, W - M - 8, y, PdfWriter.Fit(seller.Note, W - 2 * M, 9), "0.35 g"); y -= 22; }

        // Payment
        y -= 18;
        Text("F2", 8.5, M, y, "PAYMENT", "0.45 g"); y -= 16;
        Text("F1", 10, M, y, $"Status: Paid"); y -= 14;
        if (!string.IsNullOrEmpty(inv.ProviderReference)) { Text("F1", 10, M, y, $"Reference: {inv.ProviderReference}"); y -= 14; }
        Text("F1", 10, M, y, $"Plan: {inv.PlanCode}"); y -= 14;

        Text("F1", 8, M, 36, "This invoice shows the amount charged. Amounts are in " + inv.Currency + ".", "0.5 g");

        var content = c.ToString();
        var objects = new List<string>
        {
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [5 0 R] /Count 1 >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
            $"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W} {H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents 6 0 R >>",
            $"<< /Length {Encoding.Latin1.GetByteCount(content)} >>\nstream\n{content}endstream",
        };
        using var ms = new MemoryStream();
        void Put(string s) { var b = Encoding.Latin1.GetBytes(s); ms.Write(b, 0, b.Length); }
        Put("%PDF-1.4\n");
        var offsets = new List<long>();
        for (var i = 0; i < objects.Count; i++) { offsets.Add(ms.Position); Put($"{i + 1} 0 obj\n{objects[i]}\nendobj\n"); }
        var xref = ms.Position;
        Put($"xref\n0 {objects.Count + 1}\n0000000000 65535 f \n");
        foreach (var o in offsets) Put($"{o:D10} 00000 n \n");
        Put($"trailer\n<< /Size {objects.Count + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n");
        return ms.ToArray();
    }
}
