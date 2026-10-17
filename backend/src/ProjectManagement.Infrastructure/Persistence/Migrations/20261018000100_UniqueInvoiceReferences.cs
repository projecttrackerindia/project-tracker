using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// One invoice per provider payment in a workspace, and unique invoice numbers. Both indexes fail to build if the database already
    /// holds duplicates (a payment recorded twice by a race of the browser and the webhook, or a five-character number collision):
    /// remove or renumber those rows before applying.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261018000100_UniqueInvoiceReferences")]
    public partial class UniqueInvoiceReferences : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "IX_Invoices_Number",
                table: "Invoices",
                column: "Number",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Invoices_TenantId_ProviderReference",
                table: "Invoices",
                columns: new[] { "TenantId", "ProviderReference" },
                unique: true,
                filter: "\"ProviderReference\" IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Invoices_TenantId_ProviderReference",
                table: "Invoices");

            migrationBuilder.DropIndex(
                name: "IX_Invoices_Number",
                table: "Invoices");
        }
    }
}
