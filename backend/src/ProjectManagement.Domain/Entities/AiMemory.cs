using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>Whose memory it is: one person's, one team's, or the whole workspace's.</summary>
public enum AiMemoryScope { Person = 0, Team = 1, Workspace = 2 }

/// <summary>How Aura came to hold it: the person asked for it ("remember that…") or Aura offered it and the person agreed.</summary>
public enum AiMemorySource { Said = 0, Suggested = 1 }

/// <summary>
/// One short thing Aura remembers about how people or teams like to work ("Shiva prefers deep work before noon"). Saved only when a person
/// confirms a proposal card, never on its own, and never anything sensitive. A Person memory is visible to its owner alone; a Team memory to the
/// members of that team; a Workspace memory to every member. The text reaches Aura's prompt as quoted data, never as an instruction.
/// </summary>
public class AiMemory : TenantEntity, ITenantScoped
{
    public AiMemoryScope Scope { get; set; }
    /// <summary>The person it belongs to (Person scope only).</summary>
    public Guid? OwnerUserId { get; set; }
    /// <summary>The team it belongs to (Team scope only).</summary>
    public Guid? TeamId { get; set; }
    /// <summary>Up to 300 characters, one line.</summary>
    public string Text { get; set; } = "";
    public AiMemorySource Source { get; set; }
    public DateTime? LastUsedAt { get; set; }
}
