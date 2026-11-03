using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Approvals and Notes: ApprovalRequests (a request with a type-specific payload, risk, links and status), ApprovalRequestSteps (its chain),
    /// ApprovalRequestEvents (its timeline), ApprovalPolicies (a workspace's default chain per type) and Notes. Reminders gain Flagged and
    /// ListName (the Flagged smart list and the person's own lists). New tables and two new columns; nothing existing changes.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261202001000_ApprovalsAndNotes")]
    public partial class ApprovalsAndNotes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(name: "Flagged", table: "Reminders", type: "boolean", nullable: false, defaultValue: false);
            migrationBuilder.AddColumn<string>(name: "ListName", table: "Reminders", type: "character varying(40)", maxLength: 40, nullable: true);

            migrationBuilder.CreateTable(
                name: "ApprovalPolicies",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ExpiryHours = table.Column<int>(type: "integer", nullable: true),
                    StepsJson = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    Type = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_ApprovalPolicies", x => x.Id));

            migrationBuilder.CreateIndex(name: "IX_ApprovalPolicies_TenantId_Type", table: "ApprovalPolicies", columns: new[] { "TenantId", "Type" }, unique: true);
            migrationBuilder.CreateTable(
                name: "ApprovalRequests",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    CurrentStep = table.Column<int>(type: "integer", nullable: false),
                    DecidedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Impact = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    LinksJson = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    Outcome = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    PayloadJson = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: false),
                    RequesterId = table.Column<Guid>(type: "uuid", nullable: false),
                    Risk = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Summary = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    Title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Type = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_ApprovalRequests", x => x.Id));

            migrationBuilder.CreateIndex(name: "IX_ApprovalRequests_TenantId_RequesterId", table: "ApprovalRequests", columns: new[] { "TenantId", "RequesterId" });
            migrationBuilder.CreateIndex(name: "IX_ApprovalRequests_TenantId_Status_CreatedAt", table: "ApprovalRequests", columns: new[] { "TenantId", "Status", "CreatedAt" });
            migrationBuilder.CreateTable(
                name: "ApprovalRequestEvents",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Action = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Comment = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    RequestId = table.Column<Guid>(type: "uuid", nullable: false),
                    StepOrder = table.Column<int>(type: "integer", nullable: true),
                    UserId = table.Column<Guid>(type: "uuid", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_ApprovalRequestEvents", x => x.Id));

            migrationBuilder.CreateIndex(name: "IX_ApprovalRequestEvents_TenantId_RequestId_CreatedAt", table: "ApprovalRequestEvents", columns: new[] { "TenantId", "RequestId", "CreatedAt" });
            migrationBuilder.CreateTable(
                name: "ApprovalRequestSteps",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ApproverId = table.Column<Guid>(type: "uuid", nullable: false),
                    Comment = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    DecidedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Order = table.Column<int>(type: "integer", nullable: false),
                    RequestId = table.Column<Guid>(type: "uuid", nullable: false),
                    Role = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_ApprovalRequestSteps", x => x.Id));

            migrationBuilder.CreateIndex(name: "IX_ApprovalRequestSteps_TenantId_ApproverId_Status", table: "ApprovalRequestSteps", columns: new[] { "TenantId", "ApproverId", "Status" });
            migrationBuilder.CreateIndex(name: "IX_ApprovalRequestSteps_TenantId_RequestId_Order", table: "ApprovalRequestSteps", columns: new[] { "TenantId", "RequestId", "Order" }, unique: true);
            migrationBuilder.CreateTable(
                name: "Notes",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ContentJson = table.Column<string>(type: "text", nullable: false),
                    DeletedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    DeletedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    Folder = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: true),
                    IsDeleted = table.Column<bool>(type: "boolean", nullable: false),
                    LinksJson = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    MeetingId = table.Column<Guid>(type: "uuid", nullable: true),
                    OwnerId = table.Column<Guid>(type: "uuid", nullable: false),
                    Pinned = table.Column<bool>(type: "boolean", nullable: false),
                    PlainText = table.Column<string>(type: "text", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: true),
                    SharedWithJson = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    Sharing = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Tags = table.Column<string>(type: "character varying(400)", maxLength: 400, nullable: false),
                    Title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_Notes", x => x.Id));

            migrationBuilder.CreateIndex(name: "IX_Notes_TenantId_OwnerId_UpdatedAt", table: "Notes", columns: new[] { "TenantId", "OwnerId", "UpdatedAt" });
            migrationBuilder.CreateIndex(name: "IX_Notes_TenantId_ProjectId", table: "Notes", columns: new[] { "TenantId", "ProjectId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "ApprovalPolicies");
            migrationBuilder.DropTable(name: "ApprovalRequests");
            migrationBuilder.DropTable(name: "ApprovalRequestEvents");
            migrationBuilder.DropTable(name: "ApprovalRequestSteps");
            migrationBuilder.DropTable(name: "Notes");
            migrationBuilder.DropColumn(name: "ListName", table: "Reminders");
            migrationBuilder.DropColumn(name: "Flagged", table: "Reminders");
        }
    }
}
