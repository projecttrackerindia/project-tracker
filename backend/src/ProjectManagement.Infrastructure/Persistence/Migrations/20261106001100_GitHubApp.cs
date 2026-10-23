using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>The GitHub App: installations, deployments for delivery metrics, and what a pull request carries (branch, checks, reviews, size, risk). Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261106001100_GitHubApp")]
    public partial class GitHubApp : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(name: "Branch", table: "DevLinks", type: "character varying(200)", maxLength: 200, nullable: true);
            migrationBuilder.AddColumn<string>(name: "HeadSha", table: "DevLinks", type: "character varying(64)", maxLength: 64, nullable: true);
            migrationBuilder.AddColumn<string>(name: "ChecksState", table: "DevLinks", type: "character varying(20)", maxLength: 20, nullable: true);
            migrationBuilder.AddColumn<string>(name: "ReviewState", table: "DevLinks", type: "character varying(20)", maxLength: 20, nullable: true);
            migrationBuilder.AddColumn<string>(name: "ReviewerIds", table: "DevLinks", type: "character varying(400)", maxLength: 400, nullable: true);
            migrationBuilder.AddColumn<DateTime>(name: "ReviewRequestedAt", table: "DevLinks", type: "timestamp with time zone", nullable: true);
            migrationBuilder.AddColumn<long>(name: "AuthorGitHubId", table: "DevLinks", type: "bigint", nullable: true);
            migrationBuilder.AddColumn<bool>(name: "Draft", table: "DevLinks", type: "boolean", nullable: false, defaultValue: false);
            migrationBuilder.AddColumn<int>(name: "Additions", table: "DevLinks", type: "integer", nullable: true);
            migrationBuilder.AddColumn<int>(name: "Deletions", table: "DevLinks", type: "integer", nullable: true);
            migrationBuilder.AddColumn<int>(name: "ChangedFiles", table: "DevLinks", type: "integer", nullable: true);
            migrationBuilder.AddColumn<string>(name: "Files", table: "DevLinks", type: "character varying(8000)", maxLength: 8000, nullable: true);
            migrationBuilder.AddColumn<int>(name: "RiskScore", table: "DevLinks", type: "integer", nullable: true);
            migrationBuilder.AddColumn<string>(name: "RiskReasons", table: "DevLinks", type: "character varying(600)", maxLength: 600, nullable: true);
            migrationBuilder.AddColumn<DateTime>(name: "OpenedAt", table: "DevLinks", type: "timestamp with time zone", nullable: true);
            migrationBuilder.AddColumn<DateTime>(name: "MergedAt", table: "DevLinks", type: "timestamp with time zone", nullable: true);
            migrationBuilder.AddColumn<DateTime>(name: "FirstCommitAt", table: "DevLinks", type: "timestamp with time zone", nullable: true);
            migrationBuilder.AddColumn<DateTime>(name: "NudgedAt", table: "DevLinks", type: "timestamp with time zone", nullable: true);
            migrationBuilder.CreateIndex(name: "IX_DevLinks_HeadSha", table: "DevLinks", column: "HeadSha");

            migrationBuilder.CreateTable(
                name: "GitHubInstallations",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    InstallationId = table.Column<long>(type: "bigint", nullable: false),
                    AccountLogin = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    AccountType = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    RepositorySelection = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    Repositories = table.Column<string>(type: "character varying(20000)", maxLength: 20000, nullable: false),
                    InstalledBy = table.Column<Guid>(type: "uuid", nullable: false),
                    SuspendedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    StatusRules = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    RiskyPaths = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    CloseOnKeyword = table.Column<bool>(type: "boolean", nullable: false),
                    Received = table.Column<int>(type: "integer", nullable: false),
                    LastEventAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LastError = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table => { table.PrimaryKey("PK_GitHubInstallations", x => x.Id); });
            migrationBuilder.CreateIndex(name: "IX_GitHubInstallations_InstallationId", table: "GitHubInstallations", column: "InstallationId", unique: true);
            migrationBuilder.CreateIndex(name: "IX_GitHubInstallations_TenantId", table: "GitHubInstallations", column: "TenantId");

            migrationBuilder.CreateTable(
                name: "GitDeployments",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    DeploymentId = table.Column<long>(type: "bigint", nullable: false),
                    Repository = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Environment = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    Sha = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    State = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    StartedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    FinishedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Url = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table => { table.PrimaryKey("PK_GitDeployments", x => x.Id); });
            migrationBuilder.CreateIndex(name: "IX_GitDeployments_TenantId_DeploymentId", table: "GitDeployments", columns: new[] { "TenantId", "DeploymentId" }, unique: true);
            migrationBuilder.CreateIndex(name: "IX_GitDeployments_TenantId_Repository_StartedAt", table: "GitDeployments", columns: new[] { "TenantId", "Repository", "StartedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "GitDeployments");
            migrationBuilder.DropTable(name: "GitHubInstallations");
            migrationBuilder.DropIndex(name: "IX_DevLinks_HeadSha", table: "DevLinks");
            foreach (var c in new[] { "Branch", "HeadSha", "ChecksState", "ReviewState", "ReviewerIds", "ReviewRequestedAt", "AuthorGitHubId", "Draft", "Additions", "Deletions", "ChangedFiles", "Files", "RiskScore", "RiskReasons", "OpenedAt", "MergedAt", "FirstCommitAt", "NudgedAt" })
                migrationBuilder.DropColumn(name: c, table: "DevLinks");
        }
    }
}
