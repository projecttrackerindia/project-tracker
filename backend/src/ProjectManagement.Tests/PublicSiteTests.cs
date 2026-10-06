using System.Net;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>What the public website (pricing page) may read without signing in.</summary>
[Collection("api")]
public class PublicSiteTests(ApiFactory factory)
{
    [Fact]
    public async Task The_price_list_is_public_and_carries_only_prices()
    {
        var res = await new TestClient(factory).Get("/api/v1/public/plans");
        Assert.Equal(HttpStatusCode.OK, res.Status);
        var plans = res.Data!.AsArray();
        Assert.Equal(["FREE", "PRO", "BUSINESS", "ENTERPRISE"], plans.Select(p => p!["code"]!.GetValue<string>()).ToArray());
        Assert.Equal(0m, plans[0]!["priceMonthly"]!.GetValue<decimal>());
        // Nothing about an organization, a feature switch or a limit leaves through this door.
        Assert.All(plans, p => Assert.Equal(["code", "name", "priceMonthly", "currency", "perSeat", "aiCreditsPerSeat", "storageMbPerSeat", "aiModelTier"], p!.AsObject().Select(x => x.Key).ToArray()));
    }
}
