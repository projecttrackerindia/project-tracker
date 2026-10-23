using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Digest mode: the daily time updates are emailed together (null = off). Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261106000600_NotificationDigest")]
    public partial class NotificationDigest : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<TimeOnly>(name: "DigestTime", table: "ReminderSettings", type: "time without time zone", nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "DigestTime", table: "ReminderSettings");
        }
    }
}
