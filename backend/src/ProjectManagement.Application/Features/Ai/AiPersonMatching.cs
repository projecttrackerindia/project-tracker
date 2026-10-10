using System.Text;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>Matches only candidates already authorized by the caller. No guessed identities or aliases.</summary>
public static class AiPersonMatching
{
    public static string Normalize(string name) => new(name.Normalize(NormalizationForm.FormKC)
        .Where(char.IsLetterOrDigit).Select(char.ToUpperInvariant).ToArray());

    public static IReadOnlyList<int> Match(string query, IReadOnlyList<(string Name, string Email)> people)
    {
        var exactEmail = Enumerable.Range(0, people.Count).Where(i => people[i].Email.Equals(query.Trim(), StringComparison.OrdinalIgnoreCase)).ToList();
        if (exactEmail.Count > 0) return exactEmail;
        // Email addresses and IDs must never be guessed from a typo.
        if (query.Contains('@')) return [];
        var normalized = Normalize(query);
        if (normalized.Length == 0) return [];
        var exact = Enumerable.Range(0, people.Count).Where(i => Normalize(people[i].Name) == normalized).ToList();
        if (exact.Count > 0) return exact;
        var partial = Enumerable.Range(0, people.Count).Where(i => Normalize(people[i].Name).Contains(normalized, StringComparison.Ordinal)).ToList();
        if (partial.Count > 0) return partial;
        // One insertion/deletion/substitution for a long name, only when there is a unique candidate.
        // Multiple close candidates are returned for clarification, never ranked into an automatic choice.
        if (normalized.Length < 6) return [];
        return Enumerable.Range(0, people.Count).Where(i => OneEdit(normalized, Normalize(people[i].Name))).ToList();
    }

    private static bool OneEdit(string a, string b)
    {
        if (Math.Abs(a.Length - b.Length) > 1) return false;
        int i = 0, j = 0, edits = 0;
        while (i < a.Length && j < b.Length)
        {
            if (a[i] == b[j]) { i++; j++; continue; }
            if (++edits > 1) return false;
            if (a.Length >= b.Length) i++;
            if (b.Length >= a.Length) j++;
        }
        return edits + (a.Length - i) + (b.Length - j) <= 1;
    }
}
