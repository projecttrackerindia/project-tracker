using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Private (end-to-end encrypted) chats and calls: Conversations.IsPrivate, ChatMessages.Cipher (the ciphertext envelope), CallRooms.IsPrivate
    /// and CallRooms.E2eeKeyCipher (the room key wrapped per device), plus ChatDeviceKeys (each browser's public key) and ChatKeyBackups (the
    /// passphrase-wrapped recovery copy). New tables and new columns only; nothing existing changes.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261210001000_PrivateChats")]
    public partial class PrivateChats : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(name: "IsPrivate", table: "Conversations", type: "boolean", nullable: false, defaultValue: false);
            migrationBuilder.AddColumn<string>(name: "Cipher", table: "ChatMessages", type: "character varying(60000)", maxLength: 60000, nullable: true);
            migrationBuilder.AddColumn<bool>(name: "IsPrivate", table: "CallRooms", type: "boolean", nullable: false, defaultValue: false);
            migrationBuilder.AddColumn<string>(name: "E2eeKeyCipher", table: "CallRooms", type: "character varying(60000)", maxLength: 60000, nullable: true);

            migrationBuilder.CreateTable(
                name: "ChatDeviceKeys",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    DeviceId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    PublicKey = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    Label = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: true),
                    RevokedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_ChatDeviceKeys", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_ChatDeviceKeys_TenantId_UserId_DeviceId", table: "ChatDeviceKeys", columns: new[] { "TenantId", "UserId", "DeviceId" }, unique: true);

            migrationBuilder.CreateTable(
                name: "ChatKeyBackups",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Salt = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Iterations = table.Column<int>(type: "integer", nullable: false),
                    WrappedKey = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    PublicKey = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_ChatKeyBackups", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_ChatKeyBackups_TenantId_UserId", table: "ChatKeyBackups", columns: new[] { "TenantId", "UserId" }, unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "ChatKeyBackups");
            migrationBuilder.DropTable(name: "ChatDeviceKeys");
            migrationBuilder.DropColumn(name: "E2eeKeyCipher", table: "CallRooms");
            migrationBuilder.DropColumn(name: "IsPrivate", table: "CallRooms");
            migrationBuilder.DropColumn(name: "Cipher", table: "ChatMessages");
            migrationBuilder.DropColumn(name: "IsPrivate", table: "Conversations");
        }
    }
}
