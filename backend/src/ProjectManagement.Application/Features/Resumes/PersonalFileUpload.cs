using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Resumes;

/// <summary>Commit cleanup intent before touching storage. Publishing the pointer consumes it in the same transaction.</summary>
public class PersonalFileUpload(IServiceScopeFactory scopes, AppClock clock)
{
    public async Task<Guid> PrepareAsync(string key, CancellationToken ct = default)
    {
        if (!PersonalFileCleanup.IsPersonalKey(key)) throw new InvalidOperationException("Invalid personal upload key.");
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IAppDbContext>();
        var receipt = new PersonalFileDeletion { StorageKey = key, CreatedAt = clock.Now, AvailableAt = clock.Now.AddDays(1) };
        db.PersonalFileDeletions.Add(receipt);
        await db.SaveChangesAsync(ct);
        return receipt.Id;
    }

    public static async Task CompleteAsync(IAppDbContext db, Guid receipt, string key, DateTime now, CancellationToken ct)
    {
        if (db.Database.CurrentTransaction is null) throw new InvalidOperationException("Publishing an upload requires a transaction.");
        // A stale uploader cannot publish after maintenance has started removing its file.
        var claimed = await db.PersonalFileDeletions.Where(r => r.Id == receipt && r.StorageKey == key && r.AvailableAt > now && r.Attempts == 0)
            .ExecuteDeleteAsync(ct);
        if (claimed != 1) throw new ConflictException("This upload expired. Import the file again.", "PERSONAL_UPLOAD_EXPIRED");
    }
}
