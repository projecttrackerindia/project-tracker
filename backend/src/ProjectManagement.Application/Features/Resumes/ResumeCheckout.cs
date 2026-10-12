namespace ProjectManagement.Application.Features.Resumes;
public sealed class ResumeCheckoutOptions
{
    public const string Section="Resume:Checkout";
    public bool Enabled {get;set;}
    // Explicit reviewed tax configuration; null means checkout is unavailable, not tax-free.
    public decimal? TaxPercent {get;set;}
    public string TaxLabel {get;set;}="";
}
public record ResumeOrderCheckout(Guid PurchaseId,string KeyId,string OrderId,long BaseMinor,long TaxMinor,long TotalMinor,string Currency,string TaxLabel,string Status,string Format);
public record ResumePaymentProof(string PaymentId,string Signature);
public record VerifiedResumePayment(string Id,string OrderId,long AmountMinor,string Currency,string Status,long RefundedMinor);
public interface IResumePaymentGateway
{
    bool Configured {get;}
    string PublicKey {get;}
    Task<string> CreateOrderAsync(Guid purchaseId,long amountMinor,CancellationToken ct);
    bool VerifyCheckout(string orderId,string paymentId,string signature);
    Task<VerifiedResumePayment> FetchAsync(string paymentId,CancellationToken ct);
    Task<IReadOnlyList<VerifiedResumePayment>> OrderPaymentsAsync(string orderId,CancellationToken ct);
}
