using System.Net;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;
namespace ProjectManagement.Tests;
[Collection("api")]
public class SupportTicketTests(ApiFactory factory)
{
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
