using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// The AI action log: one row per change an AI agent made {agent, action, target, approvedBy, at}, or - at "Ask first" - per piece of work
    /// waiting in someone's Home inbox. Then the agents' levels for workspaces that relied on the agents acting alone before Settings › AI
    /// existed: a project agent at autonomy level 4 ("delegate") in any project, and notetakers set to create tasks from the minutes, keep doing
    /// that (Auto). Every other workspace keeps the defaults, which match how the agents behaved before. A level an admin already chose is left alone.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261111002000_AiAgentActionLog")]
    public partial class AiAgentActionLog : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AiAgentActions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Agent = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Action = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    TargetType = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    TargetId = table.Column<Guid>(type: "uuid", nullable: true),
                    TargetKey = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: true),
                    Title = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    ForUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    ApprovedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    At = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Payload = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: true),
                    FindingId = table.Column<Guid>(type: "uuid", nullable: true),
                    Error = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    Link = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AiAgentActions", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_AiAgentActions_TenantId_FindingId", table: "AiAgentActions", columns: new[] { "TenantId", "FindingId" });
            migrationBuilder.CreateIndex(name: "IX_AiAgentActions_TenantId_ForUserId_Status", table: "AiAgentActions", columns: new[] { "TenantId", "ForUserId", "Status" });
            migrationBuilder.CreateIndex(name: "IX_AiAgentActions_TenantId_ProjectId_CreatedAt", table: "AiAgentActions", columns: new[] { "TenantId", "ProjectId", "CreatedAt" });
            migrationBuilder.CreateIndex(name: "IX_AiAgentActions_TenantId_TargetId", table: "AiAgentActions", columns: new[] { "TenantId", "TargetId" });

            // Levels are stored as {"agent": level}; 3 = Auto. Only where no level was chosen for that agent yet.
            migrationBuilder.Sql("""
                UPDATE "Tenants" t SET "AiAgentLevels" = (COALESCE(NULLIF(t."AiAgentLevels", ''), '{}')::jsonb || '{"project":3}'::jsonb)::text
                WHERE NOT (COALESCE(NULLIF(t."AiAgentLevels", ''), '{}')::jsonb ? 'project')
                  AND EXISTS (SELECT 1 FROM "ProjectAgentSettings" s WHERE s."TenantId" = t."Id" AND s."Enabled" AND s."AutonomyLevel" >= 4);
                """);
            migrationBuilder.Sql("""
                UPDATE "Tenants" t SET "AiAgentLevels" = (COALESCE(NULLIF(t."AiAgentLevels", ''), '{}')::jsonb || '{"notetaker":3}'::jsonb)::text
                WHERE NOT (COALESCE(NULLIF(t."AiAgentLevels", ''), '{}')::jsonb ? 'notetaker')
                  AND EXISTS (SELECT 1 FROM "NotetakerSettings" n WHERE n."TenantId" = t."Id" AND n."AutoTasks" AND n."AutoMinutes");
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "AiAgentActions");
        }
    }
}
