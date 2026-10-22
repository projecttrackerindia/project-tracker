using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>The WhatsApp desk: chat owners, first-reply clocks, media still to fetch, ticket updates told to the customer, ratings, saved replies. Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261106000300_WhatsAppDesk")]
    public partial class WhatsAppDesk : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(name: "FirstReplyMinutes", table: "SupportChannels", type: "integer", nullable: false, defaultValue: 15);
            migrationBuilder.AddColumn<bool>(name: "TellCustomer", table: "SupportChannels", type: "boolean", nullable: false, defaultValue: true);
            migrationBuilder.AddColumn<bool>(name: "AskRating", table: "SupportChannels", type: "boolean", nullable: false, defaultValue: true);
            migrationBuilder.AddColumn<string>(name: "UpdateTemplate", table: "SupportChannels", type: "character varying(512)", maxLength: 512, nullable: true);
            migrationBuilder.AddColumn<string>(name: "UpdateTemplateLanguage", table: "SupportChannels", type: "character varying(10)", maxLength: 10, nullable: false, defaultValue: "en");
            migrationBuilder.AddColumn<string>(name: "SavedReplies", table: "SupportChannels", type: "character varying(40000)", maxLength: 40000, nullable: true);

            migrationBuilder.AddColumn<Guid>(name: "AssigneeId", table: "SupportConversations", type: "uuid", nullable: true);
            migrationBuilder.AddColumn<DateTime>(name: "WaitingSince", table: "SupportConversations", type: "timestamp with time zone", nullable: true);
            migrationBuilder.AddColumn<bool>(name: "MediaPending", table: "SupportConversations", type: "boolean", nullable: false, defaultValue: false);
            migrationBuilder.AddColumn<string>(name: "TicketState", table: "SupportConversations", type: "character varying(80)", maxLength: 80, nullable: true);
            migrationBuilder.AddColumn<DateTime>(name: "RatingAskedAt", table: "SupportConversations", type: "timestamp with time zone", nullable: true);
            migrationBuilder.AddColumn<int>(name: "Rating", table: "SupportConversations", type: "integer", nullable: true);
            migrationBuilder.CreateIndex(name: "IX_SupportConversations_MediaPending", table: "SupportConversations", column: "MediaPending");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(name: "IX_SupportConversations_MediaPending", table: "SupportConversations");
            foreach (var c in new[] { "AssigneeId", "WaitingSince", "MediaPending", "TicketState", "RatingAskedAt", "Rating" })
                migrationBuilder.DropColumn(name: c, table: "SupportConversations");
            foreach (var c in new[] { "FirstReplyMinutes", "TellCustomer", "AskRating", "UpdateTemplate", "UpdateTemplateLanguage", "SavedReplies" })
                migrationBuilder.DropColumn(name: c, table: "SupportChannels");
        }
    }
}
