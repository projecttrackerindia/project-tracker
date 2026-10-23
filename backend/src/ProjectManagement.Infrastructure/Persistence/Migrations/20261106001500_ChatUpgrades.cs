using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Chat upgrades: threads, pins, what was made from a message, voice notes with transcripts, saved messages, scheduled send, polls and status / do-not-disturb. Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261106001500_ChatUpgrades")]
    public partial class ChatUpgrades : Migration
    {

        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(name: "ThreadRootId", table: "ChatMessages", type: "uuid", nullable: true);
            migrationBuilder.AddColumn<int>(name: "ThreadReplies", table: "ChatMessages", type: "integer", nullable: false, defaultValue: 0);
            migrationBuilder.AddColumn<DateTime>(name: "ThreadLastAt", table: "ChatMessages", type: "timestamp with time zone", nullable: true);
            migrationBuilder.AddColumn<DateTime>(name: "PinnedAt", table: "ChatMessages", type: "timestamp with time zone", nullable: true);
            migrationBuilder.AddColumn<Guid>(name: "PinnedBy", table: "ChatMessages", type: "uuid", nullable: true);
            migrationBuilder.AddColumn<string>(name: "LinkedJson", table: "ChatMessages", type: "character varying(2000)", maxLength: 2000, nullable: true);
            migrationBuilder.CreateIndex(name: "IX_ChatMessages_ThreadRootId", table: "ChatMessages", column: "ThreadRootId");

            migrationBuilder.AddColumn<bool>(name: "IsVoice", table: "ChatAttachments", type: "boolean", nullable: false, defaultValue: false);
            migrationBuilder.AddColumn<string>(name: "Transcript", table: "ChatAttachments", type: "character varying(4000)", maxLength: 4000, nullable: true);
            migrationBuilder.AddColumn<string>(name: "TranscriptLanguage", table: "ChatAttachments", type: "character varying(12)", maxLength: 12, nullable: true);
            migrationBuilder.AddColumn<int>(name: "DurationSeconds", table: "ChatAttachments", type: "integer", nullable: true);

            migrationBuilder.CreateTable(
                name: "ChatSavedMessages",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    MessageId = table.Column<Guid>(type: "uuid", nullable: false),
                    ConversationId = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ChatSavedMessages", x => x.Id);
                    table.ForeignKey(name: "FK_ChatSavedMessages_ChatMessages_MessageId", column: x => x.MessageId, principalTable: "ChatMessages", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
                });
            migrationBuilder.CreateIndex(name: "IX_ChatSavedMessages_MessageId", table: "ChatSavedMessages", column: "MessageId");
            migrationBuilder.CreateIndex(name: "IX_ChatSavedMessages_UserId_MessageId", table: "ChatSavedMessages", columns: new[] { "UserId", "MessageId" }, unique: true);
            migrationBuilder.CreateIndex(name: "IX_ChatSavedMessages_TenantId_UserId_CreatedAt", table: "ChatSavedMessages", columns: new[] { "TenantId", "UserId", "CreatedAt" });

            migrationBuilder.CreateTable(
                name: "ChatScheduledMessages",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ConversationId = table.Column<Guid>(type: "uuid", nullable: false),
                    SenderId = table.Column<Guid>(type: "uuid", nullable: false),
                    Body = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    ReplyToId = table.Column<Guid>(type: "uuid", nullable: true),
                    ThreadRootId = table.Column<Guid>(type: "uuid", nullable: true),
                    SendAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    Status = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    SentMessageId = table.Column<Guid>(type: "uuid", nullable: true),
                    Error = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ChatScheduledMessages", x => x.Id);
                    table.ForeignKey(name: "FK_ChatScheduledMessages_Conversations_ConversationId", column: x => x.ConversationId, principalTable: "Conversations", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
                });
            migrationBuilder.CreateIndex(name: "IX_ChatScheduledMessages_Status_SendAt", table: "ChatScheduledMessages", columns: new[] { "Status", "SendAt" });
            migrationBuilder.CreateIndex(name: "IX_ChatScheduledMessages_ConversationId_SenderId", table: "ChatScheduledMessages", columns: new[] { "ConversationId", "SenderId" });

            migrationBuilder.CreateTable(
                name: "ChatPolls",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    MessageId = table.Column<Guid>(type: "uuid", nullable: false),
                    ConversationId = table.Column<Guid>(type: "uuid", nullable: false),
                    Question = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    OptionsJson = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    Multiple = table.Column<bool>(type: "boolean", nullable: false),
                    ClosesAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ClosedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ClosedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    Decision = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    DecisionMessageId = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ChatPolls", x => x.Id);
                    table.ForeignKey(name: "FK_ChatPolls_ChatMessages_MessageId", column: x => x.MessageId, principalTable: "ChatMessages", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
                });
            migrationBuilder.CreateIndex(name: "IX_ChatPolls_MessageId", table: "ChatPolls", column: "MessageId", unique: true);
            migrationBuilder.CreateIndex(name: "IX_ChatPolls_ConversationId", table: "ChatPolls", column: "ConversationId");

            migrationBuilder.CreateTable(
                name: "ChatPollVotes",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    PollId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Option = table.Column<int>(type: "integer", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ChatPollVotes", x => x.Id);
                    table.ForeignKey(name: "FK_ChatPollVotes_ChatPolls_PollId", column: x => x.PollId, principalTable: "ChatPolls", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
                });
            migrationBuilder.CreateIndex(name: "IX_ChatPollVotes_PollId_UserId_Option", table: "ChatPollVotes", columns: new[] { "PollId", "UserId", "Option" }, unique: true);

            migrationBuilder.CreateTable(
                name: "ChatUserStatuses",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Emoji = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    Text = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    ClearAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    DndUntil = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table => { table.PrimaryKey("PK_ChatUserStatuses", x => x.Id); });
            migrationBuilder.CreateIndex(name: "IX_ChatUserStatuses_TenantId_UserId", table: "ChatUserStatuses", columns: new[] { "TenantId", "UserId" }, unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "ChatUserStatuses");
            migrationBuilder.DropTable(name: "ChatPollVotes");
            migrationBuilder.DropTable(name: "ChatPolls");
            migrationBuilder.DropTable(name: "ChatScheduledMessages");
            migrationBuilder.DropTable(name: "ChatSavedMessages");
            migrationBuilder.DropIndex(name: "IX_ChatMessages_ThreadRootId", table: "ChatMessages");
            foreach (var c in new[] { "ThreadRootId", "ThreadReplies", "ThreadLastAt", "PinnedAt", "PinnedBy", "LinkedJson" }) migrationBuilder.DropColumn(name: c, table: "ChatMessages");
            foreach (var c in new[] { "IsVoice", "Transcript", "TranscriptLanguage", "DurationSeconds" }) migrationBuilder.DropColumn(name: c, table: "ChatAttachments");
        }
    }
}
