using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ProjectMeetingsAndGoogleConnection : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "GoogleConnections",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    GoogleEmail = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: false),
                    RefreshTokenProtected = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    AccessTokenProtected = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    AccessTokenExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Scopes = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    ConnectedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    LastSyncAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LastError = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GoogleConnections", x => x.Id);
                    table.ForeignKey(
                        name: "FK_GoogleConnections_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "ProjectMeetings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    OrganizerUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Description = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    StartTimeUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    EndTimeUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    TimeZone = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    GoogleCalendarEventId = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    GoogleMeetSpaceName = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    GoogleMeetUri = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    CancelledAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProjectMeetings", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ProjectMeetings_Projects_ProjectId",
                        column: x => x.ProjectId,
                        principalTable: "Projects",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_ProjectMeetings_Users_OrganizerUserId",
                        column: x => x.OrganizerUserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "MeetingParticipants",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    MeetingId = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: true),
                    Email = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: false),
                    Role = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    RsvpStatus = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    GoogleAttendeeId = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    IsRequired = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MeetingParticipants", x => x.Id);
                    table.ForeignKey(
                        name: "FK_MeetingParticipants_ProjectMeetings_MeetingId",
                        column: x => x.MeetingId,
                        principalTable: "ProjectMeetings",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_MeetingParticipants_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateIndex(
                name: "IX_GoogleConnections_TenantId_UserId",
                table: "GoogleConnections",
                columns: new[] { "TenantId", "UserId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_GoogleConnections_UserId",
                table: "GoogleConnections",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_MeetingParticipants_MeetingId_Email",
                table: "MeetingParticipants",
                columns: new[] { "MeetingId", "Email" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_MeetingParticipants_UserId",
                table: "MeetingParticipants",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_ProjectMeetings_GoogleCalendarEventId",
                table: "ProjectMeetings",
                column: "GoogleCalendarEventId");

            migrationBuilder.CreateIndex(
                name: "IX_ProjectMeetings_OrganizerUserId",
                table: "ProjectMeetings",
                column: "OrganizerUserId");

            migrationBuilder.CreateIndex(
                name: "IX_ProjectMeetings_ProjectId_StartTimeUtc",
                table: "ProjectMeetings",
                columns: new[] { "ProjectId", "StartTimeUtc" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "GoogleConnections");

            migrationBuilder.DropTable(
                name: "MeetingParticipants");

            migrationBuilder.DropTable(
                name: "ProjectMeetings");
        }
    }
}
