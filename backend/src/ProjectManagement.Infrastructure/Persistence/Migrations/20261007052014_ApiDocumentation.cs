using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ApiDocumentation : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "ApiHash",
                table: "Documents",
                type: "character varying(64)",
                maxLength: 64,
                nullable: false,
                defaultValue: "");

            migrationBuilder.CreateTable(
                name: "ApiDefinitions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    DocumentId = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    Description = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    BasePath = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    Version = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    Auth = table.Column<string>(type: "character varying(12)", maxLength: 12, nullable: false),
                    AuthNote = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    ServersJson = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    SortOrder = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ApiDefinitions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ApiDefinitions_Documents_DocumentId",
                        column: x => x.DocumentId,
                        principalTable: "Documents",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "ApiSnapshots",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    DocumentId = table.Column<Guid>(type: "uuid", nullable: false),
                    VersionId = table.Column<Guid>(type: "uuid", nullable: false),
                    DefinitionsJson = table.Column<string>(type: "text", nullable: false),
                    EndpointCount = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ApiSnapshots", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ApiSnapshots_DocumentVersions_VersionId",
                        column: x => x.VersionId,
                        principalTable: "DocumentVersions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "EndpointRevisions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    DocumentId = table.Column<Guid>(type: "uuid", nullable: false),
                    VersionId = table.Column<Guid>(type: "uuid", nullable: false),
                    DefinitionId = table.Column<Guid>(type: "uuid", nullable: false),
                    DefinitionName = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    EndpointId = table.Column<Guid>(type: "uuid", nullable: false),
                    Method = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    Path = table.Column<string>(type: "character varying(400)", maxLength: 400, nullable: false),
                    Summary = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    Tag = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: true),
                    Deprecated = table.Column<bool>(type: "boolean", nullable: false),
                    OwnerId = table.Column<Guid>(type: "uuid", nullable: true),
                    DetailsJson = table.Column<string>(type: "text", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_EndpointRevisions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_EndpointRevisions_DocumentVersions_VersionId",
                        column: x => x.VersionId,
                        principalTable: "DocumentVersions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "ApiEndpoints",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    DocumentId = table.Column<Guid>(type: "uuid", nullable: false),
                    DefinitionId = table.Column<Guid>(type: "uuid", nullable: false),
                    Method = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    Path = table.Column<string>(type: "character varying(400)", maxLength: 400, nullable: false),
                    Summary = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    Tag = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: true),
                    Deprecated = table.Column<bool>(type: "boolean", nullable: false),
                    OwnerId = table.Column<Guid>(type: "uuid", nullable: true),
                    DetailsJson = table.Column<string>(type: "text", nullable: false),
                    Hash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ApiEndpoints", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ApiEndpoints_ApiDefinitions_DefinitionId",
                        column: x => x.DefinitionId,
                        principalTable: "ApiDefinitions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_ApiEndpoints_Documents_DocumentId",
                        column: x => x.DocumentId,
                        principalTable: "Documents",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ApiDefinitions_DocumentId",
                table: "ApiDefinitions",
                column: "DocumentId");

            migrationBuilder.CreateIndex(
                name: "IX_ApiDefinitions_TenantId_DocumentId_Name",
                table: "ApiDefinitions",
                columns: new[] { "TenantId", "DocumentId", "Name" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ApiEndpoints_DefinitionId",
                table: "ApiEndpoints",
                column: "DefinitionId");

            migrationBuilder.CreateIndex(
                name: "IX_ApiEndpoints_DocumentId",
                table: "ApiEndpoints",
                column: "DocumentId");

            migrationBuilder.CreateIndex(
                name: "IX_ApiEndpoints_TenantId_DefinitionId_Path_Method",
                table: "ApiEndpoints",
                columns: new[] { "TenantId", "DefinitionId", "Path", "Method" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ApiEndpoints_TenantId_DocumentId",
                table: "ApiEndpoints",
                columns: new[] { "TenantId", "DocumentId" });

            migrationBuilder.CreateIndex(
                name: "IX_ApiEndpoints_TenantId_Path",
                table: "ApiEndpoints",
                columns: new[] { "TenantId", "Path" });

            migrationBuilder.CreateIndex(
                name: "IX_ApiSnapshots_TenantId_VersionId",
                table: "ApiSnapshots",
                columns: new[] { "TenantId", "VersionId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ApiSnapshots_VersionId",
                table: "ApiSnapshots",
                column: "VersionId");

            migrationBuilder.CreateIndex(
                name: "IX_EndpointRevisions_TenantId_VersionId_DefinitionName_Path_Me~",
                table: "EndpointRevisions",
                columns: new[] { "TenantId", "VersionId", "DefinitionName", "Path", "Method" });

            migrationBuilder.CreateIndex(
                name: "IX_EndpointRevisions_VersionId",
                table: "EndpointRevisions",
                column: "VersionId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ApiEndpoints");

            migrationBuilder.DropTable(
                name: "ApiSnapshots");

            migrationBuilder.DropTable(
                name: "EndpointRevisions");

            migrationBuilder.DropTable(
                name: "ApiDefinitions");

            migrationBuilder.DropColumn(
                name: "ApiHash",
                table: "Documents");
        }
    }
}
