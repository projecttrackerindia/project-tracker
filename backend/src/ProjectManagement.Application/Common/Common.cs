using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace ProjectManagement.Application.Common;

public class AppOptions
{
    public const string Section = "App";
    /// <summary>Public URL of the web client; used to build links in emails.</summary>
    public string WebBaseUrl { get; set; } = "http://localhost:5173";
    /// <summary>Public URL of the API when it is not served from the same address as the web client (identity providers call back here).</summary>
    public string? ApiBaseUrl { get; set; }
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

/// <summary>
/// The workspace's address segment: every page of the app lives under <c>/{slug}/</c> (for example <c>/acme-bank/projects/…</c>), so a link says which
/// organization it belongs to. A slug must never equal a name the app uses at the top level (a page, the API, a file), so those are kept back.
/// </summary>
public static class WorkspaceSlugs
{
    /// <summary>Keep in step with the top-level routes in frontend/src/App.tsx and the paths nginx serves itself.</summary>
    public static readonly IReadOnlySet<string> Reserved = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        // pages that need no workspace
        "login", "register", "verify-email", "forgot-password", "reset-password", "invite", "auth", "security", "r", "dev", "logout", "sso",
        // pages inside a workspace (older links to these have no workspace in front, and are sent on to the right one)
        "my-work", "ai", "reminders", "timesheet", "calendar", "chat", "projects", "portfolio", "operations", "workload", "reports", "activity", "people",
        "settings", "account", "notifications", "admin", "work", "my-team", "project-status", "project-groups", "members", "teams", "organization", "billing", "audit",
        "dashboard", "home", "tasks", "issues",
        // served by the web server or the API
        "api", "hubs", "scim", "health", "assets", "icons", "static", "sw.js", "manifest.webmanifest", "favicon.ico", "robots.txt", "index.html",
        // too easy to confuse
        "app", "www", "new", "null", "undefined", "help", "support", "status", "docs", "w", "o", "org", "orgs", "workspace", "workspaces",
    };

    public static bool IsReserved(string slug) => Reserved.Contains(slug);

    /// <summary>The address for a workspace called <paramref name="name"/>, before any uniqueness suffix.</summary>
    public static string For(string name)
    {
        var slug = Text.Slugify(name);
        return IsReserved(slug) ? $"{slug}-org" : slug;
    }
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
