using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Support;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
namespace ProjectManagement.Application.Features.SupportWorkflows;

public record SaveSupportWorkflowRequest(string Name, SupportWorkflowGraph Graph, int Version);
public record PublishSupportWorkflowRequest(int Version, int? RestoreRevision = null);
public record RunSupportWorkflowRequest(Guid TicketId, string RequestKey);
public record DecideSupportWorkflowRequest(int Version, bool Accepted);
public record WorkflowRevisionHeader(Guid Id, int Number, DateTime CreatedAt);
public record SupportWorkflowDto(Guid Id, string Name, SupportWorkflowGraph Graph, bool Enabled, Guid? PublishedRevisionId,
    int Version, IReadOnlyList<WorkflowRevisionHeader> Revisions);
public record WorkflowApprovalPreview(string Kind,string Label,Guid? UserId,string? UserName,string? Reason,int WaitMinutes,bool Stale);
public record SupportWorkflowRunDto(Guid Id, Guid WorkflowId, Guid TicketId, string NodeId, string Status, int Attempts,
    DateTime AvailableAt, string? ErrorCode, int Version, IReadOnlyList<SupportWorkflowStep> Steps, int RevisionNumber, WorkflowApprovalPreview? Approval);

public class SupportWorkflowService(IAppDbContext db, ICurrentContext ctx, PermissionService permissions,
    EntitlementService entitlements, SupportService support, AppClock clock, Recorder recorder)
{
    internal async Task GateAsync(CancellationToken ct)
    {
        ctx.RequireTenantId();ctx.RequireUserId();
        await permissions.RequireModuleAsync(Modules.Work, AccessLevel.Edit, ct);
        await permissions.RequireAsync(Permissions.WorkflowManage, ct);
        await permissions.RequireAsync(Permissions.WorkEdit, ct);
        if(await entitlements.GetValueAsync(FeatureKeys.Automation,ct)==0)throw new FeatureNotAvailableException(FeatureKeys.Automation);
    }
    private async Task<SupportWorkflow> RequireAsync(Guid id,CancellationToken ct)=>
        await db.SupportWorkflows.FirstOrDefaultAsync(w=>w.Id==id,ct)??throw new NotFoundException("Workflow not found.");
    private async Task<SupportWorkflowDto> DtoAsync(SupportWorkflow w,CancellationToken ct)=>new(w.Id,w.Name,
        JsonSerializer.Deserialize<SupportWorkflowGraph>(w.DraftJson,SupportWorkflowGraphs.Json)!,w.Enabled,w.PublishedRevisionId,w.Version,
        await db.SupportWorkflowRevisions.AsNoTracking().Where(r=>r.WorkflowId==w.Id).OrderByDescending(r=>r.Number)
            .Select(r=>new WorkflowRevisionHeader(r.Id,r.Number,r.CreatedAt)).ToListAsync(ct));
    public async Task<IReadOnlyList<SupportWorkflowDto>> ListAsync(CancellationToken ct)
    {
        await GateAsync(ct);var list=await db.SupportWorkflows.AsNoTracking().OrderBy(w=>w.Name).Take(30).ToListAsync(ct);
        var result=new List<SupportWorkflowDto>();foreach(var w in list)result.Add(await DtoAsync(w,ct));return result;
    }
    public async Task<SupportWorkflowDto> SaveAsync(Guid? id,SaveSupportWorkflowRequest req,CancellationToken ct)
    {
        await GateAsync(ct);var graph=SupportWorkflowGraphs.Validate(req.Graph);var name=(req.Name??"").Trim();
        if(name.Length is 0 or >120)throw new ValidationException("name","Use a workflow name up to 120 characters.");
        await using var tx=await db.Database.BeginOwnedTransactionAsync(ct);await db.LockTenantLedgerAsync(ctx.RequireTenantId(),ct);
        SupportWorkflow row;
        if(id is null)
        {
            if(await db.SupportWorkflows.CountAsync(ct)>=30)throw new ConflictException("Keep up to thirty support workflows.");
            row=new(){TenantId=ctx.RequireTenantId(),CreatorId=ctx.RequireUserId()};db.SupportWorkflows.Add(row);
        }
        else{row=await RequireAsync(id.Value,ct);if(row.Version!=req.Version)throw new ConflictException("The workflow changed. Reload first.");row.Version++;}
        row.Name=name;row.DraftJson=JsonSerializer.Serialize(graph,SupportWorkflowGraphs.Json);
        recorder.Audit("support.workflow_saved","SupportWorkflow",row.Id,null,new{row.Version});
        await db.SaveChangesAsync(ct);await tx.CommitIfOwnedAsync(ct);return await DtoAsync(row,ct);
    }
    public async Task<SupportWorkflowDto> PublishAsync(Guid id,PublishSupportWorkflowRequest req,CancellationToken ct)
    {
        await GateAsync(ct);await using var tx=await db.Database.BeginOwnedTransactionAsync(ct);
        await db.LockTenantLedgerAsync(ctx.RequireTenantId(),ct);var row=await RequireAsync(id,ct);
        if(row.Version!=req.Version)throw new ConflictException("The workflow changed. Reload first.");
        var json=row.DraftJson;
        if(req.RestoreRevision is {} number)json=await db.SupportWorkflowRevisions.Where(r=>r.WorkflowId==id&&r.Number==number).Select(r=>r.GraphJson).FirstOrDefaultAsync(ct)??throw new NotFoundException("Revision not found.");
        var graph=SupportWorkflowGraphs.Validate(JsonSerializer.Deserialize<SupportWorkflowGraph>(json,SupportWorkflowGraphs.Json)!);
        // References are validated again when each action executes. A draft can never assign a foreign user.
        foreach(var node in graph.Nodes.Where(n=>n.Type=="assign"))
        { var user=Guid.Parse(node.Value!);if(!await db.TenantMembers.AnyAsync(m=>m.TenantId==ctx.TenantId&&m.UserId==user,ct))throw new ValidationException("graph","Every assignee must belong to this workspace."); }
        var count=await db.SupportWorkflowRevisions.CountAsync(r=>r.WorkflowId==id,ct);
        if(count>=100)throw new ConflictException("This workflow has one hundred revisions. Create a new workflow.");
        var revision=new SupportWorkflowRevision{TenantId=row.TenantId,WorkflowId=id,Number=count+1,PublishedBy=ctx.RequireUserId(),GraphJson=json};
        db.SupportWorkflowRevisions.Add(revision);row.PublishedRevisionId=revision.Id;row.PublishedTrigger=graph.Trigger;row.Enabled=true;row.DraftJson=json;row.Version++;
        recorder.Audit("support.workflow_published","SupportWorkflow",id,null,new{revision=revision.Number,restored=req.RestoreRevision});
        await db.SaveChangesAsync(ct);await tx.CommitIfOwnedAsync(ct);return await DtoAsync(row,ct);
    }
    public async Task DisableAsync(Guid id,int version,CancellationToken ct)
    {
        await GateAsync(ct);var row=await RequireAsync(id,ct);if(row.Version!=version)throw new ConflictException("The workflow changed. Reload first.");
        row.Enabled=false;row.Version++;recorder.Audit("support.workflow_disabled","SupportWorkflow",id);await db.SaveChangesAsync(ct);
    }
    public async Task<SupportWorkflowRunDto> RunAsync(Guid id,RunSupportWorkflowRequest req,CancellationToken ct)
    {
        await GateAsync(ct);var ticket=await support.GetAsync(req.TicketId,ct);if(!ticket.Staff)throw new ForbiddenException("Manage this ticket before running a workflow.");
        if(string.IsNullOrWhiteSpace(req.RequestKey)||req.RequestKey.Length>80)throw new ValidationException("requestKey","Provide a stable request key up to eighty characters.");
        await using var tx=await db.Database.BeginOwnedTransactionAsync(ct);await db.LockTenantLedgerAsync(ctx.RequireTenantId(),ct);
        var row=await RequireAsync(id,ct);if(!row.Enabled||row.PublishedRevisionId is null)throw new ConflictException("Publish and enable this workflow first.");
        var key="manual:"+ctx.RequireUserId().ToString("N")+":"+req.RequestKey;
        var old=await db.SupportWorkflowRuns.FirstOrDefaultAsync(r=>r.WorkflowId==id&&r.RequestKey==key,ct);
        if(old!=null){if(old.TicketId!=req.TicketId)throw new ConflictException("This key was used for a different ticket.");return await RunDtoAsync(old,ct);}
        if(await db.SupportWorkflowRuns.CountAsync(r=>r.Status=="queued"||r.Status=="running"||r.Status=="approval",ct)>=500)throw new ConflictException("This workspace has five hundred pending workflow runs. Review its queue first.");
        var revision=await db.SupportWorkflowRevisions.SingleAsync(r=>r.Id==row.PublishedRevisionId,ct);
        var graph=SupportWorkflowGraphs.Validate(JsonSerializer.Deserialize<SupportWorkflowGraph>(revision.GraphJson,SupportWorkflowGraphs.Json)!);
        var run=new SupportWorkflowRun{TenantId=row.TenantId,WorkflowId=id,RevisionId=revision.Id,TicketId=req.TicketId,ExecutorId=ctx.RequireUserId(),RequestKey=key,NodeId=graph.Nodes.Single(n=>n.Type=="start").Id,AvailableAt=clock.Now};
        db.SupportWorkflowRuns.Add(run);recorder.Audit("support.workflow_queued","SupportWorkflowRun",run.Id,null,new{workflow=id,ticket=req.TicketId});
        await db.SaveChangesAsync(ct);await tx.CommitIfOwnedAsync(ct);return await RunDtoAsync(run,ct);
    }
    private async Task<SupportWorkflowRunDto> RunDtoAsync(SupportWorkflowRun run,CancellationToken ct)
    {
        var revision=await db.SupportWorkflowRevisions.AsNoTracking().SingleAsync(r=>r.Id==run.RevisionId,ct);
        WorkflowApprovalPreview? preview=null;
        if(run.Status=="approval")
        {
            var ticket=await support.GetAsync(run.TicketId,ct);
            var stale=ticket.Version!=run.ApprovedTicketVersion||ticket.Work.Version!=run.ApprovedWorkVersion
                ||!await db.SupportWorkflows.AnyAsync(w=>w.Id==run.WorkflowId&&w.Enabled&&w.PublishedRevisionId==run.RevisionId,ct);
            var graph=SupportWorkflowGraphs.Validate(JsonSerializer.Deserialize<SupportWorkflowGraph>(revision.GraphJson,SupportWorkflowGraphs.Json)!);
            var nodes=graph.Nodes.ToDictionary(n=>n.Id);var next=nodes[run.NodeId].Next;var wait=0;
            while(next!=null)
            {
                var node=nodes[next];
                if(node.Type=="condition")
                {
                    var value=SupportWorkflowGraphs.ConditionValue(ticket,node.Field);
                    next=string.Equals(value,node.Value,StringComparison.OrdinalIgnoreCase)?node.Next:node.Otherwise;continue;
                }
                if(node.Type=="wait"){wait+=node.Minutes;next=node.Next;continue;}
                if(node.Type=="assign")
                {
                    var uid=Guid.Parse(node.Value!);
                    var name=await (from m in db.TenantMembers join u in db.Users on m.UserId equals u.Id
                        where m.TenantId==ctx.TenantId&&m.UserId==uid&&u.IsActive select u.DisplayName).FirstOrDefaultAsync(ct);
                    preview=new("assign",node.Label,uid,name,null,wait,stale||name==null);break;
                }
                if(node.Type=="handoff"){preview=new("handoff",node.Label,null,null,node.Value,wait,stale);break;}
                if(node.Type is "end" or "approval")break;
                next=node.Next;
            }
            preview??=new("continue","Continue to the next review or finish",null,null,null,wait,stale);
        }
        return new(run.Id,run.WorkflowId,run.TicketId,run.NodeId,run.Status,run.Attempts,run.AvailableAt,run.ErrorCode,run.Version,
            await db.SupportWorkflowSteps.AsNoTracking().Where(s=>s.RunId==run.Id).OrderBy(s=>s.CreatedAt).ToListAsync(ct),revision.Number,preview);
    }
    private async Task<SupportWorkflowRun> RequireRunAsync(Guid id,CancellationToken ct)
    {
        await GateAsync(ct);var run=await db.SupportWorkflowRuns.FirstOrDefaultAsync(r=>r.Id==id,ct)??throw new NotFoundException("Run not found.");
        if(!(await support.GetAsync(run.TicketId,ct)).Staff)throw new NotFoundException("Run not found.");return run;
    }
    public async Task<SupportWorkflowRunDto> GetRunAsync(Guid id,CancellationToken ct)=>await RunDtoAsync(await RequireRunAsync(id,ct),ct);
    public async Task<IReadOnlyList<SupportWorkflowRunDto>> RunsAsync(Guid ticketId,CancellationToken ct)
    {
        await GateAsync(ct);if(!(await support.GetAsync(ticketId,ct)).Staff)throw new NotFoundException("Ticket not found.");
        var rows=await db.SupportWorkflowRuns.AsNoTracking().Where(r=>r.TicketId==ticketId).OrderByDescending(r=>r.CreatedAt).Take(50).ToListAsync(ct);
        var result=new List<SupportWorkflowRunDto>();foreach(var row in rows)result.Add(await RunDtoAsync(row,ct));return result;
    }
    public async Task<SupportWorkflowRunDto> DecideAsync(Guid id,DecideSupportWorkflowRequest req,CancellationToken ct)
    {
        var run=await RequireRunAsync(id,ct);await using var tx=await db.Database.BeginOwnedTransactionAsync(ct);
        var won=await db.SupportWorkflowRuns.Where(r=>r.Id==id&&r.Status=="approval"&&r.Version==req.Version).ExecuteUpdateAsync(s=>s.SetProperty(r=>r.Version,r=>r.Version),ct);
        if(won!=1)throw new ConflictException("This approval changed. Reload the run.");
        var workflow=await RequireAsync(run.WorkflowId,ct);
        if(!workflow.Enabled||workflow.PublishedRevisionId!=run.RevisionId)throw new ConflictException("This workflow revision is no longer active.");
        var json=await db.SupportWorkflowRevisions.Where(r=>r.Id==run.RevisionId).Select(r=>r.GraphJson).SingleAsync(ct);
        var node=SupportWorkflowGraphs.Validate(JsonSerializer.Deserialize<SupportWorkflowGraph>(json,SupportWorkflowGraphs.Json)!).Nodes.Single(n=>n.Id==run.NodeId);
        if(node.Type!="approval")throw new ConflictException("This node does not accept an approval.");
        var ticket=await support.GetAsync(run.TicketId,ct);
        if(ticket.Version!=run.ApprovedTicketVersion||ticket.Work.Version!=run.ApprovedWorkVersion)
            throw new ConflictException("The ticket changed while waiting for approval. Cancel this run and start a fresh review.","WORKFLOW_APPROVAL_STALE");
        db.SupportWorkflowSteps.Add(new(){TenantId=run.TenantId,RunId=id,NodeId=node.Id,Outcome=req.Accepted?"approved":"rejected",ApprovedBy=ctx.RequireUserId()});
        run.NodeId=(req.Accepted?node.Next:node.Otherwise)!;run.Status="queued";run.AvailableAt=clock.Now;run.Version++;run.Attempts=0;
        recorder.Audit("support.workflow_decided","SupportWorkflowRun",id,null,new{node=node.Id,req.Accepted});
        await db.SaveChangesAsync(ct);await tx.CommitIfOwnedAsync(ct);return await RunDtoAsync(run,ct);
    }
    public async Task CancelAsync(Guid id,int version,CancellationToken ct)
    {
        var run=await RequireRunAsync(id,ct);
        var won=await db.SupportWorkflowRuns.Where(r=>r.Id==id&&r.Version==version&&r.Status!="succeeded"&&r.Status!="cancelled")
            .ExecuteUpdateAsync(s=>s.SetProperty(r=>r.Status,"cancelled").SetProperty(r=>r.CompletedAt,clock.Now).SetProperty(r=>r.LeaseOwner,(Guid?)null).SetProperty(r=>r.LeaseExpiresAt,(DateTime?)null).SetProperty(r=>r.Version,r=>r.Version+1),ct);
        if(won!=1)throw new ConflictException("This run changed. Reload first.");
        recorder.Audit("support.workflow_cancelled","SupportWorkflowRun",run.Id);await db.SaveChangesAsync(ct);
    }
    public async Task<SupportWorkflowSchedule> ScheduleAsync(Guid id,Guid ticketId,int intervalMinutes,CancellationToken ct)
    {
        await GateAsync(ct);if(intervalMinutes is <5 or >10080)throw new ValidationException("intervalMinutes","Schedule between five minutes and seven days.");
        if(!(await support.GetAsync(ticketId,ct)).Staff)throw new NotFoundException("Ticket not found.");
        await using var tx=await db.Database.BeginOwnedTransactionAsync(ct);await db.LockTenantLedgerAsync(ctx.RequireTenantId(),ct);
        var workflow=await RequireAsync(id,ct);if(!workflow.Enabled||workflow.PublishedTrigger!="schedule")throw new ConflictException("Publish a workflow with a schedule trigger first.");
        var row=await db.SupportWorkflowSchedules.FirstOrDefaultAsync(s=>s.WorkflowId==id&&s.TicketId==ticketId,ct);
        if(row!=null)throw new ConflictException("This workflow already has a schedule for this ticket. Disable it before creating a replacement.");
        if(await db.SupportWorkflowSchedules.CountAsync(ct)>=100)throw new ConflictException("Keep up to one hundred ticket schedules.");
        row=new(){TenantId=ctx.RequireTenantId(),WorkflowId=id,TicketId=ticketId,UserId=ctx.RequireUserId(),IntervalMinutes=intervalMinutes,NextRunAt=clock.Now.AddMinutes(intervalMinutes)};
        db.SupportWorkflowSchedules.Add(row);recorder.Audit("support.workflow_scheduled","SupportWorkflowSchedule",row.Id);
        await db.SaveChangesAsync(ct);await tx.CommitIfOwnedAsync(ct);return row;
    }
    public async Task<IReadOnlyList<SupportWorkflowSchedule>> SchedulesAsync(Guid ticketId,CancellationToken ct)
    {
        await GateAsync(ct);if(!(await support.GetAsync(ticketId,ct)).Staff)throw new NotFoundException("Ticket not found.");
        return await db.SupportWorkflowSchedules.AsNoTracking().Where(s=>s.TicketId==ticketId).Take(100).ToListAsync(ct);
    }
    public async Task RemoveScheduleAsync(Guid id,CancellationToken ct)
    {
        await GateAsync(ct);var row=await db.SupportWorkflowSchedules.FirstOrDefaultAsync(s=>s.Id==id,ct)??throw new NotFoundException("Schedule not found.");
        if(!(await support.GetAsync(row.TicketId,ct)).Staff)throw new NotFoundException("Schedule not found.");
        db.SupportWorkflowSchedules.Remove(row);recorder.Audit("support.workflow_schedule_removed","SupportWorkflowSchedule",id);await db.SaveChangesAsync(ct);
    }
    public async Task RetryAsync(Guid id,int version,CancellationToken ct)
    {
        var run=await RequireRunAsync(id,ct);var workflow=await RequireAsync(run.WorkflowId,ct);
        if(!workflow.Enabled||workflow.PublishedRevisionId!=run.RevisionId)throw new ConflictException("Start a new run for the active workflow revision.");
        if(run.ErrorCode=="WORKFLOW_APPROVAL_STALE")throw new ConflictException("Start a new run to obtain a fresh approval.");
        var won=await db.SupportWorkflowRuns.Where(r=>r.Id==id&&r.Status=="failed"&&r.Version==version)
            .ExecuteUpdateAsync(s=>s.SetProperty(r=>r.Status,"queued").SetProperty(r=>r.Attempts,0).SetProperty(r=>r.ErrorCode,(string?)null).SetProperty(r=>r.CompletedAt,(DateTime?)null).SetProperty(r=>r.AvailableAt,clock.Now).SetProperty(r=>r.Version,r=>r.Version+1),ct);
        if(won!=1)throw new ConflictException("This failed run changed. Reload first.");
        recorder.Audit("support.workflow_retried","SupportWorkflowRun",id);await db.SaveChangesAsync(ct);
    }
}