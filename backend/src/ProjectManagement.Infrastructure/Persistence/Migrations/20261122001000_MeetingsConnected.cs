using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Meetings connected everywhere, and action items as work: a work item can carry the meeting (and session) it was agreed in and its
    /// owner's latest update; meetings keep how people join (video), the teams invited and the series they continue; one session of a
    /// series can be changed on its own; a meeting's time is proposed to each attendee when a session ends; and a review of a series'
    /// action items keeps its decisions and minutes. A time entry may now be spent on a project meeting (neither a task nor a work task).
    /// <para>Data: nothing to move. Project action items already live in WorkItems (work tasks of the action-item kind, since the
    /// one-Work migration) and keep their ids and their project; they simply have no source meeting, so a review lists them under "Other".
    /// Every new column is nullable and every new table empty, so Down drops them without losing anything that existed before.</para>
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261122001000_MeetingsConnected")]
    public partial class MeetingsConnected : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "LastUpdateAt",
                table: "WorkItems",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "LatestNote",
                table: "WorkItems",
                type: "character varying(500)",
                maxLength: 500,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SourceMeetingRef",
                table: "WorkItems",
                type: "character varying(40)",
                maxLength: 40,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SourceMeetingTitle",
                table: "WorkItems",
                type: "character varying(200)",
                maxLength: 200,
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "SourceOccurrenceStartUtc",
                table: "WorkItems",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SourceSeriesRef",
                table: "WorkItems",
                type: "character varying(40)",
                maxLength: 40,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "AttendeeTeamIds",
                table: "ProjectMeetings",
                type: "character varying(800)",
                maxLength: 800,
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "SeriesRootId",
                table: "ProjectMeetings",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "VideoKind",
                table: "ProjectMeetings",
                type: "character varying(16)",
                maxLength: 16,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "VideoLink",
                table: "ProjectMeetings",
                type: "character varying(500)",
                maxLength: 500,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "AttendeeTeamIds",
                table: "WorkspaceMeetings",
                type: "character varying(800)",
                maxLength: 800,
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "SeriesRootId",
                table: "WorkspaceMeetings",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "VideoKind",
                table: "WorkspaceMeetings",
                type: "character varying(16)",
                maxLength: 16,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "VideoLink",
                table: "WorkspaceMeetings",
                type: "character varying(500)",
                maxLength: 500,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "MeetingRef",
                table: "TimeEntries",
                type: "character varying(40)",
                maxLength: 40,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "MeetingTitle",
                table: "TimeEntries",
                type: "character varying(200)",
                maxLength: 200,
                nullable: true);

            migrationBuilder.CreateIndex(name: "IX_WorkItems_TenantId_SourceSeriesRef", table: "WorkItems", columns: new[] { "TenantId", "SourceSeriesRef" });

            migrationBuilder.DropCheckConstraint(name: "CK_TimeEntries_OneTarget", table: "TimeEntries");
            migrationBuilder.AddCheckConstraint(name: "CK_TimeEntries_OneTarget", table: "TimeEntries",
                sql: "(\"TaskId\" IS NOT NULL AND \"WorkTaskId\" IS NULL) OR (\"TaskId\" IS NULL AND \"WorkTaskId\" IS NOT NULL) OR (\"TaskId\" IS NULL AND \"WorkTaskId\" IS NULL AND \"MeetingRef\" IS NOT NULL)");

            migrationBuilder.CreateTable(
                name: "MeetingOccurrenceChanges",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    MeetingRef = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    MeetingId = table.Column<Guid>(type: "uuid", nullable: false),
                    OccurrenceStartUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    IsCancelled = table.Column<bool>(type: "boolean", nullable: false),
                    NewStartUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    NewEndUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MeetingOccurrenceChanges", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_MeetingOccurrenceChanges_TenantId_MeetingId_OccurrenceStartUtc", table: "MeetingOccurrenceChanges", columns: new[] { "TenantId", "MeetingId", "OccurrenceStartUtc" }, unique: true);

            migrationBuilder.CreateTable(
                name: "MeetingTimeProposals",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    MeetingRef = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    MeetingId = table.Column<Guid>(type: "uuid", nullable: false),
                    MeetingTitle = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    OccurrenceStartUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    OccurrenceEndUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    Minutes = table.Column<int>(type: "integer", nullable: false),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    SnoozedUntil = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    TimeEntryId = table.Column<Guid>(type: "uuid", nullable: true),
                    DecidedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    DismissReason = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MeetingTimeProposals", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_MeetingTimeProposals_TenantId_UserId_MeetingId_OccurrenceStartUtc", table: "MeetingTimeProposals", columns: new[] { "TenantId", "UserId", "MeetingId", "OccurrenceStartUtc" }, unique: true);
            migrationBuilder.CreateIndex(name: "IX_MeetingTimeProposals_TenantId_UserId_Status", table: "MeetingTimeProposals", columns: new[] { "TenantId", "UserId", "Status" });

            migrationBuilder.CreateTable(
                name: "MeetingReviewSessions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    SeriesRef = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    MeetingTitle = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    OccurrenceStartUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    StartedBy = table.Column<Guid>(type: "uuid", nullable: false),
                    StartedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    FinishedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Minutes = table.Column<string>(type: "text", nullable: true),
                    SentAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    MinutesDocumentId = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MeetingReviewSessions", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_MeetingReviewSessions_TenantId_SeriesRef_OccurrenceStartUtc", table: "MeetingReviewSessions", columns: new[] { "TenantId", "SeriesRef", "OccurrenceStartUtc" });

            migrationBuilder.CreateTable(
                name: "MeetingReviewDecisions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    SessionId = table.Column<Guid>(type: "uuid", nullable: false),
                    WorkItemId = table.Column<Guid>(type: "uuid", nullable: false),
                    ItemTitle = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Decision = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Reason = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    FromOwnerId = table.Column<Guid>(type: "uuid", nullable: true),
                    ToOwnerId = table.Column<Guid>(type: "uuid", nullable: true),
                    FromDue = table.Column<DateOnly>(type: "date", nullable: true),
                    ToDue = table.Column<DateOnly>(type: "date", nullable: true),
                    FromStatus = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    ConvertedTaskId = table.Column<Guid>(type: "uuid", nullable: true),
                    DecidedBy = table.Column<Guid>(type: "uuid", nullable: false),
                    DecidedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UndoneAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MeetingReviewDecisions", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_MeetingReviewDecisions_TenantId_SessionId", table: "MeetingReviewDecisions", columns: new[] { "TenantId", "SessionId" });
            migrationBuilder.CreateIndex(name: "IX_MeetingReviewDecisions_TenantId_WorkItemId", table: "MeetingReviewDecisions", columns: new[] { "TenantId", "WorkItemId" });

        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "MeetingReviewDecisions");
            migrationBuilder.DropTable(name: "MeetingReviewSessions");
            migrationBuilder.DropTable(name: "MeetingTimeProposals");
            migrationBuilder.DropTable(name: "MeetingOccurrenceChanges");

            // Meeting time has no task to stay on: it goes with the column that names its meeting, before the old rule comes back.
            migrationBuilder.Sql("DELETE FROM \"TimeEntries\" WHERE \"TaskId\" IS NULL AND \"WorkTaskId\" IS NULL;");
            migrationBuilder.DropCheckConstraint(name: "CK_TimeEntries_OneTarget", table: "TimeEntries");
            migrationBuilder.AddCheckConstraint(name: "CK_TimeEntries_OneTarget", table: "TimeEntries",
                sql: "(\"TaskId\" IS NOT NULL AND \"WorkTaskId\" IS NULL) OR (\"TaskId\" IS NULL AND \"WorkTaskId\" IS NOT NULL)");

            migrationBuilder.DropIndex(name: "IX_WorkItems_TenantId_SourceSeriesRef", table: "WorkItems");
            migrationBuilder.DropColumn(name: "LastUpdateAt", table: "WorkItems");
            migrationBuilder.DropColumn(name: "LatestNote", table: "WorkItems");
            migrationBuilder.DropColumn(name: "SourceMeetingRef", table: "WorkItems");
            migrationBuilder.DropColumn(name: "SourceMeetingTitle", table: "WorkItems");
            migrationBuilder.DropColumn(name: "SourceOccurrenceStartUtc", table: "WorkItems");
            migrationBuilder.DropColumn(name: "SourceSeriesRef", table: "WorkItems");
            migrationBuilder.DropColumn(name: "AttendeeTeamIds", table: "ProjectMeetings");
            migrationBuilder.DropColumn(name: "SeriesRootId", table: "ProjectMeetings");
            migrationBuilder.DropColumn(name: "VideoKind", table: "ProjectMeetings");
            migrationBuilder.DropColumn(name: "VideoLink", table: "ProjectMeetings");
            migrationBuilder.DropColumn(name: "AttendeeTeamIds", table: "WorkspaceMeetings");
            migrationBuilder.DropColumn(name: "SeriesRootId", table: "WorkspaceMeetings");
            migrationBuilder.DropColumn(name: "VideoKind", table: "WorkspaceMeetings");
            migrationBuilder.DropColumn(name: "VideoLink", table: "WorkspaceMeetings");
            migrationBuilder.DropColumn(name: "MeetingRef", table: "TimeEntries");
            migrationBuilder.DropColumn(name: "MeetingTitle", table: "TimeEntries");
        }
    }
}
