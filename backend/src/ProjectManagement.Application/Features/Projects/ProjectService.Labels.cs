using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Projects;

public partial class ProjectService
{
    // ---------------------------------------------------------------- labels (workspace-wide)

    public async Task<IReadOnlyList<LabelDto>> GetLabelsAsync(CancellationToken ct = default) =>
        await db.Labels.AsNoTracking().OrderBy(l => l.Name).Select(l => new LabelDto(l.Id, l.Name, l.Color)).ToListAsync(ct);

    public async Task<LabelDto> CreateLabelAsync(UpsertLabelRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.LabelsManage, ct);
        var name = req.Name.Trim();
        if (await db.Labels.AnyAsync(l => l.Name.ToLower() == name.ToLower(), ct))
            throw new ConflictException("A label with this name already exists.", "LABEL_EXISTS");
        var label = new Label { TenantId = ctx.RequireTenantId(), Name = name, Color = req.Color ?? "#8b5cf6", CreatedAt = clock.Now };
        db.Labels.Add(label);
        await db.SaveChangesAsync(ct);
        return new LabelDto(label.Id, label.Name, label.Color);
    }

    public async Task<LabelDto> UpdateLabelAsync(Guid id, UpsertLabelRequest req, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.LabelsManage, ct);
        var label = await db.Labels.FirstOrDefaultAsync(l => l.Id == id, ct) ?? throw new NotFoundException("Label not found.");
        var name = req.Name.Trim();
        if (await db.Labels.AnyAsync(l => l.Id != id && l.Name.ToLower() == name.ToLower(), ct))
            throw new ConflictException("A label with this name already exists.", "LABEL_EXISTS");
        label.Name = name;
        if (req.Color is not null) label.Color = req.Color;
        await db.SaveChangesAsync(ct);
        return new LabelDto(label.Id, label.Name, label.Color);
    }

    public async Task DeleteLabelAsync(Guid id, CancellationToken ct = default)
    {
        await permissions.RequireAsync(Permissions.LabelsManage, ct);
        var label = await db.Labels.FirstOrDefaultAsync(l => l.Id == id, ct) ?? throw new NotFoundException("Label not found.");
        db.TaskLabels.RemoveRange(await db.TaskLabels.Where(l => l.LabelId == id).ToListAsync(ct));
        db.Labels.Remove(label);
        await db.SaveChangesAsync(ct);
    }
}
