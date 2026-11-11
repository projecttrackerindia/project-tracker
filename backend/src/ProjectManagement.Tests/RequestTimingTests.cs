using System.Text.RegularExpressions;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Every API answer says how long the server took and how many database commands it ran (Server-Timing), so a slow save can be measured in
/// the browser's network panel. A request that reads the signed-in person's own record is a few commands; if it ever needs dozens, something
/// began asking the database once per item.
/// </summary>
[Collection("api")]
public class RequestTimingTests(ApiFactory factory)
{
    [Fact]
    public async Task An_api_answer_carries_server_and_database_timing()
    {
        var c = await TestClient.RegisterAsync(factory, "Tia Timing");
        var res = await c.Get("/api/v1/me");
        Assert.True(res.Ok, res.ToString());
        var timing = res.Header("Server-Timing");
        Assert.NotNull(timing);
        var m = Regex.Match(timing!, @"^app;dur=(?<app>[\d.]+), db;dur=(?<db>[\d.]+);desc=""(?<n>\d+) queries""$");
        Assert.True(m.Success, timing);
        var queries = int.Parse(m.Groups["n"].Value);
        Assert.InRange(queries, 1, 40);                                                       // it did read the database, and not once per item
        Assert.True(double.Parse(m.Groups["app"].Value, System.Globalization.CultureInfo.InvariantCulture) >= double.Parse(m.Groups["db"].Value, System.Globalization.CultureInfo.InvariantCulture) - 1);
    }
}
