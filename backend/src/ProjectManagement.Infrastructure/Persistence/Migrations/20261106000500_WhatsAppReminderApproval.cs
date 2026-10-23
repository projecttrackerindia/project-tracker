using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Two more WhatsApp notification kinds a person can opt into: their own reminders and approvals waiting for them. Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261106000500_WhatsAppReminderApproval")]
    public partial class WhatsAppReminderApproval : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(name: "ReminderTemplateState", table: "WhatsAppConnections", type: "character varying(20)", maxLength: 20, nullable: false, defaultValue: "unchecked");
            migrationBuilder.AddColumn<string>(name: "ApprovalTemplateState", table: "WhatsAppConnections", type: "character varying(20)", maxLength: 20, nullable: false, defaultValue: "unchecked");
            migrationBuilder.AddColumn<bool>(name: "NotifyReminders", table: "WhatsAppContactLinks", type: "boolean", nullable: false, defaultValue: false);
            migrationBuilder.AddColumn<bool>(name: "NotifyApprovals", table: "WhatsAppContactLinks", type: "boolean", nullable: false, defaultValue: false);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "ReminderTemplateState", table: "WhatsAppConnections");
            migrationBuilder.DropColumn(name: "ApprovalTemplateState", table: "WhatsAppConnections");
            migrationBuilder.DropColumn(name: "NotifyReminders", table: "WhatsAppContactLinks");
            migrationBuilder.DropColumn(name: "NotifyApprovals", table: "WhatsAppContactLinks");
        }
    }
}
