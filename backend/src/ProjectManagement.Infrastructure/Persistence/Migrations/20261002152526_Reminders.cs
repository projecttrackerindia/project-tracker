using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class Reminders : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ReminderPolicies",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    EscalationEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    Steps = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ReminderPolicies", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ReminderSettings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    WorkDays = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    WorkStart = table.Column<TimeOnly>(type: "time without time zone", nullable: false),
                    WorkEnd = table.Column<TimeOnly>(type: "time without time zone", nullable: false),
                    QuietStart = table.Column<TimeOnly>(type: "time without time zone", nullable: true),
                    QuietEnd = table.Column<TimeOnly>(type: "time without time zone", nullable: true),
                    DefaultTime = table.Column<TimeOnly>(type: "time without time zone", nullable: false),
                    AutoEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    DueLeads = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    OverdueSteps = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    DailyAutoLimit = table.Column<int>(type: "integer", nullable: false),
                    BriefingEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    BriefingTime = table.Column<TimeOnly>(type: "time without time zone", nullable: false),
                    LastBriefingDay = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: true),
                    FollowDeviceTimeZone = table.Column<bool>(type: "boolean", nullable: false),
                    MuteNudges = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ReminderSettings", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ReminderSettings_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "Reminders",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Source = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Note = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    TargetType = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    TargetId = table.Column<Guid>(type: "uuid", nullable: true),
                    TargetKey = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    TargetTitle = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    TargetProjectId = table.Column<Guid>(type: "uuid", nullable: true),
                    Link = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    TimeZone = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    LocalAt = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    AnchorDays = table.Column<int>(type: "integer", nullable: true),
                    AnchorTime = table.Column<TimeOnly>(type: "time without time zone", nullable: true),
                    Recurrence = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    OnlyIfOpen = table.Column<bool>(type: "boolean", nullable: false),
                    Exact = table.Column<bool>(type: "boolean", nullable: false),
                    State = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    NextFireAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    IsSnoozed = table.Column<bool>(type: "boolean", nullable: false),
                    SnoozeCount = table.Column<int>(type: "integer", nullable: false),
                    FireCount = table.Column<int>(type: "integer", nullable: false),
                    LastFiredAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Quiet = table.Column<bool>(type: "boolean", nullable: false),
                    CompletedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    SeriesId = table.Column<Guid>(type: "uuid", nullable: true),
                    SystemKey = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: true),
                    LockToken = table.Column<Guid>(type: "uuid", nullable: true),
                    LockedUntil = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ActionTokenHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    ActionTokenExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Reminders", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ReminderPolicies_TenantId",
                table: "ReminderPolicies",
                column: "TenantId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ReminderSettings_UserId",
                table: "ReminderSettings",
                column: "UserId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Reminders_ActionTokenHash",
                table: "Reminders",
                column: "ActionTokenHash");

            migrationBuilder.CreateIndex(
                name: "IX_Reminders_CreatedBy",
                table: "Reminders",
                column: "CreatedBy");

            migrationBuilder.CreateIndex(
                name: "IX_Reminders_State_NextFireAt",
                table: "Reminders",
                columns: new[] { "State", "NextFireAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Reminders_TargetType_TargetId",
                table: "Reminders",
                columns: new[] { "TargetType", "TargetId" });

            migrationBuilder.CreateIndex(
                name: "IX_Reminders_TenantId_SystemKey",
                table: "Reminders",
                columns: new[] { "TenantId", "SystemKey" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Reminders_TenantId_UserId_State",
                table: "Reminders",
                columns: new[] { "TenantId", "UserId", "State" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ReminderPolicies");

            migrationBuilder.DropTable(
                name: "ReminderSettings");

            migrationBuilder.DropTable(
                name: "Reminders");
        }
    }
}
