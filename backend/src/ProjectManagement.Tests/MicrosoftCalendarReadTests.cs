using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;
namespace ProjectManagement.Tests;
[Collection("api")]
public class MicrosoftCalendarReadTests(ApiFactory factory)
{
    private MicrosoftProductivityOptions Options=>factory.Services.GetRequiredService<IOptions<MicrosoftProductivityOptions>>().Value;
    private void Enable(){Options.Enabled=true;Options.CalendarsEnabled=true;Options.ClientId="12345678-1234-1234-1234-123456789012";Options.ClientSecret="fake-secret";Options.RedirectUri="https://testhost/api/v1/integrations/microsoft/callback";Options.AuthorityTenant="organizations";}
    private void Reset(){Options.Enabled=false;Options.CalendarsEnabled=false;Options.ClientId=null;Options.ClientSecret=null;Options.RedirectUri=null;factory.MicrosoftProductivity.Reset();}
    private async Task Connect(TestClient owner,bool calendars=true,string? scopes=null){
        var start=await owner.Get("/api/v1/integrations/microsoft/connect"+(calendars?"?calendars=true":""));Assert.True(start.Ok,start.ToString());
        var q=new Uri(start.Data!["url"]!.GetValue<string>()).Query.TrimStart('?').Split('&').Select(p=>p.Split('=',2)).ToDictionary(p=>p[0],p=>Uri.UnescapeDataString(p[1]));
        Assert.Equal(calendars,q["scope"].Contains("Calendars.ReadBasic"));Assert.DoesNotContain("ReadWrite",q["scope"]);
        using var browser=factory.CreateClient(new WebApplicationFactoryClientOptions{AllowAutoRedirect=false});browser.DefaultRequestHeaders.Add("Cookie",start.Headers["Set-Cookie"].Split(';')[0]);
        using var result=await browser.GetAsync("/api/v1/integrations/microsoft/callback?state="+q["state"]+"&code="+factory.MicrosoftProductivity.IssueCode(owner.Email,scopes??"User.Read Mail.Send Calendars.ReadBasic"));Assert.EndsWith("microsoft=connected",result.Headers.Location!.ToString());
    }
    private static object Window(string context,string[]? ids=null)=>new{calendarIds=ids??new[]{"own1","own2"},accessContext=context,start=DateTimeOffset.UtcNow.AddDays(1),end=DateTimeOffset.UtcNow.AddDays(1).AddHours(2)};
    [Fact]
    public async Task Calendars_require_activation_and_explicit_consent_without_promoting_unrequested_grants(){
        Reset();var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();Enable();Options.CalendarsEnabled=false;
        try{
            Assert.Equal("MICROSOFT_CALENDARS_DISABLED",(await owner.Get("/api/v1/integrations/microsoft/connect?calendars=true")).ErrorCode);
            Assert.Equal("MICROSOFT_CALENDARS_DISABLED",(await owner.Get("/api/v1/me/microsoft-calendars")).ErrorCode);
            Options.CalendarsEnabled=true;await Connect(owner,false);
            Assert.Equal("MICROSOFT_SCOPE_REQUIRED",(await owner.Get("/api/v1/me/microsoft-calendars")).ErrorCode);
            Assert.False((await owner.Get("/api/v1/integrations/microsoft/status")).Data!["calendarAccess"]!.GetValue<bool>());
            await Connect(owner);Assert.True((await owner.Get("/api/v1/me/microsoft-calendars")).Ok);
        }finally{Reset();}
    }
    [Fact]
    public async Task Own_calendar_inventory_and_reviewed_contexts_are_isolated_between_users_and_organizations(){
        Enable();var a=await TestClient.RegisterAsync(factory);await a.CreateOrgAsync();await a.UpgradeAsync("BUSINESS");var peer=await a.AddMemberAsync(factory,TenantRole.Member);
        var b=await TestClient.RegisterAsync(factory);await b.CreateOrgAsync();
        try{
            foreach(var user in new[]{a,peer,b})await Connect(user);
            var list=await a.Get("/api/v1/me/microsoft-calendars");Assert.Equal(2,list.Data!["calendars"]!.AsArray().Count);Assert.DoesNotContain("Another person's",list.ToString());
            var context=list.Data["accessContext"]!.GetValue<string>();
            foreach(var other in new[]{peer,b}){
                Assert.NotEqual(context,(await other.Get("/api/v1/me/microsoft-calendars")).Data!["accessContext"]!.GetValue<string>());
                Assert.Equal("MICROSOFT_CALENDAR_CONNECTION_CHANGED",(await other.Post("/api/v1/me/microsoft-calendars/availability",Window(context))).ErrorCode);
            }
            var before=factory.MicrosoftProductivity.CalendarReads.Count;
            Assert.Equal(HttpStatusCode.NotFound,(await a.Post("/api/v1/me/microsoft-calendars/availability",Window(context,new[]{"shared"}))).Status);
            Assert.Equal(before+1,factory.MicrosoftProductivity.CalendarReads.Count); // Own list only; no shared calendar view.
            await Connect(a);Assert.Equal("MICROSOFT_CALENDAR_CONNECTION_CHANGED",(await a.Post("/api/v1/me/microsoft-calendars/availability",Window(context))).ErrorCode);
        }finally{Reset();}
    }
    private static object Event(DateTimeOffset start,DateTimeOffset end,string status="busy",bool cancelled=false)=>new{start=new{dateTime=start.UtcDateTime.ToString("o"),timeZone="UTC"},end=new{dateTime=end.UtcDateTime.ToString("o"),timeZone="UTC"},showAs=status,isCancelled=cancelled};
    [Fact]
    public async Task Busy_intervals_merge_and_clip_across_selected_calendars_without_titles_ai_or_writes(){
        Enable();var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();
        try{
            await Connect(owner);var before=factory.MicrosoftProductivity.SentMessages.Count;var prompts=factory.Ai.Prompts.Count;
            var context=(await owner.Get("/api/v1/me/microsoft-calendars")).Data!["accessContext"]!.GetValue<string>();
            factory.MicrosoftProductivity.CalendarEvents=(start,end)=>new[]{Event(start.AddHours(-1),start.AddMinutes(40)),Event(start.AddMinutes(30),start.AddHours(1)),Event(end.AddMinutes(-10),end.AddHours(1)),Event(start,end,"free"),Event(start,end,cancelled:true)};
            var result=await owner.Post("/api/v1/me/microsoft-calendars/availability",Window(context));Assert.True(result.Ok,result.ToString());var busy=result.Data!["busy"]!.AsArray();Assert.Equal(2,busy.Count);
            Assert.Equal(result.Data["startUtc"]!.GetValue<DateTimeOffset>(),busy[0]!["startUtc"]!.GetValue<DateTimeOffset>());Assert.Equal(result.Data["endUtc"]!.GetValue<DateTimeOffset>(),busy[1]!["endUtc"]!.GetValue<DateTimeOffset>());
            Assert.DoesNotContain("subject",result.ToString());Assert.Equal(before,factory.MicrosoftProductivity.SentMessages.Count);Assert.Equal(prompts,factory.Ai.Prompts.Count);
            Assert.All(factory.MicrosoftProductivity.CalendarReads.Where(p=>p.Contains("calendarView")),p=>Assert.DoesNotContain("subject",p));
        }finally{Reset();}
    }
    [Theory] [InlineData("paged")] [InlineData("oversized")] [InlineData("unknown")] [InlineData("timezone")] [InlineData("reversed")] [InlineData("transport")] [InlineData("offset")]
    public async Task Incomplete_or_invalid_provider_results_never_report_free_availability(string failure){
        Enable();var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();
        try{
            await Connect(owner);var context=(await owner.Get("/api/v1/me/microsoft-calendars")).Data!["accessContext"]!.GetValue<string>();
            factory.MicrosoftProductivity.CalendarTransportFailure=failure=="transport";factory.MicrosoftProductivity.CalendarPaged=failure=="paged";factory.MicrosoftProductivity.CalendarOversized=failure=="oversized";
            factory.MicrosoftProductivity.CalendarEvents=(start,end)=>failure switch{
                "offset"=>new object[]{new{start=new{dateTime=start.ToOffset(TimeSpan.FromHours(5.5)).ToString("o"),timeZone="UTC"},end=new{dateTime=end.ToString("o"),timeZone="UTC"},isCancelled=false,showAs="busy"}},"unknown"=>new[]{Event(start,end,"unknown")},"reversed"=>new[]{Event(end,start)},"timezone"=>new object[]{new{start=new{dateTime=start.ToString("o"),timeZone="Pacific Standard Time"},end=new{dateTime=end.ToString("o"),timeZone="UTC"},isCancelled=false,showAs="busy"}},_=>Array.Empty<object>()};
            Assert.Equal("MICROSOFT_CALENDAR_INCOMPLETE",(await owner.Post("/api/v1/me/microsoft-calendars/availability",Window(context))).ErrorCode);
        }finally{Reset();}
    }
    [Theory] [InlineData("member",false)] [InlineData("epoch",false)] [InlineData("scope",false)] [InlineData("disabled",false)]
    [InlineData("member",true)] [InlineData("epoch",true)] [InlineData("scope",true)] [InlineData("disabled",true)]
    public async Task Revocation_during_calendar_reads_suppresses_inventory_and_availability(string change,bool availability){
        Enable();var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();
        try{
            await Connect(owner);var context=(await owner.Get("/api/v1/me/microsoft-calendars")).Data!["accessContext"]!.GetValue<string>();
            factory.MicrosoftProductivity.BeforeCalendarRead=path=>{
                if(availability&&!path.EndsWith("calendarView"))return;
                if(change=="disabled"){Options.CalendarsEnabled=false;return;}
                factory.WithDb(db=>{if(change=="member")db.TenantMembers.Remove(db.TenantMembers.Single(m=>m.UserId==owner.UserId&&m.TenantId==owner.WorkspaceId));else{var c=db.MicrosoftConnections.IgnoreQueryFilters().Single(c=>c.UserId==owner.UserId);if(change=="epoch")c.ConsentEpoch=Guid.NewGuid();else c.Scopes="User.Read Mail.Send";}db.SaveChanges();return 0;});
            };
            var result=availability?await owner.Post("/api/v1/me/microsoft-calendars/availability",Window(context)):await owner.Get("/api/v1/me/microsoft-calendars");
            Assert.Equal(change=="member"?HttpStatusCode.Forbidden:HttpStatusCode.Conflict,result.Status);Assert.Null(result.Data);
        }finally{Reset();}
    }
    [Fact]
    public async Task Invalid_calendar_ids_ranges_and_offsetless_times_are_rejected_before_provider_reads(){
        Enable();var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();
        try{
            var before=factory.MicrosoftProductivity.CalendarReads.Count;var route="/api/v1/me/microsoft-calendars/availability";
            foreach(var ids in new[]{new[]{"https://elsewhere.test"},new[]{"own1","own1"},Array.Empty<string>(),new[]{"1","2","3","4","5","6"}})Assert.Equal(HttpStatusCode.UnprocessableEntity,(await owner.Post(route,Window(new string('a',64),ids))).Status);
            Assert.False((await owner.Post(route,new{calendarIds=new[]{"own1"},accessContext=new string('a',64),start="2026-10-14T10:00:00",end="2026-10-14T11:00:00"})).Ok);
            Assert.Equal(HttpStatusCode.UnprocessableEntity,(await owner.Post(route,new{calendarIds=new[]{"own1"},accessContext=new string('a',64),start=DateTimeOffset.UtcNow.AddDays(1),end=DateTimeOffset.UtcNow.AddDays(4)})).Status);
            Assert.Equal(before,factory.MicrosoftProductivity.CalendarReads.Count);
        }finally{Reset();}
    }
    [Theory] [InlineData(false)] [InlineData(true)]
    public async Task Failed_or_disabled_calendar_consent_preserves_the_existing_connection(bool disabled){
        Enable();var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();
        try{
            await Connect(owner,false,"User.Read Mail.Send");var original=factory.WithDb(db=>db.MicrosoftConnections.IgnoreQueryFilters().AsNoTracking().Single(c=>c.UserId==owner.UserId));
            var start=await owner.Get("/api/v1/integrations/microsoft/connect?calendars=true");Assert.True(start.Ok,start.ToString());
            var state=new Uri(start.Data!["url"]!.GetValue<string>()).Query.TrimStart('?').Split('&').Select(p=>p.Split('=',2)).Single(p=>p[0]=="state")[1];
            if(disabled)Options.CalendarsEnabled=false;
            using var browser=factory.CreateClient(new WebApplicationFactoryClientOptions{AllowAutoRedirect=false});browser.DefaultRequestHeaders.Add("Cookie",start.Headers["Set-Cookie"].Split(';')[0]);
            using var result=await browser.GetAsync("/api/v1/integrations/microsoft/callback?state="+state+"&code="+factory.MicrosoftProductivity.IssueCode(owner.Email,disabled?"User.Read Mail.Send Calendars.ReadBasic":"User.Read Mail.Send"));
            Assert.EndsWith("microsoft=permission",result.Headers.Location!.ToString());
            var after=factory.WithDb(db=>db.MicrosoftConnections.IgnoreQueryFilters().AsNoTracking().Single(c=>c.UserId==owner.UserId));
            Assert.Equal(original.RefreshTokenProtected,after.RefreshTokenProtected);Assert.Equal(original.ConsentEpoch,after.ConsentEpoch);Assert.Equal(original.Scopes,after.Scopes);
        }finally{Reset();}
    }

}
