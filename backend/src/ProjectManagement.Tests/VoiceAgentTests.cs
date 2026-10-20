using System.Net;
using ProjectManagement.Application.Features.Voice;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Support voice agent: settings, connectors (https only, secrets write-only) and the archive key pattern.</summary>
[Collection("api")]
public class VoiceAgentTests(ApiFactory factory)
{
    [Fact]
    public async Task Settings_and_connectors_are_validated()
    {
        var owner = await TestClient.RegisterAsync(factory, "Vani Voice");
        await owner.CreateOrgAsync();
        var s = await owner.Get("/api/v1/voice/settings");
        Assert.True(s.Ok, s.ToString());
        Assert.Contains("te", s.Data!["languages"]!.AsArray().Select(x => x!.GetValue<string>()));
        Assert.Equal(422, (int)(await owner.Put("/api/v1/voice/settings", new { enabled = true, agentName = "Asha", languages = new[] { "xx" }, requireVerification = true })).Status);
        Assert.Equal(422, (int)(await owner.Put("/api/v1/voice/settings", new { enabled = true, agentName = "Asha", languages = new[] { "hi" }, requireVerification = true, storageKeyPattern = "{yyyy}/../x" })).Status);
        var saved = await owner.Put("/api/v1/voice/settings", new { enabled = true, agentName = "Asha", companyName = "FiveStar", languages = new[] { "hi", "te", "ta", "en" }, requireVerification = true,
            storageKeyPattern = "{yyyy}/{MM}/{dd}/{ticket}-{callId}" });
        Assert.True(saved.Ok, saved.ToString());
        Assert.Equal("hi", saved.Data!["languages"]![0]!.GetValue<string>());

        Assert.Equal(422, (int)(await owner.Post("/api/v1/voice/connectors", new { name = "loan_details", description = "Loan", urlTemplate = "http://api.example.com/{loanNumber}", enabled = true })).Status);
        var c = await owner.Post("/api/v1/voice/connectors", new { name = "loan_details", description = "Loan balance and EMI by loan number", urlTemplate = "https://api.example.com/loans/{loanNumber}",
            headerName = "client_id", secret = "s3cret-value", enabled = true });
        Assert.Equal(HttpStatusCode.Created, c.Status);
        Assert.True(c.Data!["hasSecret"]!.GetValue<bool>());
        Assert.DoesNotContain("s3cret", c.Json!.ToJsonString());
        Assert.Equal("loanNumber", c.Data!["placeholders"]![0]!.GetValue<string>());
        Assert.Equal(HttpStatusCode.Conflict, (await owner.Post("/api/v1/voice/connectors", new { name = "loan_details", description = "Again", urlTemplate = "https://api.example.com/x", enabled = true })).Status);
        Assert.Empty((await owner.Get("/api/v1/voice/calls")).Data!.AsArray());
    }

    [Fact]
    public void Archive_keys_follow_the_pattern()
    {
        var call = new VoiceCall { Id = Guid.Parse("0f5e1c2a-0000-0000-0000-000000000001"), StartedAt = new DateTime(2026, 10, 20, 9, 5, 0, DateTimeKind.Utc), Channel = "phone", Language = "te" };
        Assert.Equal("2026/10/20/te/WT-12-0f5e1c2a000000000000000000000001", VoiceAgentService.KeyFor("{yyyy}/{MM}/{dd}/{language}/{ticket}-{callId}", call, "WT-12"));
    }
}
