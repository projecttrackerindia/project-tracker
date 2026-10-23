using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Webhooks release 2: incoming addresses that create work (with merged repeats), outgoing filters, replay and delivery timing, the owner warning. Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261106001200_WebhooksIncoming")]
    public partial class WebhooksIncoming : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(name: "FilterProjects", table: "Webhooks", type: "character varying(2000)", maxLength: 2000, nullable: true);
            migrationBuilder.AddColumn<string>(name: "FilterPriorities", table: "Webhooks", type: "character varying(100)", maxLength: 100, nullable: true);
            migrationBuilder.AddColumn<string>(name: "FilterStatuses", table: "Webhooks", type: "character varying(500)", maxLength: 500, nullable: true);
            migrationBuilder.AddColumn<DateTime>(name: "WarnedAt", table: "Webhooks", type: "timestamp with time zone", nullable: true);
            migrationBuilder.AddColumn<int>(name: "DurationMs", table: "WebhookDeliveries", type: "integer", nullable: true);
            migrationBuilder.AddColumn<Guid>(name: "ReplayOf", table: "WebhookDeliveries", type: "uuid", nullable: true);

            migrationBuilder.CreateTable(
                name: "IncomingWebhooks",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    Token = table.Column<string>(type: "character varying(48)", maxLength: 48, nullable: false),
                    SecretProtected = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    Target = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: true),
                    WorkTypeId = table.Column<Guid>(type: "uuid", nullable: true),
                    AssigneeId = table.Column<Guid>(type: "uuid", nullable: true),
                    DefaultPriority = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Mapping = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    MergeMinutes = table.Column<int>(type: "integer", nullable: false),
                    IsActive = table.Column<bool>(type: "boolean", nullable: false),
                    ActingUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Received = table.Column<int>(type: "integer", nullable: false),
                    CreatedCount = table.Column<int>(type: "integer", nullable: false),
                    MergedCount = table.Column<int>(type: "integer", nullable: false),
                    LastReceivedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LastError = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    Sample = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table => { table.PrimaryKey("PK_IncomingWebhooks", x => x.Id); });

            migrationBuilder.CreateIndex(name: "IX_IncomingWebhooks_TenantId", table: "IncomingWebhooks", column: "TenantId");

            migrationBuilder.CreateIndex(name: "IX_IncomingWebhooks_Token", table: "IncomingWebhooks", column: "Token", unique: true);

            migrationBuilder.CreateTable(
                name: "IncomingWebhookEvents",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    IncomingWebhookId = table.Column<Guid>(type: "uuid", nullable: false),
                    ReceivedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    DedupeKey = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    Title = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    TargetType = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    TargetId = table.Column<Guid>(type: "uuid", nullable: true),
                    TargetKey = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    Error = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    Body = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table => { table.PrimaryKey("PK_IncomingWebhookEvents", x => x.Id); });

            migrationBuilder.CreateIndex(name: "IX_IncomingWebhookEvents_IncomingWebhookId_ReceivedAt", table: "IncomingWebhookEvents", columns: new[] { "IncomingWebhookId", "ReceivedAt" });

            migrationBuilder.CreateTable(
                name: "IncomingWebhookThreads",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    IncomingWebhookId = table.Column<Guid>(type: "uuid", nullable: false),
                    DedupeKey = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    TargetType = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    TargetId = table.Column<Guid>(type: "uuid", nullable: false),
                    TargetKey = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    Count = table.Column<int>(type: "integer", nullable: false),
                    FirstAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    LastAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table => { table.PrimaryKey("PK_IncomingWebhookThreads", x => x.Id); });

            migrationBuilder.CreateIndex(name: "IX_IncomingWebhookThreads_IncomingWebhookId_DedupeKey", table: "IncomingWebhookThreads", columns: new[] { "IncomingWebhookId", "DedupeKey" }, unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "IncomingWebhookThreads");
            migrationBuilder.DropTable(name: "IncomingWebhookEvents");
            migrationBuilder.DropTable(name: "IncomingWebhooks");
            migrationBuilder.DropColumn(name: "ReplayOf", table: "WebhookDeliveries");
            migrationBuilder.DropColumn(name: "DurationMs", table: "WebhookDeliveries");
            foreach (var c in new[] { "FilterProjects", "FilterPriorities", "FilterStatuses", "WarnedAt" }) migrationBuilder.DropColumn(name: c, table: "Webhooks");
        }
    }
}
