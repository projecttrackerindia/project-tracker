using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace ProjectManagement.Application.Features.Auth;

public class PasswordBreachOptions
{
    public const string Section = "Security:BreachCheck";
    /// <summary>On by default: a password found in public breaches is refused when it is chosen, for every account.</summary>
    public bool Enabled { get; set; } = true;
    /// <summary>The k-anonymity range service (Have I Been Pwned's Pwned Passwords). Only the first five characters of the SHA-1 are sent.</summary>
    public string RangeUrl { get; set; } = "https://api.pwnedpasswords.com/range/";
}

/// <summary>
/// Is this password in a public breach list? Asked by k-anonymity: the password is hashed here (SHA-1), only the first five hex characters of
/// the hash leave the server, and the service answers with every breached suffix under that prefix, padded so even the answer's size says
/// nothing. The match is made here. When the service cannot be reached the answer is "not known to be breached": choosing a password is never
/// blocked by someone else's outage.
/// </summary>
public class PasswordBreachCheck(IHttpClientFactory http, IOptions<PasswordBreachOptions> options, ILogger<PasswordBreachCheck> log)
{
    /// <summary>How many times it was seen in breaches (0 when not found, or when the check could not run).</summary>
    public async Task<int> TimesSeenAsync(string password, CancellationToken ct = default)
    {
        if (!options.Value.Enabled || string.IsNullOrEmpty(password)) return 0;
        var hash = Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(password)));
        var (prefix, suffix) = (hash[..5], hash[5..]);
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(4));
            using var req = new HttpRequestMessage(HttpMethod.Get, options.Value.RangeUrl.TrimEnd('/') + "/" + prefix);
            req.Headers.TryAddWithoutValidation("Add-Padding", "true");
            req.Headers.TryAddWithoutValidation("User-Agent", "ProjectTracker-password-check");
            using var res = await http.CreateClient("pwned-passwords").SendAsync(req, timeout.Token);
            if (!res.IsSuccessStatusCode) { log.LogInformation("Password breach check unavailable ({Status})", (int)res.StatusCode); return 0; }
            var body = await res.Content.ReadAsStringAsync(timeout.Token);
            return Count(body, suffix);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or OperationCanceledException && !ct.IsCancellationRequested)
        {
            log.LogInformation("Password breach check unavailable ({Reason})", e.GetType().Name);
            return 0;
        }
    }

    /// <summary>The count for <paramref name="suffix"/> in a range answer ("SUFFIX:COUNT" per line; padding lines have a count of 0).</summary>
    public static int Count(string rangeBody, string suffix)
    {
        foreach (var line in rangeBody.Split('\n'))
        {
            var colon = line.IndexOf(':');
            if (colon != 35) continue;
            if (!line.AsSpan(0, 35).Equals(suffix, StringComparison.OrdinalIgnoreCase)) continue;
            return int.TryParse(line.AsSpan(36).Trim(), out var n) ? n : 0;
        }
        return 0;
    }
}
