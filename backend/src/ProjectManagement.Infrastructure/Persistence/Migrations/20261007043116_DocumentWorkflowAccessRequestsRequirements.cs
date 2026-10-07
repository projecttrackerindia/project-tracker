using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class DocumentWorkflowAccessRequestsRequirements : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_DocumentLinks_TenantId_DocumentId_TargetType_TargetId_Relat~",
                table: "DocumentLinks");

            migrationBuilder.AddColumn<Guid>(
                name: "RequirementId",
                table: "DocumentLinks",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "AccessRequests",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    DocumentId = table.Column<Guid>(type: "uuid", nullable: false),
                    RequesterId = table.Column<Guid>(type: "uuid", nullable: false),
                    Level = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Reason = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    DurationDays = table.Column<int>(type: "integer", nullable: true),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    DecidedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    DecidedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    DecisionNote = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    GrantedLevel = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    GrantedUntil = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    GrantId = table.Column<Guid>(type: "uuid", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AccessRequests", x => x.Id);
                    table.ForeignKey(
                        name: "FK_AccessRequests_Documents_DocumentId",
                        column: x => x.DocumentId,
                        principalTable: "Documents",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "DocumentApprovals",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    DocumentId = table.Column<Guid>(type: "uuid", nullable: false),
                    VersionId = table.Column<Guid>(type: "uuid", nullable: false),
                    ContentHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    State = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    SubmittedBy = table.Column<Guid>(type: "uuid", nullable: false),
                    SubmittedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CurrentStep = table.Column<int>(type: "integer", nullable: false),
                    StepStartedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ReminderSent = table.Column<bool>(type: "boolean", nullable: false),
                    WorkflowName = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    Remind = table.Column<bool>(type: "boolean", nullable: false),
                    StepsJson = table.Column<string>(type: "character varying(16000)", maxLength: 16000, nullable: false),
                    Summary = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    Reason = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    Major = table.Column<bool>(type: "boolean", nullable: false),
                    ClosedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ClosedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    ClosedNote = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DocumentApprovals", x => x.Id);
                    table.ForeignKey(
                        name: "FK_DocumentApprovals_Documents_DocumentId",
                        column: x => x.DocumentId,
                        principalTable: "Documents",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "DocumentRequirements",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    DocumentId = table.Column<Guid>(type: "uuid", nullable: false),
                    Number = table.Column<int>(type: "integer", nullable: false),
                    Title = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    Detail = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    Priority = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    SortOrder = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DocumentRequirements", x => x.Id);
                    table.ForeignKey(
                        name: "FK_DocumentRequirements_Documents_DocumentId",
                        column: x => x.DocumentId,
                        principalTable: "Documents",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "WorkflowDefinitions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TypeId = table.Column<Guid>(type: "uuid", nullable: true),
                    Name = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    IsActive = table.Column<bool>(type: "boolean", nullable: false),
                    StepsJson = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: false),
                    Remind = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WorkflowDefinitions", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ApprovalDecisions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ApprovalId = table.Column<Guid>(type: "uuid", nullable: false),
                    DocumentId = table.Column<Guid>(type: "uuid", nullable: false),
                    StepIndex = table.Column<int>(type: "integer", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Decision = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Comment = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ApprovalDecisions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ApprovalDecisions_DocumentApprovals_ApprovalId",
                        column: x => x.ApprovalId,
                        principalTable: "DocumentApprovals",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_DocumentLinks_TenantId_DocumentId_TargetType_TargetId_Relat~",
                table: "DocumentLinks",
                columns: new[] { "TenantId", "DocumentId", "TargetType", "TargetId", "Relation", "RequirementId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_DocumentLinks_TenantId_RequirementId",
                table: "DocumentLinks",
                columns: new[] { "TenantId", "RequirementId" });

            migrationBuilder.CreateIndex(
                name: "IX_AccessRequests_DocumentId",
                table: "AccessRequests",
                column: "DocumentId");

            migrationBuilder.CreateIndex(
                name: "IX_AccessRequests_TenantId_DocumentId_Status",
                table: "AccessRequests",
                columns: new[] { "TenantId", "DocumentId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_AccessRequests_TenantId_RequesterId_Status",
                table: "AccessRequests",
                columns: new[] { "TenantId", "RequesterId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_ApprovalDecisions_ApprovalId",
                table: "ApprovalDecisions",
                column: "ApprovalId");

            migrationBuilder.CreateIndex(
                name: "IX_ApprovalDecisions_TenantId_ApprovalId_StepIndex",
                table: "ApprovalDecisions",
                columns: new[] { "TenantId", "ApprovalId", "StepIndex" });

            migrationBuilder.CreateIndex(
                name: "IX_DocumentApprovals_DocumentId",
                table: "DocumentApprovals",
                column: "DocumentId");

            migrationBuilder.CreateIndex(
                name: "IX_DocumentApprovals_TenantId_DocumentId_SubmittedAt",
                table: "DocumentApprovals",
                columns: new[] { "TenantId", "DocumentId", "SubmittedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_DocumentApprovals_TenantId_State",
                table: "DocumentApprovals",
                columns: new[] { "TenantId", "State" });

            migrationBuilder.CreateIndex(
                name: "IX_DocumentRequirements_DocumentId",
                table: "DocumentRequirements",
                column: "DocumentId");

            migrationBuilder.CreateIndex(
                name: "IX_DocumentRequirements_TenantId_DocumentId_Number",
                table: "DocumentRequirements",
                columns: new[] { "TenantId", "DocumentId", "Number" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_WorkflowDefinitions_TenantId_TypeId",
                table: "WorkflowDefinitions",
                columns: new[] { "TenantId", "TypeId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AccessRequests");

            migrationBuilder.DropTable(
                name: "ApprovalDecisions");

            migrationBuilder.DropTable(
                name: "DocumentRequirements");

            migrationBuilder.DropTable(
                name: "WorkflowDefinitions");

            migrationBuilder.DropTable(
                name: "DocumentApprovals");

            migrationBuilder.DropIndex(
                name: "IX_DocumentLinks_TenantId_DocumentId_TargetType_TargetId_Relat~",
                table: "DocumentLinks");

            migrationBuilder.DropIndex(
                name: "IX_DocumentLinks_TenantId_RequirementId",
                table: "DocumentLinks");

            migrationBuilder.DropColumn(
                name: "RequirementId",
                table: "DocumentLinks");

            migrationBuilder.CreateIndex(
                name: "IX_DocumentLinks_TenantId_DocumentId_TargetType_TargetId_Relat~",
                table: "DocumentLinks",
                columns: new[] { "TenantId", "DocumentId", "TargetType", "TargetId", "Relation" },
                unique: true);
        }
    }
}
