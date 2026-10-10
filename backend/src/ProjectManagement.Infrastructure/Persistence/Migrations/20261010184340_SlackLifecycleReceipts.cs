using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class SlackLifecycleReceipts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "SlackEventReceipts",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    AppId = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    TeamId = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    EventId = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    ReceivedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SlackEventReceipts", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_SlackEventReceipts_AppId_TeamId_EventId",
                table: "SlackEventReceipts",
                columns: new[] { "AppId", "TeamId", "EventId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SlackEventReceipts_ReceivedAt",
                table: "SlackEventReceipts",
                column: "ReceivedAt");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "SlackEventReceipts");
        }
    }
}
