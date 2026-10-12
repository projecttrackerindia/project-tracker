using ProjectManagement.Application.Features.Resumes;
namespace ProjectManagement.Tests.Infrastructure;
public class FakeResumePayments:IResumePaymentGateway
{
    public bool Configured{get;set;}
    public string PublicKey=>"rzp_test_resume";
    public Dictionary<string,List<VerifiedResumePayment>> Orders{get;}=new();
    public int Created{get;private set;}
    public Task<string> CreateOrderAsync(Guid purchaseId,long amountMinor,CancellationToken ct){var id="order_"+purchaseId.ToString("N");Orders[id]=[];Created++;return Task.FromResult(id);}
    public bool VerifyCheckout(string orderId,string paymentId,string signature)=>signature=="valid";
    public Task<VerifiedResumePayment> FetchAsync(string paymentId,CancellationToken ct)=>Task.FromResult(Orders.Values.SelectMany(x=>x).Single(p=>p.Id==paymentId));
    public Task<IReadOnlyList<VerifiedResumePayment>> OrderPaymentsAsync(string orderId,CancellationToken ct)=>Task.FromResult<IReadOnlyList<VerifiedResumePayment>>(Orders[orderId]);
    public void Reset(){Configured=false;Orders.Clear();Created=0;}
}
