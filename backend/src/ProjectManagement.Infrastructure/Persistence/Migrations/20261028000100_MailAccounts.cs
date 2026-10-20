using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Mailbox: personal IMAP/SMTP mail accounts (Rediffmail and similar). Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261028000100_MailAccounts")]
    public partial class MailAccounts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "MailAccounts",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Provider = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Email = table.Column<string>(type: "character varying(254)", maxLength: 254, nullable: false),
                    ImapHost = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    ImapPort = table.Column<int>(type: "integer", nullable: false),
                    SmtpHost = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    SmtpPort = table.Column<int>(type: "integer", nullable: false),
                    SecretProtected = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    LastSyncedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LastError = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MailAccounts", x => x.Id);
                    table.ForeignKey(name: "FK_MailAccounts_Users_UserId", column: x => x.UserId, principalTable: "Users", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
                });
            migrationBuilder.CreateIndex(name: "IX_MailAccounts_TenantId_UserId", table: "MailAccounts", columns: new[] { "TenantId", "UserId" });
            migrationBuilder.CreateIndex(name: "IX_MailAccounts_UserId", table: "MailAccounts", column: "UserId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder) => migrationBuilder.DropTable(name: "MailAccounts");
    }
}
