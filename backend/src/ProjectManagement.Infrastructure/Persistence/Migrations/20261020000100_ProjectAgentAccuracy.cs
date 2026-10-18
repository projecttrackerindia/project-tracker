using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// The project agent, more accurate and more useful: the lead's notes and speaker names, the meetings' caption language, calendar calls,
    /// minutes, Slack and WhatsApp as sources, whether a quote was found in its source, what approvers changed, and the assignee's answer.
    /// Additive only.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261020000100_ProjectAgentAccuracy")]
    public partial class ProjectAgentAccuracy : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "Instructions",
                table: "ProjectAgentSettings",
                type: "character varying(4000)",
                maxLength: 4000,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SpeakerAliases",
                table: "ProjectAgentSettings",
                type: "character varying(4000)",
                maxLength: 4000,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "CaptionLanguage",
                table: "ProjectAgentSettings",
                type: "character varying(16)",
                maxLength: 16,
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "AutoJoinCalendar",
                table: "ProjectAgentSettings",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "SendMinutes",
                table: "ProjectAgentSettings",
                type: "boolean",
                nullable: false,
                defaultValue: true);

            migrationBuilder.AddColumn<string>(
                name: "SlackChannelId",
                table: "ProjectAgentSettings",
                type: "character varying(32)",
                maxLength: 32,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SlackReadUntil",
                table: "ProjectAgentSettings",
                type: "character varying(32)",
                maxLength: 32,
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "ReadWhatsApp",
                table: "ProjectAgentSettings",
                type: "boolean",
                nullable: false,
                defaultValue: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "MinutesSentAt",
                table: "AgentRuns",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "Grounded",
                table: "AgentFindings",
                type: "boolean",
                nullable: false,
                defaultValue: true);

            migrationBuilder.AddColumn<string>(
                name: "Edits",
                table: "AgentFindings",
                type: "character varying(500)",
                maxLength: 500,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "OriginalTitle",
                table: "AgentFindings",
                type: "character varying(300)",
                maxLength: 300,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "OwnerResponse",
                table: "AgentFindings",
                type: "character varying(16)",
                maxLength: 16,
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "OwnerRespondedAt",
                table: "AgentFindings",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "OwnerNote",
                table: "AgentFindings",
                type: "character varying(500)",
                maxLength: 500,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "CalendarEventId",
                table: "AgentMeetingBots",
                type: "character varying(200)",
                maxLength: 200,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Title",
                table: "AgentMeetingBots",
                type: "character varying(300)",
                maxLength: 300,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "MeetUrl",
                table: "AgentMeetingBots",
                type: "character varying(300)",
                maxLength: 300,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_AgentFindings_AssigneeId",
                table: "AgentFindings",
                column: "AssigneeId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_AgentFindings_AssigneeId",
                table: "AgentFindings");

            migrationBuilder.DropColumn(
                name: "Instructions",
                table: "ProjectAgentSettings");

            migrationBuilder.DropColumn(
                name: "SpeakerAliases",
                table: "ProjectAgentSettings");

            migrationBuilder.DropColumn(
                name: "CaptionLanguage",
                table: "ProjectAgentSettings");

            migrationBuilder.DropColumn(
                name: "AutoJoinCalendar",
                table: "ProjectAgentSettings");

            migrationBuilder.DropColumn(
                name: "SendMinutes",
                table: "ProjectAgentSettings");

            migrationBuilder.DropColumn(
                name: "SlackChannelId",
                table: "ProjectAgentSettings");

            migrationBuilder.DropColumn(
                name: "SlackReadUntil",
                table: "ProjectAgentSettings");

            migrationBuilder.DropColumn(
                name: "ReadWhatsApp",
                table: "ProjectAgentSettings");

            migrationBuilder.DropColumn(
                name: "MinutesSentAt",
                table: "AgentRuns");

            migrationBuilder.DropColumn(
                name: "Grounded",
                table: "AgentFindings");

            migrationBuilder.DropColumn(
                name: "Edits",
                table: "AgentFindings");

            migrationBuilder.DropColumn(
                name: "OriginalTitle",
                table: "AgentFindings");

            migrationBuilder.DropColumn(
                name: "OwnerResponse",
                table: "AgentFindings");

            migrationBuilder.DropColumn(
                name: "OwnerRespondedAt",
                table: "AgentFindings");

            migrationBuilder.DropColumn(
                name: "OwnerNote",
                table: "AgentFindings");

            migrationBuilder.DropColumn(
                name: "CalendarEventId",
                table: "AgentMeetingBots");

            migrationBuilder.DropColumn(
                name: "Title",
                table: "AgentMeetingBots");

            migrationBuilder.DropColumn(
                name: "MeetUrl",
                table: "AgentMeetingBots");
        }
    }
}
