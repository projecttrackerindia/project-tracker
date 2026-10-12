using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>A planned absence, separate from worked hours and from HR approval.</summary>
public class PlannedLeave : TenantEntity, ITenantScoped, ISoftDelete
{
    public Guid UserId { get; set; }
    public DateOnly WorkDate { get; set; }
    public string? Note { get; set; }
    public Guid RequestId { get; set; }
    public bool IsDeleted { get; set; }
    public DateTime? DeletedAt { get; set; }
    public Guid? DeletedBy { get; set; }
}
