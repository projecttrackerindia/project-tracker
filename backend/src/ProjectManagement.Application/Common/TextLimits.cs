using ProjectManagement.Application.Exceptions;

namespace ProjectManagement.Application.Common;

/// <summary>
/// How long a title may be, checked before anything reaches the database, so a long paragraph pasted into a title comes back as a clear
/// 422 that says what to do (keep the title short, put the rest in the description) instead of a database error.
/// </summary>
public static class TextLimits
{
    /// <summary>Every work item kind (task, issue, action item, ticket), document, meeting and reminder title column is 200 characters.</summary>
    public const int Title = 200;

    public const string TooLongCode = "TEXT_TOO_LONG";

    public static string TooLong(int max, int actual) =>
        $"The title is too long ({actual} characters). Keep it to {max} characters and put the rest in the description.";

    /// <summary>Throws a 422 on <paramref name="field"/> when the trimmed title is longer than <paramref name="max"/>; empty titles are left to the caller.</summary>
    public static void EnsureTitle(string? title, int max = Title, string field = "title")
    {
        var length = (title ?? "").Trim().Length;
        if (length > max) throw new ValidationException(field, TooLong(max, length));
    }
}
