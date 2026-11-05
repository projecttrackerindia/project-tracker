using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Adoption: ImportBatches (undo an import), ClientPortalLinks (read-only client portal), ProjectInboxes (email to task) and CalendarSyncLinks /
    /// CalendarSyncItems (two-way Google / Outlook calendar sync). New tables only; nothing existing changes.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261230001000_Adoption")]
    public partial class Adoption : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ImportBatches",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    Source = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    FileName = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    TaskIds = table.Column<string>(type: "text", nullable: false),
                    Created = table.Column<int>(type: "integer", nullable: false),
                    UndoneAt = table.Column<DateTime?>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid?>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime?>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid?>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_ImportBatches", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_ImportBatches_TenantId_ProjectId_CreatedAt", table: "ImportBatches", columns: new[] { "TenantId", "ProjectId", "CreatedAt" });

            migrationBuilder.CreateTable(
                name: "ClientPortalLinks",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    TokenHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    TokenPrefix = table.Column<string>(type: "character varying(12)", maxLength: 12, nullable: false),
                    Fields = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    ExpiresAt = table.Column<DateTime?>(type: "timestamp with time zone", nullable: true),
                    RevokedAt = table.Column<DateTime?>(type: "timestamp with time zone", nullable: true),
                    LastViewedAt = table.Column<DateTime?>(type: "timestamp with time zone", nullable: true),
                    Views = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid?>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime?>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid?>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_ClientPortalLinks", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_ClientPortalLinks_TokenHash", table: "ClientPortalLinks", column: "TokenHash", unique: true);
            migrationBuilder.CreateIndex(name: "IX_ClientPortalLinks_TenantId_ProjectId", table: "ClientPortalLinks", columns: new[] { "TenantId", "ProjectId" });

            migrationBuilder.CreateTable(
                name: "ProjectInboxes",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    Token = table.Column<string>(type: "character varying(24)", maxLength: 24, nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    Received = table.Column<int>(type: "integer", nullable: false),
                    LastReceivedAt = table.Column<DateTime?>(type: "timestamp with time zone", nullable: true),
                    LastError = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    Day = table.Column<DateOnly?>(type: "date", nullable: true),
                    DayCount = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid?>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime?>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid?>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_ProjectInboxes", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_ProjectInboxes_Token", table: "ProjectInboxes", column: "Token", unique: true);
            migrationBuilder.CreateIndex(name: "IX_ProjectInboxes_TenantId_ProjectId", table: "ProjectInboxes", columns: new[] { "TenantId", "ProjectId" }, unique: true);

            migrationBuilder.CreateTable(
                name: "CalendarSyncLinks",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Provider = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    ConflictRule = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    SyncMeetings = table.Column<bool>(type: "boolean", nullable: false),
                    SyncBlocks = table.Column<bool>(type: "boolean", nullable: false),
                    DeltaToken = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    ChannelId = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    ChannelSecret = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    ChannelExpiresAt = table.Column<DateTime?>(type: "timestamp with time zone", nullable: true),
                    LastSyncedAt = table.Column<DateTime?>(type: "timestamp with time zone", nullable: true),
                    LastError = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    Pushed = table.Column<int>(type: "integer", nullable: false),
                    Pulled = table.Column<int>(type: "integer", nullable: false),
                    Conflicts = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid?>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime?>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid?>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_CalendarSyncLinks", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_CalendarSyncLinks_TenantId_UserId_Provider", table: "CalendarSyncLinks", columns: new[] { "TenantId", "UserId", "Provider" }, unique: true);
            migrationBuilder.CreateIndex(name: "IX_CalendarSyncLinks_ChannelId", table: "CalendarSyncLinks", column: "ChannelId");

            migrationBuilder.CreateTable(
                name: "CalendarSyncItems",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    LinkId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Kind = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    LocalId = table.Column<Guid?>(type: "uuid", nullable: true),
                    Title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    StartsAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    EndsAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    RemoteId = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    RemoteVersion = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    LocalChangedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    RemoteChangedAt = table.Column<DateTime?>(type: "timestamp with time zone", nullable: true),
                    SyncedAt = table.Column<DateTime?>(type: "timestamp with time zone", nullable: true),
                    Deleted = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid?>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime?>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid?>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_CalendarSyncItems", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_CalendarSyncItems_TenantId_LinkId_RemoteId", table: "CalendarSyncItems", columns: new[] { "TenantId", "LinkId", "RemoteId" });
            migrationBuilder.CreateIndex(name: "IX_CalendarSyncItems_TenantId_LinkId_Kind_LocalId", table: "CalendarSyncItems", columns: new[] { "TenantId", "LinkId", "Kind", "LocalId" });

        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "CalendarSyncItems");
            migrationBuilder.DropTable(name: "CalendarSyncLinks");
            migrationBuilder.DropTable(name: "ProjectInboxes");
            migrationBuilder.DropTable(name: "ClientPortalLinks");
            migrationBuilder.DropTable(name: "ImportBatches");
        }
    }
}
