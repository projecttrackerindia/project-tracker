using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;

namespace ProjectManagement.Application.Features.Auth;

/// <summary>How strict self-service sign-up is. Section "Signup". Every default is the strict one; see SECURITY.md.</summary>
public class SignupOptions
{
    public const string Section = "Signup";
    /// <summary>Sign-up must carry a form token from GET /auth/signup-form (proves a real form was loaded, and how long ago).</summary>
    public bool RequireFormToken { get; set; } = true;
    /// <summary>A form submitted faster than this after it was loaded is a bot.</summary>
    public int MinSubmitSeconds { get; set; } = 3;
    /// <summary>A form token older than this is refused (the page must be reloaded).</summary>
    public int MaxFormAgeMinutes { get; set; } = 120;
    /// <summary>The email's domain must be able to receive mail (MX, or an A/AAAA record as the implicit MX of RFC 5321).</summary>
    public bool CheckEmailDomain { get; set; } = true;
    /// <summary>Extra domains to refuse on top of the bundled disposable-mail list.</summary>
    public string[] BlockedEmailDomains { get; set; } = [];
    /// <summary>Cloudflare Turnstile. Off while the secret is empty; never commit the secret (environment variable Signup__TurnstileSecretKey).</summary>
    public string? TurnstileSecretKey { get; set; }
    /// <summary>The public site key the sign-up page renders the widget with (not a secret).</summary>
    public string? TurnstileSiteKey { get; set; }
    public string TurnstileVerifyUrl { get; set; } = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
}

/// <summary>Can this domain receive email? Looked up in DNS; a lookup that cannot finish is "unknown" and never blocks a sign-up.</summary>
public enum EmailDomainStatus { Accepts, NoMail, Unknown }

public interface IEmailDomainChecker
{
    Task<EmailDomainStatus> CheckAsync(string domain, CancellationToken ct = default);
}

/// <summary>The pure field rules for sign-up: the browser mirrors them (frontend/src/features/auth/signupRules.ts) so messages match.</summary>
public static partial class SignupRules
{
    public const int NameMin = 2, NameMax = 60, OrgMin = 2, OrgMax = 100;

    // Letters (any script) and their combining marks, in words joined by one space, apostrophe or hyphen.
    [GeneratedRegex(@"^[\p{L}\p{M}]+(?:[ '’-][\p{L}\p{M}]+)*$", RegexOptions.CultureInvariant)]
    private static partial Regex NameShape();
    [GeneratedRegex(@"https?:|www\.|://|\.(?:com|net|org|in|io|xyz|ru|top|info|biz|co)\b|@", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Link();
    [GeneratedRegex(@"(.)\1{3,}", RegexOptions.CultureInvariant)]
    private static partial Regex Repeats();
    [GeneratedRegex(@"\s+")]
    private static partial Regex Spaces();
    // RFC 5322 dot-atom local part and an RFC 1035 host name with an alphabetic (or IDNA xn--) top-level domain; no quoted locals, no IP literals.
    [GeneratedRegex(@"^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$", RegexOptions.CultureInvariant)]
    private static partial Regex EmailShape();
    [GeneratedRegex(@"^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} &.,'’()/+-]*$", RegexOptions.CultureInvariant)]
    private static partial Regex OrgShape();
    [GeneratedRegex(@"(.)\1{4,}", RegexOptions.CultureInvariant)]
    private static partial Regex OrgRepeats();
    [GeneratedRegex(@"^\+[1-9][0-9]{6,14}$", RegexOptions.CultureInvariant)]
    private static partial Regex E164();

    public static string Clean(string? value)
    {
        var text = value ?? "";
        try { text = text.Normalize(NormalizationForm.FormC); } catch (ArgumentException) { /* invalid UTF-16: the shape rules refuse it */ } catch (PlatformNotSupportedException) { }
        return Spaces().Replace(text, " ").Trim();
    }

    public static string? NameProblem(string? raw)
    {
        var name = Clean(raw);
        if (name.Length == 0) return "Enter your name.";
        if (name.Length is < NameMin or > NameMax) return $"Enter your name ({NameMin} to {NameMax} characters).";
        if (name.Any(char.IsDigit) || name.Any(c => CharUnicodeInfo.GetUnicodeCategory(c) is UnicodeCategory.LetterNumber or UnicodeCategory.OtherNumber))
            return "A name cannot contain numbers.";
        if (Link().IsMatch(name)) return "A name cannot contain a web or email address.";
        if (!NameShape().IsMatch(name)) return "Use letters, spaces, apostrophes and hyphens only.";
        if (Repeats().IsMatch(name.ToLowerInvariant())) return "That does not look like a real name.";
        if (name.Count(char.IsLetter) < 2) return "Enter your name.";
        return null;
    }

    public static string? EmailProblem(string? raw)
    {
        var email = (raw ?? "").Trim();
        if (email.Length == 0) return "Enter your email.";
        if (email.Length > 254) return "Enter a valid email address.";
        var at = email.LastIndexOf('@');
        if (at is < 1 or > 64 || !EmailShape().IsMatch(email)) return "Enter a valid email address.";
        var domain = DomainOf(email);
        if (domain.Split('.').Any(l => l.Length > 63)) return "Enter a valid email address.";
        if (DisposableEmailDomains.Contains(domain)) return "Use a permanent email address: disposable inboxes are not accepted.";
        return null;
    }

    public static string DomainOf(string email) => email.Trim()[(email.Trim().LastIndexOf('@') + 1)..].TrimEnd('.').ToLowerInvariant();

    public static string? OrganizationProblem(string? raw)
    {
        var org = Clean(raw);
        if (org.Length is < OrgMin or > OrgMax) return $"Enter your organisation's name ({OrgMin} to {OrgMax} characters).";
        if (Link().IsMatch(org)) return "An organisation name cannot contain a web or email address.";
        if (!OrgShape().IsMatch(org)) return "Use letters, numbers, spaces and & . , ' ( ) / + - only.";
        if (org.Count(char.IsLetter) < 2) return "An organisation name needs at least two letters.";
        if (OrgRepeats().IsMatch(org.ToLowerInvariant())) return "That does not look like a real organisation name.";
        return null;
    }

    /// <summary>
    /// E.164 (+, country code, subscriber number, 7 to 15 digits in all), with the national lengths of the countries we serve checked
    /// exactly (India: +91 then a 10-digit mobile starting 6-9). Spaces, dots, dashes and brackets are ignored.
    /// </summary>
    public static string? PhoneProblem(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var phone = new string(raw.Where(c => !(c is ' ' or '-' or '.' or '(' or ')')).ToArray());
        if (!E164().IsMatch(phone)) return "Enter the number in international format, for example +91 98765 43210.";
        foreach (var (code, length, first) in NationalLengths)
            if (phone.StartsWith(code, StringComparison.Ordinal))
            {
                var national = phone[code.Length..];
                if (national.Length != length || (first is not null && !first.Contains(national[0]))) return "That phone number is not valid for its country.";
                break;
            }
        return null;
    }

    private static readonly (string Code, int Length, string? First)[] NationalLengths =
    [
        ("+91", 10, "6789"), ("+1", 10, "23456789"), ("+44", 10, "123789"), ("+971", 9, "2345679"), ("+65", 8, "3689"), ("+61", 9, "23478"),
    ];

    /// <summary>The HMAC-signed time a sign-up form was loaded. Pure, so the timing rules are testable without waiting.</summary>
    public static string CreateFormToken(byte[] key, DateTime issuedUtc)
    {
        var payload = issuedUtc.Ticks.ToString(CultureInfo.InvariantCulture) + "." + Convert.ToHexString(RandomNumberGenerator.GetBytes(8));
        return payload + "." + Sign(key, payload);
    }

    public enum FormVerdict { Ok, Missing, Invalid, TooFast, Expired }

    public static FormVerdict CheckFormToken(byte[] key, string? token, DateTime nowUtc, TimeSpan minAge, TimeSpan maxAge)
    {
        if (string.IsNullOrWhiteSpace(token)) return FormVerdict.Missing;
        var parts = token.Split('.');
        if (parts.Length != 3 || !long.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var ticks)) return FormVerdict.Invalid;
        var expected = Sign(key, parts[0] + "." + parts[1]);
        if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(parts[2]))) return FormVerdict.Invalid;
        if (ticks < DateTime.MinValue.Ticks || ticks > DateTime.MaxValue.Ticks) return FormVerdict.Invalid;
        var age = nowUtc - new DateTime(ticks, DateTimeKind.Utc);
        if (age < minAge) return FormVerdict.TooFast;
        if (age > maxAge) return FormVerdict.Expired;
        return FormVerdict.Ok;
    }

    private static string Sign(byte[] key, string payload) =>
        Convert.ToHexString(HMACSHA256.HashData(key, Encoding.ASCII.GetBytes("signup-form|" + payload)))[..32];
}

/// <summary>
/// The checks a self-service sign-up passes before an account is made, beyond the field shapes the validator already refused: the bot
/// checks (honeypot, time to submit, optional Turnstile) and whether the email's domain can receive mail at all. Each refusal is a 422 with
/// a field so the form can show it inline, and is counted in the audit trail without the address.
/// </summary>
public class SignupGuard(IOptions<SignupOptions> options, IConfiguration config, AppClock clock, IHttpClientFactory http, ILogger<SignupGuard> log,
    IEmailDomainChecker? domains = null)
{
    private readonly SignupOptions _opt = options.Value;

    private byte[] Key => SHA256.HashData(Encoding.UTF8.GetBytes("signup-form-key|" + (config["Jwt:SigningKey"] ?? throw new InvalidOperationException("Jwt:SigningKey is not set."))));

    public object FormConfig() => new { formToken = SignupRules.CreateFormToken(Key, clock.Now), minSubmitSeconds = _opt.MinSubmitSeconds,
        turnstileSiteKey = string.IsNullOrWhiteSpace(_opt.TurnstileSecretKey) ? null : _opt.TurnstileSiteKey };

    public async Task EnsureAllowedAsync(RegisterRequest req, string? ip, CancellationToken ct = default)
    {
        // A field no person can see or reach: anything in it was typed by a script.
        if (!string.IsNullOrEmpty(req.Website)) Refuse("form", "SIGNUP_BOT_CHECK", "We could not create your account. Reload the page and try again.");

        if (_opt.RequireFormToken || !string.IsNullOrEmpty(req.FormToken))
        {
            switch (SignupRules.CheckFormToken(Key, req.FormToken, clock.Now, TimeSpan.FromSeconds(_opt.MinSubmitSeconds), TimeSpan.FromMinutes(_opt.MaxFormAgeMinutes)))
            {
                case SignupRules.FormVerdict.Ok: break;
                case SignupRules.FormVerdict.TooFast: Refuse("form", "SIGNUP_TOO_FAST", "That was quicker than a person can fill the form. Wait a moment and try again."); break;
                case SignupRules.FormVerdict.Expired: Refuse("form", "SIGNUP_FORM_EXPIRED", "This form has expired. Reload the page and try again."); break;
                default: Refuse("form", "SIGNUP_BOT_CHECK", "We could not create your account. Reload the page and try again."); break;
            }
        }

        if (!string.IsNullOrWhiteSpace(_opt.TurnstileSecretKey) && !await TurnstileAsync(req.TurnstileToken, ip, ct))
            Refuse("form", "SIGNUP_BOT_CHECK", "Complete the verification check and try again.");

        var domain = SignupRules.DomainOf(req.Email);
        if (_opt.BlockedEmailDomains.Any(d => string.Equals(d.Trim().TrimStart('@'), domain, StringComparison.OrdinalIgnoreCase)))
            Refuse("email", "EMAIL_DOMAIN_BLOCKED", "Sign-ups from this email domain are not accepted.");
        if (_opt.CheckEmailDomain && domains is not null && await domains.CheckAsync(domain, ct) == EmailDomainStatus.NoMail)
            Refuse("email", "EMAIL_DOMAIN_NO_MAIL", "This email domain cannot receive mail. Check the address for typos.");
    }

    private async Task<bool> TurnstileAsync(string? token, string? ip, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(token) || token.Length > 2048) return false;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            var form = new Dictionary<string, string> { ["secret"] = _opt.TurnstileSecretKey!, ["response"] = token };
            if (!string.IsNullOrEmpty(ip)) form["remoteip"] = ip;
            using var res = await http.CreateClient("turnstile").PostAsync(_opt.TurnstileVerifyUrl, new FormUrlEncodedContent(form), timeout.Token);
            if (!res.IsSuccessStatusCode) { log.LogWarning("Turnstile verification answered {Status}", (int)res.StatusCode); return false; }
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(timeout.Token));
            return doc.RootElement.TryGetProperty("success", out var ok) && ok.ValueKind == JsonValueKind.True;
        }
        // Fails closed: with Turnstile switched on, an unreachable verifier refuses sign-ups rather than letting bots through.
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException && !ct.IsCancellationRequested)
        {
            log.LogWarning("Turnstile verification unavailable ({Reason})", e.GetType().Name);
            return false;
        }
    }

    private static void Refuse(string field, string code, string message) =>
        throw new ValidationException([new ApiError(code, message, field)], message);
}

/// <summary>Throw-away inbox providers (a bundled list; extend it with Signup:BlockedEmailDomains). Matched on the exact domain and its parents.</summary>
public static class DisposableEmailDomains
{
    private static readonly HashSet<string> Domains = new(StringComparer.OrdinalIgnoreCase)
    {
        "0-mail.com", "10minutemail.com", "10minutemail.net", "10minutemail.co.uk", "20minutemail.com", "33mail.com", "anonbox.net", "anonymbox.com",
        "burnermail.io", "byom.de", "chacuo.net", "cock.li", "crazymailing.com", "deadaddress.com", "discard.email", "discardmail.com",
        "dispostable.com", "dropmail.me", "emailondeck.com", "emailfake.com", "emailtemporanea.com", "fakeinbox.com", "fakemail.net",
        "fakemailgenerator.com", "fexbox.org", "getairmail.com", "getnada.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org",
        "guerrillamail.biz", "guerrillamail.de", "guerrillamailblock.com", "grr.la", "sharklasers.com", "spam4.me", "pokemail.net", "harakirimail.com",
        "inboxbear.com", "inboxkitten.com", "incognitomail.org", "jetable.org", "kasmail.com", "linshiyouxiang.net", "luxusmail.org", "mail-temp.com",
        "mail.tm", "mail7.io", "mailcatch.com", "maildrop.cc", "mailinator.com", "mailinator.net", "mailinator2.com", "mailnesia.com", "mailnull.com",
        "mailpoof.com", "mailsac.com", "mailtemp.net", "mintemail.com", "mohmal.com", "moakt.com", "mytemp.email", "mytrashmail.com", "nada.email",
        "nowmymail.com", "one-time.email", "onetimemail.org", "owlymail.com", "spambox.us", "spamgourmet.com", "spamdecoy.net", "spamex.com",
        "spaml.de", "temp-mail.io", "temp-mail.org", "tempail.com", "tempinbox.com", "tempm.com", "tempmail.com", "tempmail.dev", "tempmail.net",
        "tempmail.plus", "tempmailo.com", "tempmailaddress.com", "tempr.email", "throwam.com", "throwawaymail.com", "tmail.ws", "tmpmail.net",
        "tmpmail.org", "trash-mail.com", "trashmail.com", "trashmail.de", "trashmail.net", "trashmail.io", "trbvm.com", "wegwerfmail.de",
        "wegwerfmail.net", "yopmail.com", "yopmail.fr", "yopmail.net", "cool.fr.nf", "jetable.fr.nf", "courriel.fr.nf", "moncourrier.fr.nf",
        "monemail.fr.nf", "monmail.fr.nf", "zetmail.com", "emailnax.com", "minuteinbox.com", "fakermail.com", "mvrht.net", "armyspy.com",
        "cuvox.de", "dayrep.com", "einrot.com", "fleckens.hu", "gustr.com", "jourrapide.com", "rhyta.com", "superrito.com", "teleworm.us",
        "mailbox.in.ua", "tempmailer.com", "disposablemail.com", "spamherelots.com", "email-fake.com", "generator.email", "vomoto.com",
        "lroid.com", "ezztt.com", "ruru.be", "1secmail.com", "1secmail.net", "1secmail.org", "esiix.com", "wwjmp.com", "xojxe.com", "yoggm.com",
        "kzccv.com", "qiott.com", "rteet.com", "dpptd.com", "icznn.com", "vjuum.com", "laafd.com", "txcct.com", "gufum.com", "knowledgemd.com",
        "emltmp.com", "tempmail.us.com", "fextemp.com", "smartnator.com", "thetempmail.com", "tempmailbox.net", "mailforspam.com", "mail-temporaire.fr",
        "tafmail.com", "tempomail.fr", "trashinbox.com", "mailmetrash.com", "spamfree24.org", "zippymail.info", "mailtothis.com", "dodgit.com",
    };

    public static bool Contains(string domain)
    {
        var d = domain.Trim().TrimEnd('.').ToLowerInvariant();
        while (d.Contains('.'))
        {
            if (Domains.Contains(d)) return true;
            d = d[(d.IndexOf('.') + 1)..];
        }
        return false;
    }
}
