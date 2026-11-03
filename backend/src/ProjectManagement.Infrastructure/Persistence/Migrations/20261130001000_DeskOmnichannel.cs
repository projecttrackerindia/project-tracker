using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Desk phase 1 (omnichannel support): DeskSettings (per-workspace flags, encrypted Sarvam/telephony keys, consent and retention policy),
    /// DeskInboundEvents (the durable WhatsApp intake queue: unique provider message id, lease, retries, dead letters), DeskEngineers
    /// (availability, skills, department, capacity, shift), DeskAssignments (routing offers, acceptance, escalation), DeskTicketInsights
    /// (AI category, priority, confidence, summary, review) and DeskVoiceSessions (consent, encrypted transcript, recording, retention).
    /// Six new tables; nothing existing changes.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261130001000_DeskOmnichannel")]
    public partial class DeskOmnichannel : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "DeskSettings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    IntakeEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    AutoAcknowledge = table.Column<bool>(type: "boolean", nullable: false),
                    AutoCreateTicket = table.Column<bool>(type: "boolean", nullable: false),
                    AckMessage = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    RoutingEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    ConfidenceThreshold = table.Column<int>(type: "integer", nullable: false),
                    AcceptMinutes = table.Column<int>(type: "integer", nullable: false),
                    MaxReassignments = table.Column<int>(type: "integer", nullable: false),
                    SupervisorId = table.Column<Guid>(type: "uuid", nullable: true),
                    NotifyOnWhatsApp = table.Column<bool>(type: "boolean", nullable: false),
                    VoiceEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    SarvamApiKeyProtected = table.Column<string>(type: "text", nullable: true),
                    VoiceLanguages = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    ConsentPrompt = table.Column<string>(type: "character varying(600)", maxLength: 600, nullable: false),
                    RecordCalls = table.Column<bool>(type: "boolean", nullable: false),
                    RetentionDays = table.Column<int>(type: "integer", nullable: false),
                    TelephonyProvider = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    TelephonyKeyProtected = table.Column<string>(type: "text", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DeskSettings", x => x.Id);
                });

            migrationBuilder.CreateIndex(name: "IX_DeskSettings_TenantId", table: "DeskSettings", column: "TenantId", unique: true);

            migrationBuilder.CreateTable(
                name: "DeskInboundEvents",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Provider = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    ProviderMessageId = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    ChannelId = table.Column<Guid>(type: "uuid", nullable: false),
                    ConversationId = table.Column<Guid>(type: "uuid", nullable: true),
                    MessageType = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    Status = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Attempts = table.Column<int>(type: "integer", nullable: false),
                    NextAttemptAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    LeaseUntil = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LastError = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    ProcessedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    WorkTaskId = table.Column<Guid>(type: "uuid", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DeskInboundEvents", x => x.Id);
                });

            migrationBuilder.CreateIndex(name: "IX_DeskInboundEvents_TenantId_Provider_ProviderMessageId", table: "DeskInboundEvents", columns: new[] { "TenantId", "Provider", "ProviderMessageId" }, unique: true);

            migrationBuilder.CreateIndex(name: "IX_DeskInboundEvents_Status_NextAttemptAt", table: "DeskInboundEvents", columns: new[] { "Status", "NextAttemptAt" });

            migrationBuilder.CreateTable(
                name: "DeskEngineers",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Status = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    StatusChangedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Skills = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    Department = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    MaxActive = table.Column<int>(type: "integer", nullable: false),
                    ShiftStartMinutes = table.Column<int>(type: "integer", nullable: true),
                    ShiftEndMinutes = table.Column<int>(type: "integer", nullable: true),
                    OnCall = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DeskEngineers", x => x.Id);
                });

            migrationBuilder.CreateIndex(name: "IX_DeskEngineers_TenantId_UserId", table: "DeskEngineers", columns: new[] { "TenantId", "UserId" }, unique: true);

            migrationBuilder.CreateTable(
                name: "DeskAssignments",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    WorkTaskId = table.Column<Guid>(type: "uuid", nullable: false),
                    AssigneeId = table.Column<Guid>(type: "uuid", nullable: true),
                    Method = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Reason = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    Score = table.Column<int>(type: "integer", nullable: false),
                    AssignedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    AcceptDueAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    AcceptedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Reassignments = table.Column<int>(type: "integer", nullable: false),
                    EscalatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Active = table.Column<bool>(type: "boolean", nullable: false),
                    AssignedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DeskAssignments", x => x.Id);
                });

            migrationBuilder.CreateIndex(name: "IX_DeskAssignments_TenantId_WorkTaskId_Active", table: "DeskAssignments", columns: new[] { "TenantId", "WorkTaskId", "Active" });

            migrationBuilder.CreateIndex(name: "IX_DeskAssignments_Active_AcceptDueAt", table: "DeskAssignments", columns: new[] { "Active", "AcceptDueAt" });

            migrationBuilder.CreateTable(
                name: "DeskTicketInsights",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    WorkTaskId = table.Column<Guid>(type: "uuid", nullable: false),
                    Channel = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Category = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    Priority = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Department = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    Skills = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    Confidence = table.Column<int>(type: "integer", nullable: false),
                    Summary = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    Source = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    NeedsReview = table.Column<bool>(type: "boolean", nullable: false),
                    ReviewedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    ReviewedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ContactUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    Organization = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DeskTicketInsights", x => x.Id);
                });

            migrationBuilder.CreateIndex(name: "IX_DeskTicketInsights_TenantId_WorkTaskId", table: "DeskTicketInsights", columns: new[] { "TenantId", "WorkTaskId" }, unique: true);

            migrationBuilder.CreateIndex(name: "IX_DeskTicketInsights_TenantId_NeedsReview", table: "DeskTicketInsights", columns: new[] { "TenantId", "NeedsReview" });

            migrationBuilder.CreateTable(
                name: "DeskVoiceSessions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    WorkTaskId = table.Column<Guid>(type: "uuid", nullable: true),
                    Channel = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Direction = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Language = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    Status = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    ConsentGiven = table.Column<bool>(type: "boolean", nullable: true),
                    ConsentAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    TranscriptProtected = table.Column<string>(type: "text", nullable: false),
                    Summary = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    RecordingKey = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    RecordingContentType = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    RecordingBytes = table.Column<long>(type: "bigint", nullable: false),
                    RetainUntil = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Provider = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    ProviderCallId = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    StartedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    StartedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    EndedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DeskVoiceSessions", x => x.Id);
                });

            migrationBuilder.CreateIndex(name: "IX_DeskVoiceSessions_TenantId_WorkTaskId", table: "DeskVoiceSessions", columns: new[] { "TenantId", "WorkTaskId" });

            migrationBuilder.CreateIndex(name: "IX_DeskVoiceSessions_RetainUntil", table: "DeskVoiceSessions", column: "RetainUntil");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "DeskVoiceSessions");
            migrationBuilder.DropTable(name: "DeskTicketInsights");
            migrationBuilder.DropTable(name: "DeskAssignments");
            migrationBuilder.DropTable(name: "DeskEngineers");
            migrationBuilder.DropTable(name: "DeskInboundEvents");
            migrationBuilder.DropTable(name: "DeskSettings");
        }
    }
}
