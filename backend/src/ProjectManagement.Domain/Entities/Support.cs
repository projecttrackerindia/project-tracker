using ProjectManagement.Domain.Common;
namespace ProjectManagement.Domain.Entities;
// Support augments operational work; it does not duplicate assignments, deadlines or SLA clocks.
public class SupportTicket : TenantEntity, ITenantScoped
{
    public Guid WorkTaskId {get;set;}
    public string Audience {get;set;}="internal";
    public string Category {get;set;}="General";
    public string Region {get;set;}="";
    public string Language {get;set;}="en";
    public Guid? TeamId {get;set;}
    public string CustomFieldsJson {get;set;}="{}";
    public DateTime? WorkflowResponseDueAt { get; set; }
    public DateTime? WorkflowResolutionDueAt { get; set; }
    public string State {get;set;}="open";
    public string HandoffReason {get;set;}="";
    public Guid? MergedIntoId {get;set;}
    public int Version {get;set;}=1;
}
public class SupportInteraction : TenantEntity, ITenantScoped
{
    public Guid TicketId {get;set;}
    public Guid AuthorId {get;set;}
    public string Visibility {get;set;}="public";
    public string Body {get;set;}="";
    public string Kind {get;set;}="message";
    public string RequestKey {get;set;}="";
}
public class SupportTicketLink : TenantEntity, ITenantScoped
{
    public Guid TicketId {get;set;}
    public Guid RelatedTicketId {get;set;}
}
