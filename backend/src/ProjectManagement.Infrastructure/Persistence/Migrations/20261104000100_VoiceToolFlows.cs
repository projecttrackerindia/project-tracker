using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Voice agent tools: how each API is used on a call (inputs, logic, the facts the agent may say). Additive only; existing tools keep working without one.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261104000100_VoiceToolFlows")]
    public partial class VoiceToolFlows : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(name: "FlowJson", table: "VoiceConnectors", type: "character varying(60000)", maxLength: 60000, nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "FlowJson", table: "VoiceConnectors");
        }
    }
}
