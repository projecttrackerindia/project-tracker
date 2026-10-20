using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Notetaker: the bot's signed-in Google accounts, each person's notetaker settings and meeting minutes. Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261029000100_Notetaker")]
    public partial class Notetaker : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "MeetingBotIdentities",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Email = table.Column<string>(type: "character varying(254)", maxLength: 254, nullable: false),
                    DisplayName = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    CookiesProtected = table.Column<string>(type: "character varying(400000)", maxLength: 400000, nullable: false),
                    Active = table.Column<bool>(type: "boolean", nullable: false),
                    LastUsedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LastError = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    LastErrorAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table => table.PrimaryKey("PK_MeetingBotIdentities", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_MeetingBotIdentities_Email", table: "MeetingBotIdentities", column: "Email", unique: true);

            migrationBuilder.CreateTable(
                name: "NotetakerSettings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: true),
                    AutoJoin = table.Column<bool>(type: "boolean", nullable: false),
                    AutoMinutes = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_NotetakerSettings", x => x.Id);
                    table.ForeignKey(name: "FK_NotetakerSettings_Users_UserId", column: x => x.UserId, principalTable: "Users", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(name: "FK_NotetakerSettings_Projects_ProjectId", column: x => x.ProjectId, principalTable: "Projects", principalColumn: "Id", onDelete: ReferentialAction.SetNull);
                });
            migrationBuilder.CreateIndex(name: "IX_NotetakerSettings_TenantId_UserId", table: "NotetakerSettings", columns: new[] { "TenantId", "UserId" }, unique: true);
            migrationBuilder.CreateIndex(name: "IX_NotetakerSettings_UserId", table: "NotetakerSettings", column: "UserId");
            migrationBuilder.CreateIndex(name: "IX_NotetakerSettings_ProjectId", table: "NotetakerSettings", column: "ProjectId");

            migrationBuilder.CreateTable(
                name: "MeetingMinutes",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    BotRowId = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Title = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    ContentProtected = table.Column<string>(type: "character varying(200000)", maxLength: 200000, nullable: false),
                    Status = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    SentAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Model = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MeetingMinutes", x => x.Id);
                    table.ForeignKey(name: "FK_MeetingMinutes_AgentMeetingBots_BotRowId", column: x => x.BotRowId, principalTable: "AgentMeetingBots", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(name: "FK_MeetingMinutes_Users_UserId", column: x => x.UserId, principalTable: "Users", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
                });
            migrationBuilder.CreateIndex(name: "IX_MeetingMinutes_BotRowId", table: "MeetingMinutes", column: "BotRowId", unique: true);
            migrationBuilder.CreateIndex(name: "IX_MeetingMinutes_TenantId_UserId", table: "MeetingMinutes", columns: new[] { "TenantId", "UserId" });
            migrationBuilder.CreateIndex(name: "IX_MeetingMinutes_UserId", table: "MeetingMinutes", column: "UserId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "MeetingMinutes");
            migrationBuilder.DropTable(name: "NotetakerSettings");
            migrationBuilder.DropTable(name: "MeetingBotIdentities");
        }
    }
}
