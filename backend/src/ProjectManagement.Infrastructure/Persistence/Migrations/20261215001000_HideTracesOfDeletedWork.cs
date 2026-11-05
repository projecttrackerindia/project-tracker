using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Data only, no schema change (the snapshot is unchanged): hides what deleted projects and tasks left behind before deletes cascaded -
    /// their action items and subtasks are soft-deleted, open reminders about them stop (orphaned), notifications that open them are archived -
    /// and soft-deletes the later copies of action items saved twice (the oldest stays). See <see cref="DeletedWorkCleanupSql"/>. Nothing is
    /// removed; Down leaves the data as it is.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261215001000_HideTracesOfDeletedWork")]
    public partial class HideTracesOfDeletedWork : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            if (!migrationBuilder.ActiveProvider.Contains("Npgsql", StringComparison.OrdinalIgnoreCase)) return;
            foreach (var sql in DeletedWorkCleanupSql.Statements()) migrationBuilder.Sql(sql);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
        }
    }
}
