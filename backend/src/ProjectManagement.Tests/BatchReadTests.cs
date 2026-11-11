using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Several reads in one request. The point of these tests is not that batching works but that it changes nothing: every read answers
/// exactly what it would have answered on its own, including when the answer is a refusal.
/// </summary>
public class BatchReadTests(ApiFactory factory) : IClassFixture<ApiFactory>
{
    private static JsonNode At(JsonNode? data, int i) => data!.AsArray()[i]!;

    private async Task<TestClient> MemberAsync(string name)
    {
        var owner = await TestClient.RegisterAsync(factory, $"{name} Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        return await owner.AddMemberAsync(factory, TenantRole.Member, $"{name} Dev");
    }

    [Fact]
    public async Task Reads_answer_the_same_in_a_batch_as_on_their_own()
    {
        var owner = await TestClient.RegisterAsync(factory, "Batch Owner");
        await owner.CreateOrgAsync("Batch Org");

        var direct = await owner.Get("/api/v1/shell/summary");
        Assert.True(direct.Ok, direct.ToString());

        var batch = await owner.Post("/api/v1/batch", new { reads = new[] { "/api/v1/shell/summary", "/api/v1/me" } });
        Assert.True(batch.Ok, batch.ToString());
        Assert.Equal(2, batch.Data!.AsArray().Count);

        var summary = At(batch.Data, 0);
        Assert.Equal("/api/v1/shell/summary", (string)summary["path"]!);
        Assert.Equal(200, (int)summary["status"]!);
        // Same answer, not merely a successful one.
        Assert.Equal(direct.Data!["workspaceId"]!.ToJsonString(), summary["body"]!["data"]!["workspaceId"]!.ToJsonString());
        Assert.Equal(200, (int)At(batch.Data, 1)["status"]!);
    }

    [Fact]
    public async Task A_read_someone_may_not_make_is_refused_inside_a_batch_too()
    {
        var member = await MemberAsync("Batch Guard");

        // Platform administration is not a member's to read; the batch must not become a way in.
        var direct = await member.Get("/api/v1/platform/admin/tenants");
        Assert.True(direct.Status is HttpStatusCode.Forbidden or HttpStatusCode.NotFound or HttpStatusCode.Unauthorized, direct.ToString());

        var batch = await member.Post("/api/v1/batch", new { reads = new[] { "/api/v1/platform/admin/tenants" } });
        Assert.True(batch.Ok, batch.ToString());
        var one = At(batch.Data, 0);
        Assert.Equal((int)direct.Status, (int)one["status"]!);
    }

    [Fact]
    public async Task A_batch_cannot_reach_outside_this_api_or_nest_inside_itself()
    {
        var owner = await TestClient.RegisterAsync(factory, "Batch Limits");
        await owner.CreateOrgAsync("Batch Limits Org");

        var batch = await owner.Post("/api/v1/batch", new { reads = new[] { "/health", "/api/v1/batch", "/api/v1/../../etc/passwd" } });
        Assert.True(batch.Ok, batch.ToString());
        foreach (var i in new[] { 0, 1, 2 })
            Assert.Equal(400, (int)At(batch.Data, i)["status"]!);
    }

    [Fact]
    public async Task One_read_failing_does_not_cost_the_others_their_answers()
    {
        var owner = await TestClient.RegisterAsync(factory, "Batch Partial");
        await owner.CreateOrgAsync("Batch Partial Org");

        var batch = await owner.Post("/api/v1/batch", new { reads = new[] { "/api/v1/me", "/api/v1/does-not-exist", "/api/v1/shell/summary" } });
        Assert.True(batch.Ok, batch.ToString());
        Assert.Equal(200, (int)At(batch.Data, 0)["status"]!);
        Assert.Equal(404, (int)At(batch.Data, 1)["status"]!);
        Assert.Equal(200, (int)At(batch.Data, 2)["status"]!);
    }

    [Fact]
    public async Task More_reads_than_a_batch_allows_are_refused_outright()
    {
        var owner = await TestClient.RegisterAsync(factory, "Batch Too Many");
        await owner.CreateOrgAsync("Batch Too Many Org");
        var many = Enumerable.Repeat("/api/v1/me", 40).ToArray();
        var batch = await owner.Post("/api/v1/batch", new { reads = many });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, batch.Status);
    }
}
