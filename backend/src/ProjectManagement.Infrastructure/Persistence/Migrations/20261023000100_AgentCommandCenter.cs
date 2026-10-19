using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// The agent as a project delegate: how much it may do by itself (autonomy), commitments and their check-ins, sending the agent to a
    /// meeting in someone's place, and each person's own agent preferences. Additive only.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261023000100_AgentCommandCenter")]
    public partial class AgentCommandCenter : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(name: "AutonomyLevel", table: "ProjectAgentSettings", type: "integer", nullable: false, defaultValue: 2);
            migrationBuilder.AddColumn<int>(name: "AutoApplyConfidence", table: "ProjectAgentSettings", type: "integer", nullable: false, defaultValue: 90);
            migrationBuilder.AddColumn<string>(name: "AutoApplyKinds", table: "ProjectAgentSettings", type: "character varying(200)", maxLength: 200, nullable: true);
            migrationBuilder.AddColumn<bool>(name: "FollowUps", table: "ProjectAgentSettings", type: "boolean", nullable: false, defaultValue: true);
            migrationBuilder.AddColumn<bool>(name: "MeetingBriefs", table: "ProjectAgentSettings", type: "boolean", nullable: false, defaultValue: true);

            migrationBuilder.AddColumn<bool>(name: "AutoApplied", table: "AgentFindings", type: "boolean", nullable: false, defaultValue: false);
            migrationBuilder.AddColumn<string>(name: "Before", table: "AgentFindings", type: "character varying(500)", maxLength: 500, nullable: true);
            migrationBuilder.AddColumn<Guid>(name: "CommitmentId", table: "AgentFindings", type: "uuid", nullable: true);
            migrationBuilder.CreateIndex(name: "IX_AgentFindings_ProjectId_Kind_Status", table: "AgentFindings", columns: new[] { "ProjectId", "Kind", "Status" });

            migrationBuilder.CreateTable(
                name: "AgentCommitments",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    FindingId = table.Column<Guid>(type: "uuid", nullable: true),
                    TaskId = table.Column<Guid>(type: "uuid", nullable: true),
                    WorkTaskId = table.Column<Guid>(type: "uuid", nullable: true),
                    EntityKey = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    OwnerUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Title = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    DueDate = table.Column<DateOnly>(type: "date", nullable: false),
                    Quote = table.Column<string>(type: "character varying(400)", maxLength: 400, nullable: true),
                    SourceLabel = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    ApprovedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    CheckInSentAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CheckInAnswer = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    CheckInNote = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    ProposedDate = table.Column<DateOnly>(type: "date", nullable: true),
                    AnsweredAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ResolvedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ChangeFindingId = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table => { table.PrimaryKey("PK_AgentCommitments", x => x.Id); });
            migrationBuilder.CreateIndex(name: "IX_AgentCommitments_FindingId", table: "AgentCommitments", column: "FindingId");
            migrationBuilder.CreateIndex(name: "IX_AgentCommitments_OwnerUserId_Status", table: "AgentCommitments", columns: new[] { "OwnerUserId", "Status" });
            migrationBuilder.CreateIndex(name: "IX_AgentCommitments_ProjectId_Status_DueDate", table: "AgentCommitments", columns: new[] { "ProjectId", "Status", "DueDate" });

            migrationBuilder.CreateTable(
                name: "AgentDelegations",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    MeetingId = table.Column<Guid>(type: "uuid", nullable: false),
                    SessionStartUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    SessionEndUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Instructions = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    Automatic = table.Column<bool>(type: "boolean", nullable: false),
                    BotRowId = table.Column<Guid>(type: "uuid", nullable: true),
                    ReportSentAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Note = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table => { table.PrimaryKey("PK_AgentDelegations", x => x.Id); });
            migrationBuilder.CreateIndex(name: "IX_AgentDelegations_MeetingId_SessionStartUtc_UserId", table: "AgentDelegations", columns: new[] { "MeetingId", "SessionStartUtc", "UserId" }, unique: true);
            migrationBuilder.CreateIndex(name: "IX_AgentDelegations_ProjectId_Status", table: "AgentDelegations", columns: new[] { "ProjectId", "Status" });
            migrationBuilder.CreateIndex(name: "IX_AgentDelegations_UserId_SessionStartUtc", table: "AgentDelegations", columns: new[] { "UserId", "SessionStartUtc" });

            migrationBuilder.CreateTable(
                name: "AgentPersonalSettings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    AutoDelegate = table.Column<bool>(type: "boolean", nullable: false),
                    MeetingBriefs = table.Column<bool>(type: "boolean", nullable: false),
                    BriefMinutes = table.Column<int>(type: "integer", nullable: false),
                    CheckIns = table.Column<bool>(type: "boolean", nullable: false),
                    LastVisitAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    PreviousVisitAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table => { table.PrimaryKey("PK_AgentPersonalSettings", x => x.Id); });
            migrationBuilder.CreateIndex(name: "IX_AgentPersonalSettings_TenantId_UserId", table: "AgentPersonalSettings", columns: new[] { "TenantId", "UserId" }, unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "AgentPersonalSettings");
            migrationBuilder.DropTable(name: "AgentDelegations");
            migrationBuilder.DropTable(name: "AgentCommitments");
            migrationBuilder.DropIndex(name: "IX_AgentFindings_ProjectId_Kind_Status", table: "AgentFindings");
            migrationBuilder.DropColumn(name: "AutoApplied", table: "AgentFindings");
            migrationBuilder.DropColumn(name: "Before", table: "AgentFindings");
            migrationBuilder.DropColumn(name: "CommitmentId", table: "AgentFindings");
            migrationBuilder.DropColumn(name: "AutonomyLevel", table: "ProjectAgentSettings");
            migrationBuilder.DropColumn(name: "AutoApplyConfidence", table: "ProjectAgentSettings");
            migrationBuilder.DropColumn(name: "AutoApplyKinds", table: "ProjectAgentSettings");
            migrationBuilder.DropColumn(name: "FollowUps", table: "ProjectAgentSettings");
            migrationBuilder.DropColumn(name: "MeetingBriefs", table: "ProjectAgentSettings");
        }
    }
}
