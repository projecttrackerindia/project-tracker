using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
namespace ProjectManagement.Tests.Infrastructure;

public sealed class FakeSentMailbox
{
    private record Saved(string Account,string Marker,JsonElement Metadata);
    private readonly ConcurrentDictionary<string,Saved> records=new();
    public bool Empty {get;set;}
    public bool Paged {get;set;}
    public bool Mismatch {get;set;}
    public bool Duplicate {get;set;}
    public bool Failure {get;set;}
    public Action? BeforeRead {get;set;}
    public ConcurrentBag<string> Reads {get;}=new();
    public void AddMicrosoftHistory(string account){
        for(var i=0;i<25;i++){var id="sent_old_"+Guid.NewGuid().ToString("N");records[id]=new(account,"",JsonSerializer.SerializeToElement(new{id,subject="Old sent item",from=new{emailAddress=new{address=account}},toRecipients=new[]{new{emailAddress=new{address="recipient@example.test"}}},isDraft=false,sentDateTime=DateTimeOffset.UtcNow.AddDays(-2).ToString("O")}));}
    }
    public void Reset(){Empty=false;Paged=false;Mismatch=false;Duplicate=false;Failure=false;BeforeRead=null;}
    private static HttpResponseMessage Json(object data)=>new(HttpStatusCode.OK){Content=new StringContent(JsonSerializer.Serialize(data),Encoding.UTF8,"application/json")};
    public void Google(string account,string mime){
        var lines=mime.Split("\r\n\r\n",2)[0].Split("\r\n");var headers=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);string? previous=null;
        foreach(var line in lines){if(line.StartsWith(' ')&&previous!=null){headers[previous]+="\r\n"+line;continue;}var pair=line.Split(':',2);if(pair.Length==2){previous=pair[0];headers[previous]=pair[1].Trim();}}
        var id="sent_"+Guid.NewGuid().ToString("N");
        var metadata=JsonSerializer.SerializeToElement(new{id,labelIds=new[]{"SENT"},internalDate=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(),payload=new{headers=headers.Select(h=>new{name=h.Key,value=h.Value})}});
        records[id]=new(account,headers.GetValueOrDefault("Message-ID", ""),metadata);
    }
    public void Microsoft(string account,string json){
        using var payload=JsonDocument.Parse(json);var message=payload.RootElement.GetProperty("message");
        var id="sent_"+Guid.NewGuid().ToString("N");
        var metadata=JsonSerializer.SerializeToElement(new{id,subject=message.GetProperty("subject").GetString(),from=new{emailAddress=new{address=account}},toRecipients=message.GetProperty("toRecipients").Clone(),internetMessageHeaders=message.GetProperty("internetMessageHeaders").Clone(),isDraft=false,sentDateTime=DateTimeOffset.UtcNow.ToString("O")});
        records[id]=new(account,"",metadata);
    }
    public HttpResponseMessage Read(HttpRequestMessage request,string account,bool google){
        Reads.Add(request.RequestUri!.PathAndQuery);BeforeRead?.Invoke();if(Failure)throw new HttpRequestException("Synthetic Sent read interrupted");
        var uri=request.RequestUri!;var list=google?uri.AbsolutePath.EndsWith("/messages"):uri.AbsolutePath.EndsWith("/sentitems/messages");
        if(list){
            var rows=records.Values.Where(s=>s.Account==account&&!Empty);
            if(google){var q=uri.Query.TrimStart('?').Split('&').Select(s=>s.Split('=',2)).ToDictionary(s=>s[0],s=>Uri.UnescapeDataString(s[1]));var marker=q["q"]["rfc822msgid:".Length..];rows=rows.Where(s=>s.Marker==marker);}
            else{
                var query=uri.Query.TrimStart('?').Split('&').Select(s=>s.Split('=',2)).ToDictionary(s=>s[0],s=>Uri.UnescapeDataString(s[1]));
                if(query.TryGetValue("$filter",out var filter)){var parts=filter.Split(' ');var start=DateTimeOffset.Parse(parts[2]);var end=DateTimeOffset.Parse(parts[6]);rows=rows.Where(s=>{var time=DateTimeOffset.Parse(s.Metadata.GetProperty("sentDateTime").GetString()!);return time>=start&&time<=end;});}
            }
            var values=rows.Select(s=>s.Metadata).ToList();if(Duplicate&&values.Count>0)values.Add(values[0]);
            if(google){var fields=new Dictionary<string,object>{{"messages",values.Select(s=>new{id=s.GetProperty("id").GetString()})}};if(Paged)fields["nextPageToken"]="untrusted";return Json(fields);}
            var result=new Dictionary<string,object>{{"value",values.Take(20)}};if(Paged||values.Count>20)result["@odata.nextLink"]="https://untrusted.invalid/next";return Json(result);
        }
        var id=Uri.UnescapeDataString(uri.AbsolutePath.Split('/').Last());
        if(Empty||!records.TryGetValue(id,out var row)||row.Account!=account)return new(HttpStatusCode.NotFound);
        if(Mismatch){var fields=JsonSerializer.Deserialize<Dictionary<string,JsonElement>>(row.Metadata.GetRawText())!;
            if(google)fields["payload"]=JsonSerializer.SerializeToElement(new{headers=new[]{new{name="X-ProjectTracker-Operation",value="wrong-marker"}}});
            else fields["internetMessageHeaders"]=JsonSerializer.SerializeToElement(new[]{new{name="x-projecttracker-operation",value="wrong-marker"}});
            return Json(fields);}
        return Json(row.Metadata);
    }
}
