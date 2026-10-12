using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Resumes;
using ProjectManagement.Application.Services;
using ProjectManagement.Infrastructure.Persistence;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public class PersonalFileCleanupTests(ApiFactory factory)
{
    [Fact]
    public async Task Removal_revokes_access_immediately_and_storage_failure_is_retried_durably()
    {
        var user=await TestClient.RegisterAsync(factory,"Private original");
        var original=ResumeFiles.Docx(new("Private original","Engineer","","Self supplied content",[]),ResumeService.Templates[0],false);
        var imported=await user.Upload("/api/v1/me/resumes/import","private.docx",original);
        Assert.True(imported.Ok,imported.ToString());var id=imported.Data!["id"]!.GetValue<Guid>();
        var key=factory.WithDb(db=>db.ResumeVersions.IgnoreQueryFilters().Single(v=>v.ResumeId==id).OriginalStorageKey!);
        Assert.True((await user.Delete($"/api/v1/me/resumes/{id}/versions/1/original")).Ok);
        using var denied=await user.Raw($"/api/v1/me/resumes/{id}/versions/1/original");
        Assert.Equal(HttpStatusCode.NotFound,denied.StatusCode);

        using var scope=factory.Services.CreateScope();
        var db=scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var storage=scope.ServiceProvider.GetRequiredService<IFileStorage>();
        var clock=scope.ServiceProvider.GetRequiredService<AppClock>();
        Assert.True(await storage.ExistsAsync(key));
        var failing=new PersonalFileCleanup(db,new UnavailableStorage(),clock,NullLogger<PersonalFileCleanup>.Instance);
        Assert.Throws<InvalidOperationException>(()=>failing.Enqueue("../unrelated-file"));
        await failing.PurgeAsync();
        var receipt=await db.PersonalFileDeletions.AsNoTracking().SingleAsync(d=>d.StorageKey==key);
        Assert.Equal(1,receipt.Attempts);Assert.True(receipt.AvailableAt>clock.Now);
        Assert.True(await storage.ExistsAsync(key));

        await db.PersonalFileDeletions.Where(d=>d.Id==receipt.Id).ExecuteUpdateAsync(s=>s.SetProperty(d=>d.AvailableAt,clock.Now));
        await scope.ServiceProvider.GetRequiredService<PersonalFileCleanup>().PurgeAsync();
        Assert.False(await storage.ExistsAsync(key));
        Assert.False(await db.PersonalFileDeletions.AnyAsync(d=>d.Id==receipt.Id));
        await scope.ServiceProvider.GetRequiredService<PersonalFileCleanup>().PurgeAsync();
        Assert.False(await storage.ExistsAsync(key));
    }

    private sealed class UnavailableStorage:IFileStorage
    {
        public string Name=>"unavailable";
        public Task DeleteAsync(string key,CancellationToken ct=default)=>throw new IOException("Temporary storage failure");
        public Task SaveAsync(string key,Stream content,CancellationToken ct=default)=>throw new NotSupportedException();
        public Task<Stream?> OpenReadAsync(string key,CancellationToken ct=default)=>throw new NotSupportedException();
        public Task<bool> ExistsAsync(string key,CancellationToken ct=default)=>throw new NotSupportedException();
    }
}