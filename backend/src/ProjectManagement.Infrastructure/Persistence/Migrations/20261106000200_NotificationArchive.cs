using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Notifications can be archived (put away from the inbox). Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261106000200_NotificationArchive")]
    public partial class NotificationArchive : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(name: "ArchivedAt", table: "Notifications", type: "timestamp with time zone", nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "ArchivedAt", table: "Notifications");
        }
    }
}
