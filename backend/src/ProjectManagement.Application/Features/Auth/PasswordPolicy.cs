using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Admin;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Auth;

/// <summary>
/// The rules a new password must meet. One policy for the whole platform: a password belongs to the account, and the same account
/// signs in to every workspace it is a member of. Only checked when a password is chosen, so tightening it never locks anyone out.
/// </summary>
public record PasswordPolicyDto(int MinLength, bool RequireLetter, bool RequireUppercase, bool RequireLowercase, bool RequireDigit,
    bool RequireSymbol, bool BlockCommon, bool BlockPersonalInfo, int HistoryCount)
{
    /// <summary>The rules the platform always had (8 characters, a letter and a number) plus the two cheap, sensible blocks.</summary>
    public static readonly PasswordPolicyDto Default = new(8, true, false, false, true, false, true, true, 0);
}

/// <summary>Checks a password against a policy. Pure (no database), so the rules are easy to test and to mirror in the browser.</summary>
public static class PasswordRules
{
    public const int MinAllowed = 8, MaxAllowed = 64, MaxLength = 128, MaxHistory = 10;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    // The most-used passwords and the words people build them from. Compared after lower-casing, undoing common letter swaps
    // (p@ssw0rd) and trimming digits and symbols off the ends (Password123!, Welcome2026).
    private static readonly HashSet<string> Common = new(StringComparer.Ordinal)
    {
        "password", "passwort", "passpass", "123456", "1234567", "12345678", "123456789", "1234567890", "12345", "111111", "11111111",
        "000000", "00000000", "654321", "666666", "121212", "112233", "123123", "123321", "987654321", "qwerty", "qwertyuiop", "qwertyui",
        "asdfgh", "asdfghjkl", "zxcvbnm", "qazwsx", "zaqwsx", "abc", "abcdef", "abcdefg", "abcdefgh", "letmein", "welcome", "admin",
        "administrator", "root", "login", "master", "monkey", "dragon", "football", "baseball", "basketball", "soccer", "hockey",
        "cricket", "iloveyou", "sunshine", "princess", "shadow", "superman", "batman", "trustno1", "trustno", "whatever", "freedom", "starwars",
        "pokemon", "michael", "jennifer", "charlie", "jordan", "hunter", "ranger", "buster", "thomas", "robert", "daniel", "andrew",
        "joshua", "jessica", "ashley", "michelle", "nicole", "mustang", "harley", "ginger", "hello", "secret", "summer", "winter",
        "spring", "autumn", "changeme", "default", "guest", "test", "testing", "access", "flower", "cheese", "computer", "internet",
        "killer", "pepper", "cookie", "chocolate", "maggie", "lovely", "loveme", "friends", "family", "samsung", "apple", "google",
        "microsoft", "india", "chennai", "mumbai", "hyderabad", "bangalore", "delhi", "kolkata", "ganesh", "krishna", "sairam",
        "omsairam", "company", "project", "projects", "workspace", "manager", "office", "business", "qwerasdf", "asdf",
        "1qaz2wsx", "zaq12wsx", "1q2w3e4r", "1q2w3e", "q1w2e3r4",
    };

    public static PasswordPolicyDto Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return PasswordPolicyDto.Default;
        try { return Clamp(JsonSerializer.Deserialize<PasswordPolicyDto>(json, Json) ?? PasswordPolicyDto.Default); }
        catch (JsonException) { return PasswordPolicyDto.Default; }
    }

    public static string Serialize(PasswordPolicyDto p) => JsonSerializer.Serialize(p, Json);

    public static PasswordPolicyDto Clamp(PasswordPolicyDto p) => p with
    {
        MinLength = Math.Clamp(p.MinLength, MinAllowed, MaxAllowed),
        HistoryCount = Math.Clamp(p.HistoryCount, 0, MaxHistory),
    };

    /// <summary>Everything wrong with <paramref name="password"/>, as sentences for the person choosing it (empty when it is fine).</summary>
    public static List<string> Problems(PasswordPolicyDto p, string password, string? email, string? displayName)
    {
        var problems = new List<string>();
        if (password.Length > MaxLength) { problems.Add($"Use at most {MaxLength} characters."); return problems; }

        var missing = new List<string>();
        if (password.Length < p.MinLength) missing.Add($"at least {p.MinLength} characters");
        if (p.RequireLetter && !password.Any(char.IsLetter)) missing.Add("a letter");
        if (p.RequireUppercase && !password.Any(char.IsUpper)) missing.Add("an uppercase letter");
        if (p.RequireLowercase && !password.Any(char.IsLower)) missing.Add("a lowercase letter");
        if (p.RequireDigit && !password.Any(char.IsDigit)) missing.Add("a number");
        if (p.RequireSymbol && password.All(char.IsLetterOrDigit)) missing.Add("a symbol (such as ! # or ?)");
        if (missing.Count > 0) problems.Add($"Use {JoinWithAnd(missing)}.");

        if (p.BlockCommon && IsCommon(password)) problems.Add("This password is too common. Choose something less predictable.");
        if (p.BlockPersonalInfo && ContainsPersonalInfo(password, email, displayName)) problems.Add("Don't use your name or email address in your password.");
        return problems;
    }

    private static string JoinWithAnd(List<string> items) =>
        items.Count == 1 ? items[0] : $"{string.Join(", ", items.Take(items.Count - 1))} and {items[^1]}";

    public static bool IsCommon(string password)
    {
        var lower = password.ToLowerInvariant();
        if (lower.Distinct().Count() <= 2) return true;                 // aaaaaaaa, 11111111, abababab
        var tailless = lower.TrimEnd(Trimmable);                          // Welcome2026!, p@ssw0rd123
        var core = tailless.TrimStart(Trimmable);                         // 2026welcome
        string[] candidates = [lower, tailless, core, Unleet(lower), Unleet(tailless), Unleet(core)];
        return candidates.Any(c => c.Length > 0 && Common.Contains(c));
    }

    private static string Unleet(string s) =>
        new(s.Select(c => c switch { '@' or '4' => 'a', '0' => 'o', '1' or '!' => 'i', '3' => 'e', '5' or '$' => 's', '7' => 't', _ => c }).ToArray());

    private static readonly char[] Trimmable = "0123456789!@#$%^&*()_-+=.,?~`'\" ".ToCharArray();

    public static bool ContainsPersonalInfo(string password, string? email, string? displayName)
    {
        var lower = password.ToLowerInvariant();
        var parts = new List<string>();
        if (!string.IsNullOrWhiteSpace(email))
        {
            var local = email.Split('@')[0].ToLowerInvariant();
            parts.Add(local);
            parts.AddRange(local.Split('.', '_', '-', '+'));
        }
        if (!string.IsNullOrWhiteSpace(displayName)) parts.AddRange(displayName.ToLowerInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries));
        return parts.Any(part => part.Length >= 4 && lower.Contains(part));
    }
}

/// <summary>Applies the platform's password policy wherever a password is chosen: sign-up, reset and change.</summary>
public class PasswordPolicyService(IAppDbContext db, IPasswordHasher hasher, PlatformSettingsCache platform, AppClock clock)
{
    public Task<PasswordPolicyDto> GetAsync(CancellationToken ct = default) => platform.GetPasswordPolicyAsync(ct);

    /// <summary>Throws a validation error on <paramref name="field"/> describing everything the password still needs.</summary>
    public async Task EnsureAcceptableAsync(string field, string password, string? email, string? displayName, User? existing, CancellationToken ct = default)
    {
        var policy = await GetAsync(ct);
        var problems = PasswordRules.Problems(policy, password, email, displayName);
        if (problems.Count == 0 && existing is not null && policy.HistoryCount > 0 && await WasUsedRecentlyAsync(existing, password, policy.HistoryCount, ct))
            problems.Add(policy.HistoryCount == 1
                ? "Choose a password different from your current one."
                : $"You used this password recently. Choose one that isn't among your last {policy.HistoryCount} passwords.");
        if (problems.Count > 0) throw new ValidationException(field, string.Join(" ", problems));
    }

    /// <summary>The current password counts as the most recent one; the rest come from the history.</summary>
    private async Task<bool> WasUsedRecentlyAsync(User user, string password, int count, CancellationToken ct)
    {
        if (hasher.Verify(user.PasswordHash, password)) return true;
        if (count <= 1) return false;
        var previous = await db.PasswordHistories.AsNoTracking().Where(h => h.UserId == user.Id)
            .OrderByDescending(h => h.ReplacedAt).Take(count - 1).Select(h => h.Hash).ToListAsync(ct);
        return previous.Any(h => hasher.Verify(h, password));
    }

    /// <summary>Call before replacing the hash: keeps the outgoing one, and only the most recent few, for the reuse check.</summary>
    public async Task RememberOutgoingAsync(User user, CancellationToken ct = default)
    {
        var older = await db.PasswordHistories.Where(h => h.UserId == user.Id).OrderByDescending(h => h.ReplacedAt)
            .Skip(PasswordRules.MaxHistory - 1).ToListAsync(ct);
        foreach (var h in older) db.PasswordHistories.Remove(h);
        db.PasswordHistories.Add(new PasswordHistory { UserId = user.Id, Hash = user.PasswordHash, ReplacedAt = clock.Now });
    }
}
