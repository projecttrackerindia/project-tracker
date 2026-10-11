using ProjectManagement.Domain.Common;
namespace ProjectManagement.Domain.Entities;
// Anonymous callbacks can only resolve an attempt by a random state AND browser proof.
// This is not tenant-query-filtered: the owning principal is rebuilt before connection access.
public class ProviderOAuthAttempt : Entity
{
    public string Provider {get;set;}="";
    public Guid TenantId {get;set;}
    public Guid UserId {get;set;}
    public string StateHash {get;set;}="";
    public string BrowserHash {get;set;}="";
    public string ReturnPath {get;set;}="";
    public DateTime ExpiresAt {get;set;}
    public DateTime? ConsumedAt {get;set;}
}