using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Support voice agent: settings, the company's API connectors it may read, and its calls. Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261101000100_VoiceAgent")]
    public partial class VoiceAgent : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "VoiceAgentSettings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    AgentName = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    CompanyName = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    Languages = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    Knowledge = table.Column<string>(type: "character varying(20000)", maxLength: 20000, nullable: true),
                    RequireVerification = table.Column<bool>(type: "boolean", nullable: false),
                    VerificationRule = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    TransferNumber = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: true),
                    WorkTypeId = table.Column<Guid>(type: "uuid", nullable: true),
                    StorageKeyPattern = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                },
                constraints: table => table.PrimaryKey("PK_VoiceAgentSettings", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_VoiceAgentSettings_TenantId", table: "VoiceAgentSettings", column: "TenantId", unique: true);

            migrationBuilder.CreateTable(
                name: "VoiceConnectors",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    Description = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    Method = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    UrlTemplate = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    HeaderName = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    SecretProtected = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                },
                constraints: table => table.PrimaryKey("PK_VoiceConnectors", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_VoiceConnectors_TenantId", table: "VoiceConnectors", column: "TenantId");

            migrationBuilder.CreateTable(
                name: "VoiceCalls",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    Channel = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    Direction = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    CallerNumber = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: true),
                    Language = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    Status = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    StartedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    EndedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    TranscriptProtected = table.Column<string>(type: "character varying(400000)", maxLength: 400000, nullable: false),
                    Summary = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    WorkTaskId = table.Column<Guid>(type: "uuid", nullable: true),
                    Verified = table.Column<bool>(type: "boolean", nullable: false),
                    Transferred = table.Column<bool>(type: "boolean", nullable: false),
                    ArchiveKey = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    StartedBy = table.Column<Guid>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_VoiceCalls", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_VoiceCalls_TenantId_StartedAt", table: "VoiceCalls", columns: new[] { "TenantId", "StartedAt" });

        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "VoiceCalls");
            migrationBuilder.DropTable(name: "VoiceConnectors");
            migrationBuilder.DropTable(name: "VoiceAgentSettings");
        }
    }
}
