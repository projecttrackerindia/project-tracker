using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Billing;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Persistence;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public class CertificationPrivacyTests(ApiFactory factory)
{
    [Fact]
    public async Task Badges_are_opt_in_and_never_expose_private_credentials_or_files()
    {
        var owner=await TestClient.RegisterAsync(factory);await owner.CreateOrgAsync();await owner.UpgradeAsync("BUSINESS");
        var member=await owner.AddMemberAsync(factory,TenantRole.Member,"Certificate owner");
        var outsider=await TestClient.RegisterAsync(factory);await outsider.CreateOrgAsync();
        var guest=await owner.AddMemberAsync(factory,TenantRole.Guest,"Guest");
        var request=new{name="PMP",issuer="Issuer",issuedOn="2025-01-01",credentialId="private-credential",verificationUrl="https://example.com/private",showBadge=false,version=0};
        var created=await member.Post("/api/v1/me/certifications",request);Assert.True(created.Ok,created.ToString());
        var id=created.Data!["id"]!.GetValue<string>();
        var profile=$"/api/v1/workspace/members/{member.UserId}/profile";
        Assert.Empty((await owner.Get(profile)).Data!["certificationBadges"]!.AsArray());
        Assert.True((await member.Put($"/api/v1/me/certifications/{id}",new{request.name,request.issuer,request.issuedOn,request.credentialId,request.verificationUrl,showBadge=true,version=1})).Ok);
        var shared=await owner.Get(profile);Assert.True(shared.Ok,shared.ToString());
        var badge=Assert.Single(shared.Data!["certificationBadges"]!.AsArray());
        Assert.Equal("PMP",badge!["name"]!.GetValue<string>());Assert.Null(badge["credentialId"]);Assert.Null(badge["verificationUrl"]);Assert.Null(badge["attachmentStorageKey"]);
        Assert.Empty((await guest.Get(profile)).Data!["certificationBadges"]!.AsArray());
        Assert.Equal(HttpStatusCode.NotFound,(await outsider.Get(profile)).Status);
        var pdf=ProjectManagement.Application.Features.Resumes.ResumeFiles.Pdf(new("Certificate owner","","","Certificate",[]),ProjectManagement.Application.Features.Resumes.ResumeService.Templates[0],false);
        Assert.True((await member.Upload($"/api/v1/me/certifications/{id}/attachment?version=2","certificate.pdf",pdf)).Ok);
        var mine=await member.Get("/api/v1/me/certifications");var row=Assert.Single(mine.Data!.AsArray());
        Assert.True(row!["hasAttachment"]!.GetValue<bool>());Assert.Null(row["attachmentStorageKey"]);
        Assert.Equal(HttpStatusCode.NotFound,(await owner.Raw($"/api/v1/me/certifications/{id}/attachment")).StatusCode);
        using var downloaded=await member.Raw($"/api/v1/me/certifications/{id}/attachment");
        Assert.Equal(pdf,await downloaded.Content.ReadAsByteArrayAsync());
        Assert.True((await member.Delete($"/api/v1/me/certifications/{id}/attachment?version=3")).Ok);
        Assert.Equal(HttpStatusCode.NotFound,(await member.Raw($"/api/v1/me/certifications/{id}/attachment")).StatusCode);
    }

    [Fact]
    public async Task Expiry_reminders_are_deduplicated_and_delivered_only_to_the_personal_workspace()
    {
        var user=await TestClient.RegisterAsync(factory);await user.CreateOrgAsync();
        var today=factory.Services.GetRequiredService<AppClock>().Today;
        var record=await user.Post("/api/v1/me/certifications",new{name="Expiring private certificate",issuer="Issuer",issuedOn=today.AddYears(-1),expiresOn=today.AddDays(5),version=0});
        Assert.True(record.Ok,record.ToString());var id=record.Data!["id"]!.GetValue<Guid>();
        async Task Run(){using var scope=factory.Services.CreateScope();await scope.ServiceProvider.GetRequiredService<MaintenanceService>().SendCertificationExpiryAsync();}
        await Run();await Run();
        using var scope=factory.Services.CreateScope();var db=scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var messages=await db.Notifications.IgnoreQueryFilters().Where(n=>n.UserId==user.UserId&&n.Type==NotificationType.CertificationExpiry&&n.DedupeKey!.StartsWith($"cert-expiry:{id:N}:")).ToListAsync();
        var message=Assert.Single(messages);
        var personal=await db.Tenants.IgnoreQueryFilters().SingleAsync(t=>t.OwnerUserId==user.UserId&&t.Type==WorkspaceType.Personal);
        Assert.Equal(personal.Id,message.TenantId);Assert.False(message.EmailPending);
    }
}