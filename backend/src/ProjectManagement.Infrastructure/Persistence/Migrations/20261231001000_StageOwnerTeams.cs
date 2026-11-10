using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Stages owned by a team: one nullable column on ProjectStages. Every existing stage keeps its person owner and no team.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261231001000_StageOwnerTeams")]
    public partial class StageOwnerTeams : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "OwnerTeamId",
                table: "ProjectStages",
                type: "uuid",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "OwnerTeamId", table: "ProjectStages");
        }
    }
}
