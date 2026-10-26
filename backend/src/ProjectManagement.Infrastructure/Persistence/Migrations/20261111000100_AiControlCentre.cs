using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// AI control centre: what each agent may do in a workspace (Off, Suggest, Ask first, Auto), as one small JSON column on the workspace.
    /// Null keeps every agent on its default, so existing workspaces behave as before. Additive only.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261111000100_AiControlCentre")]
    public partial class AiControlCentre : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(name: "AiAgentLevels", table: "Tenants", type: "character varying(512)", maxLength: 512, nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "AiAgentLevels", table: "Tenants");
        }
    }
}
