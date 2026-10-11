using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Enums;
namespace ProjectManagement.Application.Features.Support;

public record SupportRoutingCandidate(Guid UserId,string Name,int Open,int Overdue,int? WeeklyCapacityMinutes);
public record SupportEscalationTarget(Guid UserId,string Name,string Basis);
public record SupportRoutingPreview(int TicketVersion,int WorkVersion,string WorkloadScope,bool ScopeMayBeTruncated,
    IReadOnlyList<SupportRoutingCandidate> Candidates,IReadOnlyList<SupportEscalationTarget> EscalationTargets,string Explanation);
public record ConfirmSupportAssignmentRequest(int TicketVersion,int WorkVersion,Guid AssigneeId,bool Confirmed);

/// <summary>Deterministic suggestions, with no inference or automatic writes. Workload visibility stays authoritative.</summary>
public class SupportRoutingService(IAppDbContext db,ICurrentContext ctx,SupportService support,WorkTaskService work,
    WorkloadService workload,PermissionService permissions,Recorder recorder)
{
    private async Task<SupportTicketDto> RequireAsync(Guid id,CancellationToken ct)
    {
        var ticket=await support.GetAsync(id,ct);
        if(!ticket.Staff)throw new ForbiddenException("Only support staff can review routing.");
        await permissions.RequireAsync(Permissions.WorkEdit,ct);
        if(ticket.State is "resolved" or "closed" or "cancelled" or "merged")
            throw new ConflictException("Reopen the ticket before reviewing its assignment.");
        return ticket;
    }
    public async Task<SupportRoutingPreview> PreviewAsync(Guid id,CancellationToken ct)
    {
        var ticket=await RequireAsync(id,ct);var tid=ctx.RequireTenantId();
        var available=await workload.AvailableAsync(ct);
        var scope=available.Contains(WorkloadScope.Everyone)?WorkloadScope.Everyone:
            available.Contains(WorkloadScope.Reports)?WorkloadScope.Reports:WorkloadScope.Me;
        var view=await workload.GetAsync(scope,ct);
        var ids=view.Members.Select(m=>m.UserId).ToArray();
        // TenantMember deliberately does not have a tenant query filter: always bind this join explicitly.
        var people=await (from m in db.TenantMembers.AsNoTracking()
                          join u in db.Users.AsNoTracking() on m.UserId equals u.Id
                          where m.TenantId==tid&&ids.Contains(m.UserId)&&u.IsActive&&m.Role!=TenantRole.Guest
                          select new{m.UserId,m.WeeklyCapacityMinutes,m.ReportsToUserId,u.DisplayName}).ToListAsync(ct);
        var eligible=people.Where(p=>(p.WeeklyCapacityMinutes==null||p.WeeklyCapacityMinutes>0)).Select(p=>p.UserId).ToHashSet();
        if(ticket.TeamId is {} team){
            var members=await db.TeamMembers.Where(m=>m.TeamId==team).Select(m=>m.UserId).ToListAsync(ct);
            eligible.IntersectWith(members);
        }
        var projectEligible=people.Select(p=>p.UserId).ToHashSet();
        // Conservative project eligibility: explicit ownership, membership or project-team membership.
        // Workspace-wide visibility does not substitute for a verified relationship in routing.
        if(ticket.Work.RelatedProject is {} project){
            var row=await db.Projects.AsNoTracking().SingleAsync(p=>p.Id==project.Id,ct);
            var related=await db.ProjectMembers.Where(m=>m.ProjectId==project.Id).Select(m=>m.UserId).ToListAsync(ct);
            related.Add(row.OwnerId);
            if(row.TeamId is {} projectTeam)related.AddRange(await db.TeamMembers.Where(m=>m.TeamId==projectTeam).Select(m=>m.UserId).ToListAsync(ct));
            eligible.IntersectWith(related);projectEligible.IntersectWith(related);
        }
        var indexed=people.ToDictionary(p=>p.UserId);
        var candidates=view.Members.Where(m=>eligible.Contains(m.UserId))
            .OrderBy(m=>m.Open).ThenBy(m=>m.Overdue).ThenBy(m=>m.UserId)
            .Take(10).Select(m=>new SupportRoutingCandidate(m.UserId,m.Name,m.Open,m.Overdue,indexed[m.UserId].WeeklyCapacityMinutes)).ToArray();
        var targets=new List<SupportEscalationTarget>();var visited=new HashSet<Guid>();
        void Add(Guid user,string basis){
            if(user!=ticket.Work.Assignee?.Id&&projectEligible.Contains(user)&&indexed.TryGetValue(user,out var p)&&(p.WeeklyCapacityMinutes==null||p.WeeklyCapacityMinutes>0)&&visited.Add(user))
                targets.Add(new(user,p.DisplayName,basis));
        }
        if(ticket.TeamId is {} supportTeam){
            var leads=await db.TeamMembers.Where(m=>m.TeamId==supportTeam&&m.IsLead).OrderBy(m=>m.UserId).Select(m=>m.UserId).ToListAsync(ct);
            foreach(var lead in leads.Take(3))Add(lead,"Support team lead");
        }
        var cursor=ticket.Work.Assignee?.Id;
        var chain=new HashSet<Guid>();
        for(var depth=0;depth<3&&cursor is {} person&&chain.Add(person);depth++){
            if(!indexed.TryGetValue(person,out var member)||member.ReportsToUserId is not {} manager)break;
            if(manager==ticket.Work.Assignee?.Id)break;
            Add(manager,"Recorded manager, level "+(depth+1));cursor=manager;
        }
        return new(ticket.Version,ticket.Work.Version,scope.ToString(),scope==WorkloadScope.Everyone&&view.Members.Count>=1000,
            candidates,targets.Take(6).ToArray(),
            candidates.Length==0?"No eligible candidate in your authorized workload scope. Keep the current owner or use a reviewed human handoff.":
            "Ranked by visible open work, then overdue work. Weekly capacity is configured planning data; live availability and task effort are unknown. Assignment requires confirmation.");
    }
    public async Task<SupportTicketDto> AssignAsync(Guid id,ConfirmSupportAssignmentRequest req,CancellationToken ct)
    {
        if(!req.Confirmed)throw new ValidationException("confirmed","Review and explicitly confirm the assignment.");
        await using var tx=await db.Database.BeginOwnedTransactionAsync(ct);
        var preview=await PreviewAsync(id,ct);
        if(preview.TicketVersion!=req.TicketVersion||preview.WorkVersion!=req.WorkVersion)
            throw new ConflictException("The reviewed ticket changed. Reload routing before confirming.");
        if(!preview.Candidates.Any(p=>p.UserId==req.AssigneeId))
            throw new ConflictException("That candidate is no longer eligible. Reload routing before confirming.");
        var locked=await db.SupportTickets.Where(t=>t.Id==id&&t.Version==req.TicketVersion)
            .ExecuteUpdateAsync(s=>s.SetProperty(t=>t.Version,t=>t.Version),ct);
        if(locked!=1)throw new ConflictException("The reviewed ticket changed. Reload routing before confirming.");
        var ticket=await support.GetAsync(id,ct);var w=ticket.Work;
        await work.UpdateAsync(w.Id,new(w.Title,w.Description,w.WorkTypeId,w.RelatedProject?.Id,req.AssigneeId,w.Priority,w.Status,w.StartDate,w.DueDate,req.WorkVersion),ct);
        recorder.Audit("support.routing_confirmed","SupportTicket",id,null,new{req.AssigneeId,req.TicketVersion,req.WorkVersion});
        await db.SaveChangesAsync(ct);await tx.CommitIfOwnedAsync(ct);
        return await support.GetAsync(id,ct);
    }
}