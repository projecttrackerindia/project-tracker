using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class CertificationExpiryReminders : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "ExpiryReminders",
                table: "EmployeeCertifications",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<DateOnly>(
                name: "ReminderExpiry",
                table: "EmployeeCertifications",
                type: "date",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "ReminderStage",
                table: "EmployeeCertifications",
                type: "integer",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ExpiryReminders",
                table: "EmployeeCertifications");

            migrationBuilder.DropColumn(
                name: "ReminderExpiry",
                table: "EmployeeCertifications");

            migrationBuilder.DropColumn(
                name: "ReminderStage",
                table: "EmployeeCertifications");
        }
    }
}
