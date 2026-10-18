using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Additive only (new columns with safe defaults, new tables, new indexes), so it is also applied to SQLite development databases:
    /// <list type="bullet">
    /// <item>Notifications.DeliverAfter - e-mail and push created during someone's quiet hours wait until they end; plus an index for the inbox.</item>
    /// <item>InvoiceSequences - one unbroken tax-invoice sequence per Indian financial year.</item>
    /// <item>ProjectMeetings.IsScrum / LastSummaryDay - stand-up calls post a daily summary to the project chat.</item>
    /// <item>WorkspaceMeetings (+ attendees) - meetings for the workspace as a whole, shown on the Calendar of everyone invited.</item>
    /// <item>DocumentTypes.RequiredForProjects - document kinds every active project is expected to have.</item>
    /// </list>
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261018000300_MeetingsQuietHoursInvoicesRequiredDocs")]
    public partial class MeetingsQuietHoursInvoicesRequiredDocs : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "DeliverAfter",
                table: "Notifications",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_Notifications_UserId_CreatedAt",
                table: "Notifications",
                columns: new[] { "UserId", "CreatedAt" });

            migrationBuilder.AddColumn<bool>(
                name: "RequiredForProjects",
                table: "DocumentTypes",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "IsScrum",
                table: "ProjectMeetings",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "LastSummaryDay",
                table: "ProjectMeetings",
                type: "character varying(8)",
                maxLength: 8,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "InvoiceSequences",
                columns: table => new
                {
                    FinancialYear = table.Column<string>(type: "character varying(9)", maxLength: 9, nullable: false),
                    LastNumber = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_InvoiceSequences", x => x.FinancialYear);
                });

            migrationBuilder.CreateTable(
                name: "WorkspaceMeetings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    OrganizerUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Description = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    StartTimeUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    EndTimeUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    TimeZone = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    RecurrenceRule = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    CalendarUrl = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    GoogleCalendarEventId = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    GoogleMeetUri = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    IsScrum = table.Column<bool>(type: "boolean", nullable: false),
                    CancelledAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WorkspaceMeetings", x => x.Id);
                    table.ForeignKey(
                        name: "FK_WorkspaceMeetings_Users_OrganizerUserId",
                        column: x => x.OrganizerUserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "WorkspaceMeetingAttendees",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    MeetingId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Email = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: false),
                    IsOrganizer = table.Column<bool>(type: "boolean", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WorkspaceMeetingAttendees", x => x.Id);
                    table.ForeignKey(
                        name: "FK_WorkspaceMeetingAttendees_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_WorkspaceMeetingAttendees_WorkspaceMeetings_MeetingId",
                        column: x => x.MeetingId,
                        principalTable: "WorkspaceMeetings",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_WorkspaceMeetings_OrganizerUserId",
                table: "WorkspaceMeetings",
                column: "OrganizerUserId");

            migrationBuilder.CreateIndex(
                name: "IX_WorkspaceMeetings_TenantId_StartTimeUtc",
                table: "WorkspaceMeetings",
                columns: new[] { "TenantId", "StartTimeUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_WorkspaceMeetingAttendees_MeetingId_UserId",
                table: "WorkspaceMeetingAttendees",
                columns: new[] { "MeetingId", "UserId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_WorkspaceMeetingAttendees_UserId",
                table: "WorkspaceMeetingAttendees",
                column: "UserId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "WorkspaceMeetingAttendees");
            migrationBuilder.DropTable(name: "WorkspaceMeetings");
            migrationBuilder.DropTable(name: "InvoiceSequences");
            migrationBuilder.DropIndex(name: "IX_Notifications_UserId_CreatedAt", table: "Notifications");
            migrationBuilder.DropColumn(name: "DeliverAfter", table: "Notifications");
            migrationBuilder.DropColumn(name: "RequiredForProjects", table: "DocumentTypes");
            migrationBuilder.DropColumn(name: "IsScrum", table: "ProjectMeetings");
            migrationBuilder.DropColumn(name: "LastSummaryDay", table: "ProjectMeetings");
        }
    }
}
