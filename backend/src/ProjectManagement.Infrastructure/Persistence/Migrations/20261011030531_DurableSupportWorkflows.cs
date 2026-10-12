using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class DurableSupportWorkflows : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "WorkflowResolutionDueAt",
                table: "SupportTickets",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "WorkflowResponseDueAt",
                table: "SupportTickets",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "SupportWorkflowEvents",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TicketId = table.Column<Guid>(type: "uuid", nullable: false),
                    Kind = table.Column<string>(type: "text", nullable: false),
                    RequestKey = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    ProcessedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    RevisionIdsJson = table.Column<string>(type: "text", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SupportWorkflowEvents", x => x.Id);
                    table.ForeignKey(
                        name: "FK_SupportWorkflowEvents_SupportTickets_TicketId",
                        column: x => x.TicketId,
                        principalTable: "SupportTickets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "SupportWorkflows",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    CreatorId = table.Column<Guid>(type: "uuid", nullable: false),
                    DraftJson = table.Column<string>(type: "text", nullable: false),
                    PublishedRevisionId = table.Column<Guid>(type: "uuid", nullable: true),
                    PublishedTrigger = table.Column<string>(type: "text", nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    Version = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SupportWorkflows", x => x.Id);
                    table.ForeignKey(
                        name: "FK_SupportWorkflows_Users_CreatorId",
                        column: x => x.CreatorId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "SupportWorkflowRevisions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    WorkflowId = table.Column<Guid>(type: "uuid", nullable: false),
                    Number = table.Column<int>(type: "integer", nullable: false),
                    PublishedBy = table.Column<Guid>(type: "uuid", nullable: false),
                    GraphJson = table.Column<string>(type: "text", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SupportWorkflowRevisions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_SupportWorkflowRevisions_SupportWorkflows_WorkflowId",
                        column: x => x.WorkflowId,
                        principalTable: "SupportWorkflows",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_SupportWorkflowRevisions_Users_PublishedBy",
                        column: x => x.PublishedBy,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "SupportWorkflowSchedules",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    WorkflowId = table.Column<Guid>(type: "uuid", nullable: false),
                    TicketId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    IntervalMinutes = table.Column<int>(type: "integer", nullable: false),
                    NextRunAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    Version = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SupportWorkflowSchedules", x => x.Id);
                    table.ForeignKey(
                        name: "FK_SupportWorkflowSchedules_SupportTickets_TicketId",
                        column: x => x.TicketId,
                        principalTable: "SupportTickets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_SupportWorkflowSchedules_SupportWorkflows_WorkflowId",
                        column: x => x.WorkflowId,
                        principalTable: "SupportWorkflows",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_SupportWorkflowSchedules_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "SupportWorkflowRuns",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    WorkflowId = table.Column<Guid>(type: "uuid", nullable: false),
                    RevisionId = table.Column<Guid>(type: "uuid", nullable: false),
                    TicketId = table.Column<Guid>(type: "uuid", nullable: false),
                    EventId = table.Column<Guid>(type: "uuid", nullable: true),
                    ScheduleId = table.Column<Guid>(type: "uuid", nullable: true),
                    ExecutorId = table.Column<Guid>(type: "uuid", nullable: false),
                    RequestKey = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    NodeId = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    Status = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    AvailableAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CompletedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LeaseOwner = table.Column<Guid>(type: "uuid", nullable: true),
                    LeaseExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Attempts = table.Column<int>(type: "integer", nullable: false),
                    ApprovedWorkVersion = table.Column<int>(type: "integer", nullable: true),
                    ApprovedTicketVersion = table.Column<int>(type: "integer", nullable: true),
                    ErrorCode = table.Column<string>(type: "text", nullable: true),
                    Version = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SupportWorkflowRuns", x => x.Id);
                    table.ForeignKey(
                        name: "FK_SupportWorkflowRuns_SupportTickets_TicketId",
                        column: x => x.TicketId,
                        principalTable: "SupportTickets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_SupportWorkflowRuns_SupportWorkflowRevisions_RevisionId",
                        column: x => x.RevisionId,
                        principalTable: "SupportWorkflowRevisions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_SupportWorkflowRuns_SupportWorkflows_WorkflowId",
                        column: x => x.WorkflowId,
                        principalTable: "SupportWorkflows",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_SupportWorkflowRuns_Users_ExecutorId",
                        column: x => x.ExecutorId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "SupportWorkflowSteps",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    RunId = table.Column<Guid>(type: "uuid", nullable: false),
                    NodeId = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    Outcome = table.Column<string>(type: "text", nullable: false),
                    ApprovedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SupportWorkflowSteps", x => x.Id);
                    table.ForeignKey(
                        name: "FK_SupportWorkflowSteps_SupportWorkflowRuns_RunId",
                        column: x => x.RunId,
                        principalTable: "SupportWorkflowRuns",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_SupportWorkflowEvents_ProcessedAt_CreatedAt",
                table: "SupportWorkflowEvents",
                columns: new[] { "ProcessedAt", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_SupportWorkflowEvents_TenantId_RequestKey",
                table: "SupportWorkflowEvents",
                columns: new[] { "TenantId", "RequestKey" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SupportWorkflowEvents_TicketId",
                table: "SupportWorkflowEvents",
                column: "TicketId");

            migrationBuilder.CreateIndex(
                name: "IX_SupportWorkflowRevisions_PublishedBy",
                table: "SupportWorkflowRevisions",
                column: "PublishedBy");

            migrationBuilder.CreateIndex(
                name: "IX_SupportWorkflowRevisions_WorkflowId_Number",
                table: "SupportWorkflowRevisions",
                columns: new[] { "WorkflowId", "Number" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SupportWorkflowRuns_ExecutorId",
                table: "SupportWorkflowRuns",
                column: "ExecutorId");

            migrationBuilder.CreateIndex(
                name: "IX_SupportWorkflowRuns_RevisionId",
                table: "SupportWorkflowRuns",
                column: "RevisionId");

            migrationBuilder.CreateIndex(
                name: "IX_SupportWorkflowRuns_Status_AvailableAt_TenantId",
                table: "SupportWorkflowRuns",
                columns: new[] { "Status", "AvailableAt", "TenantId" });

            migrationBuilder.CreateIndex(
                name: "IX_SupportWorkflowRuns_TenantId_WorkflowId_RequestKey",
                table: "SupportWorkflowRuns",
                columns: new[] { "TenantId", "WorkflowId", "RequestKey" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SupportWorkflowRuns_TicketId",
                table: "SupportWorkflowRuns",
                column: "TicketId");

            migrationBuilder.CreateIndex(
                name: "IX_SupportWorkflowRuns_WorkflowId",
                table: "SupportWorkflowRuns",
                column: "WorkflowId");

            migrationBuilder.CreateIndex(
                name: "IX_SupportWorkflowSchedules_Enabled_NextRunAt",
                table: "SupportWorkflowSchedules",
                columns: new[] { "Enabled", "NextRunAt" });

            migrationBuilder.CreateIndex(
                name: "IX_SupportWorkflowSchedules_TicketId",
                table: "SupportWorkflowSchedules",
                column: "TicketId");

            migrationBuilder.CreateIndex(
                name: "IX_SupportWorkflowSchedules_UserId",
                table: "SupportWorkflowSchedules",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_SupportWorkflowSchedules_WorkflowId_TicketId",
                table: "SupportWorkflowSchedules",
                columns: new[] { "WorkflowId", "TicketId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SupportWorkflowSteps_RunId_NodeId",
                table: "SupportWorkflowSteps",
                columns: new[] { "RunId", "NodeId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SupportWorkflows_CreatorId",
                table: "SupportWorkflows",
                column: "CreatorId");

            migrationBuilder.CreateIndex(
                name: "IX_SupportWorkflows_TenantId_Enabled",
                table: "SupportWorkflows",
                columns: new[] { "TenantId", "Enabled" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "SupportWorkflowEvents");

            migrationBuilder.DropTable(
                name: "SupportWorkflowSchedules");

            migrationBuilder.DropTable(
                name: "SupportWorkflowSteps");

            migrationBuilder.DropTable(
                name: "SupportWorkflowRuns");

            migrationBuilder.DropTable(
                name: "SupportWorkflowRevisions");

            migrationBuilder.DropTable(
                name: "SupportWorkflows");

            migrationBuilder.DropColumn(
                name: "WorkflowResolutionDueAt",
                table: "SupportTickets");

            migrationBuilder.DropColumn(
                name: "WorkflowResponseDueAt",
                table: "SupportTickets");
        }
    }
}
