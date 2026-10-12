using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class WhatsAppNotificationTemplates : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "OverdueTemplateState",
                table: "WhatsAppConnections",
                type: "character varying(20)",
                maxLength: 20,
                nullable: false,
                defaultValue: "unchecked");

            migrationBuilder.AddColumn<string>(
                name: "SupportUpdateTemplateState",
                table: "WhatsAppConnections",
                type: "character varying(20)",
                maxLength: 20,
                nullable: false,
                defaultValue: "unchecked");

            migrationBuilder.AddColumn<string>(
                name: "TaskAssignmentTemplateState",
                table: "WhatsAppConnections",
                type: "character varying(20)",
                maxLength: 20,
                nullable: false,
                defaultValue: "unchecked");

            migrationBuilder.AddColumn<DateTime>(
                name: "TemplatesAttemptedAt",
                table: "WhatsAppConnections",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "TemplatesCheckedAt",
                table: "WhatsAppConnections",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "TemplatesConfigurationHash",
                table: "WhatsAppConnections",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "TemplatesLeaseId",
                table: "WhatsAppConnections",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "TemplatesLeaseUntil",
                table: "WhatsAppConnections",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "TemplatesState",
                table: "WhatsAppConnections",
                type: "character varying(20)",
                maxLength: 20,
                nullable: false,
                defaultValue: "unchecked");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "OverdueTemplateState",
                table: "WhatsAppConnections");

            migrationBuilder.DropColumn(
                name: "SupportUpdateTemplateState",
                table: "WhatsAppConnections");

            migrationBuilder.DropColumn(
                name: "TaskAssignmentTemplateState",
                table: "WhatsAppConnections");

            migrationBuilder.DropColumn(
                name: "TemplatesAttemptedAt",
                table: "WhatsAppConnections");

            migrationBuilder.DropColumn(
                name: "TemplatesCheckedAt",
                table: "WhatsAppConnections");

            migrationBuilder.DropColumn(
                name: "TemplatesConfigurationHash",
                table: "WhatsAppConnections");

            migrationBuilder.DropColumn(
                name: "TemplatesLeaseId",
                table: "WhatsAppConnections");

            migrationBuilder.DropColumn(
                name: "TemplatesLeaseUntil",
                table: "WhatsAppConnections");

            migrationBuilder.DropColumn(
                name: "TemplatesState",
                table: "WhatsAppConnections");
        }
    }
}
