using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
namespace ProjectManagement.Application.Features.SupportWorkflows;

// Durable event metadata shares the business transaction. Workflow actions suppress recursive trigger production.
public class SupportWorkflowEmitter(IAppDbContext db, ICurrentContext ctx, EntitlementService entitlements)
{
    public bool Suppressed { get; set; }
    public IDisposable Pause()
    {
        var previous=Suppressed;Suppressed=true;return new Restore(this,previous);
    }
    private sealed class Restore(SupportWorkflowEmitter owner,bool previous):IDisposable
    {
        private bool disposed;
        public void Dispose(){if(disposed)return;disposed=true;owner.Suppressed=previous;}
    }
    public async Task EmitAsync(Guid ticketId,string kind,string key,CancellationToken ct)
    {
        if(Suppressed || ctx.TenantId is null || await entitlements.GetValueAsync(FeatureKeys.Automation,ct)==0)return;
        var revisions=await db.SupportWorkflows.Where(w=>w.Enabled&&w.PublishedRevisionId!=null&&w.PublishedTrigger==kind).Select(w=>w.PublishedRevisionId!.Value).Take(30).ToListAsync(ct);
        if(revisions.Count==0)return;
        var eventKey=kind+":"+key;
        if(await db.SupportWorkflowEvents.AnyAsync(e=>e.RequestKey==eventKey,ct))return;
        db.SupportWorkflowEvents.Add(new(){TenantId=ctx.RequireTenantId(),TicketId=ticketId,Kind=kind,RequestKey=eventKey,RevisionIdsJson=JsonSerializer.Serialize(revisions)});
    }
}