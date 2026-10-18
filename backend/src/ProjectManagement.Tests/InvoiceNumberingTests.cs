using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Billing;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Paid invoices are tax invoices: numbered in one unbroken sequence per Indian financial year (April to March).</summary>
[Collection("api")]
public class InvoiceNumberingTests(ApiFactory factory)
{
    [Theory]
    [InlineData(2026, 3, 31, 19, 0, "26-27")]    // 31 March 19:00 UTC is already 00:30 on 1 April in India
    [InlineData(2026, 3, 31, 12, 0, "25-26")]
    [InlineData(2026, 4, 1, 0, 0, "26-27")]
    [InlineData(2027, 1, 15, 9, 0, "26-27")]
    [InlineData(2099, 12, 1, 9, 0, "99-00")]
    public void The_financial_year_follows_india_time(int y, int m, int d, int h, int min, string expected) =>
        Assert.Equal(expected, BillingService.FinancialYear(new DateTime(y, m, d, h, min, 0, DateTimeKind.Utc)));

    [Fact]
    public void Numbers_fit_the_gst_limit_of_sixteen_characters() =>
        Assert.Equal("INV/26-27/000042", BillingService.FormatInvoiceNumber("26-27", 42));

    [Fact]
    public async Task Each_call_takes_the_next_number_and_a_new_year_starts_at_one()
    {
        var year = "t" + Random.Shared.Next(1000, 9999);   // a sequence of its own in the shared test database
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ProjectManagement.Infrastructure.Persistence.AppDbContext>();
        var first = await db.NextInvoiceNumberAsync(year, default);
        var second = await db.NextInvoiceNumberAsync(year, default);
        Assert.Equal(1, first);
        Assert.Equal(2, second);
    }
}
