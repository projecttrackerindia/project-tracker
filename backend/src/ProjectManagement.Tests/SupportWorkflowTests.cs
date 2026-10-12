using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.SupportWorkflows;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;
namespace ProjectManagement.Tests;

[Collection("api")]
public class SupportWorkflowTests(ApiFactory factory)
{
    private static SupportWorkflowGraph NoteGraph(string trigger="manual")=>new(trigger,[new("start","start","Begin","note"),new("note","note","Staff note","end",Value:"Workflow reviewed this ticket."),new("end","end","Finish")]);
    private static SupportWorkflowGraph ApprovalGraph()=>new("manual",[new("start","start","Begin","review"),new("review","approval","Review handoff","handoff","end"),new("handoff","handoff","Human handoff","end",Value:"Requires engineering review."),new("end","end","Finish")]);
    private async Task Process(int rounds=1){for(var i=0;i<rounds;i++)await factory.Services.GetRequiredService<SupportWorkflowProcessor>().ProcessAsync();}
    private static async Task<string> Ticket(TestClient user)
    {
        var type=(await user.Get("/api/v1/work-types")).Data!.AsArray().First()!["id"]!.GetValue<string>();
        var made=await user.Post("/api/v1/support/tickets",new{title="Workflow support",workTypeId=type,priority="High",category="IT"});Assert.True(made.Ok,made.ToString());return made.Data!["id"]!.GetValue<string>();
    }
    private static async Task<string> Publish(TestClient user,SupportWorkflowGraph graph)
    {
        var made=await user.Post("/api/v1/support/workflows",new{name="Review workflow",graph,version=0});Assert.True(made.Ok,made.ToString());var id=made.Data!["id"]!.GetValue<string>();
        var published=await user.Post($"/api/v1/support/workflows/{id}/publish",new{version=1});Assert.True(published.Ok,published.ToString());return id;
    }
    [Fact]
    public void Graphs_reject_cycles_missing_edges_arbitrary_code_and_unapproved_assignments()
    {
        Assert.Throws<ValidationException>(()=>SupportWorkflowGraphs.Validate(new("manual",[new("start","start","Start","loop"),new("loop","note","Loop","start",Value:"No"),new("end","end","Finish")])));
        Assert.Throws<ValidationException>(()=>SupportWorkflowGraphs.Validate(new("manual",[new("start","start","Start","code"),new("code","javascript","Code","end",Value:"eval()"),new("end","end","Finish")])));
        Assert.Throws<ValidationException>(()=>SupportWorkflowGraphs.Validate(new("manual",[new("start","start","Start","assign"),new("assign","assign","Assign","end",Value:Guid.NewGuid().ToString()),new("end","end","Finish")])));
        Assert.Throws<ValidationException>(()=>SupportWorkflowGraphs.Validate(new("manual",[new("start","start","Start","missing"),new("end","end","Finish")])));
        Assert.NotNull(SupportWorkflowGraphs.Validate(ApprovalGraph()));
    }
    [Fact]
    public async Task Approval_pauses_actions_and_replayed_run_keys_never_repeat_a_handoff()
    {
        var admin=await TestClient.RegisterAsync(factory);await admin.CreateOrgAsync();await admin.UpgradeAsync("BUSINESS");
        var workflow=await Publish(admin,ApprovalGraph());var ticket=await Ticket(admin);
        var made=await admin.Post($"/api/v1/support/workflows/{workflow}/runs",new{ticketId=ticket,requestKey="approval-run"});Assert.True(made.Ok,made.ToString());var id=made.Data!["id"]!.GetValue<string>();
        await Process(2);var paused=await admin.Get($"/api/v1/support/workflows/runs/{id}");Assert.Equal("approval",paused.Data!["status"]!.GetValue<string>());
        Assert.Equal("open",(await admin.Get($"/api/v1/support/tickets/{ticket}")).Data!["state"]!.GetValue<string>());
        var approve=await admin.Post($"/api/v1/support/workflows/runs/{id}/decide",new{version=paused.Data["version"]!.GetValue<int>(),accepted=true});Assert.True(approve.Ok,approve.ToString());
        await Process(2);var result=await admin.Get($"/api/v1/support/workflows/runs/{id}");Assert.Equal("succeeded",result.Data!["status"]!.GetValue<string>());
        Assert.Equal(4,result.Data["steps"]!.AsArray().Count);
        var replay=await admin.Post($"/api/v1/support/workflows/{workflow}/runs",new{ticketId=ticket,requestKey="approval-run"});Assert.Equal(id,replay.Data!["id"]!.GetValue<string>());
        await Process(2);var t=await admin.Get($"/api/v1/support/tickets/{ticket}");Assert.Equal("handoff",t.Data!["state"]!.GetValue<string>());Assert.Single(t.Data["interactions"]!.AsArray());
    }
    [Fact]
    public async Task Automatic_runs_rebuild_membership_and_cannot_act_for_a_removed_publisher_or_another_tenant()
    {
        var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();await owner.UpgradeAsync("BUSINESS");var admin=await owner.AddMemberAsync(factory,TenantRole.Admin);
        await Publish(admin,NoteGraph("ticket_created"));var ticket=await Ticket(owner);
        factory.WithDb(db=>{var member=db.TenantMembers.Single(m=>m.TenantId==owner.WorkspaceId&&m.UserId==admin.UserId);db.TenantMembers.Remove(member);db.SaveChanges();return 0;});
        await Process();var runs=await owner.Get($"/api/v1/support/workflows/runs?ticketId={ticket}");var run=Assert.Single(runs.Data!.AsArray());Assert.Equal("failed",run!["status"]!.GetValue<string>());Assert.Equal("NOT_A_MEMBER",run["errorCode"]!.GetValue<string>());
        Assert.Empty((await owner.Get($"/api/v1/support/tickets/{ticket}")).Data!["interactions"]!.AsArray());
        var stranger=await TestClient.RegisterAsync(factory);await stranger.CreateOrgAsync();await stranger.UpgradeAsync("BUSINESS");
        Assert.Equal(HttpStatusCode.NotFound,(await stranger.Get($"/api/v1/support/workflows/runs/{run["id"]!.GetValue<string>()}")).Status);
        Assert.Empty((await stranger.Get("/api/v1/support/workflows")).Data!.AsArray());
    }
    [Fact]
    public async Task Changed_ticket_versions_invalidate_a_waiting_confirmation()
    {
        var admin=await TestClient.RegisterAsync(factory);await admin.CreateOrgAsync();await admin.UpgradeAsync("BUSINESS");var workflow=await Publish(admin,ApprovalGraph());var ticket=await Ticket(admin);
        var made=await admin.Post($"/api/v1/support/workflows/{workflow}/runs",new{ticketId=ticket,requestKey="stale-approval"});var id=made.Data!["id"]!.GetValue<string>();
        await Process(2);var paused=await admin.Get($"/api/v1/support/workflows/runs/{id}");
        var t=await admin.Get($"/api/v1/support/tickets/{ticket}");var work=t.Data!["work"]!["id"]!.GetValue<string>();Assert.True((await admin.Put($"/api/v1/work-tasks/{work}/status",new{status="InProgress"})).Ok);
        var decision=await admin.Post($"/api/v1/support/workflows/runs/{id}/decide",new{version=paused.Data!["version"]!.GetValue<int>(),accepted=true});Assert.Equal("WORKFLOW_APPROVAL_STALE",decision.ErrorCode);
        Assert.True((await admin.Post($"/api/v1/support/workflows/runs/{id}/cancel?version={paused.Data["version"]!.GetValue<int>()}")).Ok);
        await Process();Assert.Equal("open",(await admin.Get($"/api/v1/support/tickets/{ticket}")).Data!["state"]!.GetValue<string>());
    }
    [Fact]
    public async Task Sla_breach_events_are_durable_and_emitted_once_for_the_same_deadline()
    {
        var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();await owner.UpgradeAsync("BUSINESS");await Publish(owner,NoteGraph("sla_breach"));var ticket=await Ticket(owner);
        var tid=Guid.Parse(ticket);
        factory.WithDb(db=>{var t=db.SupportTickets.IgnoreQueryFilters().Single(t=>t.Id==tid);var work=db.WorkTasks.IgnoreQueryFilters().Single(w=>w.Id==t.WorkTaskId);work.ResponseDueAt=DateTime.UtcNow.AddMinutes(-1);db.SaveChanges();return 0;});
        await Process(5);
        var result=await owner.Get($"/api/v1/support/tickets/{ticket}");Assert.Single(result.Data!["interactions"]!.AsArray());
        Assert.Single((await owner.Get($"/api/v1/support/workflows/runs?ticketId={ticket}")).Data!.AsArray());
    }
    [Fact]
    public async Task Missed_schedule_periods_coalesce_and_never_overlap_an_active_run()
    {
        var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();await owner.UpgradeAsync("BUSINESS");
        var workflow=await Publish(owner,NoteGraph("schedule"));var ticket=await Ticket(owner);
        var created=await owner.Post($"/api/v1/support/workflows/{workflow}/schedules?ticketId={ticket}&intervalMinutes=5");
        Assert.True(created.Ok,created.ToString());var scheduleId=created.Data!["id"]!.GetValue<Guid>();
        void MakeDue()=>factory.WithDb(db=>{
            var schedule=db.SupportWorkflowSchedules.IgnoreQueryFilters().Single(s=>s.Id==scheduleId);
            schedule.NextRunAt=DateTime.UtcNow.AddDays(-2);db.SaveChanges();return 0;
        });
        MakeDue();await Process();MakeDue();await Process(2);
        var runs=(await owner.Get($"/api/v1/support/workflows/runs?ticketId={ticket}")).Data!.AsArray();
        Assert.Equal("succeeded",Assert.Single(runs)!["status"]!.GetValue<string>());
        Assert.Single((await owner.Get($"/api/v1/support/tickets/{ticket}")).Data!["interactions"]!.AsArray());
        Assert.True(factory.WithDb(db=>db.SupportWorkflowSchedules.IgnoreQueryFilters().Single(s=>s.Id==scheduleId).NextRunAt)>DateTime.UtcNow);
        Assert.True((await owner.Delete($"/api/v1/support/workflows/schedules/{scheduleId}")).Ok);
        Assert.Empty((await owner.Get($"/api/v1/support/workflows/schedules?ticketId={ticket}")).Data!.AsArray());
    }

    [Fact]
    public async Task Restoring_a_revision_creates_a_new_publication_and_fences_pending_actions()
    {
        var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();await owner.UpgradeAsync("BUSINESS");
        var workflow=await Publish(owner,NoteGraph());var ticket=await Ticket(owner);
        var made=await owner.Post($"/api/v1/support/workflows/{workflow}/runs",new{ticketId=ticket,requestKey="before-restore"});
        Assert.True(made.Ok,made.ToString());var run=made.Data!["id"]!.GetValue<string>();
        var restored=await owner.Post($"/api/v1/support/workflows/{workflow}/publish",new{version=2,restoreRevision=1});
        Assert.True(restored.Ok,restored.ToString());Assert.Equal(2,restored.Data!["revisions"]!.AsArray().Count);
        await Process(3);
        Assert.Equal("cancelled",(await owner.Get($"/api/v1/support/workflows/runs/{run}")).Data!["status"]!.GetValue<string>());
        Assert.Empty((await owner.Get($"/api/v1/support/tickets/{ticket}")).Data!["interactions"]!.AsArray());
    }    [Fact]
    public async Task Staged_escalation_waits_and_requires_a_separate_second_approval()
    {
        var owner=await TestClient.RegisterAsync(factory,"Escalation owner");await owner.CreateOrgAsync();await owner.UpgradeAsync("BUSINESS");
        var lead=await owner.AddMemberAsync(factory,TenantRole.Member,"Escalation lead");
        var manager=await owner.AddMemberAsync(factory,TenantRole.Manager,"Escalation manager");
        var graph=new SupportWorkflowGraph("manual",[
            new("start","start","Start","review1"),
            new("review1","approval","Review lead assignment","assign1","end"),
            new("assign1","assign","Assign lead","wait",Value:lead.UserId.ToString()),
            new("wait","wait","Wait before manager","closed",Minutes:60),
            new("closed","condition","Stop if resolved","end","review2",Field:"state",Value:"resolved"),
            new("review2","approval","Review manager assignment","assign2","end"),
            new("assign2","assign","Assign manager","end",Value:manager.UserId.ToString()),
            new("end","end","Finish")]);
        var workflow=await Publish(owner,graph);var ticket=await Ticket(owner);
        var made=await owner.Post($"/api/v1/support/workflows/{workflow}/runs",new{ticketId=ticket,requestKey="staged-escalation"});
        Assert.True(made.Ok,made.ToString());var id=made.Data!["id"]!.GetValue<Guid>();
        await Process(2);
        var paused=await owner.Get($"/api/v1/support/workflows/runs/{id}");
        Assert.Equal("approval",paused.Data!["status"]!.GetValue<string>());
        Assert.Null((await owner.Get($"/api/v1/support/tickets/{ticket}")).Data!["work"]!["assignee"]);
        Assert.True((await owner.Post($"/api/v1/support/workflows/runs/{id}/decide",new{version=paused.Data["version"]!.GetValue<int>(),accepted=true})).Ok);
        await Process(3);
        Assert.Equal(lead.UserId,(await owner.Get($"/api/v1/support/tickets/{ticket}")).Data!["work"]!["assignee"]!["id"]!.GetValue<Guid>());
        Assert.Equal("closed",(await owner.Get($"/api/v1/support/workflows/runs/{id}")).Data!["nodeId"]!.GetValue<string>());
        factory.WithDb(db=>{
            var run=db.SupportWorkflowRuns.IgnoreQueryFilters().Single(r=>r.Id==id);run.AvailableAt=DateTime.UtcNow.AddDays(-1);db.SaveChanges();return 0;
        });
        await Process(2);
        var second=await owner.Get($"/api/v1/support/workflows/runs/{id}");
        Assert.Equal("approval",second.Data!["status"]!.GetValue<string>());
        Assert.Equal(manager.UserId,second.Data["approval"]!["userId"]!.GetValue<Guid>());
        Assert.Equal(lead.UserId,(await owner.Get($"/api/v1/support/tickets/{ticket}")).Data!["work"]!["assignee"]!["id"]!.GetValue<Guid>());
        Assert.True((await owner.Post($"/api/v1/support/workflows/runs/{id}/decide",new{version=second.Data["version"]!.GetValue<int>(),accepted=false})).Ok);
        await Process(2);
        Assert.Equal("succeeded",(await owner.Get($"/api/v1/support/workflows/runs/{id}")).Data!["status"]!.GetValue<string>());
        Assert.Equal(lead.UserId,(await owner.Get($"/api/v1/support/tickets/{ticket}")).Data!["work"]!["assignee"]!["id"]!.GetValue<Guid>());
    }}