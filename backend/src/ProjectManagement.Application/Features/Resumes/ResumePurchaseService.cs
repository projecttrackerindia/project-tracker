using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
namespace ProjectManagement.Application.Features.Resumes;
public record ResumePurchaseRequest(Guid ResumeId,int Number,int TemplateId,string Format);
public class ResumePurchaseService(IAppDbContext db,ICurrentContext ctx,ResumeService resumes,IResumePaymentGateway gateway,
    IOptions<ResumeCheckoutOptions> options,IFileStorage storage,Recorder recorder,AppClock clock)
{
    private IQueryable<ResumeExportPurchase> Mine=>db.ResumeExportPurchases.Where(p=>p.UserId==ctx.RequireUserId());
    private ResumeOrderCheckout Dto(ResumeExportPurchase p)=>new(p.Id,gateway.PublicKey,p.ProviderOrderId??"",p.BaseMinor,p.TaxMinor,p.BaseMinor+p.TaxMinor,p.Currency,p.TaxLabel,p.Status,p.Format);
    private async Task<ResumeExportPurchase> RequireAsync(Guid id,CancellationToken ct)=>await Mine.FirstOrDefaultAsync(p=>p.Id==id,ct)??throw new NotFoundException("Purchase not found.");
    private void Gate(){var o=options.Value;if(!o.Enabled||!gateway.Configured||o.TaxPercent is not (>=0 and <=100)||string.IsNullOrWhiteSpace(o.TaxLabel))throw new ConflictException("Watermark-free checkout is not enabled. Use free branded downloads until payment and tax configuration is verified.","RESUME_CHECKOUT_DISABLED");}
    public async Task<ResumeOrderCheckout> StartAsync(ResumePurchaseRequest req,CancellationToken ct)
    {
        Gate();var uid=ctx.RequireUserId();
        await using var prepare=await db.Database.BeginOwnedTransactionAsync(ct);
        // Serialize purchases for this personal account across workspaces and API replicas.
        var locked=await db.Users.Where(u=>u.Id==uid&&u.IsActive).ExecuteUpdateAsync(s=>s.SetProperty(u=>u.IsActive,u=>u.IsActive),ct);
        if(locked!=1)throw new ForbiddenException("Your account is unavailable.");
        var doc=await resumes.GetAsync(req.ResumeId,req.Number,ct);var v=doc.Versions.Single();
        var existing=await Mine.FirstOrDefaultAsync(p=>p.ResumeVersionId==v.Id&&p.TemplateId==req.TemplateId&&p.Format==req.Format,ct);
        if(existing!=null)
        {
            if(existing.Status is "refunded" or "deleted")throw new ConflictException("This purchase is no longer available. Contact support before attempting another payment.","RESUME_PURCHASE_UNAVAILABLE");
            if(existing.ProviderOrderId is null)throw new ConflictException("The original order is being prepared or needs reconciliation. Check purchase status before paying again.","RESUME_ORDER_RECONCILIATION_REQUIRED");
            await prepare.CommitIfOwnedAsync(ct);return Dto(existing);
        }
        if(await Mine.CountAsync(p=>p.Status!="paid"&&p.Status!="refunded",ct)>=20)throw new ConflictException("Resolve pending purchases before starting another.");
        var file=await resumes.PrepareCleanAsync(req.ResumeId,req.Number,req.TemplateId,req.Format,ct);
        var row=new ResumeExportPurchase{UserId=ctx.RequireUserId(),ResumeVersionId=v.Id,TemplateId=req.TemplateId,Format=req.Format,TaxPercent=options.Value.TaxPercent!.Value,TaxLabel=options.Value.TaxLabel.Trim(),ArtifactSha256=Convert.ToHexString(SHA256.HashData(file.Bytes)),ArtifactKey=$"resume-exports/{ctx.RequireUserId():N}/{Guid.NewGuid():N}"};
        // Tax on the price actually charged for this purchase, not on a separate copy of it.
        row.TaxMinor=(long)decimal.Round(row.BaseMinor*row.TaxPercent/100,0,MidpointRounding.AwayFromZero);
        // Persist one immutable fulfillment record before contacting the gateway. Unknown outcomes never create replacement orders.
        db.ResumeExportPurchases.Add(row);await db.SaveChangesAsync(ct);await prepare.CommitIfOwnedAsync(ct);
        await using(var bytes=new MemoryStream(file.Bytes))await storage.SaveAsync(row.ArtifactKey,bytes,ct);
        row.Status="order-unknown";await db.SaveChangesAsync(ct);
        var order=await gateway.CreateOrderAsync(row.Id,row.BaseMinor+row.TaxMinor,ct);
        row.ProviderOrderId=order;row.Status="pending";row.Version++;recorder.Audit("billing.resume_order_created","ResumeExportPurchase",row.Id,null,new{row.BaseMinor,row.TaxMinor,row.Currency});await db.SaveChangesAsync(ct);return Dto(row);
    }
    public async Task<ResumeOrderCheckout> VerifyAsync(Guid id,ResumePaymentProof proof,CancellationToken ct)
    {
        Gate();var row=await RequireAsync(id,ct);
        if(row.ProviderOrderId is null||!gateway.VerifyCheckout(row.ProviderOrderId,proof.PaymentId,proof.Signature))throw new ForbiddenException("The payment signature is invalid.","PAYMENT_SIGNATURE_INVALID");
        var payment=await gateway.FetchAsync(proof.PaymentId,ct);await ApplyAsync(row,payment,ct);return Dto(row);
    }
    public async Task<ResumeOrderCheckout> RecoverAsync(Guid id,CancellationToken ct)
    {
        Gate();var row=await RequireAsync(id,ct);if(row.ProviderOrderId is null)throw new ConflictException("Support must reconcile this order before you retry payment.","RESUME_ORDER_RECONCILIATION_REQUIRED");
        var payments=await gateway.OrderPaymentsAsync(row.ProviderOrderId,ct);var captured=payments.FirstOrDefault(p=>p.OrderId==row.ProviderOrderId&&p.Status=="captured"&&p.AmountMinor==row.BaseMinor+row.TaxMinor&&p.Currency=="INR"&&p.RefundedMinor==0);
        if(captured!=null)await ApplyAsync(row,captured,ct);else if(row.ProviderPaymentId!=null)await ApplyAsync(row,await gateway.FetchAsync(row.ProviderPaymentId,ct),ct);
        return Dto(row);
    }
    private async Task ApplyAsync(ResumeExportPurchase row,VerifiedResumePayment payment,CancellationToken ct)
    {
        if(payment.OrderId!=row.ProviderOrderId||payment.AmountMinor!=row.BaseMinor+row.TaxMinor||payment.Currency!=row.Currency||row.ProviderPaymentId!=null&&payment.Id!=row.ProviderPaymentId)throw new ConflictException("This payment does not match the saved order.","PAYMENT_ORDER_MISMATCH");
        if(payment.RefundedMinor>0||payment.Status=="refunded"){
            if(row.Status!="refunded"){row.Status="refunded";row.Version++;recorder.Audit("billing.resume_payment_refunded","ResumeExportPurchase",row.Id);await db.SaveChangesAsync(ct);}return;
        }
        if(payment.Status!="captured")throw new ConflictException("Payment is awaiting capture. Use Check payment status; do not pay again.","PAYMENT_NOT_CAPTURED");
        if(row.Status=="refunded")throw new ConflictException("This purchase was refunded. Contact support.","PAYMENT_REFUNDED");
        if(row.Status=="paid")return;
        row.ProviderPaymentId=payment.Id;row.Status="paid";row.PaidAt=clock.Now;row.Version++;
        recorder.Audit("billing.resume_payment_captured","ResumeExportPurchase",row.Id,null,new{row.BaseMinor,row.TaxMinor,row.Currency,row.ProviderOrderId,row.ProviderPaymentId});await db.SaveChangesAsync(ct);
    }
    public async Task<IReadOnlyList<ResumeOrderCheckout>> ListAsync(CancellationToken ct)=> (await Mine.AsNoTracking().OrderByDescending(p=>p.CreatedAt).Take(100).ToListAsync(ct)).Select(Dto).ToArray();
    public async Task<(byte[] Bytes,string ContentType,string FileName)> DownloadAsync(Guid id,CancellationToken ct)
    {
        var row=await RequireAsync(id,ct);if(row.Status!="paid"||row.ProviderPaymentId==null||row.ArtifactKey==null||row.ResumeVersionId==null)throw new ConflictException("Only a verified paid export can be downloaded.","PAYMENT_REQUIRED");
        // Recheck capture/refunds on every download, and current source access, while retaining the purchased template after plan downgrade.
        await ApplyAsync(row,await gateway.FetchAsync(row.ProviderPaymentId,ct),ct);if(row.Status!="paid")throw new ConflictException("This purchase was refunded.","PAYMENT_REFUNDED");
        var version=await db.ResumeVersions.AsNoTracking().FirstOrDefaultAsync(v=>v.Id==row.ResumeVersionId&&v.UserId==ctx.RequireUserId(),ct)??throw new NotFoundException("Resume version not found.");
        await resumes.RevalidateAsync(version,ct);
        await using var stream=await storage.OpenReadAsync(row.ArtifactKey,ct)??throw new AppException(503,"RESUME_FILE_UNAVAILABLE","Your paid file is unavailable. Contact support with the purchase reference; do not pay again.");
        using var ms=new MemoryStream();await stream.CopyToAsync(ms,ct);var bytes=ms.ToArray();if(Convert.ToHexString(SHA256.HashData(bytes))!=row.ArtifactSha256)throw new AppException(503,"RESUME_FILE_UNAVAILABLE","The paid file could not be verified. Contact support; do not pay again.");
        row.FirstDownloadedAt??=clock.Now;await db.SaveChangesAsync(ct);return(bytes,row.Format=="pdf"?"application/pdf":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",$"resume-clean-v{version.Number}.{row.Format}");
    }
}
