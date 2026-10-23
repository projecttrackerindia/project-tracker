using System.Collections.Concurrent;
using System.Net;
using System.Text;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Voice;

namespace ProjectManagement.Tests.Infrastructure;

/// <summary>Stands in for a workspace's own systems behind its connectors: answers by path, and records every call (path and query).</summary>
public sealed class FakeConnectorApi : HttpMessageHandler
{
    public ConcurrentDictionary<string, string> Answers { get; } = new();
    public ConcurrentQueue<string> Calls { get; } = new();

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var path = request.RequestUri!.AbsolutePath;
        Calls.Enqueue(path);
        return Task.FromResult(Answers.TryGetValue(path, out var body)
            ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") }
            : new HttpResponseMessage(HttpStatusCode.NotFound) { Content = new StringContent("{}") });
    }
}

/// <summary>The connector caller with names resolved to a public address (tests have no DNS); everything else is the real code.</summary>
public sealed class TestConnectorCaller(IHttpClientFactory http, ISecretProtector secrets) : ConnectorCaller(http, secrets)
{
    protected override Task<IPAddress[]> ResolveAsync(string host, CancellationToken ct) =>
        Task.FromResult(host is "localhost" ? [IPAddress.Loopback] : host.StartsWith("10.", StringComparison.Ordinal) ? [IPAddress.Parse(host)] : new[] { IPAddress.Parse("93.184.216.34") });
}

/// <summary>Stands in for the Pwned Passwords range service: answers by five-character prefix, and records the prefixes asked (never more).</summary>
public sealed class FakePwnedPasswords : HttpMessageHandler
{
    public ConcurrentDictionary<string, int> Breached { get; } = new();
    public ConcurrentQueue<string> Asked { get; } = new();

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var prefix = request.RequestUri!.AbsolutePath.Split('/').Last();
        Asked.Enqueue(request.RequestUri.ToString());
        var lines = new List<string> { "0000000000000000000000000000000000A:0" };   // padding, as the real service adds
        foreach (var (password, count) in Breached)
        {
            var hash = Convert.ToHexString(System.Security.Cryptography.SHA1.HashData(Encoding.UTF8.GetBytes(password)));
            if (hash.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) lines.Add($"{hash[5..]}:{count}");
        }
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(string.Join("\r\n", lines)) });
    }
}
