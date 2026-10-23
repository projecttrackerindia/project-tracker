using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Documents release 2: verified and out-of-date pages, comment threads on selected text, and pages that write themselves (proposals). Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261106001400_DocumentsRelease2")]
    public partial class DocumentsRelease2 : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(name: "VerifiedAt", table: "Documents", type: "timestamp with time zone", nullable: true);
            migrationBuilder.AddColumn<Guid>(name: "VerifiedBy", table: "Documents", type: "uuid", nullable: true);
            migrationBuilder.AddColumn<DateTime>(name: "StaleSince", table: "Documents", type: "timestamp with time zone", nullable: true);
            migrationBuilder.AddColumn<string>(name: "StaleReason", table: "Documents", type: "character varying(500)", maxLength: 500, nullable: true);
            migrationBuilder.AddColumn<DateTime>(name: "StaleNotifiedAt", table: "Documents", type: "timestamp with time zone", nullable: true);

            migrationBuilder.AddColumn<Guid>(name: "ParentId", table: "DocumentComments", type: "uuid", nullable: true);
            migrationBuilder.AddColumn<string>(name: "AnchorId", table: "DocumentComments", type: "character varying(40)", maxLength: 40, nullable: true);
            migrationBuilder.AddColumn<string>(name: "Quote", table: "DocumentComments", type: "character varying(500)", maxLength: 500, nullable: true);
            migrationBuilder.AddColumn<DateTime>(name: "ResolvedAt", table: "DocumentComments", type: "timestamp with time zone", nullable: true);
            migrationBuilder.AddColumn<Guid>(name: "ResolvedBy", table: "DocumentComments", type: "uuid", nullable: true);

            migrationBuilder.CreateTable(
                name: "DocumentProposals",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: true),
                    Kind = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    SourceType = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    SourceId = table.Column<Guid>(type: "uuid", nullable: true),
                    Title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Summary = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    Body = table.Column<string>(type: "text", nullable: false),
                    TargetDocumentId = table.Column<Guid>(type: "uuid", nullable: true),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    DecidedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    DecidedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ResultDocumentId = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table => { table.PrimaryKey("PK_DocumentProposals", x => x.Id); });
            migrationBuilder.CreateIndex(name: "IX_DocumentProposals_TenantId_ProjectId_Status", table: "DocumentProposals", columns: new[] { "TenantId", "ProjectId", "Status" });
            migrationBuilder.CreateIndex(name: "IX_DocumentProposals_TenantId_Kind_SourceType_SourceId", table: "DocumentProposals", columns: new[] { "TenantId", "Kind", "SourceType", "SourceId" }, unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "DocumentProposals");
            foreach (var c in new[] { "ParentId", "AnchorId", "Quote", "ResolvedAt", "ResolvedBy" }) migrationBuilder.DropColumn(name: c, table: "DocumentComments");
            foreach (var c in new[] { "VerifiedAt", "VerifiedBy", "StaleSince", "StaleReason", "StaleNotifiedAt" }) migrationBuilder.DropColumn(name: c, table: "Documents");
        }
    }
}
