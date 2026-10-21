using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Teams connect their own WhatsApp Business numbers; chats with each number are kept (encrypted) for the AI support employee. Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261102000100_SupportChannels")]
    public partial class SupportChannels : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "SupportChannels",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    Kind = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    Name = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    TeamId = table.Column<Guid>(type: "uuid", nullable: true),
                    PhoneNumberId = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    BusinessAccountId = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    DisplayPhone = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    VerifiedName = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    AccessTokenProtected = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    AppSecretProtected = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    VerifyToken = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    AutoReply = table.Column<bool>(type: "boolean", nullable: false),
                    AgentName = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    WorkTypeId = table.Column<Guid>(type: "uuid", nullable: true),
                    ConnectedBy = table.Column<Guid>(type: "uuid", nullable: false),
                    LastInboundAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CheckedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LastError = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_SupportChannels", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_SupportChannels_TenantId", table: "SupportChannels", column: "TenantId");
            migrationBuilder.CreateIndex(name: "IX_SupportChannels_PhoneNumberId", table: "SupportChannels", column: "PhoneNumberId", unique: true);

            migrationBuilder.CreateTable(
                name: "SupportConversations",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    ChannelId = table.Column<Guid>(type: "uuid", nullable: false),
                    ContactKey = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ContactProtected = table.Column<string>(type: "character varying(400)", maxLength: 400, nullable: false),
                    ContactName = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    Language = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    Status = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Mode = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    LastMessageAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    LastInboundAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    NeedsReply = table.Column<bool>(type: "boolean", nullable: false),
                    ReplyAttempts = table.Column<int>(type: "integer", nullable: false),
                    Unread = table.Column<int>(type: "integer", nullable: false),
                    WorkTaskId = table.Column<Guid>(type: "uuid", nullable: true),
                    MessagesProtected = table.Column<string>(type: "character varying(400000)", maxLength: 400000, nullable: false),
                },
                constraints: table => table.PrimaryKey("PK_SupportConversations", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_SupportConversations_TenantId_LastMessageAt", table: "SupportConversations", columns: new[] { "TenantId", "LastMessageAt" });
            migrationBuilder.CreateIndex(name: "IX_SupportConversations_ChannelId_ContactKey", table: "SupportConversations", columns: new[] { "ChannelId", "ContactKey" }, unique: true);
            migrationBuilder.CreateIndex(name: "IX_SupportConversations_NeedsReply", table: "SupportConversations", column: "NeedsReply");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "SupportConversations");
            migrationBuilder.DropTable(name: "SupportChannels");
        }
    }
}
