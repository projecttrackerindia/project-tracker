using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.SupportWorkflows;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
namespace ProjectManagement.Application.Features.Support;

// Operational work remains authoritative, including updates made outside the support screen.
public class SupportWorkBridge(IAppDbContext db,SupportWorkflowEmitter workflows)
{
    public async Task SyncAsync(WorkTask work,WorkTaskStatus previous,bool reassigned,bool reprioritized,CancellationToken ct)
    {
        var ticket=await db.SupportTickets.FirstOrDefaultAsync(t=>t.WorkTaskId==work.Id,ct);
        if(ticket is null)return;
        ticket.Version++;
        if(work.Status==WorkTaskStatus.Completed)ticket.State="resolved";
        else if(work.Status==WorkTaskStatus.Cancelled){if(ticket.State!="merged")ticket.State="cancelled";}
        else if(previous!=work.Status)
        {
            ticket.State=work.Status==WorkTaskStatus.OnHold?"waiting":"open";
            ticket.MergedIntoId=null;ticket.HandoffReason="";
        }
        var key=ticket.Id.ToString("N")+":"+work.Version;
        if(previous!=work.Status)await workflows.EmitAsync(ticket.Id,"state_changed",key,ct);
        if(reassigned)await workflows.EmitAsync(ticket.Id,"assignment_changed",key,ct);
        if(reprioritized)await workflows.EmitAsync(ticket.Id,"priority_changed",key,ct);
    }
}