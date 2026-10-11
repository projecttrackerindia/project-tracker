using ProjectManagement.Domain.Common;
namespace ProjectManagement.Domain.Entities;
public class MicrosoftConnection : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    public string ProviderUserId { get; set; } = "";
    public string Email { get; set; } = "";
    public string Scopes { get; set; } = "";
    public string RefreshTokenProtected { get; set; } = "";
    public string AccessTokenProtected { get; set; } = "";
    public DateTime AccessTokenExpiresAt { get; set; }
    public DateTime ConnectedAt { get; set; }
}
