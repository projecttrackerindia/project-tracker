using ProjectManagement.Domain.Common;
namespace ProjectManagement.Domain.Entities;
public class PersonalEmailDraft : TenantEntity, ITenantScoped
{
    public Guid UserId {get;set;}
    public string Provider {get;set;}="google";
    public string? ConfirmedSenderEmail {get;set;}
    public string? ProviderRequestId {get;set;}
    public Guid? DispatchKey {get;set;}
    public DateTime? ReconciledAt {get;set;}
    public string Recipient {get;set;}="";
    public string Subject {get;set;}="";
    public string Body {get;set;}="";
    public string Status {get;set;}="draft";
    public int Version {get;set;}=1;
    public string? ProviderMessageId {get;set;}
    public DateTime? ConfirmedAt {get;set;}
    public DateTime? AcceptedAt {get;set;}
}
