using System.Net;
using System.Text;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Invoices people can keep: the PDF of a paid invoice with the seller's and the buyer's details, and who may see it.</summary>
[Collection("api")]
public class InvoiceTests(ApiFactory factory)
{
    private async Task<TestClient> Admin()
    {
        var c = await TestClient.RegisterAsync(factory, "Invoice Admin");
        factory.WithDb(db => { db.Users.IgnoreQueryFilters().Where(u => u.Id == c.UserId).ExecuteUpdate(s => s.SetProperty(u => u.IsPlatformAdmin, true)); return 0; });
        await c.LoginAsync();
        return c;
    }

    private async Task<(TestClient Owner, string InvoiceId)> PaidOwner()
    {
        var owner = await TestClient.RegisterAsync(factory, "Invoice Owner");
        await owner.CreateOrgAsync("Acme Works");
        await owner.UpgradeAsync("PRO");                       // simulated payment: one paid invoice
        var overview = await owner.Get("/api/v1/billing");
        return (owner, overview.Data!["invoices"]![0]!["id"]!.GetValue<string>());
    }

    private static async Task<(HttpStatusCode Status, string? Type, string? Disposition, byte[] Bytes)> Pdf(TestClient c, string id)
    {
        using var res = await c.Raw($"/api/v1/billing/invoices/{id}/pdf");
        return (res.StatusCode, res.Content.Headers.ContentType?.MediaType, res.Content.Headers.ContentDisposition?.FileNameStar ?? res.Content.Headers.ContentDisposition?.FileName, await res.Content.ReadAsByteArrayAsync());
    }

    private static string Text(byte[] pdf) => Encoding.Latin1.GetString(pdf);

    [Fact]
    public async Task A_paid_invoice_downloads_as_a_pdf_with_the_seller_and_buyer_details_and_the_amount()
    {
        var admin = await Admin();
        var seller = await admin.Put("/api/v1/admin/invoice-seller", new { legalName = "Qruize Technologies Pvt Ltd", address = "12 MG Road\nBengaluru 560001", taxId = "29ABCDE1234F1Z5", email = "billing@qruize.test", note = "Amount includes GST at 18%." });
        Assert.True(seller.Ok, seller.ToString());

        var (owner, id) = await PaidOwner();
        Assert.True((await owner.Put("/api/v1/billing/details", new { name = "Acme Works Private Limited", address = "5 Park Street\nKolkata 700016", taxId = "19AAACA1234B1Z9" })).Ok);

        var (status, type, disposition, bytes) = await Pdf(owner, id);
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal("application/pdf", type);
        Assert.StartsWith("Invoice-INV-", disposition);
        var text = Text(bytes);
        Assert.StartsWith("%PDF-1.4", text);
        Assert.EndsWith("%%EOF\n", text);
        Assert.Contains("Qruize Technologies Pvt Ltd", text);
        Assert.Contains("29ABCDE1234F1Z5", text);
        Assert.Contains("Acme Works Private Limited", text);
        Assert.Contains("19AAACA1234B1Z9", text);
        Assert.Contains("Kolkata 700016", text);
        Assert.Contains("INR 999.00", text);
        Assert.Contains("Amount includes GST at 18%.", text);
        Assert.Contains("Pro plan", text);
    }

    [Fact]
    public async Task Without_billing_details_the_invoice_is_made_out_to_the_workspace_and_special_characters_are_safe()
    {
        var admin = await Admin();
        Assert.True((await admin.Put("/api/v1/admin/invoice-seller", new { legalName = "", address = "", taxId = "", email = "", note = "" })).Ok);   // the shared test database may hold another test's seller
        var (owner, id) = await PaidOwner();
        var text = Text((await Pdf(owner, id)).Bytes);
        Assert.Contains("Acme Works", text);
        Assert.Contains("Project Tracker", text);                  // no seller set yet: the product name
        Assert.True((await owner.Put("/api/v1/billing/details", new { name = "Smith (Pvt) \\ Sons ₹", address = "", taxId = "" })).Ok);
        var again = Text((await Pdf(owner, id)).Bytes);
        Assert.Contains("Smith \\(Pvt\\) \\\\ Sons ?", again);      // escaped for PDF; the rupee sign has no glyph in the standard fonts
        Assert.StartsWith("%PDF-1.4", again);
    }

    [Fact]
    public async Task Only_paid_invoices_download_and_nobody_can_fetch_another_workspaces_invoice_or_without_billing_permission()
    {
        var (owner, id) = await PaidOwner();
        var other = await TestClient.RegisterAsync(factory, "Other Owner");
        await other.CreateOrgAsync();
        Assert.Equal(HttpStatusCode.NotFound, (await Pdf(other, id)).Status);

        factory.WithDb(db => { db.Invoices.IgnoreQueryFilters().Where(i => i.Id == Guid.Parse(id)).ExecuteUpdate(s => s.SetProperty(i => i.Status, InvoiceStatus.Failed)); return 0; });
        Assert.Equal(HttpStatusCode.Conflict, (await Pdf(owner, id)).Status);
        factory.WithDb(db => { db.Invoices.IgnoreQueryFilters().Where(i => i.Id == Guid.Parse(id)).ExecuteUpdate(s => s.SetProperty(i => i.Status, InvoiceStatus.Paid)); return 0; });

        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Plain Member");
        Assert.Equal(HttpStatusCode.Forbidden, (await Pdf(member, id)).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get("/api/v1/billing/details")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Put("/api/v1/billing/details", new { name = "x", address = "", taxId = "" })).Status);
    }

    [Fact]
    public async Task Seller_details_are_for_platform_administrators_and_too_long_values_are_refused()
    {
        var plain = await TestClient.RegisterAsync(factory, "Plain Person");
        Assert.Equal(HttpStatusCode.Forbidden, (await plain.Get("/api/v1/admin/invoice-seller")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await plain.Put("/api/v1/admin/invoice-seller", new { legalName = "x", address = "", taxId = "", email = "", note = "" })).Status);

        var admin = await Admin();
        var tooLong = await admin.Put("/api/v1/admin/invoice-seller", new { legalName = new string('x', 200), address = "", taxId = "", email = "", note = "" });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, tooLong.Status);
        Assert.True((await admin.Put("/api/v1/admin/invoice-seller", new { legalName = "Seller One", address = "", taxId = "", email = "", note = "" })).Ok);
        Assert.Equal("Seller One", (await admin.Get("/api/v1/admin/invoice-seller")).Data!["legalName"]!.GetValue<string>());
    }
}
