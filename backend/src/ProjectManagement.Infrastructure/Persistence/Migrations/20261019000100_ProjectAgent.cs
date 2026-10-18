using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// The project agent - additive only (new tables and their indexes), so it is also applied to SQLite development databases:
    /// ProjectAgentSettings, AgentSignals, AgentRuns, AgentFindings, AgentWorkspaceSettings, AgentMeetingBots and AgentInboxOptIns.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261019000100_ProjectAgent")]
    public partial class ProjectAgent : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ProjectAgentSettings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    MailboxToken = table.Column<string>(type: "character varying(24)", maxLength: 24, nullable: false),
                    ReadMailbox = table.Column<bool>(type: "boolean", nullable: false),
                    ReadChat = table.Column<bool>(type: "boolean", nullable: false),
                    ReadMeetings = table.Column<bool>(type: "boolean", nullable: false),
                    LiveBot = table.Column<bool>(type: "boolean", nullable: false),
                    DailyUpdates = table.Column<bool>(type: "boolean", nullable: false),
                    ActingUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    ChatReadUntil = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LastRunAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    RunMonth = table.Column<string>(type: "character varying(7)", maxLength: 7, nullable: true),
                    RunsThisMonth = table.Column<int>(type: "integer", nullable: false),
                    MonthlyRunLimit = table.Column<int>(type: "integer", nullable: false),
                    DailySentDay = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: true),
                    MailReceived = table.Column<int>(type: "integer", nullable: false),
                    LastError = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProjectAgentSettings", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ProjectAgentSettings_ProjectId",
                table: "ProjectAgentSettings",
                column: "ProjectId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ProjectAgentSettings_MailboxToken",
                table: "ProjectAgentSettings",
                column: "MailboxToken",
                unique: true);

            migrationBuilder.CreateTable(
                name: "AgentSignals",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    Source = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    SourceRef = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    Title = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    FromName = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    ContentProtected = table.Column<string>(type: "text", nullable: false),
                    Length = table.Column<int>(type: "integer", nullable: false),
                    OccurredAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    OwnerUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    MeetingId = table.Column<Guid>(type: "uuid", nullable: true),
                    ProcessedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    RunId = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AgentSignals", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AgentSignals_ProjectId_Source_SourceRef",
                table: "AgentSignals",
                columns: new[] { "ProjectId", "Source", "SourceRef" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_AgentSignals_ProjectId_ProcessedAt",
                table: "AgentSignals",
                columns: new[] { "ProjectId", "ProcessedAt" });

            migrationBuilder.CreateTable(
                name: "AgentRuns",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    Trigger = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    SignalCount = table.Column<int>(type: "integer", nullable: false),
                    FindingCount = table.Column<int>(type: "integer", nullable: false),
                    Credits = table.Column<int>(type: "integer", nullable: false),
                    Summary = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    Error = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    StartedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    FinishedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    MeetingId = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AgentRuns", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AgentRuns_ProjectId_StartedAt",
                table: "AgentRuns",
                columns: new[] { "ProjectId", "StartedAt" });

            migrationBuilder.CreateTable(
                name: "AgentFindings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    RunId = table.Column<Guid>(type: "uuid", nullable: false),
                    SignalId = table.Column<Guid>(type: "uuid", nullable: true),
                    Kind = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Status = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Title = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    Detail = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    Evidence = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    SourceLabel = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    TaskId = table.Column<Guid>(type: "uuid", nullable: true),
                    IssueId = table.Column<Guid>(type: "uuid", nullable: true),
                    AssigneeId = table.Column<Guid>(type: "uuid", nullable: true),
                    DueDate = table.Column<DateOnly>(type: "date", nullable: true),
                    Priority = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    NewStatus = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    Comment = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    Confidence = table.Column<int>(type: "integer", nullable: false),
                    DecidedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    DecidedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    AppliedEntityId = table.Column<Guid>(type: "uuid", nullable: true),
                    AppliedKey = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    Error = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AgentFindings", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AgentFindings_ProjectId_Status_CreatedAt",
                table: "AgentFindings",
                columns: new[] { "ProjectId", "Status", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_AgentFindings_RunId",
                table: "AgentFindings",
                column: "RunId");

            migrationBuilder.CreateTable(
                name: "AgentWorkspaceSettings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    RecallApiKeyProtected = table.Column<string>(type: "text", nullable: true),
                    RecallRegion = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    BotName = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    InCallReminders = table.Column<bool>(type: "boolean", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AgentWorkspaceSettings", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AgentWorkspaceSettings_TenantId",
                table: "AgentWorkspaceSettings",
                column: "TenantId",
                unique: true);

            migrationBuilder.CreateTable(
                name: "AgentMeetingBots",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    MeetingId = table.Column<Guid>(type: "uuid", nullable: false),
                    SessionStartUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    SessionEndUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    Kind = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    BotId = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    LastAttemptAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Attempts = table.Column<int>(type: "integer", nullable: false),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    WebhookToken = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    TranscriptProtected = table.Column<string>(type: "text", nullable: true),
                    TranscriptLength = table.Column<int>(type: "integer", nullable: false),
                    CheckedLength = table.Column<int>(type: "integer", nullable: false),
                    LastNudgeAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    NudgeCount = table.Column<int>(type: "integer", nullable: false),
                    NudgesSent = table.Column<string>(type: "text", nullable: true),
                    EndedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Error = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AgentMeetingBots", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AgentMeetingBots_MeetingId_SessionStartUtc_Kind",
                table: "AgentMeetingBots",
                columns: new[] { "MeetingId", "SessionStartUtc", "Kind" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_AgentMeetingBots_WebhookToken",
                table: "AgentMeetingBots",
                column: "WebhookToken",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_AgentMeetingBots_Status",
                table: "AgentMeetingBots",
                column: "Status");

            migrationBuilder.CreateTable(
                name: "AgentInboxOptIns",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Provider = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    OptedInAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ScannedUntil = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Found = table.Column<int>(type: "integer", nullable: false),
                    LastError = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AgentInboxOptIns", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AgentInboxOptIns_TenantId_UserId",
                table: "AgentInboxOptIns",
                columns: new[] { "TenantId", "UserId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ProjectAgentSettings");

            migrationBuilder.DropTable(
                name: "AgentSignals");

            migrationBuilder.DropTable(
                name: "AgentRuns");

            migrationBuilder.DropTable(
                name: "AgentFindings");

            migrationBuilder.DropTable(
                name: "AgentWorkspaceSettings");

            migrationBuilder.DropTable(
                name: "AgentMeetingBots");

            migrationBuilder.DropTable(
                name: "AgentInboxOptIns");
        }
    }
}
