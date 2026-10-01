using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Trigram indexes for text search. Searches are a LIKE on the lower-cased column (see SearchText), which a GIN trigram index on
    /// lower(column) answers without reading the whole table. The pg_trgm extension ships with Postgres; if the server does not allow it,
    /// the indexes are skipped (search still works, only slower) rather than stopping the application from starting.
    /// </summary>
    public partial class SearchIndexes : Migration
    {
        private static readonly (string Table, string Column)[] Columns =
        [
            ("Tasks", "Title"), ("Tasks", "Description"),
            ("WorkTasks", "Title"), ("WorkTasks", "Description"),
            ("StageIssues", "Title"), ("StageIssues", "Details"),
            ("Projects", "Name"),
            ("TaskComments", "Body"),
            ("ChatMessages", "Body"),
            ("Attachments", "FileName"),
            ("Users", "DisplayName"), ("Users", "Email"),
            ("Tenants", "Name"),
        ];

        private static string Name((string Table, string Column) c) => $"IX_{c.Table}_{c.Column}_trgm";

        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            var creates = string.Join("\n", Columns.Select(c =>
                $"    CREATE INDEX IF NOT EXISTS \"{Name(c)}\" ON \"{c.Table}\" USING gin (lower(\"{c.Column}\") gin_trgm_ops);"));
            migrationBuilder.Sql($"""
                DO $$
                BEGIN
                  BEGIN
                    CREATE EXTENSION IF NOT EXISTS pg_trgm;
                  EXCEPTION WHEN others THEN
                    RAISE NOTICE 'pg_trgm is not available (%); text search runs without trigram indexes', SQLERRM;
                  END;
                  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
                {creates}
                  END IF;
                END $$;
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            foreach (var c in Columns) migrationBuilder.Sql($"DROP INDEX IF EXISTS \"{Name(c)}\";");
        }
    }
}
