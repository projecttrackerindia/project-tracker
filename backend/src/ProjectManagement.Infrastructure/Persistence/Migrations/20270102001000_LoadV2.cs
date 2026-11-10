using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Load v2: a task's rough size (S/M/L/XL, a nullable column on WorkItems) and LoadSignals (each person's "I'm swamped / I have room" for a
    /// week). Nothing existing changes.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20270102001000_LoadV2")]
    public partial class LoadV2 : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "Size",
                table: "WorkItems",
                type: "character varying(2)",
                maxLength: 2,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "LoadSignals",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    WeekStart = table.Column<DateOnly>(type: "date", nullable: false),
                    Signal = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid?>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime?>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid?>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_LoadSignals", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_LoadSignals_TenantId_UserId_WeekStart", table: "LoadSignals", columns: new[] { "TenantId", "UserId", "WeekStart" }, unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "LoadSignals");
            migrationBuilder.DropColumn(name: "Size", table: "WorkItems");
        }
    }
}
