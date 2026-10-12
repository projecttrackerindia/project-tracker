using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class DurablePersonalEmailRecovery : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "DispatchKey",
                table: "PersonalEmailDrafts",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "ReconciledAt",
                table: "PersonalEmailDrafts",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "PersonalEmailRewrites",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    DraftId = table.Column<Guid>(type: "uuid", nullable: false),
                    OperationId = table.Column<Guid>(type: "uuid", nullable: false),
                    SourceVersion = table.Column<int>(type: "integer", nullable: false),
                    SourceHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Style = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Credits = table.Column<int>(type: "integer", nullable: false),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    ResultProtected = table.Column<string>(type: "character varying(128000)", maxLength: 128000, nullable: true),
                    Model = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    Deadline = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PersonalEmailRewrites", x => x.Id);
                    table.ForeignKey(
                        name: "FK_PersonalEmailRewrites_PersonalEmailDrafts_DraftId",
                        column: x => x.DraftId,
                        principalTable: "PersonalEmailDrafts",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_PersonalEmailRewrites_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_PersonalEmailDrafts_DispatchKey",
                table: "PersonalEmailDrafts",
                column: "DispatchKey",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_PersonalEmailRewrites_DraftId",
                table: "PersonalEmailRewrites",
                column: "DraftId");

            migrationBuilder.CreateIndex(
                name: "IX_PersonalEmailRewrites_ExpiresAt",
                table: "PersonalEmailRewrites",
                column: "ExpiresAt");

            migrationBuilder.CreateIndex(
                name: "IX_PersonalEmailRewrites_TenantId_OperationId",
                table: "PersonalEmailRewrites",
                columns: new[] { "TenantId", "OperationId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_PersonalEmailRewrites_TenantId_UserId_DraftId_ExpiresAt",
                table: "PersonalEmailRewrites",
                columns: new[] { "TenantId", "UserId", "DraftId", "ExpiresAt" });

            migrationBuilder.CreateIndex(
                name: "IX_PersonalEmailRewrites_UserId",
                table: "PersonalEmailRewrites",
                column: "UserId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "PersonalEmailRewrites");

            migrationBuilder.DropIndex(
                name: "IX_PersonalEmailDrafts_DispatchKey",
                table: "PersonalEmailDrafts");

            migrationBuilder.DropColumn(
                name: "DispatchKey",
                table: "PersonalEmailDrafts");

            migrationBuilder.DropColumn(
                name: "ReconciledAt",
                table: "PersonalEmailDrafts");
        }
    }
}
