using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Resumes;
namespace ProjectManagement.Infrastructure.Services;
public class RazorpayResumeGateway(HttpClient http,IOptions<RazorpayOptions> options):IResumePaymentGateway
{
    private RazorpayOptions Opt=>options.Value;
    public bool Configured=>!string.IsNullOrWhiteSpace(Opt.KeyId)&&!string.IsNullOrWhiteSpace(Opt.KeySecret);
    public string PublicKey=>Opt.KeyId??"";
    private static string Id(string value,string prefix){if(!Regex.IsMatch(value,"^"+prefix+"_[A-Za-z0-9]{1,70}$"))throw new ValidationException("payment","Invalid provider reference.");return value;}
    private async Task<JsonElement> SendAsync(HttpMethod method,string path,object? body,CancellationToken ct)
    {
        if(!Configured)throw new ConflictException("Resume checkout is not configured.","RESUME_CHECKOUT_DISABLED");
        using var req=new HttpRequestMessage(method,Opt.BaseUrl.TrimEnd('/')+path);req.Headers.Authorization=new AuthenticationHeaderValue("Basic",Convert.ToBase64String(Encoding.UTF8.GetBytes(Opt.KeyId+":"+Opt.KeySecret)));if(body!=null)req.Content=JsonContent.Create(body);
        using var res=await http.SendAsync(req,ct);if(!res.IsSuccessStatusCode)throw new AppException(502,"PAYMENT_PROVIDER_UNAVAILABLE","Payment verification is temporarily unavailable. Your purchase is preserved; retry verification rather than paying again.");
        using var json=JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));return json.RootElement.Clone();
    }
    public async Task<string> CreateOrderAsync(Guid purchaseId,long amountMinor,CancellationToken ct)
    {
        var json=await SendAsync(HttpMethod.Post,"/orders",new{amount=amountMinor,currency="INR",receipt=purchaseId.ToString("N"),partial_payment=false,notes=new{purpose="resume-export",purchaseId=purchaseId.ToString("N")}},ct);
        if(json.GetProperty("amount").GetInt64()!=amountMinor||json.GetProperty("currency").GetString()!="INR"||json.GetProperty("receipt").GetString()!=purchaseId.ToString("N"))throw new AppException(502,"PAYMENT_ORDER_MISMATCH",$"The payment order could not be verified. Please write to {ProjectManagement.Application.Features.Auth.EmailTemplates.SupportEmail}.");
        return Id(json.GetProperty("id").GetString()!,"order");
    }
    public bool VerifyCheckout(string orderId,string paymentId,string signature)=>RazorpaySignature.Matches(RazorpaySignature.Hex(Opt.KeySecret??"",orderId+"|"+paymentId),signature);
    private static VerifiedResumePayment Payment(JsonElement p)=>new(p.GetProperty("id").GetString()!,p.GetProperty("order_id").GetString()??"",p.GetProperty("amount").GetInt64(),p.GetProperty("currency").GetString()!,p.GetProperty("status").GetString()!,p.TryGetProperty("amount_refunded",out var refunded)?refunded.GetInt64():0);
    public async Task<VerifiedResumePayment> FetchAsync(string paymentId,CancellationToken ct)=>Payment(await SendAsync(HttpMethod.Get,"/payments/"+Id(paymentId,"pay"),null,ct));
    public async Task<IReadOnlyList<VerifiedResumePayment>> OrderPaymentsAsync(string orderId,CancellationToken ct)
    {var json=await SendAsync(HttpMethod.Get,"/orders/"+Id(orderId,"order")+"/payments",null,ct);return json.GetProperty("items").EnumerateArray().Select(Payment).ToArray();}
}
