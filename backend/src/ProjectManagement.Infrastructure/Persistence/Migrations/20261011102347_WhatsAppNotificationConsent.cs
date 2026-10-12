using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class WhatsAppNotificationConsent : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "NotificationConsentAt",
                table: "WhatsAppContactLinks",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "NotificationConsentExpiresAt",
                table: "WhatsAppContactLinks",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "NotificationConsentVersion",
                table: "WhatsAppContactLinks",
                type: "character varying(80)",
                maxLength: 80,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "NotificationPreferencesVersion",
                table: "WhatsAppContactLinks",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "NotificationQuietEndMinutes",
                table: "WhatsAppContactLinks",
                type: "integer",
                nullable: false,
                defaultValue: 480);

            migrationBuilder.AddColumn<int>(
                name: "NotificationQuietStartMinutes",
                table: "WhatsAppContactLinks",
                type: "integer",
                nullable: false,
                defaultValue: 1320);

            migrationBuilder.AddColumn<string>(
                name: "NotificationTimeZone",
                table: "WhatsAppContactLinks",
                type: "character varying(100)",
                maxLength: 100,
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "NotifyOverdue",
                table: "WhatsAppContactLinks",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "NotifySupportUpdates",
                table: "WhatsAppContactLinks",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "NotifyTaskAssignments",
                table: "WhatsAppContactLinks",
                type: "boolean",
                nullable: false,
                defaultValue: false);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "NotificationConsentAt",
                table: "WhatsAppContactLinks");

            migrationBuilder.DropColumn(
                name: "NotificationConsentExpiresAt",
                table: "WhatsAppContactLinks");

            migrationBuilder.DropColumn(
                name: "NotificationConsentVersion",
                table: "WhatsAppContactLinks");

            migrationBuilder.DropColumn(
                name: "NotificationPreferencesVersion",
                table: "WhatsAppContactLinks");

            migrationBuilder.DropColumn(
                name: "NotificationQuietEndMinutes",
                table: "WhatsAppContactLinks");

            migrationBuilder.DropColumn(
                name: "NotificationQuietStartMinutes",
                table: "WhatsAppContactLinks");

            migrationBuilder.DropColumn(
                name: "NotificationTimeZone",
                table: "WhatsAppContactLinks");

            migrationBuilder.DropColumn(
                name: "NotifyOverdue",
                table: "WhatsAppContactLinks");

            migrationBuilder.DropColumn(
                name: "NotifySupportUpdates",
                table: "WhatsAppContactLinks");

            migrationBuilder.DropColumn(
                name: "NotifyTaskAssignments",
                table: "WhatsAppContactLinks");
        }
    }
}
