using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Meaning-based search also covers chat messages, meeting notes and project mail: a chat piece remembers its conversation, so membership
    /// can be checked before anything is opened. Nothing existing changes (a null conversation is what every earlier piece has).
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20270105001000_AssistantMeaningSearchSources")]
    public partial class AssistantMeaningSearchSources : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(name: "ConversationId", table: "AiSearchChunks", type: "uuid", nullable: true);
            migrationBuilder.CreateIndex(name: "IX_AiSearchChunks_TenantId_ConversationId", table: "AiSearchChunks", columns: new[] { "TenantId", "ConversationId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(name: "IX_AiSearchChunks_TenantId_ConversationId", table: "AiSearchChunks");
            migrationBuilder.DropColumn(name: "ConversationId", table: "AiSearchChunks");
        }
    }
}
