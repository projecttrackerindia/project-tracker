using System.Net;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;
namespace ProjectManagement.Tests;
[Collection("api")]
public class SupportRoutingTests(ApiFactory factory)
{
    [Fact]
    public async Task Routing_excludes_ineligible_people_requires_review_and_revalidates_ticket_versions()
    {
        var owner=await TestClient.RegisterAsync(factory,"Routing owner");await owner.CreateOrgAsync();await owner.UpgradeAsync("BUSINESS");
        var low=await owner.AddMemberAsync(factory,TenantRole.Member,"Light workload");
        var busy=await owner.AddMemberAsync(factory,TenantRole.Member,"Team lead");
        var zero=await owner.AddMemberAsync(factory,TenantRole.Member,"Zero capacity");
        var inactive=await owner.AddMemberAsync(factory,TenantRole.Member,"Inactive engineer");
        var guest=await owner.AddMemberAsync(factory,TenantRole.Guest,"Guest contact");
        var reporter=await owner.AddMemberAsync(factory,TenantRole.Member,"Routing requester");
        var foreign=await TestClient.RegisterAsync(factory,"Foreign routing owner");await foreign.CreateOrgAsync();await foreign.UpgradeAsync("BUSINESS");
        var type=(await owner.Get("/api/v1/work-types")).Data!.AsArray().First()!["id"]!.GetValue<string>();
        var work=await owner.Post("/api/v1/work-tasks",new{title="Existing lead work",workTypeId=type,assigneeId=busy.UserId});
        Assert.True(work.Ok,work.ToString());
        var made=await reporter.Post("/api/v1/support/tickets",new{title="Routing ticket",workTypeId=type,priority="High",category="IT"});
        Assert.True(made.Ok,made.ToString());var id=made.Data!["id"]!.GetValue<Guid>();
        var team=factory.WithDb(db=>{
            var ticket=db.SupportTickets.IgnoreQueryFilters().Single(t=>t.Id==id);
            var team=new Team{TenantId=ticket.TenantId,Name="Service engineers"};db.Teams.Add(team);
            foreach(var user in new[]{low,busy,zero,inactive,guest})
                db.TeamMembers.Add(new TeamMember{TenantId=ticket.TenantId,TeamId=team.Id,UserId=user.UserId,IsLead=user==busy});
            foreach(var user in new[]{low,busy,zero}){
                var member=db.TenantMembers.Single(m=>m.TenantId==ticket.TenantId&&m.UserId==user.UserId);
                member.WeeklyCapacityMinutes=user==zero?0:1200;
                if(user==low)member.ReportsToUserId=owner.UserId;
            }
            db.Users.Single(u=>u.Id==inactive.UserId).IsActive=false;
            ticket.TeamId=team.Id;ticket.Version++;db.SaveChanges();return team.Id;
        });
        var preview=await owner.Get($"/api/v1/support/tickets/{id}/routing");Assert.True(preview.Ok,preview.ToString());
        var p=preview.Data!;var candidates=p["candidates"]!.AsArray();
        Assert.Equal(2,candidates.Count);Assert.Equal(low.UserId,candidates[0]!["userId"]!.GetValue<Guid>());
        Assert.Equal(1200,candidates[0]!["weeklyCapacityMinutes"]!.GetValue<int>());
        Assert.Equal(busy.UserId,p["escalationTargets"]!.AsArray().Single()!["userId"]!.GetValue<Guid>());
        Assert.DoesNotContain(foreign.UserId.ToString(),p.ToJsonString());
        Assert.Equal(HttpStatusCode.Forbidden,(await reporter.Get($"/api/v1/support/tickets/{id}/routing")).Status);
        Assert.Equal(HttpStatusCode.NotFound,(await foreign.Get($"/api/v1/support/tickets/{id}/routing")).Status);
        var version=p["ticketVersion"]!.GetValue<int>();var workVersion=p["workVersion"]!.GetValue<int>();
        Assert.Equal(HttpStatusCode.UnprocessableEntity,(await owner.Post($"/api/v1/support/tickets/{id}/routing/assign",new{ticketVersion=version,workVersion,assigneeId=low.UserId,confirmed=false})).Status);
        Assert.Equal(HttpStatusCode.Conflict,(await owner.Post($"/api/v1/support/tickets/{id}/routing/assign",new{ticketVersion=version,workVersion,assigneeId=foreign.UserId,confirmed=true})).Status);
        var assigned=await owner.Post($"/api/v1/support/tickets/{id}/routing/assign",new{ticketVersion=version,workVersion,assigneeId=low.UserId,confirmed=true});
        Assert.True(assigned.Ok,assigned.ToString());Assert.Equal(low.UserId,assigned.Data!["work"]!["assignee"]!["id"]!.GetValue<Guid>());
        Assert.Equal(HttpStatusCode.Conflict,(await owner.Post($"/api/v1/support/tickets/{id}/routing/assign",new{ticketVersion=version,workVersion,assigneeId=busy.UserId,confirmed=true})).Status);
        var after=await owner.Get($"/api/v1/support/tickets/{id}/routing");Assert.True(after.Ok,after.ToString());
        Assert.Contains(owner.UserId.ToString(),after.Data!["escalationTargets"]!.ToJsonString());
        factory.WithDb(db=>{
            db.TeamMembers.RemoveRange(db.TeamMembers.IgnoreQueryFilters().Where(m=>m.TeamId==team));db.SaveChanges();return 0;
        });
        var empty=await owner.Get($"/api/v1/support/tickets/{id}/routing");Assert.True(empty.Ok,empty.ToString());
        Assert.Empty(empty.Data!["candidates"]!.AsArray());
        Assert.Equal(low.UserId,(await owner.Get($"/api/v1/support/tickets/{id}")).Data!["work"]!["assignee"]!["id"]!.GetValue<Guid>());
        Assert.Equal(HttpStatusCode.Conflict,(await owner.Post($"/api/v1/support/tickets/{id}/routing/assign",new{ticketVersion=after.Data!["ticketVersion"]!.GetValue<int>(),workVersion=after.Data["workVersion"]!.GetValue<int>(),assigneeId=busy.UserId,confirmed=true})).Status);
    }
    [Fact]
    public async Task Project_routing_requires_a_recorded_project_relationship()
    {
        var owner=await TestClient.RegisterAsync(factory,"Project routing");await owner.CreateOrgAsync();await owner.UpgradeAsync("BUSINESS");
        var linked=await owner.AddMemberAsync(factory,TenantRole.Member,"Project engineer");
        var unlinked=await owner.AddMemberAsync(factory,TenantRole.Member,"Unlinked lead");
        var project=await owner.CreateProjectAsync("Restricted routing");
        var type=(await owner.Get("/api/v1/work-types")).Data!.AsArray().First()!["id"]!.GetValue<string>();
        var made=await owner.Post("/api/v1/support/tickets",new{title="Project support",workTypeId=type,priority="High",category="IT",projectId=project});
        Assert.True(made.Ok,made.ToString());var id=made.Data!["id"]!.GetValue<Guid>();
        factory.WithDb(db=>{
            var ticket=db.SupportTickets.IgnoreQueryFilters().Single(t=>t.Id==id);
            var team=new Team{TenantId=ticket.TenantId,Name="Routing team"};db.Teams.Add(team);
            foreach(var user in new[]{linked,unlinked})
                db.TeamMembers.Add(new TeamMember{TenantId=ticket.TenantId,TeamId=team.Id,UserId=user.UserId,IsLead=user==unlinked});
            db.ProjectMembers.Add(new ProjectMember{TenantId=ticket.TenantId,ProjectId=project,UserId=linked.UserId});
            ticket.TeamId=team.Id;ticket.Version++;db.SaveChanges();return 0;
        });
        var preview=await owner.Get($"/api/v1/support/tickets/{id}/routing");Assert.True(preview.Ok,preview.ToString());
        Assert.Equal(linked.UserId,preview.Data!["candidates"]!.AsArray().Single()!["userId"]!.GetValue<Guid>());
        Assert.Empty(preview.Data["escalationTargets"]!.AsArray());
    }}