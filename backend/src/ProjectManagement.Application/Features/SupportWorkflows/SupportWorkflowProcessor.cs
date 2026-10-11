using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Support;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
namespace ProjectManagement.Application.Features.SupportWorkflows;

public class SupportWorkflowProcessor(IServiceScopeFactory scopes,TimeProvider time)
{
    private DateTime Now=>time.GetUtcNow().UtcDateTime;
    public async Task<int> ProcessAsync(CancellationToken ct=default)
    {
        await QueueSlaEventsAsync(ct);
        await QueueEventsAsync(ct);
        await QueueSchedulesAsync(ct);
        List<Guid> ids;
        using(var scan=scopes.CreateScope())
        {
            var db=scan.ServiceProvider.GetRequiredService<IAppDbContext>();var now=Now;
            await db.SupportWorkflowRuns.IgnoreQueryFilters().Where(r=>r.Status=="running"&&r.LeaseExpiresAt<=now)
                .ExecuteUpdateAsync(s=>s.SetProperty(r=>r.Status,"queued").SetProperty(r=>r.LeaseOwner,(Guid?)null).SetProperty(r=>r.LeaseExpiresAt,(DateTime?)null).SetProperty(r=>r.AvailableAt,now),ct);
            await db.SupportWorkflowRuns.IgnoreQueryFilters().Where(r=>r.Status=="approval"&&r.AvailableAt<=now)
                .ExecuteUpdateAsync(s=>s.SetProperty(r=>r.Status,"failed").SetProperty(r=>r.CompletedAt,now).SetProperty(r=>r.ErrorCode,"WORKFLOW_APPROVAL_EXPIRED").SetProperty(r=>r.Version,r=>r.Version+1),ct);
            var tenants=await db.SupportWorkflowRuns.IgnoreQueryFilters().AsNoTracking().Where(r=>r.Status=="queued"&&r.AvailableAt<=now)
                .GroupBy(r=>r.TenantId).Select(g=>new{Id=g.Key,Due=g.Min(r=>r.AvailableAt)}).OrderBy(g=>g.Due).Take(10).ToListAsync(ct);
            ids=[];
            foreach(var tenant in tenants)
            {
                var id=await db.SupportWorkflowRuns.IgnoreQueryFilters().Where(r=>r.TenantId==tenant.Id&&r.Status=="queued"&&r.AvailableAt<=now)
                    .OrderBy(r=>r.AvailableAt).ThenBy(r=>r.CreatedAt).Select(r=>r.Id).FirstOrDefaultAsync(ct);
                if(id!=Guid.Empty)ids.Add(id);
            }
        }
        var count=0;foreach(var id in ids){ct.ThrowIfCancellationRequested();if(await StepAsync(id,ct))count++;}return count;
    }
    private async Task QueueEventsAsync(CancellationToken ct)
    {
        List<Guid> tenants;
        using(var scan=scopes.CreateScope())
        {
            var db=scan.ServiceProvider.GetRequiredService<IAppDbContext>();
            tenants=await db.SupportWorkflowEvents.IgnoreQueryFilters().Where(e=>e.ProcessedAt==null
                // Leave headroom for the maximum 30 publications per event. Saturated
                // tenants retain their events without occupying every scan slot.
                &&db.SupportWorkflowRuns.IgnoreQueryFilters().Count(r=>r.TenantId==e.TenantId
                    &&(r.Status=="queued"||r.Status=="running"||r.Status=="approval"))<=470)
                .GroupBy(e=>e.TenantId).Select(g=>new{Id=g.Key,Oldest=g.Min(e=>e.CreatedAt)}).OrderBy(g=>g.Oldest).Take(10).Select(g=>g.Id).ToListAsync(ct);
        }
        foreach(var tenant in tenants)
        {
            using var scope=scopes.CreateScope();var db=scope.ServiceProvider.GetRequiredService<IAppDbContext>();
            scope.ServiceProvider.GetRequiredService<CurrentContext>().TenantId=tenant;
            await using var tx=await db.Database.BeginOwnedTransactionAsync(ct);await db.LockTenantLedgerAsync(tenant,ct);
            var pending=await db.SupportWorkflowRuns.CountAsync(r=>r.Status=="queued"||r.Status=="running"||r.Status=="approval",ct);
            var events=await db.SupportWorkflowEvents.Where(e=>e.ProcessedAt==null).OrderBy(e=>e.CreatedAt).Take(20).ToListAsync(ct);
            foreach(var ev in events)
            {
                var revisionIds=JsonSerializer.Deserialize<Guid[]>(ev.RevisionIdsJson)??[];
                var workflows=await db.SupportWorkflows.Where(w=>w.Enabled&&w.PublishedRevisionId!=null&&revisionIds.Contains(w.PublishedRevisionId.Value)&&w.PublishedTrigger==ev.Kind).Take(30).ToListAsync(ct);
                if(pending+workflows.Count>500)break; // retain the event; capacity pressure never drops it
                foreach(var w in workflows)
                {
                    var revision=await db.SupportWorkflowRevisions.SingleAsync(r=>r.Id==w.PublishedRevisionId,ct);
                    var graph=SupportWorkflowGraphs.Validate(JsonSerializer.Deserialize<SupportWorkflowGraph>(revision.GraphJson,SupportWorkflowGraphs.Json)!);
                    db.SupportWorkflowRuns.Add(new(){TenantId=tenant,WorkflowId=w.Id,RevisionId=revision.Id,TicketId=ev.TicketId,EventId=ev.Id,ExecutorId=revision.PublishedBy,
                        RequestKey="event:"+ev.Id.ToString("N"),NodeId=graph.Nodes.Single(n=>n.Type=="start").Id,AvailableAt=Now});pending++;
                }
                ev.ProcessedAt=Now;
            }
            await db.SaveChangesAsync(ct);await tx.CommitIfOwnedAsync(ct);
        }
    }
    private async Task QueueSchedulesAsync(CancellationToken ct)
    {
        List<Guid> tenants;
        using(var scan=scopes.CreateScope())
        {
            var db=scan.ServiceProvider.GetRequiredService<IAppDbContext>();var now=Now;
            tenants=await db.SupportWorkflowSchedules.IgnoreQueryFilters().Where(s=>s.Enabled&&s.NextRunAt<=now)
                .GroupBy(s=>s.TenantId).Select(g=>new{Id=g.Key,Due=g.Min(s=>s.NextRunAt)}).OrderBy(g=>g.Due).Take(10).Select(g=>g.Id).ToListAsync(ct);
        }
        foreach(var tenant in tenants)
        {
            using var scope=scopes.CreateScope();var db=scope.ServiceProvider.GetRequiredService<IAppDbContext>();var now=Now;
            scope.ServiceProvider.GetRequiredService<CurrentContext>().TenantId=tenant;
            await using var tx=await db.Database.BeginOwnedTransactionAsync(ct);await db.LockTenantLedgerAsync(tenant,ct);
            var due=await db.SupportWorkflowSchedules.Where(s=>s.Enabled&&s.NextRunAt<=now).OrderBy(s=>s.NextRunAt).Take(20).ToListAsync(ct);
            var pending=await db.SupportWorkflowRuns.CountAsync(r=>r.Status=="queued"||r.Status=="running"||r.Status=="approval",ct);
            foreach(var schedule in due)
            {
                if(pending>=500){schedule.NextRunAt=now.AddMinutes(1);schedule.Version++;continue;}
                var workflow=await db.SupportWorkflows.FirstOrDefaultAsync(w=>w.Id==schedule.WorkflowId&&w.Enabled&&w.PublishedTrigger=="schedule",ct);
                if(workflow?.PublishedRevisionId is not {} revisionId){schedule.Enabled=false;schedule.Version++;continue;}
                var active=await db.SupportWorkflowRuns.AnyAsync(r=>r.WorkflowId==schedule.WorkflowId&&r.TicketId==schedule.TicketId&&(r.Status=="queued"||r.Status=="running"||r.Status=="approval"),ct);
                if(!active)
                {
                    var json=await db.SupportWorkflowRevisions.Where(r=>r.Id==revisionId).Select(r=>r.GraphJson).SingleAsync(ct);
                    var graph=SupportWorkflowGraphs.Validate(JsonSerializer.Deserialize<SupportWorkflowGraph>(json,SupportWorkflowGraphs.Json)!);
                    db.SupportWorkflowRuns.Add(new(){TenantId=tenant,WorkflowId=workflow.Id,RevisionId=revisionId,TicketId=schedule.TicketId,ScheduleId=schedule.Id,ExecutorId=schedule.UserId,
                        RequestKey=$"schedule:{schedule.Id:N}:{schedule.NextRunAt.Ticks}",NodeId=graph.Nodes.Single(n=>n.Type=="start").Id,AvailableAt=now});pending++;
                }
                // Coalesce missed periods. A waiting approval never accumulates repeated executions.
                schedule.NextRunAt=now.AddMinutes(schedule.IntervalMinutes);schedule.Version++;
            }
            await db.SaveChangesAsync(ct);await tx.CommitIfOwnedAsync(ct);
        }
    }
    private async Task QueueSlaEventsAsync(CancellationToken ct)
    {
        using var scan=scopes.CreateScope();var scanDb=scan.ServiceProvider.GetRequiredService<IAppDbContext>();var now=Now;
        var candidates=await (from ticket in scanDb.SupportTickets.IgnoreQueryFilters().AsNoTracking()
            join work in scanDb.WorkTasks.IgnoreQueryFilters().AsNoTracking() on ticket.WorkTaskId equals work.Id
            where ticket.TenantId==work.TenantId&&!work.IsDeleted&&(work.Status==WorkTaskStatus.ToDo||work.Status==WorkTaskStatus.InProgress||work.Status==WorkTaskStatus.OnHold)
                &&scanDb.Tenants.IgnoreQueryFilters().Any(t=>t.Id==ticket.TenantId&&!t.IsDeleted&&t.Status==TenantStatus.Active)
                &&scanDb.SupportWorkflows.IgnoreQueryFilters().Any(w=>w.TenantId==ticket.TenantId&&w.Enabled&&w.PublishedTrigger=="sla_breach")
                &&(work.RespondedAt==null&&work.ResponseDueAt!=null&&work.ResponseDueAt<=now&&ticket.WorkflowResponseDueAt!=work.ResponseDueAt
                   ||work.SlaPausedAt==null&&work.ResolutionDueAt!=null&&work.ResolutionDueAt<=now&&ticket.WorkflowResolutionDueAt!=work.ResolutionDueAt)
            orderby ticket.CreatedAt
            select new{ticket.Id,ticket.TenantId}).Take(100).ToListAsync(ct);
        foreach(var candidate in candidates)
        {
            using var scope=scopes.CreateScope();var db=scope.ServiceProvider.GetRequiredService<IAppDbContext>();
            scope.ServiceProvider.GetRequiredService<CurrentContext>().TenantId=candidate.TenantId;
            await using var tx=await db.Database.BeginOwnedTransactionAsync(ct);await db.LockTenantLedgerAsync(candidate.TenantId,ct);
            var ticket=await db.SupportTickets.SingleAsync(t=>t.Id==candidate.Id,ct);
            var work=await db.WorkTasks.FirstOrDefaultAsync(w=>w.Id==ticket.WorkTaskId,ct);
            if(work is null||work.Status is WorkTaskStatus.Completed or WorkTaskStatus.Cancelled)continue;
            var revisions=await db.SupportWorkflows.Where(w=>w.Enabled&&w.PublishedRevisionId!=null&&w.PublishedTrigger=="sla_breach").Select(w=>w.PublishedRevisionId!.Value).Take(30).ToListAsync(ct);
            if(revisions.Count==0)continue;
            async Task Add(string clock,DateTime due)
            {
                var key=$"sla:{ticket.Id:N}:{clock}:{due.Ticks}";
                if(!await db.SupportWorkflowEvents.AnyAsync(e=>e.RequestKey==key,ct))
                    db.SupportWorkflowEvents.Add(new(){TenantId=candidate.TenantId,TicketId=ticket.Id,Kind="sla_breach",RequestKey=key,RevisionIdsJson=JsonSerializer.Serialize(revisions)});
            }
            if(work.RespondedAt==null&&work.ResponseDueAt is {} response&&response<=now&&ticket.WorkflowResponseDueAt!=response)
            {await Add("response",response);ticket.WorkflowResponseDueAt=response;}
            if(work.SlaPausedAt==null&&work.ResolutionDueAt is {} resolution&&resolution<=now&&ticket.WorkflowResolutionDueAt!=resolution)
            {await Add("resolution",resolution);ticket.WorkflowResolutionDueAt=resolution;}
            await db.SaveChangesAsync(ct);await tx.CommitIfOwnedAsync(ct);
        }
    }
    private async Task<bool> StepAsync(Guid id,CancellationToken ct)
    {
        using var scope=scopes.CreateScope();var sp=scope.ServiceProvider;var db=sp.GetRequiredService<IAppDbContext>();var lease=Guid.NewGuid();var now=Now;
        var won=await db.SupportWorkflowRuns.IgnoreQueryFilters().Where(r=>r.Id==id&&r.Status=="queued"&&r.AvailableAt<=now)
            .ExecuteUpdateAsync(s=>s.SetProperty(r=>r.Status,"running").SetProperty(r=>r.LeaseOwner,lease).SetProperty(r=>r.LeaseExpiresAt,now.AddMinutes(2)),ct);
        if(won==0)return false;
        var run=await db.SupportWorkflowRuns.IgnoreQueryFilters().SingleAsync(r=>r.Id==id&&r.LeaseOwner==lease,ct);
        using var deadline=CancellationTokenSource.CreateLinkedTokenSource(ct);deadline.CancelAfter(TimeSpan.FromSeconds(30));
        try
        {
            await WorkspaceExecutionPrincipal.ConfigureAsync(sp,run.ExecutorId,run.TenantId,null,deadline.Token);
            await using var tx=await db.Database.BeginOwnedTransactionAsync(deadline.Token);
            var locked=await db.SupportWorkflowRuns.Where(r=>r.Id==id&&r.Status=="running"&&r.LeaseOwner==lease&&r.LeaseExpiresAt>Now)
                .ExecuteUpdateAsync(s=>s.SetProperty(r=>r.Version,r=>r.Version),deadline.Token);
            if(locked!=1)return true;
            await sp.GetRequiredService<SupportWorkflowService>().GateAsync(deadline.Token);
            var workflow=await db.SupportWorkflows.SingleOrDefaultAsync(w=>w.Id==run.WorkflowId,deadline.Token);
            if(workflow is null||!workflow.Enabled||workflow.PublishedRevisionId!=run.RevisionId)
            {run.Status="cancelled";run.ErrorCode="WORKFLOW_REVISION_INACTIVE";run.CompletedAt=Now;}
            else
            {
                var json=await db.SupportWorkflowRevisions.Where(r=>r.Id==run.RevisionId).Select(r=>r.GraphJson).SingleAsync(deadline.Token);
                var graph=SupportWorkflowGraphs.Validate(JsonSerializer.Deserialize<SupportWorkflowGraph>(json,SupportWorkflowGraphs.Json)!);
                var node=graph.Nodes.Single(n=>n.Id==run.NodeId);
                var support=sp.GetRequiredService<SupportService>();var ticket=await support.GetAsync(run.TicketId,deadline.Token);
                if(!ticket.Staff)throw new ForbiddenException("The workflow principal cannot manage this ticket.");
                sp.GetRequiredService<SupportWorkflowEmitter>().Suppressed=true;
                string outcome="completed";string? next=node.Next;
                if(node.Type=="approval")
                {run.Status="approval";run.AvailableAt=Now.AddDays(7);run.ApprovedWorkVersion=ticket.Work.Version;run.ApprovedTicketVersion=ticket.Version;}
                else
                {
                    if(node.Type is "assign" or "handoff")
                    {
                        if(run.ApprovedWorkVersion!=ticket.Work.Version||run.ApprovedTicketVersion!=ticket.Version)
                            throw new ConflictException("The approved ticket changed. A fresh confirmation is required.","WORKFLOW_APPROVAL_STALE");
                    }
                    switch(node.Type)
                    {
                        case "condition":
                            var value=SupportWorkflowGraphs.ConditionValue(ticket,node.Field);
                            var matched=string.Equals(value,node.Value,StringComparison.OrdinalIgnoreCase);next=matched?node.Next:node.Otherwise;outcome=matched?"matched":"unmatched";break;
                        case "note":
                            await support.MessageAsync(run.TicketId,new(node.Value!,"internal",$"workflow:{run.Id:N}:{node.Id}"),deadline.Token);break;
                        case "handoff":
                            await support.StateAsync(run.TicketId,new(ticket.Version,"handoff",node.Value),deadline.Token);run.ApprovedWorkVersion=null;run.ApprovedTicketVersion=null;break;
                        case "assign":
                            var w=ticket.Work;
                            await sp.GetRequiredService<WorkTaskService>().UpdateAsync(w.Id,new(w.Title,w.Description,w.WorkTypeId,w.RelatedProject?.Id,Guid.Parse(node.Value!),w.Priority,w.Status,w.StartDate,w.DueDate,w.Version),deadline.Token);
                            run.ApprovedWorkVersion=null;run.ApprovedTicketVersion=null;break;
                        case "wait":run.AvailableAt=Now.AddMinutes(node.Minutes);outcome="scheduled";break;
                        case "end":run.Status="succeeded";run.CompletedAt=Now;break;
                    }
                    db.SupportWorkflowSteps.Add(new(){TenantId=run.TenantId,RunId=run.Id,NodeId=node.Id,Outcome=outcome});
                    if(node.Type!="end"){run.NodeId=next!;run.Status="queued";if(node.Type!="wait")run.AvailableAt=Now;}
                    run.Attempts=0;run.ErrorCode=null;
                }
            }
            run.LeaseOwner=null;run.LeaseExpiresAt=null;run.Version++;
            sp.GetRequiredService<Recorder>().Audit("support.workflow_step","SupportWorkflowRun",run.Id,null,new{run.NodeId,run.Status});
            await db.SaveChangesAsync(deadline.Token);await tx.CommitIfOwnedAsync(deadline.Token);
        }
        catch(OperationCanceledException)when(ct.IsCancellationRequested){throw;}
        catch(Exception ex)
        {
            // No external sends occur in this processor. Rolled-back actions can be retried atomically with their receipt.
            if(ex is AppException && run.ScheduleId is {} scheduleId)
                await db.SupportWorkflowSchedules.IgnoreQueryFilters().Where(s=>s.Id==scheduleId&&s.TenantId==run.TenantId)
                    .ExecuteUpdateAsync(s=>s.SetProperty(x=>x.Enabled,false).SetProperty(x=>x.Version,x=>x.Version+1),ct);
            var code=ex is AppException app?app.Code:ex is OperationCanceledException?"WORKFLOW_TIMEOUT":"WORKFLOW_STEP_FAILED";
            var attempts=run.Attempts+1;var retry=ex is not AppException&&attempts<3;

            await db.SupportWorkflowRuns.IgnoreQueryFilters().Where(r=>r.Id==id&&r.Status=="running"&&r.LeaseOwner==lease)
                .ExecuteUpdateAsync(s=>s.SetProperty(r=>r.Status,retry?"queued":"failed").SetProperty(r=>r.Attempts,attempts).SetProperty(r=>r.ErrorCode,code)
                    .SetProperty(r=>r.AvailableAt,Now.AddSeconds(attempts*30)).SetProperty(r=>r.CompletedAt,retry?(DateTime?)null:Now)
                    .SetProperty(r=>r.LeaseOwner,(Guid?)null).SetProperty(r=>r.LeaseExpiresAt,(DateTime?)null).SetProperty(r=>r.Version,r=>r.Version+1),ct);
        }
        return true;
    }
}