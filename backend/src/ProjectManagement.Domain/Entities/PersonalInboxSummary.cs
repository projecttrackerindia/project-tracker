using ProjectManagement.Domain.Common;
namespace ProjectManagement.Domain.Entities;
public class PersonalInboxSummary : TenantEntity, ITenantScoped
{
    public Guid UserId {get;set;}
    public Guid OperationId {get;set;}
    public string Provider {get;set;}="";
    public string MessageId {get;set;}="";
    public string SourceHash {get;set;}="";
    public string AccessContext {get;set;}="";
    public int Credits {get;set;}
    public string Status {get;set;}="pending";
    public string? ResultProtected {get;set;}
    public string? Model {get;set;}
    public DateTime Deadline {get;set;}
    public DateTime ExpiresAt {get;set;}
}
