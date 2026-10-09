using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Infrastructure.Persistence;

public partial class AppDbContext
{
    private static void ConfigureWork(ModelBuilder b)
    {
        b.Entity<Project>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Key });
            e.HasIndex(x => new { x.TenantId, x.Status });
            e.HasIndex(x => new { x.TenantId, x.DueDate });
            e.Property(x => x.Name).HasMaxLength(120);
            e.Property(x => x.Key).HasMaxLength(10);
            e.HasOne(x => x.Owner).WithMany().HasForeignKey(x => x.OwnerId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.Team).WithMany().HasForeignKey(x => x.TeamId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne(x => x.Group).WithMany().HasForeignKey(x => x.ProjectGroupId).OnDelete(DeleteBehavior.Restrict);
            e.HasIndex(x => x.ProjectGroupId);
            e.HasMany(x => x.Members).WithOne().HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
            e.HasMany(x => x.Statuses).WithOne().HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
            e.HasMany(x => x.Stages).WithOne().HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
            e.Property(x => x.Version).IsConcurrencyToken();
            e.Property(x => x.DeliveryMethod).HasDefaultValue(DeliveryMethod.Hybrid).HasSentinel(DeliveryMethod.Hybrid);
            e.Property(x => x.BudgetHours).HasPrecision(10, 2);
            e.Property(x => x.BudgetAmount).HasPrecision(14, 2);
            e.Property(x => x.BillRate).HasPrecision(12, 2);
        });
        b.Entity<ProjectMember>(e =>
        {
            e.HasIndex(x => new { x.ProjectId, x.UserId }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.UserId });
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<WorkflowStatus>(e => { e.HasIndex(x => new { x.ProjectId, x.Order }); e.Property(x => x.Name).HasMaxLength(40); e.Property(x => x.Color).HasMaxLength(9); });
        b.Entity<ProjectStage>(e => { e.HasIndex(x => new { x.ProjectId, x.Order }); e.Property(x => x.Name).HasMaxLength(80); });
        b.Entity<WorkType>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Order });
            e.HasIndex(x => new { x.TenantId, x.Name }).IsUnique();
            e.Property(x => x.Name).HasMaxLength(60);
            e.Property(x => x.Description).HasMaxLength(200);
        });
        b.Entity<WorkTask>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Number }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.Status, x.DueDate });
            e.HasIndex(x => new { x.TenantId, x.AssigneeId });
            e.HasIndex(x => new { x.TenantId, x.RelatedProjectId });
            e.HasIndex(x => new { x.TenantId, x.WorkTypeId });
            e.HasIndex(x => new { x.TenantId, x.Kind, x.RelatedProjectId });
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.Description).HasMaxLength(8000);
            e.Property(x => x.Kind).HasDefaultValue(WorkTaskKind.Operational).HasSentinel(WorkTaskKind.Operational);
            e.HasOne(x => x.WorkType).WithMany().HasForeignKey(x => x.WorkTypeId).OnDelete(DeleteBehavior.Restrict);
            // The SLA monitor looks for open work whose response or resolution time has run out.
            e.HasIndex(x => new { x.Status, x.ResolutionDueAt });
            e.HasIndex(x => new { x.Status, x.ResponseDueAt });
        });
        b.Entity<SlaPolicy>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.WorkTypeId, x.Priority });
            e.HasOne<WorkType>().WithMany().HasForeignKey(x => x.WorkTypeId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<WorkTaskComment>(e => { e.HasIndex(x => x.WorkTaskId); e.Property(x => x.Body).HasMaxLength(4000); });
        b.Entity<WorkTaskAttachment>(e => { e.HasIndex(x => x.WorkTaskId); e.Property(x => x.FileName).HasMaxLength(200); e.Property(x => x.ContentType).HasMaxLength(120); e.Property(x => x.StorageKey).HasMaxLength(200); e.Property(x => x.Sha256).HasMaxLength(64); });
        b.Entity<ProjectGroup>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Order });
            e.HasIndex(x => new { x.TenantId, x.Name }).IsUnique();
            e.Property(x => x.Name).HasMaxLength(60);
            e.Property(x => x.Description).HasMaxLength(200);
        });
        b.Entity<DueDateChange>(e =>
        {
            e.HasIndex(x => new { x.ProjectId, x.CreatedAt });
            e.HasIndex(x => x.TaskId);
            e.Property(x => x.Reason).HasMaxLength(500);
            e.Property(x => x.Dependency).HasMaxLength(300);
        });
        b.Entity<StageIssue>(e =>
        {
            e.HasIndex(x => new { x.ProjectId, x.Number }).IsUnique();
            e.HasIndex(x => new { x.ProjectId, x.StageId, x.Status });
            e.HasIndex(x => new { x.TenantId, x.AssigneeId });
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.Details).HasMaxLength(4000);
            e.HasOne<ProjectStage>().WithMany().HasForeignKey(x => x.StageId).OnDelete(DeleteBehavior.SetNull);   // the issue stays as history when its stage is deleted
        });
        b.Entity<StageIssueEvent>(e =>
        {
            e.HasIndex(x => x.IssueId);
            e.Property(x => x.Kind).HasMaxLength(20);
            e.Property(x => x.Note).HasMaxLength(1000);
            e.HasOne<StageIssue>().WithMany().HasForeignKey(x => x.IssueId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<CustomTimelineTemplate>(e => { e.HasIndex(x => x.TenantId); e.Property(x => x.Name).HasMaxLength(80); e.Property(x => x.Description).HasMaxLength(300); });
        b.Entity<Label>(e => { e.HasIndex(x => x.TenantId); e.Property(x => x.Name).HasMaxLength(40); e.Property(x => x.Color).HasMaxLength(9); });

        b.Entity<TaskItem>(e =>
        {
            e.ToTable("Tasks");
            e.HasIndex(x => new { x.ProjectId, x.Number }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.ProjectId });
            e.HasIndex(x => new { x.TenantId, x.AssigneeId });
            e.HasIndex(x => new { x.TenantId, x.DueDate });
            e.HasIndex(x => new { x.ProjectId, x.StatusId });
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.EstimatedHours).HasPrecision(9, 2);
            e.Property(x => x.ActualHours).HasPrecision(9, 2);
            e.Property(x => x.Version).IsConcurrencyToken();
            e.HasOne(x => x.Project).WithMany().HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Status).WithMany().HasForeignKey(x => x.StatusId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.Assignee).WithMany().HasForeignKey(x => x.AssigneeId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.Reporter).WithMany().HasForeignKey(x => x.ReporterId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.ParentTask).WithMany(x => x.Subtasks).HasForeignKey(x => x.ParentTaskId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne<Milestone>().WithMany().HasForeignKey(x => x.MilestoneId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne<Sprint>().WithMany().HasForeignKey(x => x.SprintId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne<ProjectStage>().WithMany().HasForeignKey(x => x.StageId).OnDelete(DeleteBehavior.SetNull);
            e.HasIndex(x => x.SprintId);
            e.HasIndex(x => x.StageId);
            e.HasMany(x => x.Labels).WithOne().HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
            e.HasMany(x => x.Comments).WithOne().HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<TaskDependency>(e =>
        {
            e.HasIndex(x => new { x.TaskId, x.DependsOnTaskId }).IsUnique();
            e.HasIndex(x => x.DependsOnTaskId);
            e.HasOne(x => x.Task).WithMany().HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.DependsOnTask).WithMany().HasForeignKey(x => x.DependsOnTaskId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<Milestone>(e =>
        {
            e.HasIndex(x => new { x.ProjectId, x.SortOrder });
            e.HasIndex(x => new { x.TenantId, x.DueDate });
            e.Property(x => x.Name).HasMaxLength(120);
            e.Property(x => x.Description).HasMaxLength(2000);
            e.HasOne(x => x.Owner).WithMany().HasForeignKey(x => x.OwnerId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne<ProjectStage>().WithMany().HasForeignKey(x => x.StageId).OnDelete(DeleteBehavior.SetNull);
            e.HasIndex(x => x.StageId);
        });
        b.Entity<Sprint>(e =>
        {
            e.HasIndex(x => new { x.ProjectId, x.Status });
            e.Property(x => x.Name).HasMaxLength(100);
            e.Property(x => x.Goal).HasMaxLength(500);
            e.HasOne<Project>().WithMany().HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<ReportExport>(e =>
        {
            e.HasIndex(x => new { x.UserId, x.CreatedAt });
            e.HasIndex(x => new { x.Status, x.CreatedAt });
            e.Property(x => x.FileName).HasMaxLength(200);
            e.Property(x => x.StorageKey).HasMaxLength(300);
            e.Property(x => x.Error).HasMaxLength(300);
        });
        b.Entity<ChecklistItem>(e =>
        {
            e.HasIndex(x => new { x.TaskId, x.Position });
            e.Property(x => x.Title).HasMaxLength(200);
            e.HasOne<TaskItem>().WithMany().HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<PrioritySetting>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Level }).IsUnique();
            e.Property(x => x.Name).HasMaxLength(20);
            e.Property(x => x.Color).HasMaxLength(7);
        });
        b.Entity<CustomFieldDefinition>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.SortOrder });
            e.Property(x => x.Name).HasMaxLength(40);
            e.Property(x => x.Options).HasMaxLength(2000);
        });
        b.Entity<CustomFieldValue>(e =>
        {
            e.HasIndex(x => new { x.TaskId, x.FieldId }).IsUnique();
            e.HasIndex(x => x.FieldId);
            e.Property(x => x.Value).HasMaxLength(500);
            e.HasOne<TaskItem>().WithMany().HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<CustomFieldDefinition>().WithMany().HasForeignKey(x => x.FieldId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<ApiKey>(e =>
        {
            e.HasIndex(x => x.Prefix).IsUnique();
            e.HasIndex(x => x.TenantId);
            e.Property(x => x.Name).HasMaxLength(60);
            e.Property(x => x.Prefix).HasMaxLength(20);
            e.Property(x => x.SecretHash).HasMaxLength(64);
            e.Property(x => x.LastUsedIp).HasMaxLength(64);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<Webhook>(e =>
        {
            e.HasIndex(x => x.TenantId);
            e.Property(x => x.Name).HasMaxLength(60);
            e.Property(x => x.Url).HasMaxLength(500);
            e.Property(x => x.SecretProtected).HasMaxLength(300);
            e.Property(x => x.Events).HasMaxLength(1000);
            e.Property(x => x.DisabledReason).HasMaxLength(200);
            e.Property(x => x.LastStatus).HasMaxLength(20);
            e.Property(x => x.Format).HasDefaultValue(WebhookFormat.Json).HasSentinel(WebhookFormat.Json);
        });
        b.Entity<CalendarFeed>(e =>
        {
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.UserId }).IsUnique();
            e.Property(x => x.TokenHash).HasMaxLength(64);
            e.Property(x => x.TokenProtected).HasMaxLength(300);
            e.Property(x => x.Prefix).HasMaxLength(16);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<InboundMailbox>(e =>
        {
            e.HasIndex(x => x.Token).IsUnique();
            e.HasIndex(x => x.TenantId).IsUnique();
            e.Property(x => x.Token).HasMaxLength(40);
            e.Property(x => x.LastError).HasMaxLength(300);
            e.HasOne<WorkType>().WithMany().HasForeignKey(x => x.WorkTypeId).OnDelete(DeleteBehavior.SetNull);
        });
        b.Entity<GitConnection>(e =>
        {
            e.HasIndex(x => x.Token).IsUnique();
            e.HasIndex(x => x.TenantId);
            e.Property(x => x.Name).HasMaxLength(60);
            e.Property(x => x.Token).HasMaxLength(40);
            e.Property(x => x.SecretProtected).HasMaxLength(300);
            e.Property(x => x.LastError).HasMaxLength(300);
        });
        b.Entity<GoogleConnection>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId }).IsUnique();
            e.Property(x => x.GoogleEmail).HasMaxLength(320);
            e.Property(x => x.RefreshTokenProtected).HasMaxLength(2000);
            e.Property(x => x.AccessTokenProtected).HasMaxLength(2000);
            e.Property(x => x.Scopes).HasMaxLength(500);
            e.Property(x => x.LastError).HasMaxLength(300);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<ProjectMeeting>(e =>
        {
            e.HasIndex(x => new { x.ProjectId, x.StartTimeUtc });
            e.HasIndex(x => x.GoogleCalendarEventId);
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.Description).HasMaxLength(4000);
            e.Property(x => x.TimeZone).HasMaxLength(60);
            e.Property(x => x.GoogleCalendarEventId).HasMaxLength(200);
            e.Property(x => x.GoogleMeetSpaceName).HasMaxLength(200);
            e.Property(x => x.GoogleMeetUri).HasMaxLength(300);
            e.HasOne(x => x.Project).WithMany().HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Organizer).WithMany().HasForeignKey(x => x.OrganizerUserId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<MeetingParticipant>(e =>
        {
            e.HasIndex(x => new { x.MeetingId, x.Email }).IsUnique();
            e.Property(x => x.Email).HasMaxLength(320);
            e.Property(x => x.GoogleAttendeeId).HasMaxLength(200);
            e.HasOne(x => x.Meeting).WithMany(m => m.Participants).HasForeignKey(x => x.MeetingId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.SetNull);
        });
        b.Entity<DevLink>(e =>
        {
            e.HasIndex(x => new { x.TaskId, x.OccurredAt });
            e.HasIndex(x => new { x.WorkTaskId, x.OccurredAt });
            e.HasIndex(x => new { x.TenantId, x.Provider, x.Kind, x.ExternalId });
            e.Property(x => x.Kind).HasMaxLength(20);
            e.Property(x => x.ExternalId).HasMaxLength(80);
            e.Property(x => x.Title).HasMaxLength(300);
            e.Property(x => x.Url).HasMaxLength(500);
            e.Property(x => x.Repository).HasMaxLength(200);
            e.Property(x => x.Author).HasMaxLength(120);
            e.Property(x => x.State).HasMaxLength(20);
            e.HasOne<TaskItem>().WithMany().HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<WorkTask>().WithMany().HasForeignKey(x => x.WorkTaskId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<TenantDataPolicy>(e => e.HasIndex(x => x.TenantId).IsUnique());
        b.Entity<AiConversation>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId, x.LastMessageAt });
            e.Property(x => x.Title).HasMaxLength(120);
        });
        b.Entity<AiMessage>(e =>
        {
            e.HasIndex(x => new { x.ConversationId, x.CreatedAt });
            e.HasIndex(x => new { x.TenantId, x.CreatedAt });               // a workspace's credits used this month
            e.Property(x => x.Role).HasMaxLength(12);
            e.Property(x => x.Tier).HasMaxLength(12);
            e.Property(x => x.Model).HasMaxLength(64);
            e.Property(x => x.RouteReason).HasMaxLength(120);
            e.Property(x => x.Status).HasMaxLength(12);
            e.Property(x => x.Feedback).HasMaxLength(8);
            e.Property(x => x.FeedbackReason).HasMaxLength(24);
            e.HasOne<AiConversation>().WithMany().HasForeignKey(x => x.ConversationId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<ChatAttachment>(e =>
        {
            e.HasIndex(x => new { x.ConversationId, x.MessageId });
            e.HasIndex(x => x.MessageId);
            e.Property(x => x.FileName).HasMaxLength(200);
            e.Property(x => x.ContentType).HasMaxLength(120);
            e.Property(x => x.StorageKey).HasMaxLength(200);
            e.Property(x => x.Sha256).HasMaxLength(64);
        });
        b.Entity<ChatReaction>(e =>
        {
            e.HasIndex(x => new { x.MessageId, x.UserId, x.Emoji }).IsUnique();
            e.Property(x => x.Emoji).HasMaxLength(16);
        });
        b.Entity<AiUserProfile>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId }).IsUnique();       // one profile per person per workspace
            e.Property(x => x.Notes).HasMaxLength(500);
        });
        b.Entity<AiAttachment>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId, x.MessageId });
            e.HasIndex(x => x.MessageId);
            e.Property(x => x.FileName).HasMaxLength(150);
            e.Property(x => x.ContentType).HasMaxLength(120);
            e.Property(x => x.StorageKey).HasMaxLength(200);
        });
        b.Entity<Reminder>(e =>
        {
            e.HasIndex(x => new { x.State, x.NextFireAt });                 // the scheduler's question: what is due
            e.HasIndex(x => new { x.TenantId, x.UserId, x.State });
            e.HasIndex(x => new { x.TenantId, x.SystemKey }).IsUnique();    // one automatic reminder per date and step
            e.HasIndex(x => new { x.TargetType, x.TargetId });
            e.HasIndex(x => x.ActionTokenHash);
            e.HasIndex(x => x.CreatedBy);
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.Note).HasMaxLength(1000);
            e.Property(x => x.TargetKey).HasMaxLength(40);
            e.Property(x => x.TargetTitle).HasMaxLength(200);
            e.Property(x => x.Link).HasMaxLength(300);
            e.Property(x => x.TimeZone).HasMaxLength(64);
            e.Property(x => x.LocalAt).HasMaxLength(16);
            e.Property(x => x.Recurrence).HasMaxLength(120);
            e.Property(x => x.SystemKey).HasMaxLength(160);
            e.Property(x => x.ActionTokenHash).HasMaxLength(64);
        });
        b.Entity<ReminderSettings>(e =>
        {
            e.HasIndex(x => x.UserId).IsUnique();
            e.Property(x => x.WorkDays).HasMaxLength(20);
            e.Property(x => x.DueLeads).HasMaxLength(40);
            e.Property(x => x.OverdueSteps).HasMaxLength(40);
            e.Property(x => x.LastBriefingDay).HasMaxLength(8);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<ReminderPolicy>(e =>
        {
            e.HasIndex(x => x.TenantId).IsUnique();
            e.Property(x => x.Steps).HasMaxLength(120);
        });
        b.Entity<PushSubscription>(e =>
        {
            e.HasIndex(x => x.Endpoint).IsUnique();
            e.HasIndex(x => x.UserId);
            e.Property(x => x.Endpoint).HasMaxLength(800);
            e.Property(x => x.P256dh).HasMaxLength(200);
            e.Property(x => x.Auth).HasMaxLength(100);
            e.Property(x => x.UserAgent).HasMaxLength(300);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<WebhookDelivery>(e =>
        {
            e.HasIndex(x => new { x.WebhookId, x.ActivityId }).IsUnique();
            e.HasIndex(x => new { x.Status, x.NextAttemptAt });
            e.HasIndex(x => new { x.WebhookId, x.CreatedAt });
            e.Property(x => x.EventType).HasMaxLength(60);
            e.Property(x => x.ResponseSnippet).HasMaxLength(600);
            e.Property(x => x.Error).HasMaxLength(300);
            e.HasOne<Webhook>().WithMany().HasForeignKey(x => x.WebhookId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<TenantSecuritySettings>(e =>
        {
            e.HasIndex(x => x.TenantId).IsUnique();
            e.Property(x => x.IpRanges).HasMaxLength(6000);
        });
        b.Entity<SsoConnection>(e =>
        {
            e.HasIndex(x => x.TenantId).IsUnique();   // one identity provider per organization
            e.Property(x => x.Name).HasMaxLength(80);
            e.Property(x => x.Authority).HasMaxLength(400);
            e.Property(x => x.ClientId).HasMaxLength(300);
            e.Property(x => x.ClientSecret).HasMaxLength(1000);
            e.Property(x => x.SamlEntityId).HasMaxLength(400);
            e.Property(x => x.SamlSsoUrl).HasMaxLength(800);
            e.Property(x => x.SamlCertificate).HasMaxLength(12000);
            e.HasOne<Tenant>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<SsoGroupMapping>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Group, x.TeamId }).IsUnique();
            e.Property(x => x.Group).HasMaxLength(200);
        });
        b.Entity<SsoDomain>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Domain }).IsUnique();
            // A domain can be verified by one organization only.
            e.HasIndex(x => x.Domain).IsUnique().HasFilter("\"VerifiedAt\" IS NOT NULL").HasDatabaseName("IX_SsoDomains_Domain_Verified");
            e.Property(x => x.Domain).HasMaxLength(253);
            e.Property(x => x.VerificationToken).HasMaxLength(64);
            e.HasOne<Tenant>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<ScimToken>(e =>
        {
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasIndex(x => x.TenantId);
            e.Property(x => x.Name).HasMaxLength(80);
            e.Property(x => x.Prefix).HasMaxLength(16);
            e.Property(x => x.TokenHash).HasMaxLength(128);
            e.HasOne<Tenant>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<UserLogin>(e =>
        {
            e.HasIndex(x => new { x.Provider, x.Subject }).IsUnique();
            e.HasIndex(x => x.UserId);
            e.Property(x => x.Provider).HasMaxLength(64);
            e.Property(x => x.Subject).HasMaxLength(256);
            e.Property(x => x.Email).HasMaxLength(320);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<PasswordHistory>(e =>
        {
            e.HasIndex(x => new { x.UserId, x.ReplacedAt });
            e.Property(x => x.Hash).HasMaxLength(200);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<UserConsent>(e =>
        {
            e.HasIndex(x => new { x.UserId, x.DocumentType, x.Version }).IsUnique();
            e.Property(x => x.DocumentType).HasMaxLength(30);
            e.Property(x => x.IpAddress).HasMaxLength(64);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<Conversation>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.LastMessageAt });
            e.HasIndex(x => new { x.TenantId, x.DirectKey }).IsUnique();   // one direct chat per pair of people (groups have no key)
            e.HasIndex(x => x.ProjectId).IsUnique();                       // one team chat per project (other chats have no project)
            e.Property(x => x.Name).HasMaxLength(80);
            e.Property(x => x.DirectKey).HasMaxLength(80);
            e.Property(x => x.LastMessageSnippet).HasMaxLength(200);
        });
        b.Entity<ConversationMember>(e =>
        {
            e.HasIndex(x => new { x.ConversationId, x.UserId }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.UserId });
            e.HasOne<Conversation>().WithMany().HasForeignKey(x => x.ConversationId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<ChatMessage>(e =>
        {
            e.HasIndex(x => new { x.ConversationId, x.CreatedAt });
            e.Property(x => x.Body).HasMaxLength(4000);
            e.HasOne<Conversation>().WithMany().HasForeignKey(x => x.ConversationId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<ChatMention>(e =>
        {
            e.HasIndex(x => new { x.UserId, x.ConversationId });
            e.HasIndex(x => x.MessageId);
            e.HasOne<ChatMessage>().WithMany().HasForeignKey(x => x.MessageId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<TenantFeatureOverride>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.FeatureKey }).IsUnique();
            e.Property(x => x.FeatureKey).HasMaxLength(64);
            e.Property(x => x.Reason).HasMaxLength(200);
        });
        b.Entity<PlatformSetting>(e =>
        {
            e.HasIndex(x => x.Key).IsUnique();
            e.Property(x => x.Key).HasMaxLength(64);
            e.Property(x => x.Value).HasMaxLength(500);
        });
        b.Entity<TimeEntry>(e =>
        {
            e.Ignore(x => x.IsRunning);
            e.HasIndex(x => new { x.TaskId, x.WorkDate });
            e.HasIndex(x => new { x.WorkTaskId, x.WorkDate });
            e.HasIndex(x => new { x.UserId, x.WorkDate });
            e.HasIndex(x => new { x.ProjectId, x.WorkDate });
            e.Property(x => x.Note).HasMaxLength(500);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne<TaskItem>().WithMany().HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<WorkTask>().WithMany().HasForeignKey(x => x.WorkTaskId).OnDelete(DeleteBehavior.Cascade);
            // Time is spent on exactly one thing: a project task or a work task.
            e.ToTable(t => t.HasCheckConstraint("CK_TimeEntries_OneTarget",
                "(\"TaskId\" IS NOT NULL AND \"WorkTaskId\" IS NULL) OR (\"TaskId\" IS NULL AND \"WorkTaskId\" IS NOT NULL)"));
        });
        b.Entity<TimesheetApproval>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId, x.WeekStart }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.Status, x.WeekStart });
            e.Property(x => x.Note).HasMaxLength(500);
            e.Property(x => x.ReviewNote).HasMaxLength(500);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<AutomationRule>(e =>
        {
            e.HasIndex(x => new { x.ProjectId, x.Trigger });
            e.Property(x => x.Name).HasMaxLength(100);
            e.Property(x => x.ActionText).HasMaxLength(500);
            e.Property(x => x.MoreActionsJson).HasMaxLength(4000);
            e.HasIndex(x => new { x.TenantId, x.Trigger });
            e.HasOne<Project>().WithMany().HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<AutomationRun>(e =>
        {
            e.HasIndex(x => new { x.RuleId, x.TaskId, x.Period }).IsUnique();
            e.Property(x => x.Period).HasMaxLength(20);
            e.HasOne<AutomationRule>().WithMany().HasForeignKey(x => x.RuleId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<TaskItem>().WithMany().HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<TaskLabel>(e =>
        {
            e.HasIndex(x => new { x.TaskId, x.LabelId }).IsUnique();
            e.HasOne(x => x.Label).WithMany().HasForeignKey(x => x.LabelId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<TaskComment>(e =>
        {
            e.HasIndex(x => x.TaskId);
            e.HasOne(x => x.Author).WithMany().HasForeignKey(x => x.AuthorId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<Activity>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.CreatedAt });
            e.HasIndex(x => new { x.TenantId, x.ProjectId, x.CreatedAt });
            e.Property(x => x.Action).HasMaxLength(60);
            e.Property(x => x.Summary).HasMaxLength(500);
            e.HasOne(x => x.Actor).WithMany().HasForeignKey(x => x.ActorId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<Notification>(e =>
        {
            e.HasIndex(x => new { x.UserId, x.ReadAt });
            e.HasIndex(x => x.DedupeKey);
            e.HasIndex(x => x.EmailPending);
            e.HasIndex(x => x.PushPending);
            e.Property(x => x.DedupeKey).HasMaxLength(100);
        });
        b.Entity<Attachment>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.ProjectId });
            e.HasIndex(x => x.TaskId);
            e.HasIndex(x => x.IssueId);
            e.Property(x => x.FileName).HasMaxLength(200);
            e.Property(x => x.ContentType).HasMaxLength(100);
            e.Property(x => x.StorageKey).HasMaxLength(200);
            e.Property(x => x.Sha256).HasMaxLength(64);
        });
        b.Entity<NotificationPreference>(e =>
        {
            e.HasIndex(x => new { x.UserId, x.Type }).IsUnique();
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<AuditLog>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.CreatedAt });
            e.HasIndex(x => x.CreatedAt);
            // The chain: one position per workspace. Two writers that both read the same last row cannot both win (the loser tries again).
            e.HasIndex(x => new { x.TenantId, x.Seq }).IsUnique();
            e.Property(x => x.PrevHash).HasMaxLength(64);
            e.Property(x => x.Hash).HasMaxLength(64);
            e.Property(x => x.Action).HasMaxLength(60);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Restrict);
        });
    }
}
