using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AiEfficiencyAndLearning : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "CacheReadTokens",
                table: "AiMessages",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "CacheWriteTokens",
                table: "AiMessages",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "Feedback",
                table: "AiMessages",
                type: "character varying(8)",
                maxLength: 8,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "FeedbackReason",
                table: "AiMessages",
                type: "character varying(24)",
                maxLength: 24,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "FollowUpsJson",
                table: "AiMessages",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "UnverifiedJson",
                table: "AiMessages",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "SummarizedThroughAt",
                table: "AiConversations",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Summary",
                table: "AiConversations",
                type: "text",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "AiUserProfiles",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    DetailLevel = table.Column<int>(type: "integer", nullable: false),
                    Notes = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    CountersJson = table.Column<string>(type: "text", nullable: true),
                    LearnedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AiUserProfiles", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AiUserProfiles_TenantId_UserId",
                table: "AiUserProfiles",
                columns: new[] { "TenantId", "UserId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AiUserProfiles");

            migrationBuilder.DropColumn(
                name: "CacheReadTokens",
                table: "AiMessages");

            migrationBuilder.DropColumn(
                name: "CacheWriteTokens",
                table: "AiMessages");

            migrationBuilder.DropColumn(
                name: "Feedback",
                table: "AiMessages");

            migrationBuilder.DropColumn(
                name: "FeedbackReason",
                table: "AiMessages");

            migrationBuilder.DropColumn(
                name: "FollowUpsJson",
                table: "AiMessages");

            migrationBuilder.DropColumn(
                name: "UnverifiedJson",
                table: "AiMessages");

            migrationBuilder.DropColumn(
                name: "SummarizedThroughAt",
                table: "AiConversations");

            migrationBuilder.DropColumn(
                name: "Summary",
                table: "AiConversations");
        }
    }
}
