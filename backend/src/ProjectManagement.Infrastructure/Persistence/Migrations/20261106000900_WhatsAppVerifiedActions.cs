using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>WhatsApp: one connection shared with notifications, and verified actions behind a one-time code. Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261106000900_WhatsAppVerifiedActions")]
    public partial class WhatsAppVerifiedActions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(name: "ConnectionId", table: "SupportChannels", type: "uuid", nullable: true);
            migrationBuilder.AddColumn<bool>(name: "VerifiedActions", table: "SupportChannels", type: "boolean", nullable: false, defaultValue: false);
            migrationBuilder.AddColumn<string>(name: "VerifyConnector", table: "SupportChannels", type: "character varying(60)", maxLength: 60, nullable: true);
            migrationBuilder.AddColumn<string>(name: "VerifyMobilePath", table: "SupportChannels", type: "character varying(120)", maxLength: 120, nullable: true);
            migrationBuilder.AddColumn<string>(name: "OtpTemplate", table: "SupportChannels", type: "character varying(512)", maxLength: 512, nullable: true);
            migrationBuilder.AddColumn<string>(name: "OtpTemplateLanguage", table: "SupportChannels", type: "character varying(10)", maxLength: 10, nullable: false, defaultValue: "en");
            migrationBuilder.AddColumn<string>(name: "OtpHash", table: "SupportConversations", type: "character varying(64)", maxLength: 64, nullable: true);
            migrationBuilder.AddColumn<DateTime>(name: "OtpExpiresAt", table: "SupportConversations", type: "timestamp with time zone", nullable: true);
            migrationBuilder.AddColumn<int>(name: "OtpAttempts", table: "SupportConversations", type: "integer", nullable: false, defaultValue: 0);
            migrationBuilder.AddColumn<int>(name: "OtpSends", table: "SupportConversations", type: "integer", nullable: false, defaultValue: 0);
            migrationBuilder.AddColumn<DateTime>(name: "OtpWindowAt", table: "SupportConversations", type: "timestamp with time zone", nullable: true);
            migrationBuilder.AddColumn<string>(name: "OtpForProtected", table: "SupportConversations", type: "character varying(1000)", maxLength: 1000, nullable: true);
            migrationBuilder.AddColumn<DateTime>(name: "VerifiedUntil", table: "SupportConversations", type: "timestamp with time zone", nullable: true);
            migrationBuilder.AddColumn<string>(name: "VerifiedForProtected", table: "SupportConversations", type: "character varying(1000)", maxLength: 1000, nullable: true);
            migrationBuilder.CreateIndex(name: "IX_SupportChannels_ConnectionId", table: "SupportChannels", column: "ConnectionId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(name: "IX_SupportChannels_ConnectionId", table: "SupportChannels");
            foreach (var c in new[] { "ConnectionId", "VerifiedActions", "VerifyConnector", "VerifyMobilePath", "OtpTemplate", "OtpTemplateLanguage" })
                migrationBuilder.DropColumn(name: c, table: "SupportChannels");
            foreach (var c in new[] { "OtpHash", "OtpExpiresAt", "OtpAttempts", "OtpSends", "OtpWindowAt", "OtpForProtected", "VerifiedUntil", "VerifiedForProtected" })
                migrationBuilder.DropColumn(name: c, table: "SupportConversations");
        }
    }
}
