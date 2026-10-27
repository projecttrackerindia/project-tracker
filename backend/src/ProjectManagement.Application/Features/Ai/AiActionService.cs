using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Application.Features.Mailbox;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Ai;

public record AiAgentActionDto(Guid Id, string Agent, string AgentName, string Action, string TargetType, Guid? TargetId, string? TargetKey, Guid? ProjectId, string Title,
    string Status, Guid? ApprovedBy, DateTime? At, DateTime CreatedAt, string? Error, string? Link);

/// <summary>
/// Deciding an agent's "Ask first" row from the Home inbox: approving carries it out as the person approving, through the same services the
/// screens use (so every rule and permission still applies), and the row becomes the AI action log entry {agent, action, target, approvedBy,
/// at}. A failure is kept on the row (the inbox shows why) and reported. Only the person the row is for may decide it.
/// </summary>
public class AiActionService(IAppDbContext db, ICurrentContext ctx, AppClock clock, AiActionLog log, WorkTaskService work, NotetakerService notetaker,
    MailboxAgent mail, TimesheetHelper timesheet)
{
    public static AiAgentActionDto ToDto(AiAgentAction a) => new(a.Id, a.Agent, AiAgents.Name(a.Agent), a.Action, a.TargetType, a.TargetId, a.TargetKey, a.ProjectId, a.Title,
        a.Status, a.ApprovedBy, a.At, a.CreatedAt, a.Error, a.Link);

    private async Task<AiAgentAction> DecidableAsync(Guid id, CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var row = await db.AiAgentActions.FirstOrDefaultAsync(a => a.Id == id, ct) ?? throw new NotFoundException("That suggestion was not found.", "AI_ACTION_NOT_FOUND");
        if (row.ForUserId != me) throw new ForbiddenException("This suggestion is for someone else to decide.", "PERMISSION_DENIED");
        if (row.Status is not ("proposed" or "failed")) throw new ConflictException("This suggestion was already decided.", "AI_ACTION_DECIDED");
        return row;
    }

    public async Task<AiAgentActionDto> ApproveAsync(Guid id, CancellationToken ct = default)
    {
        var row = await DecidableAsync(id, ct);
        var me = ctx.RequireUserId();
        bool loggedItself;
        try { loggedItself = await CarryOutAsync(row, me, ct); }
        catch (AppException ex)
        {
            AgentDb.ClearTracking(db);
            var failed = await db.AiAgentActions.FirstAsync(a => a.Id == id, ct);
            failed.Status = "failed"; failed.Error = Text.Truncate(ex.Message, 500); failed.UpdatedAt = clock.Now; failed.UpdatedBy = me;
            await db.SaveChangesAsync(ct);
            throw;
        }
        var done = await db.AiAgentActions.FirstAsync(a => a.Id == id, ct);
        done.Status = "applied"; done.ApprovedBy = me; done.At = clock.Now; done.Error = null; done.UpdatedAt = clock.Now; done.UpdatedBy = me;
        // A row whose work wrote its own log entries (each task made from the minutes, the ticket made from the mail) is not shown twice.
        if (!loggedItself) log.Activity(done);
        await db.SaveChangesAsync(ct);
        return ToDto(done);
    }

    public async Task<AiAgentActionDto> DismissAsync(Guid id, CancellationToken ct = default)
    {
        var row = await DecidableAsync(id, ct);
        row.Status = "dismissed"; row.At = clock.Now; row.UpdatedAt = clock.Now; row.UpdatedBy = ctx.RequireUserId();
        await db.SaveChangesAsync(ct);
        return ToDto(row);
    }

    /// <summary>Carries the row out. True when the work logged its own entries in the AI action log.</summary>
    private async Task<bool> CarryOutAsync(AiAgentAction row, Guid me, CancellationToken ct)
    {
        switch (row.Agent)
        {
            case AiAgents.Triage:
            {
                var p = AiActionLog.Read<TicketTriage.Proposal>(row) ?? throw new ConflictException("This suggestion cannot be read any more.", "AI_ACTION_UNREADABLE");
                var id = row.TargetId ?? throw new ConflictException("The ticket is gone.", "AI_ACTION_UNREADABLE");
                var t = await work.GetAsync(id, ct);
                await work.UpdateAsync(id, new UpdateWorkTaskRequest(t.Title, t.Description, t.WorkTypeId, t.RelatedProject?.Id, p.AssigneeId ?? t.Assignee?.Id,
                    p.Priority ?? t.Priority, t.Status, t.StartDate, t.DueDate, t.Version), ct);
                return false;
            }
            case AiAgents.Notetaker:
            {
                var p = AiActionLog.Read<NotetakerService.TasksProposal>(row) ?? throw new ConflictException("This suggestion cannot be read any more.", "AI_ACTION_UNREADABLE");
                if (await notetaker.ApplyTasksAsync(p, me, ct) == 0) throw new ConflictException("None of the tasks could be created.", "NOTHING_CREATED");
                return true;
            }
            case AiAgents.Mail:
            {
                var s = AiActionLog.Read<MailTaskSuggestion>(row) ?? throw new ConflictException("This suggestion cannot be read any more.", "AI_ACTION_UNREADABLE");
                var target = await mail.ApplyAsync(s, me, ct);
                row.TargetId ??= target;
                return true;
            }
            case AiAgents.Timesheet:
            {
                var p = AiActionLog.Read<TimesheetHelper.Proposal>(row) ?? throw new ConflictException("This suggestion cannot be read any more.", "AI_ACTION_UNREADABLE");
                await timesheet.ApplyAsync(p, ct);
                return false;
            }
            default:
                throw new ConflictException("This suggestion cannot be carried out here.", "AI_ACTION_UNREADABLE");
        }
    }
}
