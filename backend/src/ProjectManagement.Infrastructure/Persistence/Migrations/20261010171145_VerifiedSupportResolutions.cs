using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class VerifiedSupportResolutions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "ResolutionAcceptedAt",
                table: "WorkTasks",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "ResolutionAcceptedBy",
                table: "WorkTasks",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "ResolutionDocumentId",
                table: "WorkTasks",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ResolutionDocumentVersion",
                table: "WorkTasks",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ResolutionNote",
                table: "WorkTasks",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "ResolutionProposedAt",
                table: "WorkTasks",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "ResolutionProposedBy",
                table: "WorkTasks",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "ResolutionWorkVersion",
                table: "WorkTasks",
                type: "integer",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ResolutionAcceptedAt",
                table: "WorkTasks");

            migrationBuilder.DropColumn(
                name: "ResolutionAcceptedBy",
                table: "WorkTasks");

            migrationBuilder.DropColumn(
                name: "ResolutionDocumentId",
                table: "WorkTasks");

            migrationBuilder.DropColumn(
                name: "ResolutionDocumentVersion",
                table: "WorkTasks");

            migrationBuilder.DropColumn(
                name: "ResolutionNote",
                table: "WorkTasks");

            migrationBuilder.DropColumn(
                name: "ResolutionProposedAt",
                table: "WorkTasks");

            migrationBuilder.DropColumn(
                name: "ResolutionProposedBy",
                table: "WorkTasks");

            migrationBuilder.DropColumn(
                name: "ResolutionWorkVersion",
                table: "WorkTasks");
        }
    }
}
