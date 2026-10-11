using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Integrations;
public record SaveCalendarProposal(string Title,string? Description,[property:JsonConverter(typeof(CalendarInstantConverter))]DateTimeOffset Start,[property:JsonConverter(typeof(CalendarInstantConverter))]DateTimeOffset End,string TimeZone);
public sealed class CalendarInstantConverter:JsonConverter<DateTimeOffset>
{
    public override DateTimeOffset Read(ref Utf8JsonReader reader,Type type,JsonSerializerOptions options){
        if(reader.TokenType!=JsonTokenType.String)throw new JsonException("Calendar times require explicit UTC offsets.");
        var text=reader.GetString();
        if(text==null||text.Length>64||!System.Text.RegularExpressions.Regex.IsMatch(text,@"(Z|[+-]\d{2}:\d{2})$")||!DateTimeOffset.TryParse(text,CultureInfo.InvariantCulture,DateTimeStyles.RoundtripKind,out var instant))
            throw new JsonException("Calendar times require explicit UTC offsets.");
        return instant;
    }
    public override void Write(Utf8JsonWriter writer,DateTimeOffset value,JsonSerializerOptions options)=>writer.WriteStringValue(value.ToString("o",CultureInfo.InvariantCulture));
}
public record ConfirmCalendarProposal(int Version,bool Confirmed,string Account);
public record CalendarProposalDto(Guid Id,string Title,string Description,DateTimeOffset StartUtc,DateTimeOffset EndUtc,string TimeZone,string Status,int Version,string? ConfirmedAccount,DateTime? VerifiedAt);
public record CalendarAvailability(int Version,int BlockingEvents,string Scope);
public class PersonalCalendarService(IAppDbContext db,ICurrentContext ctx,AppClock clock,Recorder recorder,
    GoogleCalendarAuthService auth,IOptions<GoogleCalendarOptions> options,IHttpClientFactory http,IServiceProvider services)
{
    private const string Events="https://www.googleapis.com/calendar/v3/calendars/primary/events";
    private const string CalendarScope="https://www.googleapis.com/auth/calendar.events";
    private IQueryable<PersonalCalendarProposal> Mine=>db.PersonalCalendarProposals.Where(p=>p.UserId==ctx.RequireUserId()&&p.Status!="deleted");
    private static CalendarProposalDto Dto(PersonalCalendarProposal p,bool detail=true)=>new(p.Id,p.Title,detail?p.Description:"",new DateTimeOffset(DateTime.SpecifyKind(p.StartUtc,DateTimeKind.Utc)),new DateTimeOffset(DateTime.SpecifyKind(p.EndUtc,DateTimeKind.Utc)),p.TimeZone,p.Status,p.Version,p.ConfirmedAccount,p.VerifiedAt);
    private void Enabled(){if(!options.Value.PersonalCalendarEnabled||!auth.Configured)throw new ConflictException("Personal Calendar is awaiting administrator setup.","PERSONAL_CALENDAR_DISABLED");}
    private async Task<PersonalCalendarProposal> Require(Guid id,CancellationToken ct){ctx.RequireTenantId();return await Mine.AsNoTracking().SingleOrDefaultAsync(p=>p.Id==id,ct)??throw new NotFoundException("Calendar proposal not found.");}
    public async Task<object> OptionsAsync(CancellationToken ct){ctx.RequireTenantId();var c=await db.GoogleConnections.AsNoTracking().SingleOrDefaultAsync(c=>c.UserId==ctx.RequireUserId(),ct);return new{enabled=options.Value.PersonalCalendarEnabled&&auth.Configured,account=c?.GoogleEmail,calendarAccess=c?.Scopes.Split(' ').Contains(CalendarScope)==true};}
    public async Task<IReadOnlyList<CalendarProposalDto>> ListAsync(CancellationToken ct){ctx.RequireTenantId();return await Mine.AsNoTracking().OrderByDescending(p=>p.CreatedAt).Take(100).Select(p=>new CalendarProposalDto(p.Id,p.Title,"",new DateTimeOffset(DateTime.SpecifyKind(p.StartUtc,DateTimeKind.Utc)),new DateTimeOffset(DateTime.SpecifyKind(p.EndUtc,DateTimeKind.Utc)),p.TimeZone,p.Status,p.Version,p.ConfirmedAccount,p.VerifiedAt)).ToArrayAsync(ct);}
    public async Task<CalendarProposalDto> GetAsync(Guid id,CancellationToken ct)=>Dto(await Require(id,ct));
    public async Task<CalendarProposalDto> SaveAsync(SaveCalendarProposal req,CancellationToken ct){
        var uid=ctx.RequireUserId();var tid=ctx.RequireTenantId();var title=req.Title?.Trim()??"";var description=req.Description??"";
        if(title.Length is <1 or >200||title.Any(char.IsControl)||description.Length>6000)throw new ValidationException("title","Use a title up to 200 characters and notes up to 6,000 characters.");
        if(req.Start<new DateTimeOffset(clock.Now).AddMinutes(1)||req.Start>new DateTimeOffset(clock.Now).AddYears(1)||req.End<=req.Start||req.End-req.Start>TimeSpan.FromHours(24))
            throw new ValidationException("start","Choose a future time within a year, ending within 24 hours.");
        if(string.IsNullOrWhiteSpace(req.TimeZone)||req.TimeZone.Length>100||NodaTime.DateTimeZoneProviders.Tzdb.GetZoneOrNull(req.TimeZone)==null)throw new ValidationException("timeZone","Choose a valid IANA time zone.");
        await using var tx=await db.Database.BeginOwnedTransactionAsync(ct);
        if(await db.Users.Where(u=>u.Id==uid&&u.IsActive).ExecuteUpdateAsync(s=>s.SetProperty(u=>u.IsActive,u=>u.IsActive),ct)!=1)throw new ForbiddenException("Your account is unavailable.");
        if(await Mine.CountAsync(ct)>=100)throw new ConflictException("Remove an older proposal before saving another.");
        var row=new PersonalCalendarProposal{TenantId=tid,UserId=uid,Title=title,Description=description,StartUtc=req.Start.UtcDateTime,EndUtc=req.End.UtcDateTime,TimeZone=req.TimeZone};
        db.PersonalCalendarProposals.Add(row);recorder.Audit("personal_calendar.saved","PersonalCalendarProposal",row.Id);
        await db.SaveChangesAsync(ct);await tx.CommitIfOwnedAsync(ct);return Dto(row);
    }
    private async Task<(string Account,string Token)> Grant(CancellationToken ct){
        Enabled();var uid=ctx.RequireUserId();
        var connection=await db.GoogleConnections.AsNoTracking().SingleOrDefaultAsync(c=>c.UserId==uid,ct)??throw new ConflictException("Connect Google Calendar first.","GOOGLE_NOT_CONNECTED");
        if(string.IsNullOrWhiteSpace(connection.GoogleEmail))throw new ConflictException("Reconnect Google to verify the calendar account.","CALENDAR_ACCOUNT_MISSING");
        var token=await auth.GetAccessTokenAsync(uid,ct,CalendarScope);
        await WorkspaceExecutionPrincipal.ConfigureAsync(services,uid,ctx.RequireTenantId(),null,ct);
        return(connection.GoogleEmail,token);
    }
    private async Task<JsonDocument?> Read(HttpRequestMessage request,CancellationToken ct,bool allowMissing=false){
        using var deadline=CancellationTokenSource.CreateLinkedTokenSource(ct);deadline.CancelAfter(TimeSpan.FromSeconds(20));
        using var response=await http.CreateClient("google-calendar").SendAsync(request,HttpCompletionOption.ResponseHeadersRead,deadline.Token);
        if(allowMissing&&response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Gone)return null;
        if(!response.IsSuccessStatusCode)throw new ConflictException("Google Calendar could not verify this request.","CALENDAR_PROVIDER_ERROR");
        await using var stream=await response.Content.ReadAsStreamAsync(deadline.Token);var buffer=new byte[65537];var length=0;int n;
        while(length<buffer.Length&&(n=await stream.ReadAsync(buffer.AsMemory(length),deadline.Token))>0)length+=n;
        if(length>65536)throw new ConflictException("Calendar response is too large to verify safely.","CALENDAR_PROVIDER_ERROR");
        try{var doc=JsonDocument.Parse(buffer.AsMemory(0,length));if(doc.RootElement.ValueKind!=JsonValueKind.Object){doc.Dispose();throw new JsonException();}return doc;}catch(JsonException){throw new ConflictException("Google Calendar returned an invalid response.","CALENDAR_PROVIDER_ERROR");}
    }
    private static HttpRequestMessage Request(HttpMethod method,string url,string token,object? body=null){
        var r=new HttpRequestMessage(method,url);r.Headers.Authorization=new AuthenticationHeaderValue("Bearer",token);
        if(body!=null)r.Content=new StringContent(JsonSerializer.Serialize(body),Encoding.UTF8,"application/json");return r;
    }
    private static string? Text(JsonElement e,string key)=>e.TryGetProperty(key,out var x)&&x.ValueKind==JsonValueKind.String?x.GetString():null;
    private async Task<int> Conflicts(PersonalCalendarProposal row,string token,CancellationToken ct){
        var url=Events+"?singleEvents=true&showDeleted=false&maxResults=100&timeMin="+Uri.EscapeDataString(row.StartUtc.ToString("o"))+"&timeMax="+Uri.EscapeDataString(row.EndUtc.ToString("o"));
        using var request=Request(HttpMethod.Get,url,token);using var doc=await Read(request,ct);
        var root=doc!.RootElement;
        if(root.TryGetProperty("nextPageToken",out _)||!root.TryGetProperty("items",out var items)||items.ValueKind!=JsonValueKind.Array)throw new ConflictException("Calendar availability could not be checked completely.","CALENDAR_AVAILABILITY_INCOMPLETE");
        if(items.EnumerateArray().Any(item=>item.ValueKind!=JsonValueKind.Object||Text(item,"status") is not ("confirmed" or "tentative" or "cancelled")))throw new ConflictException("Calendar availability returned invalid events.","CALENDAR_AVAILABILITY_INCOMPLETE");
        return items.EnumerateArray().Count(item=>Text(item,"status")!="cancelled"&&Text(item,"transparency")!="transparent");
    }
    public async Task<CalendarAvailability> AvailabilityAsync(Guid id,int version,CancellationToken ct){
        var row=await Require(id,ct);if(row.Version!=version||row.Status!="draft")throw new ConflictException("Reload the saved proposal before checking.");
        var grant=await Grant(ct);return new(row.Version,await Conflicts(row,grant.Token,ct),"Connected account's primary Google calendar only; other attendees and calendars are not checked.");
    }
    private static bool Instant(JsonElement root,string field,DateTime expected)=>root.TryGetProperty(field,out var value)&&value.ValueKind==JsonValueKind.Object&&DateTimeOffset.TryParse(Text(value,"dateTime"),CultureInfo.InvariantCulture,DateTimeStyles.RoundtripKind,out var instant)&&instant.UtcDateTime==expected;
    private static bool Matches(JsonElement root,PersonalCalendarProposal row){
        if(Text(root,"id")!=row.ProviderEventId||Text(root,"status")!="confirmed"||Text(root,"summary")!=row.Title||(Text(root,"description")??"")!=row.Description||!Instant(root,"start",row.StartUtc)||!Instant(root,"end",row.EndUtc))return false;
        if(root.TryGetProperty("attendees",out var attendees)&&(attendees.ValueKind!=JsonValueKind.Array||attendees.GetArrayLength()!=0))return false;
        return root.TryGetProperty("extendedProperties",out var ext)&&ext.ValueKind==JsonValueKind.Object&&ext.TryGetProperty("private",out var p)&&p.ValueKind==JsonValueKind.Object
            &&Text(p,"projectTrackerProposal")==row.Id.ToString("N")&&Text(p,"owner")==row.UserId.ToString("N")&&Text(p,"workspace")==row.TenantId.ToString("N");
    }
    private async Task<bool> Verify(PersonalCalendarProposal row,string token,CancellationToken ct){
        using var req=Request(HttpMethod.Get,Events+"/"+row.ProviderEventId,token);using var doc=await Read(req,ct,true);return doc!=null&&Matches(doc.RootElement,row);
    }
    public async Task<CalendarProposalDto> ConfirmAsync(Guid id,ConfirmCalendarProposal req,CancellationToken ct){
        var row=await Require(id,ct);
        if(!req.Confirmed)throw new ValidationException("confirmed","Review the account, saved title, notes and exact times before confirming.");
        if(row.Status=="verified")return Dto(row);
        if(row.Status!="draft")throw new ConflictException("Check the provider status; this proposal cannot be sent again.","CALENDAR_OUTCOME_UNKNOWN");
        if(row.Version!=req.Version)throw new ConflictException("The proposal changed. Reload it.");
        if(row.StartUtc<=clock.Now)throw new ConflictException("This proposed time has passed.");
        var grant=await Grant(ct);
        if(!string.Equals(grant.Account,req.Account,StringComparison.OrdinalIgnoreCase))throw new ConflictException("The connected calendar account changed. Review again.","CALENDAR_ACCOUNT_CHANGED");
        if(await Conflicts(row,grant.Token,ct)>0)throw new ConflictException("The primary calendar now has a conflicting event. Choose a different time.","CALENDAR_CONFLICT");
        await WorkspaceExecutionPrincipal.ConfigureAsync(services,row.UserId,row.TenantId,null,ct);
        var providerId="pt"+row.Id.ToString("N");
        await using(var tx=await db.Database.BeginOwnedTransactionAsync(ct)){
            if(await db.Users.Where(u=>u.Id==row.UserId&&u.IsActive).ExecuteUpdateAsync(s=>s.SetProperty(u=>u.IsActive,u=>u.IsActive),ct)!=1)throw new ForbiddenException("Your account is unavailable.");
            if(await db.PersonalCalendarProposals.CountAsync(p=>p.UserId==row.UserId&&p.ConfirmedAt>=clock.Now.AddHours(-1),ct)>=10)throw new ConflictException("Ten calendar blocks were confirmed in the last hour. Try later.");
            if(await db.PersonalCalendarProposals.AnyAsync(p=>p.UserId==row.UserId&&p.Id!=id&&(p.Status=="sending"||p.Status=="unknown"||p.Status=="verified")&&p.StartUtc<row.EndUtc&&p.EndUtc>row.StartUtc,ct))throw new ConflictException("Another calendar proposal overlaps this time. Resolve its receipt or choose another time.","CALENDAR_CONFLICT");
            if(await Mine.Where(p=>p.Id==id&&p.Status=="draft"&&p.Version==req.Version).ExecuteUpdateAsync(s=>s.SetProperty(p=>p.Status,"sending").SetProperty(p=>p.Version,p=>p.Version+1).SetProperty(p=>p.ProviderEventId,providerId).SetProperty(p=>p.ConfirmedAccount,grant.Account).SetProperty(p=>p.ConfirmedAt,clock.Now),ct)!=1)throw new ConflictException("This proposal was already confirmed. Reload it.");
            recorder.Audit("personal_calendar.confirmed","PersonalCalendarProposal",id);await db.SaveChangesAsync(ct);await tx.CommitIfOwnedAsync(ct);
        }
        row.ProviderEventId=providerId;var verified=false;
        try{
            using var dispatch=Request(HttpMethod.Post,Events+"?sendUpdates=none",grant.Token,new{
                id=providerId,summary=row.Title,description=row.Description,
                start=new{dateTime=row.StartUtc.ToString("o"),timeZone=row.TimeZone},end=new{dateTime=row.EndUtc.ToString("o"),timeZone=row.TimeZone},
                extendedProperties=new{@private=new{projectTrackerProposal=row.Id.ToString("N"),owner=row.UserId.ToString("N"),workspace=row.TenantId.ToString("N")}}
            });
            using var response=await Read(dispatch,ct);
            verified=await Verify(row,grant.Token,ct); // A write response alone does not mark the proposal verified.
        }catch(Exception e)when(e is HttpRequestException or IOException or OperationCanceledException or ConflictException){}
        var status=verified?"verified":"unknown";var verifiedAt=verified?(DateTime?)clock.Now:null;
        await Mine.Where(p=>p.Id==id&&p.Status=="sending").ExecuteUpdateAsync(s=>s.SetProperty(p=>p.Status,status).SetProperty(p=>p.VerifiedAt,verifiedAt).SetProperty(p=>p.Version,p=>p.Version+1),CancellationToken.None);
        recorder.Audit("personal_calendar.outcome","PersonalCalendarProposal",id,null,new{status});await db.SaveChangesAsync(CancellationToken.None);
        return Dto(await Require(id,CancellationToken.None));
    }
    public async Task<CalendarProposalDto> ReconcileAsync(Guid id,CancellationToken ct){
        var row=await Require(id,ct);
        if(row.Status=="verified")return Dto(row);
        if(row.Status is not ("unknown" or "sending"))throw new ConflictException("Only an uncertain calendar outcome can be checked.");
        if(row.Status=="sending"&&row.ConfirmedAt>clock.Now.AddMinutes(-2))throw new ConflictException("The calendar request is still being processed. Check again shortly.");
        var grant=await Grant(ct);
        if(!string.Equals(grant.Account,row.ConfirmedAccount,StringComparison.OrdinalIgnoreCase))throw new ConflictException("Reconnect the original calendar account before checking.","CALENDAR_ACCOUNT_CHANGED");
        if(await Verify(row,grant.Token,ct)){
            await WorkspaceExecutionPrincipal.ConfigureAsync(services,row.UserId,row.TenantId,null,ct);
            await Mine.Where(p=>p.Id==id&&p.Version==row.Version&&p.Status==row.Status).ExecuteUpdateAsync(s=>s.SetProperty(p=>p.Status,"verified").SetProperty(p=>p.VerifiedAt,clock.Now).SetProperty(p=>p.Version,p=>p.Version+1),ct);
            recorder.Audit("personal_calendar.reconciled","PersonalCalendarProposal",id);await db.SaveChangesAsync(ct);
        }
        return Dto(await Require(id,ct)); // A missing or changed event never authorizes another POST.
    }
    public async Task DeleteAsync(Guid id,CancellationToken ct){
        var row=await Require(id,ct);if(row.Status is "sending" or "unknown")throw new ConflictException("Keep this receipt until the calendar outcome is resolved.");
        int changed;
        if(row.Status=="draft")changed=await Mine.Where(p=>p.Id==id&&p.Status=="draft"&&p.Version==row.Version).ExecuteDeleteAsync(ct);
        else changed=await Mine.Where(p=>p.Id==id&&p.Status=="verified"&&p.Version==row.Version).ExecuteUpdateAsync(s=>s.SetProperty(p=>p.Status,"deleted").SetProperty(p=>p.Title,"").SetProperty(p=>p.Description,"").SetProperty(p=>p.StartUtc,DateTime.UnixEpoch).SetProperty(p=>p.EndUtc,DateTime.UnixEpoch).SetProperty(p=>p.TimeZone,"UTC").SetProperty(p=>p.ConfirmedAccount,(string?)null),ct);
        if(changed!=1)throw new ConflictException("This proposal changed. Reload before removing it.");
        recorder.Audit("personal_calendar.removed","PersonalCalendarProposal",id);await db.SaveChangesAsync(ct);
    }
}
