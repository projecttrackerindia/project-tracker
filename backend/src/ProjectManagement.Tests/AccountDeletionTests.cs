using System.Net;
using System.Net.Http.Json;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Asking for one's own account to be deleted (required by app stores): signed in only, acknowledged with the address and the time to complete.</summary>
[Collection("api")]
public class AccountDeletionTests(ApiFactory factory)
{
    [Fact]
    public async Task A_signed_in_person_can_request_deletion_and_a_repeat_is_acknowledged()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        var res = await c.Post("/api/v1/me/deletion-request", new { reason = "Moving to another tool" });
        Assert.True(res.Ok, res.ToString());
        Assert.Equal(c.Email, res.Data!["email"]!.GetValue<string>());
        Assert.Equal(30, res.Data!["completeWithinDays"]!.GetValue<int>());
        Assert.True((await c.Post("/api/v1/me/deletion-request", new { })).Ok);
        Assert.Equal(422, (int)(await c.Post("/api/v1/me/deletion-request", new { reason = new string('x', 1001) })).Status);
    }

    [Fact]
    public async Task Nobody_can_request_it_without_signing_in()
    {
        var anon = factory.CreateClient();
        var res = await anon.PostAsJsonAsync("/api/v1/me/deletion-request", new { });
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }
}
