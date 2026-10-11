using ProjectManagement.Domain.Common;
namespace ProjectManagement.Domain.Entities;

// Internal storage cleanup receipt. It survives deletion of its owner or source record.
// No controller or user-facing DTO exposes storage keys.
public class PersonalFileDeletion : Entity
{
    public string StorageKey { get; set; } = "";
    public DateTime CreatedAt { get; set; }
    public DateTime AvailableAt { get; set; }
    public int Attempts { get; set; }
}