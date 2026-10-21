using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>DocTracker: each project's architecture and request-flow diagrams and integration notes. Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261102000300_ProjectArchitecture")]
    public partial class ProjectArchitecture : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ProjectArchitectures",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    DiagramsJson = table.Column<string>(type: "character varying(600000)", maxLength: 600000, nullable: false),
                    Notes = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_ProjectArchitectures", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_ProjectArchitectures_TenantId_ProjectId", table: "ProjectArchitectures", columns: new[] { "TenantId", "ProjectId" }, unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder) => migrationBuilder.DropTable(name: "ProjectArchitectures");
    }
}
