using System.Net;
using System.Text;
using Microsoft.Extensions.Configuration;
using ProjectManagement.Api.Extensions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Support;
using ProjectManagement.Application.Features.Voice;
using ProjectManagement.Infrastructure.Services;

namespace ProjectManagement.Tests;

public class AssessmentRemediationTests
{
    [Fact]
    public async Task Chunked_responses_are_stopped_at_the_byte_limit()
    {
        using var content = new StreamContent(new NonSeekableStream(Encoding.UTF8.GetBytes("123456789")));
        Assert.Null(content.Headers.ContentLength);
        await Assert.ThrowsAsync<HttpBodyTooLargeException>(() => BoundedHttpContent.ReadUtf8Async(content, 8, default));
        using var exact = new StringContent("éé", Encoding.UTF8);
        Assert.Equal("éé", await BoundedHttpContent.ReadUtf8Async(exact, 4, default));
        using var tooBig = new StringContent("éé", Encoding.UTF8);
        await Assert.ThrowsAsync<HttpBodyTooLargeException>(() => BoundedHttpContent.ReadUtf8Async(tooBig, 3, default));
    }

    [Fact]
    public async Task Connection_time_resolution_refuses_private_and_mixed_addresses()
    {
        foreach (var addresses in new[] { new[] { IPAddress.Loopback }, new[] { IPAddress.Parse("8.8.8.8"), IPAddress.Loopback } })
        {
            using var handler = PublicNetworkHandler.Create((_, _) => Task.FromResult(addresses));
            Assert.False(handler.AllowAutoRedirect);
            Assert.False(handler.UseProxy);
            using var client = new HttpClient(handler);
            await Assert.ThrowsAsync<HttpRequestException>(() => client.GetAsync("https://example.test/"));
        }
    }

    [Fact]
    public void Verified_account_grants_cannot_cross_input_schemas_or_omit_bindings()
    {
        var flow = new VoiceFlow { Inputs = [new() { Name = "loan", Type = "digits" }, new() { Name = "dob", Required = false }] };
        var bound = new Dictionary<string, string> { ["loan"] = "1234" };
        Assert.True(SupportChannelService.MatchesVerifiedScope(bound, bound, flow));
        Assert.False(SupportChannelService.MatchesVerifiedScope(bound, new Dictionary<string, string>(), flow));
        Assert.False(SupportChannelService.MatchesVerifiedScope(bound, new Dictionary<string, string> { ["loan"] = "9999" }, flow));
        Assert.False(SupportChannelService.MatchesVerifiedScope(bound, new Dictionary<string, string> { ["loan"] = "1234", ["dob"] = "2000-01-01" }, flow));
        Assert.False(SupportChannelService.MatchesVerifiedScope(bound, bound, new VoiceFlow { Inputs = [new() { Name = "account" }] }));
        Assert.False(SupportChannelService.MatchesVerifiedScope(new Dictionary<string, string>(), bound, flow));
    }

    [Fact]
    public void Production_refuses_development_fallbacks_but_testing_remains_isolated()
    {
        var empty = new ConfigurationBuilder().Build();
        Assert.Equal(3, ProductionSafety.Problems(empty, "Production").Count);
        Assert.Empty(ProductionSafety.Problems(empty, "Testing"));
        Assert.Throws<InvalidOperationException>(() => ProductionSafety.Validate(empty, "Production"));
        var configured = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Email:Provider"] = "Smtp", ["Billing:Provider"] = "Razorpay", ["Mfa:EncryptionKey"] = "test-only-independent-key"
        }).Build();
        Assert.Empty(ProductionSafety.Problems(configured, "Production"));
    }

    private sealed class NonSeekableStream(byte[] bytes) : MemoryStream(bytes)
    {
        public override bool CanSeek => false;
    }
}
