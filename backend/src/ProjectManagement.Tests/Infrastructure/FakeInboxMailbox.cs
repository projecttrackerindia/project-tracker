using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
namespace ProjectManagement.Tests.Infrastructure;
public class FakeInboxMailbox
{
    public Action? BeforeRead {get;set;}
    public bool Oversized {get;set;}
    public bool Paged {get;set;}
    public bool HtmlOnly {get;set;}
    public bool WrongThread {get;set;}
    public string? NextLink {get;set;}
    public ConcurrentBag<string> Requests {get;}=new();
    private static HttpResponseMessage Json(object value)=>new(HttpStatusCode.OK){Content=new StringContent(JsonSerializer.Serialize(value),Encoding.UTF8,"application/json")};
    public HttpResponseMessage Read(HttpRequestMessage request,string email,bool google)
    {
        Requests.Add(request.RequestUri!.AbsoluteUri);BeforeRead?.Invoke();
        if(Oversized)return Json(new{value=new string('x',1048577)});
        var path=request.RequestUri.AbsolutePath;
        if(google){
            var mail=new{id="1001",threadId=WrongThread?"dead":"2001",internalDate="1791705600000",labelIds=new[]{"INBOX","UNREAD"},
                payload=new{mimeType=HtmlOnly?"text/html":"text/plain",headers=new[]{new{name="From",value=email},new{name="Subject",value="Private inbox fixture"}},
                    body=new{data=Convert.ToBase64String(Encoding.UTF8.GetBytes(HtmlOnly?"<script>doSomething()</script>":"Private content for "+email)).TrimEnd('=').Replace('+','-').Replace('/','_')}}};
            if(path=="/gmail/v1/users/me/messages")return Json(new{messages=new[]{new{id="1001",threadId="2001"}},nextPageToken=Paged?"private-provider-page":null});
            if(path=="/gmail/v1/users/me/messages/1001")return Json(mail);
            if(path=="/gmail/v1/users/me/threads/2001")return Json(new{id="2001",messages=new[]{mail}});
        }else{
            var mail=new{id="message1",conversationId=WrongThread?"wrong":"conversation1",subject="Private inbox fixture",from=new{emailAddress=new{address=email}},
                receivedDateTime="2026-10-11T08:00:00Z",isRead=false,hasAttachments=false,body=new{contentType=HtmlOnly?"html":"text",content=HtmlOnly?"<script>doSomething()</script>":"Private content for "+email}};
            if(path=="/v1.0/me/mailFolders/inbox/messages")return Json(new Dictionary<string,object?>{{"value",new[]{mail}},{"@odata.nextLink",NextLink??(Paged?"https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=20&$skip=20":null)}});
            if(path=="/v1.0/me/messages/message1")return Json(mail);
            if(path=="/v1.0/me/messages"){
                if(WrongThread)return Json(new{value=new[]{new{id="message2",conversationId="other-conversation"}}});
                return Json(new{value=new[]{mail}});
            }
        }
        return new(HttpStatusCode.NotFound);
    }
    public void Reset(){BeforeRead=null;Oversized=false;Paged=false;HtmlOnly=false;WrongThread=false;NextLink=null;Requests.Clear();}
}
