using System.Net;
using System.Net.Sockets;
using System.Text;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Integrations;

namespace ProjectManagement.Infrastructure.Services;

/// <summary>
/// Sends webhook requests. The connection is made to an address that was checked at the moment of connecting (so a host name that later
/// changes to an internal address cannot slip through), redirects are never followed, and the wait is short.
/// </summary>
public sealed class HttpWebhookTransport : IWebhookTransport, IDisposable
{
    private readonly HttpClient _client;

    public HttpWebhookTransport(IOptions<WebhookOptions> options)
    {
        var allowPrivate = options.Value.AllowPrivateTargets;
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            ConnectTimeout = TimeSpan.FromSeconds(5),
            PooledConnectionLifetime = TimeSpan.FromMinutes(2),
            ConnectCallback = async (context, ct) =>
            {
                var addresses = await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, ct);
                var allowed = allowPrivate ? addresses : addresses.Where(a => !WebhookUrlRules.IsBlocked(a)).ToArray();
                if (allowed.Length == 0 || (!allowPrivate && allowed.Length != addresses.Length)) throw new HttpRequestException("The address is not allowed.");

                var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                try
                {
                    await socket.ConnectAsync(new IPEndPoint(allowed[0], context.DnsEndPoint.Port), ct);
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch { socket.Dispose(); throw; }
            },
        };
        _client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(10) };
        _client.DefaultRequestHeaders.UserAgent.ParseAdd("ProjectManagement-Webhooks/1.0");
    }

    public async Task<WebhookSendResult> SendAsync(string url, IReadOnlyDictionary<string, string> headers, string body, CancellationToken ct)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, url) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
            foreach (var (k, v) in headers) req.Headers.TryAddWithoutValidation(k, v);
            using var res = await _client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);

            // Keep only the first bit of the answer: enough to see what went wrong, never a large download.
            await using var stream = await res.Content.ReadAsStreamAsync(ct);
            var buffer = new byte[512];
            var read = await stream.ReadAsync(buffer, ct);
            var snippet = Encoding.UTF8.GetString(buffer, 0, read).Replace('\0', ' ').Trim();
            return new WebhookSendResult((int)res.StatusCode, null, snippet.Length == 0 ? null : snippet);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested) { return new WebhookSendResult(null, "The receiver did not answer within 10 seconds.", null); }
        catch (HttpRequestException) { return new WebhookSendResult(null, "Could not connect to the receiver.", null); }
    }

    public void Dispose() => _client.Dispose();
}
