using ProjectManagement.Application.Features.Billing;

namespace ProjectManagement.Tests;

public class BillingMailerTests
{
    [Fact]
    public void Rupees_use_the_rupee_sign_and_Indian_digit_grouping()
    {
        Assert.Equal("₹449.00", BillingMailer.Money(449m, "INR"));
        Assert.Equal("₹1,24,999.50", BillingMailer.Money(124999.5m, "INR"));
        Assert.Equal("USD 12.00", BillingMailer.Money(12m, "usd"));
    }

    [Fact]
    public void Dates_are_shown_in_India_time()
    {
        // 20:00 UTC is 01:30 the next morning in India.
        Assert.Equal("22 Oct 2026", BillingMailer.Day(new DateTime(2026, 10, 21, 20, 0, 0, DateTimeKind.Utc)));
        Assert.Equal("22 Oct 2026, 1:30 am IST", BillingMailer.Day(new DateTime(2026, 10, 21, 20, 0, 0, DateTimeKind.Utc), withTime: true));
    }
}
