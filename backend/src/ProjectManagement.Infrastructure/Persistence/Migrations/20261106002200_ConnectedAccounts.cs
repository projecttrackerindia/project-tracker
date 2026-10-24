using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Connected accounts: where each meeting lives (Google Meet, Teams or our own call), each person's meeting and Slack choices, their
    /// own Slack link, Slack direct messages for notifications, and calls held for workspace meetings. Additive only: every
    /// existing meeting stays a Google meeting (Provider 0).
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261106002200_ConnectedAccounts")]
    public partial class ConnectedAccounts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(name: "Provider", table: "ProjectMeetings", type: "integer", nullable: false, defaultValue: 0);
            migrationBuilder.AddColumn<int>(name: "Provider", table: "WorkspaceMeetings", type: "integer", nullable: false, defaultValue: 0);
            migrationBuilder.AddColumn<Guid>(name: "WorkspaceMeetingId", table: "CallRooms", type: "uuid", nullable: true);
            migrationBuilder.AddColumn<bool>(name: "SlackPending", table: "Notifications", type: "boolean", nullable: false, defaultValue: false);
            migrationBuilder.AddColumn<DateTime>(name: "SlackSentAt", table: "Notifications", type: "timestamp with time zone", nullable: true);

            migrationBuilder.CreateTable(
                name: "PersonalConnectionSettings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    MeetingService = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false, defaultValue: "auto"),
                    SlackMessages = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false, defaultValue: "off"),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PersonalConnectionSettings", x => x.Id);
                    table.ForeignKey(name: "FK_PersonalConnectionSettings_Users_UserId", column: x => x.UserId, principalTable: "Users", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "SlackUserLinks",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    SlackTeamId = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    SlackUserId = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    Email = table.Column<string>(type: "character varying(254)", maxLength: 254, nullable: true),
                    ConnectedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    LastError = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SlackUserLinks", x => x.Id);
                    table.ForeignKey(name: "FK_SlackUserLinks_Users_UserId", column: x => x.UserId, principalTable: "Users", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(name: "IX_PersonalConnectionSettings_TenantId_UserId", table: "PersonalConnectionSettings", columns: new[] { "TenantId", "UserId" }, unique: true);
            migrationBuilder.CreateIndex(name: "IX_PersonalConnectionSettings_UserId", table: "PersonalConnectionSettings", column: "UserId");
            migrationBuilder.CreateIndex(name: "IX_SlackUserLinks_TenantId_UserId", table: "SlackUserLinks", columns: new[] { "TenantId", "UserId" }, unique: true);
            migrationBuilder.CreateIndex(name: "IX_SlackUserLinks_TenantId_SlackUserId", table: "SlackUserLinks", columns: new[] { "TenantId", "SlackUserId" }, unique: true);
            migrationBuilder.CreateIndex(name: "IX_SlackUserLinks_UserId", table: "SlackUserLinks", column: "UserId");
            migrationBuilder.CreateIndex(name: "IX_Notifications_SlackPending", table: "Notifications", column: "SlackPending");
            migrationBuilder.CreateIndex(name: "IX_CallRooms_TenantId_MeetingId", table: "CallRooms", columns: new[] { "TenantId", "MeetingId" });
            migrationBuilder.CreateIndex(name: "IX_CallRooms_TenantId_WorkspaceMeetingId", table: "CallRooms", columns: new[] { "TenantId", "WorkspaceMeetingId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "SlackUserLinks");
            migrationBuilder.DropTable(name: "PersonalConnectionSettings");
            migrationBuilder.DropIndex(name: "IX_Notifications_SlackPending", table: "Notifications");
            migrationBuilder.DropIndex(name: "IX_CallRooms_TenantId_MeetingId", table: "CallRooms");
            migrationBuilder.DropIndex(name: "IX_CallRooms_TenantId_WorkspaceMeetingId", table: "CallRooms");
            migrationBuilder.DropColumn(name: "SlackSentAt", table: "Notifications");
            migrationBuilder.DropColumn(name: "SlackPending", table: "Notifications");
            migrationBuilder.DropColumn(name: "WorkspaceMeetingId", table: "CallRooms");
            migrationBuilder.DropColumn(name: "Provider", table: "WorkspaceMeetings");
            migrationBuilder.DropColumn(name: "Provider", table: "ProjectMeetings");
        }
    }
}
