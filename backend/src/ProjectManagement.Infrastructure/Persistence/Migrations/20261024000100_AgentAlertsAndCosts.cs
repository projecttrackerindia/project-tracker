using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Agent alerts and the weekly summary (workspace thresholds), a monthly AI-credit cap per project agent, "not now" to autonomy suggestions,
    /// and why a proposal was dismissed. Additive only.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261024000100_AgentAlertsAndCosts")]
    public partial class AgentAlertsAndCosts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(name: "MonthlyCreditCap", table: "ProjectAgentSettings", type: "integer", nullable: false, defaultValue: 0);
            migrationBuilder.AddColumn<string>(name: "AutonomyHintsDismissed", table: "ProjectAgentSettings", type: "character varying(200)", maxLength: 200, nullable: true);
            migrationBuilder.AddColumn<string>(name: "DismissReason", table: "AgentFindings", type: "character varying(32)", maxLength: 32, nullable: true);

            migrationBuilder.AddColumn<bool>(name: "AlertsEnabled", table: "AgentWorkspaceSettings", type: "boolean", nullable: false, defaultValue: true);
            migrationBuilder.AddColumn<int>(name: "AlertMinSuccessRate", table: "AgentWorkspaceSettings", type: "integer", nullable: false, defaultValue: 80);
            migrationBuilder.AddColumn<int>(name: "AlertMaxP95Seconds", table: "AgentWorkspaceSettings", type: "integer", nullable: false, defaultValue: 30);
            migrationBuilder.AddColumn<int>(name: "AlertBotFailures", table: "AgentWorkspaceSettings", type: "integer", nullable: false, defaultValue: 2);
            migrationBuilder.AddColumn<int>(name: "AlertReadingFailures", table: "AgentWorkspaceSettings", type: "integer", nullable: false, defaultValue: 3);
            migrationBuilder.AddColumn<int>(name: "AlertCreditDays", table: "AgentWorkspaceSettings", type: "integer", nullable: false, defaultValue: 5);
            migrationBuilder.AddColumn<bool>(name: "WeeklyDigest", table: "AgentWorkspaceSettings", type: "boolean", nullable: false, defaultValue: true);
            migrationBuilder.AddColumn<DateTime>(name: "AlertsCheckedAt", table: "AgentWorkspaceSettings", type: "timestamp with time zone", nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "MonthlyCreditCap", table: "ProjectAgentSettings");
            migrationBuilder.DropColumn(name: "AutonomyHintsDismissed", table: "ProjectAgentSettings");
            migrationBuilder.DropColumn(name: "DismissReason", table: "AgentFindings");
            migrationBuilder.DropColumn(name: "AlertsEnabled", table: "AgentWorkspaceSettings");
            migrationBuilder.DropColumn(name: "AlertMinSuccessRate", table: "AgentWorkspaceSettings");
            migrationBuilder.DropColumn(name: "AlertMaxP95Seconds", table: "AgentWorkspaceSettings");
            migrationBuilder.DropColumn(name: "AlertBotFailures", table: "AgentWorkspaceSettings");
            migrationBuilder.DropColumn(name: "AlertReadingFailures", table: "AgentWorkspaceSettings");
            migrationBuilder.DropColumn(name: "AlertCreditDays", table: "AgentWorkspaceSettings");
            migrationBuilder.DropColumn(name: "WeeklyDigest", table: "AgentWorkspaceSettings");
            migrationBuilder.DropColumn(name: "AlertsCheckedAt", table: "AgentWorkspaceSettings");
        }
    }
}
