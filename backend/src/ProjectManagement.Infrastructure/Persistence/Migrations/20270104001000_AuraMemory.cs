using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Aura's memory: short notes about how a person, a team or the workspace likes to work, saved only from a card the person confirmed.
    /// Plus two workspace switches: memory on (default on) and workspace-wide memories on (default off until an admin enables them).
    /// Additive only; nothing existing changes.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20270104001000_AuraMemory")]
    public partial class AuraMemory : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(name: "AiMemoryEnabled", table: "Tenants", type: "boolean", nullable: false, defaultValue: true);
            migrationBuilder.AddColumn<bool>(name: "AiWorkspaceMemoryEnabled", table: "Tenants", type: "boolean", nullable: false, defaultValue: false);
            migrationBuilder.CreateTable(
                name: "AiMemories",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Scope = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    OwnerUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    TeamId = table.Column<Guid>(type: "uuid", nullable: true),
                    Text = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    Source = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    LastUsedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AiMemories", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_AiMemories_TenantId_Scope_OwnerUserId", table: "AiMemories", columns: new[] { "TenantId", "Scope", "OwnerUserId" });
            migrationBuilder.CreateIndex(name: "IX_AiMemories_TenantId_TeamId", table: "AiMemories", columns: new[] { "TenantId", "TeamId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "AiMemories");
            migrationBuilder.DropColumn(name: "AiMemoryEnabled", table: "Tenants");
            migrationBuilder.DropColumn(name: "AiWorkspaceMemoryEnabled", table: "Tenants");
        }
    }
}
