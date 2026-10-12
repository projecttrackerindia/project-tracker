using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
namespace ProjectManagement.Application.Features.Support;
public record CreateSupportTicketRequest(string Title,string? Description,Guid WorkTypeId,Priority Priority,string Category,Guid? ProjectId=null);
public record SupportMetadataRequest(int Version,string Category,string Region,string Language,Guid? TeamId,Dictionary<string,string>? CustomFields=null);
public record SupportInteractionRequest(string Body,string Visibility,string RequestKey);
public record SupportStateRequest(int Version,string State,string? Reason=null,Guid? RelatedTicketId=null);
public record SupportTicketDto(Guid Id,WorkTaskDto Work,string Category,string Region,string Language,Guid? TeamId,string State,int Version,bool Staff,
    IReadOnlyList<SupportInteraction> Interactions,IReadOnlyList<Guid> Links,string HandoffReason,IReadOnlyDictionary<string,string> CustomFields);
public record SupportSummary(int Backlog,int Unassigned,int Handoffs,int OpenBreached,int ResolutionMet,int ResolutionMissed,int ResponseMet,int ResponseMissed);
public record SupportMessagePage(int Version,int Offset,int? NextOffset,IReadOnlyList<SupportInteraction> Items);
public record SupportQueueItem(Guid Id,string Key,string Title,Priority Priority,WorkTaskStatus WorkStatus,string State,string Category,Guid? AssigneeId,Guid? TeamId,DateTime? ResponseDueAt,DateTime? ResolutionDueAt,int Version);
public class SupportService(IAppDbContext db,ICurrentContext ctx,WorkTaskService work,PermissionService permissions,Recorder recorder,AppClock clock,ProjectManagement.Application.Features.SupportWorkflows.SupportWorkflowEmitter workflows,ProjectManagement.Application.Features.Notifications.NotificationService notifications)
{
    private async Task GateAsync(CancellationToken ct){ctx.RequireTenantId();await permissions.RequireModuleAsync(Modules.Work,AccessLevel.View,ct);}
    private async Task<(SupportTicket Ticket,WorkTaskDto Work,bool Staff)> FindAsync(Guid id,CancellationToken ct)
    {
        await GateAsync(ct);var row=await db.SupportTickets.FirstOrDefaultAsync(t=>t.Id==id,ct)??throw new NotFoundException("Ticket not found.");
        var w=await work.GetAsync(row.WorkTaskId,ct);var staff=await permissions.LevelAsync(Modules.Work,ct)>=AccessLevel.Edit && (await permissions.HasAsync(Permissions.WorkEdit,ct)||w.Assignee?.Id==ctx.UserId);
        if(!staff&&w.Reporter?.Id!=ctx.UserId)throw new NotFoundException("Ticket not found.");return(row,w,staff);
    }
    public async Task<IReadOnlyList<SupportQueueItem>> ListAsync(string? state,string? query,int page,CancellationToken ct)
    {
        await GateAsync(ct);var permissionsLevel=await permissions.LevelAsync(Modules.Work,ct);var staff=permissionsLevel>=AccessLevel.Edit&&await permissions.HasAsync(Permissions.WorkEdit,ct);var uid=ctx.RequireUserId();
        var q=from t in db.SupportTickets.AsNoTracking() join w in db.WorkTasks.AsNoTracking() on t.WorkTaskId equals w.Id
              where staff||w.ReporterId==uid||(w.AssigneeId==uid&&permissionsLevel>=AccessLevel.Edit) select new{Ticket=t,Work=w};
        if(!string.IsNullOrWhiteSpace(state))q=q.Where(x=>x.Ticket.State==state);
        if(!string.IsNullOrWhiteSpace(query)){var term=query.Trim();if(term.Length>200)throw new ValidationException("query","Use a shorter search.");q=q.Where(x=>x.Work.Title.Contains(term)||x.Ticket.Category.Contains(term));}
        return await q.OrderByDescending(x=>x.Ticket.CreatedAt).Skip((Math.Clamp(page,1,10000)-1)*25).Take(25)
            .Select(x=>new SupportQueueItem(x.Ticket.Id,"WT-"+x.Work.Number,x.Work.Title,x.Work.Priority,x.Work.Status,x.Ticket.State,x.Ticket.Category,x.Work.AssigneeId,x.Ticket.TeamId,x.Work.ResponseDueAt,x.Work.ResolutionDueAt,x.Ticket.Version)).ToListAsync(ct);
    }
    public async Task<SupportSummary> SummaryAsync(CancellationToken ct)
    {
        await GateAsync(ct);await permissions.RequireAsync(Permissions.ReportsView,ct);
        var level=await permissions.LevelAsync(Modules.Work,ct);
        var staff=level>=AccessLevel.Edit&&await permissions.HasAsync(Permissions.WorkEdit,ct);
        var uid=ctx.RequireUserId();var now=clock.Now;
        // WorkTasks retains its tenant and project query filters. Never aggregate unrestricted tickets.
        var visible=from t in db.SupportTickets.AsNoTracking()
                    join w in db.WorkTasks.AsNoTracking() on t.WorkTaskId equals w.Id
                    where staff||w.ReporterId==uid||(w.AssigneeId==uid&&level>=AccessLevel.Edit)
                    select new{Ticket=t,Work=w};
        var result=await visible.GroupBy(x=>1).Select(g=>new SupportSummary(
            g.Count(x=>x.Work.Status!=WorkTaskStatus.Completed&&x.Work.Status!=WorkTaskStatus.Cancelled),
            g.Count(x=>x.Work.Status!=WorkTaskStatus.Completed&&x.Work.Status!=WorkTaskStatus.Cancelled&&x.Work.AssigneeId==null),
            g.Count(x=>x.Ticket.State=="handoff"&&x.Work.Status!=WorkTaskStatus.Completed&&x.Work.Status!=WorkTaskStatus.Cancelled),
            g.Count(x=>x.Work.Status!=WorkTaskStatus.Completed&&x.Work.Status!=WorkTaskStatus.Cancelled&&
                ((x.Work.ResponseDueAt!=null&&x.Work.RespondedAt==null&&x.Work.ResponseDueAt<now)||
                 (x.Work.ResolutionDueAt!=null&&((x.Work.SlaPausedAt==null&&x.Work.ResolutionDueAt<now)||
                    (x.Work.SlaPausedAt!=null&&x.Work.SlaPausedAt>x.Work.ResolutionDueAt))))),
            g.Count(x=>x.Work.Status==WorkTaskStatus.Completed&&x.Work.CompletedAt!=null&&x.Work.ResolutionDueAt!=null&&x.Work.CompletedAt<=x.Work.ResolutionDueAt),
            g.Count(x=>x.Work.Status==WorkTaskStatus.Completed&&x.Work.CompletedAt!=null&&x.Work.ResolutionDueAt!=null&&x.Work.CompletedAt>x.Work.ResolutionDueAt),
            g.Count(x=>x.Work.Status!=WorkTaskStatus.Cancelled&&x.Work.RespondedAt!=null&&x.Work.ResponseDueAt!=null&&x.Work.RespondedAt<=x.Work.ResponseDueAt),
            g.Count(x=>x.Work.Status!=WorkTaskStatus.Cancelled&&x.Work.RespondedAt!=null&&x.Work.ResponseDueAt!=null&&x.Work.RespondedAt>x.Work.ResponseDueAt)
        )).SingleOrDefaultAsync(ct);
        return result??new(0,0,0,0,0,0,0,0);
    }
    public async Task<SupportMessagePage> MessagesAsync(Guid id,int version,int offset,CancellationToken ct)
    {
        var(t,_,staff)=await FindAsync(id,ct);
        if(offset<0||offset>2000)throw new ValidationException("offset","Choose a valid conversation page.");
        if(version!=t.Version)throw new ConflictException("This conversation changed. Reload the ticket before paging.");
        // Filter private notes before paging; hidden identifiers and counts never reach requesters.
        var rows=await db.SupportInteractions.AsNoTracking()
            .Where(m=>m.TicketId==id&&(staff||m.Visibility=="public"))
            .OrderByDescending(m=>m.CreatedAt).ThenByDescending(m=>m.Id)
            .Skip(offset).Take(51).ToListAsync(ct);
        // A concurrent writer must not shift offsets silently.
        var current=await db.SupportTickets.AsNoTracking().Where(x=>x.Id==id).Select(x=>(int?)x.Version).SingleOrDefaultAsync(ct);
        if(current!=version)throw new ConflictException("This conversation changed. Reload the ticket before paging.");
        return new(version,offset,rows.Count>50?offset+50:null,rows.Take(50).Reverse().ToArray());
    }
    public async Task<SupportTicketDto> GetAsync(Guid id,CancellationToken ct)
    {
        var (t,w,staff)=await FindAsync(id,ct);
        var messages=await db.SupportInteractions.AsNoTracking().Where(m=>m.TicketId==id&&(staff||m.Visibility=="public")).OrderByDescending(m=>m.CreatedAt).ThenByDescending(m=>m.Id).Take(50).ToListAsync(ct);
        var links=await db.SupportTicketLinks.Where(l=>l.TicketId==id).Select(l=>l.RelatedTicketId).ToListAsync(ct);
        // Link identifiers are only returned when the caller can open both sides.
        var safe=new List<Guid>();foreach(var link in links){try{await FindAsync(link,ct);safe.Add(link);}catch(NotFoundException){}}
        return new(t.Id,w,t.Category,t.Region,t.Language,t.TeamId,t.State,t.Version,staff,messages.AsEnumerable().Reverse().ToArray(),safe,staff?t.HandoffReason:"",staff?JsonSerializer.Deserialize<Dictionary<string,string>>(t.CustomFieldsJson)??new():new());
    }
    public async Task<SupportTicketDto> CreateAsync(CreateSupportTicketRequest req,CancellationToken ct)
    {
        await GateAsync(ct);await using var tx=await db.Database.BeginOwnedTransactionAsync(ct);
        var w=await work.CreateAsync(new(req.Title,req.Description,req.WorkTypeId,req.ProjectId,null,req.Priority,null,null,null),ct);
        var row=new SupportTicket{TenantId=ctx.RequireTenantId(),WorkTaskId=w.Id,Category=Clean(req.Category,120,"category")};db.SupportTickets.Add(row);
        await workflows.EmitAsync(row.Id,"ticket_created",row.Id.ToString("N"),ct);
        recorder.Audit("support.ticket_created","SupportTicket",row.Id,null,new{workId=w.Id});await db.SaveChangesAsync(ct);await tx.CommitIfOwnedAsync(ct);return await GetAsync(row.Id,ct);
    }
    private static string Clean(string? s,int max,string field){var t=(s??"").Trim();if(t.Length>max)throw new ValidationException(field,$"Keep this under {max} characters.");return t;}
    public async Task<SupportTicketDto> MetadataAsync(Guid id,SupportMetadataRequest req,CancellationToken ct)
    {
        var(t,_,staff)=await FindAsync(id,ct);if(!staff)throw new ForbiddenException("Only support staff can configure routing metadata.");if(req.Version!=t.Version)throw new ConflictException("This ticket changed. Reload first.");
        if(req.TeamId!=null&&!await db.Teams.AnyAsync(x=>x.Id==req.TeamId,ct))throw new ValidationException("teamId","Choose a team in this workspace.");
        if(req.CustomFields?.Count>20||req.CustomFields?.Any(f=>string.IsNullOrWhiteSpace(f.Key)||f.Key.Length>80||f.Value==null||f.Value.Length>1000)==true)throw new ValidationException("customFields","Use up to 20 bounded custom fields.");
        t.Category=Clean(req.Category,120,"category");t.Region=Clean(req.Region,80,"region");t.Language=Clean(req.Language,30,"language");t.TeamId=req.TeamId;t.CustomFieldsJson=JsonSerializer.Serialize(req.CustomFields??new());t.Version++;
        recorder.Audit("support.routing_updated","SupportTicket",id,null,new{t.Version,t.TeamId});await db.SaveChangesAsync(ct);return await GetAsync(id,ct);
    }
    public async Task<SupportTicketDto> MessageAsync(Guid id,SupportInteractionRequest req,CancellationToken ct)
    {
        var(t,w,staff)=await FindAsync(id,ct);if(req.Visibility is not ("public" or "internal")||req.Visibility=="internal"&&!staff)throw new ForbiddenException("Internal notes are available only to support staff.");
        if(t.State is "closed" or "merged" or "cancelled")throw new ConflictException("Reopen this ticket before adding a reply.");var text=Clean(req.Body,8000,"body");var key=Clean(req.RequestKey,100,"requestKey");if(text.Length==0||key.Length==0)throw new ValidationException("body","Add a message and an idempotency key.");
        var old=await db.SupportInteractions.FirstOrDefaultAsync(m=>m.TicketId==id&&m.AuthorId==ctx.UserId&&m.RequestKey==key,ct);
        if(old!=null){if(old.Body!=text||old.Visibility!=req.Visibility)throw new ConflictException("This key was used for a different message.");return await GetAsync(id,ct);}
        if(await db.SupportInteractions.CountAsync(m=>m.TicketId==id,ct)>=2000)throw new ConflictException("This ticket has two thousand messages. Create a linked follow-up ticket.");
        var interaction=new SupportInteraction{TenantId=t.TenantId,TicketId=id,AuthorId=ctx.RequireUserId(),Body=text,Visibility=req.Visibility,RequestKey=key};
        db.SupportInteractions.Add(interaction);t.Version++;
        if(req.Visibility=="public")
        {
            await workflows.EmitAsync(id,"message_received",interaction.Id.ToString("N"),ct);
            foreach(var recipient in new Guid?[]{w.Reporter?.Id,w.Assignee?.Id}.Where(x=>x!=null).Select(x=>x!.Value).Distinct())
                await notifications.AddAsync(recipient,NotificationType.TaskUpdated,"Support ticket updated",null,$"/support?ticket={id}",
                    $"support:{interaction.Id:N}:{recipient:N}",ct:ct);
        }
        // Public staff response meets the existing first-response SLA, not a requester's own message or a private note.
        if(staff&&w.Reporter?.Id!=ctx.UserId&&req.Visibility=="public"){var task=await db.WorkTasks.SingleAsync(x=>x.Id==t.WorkTaskId,ct);task.RespondedAt??=clock.Now;}
        recorder.Audit("support.message_added","SupportTicket",id,null,new{visibility=req.Visibility});await db.SaveChangesAsync(ct);return await GetAsync(id,ct);
    }
    public async Task<SupportTicketDto> StateAsync(Guid id,SupportStateRequest req,CancellationToken ct)
    {
        var(t,w,staff)=await FindAsync(id,ct);if(!staff)throw new ForbiddenException("Only support staff can change ticket state.");if(req.Version!=t.Version)throw new ConflictException("This ticket changed. Reload first.");
        if(req.State is not ("open" or "waiting" or "resolved" or "closed" or "handoff" or "merged" or "linked" or "cancelled"))throw new ValidationException("state","Choose an allowed ticket state.");
        await using var tx=await db.Database.BeginOwnedTransactionAsync(ct);
        using var paused=workflows.Pause();
        if(req.State=="closed"){
            var locked=await db.WorkTasks.Where(x=>x.Id==t.WorkTaskId&&x.Version==w.Version).ExecuteUpdateAsync(s=>s.SetProperty(x=>x.Version,x=>x.Version),ct);
            if(locked!=1)throw new ConflictException("The support work changed. Reload before closing.");
            var task=await db.WorkTasks.AsNoTracking().SingleAsync(x=>x.Id==t.WorkTaskId,ct);if(task.Status!=WorkTaskStatus.Completed||task.ResolutionAcceptedAt==null)throw new ConflictException("Complete the work and obtain requester acceptance before closing this ticket.");
        }
        if(req.State=="cancelled")await work.SetStatusAsync(t.WorkTaskId,new(WorkTaskStatus.Cancelled),ct);
        if(req.State=="resolved")await work.SetStatusAsync(t.WorkTaskId,new(WorkTaskStatus.Completed),ct);
        if(req.State=="open")await work.SetStatusAsync(t.WorkTaskId,new(WorkTaskStatus.ToDo),ct);
        if(req.State=="waiting")await work.SetStatusAsync(t.WorkTaskId,new(WorkTaskStatus.OnHold),ct);
        if(req.State=="handoff"){t.HandoffReason=Clean(req.Reason,1000,"reason");if(t.HandoffReason.Length==0)throw new ValidationException("reason","Explain why human support is needed.");}
        if(req.State is "merged" or "linked"){
            if(req.RelatedTicketId is not {} target||target==id)throw new ValidationException("relatedTicketId","Choose another ticket.");var(other,_,targetStaff)=await FindAsync(target,ct);if(!targetStaff)throw new ForbiddenException("You must manage both tickets.");
            if(other.State=="merged")throw new ConflictException("Link to an active ticket rather than a merged ticket.");
            if(await db.SupportTicketLinks.CountAsync(l=>l.TicketId==id,ct)>=30)throw new ConflictException("Keep up to thirty related tickets.");
            if(!await db.SupportTicketLinks.AnyAsync(l=>l.TicketId==id&&l.RelatedTicketId==target,ct))db.SupportTicketLinks.Add(new(){TenantId=t.TenantId,TicketId=id,RelatedTicketId=target});
            if(req.State=="merged"){t.MergedIntoId=target;await work.SetStatusAsync(t.WorkTaskId,new(WorkTaskStatus.Cancelled),ct);}
        }
        if(req.State!="linked")t.State=req.State;t.Version++;
        if(req.State=="open")t.MergedIntoId=null;
        paused.Dispose();
        if(req.State!="linked")await workflows.EmitAsync(id,"state_changed",id.ToString("N")+":"+t.Version,ct);
        db.SupportInteractions.Add(new(){TenantId=t.TenantId,TicketId=id,AuthorId=ctx.RequireUserId(),Kind="state",Visibility="internal",Body=$"State: {req.State}. {Clean(req.Reason,1000,"reason")}",RequestKey=Guid.NewGuid().ToString("N")});
        if(req.State!="linked")foreach(var recipient in new Guid?[]{w.Reporter?.Id,w.Assignee?.Id}.Where(x=>x!=null).Select(x=>x!.Value).Distinct())
            await notifications.AddAsync(recipient,NotificationType.TaskUpdated,"Support ticket updated",null,$"/support?ticket={id}",
                $"support-state:{id:N}:{t.Version}:{recipient:N}",ct:ct);
        recorder.Audit("support.state_changed","SupportTicket",id,null,new{state=req.State,t.Version,req.RelatedTicketId});await db.SaveChangesAsync(ct);await tx.CommitIfOwnedAsync(ct);return await GetAsync(id,ct);
    }
}
