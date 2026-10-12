using System.Globalization;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
namespace ProjectManagement.Application.Features.Integrations;
public record OwnMicrosoftCalendar(string Id,string Name,bool IsDefault);
public record MicrosoftCalendarInventory(string Account,string AccessContext,IReadOnlyList<OwnMicrosoftCalendar> Calendars,bool Truncated);
public record CalendarReadWindow(string[] CalendarIds,string AccessContext,[property:JsonConverter(typeof(CalendarInstantConverter))]DateTimeOffset Start,[property:JsonConverter(typeof(CalendarInstantConverter))]DateTimeOffset End);
public record CalendarBusyWindow(DateTimeOffset StartUtc,DateTimeOffset EndUtc);
public record MicrosoftCalendarAvailability(string Account,string AccessContext,IReadOnlyList<string> CalendarIds,DateTimeOffset StartUtc,DateTimeOffset EndUtc,IReadOnlyList<CalendarBusyWindow> Busy,DateTime CheckedAt,string Scope);
// Explicit own-calendar reads. No event titles, bodies, attendees, shared calendar reads, AI or writes.
public class MicrosoftCalendarReadService(IAppDbContext db,ICurrentContext ctx,MicrosoftProductivityAuthService auth,IOptions<MicrosoftProductivityOptions> options,IHttpClientFactory http,IServiceProvider services,AppClock clock)
{
    private record Grant(Guid User,Guid Tenant,MicrosoftMailGrant Access);
    private static string Hash(string value)=>Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    private static string Context(Grant g)=>Hash(JsonSerializer.Serialize(new{g.User,g.Tenant,g.Access.ConnectionId,g.Access.ConsentEpoch,g.Access.Email}));
    private static ConflictException Invalid()=>new("Calendar availability could not be checked completely. Review it in Outlook.","MICROSOFT_CALENDAR_INCOMPLETE");
    private static string Text(JsonElement e,string name,int max=500)=>e.TryGetProperty(name,out var p)&&p.ValueKind==JsonValueKind.String&&p.GetString() is {Length:>0} text&&text.Length<=max&&!text.Any(char.IsControl)?text:throw Invalid();
    private static bool Bool(JsonElement e,string name)=>e.TryGetProperty(name,out var p)&&p.ValueKind is JsonValueKind.True or JsonValueKind.False?p.GetBoolean():throw Invalid();
    private static string Id(string? id){if(string.IsNullOrWhiteSpace(id)||id.Length>500||id.Any(c=>!char.IsAsciiLetterOrDigit(c)&&!"_-+/=".Contains(c)))throw new ValidationException("calendarIds","Invalid calendar reference.");return Uri.EscapeDataString(id);}
    private async Task<Grant> GrantAsync(CancellationToken ct){
        var uid=ctx.RequireUserId();var tid=ctx.RequireTenantId();await WorkspaceExecutionPrincipal.ConfigureAsync(services,uid,tid,null,ct);
        var grant=new Grant(uid,tid,await auth.GetCalendarGrantAsync(ct));await Recheck(grant,ct);return grant;
    }
    private async Task Recheck(Grant g,CancellationToken ct){
        await WorkspaceExecutionPrincipal.ConfigureAsync(services,g.User,g.Tenant,null,ct);
        var c=await db.MicrosoftConnections.AsNoTracking().SingleOrDefaultAsync(c=>c.UserId==g.User,ct);
        if(!options.Value.Enabled||!options.Value.Configured||!options.Value.CalendarsEnabled||c==null||c.Id!=g.Access.ConnectionId||c.ConsentEpoch!=g.Access.ConsentEpoch||c.Email!=g.Access.Email||Hash(c.RefreshTokenProtected)!=g.Access.RefreshFingerprint||!c.Scopes.Split(' ').Any(s=>s.Split('/').Last().Equals("Calendars.ReadBasic",StringComparison.OrdinalIgnoreCase)))
            throw new ConflictException("Your calendar connection changed. Reload your calendar list.","MICROSOFT_CALENDAR_CONNECTION_CHANGED");
    }
    private async Task<JsonDocument> Read(Grant g,string path,int bound,CancellationToken ct){
        using var request=new HttpRequestMessage(HttpMethod.Get,"https://graph.microsoft.com/v1.0/me/"+path);request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",g.Access.AccessToken);request.Headers.Add("Prefer","outlook.timezone=\"UTC\"");
        using var response=await http.CreateClient("microsoft-productivity").SendAsync(request,HttpCompletionOption.ResponseHeadersRead,ct);if(!response.IsSuccessStatusCode)throw Invalid();
        await using var stream=await response.Content.ReadAsStreamAsync(ct);var bytes=new byte[bound+1];var size=0;int n;
        while(size<bytes.Length&&(n=await stream.ReadAsync(bytes.AsMemory(size),ct))>0)size+=n;
        if(size>bound)throw Invalid();try{var doc=JsonDocument.Parse(bytes.AsMemory(0,size));if(doc.RootElement.ValueKind!=JsonValueKind.Object){doc.Dispose();throw Invalid();}return doc;}catch(JsonException){throw Invalid();}
    }
    private static JsonElement[] Values(JsonElement root,int max){if(!root.TryGetProperty("value",out var array)||array.ValueKind!=JsonValueKind.Array||array.GetArrayLength()>max||array.EnumerateArray().Any(e=>e.ValueKind!=JsonValueKind.Object))throw Invalid();return array.EnumerateArray().ToArray();}
    private async Task<MicrosoftCalendarInventory> Inventory(Grant g,CancellationToken ct){
        using var doc=await Read(g,"calendars?$top=20&$select=id,name,isDefaultCalendar,owner",65536,ct);var calendars=new List<OwnMicrosoftCalendar>();
        foreach(var c in Values(doc.RootElement,20)){
            if(!c.TryGetProperty("owner",out var owner)||owner.ValueKind!=JsonValueKind.Object)throw Invalid();
            var email=Text(owner,"address",254);if(!email.Equals(g.Access.Email,StringComparison.OrdinalIgnoreCase))continue;
            var id=Text(c,"id");Id(id);calendars.Add(new(id,Text(c,"name",200),Bool(c,"isDefaultCalendar")));
        }
        if(calendars.Select(c=>c.Id).Distinct(StringComparer.Ordinal).Count()!=calendars.Count)throw Invalid();
        await Recheck(g,ct);return new(g.Access.Email,Context(g),calendars,doc.RootElement.TryGetProperty("@odata.nextLink",out _));
    }
    private static ConflictException Timeout()=>new("Outlook did not respond within the waiting limit. Retry this read when ready.","MICROSOFT_CALENDAR_TIMEOUT");
    public async Task<MicrosoftCalendarInventory> ListAsync(CancellationToken ct){
        using var deadline=CancellationTokenSource.CreateLinkedTokenSource(ct);deadline.CancelAfter(TimeSpan.FromSeconds(20));
        try{return await Inventory(await GrantAsync(deadline.Token),deadline.Token);}
        catch(OperationCanceledException)when(!ct.IsCancellationRequested){throw Timeout();}
        catch(Exception e)when(e is HttpRequestException or IOException){throw Invalid();}
    }
    private static DateTimeOffset Instant(JsonElement e,string name){
        if(!e.TryGetProperty(name,out var value)||value.ValueKind!=JsonValueKind.Object||Text(value,"timeZone",100)!="UTC"||!DateTimeOffset.TryParse(Text(value,"dateTime",64),CultureInfo.InvariantCulture,DateTimeStyles.AssumeUniversal,out var instant)||instant.Offset!=TimeSpan.Zero)throw Invalid();return instant.ToUniversalTime();
    }
    public async Task<MicrosoftCalendarAvailability> AvailabilityAsync(CalendarReadWindow req,CancellationToken ct){
        try{return await CheckAsync(req,ct);}
        catch(OperationCanceledException)when(!ct.IsCancellationRequested){throw Timeout();}
        catch(Exception e)when(e is HttpRequestException or IOException){throw Invalid();}
    }
    private async Task<MicrosoftCalendarAvailability> CheckAsync(CalendarReadWindow req,CancellationToken ct){
        var ids=req.CalendarIds;if(ids==null||ids.Length is <1 or >5||ids.Distinct(StringComparer.Ordinal).Count()!=ids.Length)throw new ValidationException("calendarIds","Select one to five distinct calendars.");foreach(var id in ids)Id(id);
        if(req.AccessContext==null||req.AccessContext.Length!=64)throw new ValidationException("accessContext","Reload the calendar list before checking.");
        if(req.Start<new DateTimeOffset(clock.Now).AddDays(-1)||req.Start>new DateTimeOffset(clock.Now).AddYears(1)||req.End<=req.Start||req.End-req.Start>TimeSpan.FromHours(24))throw new ValidationException("start","Check a window of up to 24 hours, within the next year.");
        using var deadline=CancellationTokenSource.CreateLinkedTokenSource(ct);deadline.CancelAfter(TimeSpan.FromSeconds(20));var g=await GrantAsync(deadline.Token);
        if(!Context(g).Equals(req.AccessContext,StringComparison.Ordinal))throw new ConflictException("Your calendar account changed. Reload the list.","MICROSOFT_CALENDAR_CONNECTION_CHANGED");
        var inventory=await Inventory(g,deadline.Token);if(ids.Any(id=>!inventory.Calendars.Any(c=>c.Id==id)))throw new NotFoundException("A selected own calendar is unavailable. Reload the calendar list.");
        var busy=new List<CalendarBusyWindow>();
        foreach(var id in ids){
            using var doc=await Read(g,"calendars/"+Id(id)+"/calendarView?$top=100&$select=start,end,isCancelled,showAs&startDateTime="+Uri.EscapeDataString(req.Start.ToUniversalTime().ToString("o"))+"&endDateTime="+Uri.EscapeDataString(req.End.ToUniversalTime().ToString("o")),131072,deadline.Token);
            if(doc.RootElement.TryGetProperty("@odata.nextLink",out _))throw Invalid();
            foreach(var e in Values(doc.RootElement,100)){
                if(Bool(e,"isCancelled"))continue;var status=Text(e,"showAs",30);if(status is not ("free" or "tentative" or "busy" or "oof" or "workingElsewhere"))throw Invalid();
                var start=Instant(e,"start");var end=Instant(e,"end");if(end<=start)throw Invalid();
                if(status=="free"||start>=req.End||end<=req.Start)continue;
                busy.Add(new(start<req.Start?req.Start.ToUniversalTime():start,end>req.End?req.End.ToUniversalTime():end));
            }
            await Recheck(g,deadline.Token);
        }
        var merged=new List<CalendarBusyWindow>();foreach(var interval in busy.OrderBy(b=>b.StartUtc)){
            if(merged.Count==0||merged[^1].EndUtc<interval.StartUtc)merged.Add(interval);else if(interval.EndUtc>merged[^1].EndUtc)merged[^1]=merged[^1] with{EndUtc=interval.EndUtc};
        }
        await Recheck(g,deadline.Token);return new(g.Access.Email,Context(g),ids,req.Start.ToUniversalTime(),req.End.ToUniversalTime(),merged,clock.Now,"Selected own Outlook calendars only. Other calendars and attendees are not checked. Availability can change after this read.");
    }
}
