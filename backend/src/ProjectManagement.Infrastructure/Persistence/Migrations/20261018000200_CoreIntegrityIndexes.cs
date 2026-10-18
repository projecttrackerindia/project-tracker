using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using ProjectManagement.Infrastructure.Persistence;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Integrity rules the application already meant to hold, now kept by the database so two requests at the same moment cannot break them:
    /// a project key is unique in its workspace (deleted projects included), and a person has at most one running timer per workspace.
    /// Existing duplicates are resolved first so the indexes can be built: later projects that share a key get a numeric suffix (the oldest
    /// keeps the key), and all but the newest running timer of a person are stopped at their start time (no time is invented).
    /// A second running sprint per project is prevented in code (a project row lock and a re-check), not by an index.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261018000200_CoreIntegrityIndexes")]
    public partial class CoreIntegrityIndexes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            var postgres = ActiveProvider.Contains("Npgsql", StringComparison.OrdinalIgnoreCase);

            // ---- duplicate project keys: the oldest project keeps the key, later ones become KEY2, KEY3... (within the 10-character limit,
            // skipping any key already in use in that workspace).
            migrationBuilder.Sql(postgres
                ? """
                  DO $$
                  DECLARE r record; candidate text; n int;
                  BEGIN
                    FOR r IN
                      SELECT d."Id", d."TenantId", d."Key" FROM (
                        SELECT "Id", "TenantId", "Key", ROW_NUMBER() OVER (PARTITION BY "TenantId", "Key" ORDER BY "CreatedAt", "Id") AS rn FROM "Projects"
                      ) d WHERE d.rn > 1 ORDER BY d."TenantId", d."Key"
                    LOOP
                      n := 2;
                      LOOP
                        candidate := left(r."Key", 10 - length(n::text)) || n::text;
                        EXIT WHEN NOT EXISTS (SELECT 1 FROM "Projects" p WHERE p."TenantId" = r."TenantId" AND p."Key" = candidate);
                        n := n + 1;
                      END LOOP;
                      UPDATE "Projects" SET "Key" = candidate WHERE "Id" = r."Id";
                    END LOOP;
                  END $$;
                  """
                // SQLite has no procedural blocks: later duplicates get a random 4-character hexadecimal suffix instead (uppercase, so still
                // a valid key; a clash is vanishingly unlikely and would only stop this migration, not lose data).
                : """
                  UPDATE "Projects" SET "Key" = substr("Key", 1, 6) || substr(hex(randomblob(2)), 1, 4)
                  WHERE "Id" IN (
                    SELECT "Id" FROM (
                      SELECT "Id", ROW_NUMBER() OVER (PARTITION BY "TenantId", "Key" ORDER BY "CreatedAt", "Id") AS rn FROM "Projects"
                    ) d WHERE d.rn > 1
                  );
                  """);

            migrationBuilder.DropIndex(
                name: "IX_Projects_TenantId_Key",
                table: "Projects");

            migrationBuilder.CreateIndex(
                name: "IX_Projects_TenantId_Key",
                table: "Projects",
                columns: new[] { "TenantId", "Key" },
                unique: true);

            // ---- more than one running timer for a person in a workspace: keep the newest, stop the others where they started.
            migrationBuilder.Sql("""
                UPDATE "TimeEntries" SET "EndedAt" = "StartedAt"
                WHERE "Id" IN (
                  SELECT "Id" FROM (
                    SELECT "Id", ROW_NUMBER() OVER (PARTITION BY "TenantId", "UserId" ORDER BY "StartedAt" DESC, "Id" DESC) AS rn
                    FROM "TimeEntries" WHERE "StartedAt" IS NOT NULL AND "EndedAt" IS NULL
                  ) r WHERE r.rn > 1
                );
                """);

            migrationBuilder.CreateIndex(
                name: "IX_TimeEntries_TenantId_UserId_Running",
                table: "TimeEntries",
                columns: new[] { "TenantId", "UserId" },
                unique: true,
                filter: "\"StartedAt\" IS NOT NULL AND \"EndedAt\" IS NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_TimeEntries_TenantId_UserId_Running",
                table: "TimeEntries");

            migrationBuilder.DropIndex(
                name: "IX_Projects_TenantId_Key",
                table: "Projects");

            migrationBuilder.CreateIndex(
                name: "IX_Projects_TenantId_Key",
                table: "Projects",
                columns: new[] { "TenantId", "Key" });
        }
    }
}
