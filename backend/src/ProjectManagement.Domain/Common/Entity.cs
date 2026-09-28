namespace ProjectManagement.Domain.Common;

public abstract class Entity
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
}

public abstract class AuditableEntity : Entity
{
    public DateTime CreatedAt { get; set; }
    public Guid? CreatedBy { get; set; }
    public DateTime? UpdatedAt { get; set; }
    public Guid? UpdatedBy { get; set; }
}

/// <summary>Every tenant-owned record carries a TenantId (see spec section 4).</summary>
public abstract class TenantEntity : AuditableEntity
{
    public Guid TenantId { get; set; }
}

public interface ISoftDelete
{
    bool IsDeleted { get; set; }
    DateTime? DeletedAt { get; set; }
    Guid? DeletedBy { get; set; }
}

/// <summary>Marks entities that get the automatic tenant query filter.</summary>
public interface ITenantScoped
{
    Guid TenantId { get; set; }
}
