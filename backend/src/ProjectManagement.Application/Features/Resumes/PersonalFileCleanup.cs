using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Resumes;

public class PersonalFileCleanup(IAppDbContext db, IFileStorage storage, AppClock clock, ILogger<PersonalFileCleanup> log)
{
    // Call before saving the corresponding pointer removal: both changes commit together.
    public void Enqueue(string storageKey)
    {
        if(!IsPersonalKey(storageKey))throw new InvalidOperationException("Invalid personal-file cleanup key.");
        db.PersonalFileDeletions.Add(new(){StorageKey=storageKey,CreatedAt=clock.Now,AvailableAt=clock.Now});
    }

    public async Task<int> PurgeAsync(CancellationToken ct=default)
    {
        // Trusted maintenance metadata only. There is no content retrieval or user impersonation.
        var due=await db.PersonalFileDeletions.AsNoTracking().Where(d=>d.AvailableAt<=clock.Now)
            .OrderBy(d=>d.AvailableAt).Take(50).ToListAsync(ct);
        var deleted=0;
        foreach(var receipt in due)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                if(!IsPersonalKey(receipt.StorageKey))throw new InvalidOperationException("Invalid personal-file cleanup key.");
                await storage.DeleteAsync(receipt.StorageKey,ct);
                // Storage deletion is idempotent; concurrent workers can safely repeat it.
                deleted+=await db.PersonalFileDeletions.Where(d=>d.Id==receipt.Id).ExecuteDeleteAsync(ct);
            }
            catch(Exception ex)when(ex is not OperationCanceledException)
            {
                var retryAt=clock.Now.AddMinutes(Math.Min(1440,Math.Pow(2,Math.Min(receipt.Attempts,10))));
                await db.PersonalFileDeletions.Where(d=>d.Id==receipt.Id)
                    .ExecuteUpdateAsync(s=>s.SetProperty(d=>d.Attempts,d=>d.Attempts+1).SetProperty(d=>d.AvailableAt,retryAt),ct);
                log.LogWarning("Personal file cleanup {ReceiptId} will retry after {ErrorType}",receipt.Id,ex.GetType().Name);
            }
        }
        return deleted;
    }

    private static bool IsPersonalKey(string key)
    {
        var parts=key.Split('/');
        if(parts.Length is <3 or >4||parts.Any(p=>p.Length!=32&&!IsPrefix(p)))return false;
        if(!IsPrefix(parts[0]))return false;
        return parts.Skip(1).All(p=>Guid.TryParseExact(p,"N",out _));
    }
    private static bool IsPrefix(string value)=>value is "resumes" or "certificates" or "resume-exports";
}