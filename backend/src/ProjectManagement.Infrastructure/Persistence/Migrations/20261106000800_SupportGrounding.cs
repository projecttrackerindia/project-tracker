using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>WhatsApp answers from DocTracker pages (per number, optionally one project's space), when a chat was rated, and AI handovers. Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261106000800_SupportGrounding")]
    public partial class SupportGrounding : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(name: "AnswerFromDocuments", table: "SupportChannels", type: "boolean", nullable: false, defaultValue: true);
            migrationBuilder.AddColumn<Guid>(name: "KnowledgeProjectId", table: "SupportChannels", type: "uuid", nullable: true);
            migrationBuilder.AddColumn<DateTime>(name: "RatedAt", table: "SupportConversations", type: "timestamp with time zone", nullable: true);
            migrationBuilder.AddColumn<DateTime>(name: "HandedOverAt", table: "SupportConversations", type: "timestamp with time zone", nullable: true);
            migrationBuilder.AddColumn<string>(name: "HandoverReason", table: "SupportConversations", type: "character varying(20)", maxLength: 20, nullable: true);
            // Ratings given before this release: dated by when they were asked for.
            migrationBuilder.Sql("UPDATE \"SupportConversations\" SET \"RatedAt\" = \"RatingAskedAt\" WHERE \"Rating\" IS NOT NULL AND \"RatedAt\" IS NULL;");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "AnswerFromDocuments", table: "SupportChannels");
            migrationBuilder.DropColumn(name: "KnowledgeProjectId", table: "SupportChannels");
            migrationBuilder.DropColumn(name: "RatedAt", table: "SupportConversations");
            migrationBuilder.DropColumn(name: "HandedOverAt", table: "SupportConversations");
            migrationBuilder.DropColumn(name: "HandoverReason", table: "SupportConversations");
        }
    }
}
