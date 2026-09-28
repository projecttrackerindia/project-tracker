using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace ProjectManagement.Application.Common;

public class AppOptions
{
    public const string Section = "App";
    /// <summary>Public URL of the web client; used to build links in emails.</summary>
    public string WebBaseUrl { get; set; } = "http://localhost:5173";
    public bool RequireEmailVerification { get; set; } = true;
    public int MaxFailedLogins { get; set; } = 5;
    public int LockoutMinutes { get; set; } = 15;
    public int VerificationTokenHours { get; set; } = 24;
    public int ResetTokenHours { get; set; } = 2;
    public int InvitationDays { get; set; } = 7;
    public int TrialDays { get; set; } = 14;
    public int RefreshTokenDays { get; set; } = 30;
    public int RefreshReuseGraceSeconds { get; set; } = 10;
    /// <summary>Offset applied to UTC to decide what "today" means (default: India Standard Time, UTC+05:30).</summary>
    public int TimeZoneOffsetMinutes { get; set; } = 330;
}

public record PagedResult<T>(IReadOnlyList<T> Items, int Page, int PageSize, int TotalItems)
{
    public int TotalPages => PageSize <= 0 ? 0 : (int)Math.Ceiling(TotalItems / (double)PageSize);
}

public record PageQuery(int Page = 1, int PageSize = 25)
{
    public int SafePage => Math.Max(1, Page);
    public int SafeSize(int max = 100) => Math.Clamp(PageSize, 1, max);
}

public static partial class Text
{
    public static string NormalizeEmail(string email) => email.Trim().ToLowerInvariant();

    public static string Slugify(string value)
    {
        var normalized = value.Trim().ToLowerInvariant().Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder();
        foreach (var c in normalized)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(c) == UnicodeCategory.NonSpacingMark) continue;
            sb.Append(char.IsLetterOrDigit(c) ? c : '-');
        }
        var slug = DashRun().Replace(sb.ToString(), "-").Trim('-');
        return slug.Length == 0 ? "workspace" : slug.Length > 40 ? slug[..40].TrimEnd('-') : slug;
    }

    /// <summary>Derives a short uppercase project key (e.g. "Customer Portal" -> "CP").</summary>
    public static string KeyFrom(string name)
    {
        var words = NonAlnum().Split(name.ToUpperInvariant()).Where(w => w.Length > 0).ToList();
        var key = words.Count switch
        {
            0 => "PRJ",
            1 => new string(words[0].Take(4).ToArray()),
            _ => new string(words.Take(4).Select(w => w[0]).ToArray()),
        };
        return key.Length < 2 ? (key + "X") : key;
    }

    public static string? Truncate(string? value, int max) =>
        value is null ? null : value.Length <= max ? value : value[..max];

    [GeneratedRegex("-{2,}")] private static partial Regex DashRun();
    [GeneratedRegex("[^A-Z0-9]+")] private static partial Regex NonAlnum();
}
