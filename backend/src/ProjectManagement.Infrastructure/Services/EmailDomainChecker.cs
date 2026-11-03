using System.Collections.Concurrent;
using DnsClient;
using DnsClient.Protocol;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Features.Auth;

namespace ProjectManagement.Infrastructure.Services;

/// <summary>
/// Can a domain receive email? An MX record (other than the RFC 7505 "null MX" of "."), or failing that an A/AAAA record, which RFC 5321
/// treats as the implicit mail exchanger. A domain that does not exist is NoMail. A lookup that times out or errors is Unknown, so a DNS
/// outage never blocks a real person. Answers are cached for 30 minutes.
/// </summary>
public sealed class DnsEmailDomainChecker(ILogger<DnsEmailDomainChecker> log) : IEmailDomainChecker
{
    private static readonly LookupClient Lookup = new(new LookupClientOptions { UseCache = true, Timeout = TimeSpan.FromSeconds(3), Retries = 1, ThrowDnsErrors = false });
    private static readonly ConcurrentDictionary<string, (EmailDomainStatus Status, DateTime At)> Cache = new(StringComparer.OrdinalIgnoreCase);

    public async Task<EmailDomainStatus> CheckAsync(string domain, CancellationToken ct = default)
    {
        domain = domain.Trim().TrimEnd('.').ToLowerInvariant();
        if (domain.Length is 0 or > 253) return EmailDomainStatus.NoMail;
        if (Cache.TryGetValue(domain, out var hit) && hit.At > DateTime.UtcNow.AddMinutes(-30)) return hit.Status;
        var status = await LookUpAsync(domain, ct);
        if (status != EmailDomainStatus.Unknown)
        {
            if (Cache.Count > 10_000) Cache.Clear();
            Cache[domain] = (status, DateTime.UtcNow);
        }
        return status;
    }

    private async Task<EmailDomainStatus> LookUpAsync(string domain, CancellationToken ct)
    {
        try
        {
            var mx = await Lookup.QueryAsync(domain, QueryType.MX, cancellationToken: ct);
            if (mx.Header.ResponseCode == DnsHeaderResponseCode.NotExistentDomain) return EmailDomainStatus.NoMail;
            if (mx.HasError) return EmailDomainStatus.Unknown;
            var exchanges = mx.Answers.MxRecords().Select(r => r.Exchange.Value.TrimEnd('.')).ToList();
            if (exchanges.Count > 0) return exchanges.All(e => e.Length == 0) ? EmailDomainStatus.NoMail : EmailDomainStatus.Accepts;
            var a = await Lookup.QueryAsync(domain, QueryType.A, cancellationToken: ct);
            if (a.Answers.ARecords().Any()) return EmailDomainStatus.Accepts;
            var aaaa = await Lookup.QueryAsync(domain, QueryType.AAAA, cancellationToken: ct);
            if (aaaa.Answers.AaaaRecords().Any()) return EmailDomainStatus.Accepts;
            return a.HasError || aaaa.HasError ? EmailDomainStatus.Unknown : EmailDomainStatus.NoMail;
        }
        catch (Exception ex) when (ex is DnsResponseException or OperationCanceledException or System.Net.Sockets.SocketException && !ct.IsCancellationRequested)
        {
            log.LogInformation("Mail domain lookup failed ({Reason})", ex.GetType().Name);
            return EmailDomainStatus.Unknown;
        }
    }
}
