using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Meeting bots as a queue: bot workers ask for sessions, hold them with a lease, report on them and collect chat messages, so any number of
    /// workers can run and a session whose worker stops is picked up by another. Additive only.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261022000100_MeetingBotQueue")]
    public partial class MeetingBotQueue : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "WorkerId",
                table: "AgentMeetingBots",
                type: "character varying(100)",
                maxLength: 100,
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "LeaseUntil",
                table: "AgentMeetingBots",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "WorkerStatus",
                table: "AgentMeetingBots",
                type: "character varying(32)",
                maxLength: 32,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "PendingChat",
                table: "AgentMeetingBots",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "JoinPayload",
                table: "AgentMeetingBots",
                type: "text",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_AgentMeetingBots_Kind_Status_SessionStartUtc",
                table: "AgentMeetingBots",
                columns: new[] { "Kind", "Status", "SessionStartUtc" });

            migrationBuilder.CreateTable(
                name: "AgentBotWorkers",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    WorkerKey = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    Host = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    Version = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    Capacity = table.Column<int>(type: "integer", nullable: false),
                    Active = table.Column<int>(type: "integer", nullable: false),
                    Draining = table.Column<bool>(type: "boolean", nullable: false),
                    LastSeenAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AgentBotWorkers", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AgentBotWorkers_LastSeenAt",
                table: "AgentBotWorkers",
                column: "LastSeenAt");

            migrationBuilder.CreateIndex(
                name: "IX_AgentBotWorkers_WorkerKey",
                table: "AgentBotWorkers",
                column: "WorkerKey",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "AgentBotWorkers");
            migrationBuilder.DropIndex(name: "IX_AgentMeetingBots_Kind_Status_SessionStartUtc", table: "AgentMeetingBots");
            migrationBuilder.DropColumn(name: "WorkerId", table: "AgentMeetingBots");
            migrationBuilder.DropColumn(name: "LeaseUntil", table: "AgentMeetingBots");
            migrationBuilder.DropColumn(name: "WorkerStatus", table: "AgentMeetingBots");
            migrationBuilder.DropColumn(name: "PendingChat", table: "AgentMeetingBots");
            migrationBuilder.DropColumn(name: "JoinPayload", table: "AgentMeetingBots");
        }
    }
}
