using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Quality: test cases (TC-118 …), test runs (UAT 1.4 on a build and environment) and one result per case in a run (Pass, Fail, Blocked
    /// or not run yet, with what happened, the evidence and the bug filed from it). New tables only.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261112001000_Quality")]
    public partial class Quality : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "TestCases",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: true),
                    Number = table.Column<int>(type: "integer", nullable: false),
                    Key = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Title = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    Steps = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: true),
                    Expected = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    Priority = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Tags = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TestCases", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_TestCases_TenantId_Number", table: "TestCases", columns: new[] { "TenantId", "Number" }, unique: true);
            migrationBuilder.CreateIndex(name: "IX_TestCases_TenantId_ProjectId", table: "TestCases", columns: new[] { "TenantId", "ProjectId" });
            migrationBuilder.CreateTable(
                name: "TestRuns",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: true),
                    Name = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    Environment = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    Build = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    StartedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CompletedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TestRuns", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_TestRuns_TenantId_ProjectId_CreatedAt", table: "TestRuns", columns: new[] { "TenantId", "ProjectId", "CreatedAt" });
            migrationBuilder.CreateTable(
                name: "TestResults",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    RunId = table.Column<Guid>(type: "uuid", nullable: false),
                    CaseId = table.Column<Guid>(type: "uuid", nullable: false),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Actual = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    Evidence = table.Column<string>(type: "character varying(16000)", maxLength: 16000, nullable: true),
                    RunById = table.Column<Guid>(type: "uuid", nullable: true),
                    At = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LinkedWorkItemId = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TestResults", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_TestResults_TenantId_RunId_CaseId", table: "TestResults", columns: new[] { "TenantId", "RunId", "CaseId" }, unique: true);
            migrationBuilder.CreateIndex(name: "IX_TestResults_TenantId_CaseId", table: "TestResults", columns: new[] { "TenantId", "CaseId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "TestResults");
            migrationBuilder.DropTable(name: "TestRuns");
            migrationBuilder.DropTable(name: "TestCases");
        }
    }
}
