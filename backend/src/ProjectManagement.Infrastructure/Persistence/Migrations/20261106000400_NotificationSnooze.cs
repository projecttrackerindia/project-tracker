using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Notifications can be snoozed until a chosen time. Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261106000400_NotificationSnooze")]
    public partial class NotificationSnooze : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(name: "SnoozedUntil", table: "Notifications", type: "timestamp with time zone", nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "SnoozedUntil", table: "Notifications");
        }
    }
}
