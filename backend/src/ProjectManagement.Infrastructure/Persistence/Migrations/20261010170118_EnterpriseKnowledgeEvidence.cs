using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class EnterpriseKnowledgeEvidence : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "SourcesJson",
                table: "AiMessages",
                type: "text",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "AiForecastSnapshots",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    JobId = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    EvidenceAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    AsOf = table.Column<DateOnly>(type: "date", nullable: false),
                    DueDate = table.Column<DateOnly>(type: "date", nullable: true),
                    ProjectedFinish = table.Column<DateOnly>(type: "date", nullable: true),
                    ProjectVersion = table.Column<int>(type: "integer", nullable: false),
                    TotalTasks = table.Column<int>(type: "integer", nullable: false),
                    OpenTasks = table.Column<int>(type: "integer", nullable: false),
                    FinishedLast28Days = table.Column<int>(type: "integer", nullable: false),
                    InputComplete = table.Column<bool>(type: "boolean", nullable: false),
                    Confidence = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    MethodologyVersion = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AiForecastSnapshots", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AiForecastSnapshots_TenantId_JobId_ProjectId",
                table: "AiForecastSnapshots",
                columns: new[] { "TenantId", "JobId", "ProjectId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_AiForecastSnapshots_TenantId_UserId_EvidenceAt",
                table: "AiForecastSnapshots",
                columns: new[] { "TenantId", "UserId", "EvidenceAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AiForecastSnapshots");

            migrationBuilder.DropColumn(
                name: "SourcesJson",
                table: "AiMessages");
        }
    }
}
