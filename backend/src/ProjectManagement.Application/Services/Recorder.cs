using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Services;

/// <summary>Writes business activity and security audit records in the same unit of work as the operation.</summary>
public class Recorder(IAppDbContext db, ICurrentContext ctx, AppClock clock)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public void Activity(string action, string entityType, Guid? entityId, string summary,
        Guid? projectId = null, string? oldValue = null, string? newValue = null)
    {
        db.Activities.Add(new Activity
        {
            TenantId = ctx.RequireTenantId(),
            ProjectId = projectId,
            ActorId = ctx.UserId,
            Action = action,
            EntityType = entityType,
            EntityId = entityId,
            Summary = Text.Truncate(summary, 500)!,
            OldValue = Text.Truncate(oldValue, 500),
            NewValue = Text.Truncate(newValue, 500),
            IpAddress = ctx.IpAddress,
            CreatedAt = clock.Now,
        });
    }

    public void Audit(string action, string entityType, Guid? entityId = null, object? oldValue = null,
        object? newValue = null, Guid? tenantId = null, Guid? userId = null)
    {
        db.AuditLogs.Add(new AuditLog
        {
            TenantId = tenantId ?? ctx.TenantId,
            UserId = userId ?? ctx.UserId,
            Action = action,
            EntityType = entityType,
            EntityId = entityId,
            OldValue = Serialize(oldValue),
            NewValue = Serialize(newValue),
            IpAddress = ctx.IpAddress,
            UserAgent = Text.Truncate(ctx.UserAgent, 300),
            CreatedAt = clock.Now,
        });
    }

    private static string? Serialize(object? value) => value switch
    {
        null => null,
        string s => Text.Truncate(s, 2000),
        _ => Text.Truncate(JsonSerializer.Serialize(value, Json), 2000),
    };
}
