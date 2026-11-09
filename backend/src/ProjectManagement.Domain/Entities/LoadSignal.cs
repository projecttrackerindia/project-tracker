using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// How someone says their week feels on the Load page: "swamped" or "room". One row per person per week (the week's Monday); it is shown next to
/// their load and nudges suggestions (nobody is offered work in a week they said they are swamped), never changes the numbers.
/// </summary>
public class LoadSignal : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    public DateOnly WeekStart { get; set; }
    /// <summary>"swamped" or "room".</summary>
    public string Signal { get; set; } = "";
}
