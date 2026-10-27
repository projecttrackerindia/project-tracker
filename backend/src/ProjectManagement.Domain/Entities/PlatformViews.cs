using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// A named view of a list (My Work, a Work list, the Desk queue, the Portfolio): its filters, sort and grouping as JSON, kept by the person
/// who saved it. Private to them, or shared with the whole workspace (<see cref="Shared"/> without <see cref="TeamId"/>) or with one team.
/// </summary>
public class SavedView : TenantEntity, ITenantScoped
{
    public Guid OwnerId { get; set; }
    /// <summary>Which list it belongs to: mywork, work, desk or portfolio.</summary>
    public string Scope { get; set; } = "";
    public string Name { get; set; } = "";
    public bool Shared { get; set; }
    /// <summary>Shared with this team only (needs <see cref="Shared"/>); null with Shared = the whole workspace.</summary>
    public Guid? TeamId { get; set; }
    /// <summary>The filters, sort and grouping, as the screen wrote them (at most 8,000 characters).</summary>
    public string ConfigJson { get; set; } = "{}";
}

/// <summary>A public holiday of the workspace: nobody is expected to work that day, so Capacity counts it as a day off for everyone.</summary>
public class Holiday : TenantEntity, ITenantScoped
{
    public DateOnly Date { get; set; }
    public string Name { get; set; } = "";
    /// <summary>Optional: where it is observed (a state or office, e.g. "Telangana"). A label only; every holiday counts for everyone.</summary>
    public string? Region { get; set; }
}

/// <summary>
/// A workspace's public status page for its APIs (opt in), served at /status/{slug} without signing in. The components are documented APIs
/// chosen by an admin; nothing else (no servers, hosts or keys) is shown.
/// </summary>
public class StatusPage : TenantEntity, ITenantScoped
{
    /// <summary>The address segment: /status/{Slug}. Unique across all workspaces.</summary>
    public string Slug { get; set; } = "";
    public string Title { get; set; } = "";
    public bool Published { get; set; }
    /// <summary>The components as JSON: [{ "apiId": "…", "name": "Payments API" }] - the API definitions shown, with the name shown for each.</summary>
    public string ComponentsJson { get; set; } = "[]";
    public DateTime? PublishedAt { get; set; }
}
