using ProjectManagement.Domain.Common;
namespace ProjectManagement.Domain.Entities;
public class PersonalCalendarProposal:TenantEntity,ITenantScoped
{
    public Guid UserId{get;set;}
    public string Title{get;set;}="";
    public string Description{get;set;}="";
    public DateTime StartUtc{get;set;}
    public DateTime EndUtc{get;set;}
    public string TimeZone{get;set;}="UTC";
    public string Status{get;set;}="draft";
    public int Version{get;set;}=1;
    public string? ConfirmedAccount{get;set;}
    public DateTime? ConfirmedAt{get;set;}
    public DateTime? VerifiedAt{get;set;}
    public string? ProviderEventId{get;set;}
}
