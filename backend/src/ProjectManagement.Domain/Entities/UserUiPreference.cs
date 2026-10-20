using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// One person's own layout choice for the app (the sidebar's order, pinned, hidden and collapsed sections), kept with their account so it
/// follows them to every device. Not workspace data: it belongs to the person, in every workspace they use.
/// </summary>
public class UserUiPreference : Entity
{
    public Guid UserId { get; set; }
    /// <summary>Which layout: "sidebar".</summary>
    public string Key { get; set; } = "";
    /// <summary>The layout as JSON, as the app wrote it (validated as JSON, at most 8,000 characters).</summary>
    public string Value { get; set; } = "{}";
    public DateTime UpdatedAt { get; set; }
}
