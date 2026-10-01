namespace ProjectManagement.Application.Common;

/// <summary>
/// Text search patterns. Searches are written as <c>EF.Functions.Like(column.ToLower(), SearchText.Pattern(term), SearchText.Escape)</c>:
/// a plain LIKE on the lower-cased column, which the trigram indexes on lower(column) serve on Postgres, so search stays fast as the
/// tables grow (a "contains" query would read every row instead).
/// </summary>
public static class SearchText
{
    /// <summary>The escape character used in <see cref="Pattern"/>.</summary>
    public const string Escape = "\\";

    /// <summary>"%term%", lower-cased, with LIKE's own wildcards in the term taken literally.</summary>
    public static string Pattern(string term) =>
        "%" + term.Trim().ToLowerInvariant().Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";
}
