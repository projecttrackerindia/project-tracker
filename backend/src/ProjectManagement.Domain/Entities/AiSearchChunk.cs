using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// A piece of a page or a work item, with its meaning as a vector, for meaning-based search ("what's our refund rule" finds "Returns
/// policy"). The vector is stored compactly (one signed byte per dimension). Who may see a result is never decided here: every hit is checked
/// against the reader's own access before it is shown. Confidential and restricted pages are not indexed at all.
/// </summary>
public class AiSearchChunk : TenantEntity, ITenantScoped
{
    /// <summary>"document", "task", "work" (operational) or "actionitem".</summary>
    public string SourceKind { get; set; } = "document";
    public Guid SourceId { get; set; }
    public Guid? ProjectId { get; set; }
    public int Part { get; set; }
    public string Title { get; set; } = "";
    /// <summary>The text that was embedded (masked for personal data), shown as the excerpt.</summary>
    public string Text { get; set; } = "";
    public byte[] Vector { get; set; } = [];
    public float Scale { get; set; }
    public string Model { get; set; } = "";
    /// <summary>A hash of the source text, so unchanged work is not embedded again.</summary>
    public string ContentHash { get; set; } = "";
    public DateTime IndexedAt { get; set; }
}
