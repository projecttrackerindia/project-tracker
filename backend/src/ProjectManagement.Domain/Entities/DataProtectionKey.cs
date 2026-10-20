using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>An ASP.NET Core data-protection key (XML), kept in the database so cookies and protected tokens survive redeploys and are shared by every server.</summary>
public class DataProtectionKey : Entity
{
    public string? FriendlyName { get; set; }
    public string Xml { get; set; } = "";
    public DateTime CreatedAt { get; set; }
}
