using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;
using System.Net;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;
namespace ProjectManagement.Tests;
[Collection("api")]
public class SupportTicketTests(ApiFactory factory)
{
    [Fact]
    public async Task Summary_uses_recorded_Sla_outcomes_and_does_not_breach_a_resolution_paused_before_its_deadline()
    {
        var admin=await TestClient.RegisterAsync(factory,"SLA metrics");await admin.CreateOrgAsync();await admin.UpgradeAsync("BUSINESS");
        var type=(await admin.Get("/api/v1/work-types")).Data!.AsArray().First()!["id"]!.GetValue<string>();
        var ids=new List<Guid>();
        foreach(var name in new[]{"Met","Missed","Paused","Cancelled"}){
            var ticket=await admin.Post("/api/v1/support/tickets",new{title=name,workTypeId=type,priority="High",category="IT"});
            Assert.True(ticket.Ok,ticket.ToString());ids.Add(ticket.Data!["id"]!.GetValue<Guid>());
        }
        factory.WithDb(db=>{
            var now=DateTime.UtcNow;
            for(var i=0;i<ids.Count;i++){
                var ticket=db.SupportTickets.IgnoreQueryFilters().Single(t=>t.Id==ids[i]);
                var w=db.WorkTasks.IgnoreQueryFilters().Single(t=>t.Id==ticket.WorkTaskId);
                w.ResponseDueAt=now.AddHours(-2);w.ResolutionDueAt=now.AddHours(-1);
                if(i<2){w.Status=WorkTaskStatus.Completed;w.CompletedAt=now.AddHours(i==0?-3:0);w.RespondedAt=w.CompletedAt;}
                else if(i==2){w.Status=WorkTaskStatus.OnHold;w.SlaPausedAt=now.AddHours(-2);w.RespondedAt=now.AddHours(-3);}
                else w.Status=WorkTaskStatus.Cancelled;
            }
            db.SaveChanges();return 0;
        });
        var result=await admin.Get("/api/v1/support/tickets/summary");Assert.True(result.Ok,result.ToString());
        var s=result.Data!;
        Assert.Equal(1,s["backlog"]!.GetValue<int>());Assert.Equal(0,s["openBreached"]!.GetValue<int>());
        Assert.Equal(1,s["resolutionMet"]!.GetValue<int>());Assert.Equal(1,s["resolutionMissed"]!.GetValue<int>());
        Assert.Equal(2,s["responseMet"]!.GetValue<int>());Assert.Equal(1,s["responseMissed"]!.GetValue<int>());
    }
    [Fact]
    public async Task Conversation_pages_filter_private_notes_before_paging_and_reject_stale_versions()
    {
        var admin=await TestClient.RegisterAsync(factory,"History admin");await admin.CreateOrgAsync();await admin.UpgradeAsync("BUSINESS");
        var reporter=await admin.AddMemberAsync(factory,TenantRole.Member,"History requester");
        var other=await TestClient.RegisterAsync(factory,"Foreign history");await other.CreateOrgAsync();
        var type=(await reporter.Get("/api/v1/work-types")).Data!.AsArray().First()!["id"]!.GetValue<string>();
        var made=await reporter.Post("/api/v1/support/tickets",new{title="Long history",workTypeId=type,priority="High",category="IT"});
        Assert.True(made.Ok,made.ToString());var id=made.Data!["id"]!.GetValue<Guid>();var version=made.Data["version"]!.GetValue<int>();
        factory.WithDb(db=>{
            var ticket=db.SupportTickets.IgnoreQueryFilters().Single(t=>t.Id==id);
            for(var i=0;i<60;i++){
                db.SupportInteractions.Add(new SupportInteraction{TenantId=ticket.TenantId,TicketId=id,AuthorId=reporter.UserId,Visibility="public",Body="Reply "+i,RequestKey="public-"+i});
                db.SupportInteractions.Add(new SupportInteraction{TenantId=ticket.TenantId,TicketId=id,AuthorId=admin.UserId,Visibility="internal",Body="Secret "+i,RequestKey="secret-"+i});
            }
            db.SaveChanges();return 0;
        });
        var metrics=await admin.Get("/api/v1/support/tickets/summary");Assert.True(metrics.Ok,metrics.ToString());
        Assert.Equal(1,metrics.Data!["backlog"]!.GetValue<int>());
        Assert.Equal(1,metrics.Data["unassigned"]!.GetValue<int>());
        var foreignMetrics=await other.Get("/api/v1/support/tickets/summary");Assert.True(foreignMetrics.Ok,foreignMetrics.ToString());
        Assert.Equal(0,foreignMetrics.Data!["backlog"]!.GetValue<int>());
        var first=await reporter.Get($"/api/v1/support/tickets/{id}/messages?version={version}");
        Assert.True(first.Ok,first.ToString());Assert.Equal(50,first.Data!["items"]!.AsArray().Count);
        Assert.Equal(50,first.Data["nextOffset"]!.GetValue<int>());Assert.DoesNotContain("Secret",first.Data.ToJsonString());
        var second=await reporter.Get($"/api/v1/support/tickets/{id}/messages?version={version}&offset=50");
        Assert.True(second.Ok,second.ToString());Assert.Equal(10,second.Data!["items"]!.AsArray().Count);Assert.Null(second.Data["nextOffset"]);
        var ids=first.Data["items"]!.AsArray().Concat(second.Data["items"]!.AsArray()).Select(x=>x!["id"]!.GetValue<string>()).ToArray();
        Assert.Equal(60,ids.Distinct().Count());Assert.DoesNotContain("Secret",second.Data.ToJsonString());
        var staff=await admin.Get($"/api/v1/support/tickets/{id}/messages?version={version}");
        Assert.True(staff.Ok,staff.ToString());Assert.Contains("Secret",staff.Data!.ToJsonString());
        Assert.Equal(HttpStatusCode.NotFound,(await other.Get($"/api/v1/support/tickets/{id}/messages?version={version}")).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity,(await reporter.Get($"/api/v1/support/tickets/{id}/messages?version={version}&offset=-1")).Status);
        Assert.True((await reporter.Post($"/api/v1/support/tickets/{id}/messages",new{body="New reply",visibility="public",requestKey="new-reply"})).Ok);
        Assert.Equal(HttpStatusCode.Conflict,(await reporter.Get($"/api/v1/support/tickets/{id}/messages?version={version}&offset=50")).Status);
    }
    [Fact]
    public async Task Requester_cannot_read_staff_notes_or_cross_tenant_tickets_and_message_keys_are_idempotent()
    {
        var admin=await TestClient.RegisterAsync(factory,"Support admin");await admin.CreateOrgAsync();await admin.UpgradeAsync("BUSINESS");var reporter=await admin.AddMemberAsync(factory,TenantRole.Member,"Requester");var other=await TestClient.RegisterAsync(factory,"Other organization");await other.CreateOrgAsync();await other.UpgradeAsync("BUSINESS");
        var types=(await reporter.Get("/api/v1/work-types")).Data!.AsArray();var type=types.First()!["id"]!.GetValue<string>();
        var made=await reporter.Post("/api/v1/support/tickets",new{title="Laptop support",description="Cannot connect",workTypeId=type,priority="High",category="IT"});Assert.True(made.Ok,made.ToString());var id=made.Data!["id"]!.GetValue<string>();
        Assert.Equal(HttpStatusCode.NotFound,(await other.Get($"/api/v1/support/tickets/{id}")).Status);
        var note=await admin.Post($"/api/v1/support/tickets/{id}/messages",new{body="Private engineer note",visibility="internal",requestKey="private-note"});Assert.True(note.Ok,note.ToString());Assert.Contains("Private engineer note",note.Data!.ToJsonString());
        var seen=await reporter.Get($"/api/v1/support/tickets/{id}");Assert.DoesNotContain("Private engineer note",seen.Data!.ToJsonString());
        Assert.Equal(HttpStatusCode.Forbidden,(await reporter.Post($"/api/v1/support/tickets/{id}/messages",new{body="No",visibility="internal",requestKey="denied"})).Status);
        var message=new{body="Please help",visibility="public",requestKey="same-message"};Assert.True((await reporter.Post($"/api/v1/support/tickets/{id}/messages",message)).Ok);var duplicate=await reporter.Post($"/api/v1/support/tickets/{id}/messages",message);Assert.True(duplicate.Ok,duplicate.ToString());Assert.Single(duplicate.Data!["interactions"]!.AsArray());
        var close=await admin.Post($"/api/v1/support/tickets/{id}/state",new{version=duplicate.Data["version"]!.GetValue<int>(),state="closed"});Assert.Equal(HttpStatusCode.Conflict,close.Status);
        var handoff=await admin.Post($"/api/v1/support/tickets/{id}/state",new{version=duplicate.Data["version"]!.GetValue<int>(),state="handoff",reason="Requires IT review"});Assert.True(handoff.Ok,handoff.ToString());Assert.Equal("handoff",handoff.Data!["state"]!.GetValue<string>());
        Assert.DoesNotContain("Requires IT review",(await reporter.Get($"/api/v1/support/tickets/{id}")).Data!.ToJsonString());
        var metadata=new{version=handoff.Data["version"]!.GetValue<int>(),category="IT",region="South",language="English",customFields=new Dictionary<string,string>{{"Private routing context","Engineering-only customer details"}}};
        var configured=await admin.Put($"/api/v1/support/tickets/{id}/metadata",metadata);
        Assert.True(configured.Ok,configured.ToString());
        Assert.Equal("Engineering-only customer details",configured.Data!["customFields"]!["Private routing context"]!.GetValue<string>());
        var requester=(await reporter.Get($"/api/v1/support/tickets/{id}")).Data!;
        Assert.Empty(requester["customFields"]!.AsObject());Assert.DoesNotContain("Engineering-only customer details",requester.ToJsonString());
        Assert.Equal(HttpStatusCode.Forbidden,(await reporter.Put($"/api/v1/support/tickets/{id}/metadata",metadata)).Status);
        Assert.Equal(HttpStatusCode.Conflict,(await admin.Put($"/api/v1/support/tickets/{id}/metadata",metadata)).Status);
        Assert.DoesNotContain(id,(await other.Get("/api/v1/support/tickets")).Data!.ToJsonString());
    }
}
