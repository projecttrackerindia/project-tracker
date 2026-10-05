using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class OrganizationAddresses : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Every page now lives under /{organization address}/. An address that equals a name the app uses at the top level (a page, the API, a file)
            // would be ambiguous, so an organization that already has one gets "-org" added. (A snapshot of the list at the time, on purpose.)
            migrationBuilder.Sql("""
                UPDATE "Tenants" SET "Slug" = "Slug" || '-org'
                WHERE lower("Slug") IN ('login','register','verify-email','forgot-password','reset-password','invite','auth','security','r','dev','logout','sso',
                    'my-work','ai','reminders','timesheet','calendar','chat','projects','portfolio','operations','workload','reports','activity','people',
                    'settings','account','notifications','admin','work','my-team','project-status','project-groups','members','teams','organization','billing','audit',
                    'dashboard','home','tasks','issues','api','hubs','scim','health','assets','icons','static','sw.js','manifest.webmanifest','favicon.ico','robots.txt','index.html',
                    'app','www','new','null','undefined','help','support','status','docs','w','o','org','orgs','workspace','workspaces');
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {

        }
    }
}
