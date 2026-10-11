using ProjectManagement.Domain.Common;
namespace ProjectManagement.Domain.Entities;
// Gateway order/fulfilment record, not a credit balance or replacement subscription ledger.
public class ResumeExportPurchase : AuditableEntity
{
    public Guid UserId {get;set;}
    public Guid? ResumeVersionId {get;set;}
    public int TemplateId {get;set;}
    public string Format {get;set;}="pdf";
    public string Status {get;set;}="preparing";
    public long BaseMinor {get;set;}=4900;
    public long TaxMinor {get;set;}
    public decimal TaxPercent {get;set;}
    public string TaxLabel {get;set;}="";
    public string Currency {get;set;}="INR";
    public string? ProviderOrderId {get;set;}
    public string? ProviderPaymentId {get;set;}
    public string? ArtifactKey {get;set;}
    public string? ArtifactSha256 {get;set;}
    public DateTime? PaidAt {get;set;}
    public DateTime? FirstDownloadedAt {get;set;}
    public int Version {get;set;}=1;
}
