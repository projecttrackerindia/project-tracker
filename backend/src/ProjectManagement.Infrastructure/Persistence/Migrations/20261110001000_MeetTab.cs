using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Meet: each meeting's notetaker choice (0 = the project agent's settings decide, as for every meeting before this), replies to
    /// Project Tracker calls for workspace meetings (the organizer has accepted), and the meeting bot's mode, spoken lines and end-of-meeting
    /// check. Additive only.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261110001000_MeetTab")]
    public partial class MeetTab : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(name: "Notetaker", table: "ProjectMeetings", type: "integer", nullable: false, defaultValue: 0);
            migrationBuilder.AddColumn<int>(name: "Notetaker", table: "WorkspaceMeetings", type: "integer", nullable: false, defaultValue: 0);
            migrationBuilder.AddColumn<string>(name: "RsvpStatus", table: "WorkspaceMeetingAttendees", type: "character varying(16)", maxLength: 16, nullable: false, defaultValue: "NeedsAction");
            migrationBuilder.Sql("UPDATE \"WorkspaceMeetingAttendees\" SET \"RsvpStatus\" = 'Accepted' WHERE \"IsOrganizer\" = TRUE;");
            migrationBuilder.AddColumn<string>(name: "Mode", table: "AgentMeetingBots", type: "character varying(16)", maxLength: 16, nullable: true);
            migrationBuilder.AddColumn<string>(name: "PendingSay", table: "AgentMeetingBots", type: "text", nullable: true);
            migrationBuilder.AddColumn<DateTime>(name: "WrapUpAt", table: "AgentMeetingBots", type: "timestamp with time zone", nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "Notetaker", table: "ProjectMeetings");
            migrationBuilder.DropColumn(name: "Notetaker", table: "WorkspaceMeetings");
            migrationBuilder.DropColumn(name: "RsvpStatus", table: "WorkspaceMeetingAttendees");
            migrationBuilder.DropColumn(name: "Mode", table: "AgentMeetingBots");
            migrationBuilder.DropColumn(name: "PendingSay", table: "AgentMeetingBots");
            migrationBuilder.DropColumn(name: "WrapUpAt", table: "AgentMeetingBots");
        }
    }
}
