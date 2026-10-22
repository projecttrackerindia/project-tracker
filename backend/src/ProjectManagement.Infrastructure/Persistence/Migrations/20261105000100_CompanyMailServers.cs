using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Company mail: the administrator can set the incoming (IMAP or POP) and outgoing servers themselves. Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261105000100_CompanyMailServers")]
    public partial class CompanyMailServers : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(name: "IncomingProtocol", table: "CompanyMailSettings", type: "character varying(8)", maxLength: 8, nullable: true);
            migrationBuilder.AddColumn<string>(name: "IncomingHost", table: "CompanyMailSettings", type: "character varying(200)", maxLength: 200, nullable: true);
            migrationBuilder.AddColumn<int>(name: "IncomingPort", table: "CompanyMailSettings", type: "integer", nullable: true);
            migrationBuilder.AddColumn<string>(name: "SmtpHost", table: "CompanyMailSettings", type: "character varying(200)", maxLength: 200, nullable: true);
            migrationBuilder.AddColumn<int>(name: "SmtpPort", table: "CompanyMailSettings", type: "integer", nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            foreach (var c in new[] { "IncomingProtocol", "IncomingHost", "IncomingPort", "SmtpHost", "SmtpPort" })
                migrationBuilder.DropColumn(name: c, table: "CompanyMailSettings");
        }
    }
}
