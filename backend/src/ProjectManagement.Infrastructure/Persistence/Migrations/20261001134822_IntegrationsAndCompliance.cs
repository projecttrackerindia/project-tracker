using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class IntegrationsAndCompliance : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "AuditCursorAt",
                table: "Webhooks",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Format",
                table: "Webhooks",
                type: "character varying(16)",
                maxLength: 16,
                nullable: false,
                defaultValue: "Json");

            migrationBuilder.CreateTable(
                name: "CalendarFeeds",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    TokenHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    TokenProtected = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    Prefix = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    LastUsedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CalendarFeeds", x => x.Id);
                    table.ForeignKey(
                        name: "FK_CalendarFeeds_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "DevLinks",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TaskId = table.Column<Guid>(type: "uuid", nullable: true),
                    WorkTaskId = table.Column<Guid>(type: "uuid", nullable: true),
                    Provider = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Kind = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    ExternalId = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    Title = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    Url = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    Repository = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    Author = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    State = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: true),
                    OccurredAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DevLinks", x => x.Id);
                    table.ForeignKey(
                        name: "FK_DevLinks_Tasks_TaskId",
                        column: x => x.TaskId,
                        principalTable: "Tasks",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_DevLinks_WorkTasks_WorkTaskId",
                        column: x => x.WorkTaskId,
                        principalTable: "WorkTasks",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "GitConnections",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Provider = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Name = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    Token = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    SecretProtected = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    CloseOnKeyword = table.Column<bool>(type: "boolean", nullable: false),
                    Received = table.Column<int>(type: "integer", nullable: false),
                    LastReceivedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LastError = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GitConnections", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "InboundMailboxes",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    Token = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    WorkTypeId = table.Column<Guid>(type: "uuid", nullable: true),
                    Priority = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Received = table.Column<int>(type: "integer", nullable: false),
                    LastReceivedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LastError = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    Day = table.Column<DateOnly>(type: "date", nullable: true),
                    DayCount = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_InboundMailboxes", x => x.Id);
                    table.ForeignKey(
                        name: "FK_InboundMailboxes_WorkTypes_WorkTypeId",
                        column: x => x.WorkTypeId,
                        principalTable: "WorkTypes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "TenantDataPolicies",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ActivityRetentionDays = table.Column<int>(type: "integer", nullable: true),
                    NotificationRetentionDays = table.Column<int>(type: "integer", nullable: true),
                    ChatRetentionDays = table.Column<int>(type: "integer", nullable: true),
                    AuditRetentionDays = table.Column<int>(type: "integer", nullable: true),
                    LastPurgedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TenantDataPolicies", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_CalendarFeeds_TenantId_UserId",
                table: "CalendarFeeds",
                columns: new[] { "TenantId", "UserId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_CalendarFeeds_TokenHash",
                table: "CalendarFeeds",
                column: "TokenHash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_CalendarFeeds_UserId",
                table: "CalendarFeeds",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_DevLinks_TaskId_OccurredAt",
                table: "DevLinks",
                columns: new[] { "TaskId", "OccurredAt" });

            migrationBuilder.CreateIndex(
                name: "IX_DevLinks_TenantId_Provider_Kind_ExternalId",
                table: "DevLinks",
                columns: new[] { "TenantId", "Provider", "Kind", "ExternalId" });

            migrationBuilder.CreateIndex(
                name: "IX_DevLinks_WorkTaskId_OccurredAt",
                table: "DevLinks",
                columns: new[] { "WorkTaskId", "OccurredAt" });

            migrationBuilder.CreateIndex(
                name: "IX_GitConnections_TenantId",
                table: "GitConnections",
                column: "TenantId");

            migrationBuilder.CreateIndex(
                name: "IX_GitConnections_Token",
                table: "GitConnections",
                column: "Token",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_InboundMailboxes_TenantId",
                table: "InboundMailboxes",
                column: "TenantId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_InboundMailboxes_Token",
                table: "InboundMailboxes",
                column: "Token",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_InboundMailboxes_WorkTypeId",
                table: "InboundMailboxes",
                column: "WorkTypeId");

            migrationBuilder.CreateIndex(
                name: "IX_TenantDataPolicies_TenantId",
                table: "TenantDataPolicies",
                column: "TenantId",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "CalendarFeeds");

            migrationBuilder.DropTable(
                name: "DevLinks");

            migrationBuilder.DropTable(
                name: "GitConnections");

            migrationBuilder.DropTable(
                name: "InboundMailboxes");

            migrationBuilder.DropTable(
                name: "TenantDataPolicies");

            migrationBuilder.DropColumn(
                name: "AuditCursorAt",
                table: "Webhooks");

            migrationBuilder.DropColumn(
                name: "Format",
                table: "Webhooks");
        }
    }
}
