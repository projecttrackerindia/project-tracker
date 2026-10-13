using Microsoft.EntityFrameworkCore;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Projects;

public partial class ProjectService
{
    private static IReadOnlyList<StageScheduleInput> ScheduleInputs(IEnumerable<ProjectStage> stages) => stages.Select(s =>
        new StageScheduleInput(s.Id, s.Name, s.DurationDays, s.PlannedStart, s.PlannedEnd, s.Status == StageStatus.Completed)).ToList();

    private StageSchedulePreview ApplyCalculatedSchedule(Project project, IReadOnlyList<ProjectStage> stages,
        int fromIndex = 0, DateOnly? anchorStart = null, bool alignFinish = false, DateOnly? originStart = null)
    {
        var preview = StageScheduler.Calculate(project.Version, project.StageScheduleMode, project.StartDate, project.DueDate,
            ScheduleInputs(stages), fromIndex, anchorStart, alignFinish, originStart);
        foreach (var row in preview.Stages)
        {
            var stage = stages.Single(s => s.Id == row.Id);
            if (row.Changed) recorder.Activity("project.stage_dates_changed", "Project", project.Id,
                $"Stage \"{stage.Name}\" planned dates: {stage.PlannedStart:yyyy-MM-dd}–{stage.PlannedEnd:yyyy-MM-dd} → {row.Start:yyyy-MM-dd}–{row.End:yyyy-MM-dd}", project.Id);
            stage.PlannedStart = row.Start; stage.PlannedEnd = row.End; stage.DurationDays = row.DurationDays;
        }
        project.DueDate = preview.DueDate;
        return preview;
    }

    private void FinishStageSchedule(Project project, IReadOnlyList<ProjectStage> stages, int fromIndex,
        DateOnly? anchorStart, string? reason)
    {
        if (project.StageScheduleMode == StageScheduleMode.Manual) return;
        var oldDue = project.DueDate;
        ApplyCalculatedSchedule(project, stages, fromIndex, anchorStart);
        var note = DueDateHistory.Prepare(oldDue, project.DueDate, reason, null);
        if (note is not null) dueHistory.Record(project.TenantId, project.Id, null, oldDue, project.DueDate, note);
        project.Version++;
        recorder.Audit("project.schedule_recalculated", "Project", project.Id, newValue: new { project.StartDate, project.DueDate, project.StageScheduleMode });
    }

    private static void RequireScheduleVersion(Project project, int? expected)
    {
        if (expected is { } version && project.Version != version)
            throw new ConflictException("The project schedule changed. Reload and review the latest dates before saving.", "VERSION_CONFLICT");
    }

    private async Task<(Project Project, List<ProjectStage> Stages, StageSchedulePreview Preview)> PrepareScheduleAsync(Guid id, ProjectScheduleRequest req, CancellationToken ct)
    {
        var project = await access.GetProjectAsync(id, ct);
        await access.RequireProjectEditAsync(project, ct);
        RequireScheduleVersion(project, req.Version);
        var stages = await db.ProjectStages.Where(s => s.ProjectId == id).OrderBy(s => s.Order).ToListAsync(ct);
        var fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new {
            project.Version, project.StartDate, project.DueDate, project.StageScheduleMode,
            Stages = stages.Select(s => new { s.Id, s.Name, s.Order, s.Status, s.PlannedStart, s.PlannedEnd, s.DurationDays })
        }))));
        if (req.ExpectedFingerprint is not null && req.ExpectedFingerprint != fingerprint)
            throw new ConflictException("The stages changed after your preview. Preview the current schedule before applying it.", "VERSION_CONFLICT");
        if (req.Durations is null || req.Durations.Count != stages.Count || req.Durations.Select(s => s.Id).Distinct().Count() != stages.Count || stages.Any(s => !req.Durations.Any(d => d.Id == s.Id)))
            throw new ValidationException("durations", "Supply every stage's allocated duration exactly once.");
        var inputs = ScheduleInputs(stages).Select(s =>
        {
            var days = req.Durations.Single(d => d.Id == s.Id).DurationDays;
            if (s.Completed && days != (StageScheduler.Duration(s.DurationDays, s.Start, s.End) ?? 0))
                throw new ValidationException("durations", $"Completed stage '{s.Name}' is protected; its allocated duration cannot change automatically.");
            return s with { DurationDays = days };
        }).ToList();
        var preview = StageScheduler.Calculate(project.Version, req.Mode, req.StartDate, req.DueDate, inputs,
            alignFinish: req.Mode == StageScheduleMode.FollowSchedule && req.DueDate != project.DueDate) with { Fingerprint = fingerprint };
        return (project, stages, preview);
    }

    public async Task<StageSchedulePreview> PreviewScheduleAsync(Guid id, ProjectScheduleRequest req, CancellationToken ct = default) =>
        (await PrepareScheduleAsync(id, req, ct)).Preview;

    public async Task<ProjectDetailDto> SaveScheduleAsync(Guid id, ProjectScheduleRequest req, CancellationToken ct = default)
    {
        await using var tx = await db.Database.BeginOwnedTransactionAsync(ct);
        var (project, stages, preview) = await PrepareScheduleAsync(id, req, ct);
        var oldDue = project.DueDate;
        var note = DueDateHistory.Prepare(oldDue, preview.DueDate, req.Reason, null);
        project.StageScheduleMode = req.Mode; project.StartDate = preview.StartDate; project.DueDate = preview.DueDate;
        foreach (var row in preview.Stages)
        {
            var stage = stages.Single(s => s.Id == row.Id);
            stage.DurationDays = row.DurationDays; stage.PlannedStart = row.Start; stage.PlannedEnd = row.End;
        }
        project.Version++;
        if (note is not null) dueHistory.Record(project.TenantId, id, null, oldDue, preview.DueDate, note);
        recorder.Activity("project.schedule_recalculated", "Project", id, $"Scheduled {stages.Count} stages of \"{project.Name}\"; finish {preview.FinishDate:yyyy-MM-dd}, end {preview.DueDate:yyyy-MM-dd} ({req.Mode}).", id);
        recorder.Audit("project.schedule_recalculated", "Project", id, newValue: preview);
        await db.SaveChangesAsync(ct); await tx.CommitIfOwnedAsync(ct);
        return await BuildDetailAsync(project, ct);
    }
}
