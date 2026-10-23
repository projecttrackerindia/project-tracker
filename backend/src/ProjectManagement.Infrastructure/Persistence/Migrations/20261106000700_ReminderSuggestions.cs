using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Reminders offered from what people said (chat, meetings, emails). New table only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261106000700_ReminderSuggestions")]
    public partial class ReminderSuggestions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ReminderSuggestions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    FireAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    TimeZone = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    LocalAt = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    SourceKind = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    SourceKey = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    Link = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    Quote = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    State = table.Column<string>(type: "character varying(12)", maxLength: 12, nullable: false),
                    ReminderId = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table => table.PrimaryKey("PK_ReminderSuggestions", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_ReminderSuggestions_TenantId_UserId_SourceKey", table: "ReminderSuggestions", columns: new[] { "TenantId", "UserId", "SourceKey" }, unique: true);
            migrationBuilder.CreateIndex(name: "IX_ReminderSuggestions_UserId_State", table: "ReminderSuggestions", columns: new[] { "UserId", "State" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "ReminderSuggestions");
        }
    }
}
