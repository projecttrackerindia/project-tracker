using System.Net;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Resumes;
using ProjectManagement.Tests.Infrastructure;
namespace ProjectManagement.Tests;
[Collection("api")]
public class ResumePurchaseTests(ApiFactory factory)
{
    [Fact]
    public async Task Captured_payment_unlocks_only_bound_artifact_and_recover_or_redownload_never_creates_another_order()
    {
        var owner=await TestClient.RegisterAsync(factory,"Paid Resume");var stranger=await TestClient.RegisterAsync(factory);
        var made=await owner.Post("/api/v1/me/resumes",new{title="Clean export",expectedVersion=0,content=new{name="Paid Resume",headline="Engineer",contact="paid@example.com",summary="Verified personal experience",sections=Array.Empty<object>()}});Assert.True(made.Ok,made.ToString());var id=made.Data!["id"]!.GetValue<string>();
        Assert.True((await owner.Post($"/api/v1/me/resumes/{id}/versions/1/approve")).Ok);
        var opt=factory.Services.GetRequiredService<IOptions<ResumeCheckoutOptions>>().Value;var prev=(opt.Enabled,opt.TaxPercent,opt.TaxLabel);
        opt.Enabled=true;opt.TaxPercent=18;opt.TaxLabel="Test tax";factory.ResumePayments.Configured=true;
        try{
            var order=await owner.Post("/api/v1/me/resume-purchases",new{resumeId=id,number=1,templateId=1,format="pdf"});Assert.True(order.Ok,order.ToString());var purchase=order.Data!["purchaseId"]!.GetValue<string>();var orderId=order.Data["orderId"]!.GetValue<string>();
            Assert.Equal(4900,order.Data["baseMinor"]!.GetValue<int>());Assert.Equal(882,order.Data["taxMinor"]!.GetValue<int>());
            Assert.Equal(HttpStatusCode.Conflict,(await owner.Get($"/api/v1/me/resume-purchases/{purchase}/download")).Status);
            Assert.Equal(HttpStatusCode.NotFound,(await stranger.Post($"/api/v1/me/resume-purchases/{purchase}/recover")).Status);
            Assert.Equal("PAYMENT_SIGNATURE_INVALID",(await owner.Post($"/api/v1/me/resume-purchases/{purchase}/verify",new{paymentId="pay_test",signature="forged"})).ErrorCode);
            factory.ResumePayments.Orders[orderId].Add(new("pay_test",orderId,5782,"INR","authorized",0));
            Assert.Equal("PAYMENT_NOT_CAPTURED",(await owner.Post($"/api/v1/me/resume-purchases/{purchase}/verify",new{paymentId="pay_test",signature="valid"})).ErrorCode);
            factory.ResumePayments.Orders[orderId][0]=new("pay_test",orderId,5782,"INR","captured",0);
            var recovered=await owner.Post($"/api/v1/me/resume-purchases/{purchase}/recover");Assert.Equal("paid",recovered.Data!["status"]!.GetValue<string>());
            var again=await owner.Post("/api/v1/me/resume-purchases",new{resumeId=id,number=1,templateId=1,format="pdf"});Assert.Equal(purchase,again.Data!["purchaseId"]!.GetValue<string>());Assert.Equal(1,factory.ResumePayments.Created);
            using var download=await owner.Raw($"/api/v1/me/resume-purchases/{purchase}/download");Assert.Equal(HttpStatusCode.OK,download.StatusCode);var bytes=await download.Content.ReadAsByteArrayAsync();using(var parsed=UglyToad.PdfPig.PdfDocument.Open(bytes)){var text=string.Join(" ",parsed.GetPages().Select(p=>p.Text));Assert.Contains("Paid Resume",text);Assert.DoesNotContain("Project Tracker",text);}
            using var repeat=await owner.Raw($"/api/v1/me/resume-purchases/{purchase}/download");Assert.Equal(bytes,await repeat.Content.ReadAsByteArrayAsync());Assert.Equal(1,factory.ResumePayments.Created);
            factory.ResumePayments.Orders[orderId][0]=new("pay_test",orderId,5782,"INR","refunded",5782);
            Assert.Equal("PAYMENT_REFUNDED",(await owner.Get($"/api/v1/me/resume-purchases/{purchase}/download")).ErrorCode);
        }finally{(opt.Enabled,opt.TaxPercent,opt.TaxLabel)=prev;factory.ResumePayments.Reset();}
    }
}
