using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
namespace ProjectManagement.Tests.Infrastructure;
public sealed class FakeMicrosoftProductivity : HttpMessageHandler
{
    private record Grant(string Email,string Scopes);
    private readonly ConcurrentDictionary<string,Grant> codes=new(),access=new(),refresh=new();
    public ConcurrentBag<string> SentMessages {get;}=new();
    public ConcurrentBag<string> CodeVerifiers {get;}=new();
    public bool MissingScope {get;set;}
    public bool ResponseLost {get;set;}
    public Action? BeforeMailSendResponse {get;set;}
    public bool MissingRefresh {get;set;}
    public bool InvalidProfile {get;set;}
    public Action? BeforeRefresh {get;set;}
    public bool RefreshFails {get;set;}
    public FakeInboxMailbox Inbox {get;}=new();
    public string IssueCode(string email="outlook@example.com",string scopes="User.Read Mail.Send"){
        var id=Convert.ToHexString(RandomNumberGenerator.GetBytes(12));
        codes[id]=new(email,scopes);return id;
    }
    private static HttpResponseMessage Json(object value,HttpStatusCode code=HttpStatusCode.OK)=>new(code){Content=new StringContent(JsonSerializer.Serialize(value),Encoding.UTF8,"application/json")};
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct){
        var uri=request.RequestUri!;
        if(uri.Host=="login.microsoftonline.com"&&uri.AbsolutePath.EndsWith("/token")){
            var fields=(await request.Content!.ReadAsStringAsync(ct)).Split('&').Select(s=>s.Split('=',2)).ToDictionary(p=>Uri.UnescapeDataString(p[0]),p=>Uri.UnescapeDataString(p[1]));
            Grant? grant;
            if(fields["grant_type"]=="authorization_code"){
                if(!codes.TryRemove(fields["code"],out grant))return Json(new{error="invalid_code"},HttpStatusCode.BadRequest);
                if(!fields.TryGetValue("code_verifier",out var verifier)||verifier.Length!=64)return Json(new{error="pkce_missing"},HttpStatusCode.BadRequest);
                CodeVerifiers.Add(verifier);
            }else{
                BeforeRefresh?.Invoke();
                if(RefreshFails||!refresh.TryGetValue(fields["refresh_token"],out grant))return Json(new{error="invalid_grant"},HttpStatusCode.BadRequest);
            }
            var scopes=MissingScope?"User.Read":grant.Scopes;grant=grant with{Scopes=scopes};
            var at="ms_at_"+Guid.NewGuid().ToString("N");var rt="ms_rt_"+Guid.NewGuid().ToString("N");access[at]=grant;refresh[rt]=grant;
            return Json(new{access_token=at,refresh_token=MissingRefresh?null:rt,scope=scopes,expires_in=3600});
        }
        var token=request.Headers.Authorization?.Parameter??"";
        if(!access.TryGetValue(token,out var known))return Json(new{error="invalid_token"},HttpStatusCode.Unauthorized);
        if(uri.Host=="graph.microsoft.com"&&request.Method==HttpMethod.Get&&uri.AbsolutePath.StartsWith("/v1.0/me/")&&uri.AbsolutePath.Contains("messages")){
            if(!known.Scopes.Split(' ').Contains("Mail.Read"))return Json(new{error="permission"},HttpStatusCode.Forbidden);
            return Inbox.Read(request,known.Email,false);
        }
        if(uri.Host=="graph.microsoft.com"&&uri.AbsolutePath=="/v1.0/me"){
            return Json(new{id="provider_"+known.Email,mail=InvalidProfile?"invalid\r\nsender":known.Email,userPrincipalName=known.Email});
        }
        if(uri.Host=="graph.microsoft.com"&&uri.AbsolutePath=="/v1.0/me/sendMail"){
            if(!known.Scopes.Contains("Mail.Send"))return Json(new{error="permission"},HttpStatusCode.Forbidden);
            SentMessages.Add(await request.Content!.ReadAsStringAsync(ct));
            BeforeMailSendResponse?.Invoke();
            if(ResponseLost)throw new HttpRequestException("Fake response lost after processing");
            var response=new HttpResponseMessage(HttpStatusCode.Accepted);response.Headers.Add("request-id",Guid.NewGuid().ToString());return response;
        }
        return new HttpResponseMessage(HttpStatusCode.NotFound);
    }
    public void Reset(){MissingScope=false;ResponseLost=false;MissingRefresh=false;InvalidProfile=false;RefreshFails=false;BeforeRefresh=null;BeforeMailSendResponse=null;Inbox.Reset();}
}
