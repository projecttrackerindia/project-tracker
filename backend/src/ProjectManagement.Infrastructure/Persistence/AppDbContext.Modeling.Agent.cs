using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Infrastructure.Persistence;

public partial class AppDbContext
{
    /// <summary>The project agent: its settings, what it read, what it found, and the live meeting bot.</summary>
    private static void ConfigureAgent(ModelBuilder b)
    {
        b.Entity<ProjectAgentSettings>(e =>
        {
            e.HasIndex(x => x.ProjectId).IsUnique();
            e.HasIndex(x => x.MailboxToken).IsUnique();
            e.Property(x => x.MailboxToken).HasMaxLength(24);
            e.Property(x => x.RunMonth).HasMaxLength(7);
            e.Property(x => x.DailySentDay).HasMaxLength(8);
            e.Property(x => x.LastError).HasMaxLength(500);
            e.Property(x => x.Instructions).HasMaxLength(4000);
            e.Property(x => x.SpeakerAliases).HasMaxLength(4000);
            e.Property(x => x.CaptionLanguage).HasMaxLength(16);
            e.Property(x => x.SlackChannelId).HasMaxLength(32);
            e.Property(x => x.SlackReadUntil).HasMaxLength(32);
            e.Property(x => x.AutoApplyKinds).HasMaxLength(200);
            e.Property(x => x.AutonomyHintsDismissed).HasMaxLength(200);
        });
        b.Entity<AgentSignal>(e =>
        {
            e.HasIndex(x => new { x.ProjectId, x.Source, x.SourceRef }).IsUnique();
            e.HasIndex(x => new { x.ProjectId, x.ProcessedAt });
            e.Property(x => x.SourceRef).HasMaxLength(300);
            e.Property(x => x.Title).HasMaxLength(300);
            e.Property(x => x.FromName).HasMaxLength(200);
            e.Property(x => x.ContentProtected).HasColumnType("text");
        });
        b.Entity<AgentRun>(e =>
        {
            e.HasIndex(x => new { x.ProjectId, x.StartedAt });
            e.Property(x => x.Trigger).HasMaxLength(16);
            e.Property(x => x.Status).HasMaxLength(16);
            e.Property(x => x.Summary).HasMaxLength(4000);
            e.Property(x => x.Error).HasMaxLength(500);
        });
        b.Entity<AgentFinding>(e =>
        {
            e.HasIndex(x => new { x.ProjectId, x.Status, x.CreatedAt });
            e.HasIndex(x => x.RunId);
            e.HasIndex(x => x.AssigneeId);
            e.Property(x => x.Title).HasMaxLength(300);
            e.Property(x => x.Detail).HasMaxLength(4000);
            e.Property(x => x.Evidence).HasMaxLength(2000);
            e.Property(x => x.SourceLabel).HasMaxLength(200);
            e.Property(x => x.NewStatus).HasMaxLength(32);
            e.Property(x => x.Comment).HasMaxLength(4000);
            e.Property(x => x.AppliedKey).HasMaxLength(40);
            e.Property(x => x.Error).HasMaxLength(500);
            e.Property(x => x.Edits).HasMaxLength(500);
            e.Property(x => x.OriginalTitle).HasMaxLength(300);
            e.Property(x => x.OwnerResponse).HasMaxLength(16);
            e.Property(x => x.OwnerNote).HasMaxLength(500);
            e.Property(x => x.Before).HasMaxLength(500);
            e.Property(x => x.DismissReason).HasMaxLength(32);
            e.HasIndex(x => new { x.ProjectId, x.Kind, x.Status });
        });
        b.Entity<AgentCommitment>(e =>
        {
            e.HasIndex(x => new { x.ProjectId, x.Status, x.DueDate });
            e.HasIndex(x => new { x.OwnerUserId, x.Status });
            e.HasIndex(x => x.FindingId);
            e.Property(x => x.EntityKey).HasMaxLength(40);
            e.Property(x => x.Title).HasMaxLength(300);
            e.Property(x => x.Quote).HasMaxLength(400);
            e.Property(x => x.SourceLabel).HasMaxLength(200);
            e.Property(x => x.Status).HasMaxLength(16);
            e.Property(x => x.CheckInAnswer).HasMaxLength(16);
            e.Property(x => x.CheckInNote).HasMaxLength(500);
        });
        b.Entity<AgentDelegation>(e =>
        {
            e.HasIndex(x => new { x.MeetingId, x.SessionStartUtc, x.UserId }).IsUnique();
            e.HasIndex(x => new { x.UserId, x.SessionStartUtc });
            e.HasIndex(x => new { x.ProjectId, x.Status });
            e.Property(x => x.Status).HasMaxLength(16);
            e.Property(x => x.Instructions).HasMaxLength(1000);
            e.Property(x => x.Note).HasMaxLength(500);
        });
        b.Entity<AgentPersonalSettings>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId }).IsUnique();
        });
        b.Entity<AgentWorkspaceSettings>(e =>
        {
            e.HasIndex(x => x.TenantId).IsUnique();
            e.Property(x => x.RecallApiKeyProtected).HasColumnType("text");
            e.Property(x => x.RecallRegion).HasMaxLength(32);
            e.Property(x => x.BotName).HasMaxLength(100);
        });
        b.Entity<AgentMeetingBot>(e =>
        {
            e.HasIndex(x => new { x.MeetingId, x.SessionStartUtc, x.Kind }).IsUnique();
            e.Property(x => x.Kind).HasMaxLength(16);
            e.HasIndex(x => x.WebhookToken).IsUnique();
            e.HasIndex(x => x.Status);
            e.Property(x => x.BotId).HasMaxLength(100);
            e.Property(x => x.Status).HasMaxLength(16);
            e.Property(x => x.WebhookToken).HasMaxLength(32);
            e.Property(x => x.TranscriptProtected).HasColumnType("text");
            e.Property(x => x.NudgesSent).HasColumnType("text");
            e.Property(x => x.Error).HasMaxLength(500);
            e.Property(x => x.CalendarEventId).HasMaxLength(200);
            e.Property(x => x.Title).HasMaxLength(300);
            e.Property(x => x.MeetUrl).HasMaxLength(300);
            e.Property(x => x.WorkerId).HasMaxLength(100);
            e.Property(x => x.WorkerStatus).HasMaxLength(32);
            e.Property(x => x.PendingChat).HasColumnType("text");
            e.Property(x => x.JoinPayload).HasColumnType("text");
            e.HasIndex(x => new { x.Kind, x.Status, x.SessionStartUtc });
        });
        b.Entity<AgentBotWorker>(e =>
        {
            e.HasIndex(x => x.WorkerKey).IsUnique();
            e.HasIndex(x => x.LastSeenAt);
            e.Property(x => x.WorkerKey).HasMaxLength(100);
            e.Property(x => x.Host).HasMaxLength(200);
            e.Property(x => x.Version).HasMaxLength(40);
        });
        b.Entity<AgentInboxOptIn>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId }).IsUnique();
            e.Property(x => x.Provider).HasMaxLength(16);
            e.Property(x => x.LastError).HasMaxLength(500);
        });
    }
}
