using System.Net;
using System.Net.Sockets;
using ProjectManagement.Application.Features.Integrations;

namespace ProjectManagement.Infrastructure.Services;

/// <summary>Validate the address actually connected to, never follow redirects or delegate resolution to an unchecked proxy.</summary>
public static class PublicNetworkHandler
{
    public static SocketsHttpHandler Create(Func<string, CancellationToken, Task<IPAddress[]>>? resolve = null) => new()
    {
        AllowAutoRedirect = false,
        UseProxy = false,
        ConnectTimeout = TimeSpan.FromSeconds(5),
        PooledConnectionLifetime = TimeSpan.FromMinutes(2),
        ConnectCallback = async (context, ct) =>
        {
            var addresses = await (resolve is null
                ? Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, ct)
                : resolve(context.DnsEndPoint.Host, ct));
            if (addresses.Length == 0 || addresses.Any(WebhookUrlRules.IsBlocked))
                throw new HttpRequestException("The destination address is not allowed.");
            var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
            try
            {
                await socket.ConnectAsync(new IPEndPoint(addresses[0], context.DnsEndPoint.Port), ct);
                return new NetworkStream(socket, ownsSocket: true);
            }
            catch { socket.Dispose(); throw; }
        },
    };
}
