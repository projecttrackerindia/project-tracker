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
    public FakeSentMailbox Sent {get;}=new();
    public Action<string>? BeforeCalendarRead {get;set;}
    public bool CalendarPaged {get;set;}
    public bool CalendarOversized {get;set;}
    public bool CalendarTransportFailure {get;set;}
    public Func<DateTimeOffset,DateTimeOffset,object[]>? CalendarEvents {get;set;}
    public ConcurrentBag<string> CalendarReads {get;}=new();
    /// <summary>Outlook events created as people (Teams meetings): id -> the event as last written.</summary>
    public ConcurrentDictionary<string,System.Text.Json.Nodes.JsonObject> Events {get;}=new();
    public ConcurrentBag<string> CancelledEvents {get;}=new();
    /// <summary>Attendee answers Outlook reports (email -> accepted, declined, tentativelyAccepted, none).</summary>
    public ConcurrentDictionary<string,string> Responses {get;}=new(StringComparer.OrdinalIgnoreCase);
    public bool EventsFail {get;set;}
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
        if(uri.Host=="graph.microsoft.com"&&request.Method==HttpMethod.Get&&uri.AbsolutePath.StartsWith("/v1.0/me/calendars")){
            if(!known.Scopes.Split(' ').Any(s=>s.Split('/').Last()=="Calendars.ReadBasic"))return Json(new{error="permission"},HttpStatusCode.Forbidden);
            CalendarReads.Add(uri.PathAndQuery);BeforeCalendarRead?.Invoke(uri.AbsolutePath);
            if(CalendarTransportFailure)throw new HttpRequestException("Synthetic calendar transport failed");
            if(CalendarOversized)return Json(new{value=new string('x',140000)});
            if(uri.AbsolutePath=="/v1.0/me/calendars")return Json(new{value=new object[]{
                new{id="own1",name=known.Email+" primary",isDefaultCalendar=true,owner=new{address=known.Email}},
                new{id="own2",name=known.Email+" secondary",isDefaultCalendar=false,owner=new{address=known.Email}},
                new{id="shared",name="Another person's calendar",isDefaultCalendar=false,owner=new{address="other-owner@example.com"}}
            }});
            if(uri.AbsolutePath.EndsWith("/calendarView")){
                var q=uri.Query.TrimStart('?').Split('&').Select(p=>p.Split('=',2)).ToDictionary(p=>Uri.UnescapeDataString(p[0]),p=>Uri.UnescapeDataString(p[1]));
                var start=DateTimeOffset.Parse(q["startDateTime"]);var end=DateTimeOffset.Parse(q["endDateTime"]);var events=CalendarEvents?.Invoke(start,end)??Array.Empty<object>();
                if(CalendarPaged)return Json(new Dictionary<string,object>{{"value",events},{"@odata.nextLink","https://untrusted.invalid/next"}});
                return Json(new{value=events});
            }
        }
        if(uri.Host=="graph.microsoft.com"&&request.Method==HttpMethod.Get&&uri.AbsolutePath.StartsWith("/v1.0/me/")&&uri.AbsolutePath.Contains("messages")){
            if(!known.Scopes.Split(' ').Contains("Mail.Read"))return Json(new{error="permission"},HttpStatusCode.Forbidden);
            if(uri.AbsolutePath.Contains("/mailFolders/sentitems/messages"))return Sent.Read(request,known.Email,false);
            return Inbox.Read(request,known.Email,false);
        }
        if(uri.Host=="graph.microsoft.com"&&uri.AbsolutePath.StartsWith("/v1.0/me/events")){
            if(!known.Scopes.Split(' ').Any(x=>x.Split('/').Last()=="Calendars.ReadWrite"))return Json(new{error="permission"},HttpStatusCode.Forbidden);
            if(EventsFail)return Json(new{error="busy"},HttpStatusCode.ServiceUnavailable);
            var parts=uri.AbsolutePath.Split('/',StringSplitOptions.RemoveEmptyEntries);   // v1.0, me, events, {id}, cancel
            var body=request.Content is null?null:System.Text.Json.Nodes.JsonNode.Parse(await request.Content.ReadAsStringAsync(ct)) as System.Text.Json.Nodes.JsonObject;
            if(parts.Length==3&&request.Method==HttpMethod.Post){
                var id="evt_"+Guid.NewGuid().ToString("N")[..12];
                body!["id"]=id;body["webLink"]="https://outlook.office365.com/owa/?itemid="+id;
                body["onlineMeeting"]=new System.Text.Json.Nodes.JsonObject{["joinUrl"]="https://teams.microsoft.com/l/meetup-join/"+id};
                body["organizer"]=known.Email;
                Events[id]=body;return Json(body,HttpStatusCode.Created);
            }
            if(parts.Length<4||!Events.TryGetValue(Uri.UnescapeDataString(parts[3]),out var ev))return Json(new{error="not found"},HttpStatusCode.NotFound);
            if(parts.Length==5&&parts[4]=="cancel"&&request.Method==HttpMethod.Post){CancelledEvents.Add(parts[3]);Events.TryRemove(parts[3],out _);return new HttpResponseMessage(HttpStatusCode.Accepted);}
            if(request.Method==HttpMethod.Patch){foreach(var kv in body!.ToList()){body.Remove(kv.Key);ev[kv.Key]=kv.Value;}return Json(ev);}
            if(request.Method==HttpMethod.Get){
                var attendees=(ev["attendees"] as System.Text.Json.Nodes.JsonArray??[]).Select(a=>a!["emailAddress"]!["address"]!.GetValue<string>())
                    .Select(email=>new{emailAddress=new{address=email},status=new{response=Responses.TryGetValue(email,out var r)?r:"none"}});
                return Json(new{attendees});
            }
        }
        if(uri.Host=="graph.microsoft.com"&&uri.AbsolutePath=="/v1.0/me"){
            return Json(new{id="provider_"+known.Email,mail=InvalidProfile?"invalid\r\nsender":known.Email,userPrincipalName=known.Email});
        }
        if(uri.Host=="graph.microsoft.com"&&uri.AbsolutePath=="/v1.0/me/sendMail"){
            if(!known.Scopes.Contains("Mail.Send"))return Json(new{error="permission"},HttpStatusCode.Forbidden);
            var json=await request.Content!.ReadAsStringAsync(ct);SentMessages.Add(json);Sent.Microsoft(known.Email,json);
            BeforeMailSendResponse?.Invoke();
            if(ResponseLost)throw new HttpRequestException("Fake response lost after processing");
            var response=new HttpResponseMessage(HttpStatusCode.Accepted);response.Headers.Add("request-id",Guid.NewGuid().ToString());return response;
        }
        return new HttpResponseMessage(HttpStatusCode.NotFound);
    }
    public void Reset(){MissingScope=false;ResponseLost=false;MissingRefresh=false;InvalidProfile=false;RefreshFails=false;BeforeRefresh=null;BeforeMailSendResponse=null;BeforeCalendarRead=null;CalendarEvents=null;CalendarPaged=false;CalendarOversized=false;CalendarTransportFailure=false;Inbox.Reset();Events.Clear();Responses.Clear();EventsFail=false;}
}
