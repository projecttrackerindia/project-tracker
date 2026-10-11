using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Resumes;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Infrastructure.Persistence;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public class PersonalFileUploadTests(ApiFactory factory)
{
    private string Key(Guid user, string prefix="resumes") => prefix=="certificates"
        ? $"{prefix}/{user:N}/{Guid.NewGuid():N}/{Guid.NewGuid():N}"
        : $"{prefix}/{user:N}/{Guid.NewGuid():N}";

    private async Task<Guid> Prepare(string key)
    {
        using var scope=factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<PersonalFileUpload>().PrepareAsync(key);
    }
    private async Task Write(string key)
    {
        using var scope=factory.Services.CreateScope();
        await using var bytes=new MemoryStream([1,2,3]);
        await scope.ServiceProvider.GetRequiredService<IFileStorage>().SaveAsync(key,bytes);
    }
    private void Due(Guid id)=>factory.WithDb(db=>db.PersonalFileDeletions.Where(d=>d.Id==id)
        .ExecuteUpdate(s=>s.SetProperty(d=>d.AvailableAt,DateTime.UtcNow.AddMinutes(-1))));
    private async Task Purge()
    {
        using var scope=factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<PersonalFileCleanup>().PurgeAsync();
    }
    private async Task<bool> Exists(string key)
    {
        using var scope=factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<IFileStorage>().ExistsAsync(key);
    }
    private bool Receipt(Guid id)=>factory.WithDb(db=>db.PersonalFileDeletions.Any(d=>d.Id==id));
    private void Reference(AppDbContext db,Guid user,string key,string kind="resumes")
    {
        if(kind=="certificates")db.EmployeeCertifications.Add(new(){UserId=user,Name="Private credential",Issuer="Fixture",AttachmentStorageKey=key});
        else if(kind=="resume-exports")db.ResumeExportPurchases.Add(new(){UserId=user,ArtifactKey=key});
        else {
            var resume=new PersonalResume{UserId=user};db.PersonalResumes.Add(resume);
            db.ResumeVersions.Add(new(){UserId=user,ResumeId=resume.Id,Number=1,OriginalStorageKey=key});
        }
    }

    [Fact]
    public async Task Interrupted_upload_is_retained_for_its_window_then_reclaimed_from_an_independent_scope()
    {
        var key=Key(Guid.NewGuid());var id=await Prepare(key);await Write(key);
        await Purge();Assert.True(await Exists(key));Assert.True(Receipt(id));
        Due(id);await Purge();Assert.False(await Exists(key));Assert.False(Receipt(id));
        await Purge();Assert.False(await Exists(key));
    }

    [Fact]
    public async Task Pointer_publication_and_receipt_consumption_commit_together_and_survive_later_maintenance()
    {
        var user=await TestClient.RegisterAsync(factory,"Upload owner");var key=Key(user.UserId);var id=await Prepare(key);await Write(key);
        using(var scope=factory.Services.CreateScope()){
            var db=scope.ServiceProvider.GetRequiredService<AppDbContext>();await using var tx=await db.Database.BeginTransactionAsync();
            await PersonalFileUpload.CompleteAsync(db,id,key,DateTime.UtcNow,default);
            Reference(db,user.UserId,key);await db.SaveChangesAsync();await tx.CommitAsync();
        }
        Assert.False(Receipt(id));await Purge();Assert.True(await Exists(key));
    }

    [Fact]
    public async Task Database_rollback_restores_the_intent_and_does_not_leave_an_untracked_file()
    {
        var user=await TestClient.RegisterAsync(factory,"Rolled back upload");var key=Key(user.UserId);var id=await Prepare(key);await Write(key);
        using(var scope=factory.Services.CreateScope()){
            var db=scope.ServiceProvider.GetRequiredService<AppDbContext>();await using var tx=await db.Database.BeginTransactionAsync();
            await PersonalFileUpload.CompleteAsync(db,id,key,DateTime.UtcNow,default);
            Reference(db,user.UserId,key);await db.SaveChangesAsync();await tx.RollbackAsync();
        }
        Assert.True(Receipt(id));Assert.False(factory.WithDb(db=>db.ResumeVersions.IgnoreQueryFilters().Any(v=>v.OriginalStorageKey==key)));
        Due(id);await Purge();Assert.False(await Exists(key));Assert.False(Receipt(id));
    }

    [Theory][InlineData("resumes")][InlineData("certificates")][InlineData("resume-exports")]
    public async Task A_stale_cleanup_receipt_never_deletes_another_owners_referenced_file(string kind)
    {
        var user=await TestClient.RegisterAsync(factory,"Referenced private file");var key=Key(user.UserId,kind);var id=await Prepare(key);await Write(key);
        factory.WithDb(db=>{Reference(db,user.UserId,key,kind);db.SaveChanges();return 0;});
        Due(id);await Purge();Assert.True(await Exists(key));Assert.True(Receipt(id));
        var receipt=factory.WithDb(db=>db.PersonalFileDeletions.AsNoTracking().Single(d=>d.Id==id));
        Assert.True(receipt.AvailableAt>DateTime.UtcNow);Assert.Equal(0,receipt.Attempts);
    }

    [Fact]
    public async Task An_expired_uploader_cannot_publish_after_the_cleanup_deadline_or_after_deletion()
    {
        var key=Key(Guid.NewGuid());var id=await Prepare(key);await Write(key);Due(id);
        using(var scope=factory.Services.CreateScope()){
            var db=scope.ServiceProvider.GetRequiredService<IAppDbContext>();await using var tx=await db.Database.BeginTransactionAsync();
            await Assert.ThrowsAsync<ConflictException>(()=>PersonalFileUpload.CompleteAsync(db,id,key,DateTime.UtcNow,default));
        }
        await Purge();Assert.False(await Exists(key));
        using(var scope=factory.Services.CreateScope()){
            var db=scope.ServiceProvider.GetRequiredService<IAppDbContext>();await using var tx=await db.Database.BeginTransactionAsync();
            await Assert.ThrowsAsync<ConflictException>(()=>PersonalFileUpload.CompleteAsync(db,id,key,DateTime.UtcNow,default));
        }
    }

    [Fact]
    public async Task Publication_requires_a_transaction_and_one_valid_matching_receipt()
    {
        var key=Key(Guid.NewGuid());var id=await Prepare(key);
        using var scope=factory.Services.CreateScope();var db=scope.ServiceProvider.GetRequiredService<IAppDbContext>();
        await Assert.ThrowsAsync<InvalidOperationException>(()=>PersonalFileUpload.CompleteAsync(db,id,key,DateTime.UtcNow,default));
        await using(var tx=await db.Database.BeginTransactionAsync()){
            await Assert.ThrowsAsync<ConflictException>(()=>PersonalFileUpload.CompleteAsync(db,id,Key(Guid.NewGuid()),DateTime.UtcNow,default));
            await PersonalFileUpload.CompleteAsync(db,id,key,DateTime.UtcNow,default);
            await Assert.ThrowsAsync<ConflictException>(()=>PersonalFileUpload.CompleteAsync(db,id,key,DateTime.UtcNow,default));
            await tx.CommitAsync();
        }
        await Assert.ThrowsAsync<InvalidOperationException>(()=>scope.ServiceProvider.GetRequiredService<PersonalFileUpload>().PrepareAsync("resumes/../private"));
    }

    [Fact]
    public async Task The_real_import_endpoint_consumes_its_upload_intent_and_keeps_the_original_downloadable()
    {
        var user=await TestClient.RegisterAsync(factory,"Imported file owner");
        var bytes=ResumeFiles.Docx(new("Imported file owner","Engineer","","Supplied experience",[]),ResumeService.Templates[0],false);
        var result=await user.Upload("/api/v1/me/resumes/import","resume.docx",bytes);Assert.True(result.Ok,result.ToString());
        var resumeId=result.Data!["id"]!.GetValue<Guid>();
        var key=factory.WithDb(db=>db.ResumeVersions.IgnoreQueryFilters().Single(v=>v.ResumeId==resumeId).OriginalStorageKey!);
        Assert.False(factory.WithDb(db=>db.PersonalFileDeletions.Any(d=>d.StorageKey==key)));
        await Purge();Assert.True(await Exists(key));
        using var original=await user.Raw($"/api/v1/me/resumes/{resumeId}/versions/1/original");
        Assert.True(original.IsSuccessStatusCode);Assert.Equal(bytes,await original.Content.ReadAsByteArrayAsync());
    }
}
