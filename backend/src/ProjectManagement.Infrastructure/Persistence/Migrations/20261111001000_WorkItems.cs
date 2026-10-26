using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// v2: one table for every kind of work. Project tasks ("Tasks"), stage issues ("StageIssues") and work tasks ("WorkTasks": tickets and
    /// action items) move into <c>WorkItems</c> (TPH, discriminator <c>ItemType</c> = Task | Issue | Work; a work task's <c>Kind</c> still says
    /// ticket or action item); task and work task comments into <c>WorkItemComments</c>; work task files into <c>WorkItemAttachments</c>.
    /// Ids, numbers (PAY-12, PAY-I3, WT-5, AI-7), versions and every value are kept, so links, keys and history stay valid. Every foreign key
    /// that pointed at the old tables now points at the new ones.
    ///
    /// Safety: runs in one transaction (PostgreSQL); stops before changing anything if a row would break the new keys (an issue of a project
    /// that is gone, a reporter or comment author who is gone); checks row for row that everything arrived and fails otherwise; keeps the
    /// old tables as legacy_* (without their foreign keys, so they block nothing) for one release; every step is guarded so a re-run does no harm.
    /// Down puts the old tables back with everything that changed since (issue comments become notes in the issue's history; an issue's
    /// start and due dates, new in v2, are dropped).
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261111001000_WorkItems")]
    public partial class WorkItems : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""""
                -- 1. The new tables (no foreign keys yet: the rows are copied first, then checked by the keys).
                CREATE TABLE IF NOT EXISTS "WorkItemAttachments" (
                    "Id" uuid NOT NULL,
                    "WorkItemId" uuid NOT NULL,
                    "FileName" character varying(200) NOT NULL,
                    "ContentType" character varying(120) NOT NULL,
                    "SizeBytes" bigint NOT NULL,
                    "StorageKey" character varying(200) NOT NULL,
                    "Sha256" character varying(64) NOT NULL,
                    "CreatedAt" timestamp with time zone NOT NULL,
                    "CreatedBy" uuid,
                    "UpdatedAt" timestamp with time zone,
                    "UpdatedBy" uuid,
                    "TenantId" uuid NOT NULL,
                    CONSTRAINT "PK_WorkItemAttachments" PRIMARY KEY ("Id")
                );
                CREATE TABLE IF NOT EXISTS "WorkItems" (
                    "Id" uuid NOT NULL,
                    "Number" integer NOT NULL,
                    "Title" character varying(200) NOT NULL,
                    "AssigneeId" uuid,
                    "ReporterId" uuid NOT NULL,
                    "Description" text,
                    "StartDate" date,
                    "DueDate" date,
                    "CompletedAt" timestamp with time zone,
                    "Version" integer NOT NULL,
                    "IsDeleted" boolean NOT NULL,
                    "DeletedAt" timestamp with time zone,
                    "DeletedBy" uuid,
                    "ScopeProjectId" uuid GENERATED ALWAYS AS (COALESCE("ProjectId", "RelatedProjectId")) STORED,
                    "ItemType" character varying(16) NOT NULL,
                    "ProjectId" uuid,
                    "StageId" uuid,
                    "Details" character varying(4000),
                    "Priority" character varying(32),
                    "Status" character varying(32),
                    "ResolvedAt" timestamp with time zone,
                    "ResolvedBy" uuid,
                    "ParentTaskId" uuid,
                    "MilestoneId" uuid,
                    "SprintId" uuid,
                    "StatusId" uuid,
                    "EstimatedHours" numeric(9,2),
                    "ActualHours" numeric(9,2),
                    "Position" double precision,
                    "Kind" character varying(32),
                    "WorkTypeId" uuid,
                    "RelatedProjectId" uuid,
                    "CompletedBy" uuid,
                    "ResolutionNote" text,
                    "ResolutionWorkVersion" integer,
                    "ResolutionProposedBy" uuid,
                    "ResolutionProposedAt" timestamp with time zone,
                    "ResolutionAcceptedBy" uuid,
                    "ResolutionAcceptedAt" timestamp with time zone,
                    "ResolutionDocumentId" uuid,
                    "ResolutionDocumentVersion" text,
                    "RespondedAt" timestamp with time zone,
                    "ResponseDueAt" timestamp with time zone,
                    "ResolutionDueAt" timestamp with time zone,
                    "ResolutionRiskAt" timestamp with time zone,
                    "SlaPausedAt" timestamp with time zone,
                    "SlaPausedMinutes" integer,
                    "SlaAlerted" integer,
                    "CreatedAt" timestamp with time zone NOT NULL,
                    "CreatedBy" uuid,
                    "UpdatedAt" timestamp with time zone,
                    "UpdatedBy" uuid,
                    "TenantId" uuid NOT NULL,
                    CONSTRAINT "PK_WorkItems" PRIMARY KEY ("Id")
                );
                CREATE TABLE IF NOT EXISTS "WorkItemComments" (
                    "Id" uuid NOT NULL,
                    "AuthorId" uuid NOT NULL,
                    "Body" text NOT NULL,
                    "EditedAt" timestamp with time zone,
                    "IsDeleted" boolean NOT NULL,
                    "DeletedAt" timestamp with time zone,
                    "DeletedBy" uuid,
                    "ItemId" uuid GENERATED ALWAYS AS ("WorkItemId") STORED,
                    "ItemType" character varying(16) NOT NULL,
                    "WorkItemId" uuid,
                    "ParentCommentId" uuid,
                    "CreatedAt" timestamp with time zone NOT NULL,
                    "CreatedBy" uuid,
                    "UpdatedAt" timestamp with time zone,
                    "UpdatedBy" uuid,
                    "TenantId" uuid NOT NULL,
                    CONSTRAINT "PK_WorkItemComments" PRIMARY KEY ("Id")
                );
                """"");
            migrationBuilder.Sql("""""
                -- 2. Copy every row, ids kept (see the checks inside for rows the new keys would refuse).
                DO $$
                DECLARE
                  n bigint;
                BEGIN
                  -- Pre-flight. The new table puts the rules of every kind on every row (an issue's project, every reporter and comment author must
                  -- exist). Rows that would break them are reported and nothing is changed; nothing in the application hard-deletes projects or users.
                  IF to_regclass('public."StageIssues"') IS NOT NULL THEN
                    SELECT count(*) INTO n FROM "StageIssues" i WHERE NOT EXISTS (SELECT 1 FROM "Projects" p WHERE p."Id" = i."ProjectId");
                    IF n > 0 THEN RAISE EXCEPTION 'WorkItems migration stopped, nothing changed: % issue(s) belong to a project that no longer exists (StageIssues.ProjectId).', n; END IF;
                    SELECT count(*) INTO n FROM "StageIssues" i WHERE NOT EXISTS (SELECT 1 FROM "Users" u WHERE u."Id" = i."ReporterId");
                    IF n > 0 THEN RAISE EXCEPTION 'WorkItems migration stopped, nothing changed: % issue(s) were reported by a user who no longer exists (StageIssues.ReporterId).', n; END IF;
                  END IF;
                  IF to_regclass('public."WorkTasks"') IS NOT NULL THEN
                    SELECT count(*) INTO n FROM "WorkTasks" w WHERE NOT EXISTS (SELECT 1 FROM "Users" u WHERE u."Id" = w."ReporterId");
                    IF n > 0 THEN RAISE EXCEPTION 'WorkItems migration stopped, nothing changed: % work task(s) were raised by a user who no longer exists (WorkTasks.ReporterId).', n; END IF;
                  END IF;
                  IF to_regclass('public."WorkTaskComments"') IS NOT NULL THEN
                    SELECT count(*) INTO n FROM "WorkTaskComments" c
                      WHERE EXISTS (SELECT 1 FROM "WorkTasks" w WHERE w."Id" = c."WorkTaskId") AND NOT EXISTS (SELECT 1 FROM "Users" u WHERE u."Id" = c."AuthorId");
                    IF n > 0 THEN RAISE EXCEPTION 'WorkItems migration stopped, nothing changed: % work task comment(s) were written by a user who no longer exists (WorkTaskComments.AuthorId).', n; END IF;
                  END IF;

                  -- Project tasks. Every column keeps its value; the IDs, numbers (PAY-12) and versions are the same.
                  IF to_regclass('public."Tasks"') IS NOT NULL THEN
                    INSERT INTO "WorkItems" ("Id", "TenantId", "ItemType", "Number", "Title", "AssigneeId", "ReporterId", "Description", "StartDate", "DueDate",
                        "CompletedAt", "Version", "IsDeleted", "DeletedAt", "DeletedBy", "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy",
                        "ProjectId", "ParentTaskId", "StageId", "MilestoneId", "SprintId", "StatusId", "Priority", "EstimatedHours", "ActualHours", "Position")
                    SELECT t."Id", t."TenantId", 'Task', t."Number", t."Title", t."AssigneeId", t."ReporterId", t."Description", t."StartDate", t."DueDate",
                        t."CompletedAt", t."Version", t."IsDeleted", t."DeletedAt", t."DeletedBy", t."CreatedAt", t."CreatedBy", t."UpdatedAt", t."UpdatedBy",
                        t."ProjectId", t."ParentTaskId", t."StageId", t."MilestoneId", t."SprintId", t."StatusId", t."Priority", t."EstimatedHours", t."ActualHours", t."Position"
                    FROM "Tasks" t
                    ON CONFLICT ("Id") DO NOTHING;
                  END IF;

                  -- Stage issues: severity goes to the shared Priority column, details keep their own column. An assignee or stage that no longer exists
                  -- (the old table did not check assignees) is cleared, as the old foreign key on the stage already did.
                  IF to_regclass('public."StageIssues"') IS NOT NULL THEN
                    INSERT INTO "WorkItems" ("Id", "TenantId", "ItemType", "Number", "Title", "AssigneeId", "ReporterId", "Version", "IsDeleted",
                        "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy", "ProjectId", "StageId", "Priority", "Details", "Status", "ResolvedAt", "ResolvedBy")
                    SELECT i."Id", i."TenantId", 'Issue', i."Number", i."Title",
                        CASE WHEN EXISTS (SELECT 1 FROM "Users" u WHERE u."Id" = i."AssigneeId") THEN i."AssigneeId" END,
                        i."ReporterId", 1, FALSE, i."CreatedAt", i."CreatedBy", i."UpdatedAt", i."UpdatedBy", i."ProjectId",
                        CASE WHEN EXISTS (SELECT 1 FROM "ProjectStages" s WHERE s."Id" = i."StageId") THEN i."StageId" END,
                        i."Severity", i."Details", i."Status", i."ResolvedAt", i."ResolvedBy"
                    FROM "StageIssues" i
                    ON CONFLICT ("Id") DO NOTHING;
                  END IF;

                  -- Work tasks (tickets and action items: their Kind column says which).
                  IF to_regclass('public."WorkTasks"') IS NOT NULL THEN
                    INSERT INTO "WorkItems" ("Id", "TenantId", "ItemType", "Number", "Title", "AssigneeId", "ReporterId", "Description", "StartDate", "DueDate",
                        "CompletedAt", "Version", "IsDeleted", "DeletedAt", "DeletedBy", "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy",
                        "Kind", "WorkTypeId", "RelatedProjectId", "Priority", "Status", "CompletedBy", "ResolutionNote", "ResolutionWorkVersion", "ResolutionProposedBy",
                        "ResolutionProposedAt", "ResolutionAcceptedBy", "ResolutionAcceptedAt", "ResolutionDocumentId", "ResolutionDocumentVersion", "RespondedAt",
                        "ResponseDueAt", "ResolutionDueAt", "ResolutionRiskAt", "SlaPausedAt", "SlaPausedMinutes", "SlaAlerted")
                    SELECT w."Id", w."TenantId", 'Work', w."Number", w."Title",
                        CASE WHEN EXISTS (SELECT 1 FROM "Users" u WHERE u."Id" = w."AssigneeId") THEN w."AssigneeId" END,
                        w."ReporterId", w."Description", w."StartDate", w."DueDate",
                        w."CompletedAt", w."Version", w."IsDeleted", w."DeletedAt", w."DeletedBy", w."CreatedAt", w."CreatedBy", w."UpdatedAt", w."UpdatedBy",
                        w."Kind", w."WorkTypeId", w."RelatedProjectId", w."Priority", w."Status", w."CompletedBy", w."ResolutionNote", w."ResolutionWorkVersion", w."ResolutionProposedBy",
                        w."ResolutionProposedAt", w."ResolutionAcceptedBy", w."ResolutionAcceptedAt", w."ResolutionDocumentId", w."ResolutionDocumentVersion", w."RespondedAt",
                        w."ResponseDueAt", w."ResolutionDueAt", w."ResolutionRiskAt", w."SlaPausedAt", w."SlaPausedMinutes", w."SlaAlerted"
                    FROM "WorkTasks" w
                    ON CONFLICT ("Id") DO NOTHING;
                  END IF;

                  -- Comments: tasks' and work tasks' in one table, keyed by WorkItemId. A work task comment whose work task is gone (the old table did
                  -- not check) cannot be shown anywhere; it is left in legacy_WorkTaskComments and counted below.
                  IF to_regclass('public."TaskComments"') IS NOT NULL THEN
                    INSERT INTO "WorkItemComments" ("Id", "TenantId", "ItemType", "WorkItemId", "AuthorId", "Body", "ParentCommentId", "EditedAt", "IsDeleted", "DeletedAt",
                        "DeletedBy", "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy")
                    SELECT c."Id", c."TenantId", 'Task', c."TaskId", c."AuthorId", c."Body", c."ParentCommentId", c."EditedAt", c."IsDeleted", c."DeletedAt",
                        c."DeletedBy", c."CreatedAt", c."CreatedBy", c."UpdatedAt", c."UpdatedBy"
                    FROM "TaskComments" c
                    ON CONFLICT ("Id") DO NOTHING;
                  END IF;
                  IF to_regclass('public."WorkTaskComments"') IS NOT NULL THEN
                    INSERT INTO "WorkItemComments" ("Id", "TenantId", "ItemType", "WorkItemId", "AuthorId", "Body", "EditedAt", "IsDeleted", "DeletedAt",
                        "DeletedBy", "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy")
                    SELECT c."Id", c."TenantId", 'Work', c."WorkTaskId", c."AuthorId", c."Body", c."EditedAt", c."IsDeleted", c."DeletedAt",
                        c."DeletedBy", c."CreatedAt", c."CreatedBy", c."UpdatedAt", c."UpdatedBy"
                    FROM "WorkTaskComments" c
                    WHERE EXISTS (SELECT 1 FROM "WorkTasks" w WHERE w."Id" = c."WorkTaskId")
                    ON CONFLICT ("Id") DO NOTHING;
                  END IF;

                  -- Work task files (metadata only; the bytes stay where they are in file storage).
                  IF to_regclass('public."WorkTaskAttachments"') IS NOT NULL THEN
                    INSERT INTO "WorkItemAttachments" ("Id", "TenantId", "WorkItemId", "FileName", "ContentType", "SizeBytes", "StorageKey", "Sha256",
                        "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy")
                    SELECT a."Id", a."TenantId", a."WorkTaskId", a."FileName", a."ContentType", a."SizeBytes", a."StorageKey", a."Sha256",
                        a."CreatedAt", a."CreatedBy", a."UpdatedAt", a."UpdatedBy"
                    FROM "WorkTaskAttachments" a
                    ON CONFLICT ("Id") DO NOTHING;
                  END IF;
                END $$;
                """"");
            migrationBuilder.Sql("""""
                -- 3. Row-for-row checks: the migration fails (and nothing changes) unless every row arrived intact.
                DO $$
                DECLARE
                  src bigint;
                  dst bigint;
                  extra bigint;
                BEGIN
                  -- Every old row must be in the new table with its id, tenant, number, project and title unchanged, and nothing else may be there.
                  IF to_regclass('public."Tasks"') IS NOT NULL THEN
                    SELECT count(*) INTO src FROM "Tasks";
                    SELECT count(*) INTO dst FROM "Tasks" t JOIN "WorkItems" w ON w."Id" = t."Id" AND w."ItemType" = 'Task' AND w."TenantId" = t."TenantId"
                      AND w."Number" = t."Number" AND w."ProjectId" = t."ProjectId" AND w."Title" = t."Title" AND w."Version" = t."Version" AND w."IsDeleted" = t."IsDeleted"
                      AND w."StatusId" = t."StatusId" AND w."ReporterId" = t."ReporterId" AND w."AssigneeId" IS NOT DISTINCT FROM t."AssigneeId" AND w."DueDate" IS NOT DISTINCT FROM t."DueDate";
                    SELECT count(*) INTO extra FROM "WorkItems" WHERE "ItemType" = 'Task';
                    IF src <> dst OR extra <> src THEN RAISE EXCEPTION 'WorkItems migration: tasks did not arrive intact (% old, % matched, % new).', src, dst, extra; END IF;
                  END IF;
                  IF to_regclass('public."StageIssues"') IS NOT NULL THEN
                    SELECT count(*) INTO src FROM "StageIssues";
                    SELECT count(*) INTO dst FROM "StageIssues" i JOIN "WorkItems" w ON w."Id" = i."Id" AND w."ItemType" = 'Issue' AND w."TenantId" = i."TenantId"
                      AND w."Number" = i."Number" AND w."ProjectId" = i."ProjectId" AND w."Title" = i."Title" AND w."Priority" = i."Severity" AND w."Status" = i."Status"
                      AND w."ReporterId" = i."ReporterId" AND w."Details" IS NOT DISTINCT FROM i."Details";
                    SELECT count(*) INTO extra FROM "WorkItems" WHERE "ItemType" = 'Issue';
                    IF src <> dst OR extra <> src THEN RAISE EXCEPTION 'WorkItems migration: issues did not arrive intact (% old, % matched, % new).', src, dst, extra; END IF;
                  END IF;
                  IF to_regclass('public."WorkTasks"') IS NOT NULL THEN
                    SELECT count(*) INTO src FROM "WorkTasks";
                    SELECT count(*) INTO dst FROM "WorkTasks" t JOIN "WorkItems" w ON w."Id" = t."Id" AND w."ItemType" = 'Work' AND w."TenantId" = t."TenantId"
                      AND w."Number" = t."Number" AND w."Kind" = t."Kind" AND w."Title" = t."Title" AND w."Status" = t."Status" AND w."Priority" = t."Priority"
                      AND w."Version" = t."Version" AND w."IsDeleted" = t."IsDeleted" AND w."ReporterId" = t."ReporterId"
                      AND w."RelatedProjectId" IS NOT DISTINCT FROM t."RelatedProjectId" AND w."WorkTypeId" IS NOT DISTINCT FROM t."WorkTypeId"
                      AND w."ResolutionDueAt" IS NOT DISTINCT FROM t."ResolutionDueAt";
                    SELECT count(*) INTO extra FROM "WorkItems" WHERE "ItemType" = 'Work';
                    IF src <> dst OR extra <> src THEN RAISE EXCEPTION 'WorkItems migration: work tasks did not arrive intact (% old, % matched, % new).', src, dst, extra; END IF;
                  END IF;
                  IF to_regclass('public."TaskComments"') IS NOT NULL THEN
                    SELECT count(*) INTO src FROM "TaskComments";
                    SELECT count(*) INTO dst FROM "TaskComments" c JOIN "WorkItemComments" n ON n."Id" = c."Id" AND n."ItemType" = 'Task' AND n."WorkItemId" = c."TaskId"
                      AND n."AuthorId" = c."AuthorId" AND n."Body" = c."Body" AND n."IsDeleted" = c."IsDeleted" AND n."ParentCommentId" IS NOT DISTINCT FROM c."ParentCommentId";
                    SELECT count(*) INTO extra FROM "WorkItemComments" WHERE "ItemType" = 'Task';
                    IF src <> dst OR extra <> src THEN RAISE EXCEPTION 'WorkItems migration: task comments did not arrive intact (% old, % matched, % new).', src, dst, extra; END IF;
                  END IF;
                  IF to_regclass('public."WorkTaskComments"') IS NOT NULL THEN
                    SELECT count(*) INTO src FROM "WorkTaskComments" c WHERE EXISTS (SELECT 1 FROM "WorkTasks" w WHERE w."Id" = c."WorkTaskId");
                    SELECT count(*) INTO dst FROM "WorkTaskComments" c JOIN "WorkItemComments" n ON n."Id" = c."Id" AND n."ItemType" = 'Work' AND n."WorkItemId" = c."WorkTaskId"
                      AND n."AuthorId" = c."AuthorId" AND n."Body" = c."Body" AND n."IsDeleted" = c."IsDeleted";
                    SELECT count(*) INTO extra FROM "WorkItemComments" WHERE "ItemType" = 'Work';
                    IF src <> dst OR extra <> src THEN RAISE EXCEPTION 'WorkItems migration: work task comments did not arrive intact (% old, % matched, % new).', src, dst, extra; END IF;
                    SELECT count(*) INTO src FROM "WorkTaskComments" c WHERE NOT EXISTS (SELECT 1 FROM "WorkTasks" w WHERE w."Id" = c."WorkTaskId");
                    IF src > 0 THEN RAISE NOTICE 'WorkItems migration: % comment(s) of work tasks that no longer exist stay in legacy_WorkTaskComments.', src; END IF;
                  END IF;
                  IF to_regclass('public."WorkTaskAttachments"') IS NOT NULL THEN
                    SELECT count(*) INTO src FROM "WorkTaskAttachments";
                    SELECT count(*) INTO dst FROM "WorkTaskAttachments" a JOIN "WorkItemAttachments" n ON n."Id" = a."Id" AND n."WorkItemId" = a."WorkTaskId"
                      AND n."StorageKey" = a."StorageKey" AND n."Sha256" = a."Sha256" AND n."SizeBytes" = a."SizeBytes" AND n."FileName" = a."FileName";
                    SELECT count(*) INTO extra FROM "WorkItemAttachments";
                    IF src <> dst OR extra <> src THEN RAISE EXCEPTION 'WorkItems migration: work task files did not arrive intact (% old, % matched, % new).', src, dst, extra; END IF;
                  END IF;
                END $$;
                """"");
            migrationBuilder.Sql("""""
                -- 4. Foreign keys that pointed at the old tables, and the old tables' own keys, are dropped; the old tables are kept as legacy_* for one release.
                -- every foreign key to or from the old tables
                DO $$
                DECLARE
                  r record;
                BEGIN
                  FOR r IN
                    SELECT c.conname, c.conrelid::regclass AS tbl
                    FROM pg_constraint c
                    WHERE c.contype = 'f'
                      AND (c.confrelid IN (SELECT to_regclass(x) FROM unnest(ARRAY['public."Tasks"', 'public."StageIssues"', 'public."WorkTasks"', 'public."TaskComments"', 'public."WorkTaskComments"', 'public."WorkTaskAttachments"']) x WHERE to_regclass(x) IS NOT NULL)
                        OR c.conrelid IN (SELECT to_regclass(x) FROM unnest(ARRAY['public."Tasks"', 'public."StageIssues"', 'public."WorkTasks"', 'public."TaskComments"', 'public."WorkTaskComments"', 'public."WorkTaskAttachments"']) x WHERE to_regclass(x) IS NOT NULL))
                  LOOP
                    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
                  END LOOP;
                END $$;
                DO $$ BEGIN IF to_regclass('public."Tasks"') IS NOT NULL AND to_regclass('public."legacy_Tasks"') IS NULL THEN ALTER TABLE "Tasks" RENAME TO "legacy_Tasks"; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."StageIssues"') IS NOT NULL AND to_regclass('public."legacy_StageIssues"') IS NULL THEN ALTER TABLE "StageIssues" RENAME TO "legacy_StageIssues"; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."WorkTasks"') IS NOT NULL AND to_regclass('public."legacy_WorkTasks"') IS NULL THEN ALTER TABLE "WorkTasks" RENAME TO "legacy_WorkTasks"; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."TaskComments"') IS NOT NULL AND to_regclass('public."legacy_TaskComments"') IS NULL THEN ALTER TABLE "TaskComments" RENAME TO "legacy_TaskComments"; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."WorkTaskComments"') IS NOT NULL AND to_regclass('public."legacy_WorkTaskComments"') IS NULL THEN ALTER TABLE "WorkTaskComments" RENAME TO "legacy_WorkTaskComments"; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."WorkTaskAttachments"') IS NOT NULL AND to_regclass('public."legacy_WorkTaskAttachments"') IS NULL THEN ALTER TABLE "WorkTaskAttachments" RENAME TO "legacy_WorkTaskAttachments"; END IF; END $$;
                """"");
            migrationBuilder.Sql("""""
                -- 5. Indexes of the new tables.
                CREATE INDEX IF NOT EXISTS "IX_WorkItemAttachments_WorkItemId" ON "WorkItemAttachments" ("WorkItemId");
                CREATE INDEX IF NOT EXISTS "IX_WorkItemComments_AuthorId" ON "WorkItemComments" ("AuthorId");
                CREATE INDEX IF NOT EXISTS "IX_WorkItemComments_WorkItemId" ON "WorkItemComments" ("WorkItemId");
                CREATE INDEX IF NOT EXISTS "IX_WorkItems_AssigneeId" ON "WorkItems" ("AssigneeId");
                CREATE UNIQUE INDEX IF NOT EXISTS "IX_WorkItems_Issue_ProjectId_Number" ON "WorkItems" ("ProjectId", "Number") WHERE "ItemType" = 'Issue';
                CREATE INDEX IF NOT EXISTS "IX_WorkItems_MilestoneId" ON "WorkItems" ("MilestoneId");
                CREATE INDEX IF NOT EXISTS "IX_WorkItems_ParentTaskId" ON "WorkItems" ("ParentTaskId");
                CREATE INDEX IF NOT EXISTS "IX_WorkItems_ProjectId_StageId_Status" ON "WorkItems" ("ProjectId", "StageId", "Status");
                CREATE INDEX IF NOT EXISTS "IX_WorkItems_ProjectId_StatusId" ON "WorkItems" ("ProjectId", "StatusId");
                CREATE INDEX IF NOT EXISTS "IX_WorkItems_ReporterId" ON "WorkItems" ("ReporterId");
                CREATE INDEX IF NOT EXISTS "IX_WorkItems_SprintId" ON "WorkItems" ("SprintId");
                CREATE INDEX IF NOT EXISTS "IX_WorkItems_StageId" ON "WorkItems" ("StageId");
                CREATE INDEX IF NOT EXISTS "IX_WorkItems_Status_ResolutionDueAt" ON "WorkItems" ("Status", "ResolutionDueAt");
                CREATE INDEX IF NOT EXISTS "IX_WorkItems_Status_ResponseDueAt" ON "WorkItems" ("Status", "ResponseDueAt");
                CREATE INDEX IF NOT EXISTS "IX_WorkItems_StatusId" ON "WorkItems" ("StatusId");
                CREATE UNIQUE INDEX IF NOT EXISTS "IX_WorkItems_Task_ProjectId_Number" ON "WorkItems" ("ProjectId", "Number") WHERE "ItemType" = 'Task';
                CREATE INDEX IF NOT EXISTS "IX_WorkItems_TenantId_AssigneeId" ON "WorkItems" ("TenantId", "AssigneeId");
                CREATE INDEX IF NOT EXISTS "IX_WorkItems_TenantId_DueDate" ON "WorkItems" ("TenantId", "DueDate");
                CREATE INDEX IF NOT EXISTS "IX_WorkItems_TenantId_ItemType" ON "WorkItems" ("TenantId", "ItemType");
                CREATE INDEX IF NOT EXISTS "IX_WorkItems_TenantId_Kind_RelatedProjectId" ON "WorkItems" ("TenantId", "Kind", "RelatedProjectId");
                CREATE INDEX IF NOT EXISTS "IX_WorkItems_TenantId_ProjectId" ON "WorkItems" ("TenantId", "ProjectId");
                CREATE INDEX IF NOT EXISTS "IX_WorkItems_TenantId_RelatedProjectId" ON "WorkItems" ("TenantId", "RelatedProjectId");
                CREATE INDEX IF NOT EXISTS "IX_WorkItems_TenantId_ScopeProjectId" ON "WorkItems" ("TenantId", "ScopeProjectId");
                CREATE INDEX IF NOT EXISTS "IX_WorkItems_TenantId_Status_DueDate" ON "WorkItems" ("TenantId", "Status", "DueDate");
                CREATE INDEX IF NOT EXISTS "IX_WorkItems_TenantId_WorkTypeId" ON "WorkItems" ("TenantId", "WorkTypeId");
                CREATE UNIQUE INDEX IF NOT EXISTS "IX_WorkItems_Work_TenantId_Number" ON "WorkItems" ("TenantId", "Number") WHERE "ItemType" = 'Work';
                CREATE INDEX IF NOT EXISTS "IX_WorkItems_WorkTypeId" ON "WorkItems" ("WorkTypeId");
                DO $$
                BEGIN
                  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
                    CREATE INDEX IF NOT EXISTS "IX_WorkItems_Title_trgm" ON "WorkItems" USING gin (lower("Title") gin_trgm_ops);
                    CREATE INDEX IF NOT EXISTS "IX_WorkItems_Description_trgm" ON "WorkItems" USING gin (lower("Description") gin_trgm_ops);
                    CREATE INDEX IF NOT EXISTS "IX_WorkItems_Details_trgm" ON "WorkItems" USING gin (lower("Details") gin_trgm_ops);
                    CREATE INDEX IF NOT EXISTS "IX_WorkItemComments_Body_trgm" ON "WorkItemComments" USING gin (lower("Body") gin_trgm_ops);
                  END IF;
                END $$;
                """"");
            migrationBuilder.Sql("""""
                -- 6. Foreign keys: the new tables' own, and every table that pointed at tasks, issues or work tasks now points at WorkItems (same ids).
                DO $$ BEGIN IF to_regclass('public."WorkItems"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_WorkItems_Milestones_MilestoneId' AND conrelid = 'public."WorkItems"'::regclass) THEN ALTER TABLE "WorkItems" ADD CONSTRAINT "FK_WorkItems_Milestones_MilestoneId" FOREIGN KEY ("MilestoneId") REFERENCES "Milestones" ("Id") ON DELETE SET NULL; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."WorkItems"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_WorkItems_ProjectStages_StageId' AND conrelid = 'public."WorkItems"'::regclass) THEN ALTER TABLE "WorkItems" ADD CONSTRAINT "FK_WorkItems_ProjectStages_StageId" FOREIGN KEY ("StageId") REFERENCES "ProjectStages" ("Id") ON DELETE SET NULL; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."WorkItems"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_WorkItems_Projects_ProjectId' AND conrelid = 'public."WorkItems"'::regclass) THEN ALTER TABLE "WorkItems" ADD CONSTRAINT "FK_WorkItems_Projects_ProjectId" FOREIGN KEY ("ProjectId") REFERENCES "Projects" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."WorkItems"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_WorkItems_Sprints_SprintId' AND conrelid = 'public."WorkItems"'::regclass) THEN ALTER TABLE "WorkItems" ADD CONSTRAINT "FK_WorkItems_Sprints_SprintId" FOREIGN KEY ("SprintId") REFERENCES "Sprints" ("Id") ON DELETE SET NULL; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."WorkItems"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_WorkItems_Users_AssigneeId' AND conrelid = 'public."WorkItems"'::regclass) THEN ALTER TABLE "WorkItems" ADD CONSTRAINT "FK_WorkItems_Users_AssigneeId" FOREIGN KEY ("AssigneeId") REFERENCES "Users" ("Id") ON DELETE RESTRICT; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."WorkItems"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_WorkItems_Users_ReporterId' AND conrelid = 'public."WorkItems"'::regclass) THEN ALTER TABLE "WorkItems" ADD CONSTRAINT "FK_WorkItems_Users_ReporterId" FOREIGN KEY ("ReporterId") REFERENCES "Users" ("Id") ON DELETE RESTRICT; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."WorkItems"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_WorkItems_WorkItems_ParentTaskId' AND conrelid = 'public."WorkItems"'::regclass) THEN ALTER TABLE "WorkItems" ADD CONSTRAINT "FK_WorkItems_WorkItems_ParentTaskId" FOREIGN KEY ("ParentTaskId") REFERENCES "WorkItems" ("Id") ON DELETE RESTRICT; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."WorkItems"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_WorkItems_WorkTypes_WorkTypeId' AND conrelid = 'public."WorkItems"'::regclass) THEN ALTER TABLE "WorkItems" ADD CONSTRAINT "FK_WorkItems_WorkTypes_WorkTypeId" FOREIGN KEY ("WorkTypeId") REFERENCES "WorkTypes" ("Id") ON DELETE RESTRICT; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."WorkItems"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_WorkItems_WorkflowStatuses_StatusId' AND conrelid = 'public."WorkItems"'::regclass) THEN ALTER TABLE "WorkItems" ADD CONSTRAINT "FK_WorkItems_WorkflowStatuses_StatusId" FOREIGN KEY ("StatusId") REFERENCES "WorkflowStatuses" ("Id") ON DELETE RESTRICT; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."WorkItemComments"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_WorkItemComments_Users_AuthorId' AND conrelid = 'public."WorkItemComments"'::regclass) THEN ALTER TABLE "WorkItemComments" ADD CONSTRAINT "FK_WorkItemComments_Users_AuthorId" FOREIGN KEY ("AuthorId") REFERENCES "Users" ("Id") ON DELETE RESTRICT; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."WorkItemComments"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_WorkItemComments_WorkItems_WorkItemId' AND conrelid = 'public."WorkItemComments"'::regclass) THEN ALTER TABLE "WorkItemComments" ADD CONSTRAINT "FK_WorkItemComments_WorkItems_WorkItemId" FOREIGN KEY ("WorkItemId") REFERENCES "WorkItems" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."AutomationRuns"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_AutomationRuns_WorkItems_TaskId' AND conrelid = 'public."AutomationRuns"'::regclass) THEN ALTER TABLE "AutomationRuns" ADD CONSTRAINT "FK_AutomationRuns_WorkItems_TaskId" FOREIGN KEY ("TaskId") REFERENCES "WorkItems" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."ChecklistItems"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_ChecklistItems_WorkItems_TaskId' AND conrelid = 'public."ChecklistItems"'::regclass) THEN ALTER TABLE "ChecklistItems" ADD CONSTRAINT "FK_ChecklistItems_WorkItems_TaskId" FOREIGN KEY ("TaskId") REFERENCES "WorkItems" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."CustomFieldValues"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_CustomFieldValues_WorkItems_TaskId' AND conrelid = 'public."CustomFieldValues"'::regclass) THEN ALTER TABLE "CustomFieldValues" ADD CONSTRAINT "FK_CustomFieldValues_WorkItems_TaskId" FOREIGN KEY ("TaskId") REFERENCES "WorkItems" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."DevLinks"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_DevLinks_WorkItems_TaskId' AND conrelid = 'public."DevLinks"'::regclass) THEN ALTER TABLE "DevLinks" ADD CONSTRAINT "FK_DevLinks_WorkItems_TaskId" FOREIGN KEY ("TaskId") REFERENCES "WorkItems" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."DevLinks"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_DevLinks_WorkItems_WorkTaskId' AND conrelid = 'public."DevLinks"'::regclass) THEN ALTER TABLE "DevLinks" ADD CONSTRAINT "FK_DevLinks_WorkItems_WorkTaskId" FOREIGN KEY ("WorkTaskId") REFERENCES "WorkItems" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."StageIssueEvents"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_StageIssueEvents_WorkItems_IssueId' AND conrelid = 'public."StageIssueEvents"'::regclass) THEN ALTER TABLE "StageIssueEvents" ADD CONSTRAINT "FK_StageIssueEvents_WorkItems_IssueId" FOREIGN KEY ("IssueId") REFERENCES "WorkItems" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."SupportTickets"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_SupportTickets_WorkItems_WorkTaskId' AND conrelid = 'public."SupportTickets"'::regclass) THEN ALTER TABLE "SupportTickets" ADD CONSTRAINT "FK_SupportTickets_WorkItems_WorkTaskId" FOREIGN KEY ("WorkTaskId") REFERENCES "WorkItems" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."TaskDependencies"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_TaskDependencies_WorkItems_DependsOnTaskId' AND conrelid = 'public."TaskDependencies"'::regclass) THEN ALTER TABLE "TaskDependencies" ADD CONSTRAINT "FK_TaskDependencies_WorkItems_DependsOnTaskId" FOREIGN KEY ("DependsOnTaskId") REFERENCES "WorkItems" ("Id") ON DELETE RESTRICT; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."TaskDependencies"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_TaskDependencies_WorkItems_TaskId' AND conrelid = 'public."TaskDependencies"'::regclass) THEN ALTER TABLE "TaskDependencies" ADD CONSTRAINT "FK_TaskDependencies_WorkItems_TaskId" FOREIGN KEY ("TaskId") REFERENCES "WorkItems" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."TaskLabels"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_TaskLabels_WorkItems_TaskId' AND conrelid = 'public."TaskLabels"'::regclass) THEN ALTER TABLE "TaskLabels" ADD CONSTRAINT "FK_TaskLabels_WorkItems_TaskId" FOREIGN KEY ("TaskId") REFERENCES "WorkItems" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."TimeEntries"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_TimeEntries_WorkItems_TaskId' AND conrelid = 'public."TimeEntries"'::regclass) THEN ALTER TABLE "TimeEntries" ADD CONSTRAINT "FK_TimeEntries_WorkItems_TaskId" FOREIGN KEY ("TaskId") REFERENCES "WorkItems" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."TimeEntries"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_TimeEntries_WorkItems_WorkTaskId' AND conrelid = 'public."TimeEntries"'::regclass) THEN ALTER TABLE "TimeEntries" ADD CONSTRAINT "FK_TimeEntries_WorkItems_WorkTaskId" FOREIGN KEY ("WorkTaskId") REFERENCES "WorkItems" ("Id") ON DELETE CASCADE; END IF; END $$;
                """"");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""""
                -- 1. Keys to and from the new tables go; the old tables come back under their own names.
                -- every foreign key to or from the new tables
                DO $$
                DECLARE
                  r record;
                BEGIN
                  FOR r IN
                    SELECT c.conname, c.conrelid::regclass AS tbl
                    FROM pg_constraint c
                    WHERE c.contype = 'f'
                      AND (c.confrelid IN (SELECT to_regclass(x) FROM unnest(ARRAY['public."WorkItems"', 'public."WorkItemComments"', 'public."WorkItemAttachments"']) x WHERE to_regclass(x) IS NOT NULL)
                        OR c.conrelid IN (SELECT to_regclass(x) FROM unnest(ARRAY['public."WorkItems"', 'public."WorkItemComments"', 'public."WorkItemAttachments"']) x WHERE to_regclass(x) IS NOT NULL))
                  LOOP
                    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
                  END LOOP;
                END $$;
                DO $$ BEGIN IF to_regclass('public."legacy_Tasks"') IS NOT NULL AND to_regclass('public."Tasks"') IS NULL THEN ALTER TABLE "legacy_Tasks" RENAME TO "Tasks"; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."legacy_StageIssues"') IS NOT NULL AND to_regclass('public."StageIssues"') IS NULL THEN ALTER TABLE "legacy_StageIssues" RENAME TO "StageIssues"; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."legacy_WorkTasks"') IS NOT NULL AND to_regclass('public."WorkTasks"') IS NULL THEN ALTER TABLE "legacy_WorkTasks" RENAME TO "WorkTasks"; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."legacy_TaskComments"') IS NOT NULL AND to_regclass('public."TaskComments"') IS NULL THEN ALTER TABLE "legacy_TaskComments" RENAME TO "TaskComments"; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."legacy_WorkTaskComments"') IS NOT NULL AND to_regclass('public."WorkTaskComments"') IS NULL THEN ALTER TABLE "legacy_WorkTaskComments" RENAME TO "WorkTaskComments"; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."legacy_WorkTaskAttachments"') IS NOT NULL AND to_regclass('public."WorkTaskAttachments"') IS NULL THEN ALTER TABLE "legacy_WorkTaskAttachments" RENAME TO "WorkTaskAttachments"; END IF; END $$;
                """"");
            migrationBuilder.Sql("""""
                -- 2. What changed since the upgrade goes back into the old tables (new rows, edits and deletions).
                INSERT INTO "Tasks" ("Id", "TenantId", "Number", "Title", "AssigneeId", "ReporterId", "Description", "StartDate", "DueDate", "CompletedAt", "Version", "IsDeleted", "DeletedAt", "DeletedBy", "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy", "ProjectId", "ParentTaskId", "StageId", "MilestoneId", "SprintId", "StatusId", "Priority", "EstimatedHours", "ActualHours", "Position")
                  SELECT "Id", "TenantId", "Number", "Title", "AssigneeId", "ReporterId", "Description", "StartDate", "DueDate", "CompletedAt", "Version", "IsDeleted", "DeletedAt", "DeletedBy", "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy", "ProjectId", "ParentTaskId", "StageId", "MilestoneId", "SprintId", "StatusId", "Priority", "EstimatedHours", "ActualHours", "Position" FROM "WorkItems" WHERE "ItemType" = 'Task'
                  ON CONFLICT ("Id") DO UPDATE SET "TenantId" = EXCLUDED."TenantId", "Number" = EXCLUDED."Number", "Title" = EXCLUDED."Title", "AssigneeId" = EXCLUDED."AssigneeId", "ReporterId" = EXCLUDED."ReporterId", "Description" = EXCLUDED."Description", "StartDate" = EXCLUDED."StartDate", "DueDate" = EXCLUDED."DueDate", "CompletedAt" = EXCLUDED."CompletedAt", "Version" = EXCLUDED."Version", "IsDeleted" = EXCLUDED."IsDeleted", "DeletedAt" = EXCLUDED."DeletedAt", "DeletedBy" = EXCLUDED."DeletedBy", "CreatedAt" = EXCLUDED."CreatedAt", "CreatedBy" = EXCLUDED."CreatedBy", "UpdatedAt" = EXCLUDED."UpdatedAt", "UpdatedBy" = EXCLUDED."UpdatedBy", "ProjectId" = EXCLUDED."ProjectId", "ParentTaskId" = EXCLUDED."ParentTaskId", "StageId" = EXCLUDED."StageId", "MilestoneId" = EXCLUDED."MilestoneId", "SprintId" = EXCLUDED."SprintId", "StatusId" = EXCLUDED."StatusId", "Priority" = EXCLUDED."Priority", "EstimatedHours" = EXCLUDED."EstimatedHours", "ActualHours" = EXCLUDED."ActualHours", "Position" = EXCLUDED."Position";
                DELETE FROM "Tasks" o WHERE NOT EXISTS (SELECT 1 FROM "WorkItems" n WHERE n."Id" = o."Id" AND n."ItemType" = 'Task');
                INSERT INTO "StageIssues" ("Id", "TenantId", "Number", "Title", "AssigneeId", "ReporterId", "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy", "ProjectId", "StageId", "Severity", "Details", "Status", "ResolvedAt", "ResolvedBy")
                  SELECT "Id", "TenantId", "Number", "Title", "AssigneeId", "ReporterId", "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy", "ProjectId", "StageId", "Priority", "Details", "Status", "ResolvedAt", "ResolvedBy" FROM "WorkItems" WHERE "ItemType" = 'Issue'
                  ON CONFLICT ("Id") DO UPDATE SET "TenantId" = EXCLUDED."TenantId", "Number" = EXCLUDED."Number", "Title" = EXCLUDED."Title", "AssigneeId" = EXCLUDED."AssigneeId", "ReporterId" = EXCLUDED."ReporterId", "CreatedAt" = EXCLUDED."CreatedAt", "CreatedBy" = EXCLUDED."CreatedBy", "UpdatedAt" = EXCLUDED."UpdatedAt", "UpdatedBy" = EXCLUDED."UpdatedBy", "ProjectId" = EXCLUDED."ProjectId", "StageId" = EXCLUDED."StageId", "Severity" = EXCLUDED."Severity", "Details" = EXCLUDED."Details", "Status" = EXCLUDED."Status", "ResolvedAt" = EXCLUDED."ResolvedAt", "ResolvedBy" = EXCLUDED."ResolvedBy";
                DELETE FROM "StageIssues" o WHERE NOT EXISTS (SELECT 1 FROM "WorkItems" n WHERE n."Id" = o."Id" AND n."ItemType" = 'Issue');
                INSERT INTO "WorkTasks" ("Id", "TenantId", "Number", "Title", "AssigneeId", "ReporterId", "Description", "StartDate", "DueDate", "CompletedAt", "Version", "IsDeleted", "DeletedAt", "DeletedBy", "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy", "Kind", "WorkTypeId", "RelatedProjectId", "Priority", "Status", "CompletedBy", "ResolutionNote", "ResolutionWorkVersion", "ResolutionProposedBy", "ResolutionProposedAt", "ResolutionAcceptedBy", "ResolutionAcceptedAt", "ResolutionDocumentId", "ResolutionDocumentVersion", "RespondedAt", "ResponseDueAt", "ResolutionDueAt", "ResolutionRiskAt", "SlaPausedAt", "SlaPausedMinutes", "SlaAlerted")
                  SELECT "Id", "TenantId", "Number", "Title", "AssigneeId", "ReporterId", left("Description", 8000), "StartDate", "DueDate", "CompletedAt", "Version", "IsDeleted", "DeletedAt", "DeletedBy", "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy", "Kind", "WorkTypeId", "RelatedProjectId", "Priority", "Status", "CompletedBy", "ResolutionNote", "ResolutionWorkVersion", "ResolutionProposedBy", "ResolutionProposedAt", "ResolutionAcceptedBy", "ResolutionAcceptedAt", "ResolutionDocumentId", "ResolutionDocumentVersion", "RespondedAt", "ResponseDueAt", "ResolutionDueAt", "ResolutionRiskAt", "SlaPausedAt", "SlaPausedMinutes", "SlaAlerted" FROM "WorkItems" WHERE "ItemType" = 'Work'
                  ON CONFLICT ("Id") DO UPDATE SET "TenantId" = EXCLUDED."TenantId", "Number" = EXCLUDED."Number", "Title" = EXCLUDED."Title", "AssigneeId" = EXCLUDED."AssigneeId", "ReporterId" = EXCLUDED."ReporterId", "Description" = EXCLUDED."Description", "StartDate" = EXCLUDED."StartDate", "DueDate" = EXCLUDED."DueDate", "CompletedAt" = EXCLUDED."CompletedAt", "Version" = EXCLUDED."Version", "IsDeleted" = EXCLUDED."IsDeleted", "DeletedAt" = EXCLUDED."DeletedAt", "DeletedBy" = EXCLUDED."DeletedBy", "CreatedAt" = EXCLUDED."CreatedAt", "CreatedBy" = EXCLUDED."CreatedBy", "UpdatedAt" = EXCLUDED."UpdatedAt", "UpdatedBy" = EXCLUDED."UpdatedBy", "Kind" = EXCLUDED."Kind", "WorkTypeId" = EXCLUDED."WorkTypeId", "RelatedProjectId" = EXCLUDED."RelatedProjectId", "Priority" = EXCLUDED."Priority", "Status" = EXCLUDED."Status", "CompletedBy" = EXCLUDED."CompletedBy", "ResolutionNote" = EXCLUDED."ResolutionNote", "ResolutionWorkVersion" = EXCLUDED."ResolutionWorkVersion", "ResolutionProposedBy" = EXCLUDED."ResolutionProposedBy", "ResolutionProposedAt" = EXCLUDED."ResolutionProposedAt", "ResolutionAcceptedBy" = EXCLUDED."ResolutionAcceptedBy", "ResolutionAcceptedAt" = EXCLUDED."ResolutionAcceptedAt", "ResolutionDocumentId" = EXCLUDED."ResolutionDocumentId", "ResolutionDocumentVersion" = EXCLUDED."ResolutionDocumentVersion", "RespondedAt" = EXCLUDED."RespondedAt", "ResponseDueAt" = EXCLUDED."ResponseDueAt", "ResolutionDueAt" = EXCLUDED."ResolutionDueAt", "ResolutionRiskAt" = EXCLUDED."ResolutionRiskAt", "SlaPausedAt" = EXCLUDED."SlaPausedAt", "SlaPausedMinutes" = EXCLUDED."SlaPausedMinutes", "SlaAlerted" = EXCLUDED."SlaAlerted";
                DELETE FROM "WorkTasks" o WHERE NOT EXISTS (SELECT 1 FROM "WorkItems" n WHERE n."Id" = o."Id" AND n."ItemType" = 'Work');
                INSERT INTO "TaskComments" ("Id", "TenantId", "TaskId", "AuthorId", "Body", "ParentCommentId", "EditedAt", "IsDeleted", "DeletedAt", "DeletedBy", "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy")
                  SELECT "Id", "TenantId", "WorkItemId", "AuthorId", "Body", "ParentCommentId", "EditedAt", "IsDeleted", "DeletedAt", "DeletedBy", "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy" FROM "WorkItemComments" WHERE "ItemType" = 'Task'
                  ON CONFLICT ("Id") DO UPDATE SET "TenantId" = EXCLUDED."TenantId", "TaskId" = EXCLUDED."TaskId", "AuthorId" = EXCLUDED."AuthorId", "Body" = EXCLUDED."Body", "ParentCommentId" = EXCLUDED."ParentCommentId", "EditedAt" = EXCLUDED."EditedAt", "IsDeleted" = EXCLUDED."IsDeleted", "DeletedAt" = EXCLUDED."DeletedAt", "DeletedBy" = EXCLUDED."DeletedBy", "CreatedAt" = EXCLUDED."CreatedAt", "CreatedBy" = EXCLUDED."CreatedBy", "UpdatedAt" = EXCLUDED."UpdatedAt", "UpdatedBy" = EXCLUDED."UpdatedBy";
                DELETE FROM "TaskComments" o WHERE NOT EXISTS (SELECT 1 FROM "WorkItemComments" n WHERE n."Id" = o."Id" AND n."ItemType" = 'Task');
                INSERT INTO "WorkTaskComments" ("Id", "TenantId", "AuthorId", "EditedAt", "IsDeleted", "DeletedAt", "DeletedBy", "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy", "WorkTaskId", "Body")
                  SELECT "Id", "TenantId", "AuthorId", "EditedAt", "IsDeleted", "DeletedAt", "DeletedBy", "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy", "WorkItemId", left("Body", 4000) FROM "WorkItemComments" WHERE "ItemType" = 'Work'
                  ON CONFLICT ("Id") DO UPDATE SET "TenantId" = EXCLUDED."TenantId", "AuthorId" = EXCLUDED."AuthorId", "EditedAt" = EXCLUDED."EditedAt", "IsDeleted" = EXCLUDED."IsDeleted", "DeletedAt" = EXCLUDED."DeletedAt", "DeletedBy" = EXCLUDED."DeletedBy", "CreatedAt" = EXCLUDED."CreatedAt", "CreatedBy" = EXCLUDED."CreatedBy", "UpdatedAt" = EXCLUDED."UpdatedAt", "UpdatedBy" = EXCLUDED."UpdatedBy", "WorkTaskId" = EXCLUDED."WorkTaskId", "Body" = EXCLUDED."Body";
                DELETE FROM "WorkTaskComments" o WHERE NOT EXISTS (SELECT 1 FROM "WorkItemComments" n WHERE n."Id" = o."Id" AND n."ItemType" = 'Work')
                  AND EXISTS (SELECT 1 FROM "WorkTasks" w WHERE w."Id" = o."WorkTaskId");
                INSERT INTO "WorkTaskAttachments" ("Id", "TenantId", "WorkTaskId", "FileName", "ContentType", "SizeBytes", "StorageKey", "Sha256", "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy")
                  SELECT "Id", "TenantId", "WorkItemId", "FileName", "ContentType", "SizeBytes", "StorageKey", "Sha256", "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy" FROM "WorkItemAttachments" WHERE TRUE
                  ON CONFLICT ("Id") DO UPDATE SET "TenantId" = EXCLUDED."TenantId", "WorkTaskId" = EXCLUDED."WorkTaskId", "FileName" = EXCLUDED."FileName", "ContentType" = EXCLUDED."ContentType", "SizeBytes" = EXCLUDED."SizeBytes", "StorageKey" = EXCLUDED."StorageKey", "Sha256" = EXCLUDED."Sha256", "CreatedAt" = EXCLUDED."CreatedAt", "CreatedBy" = EXCLUDED."CreatedBy", "UpdatedAt" = EXCLUDED."UpdatedAt", "UpdatedBy" = EXCLUDED."UpdatedBy";
                DELETE FROM "WorkTaskAttachments" o WHERE NOT EXISTS (SELECT 1 FROM "WorkItemAttachments" n WHERE n."Id" = o."Id");
                INSERT INTO "StageIssueEvents" ("Id", "TenantId", "IssueId", "Kind", "Note", "ActorId", "CreatedAt", "CreatedBy")
                  SELECT c."Id", c."TenantId", c."WorkItemId", 'comment', left(c."Body", 1000), c."AuthorId", c."CreatedAt", c."CreatedBy"
                  FROM "WorkItemComments" c WHERE c."ItemType" = 'Issue' AND NOT c."IsDeleted" AND EXISTS (SELECT 1 FROM "StageIssues" i WHERE i."Id" = c."WorkItemId")
                  ON CONFLICT ("Id") DO NOTHING;
                """"");
            migrationBuilder.Sql("""""
                -- 3. The old foreign keys.
                DO $$ BEGIN IF to_regclass('public."WorkTasks"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_WorkTasks_WorkTypes_WorkTypeId' AND conrelid = 'public."WorkTasks"'::regclass) THEN ALTER TABLE "WorkTasks" ADD CONSTRAINT "FK_WorkTasks_WorkTypes_WorkTypeId" FOREIGN KEY ("WorkTypeId") REFERENCES "WorkTypes" ("Id") ON DELETE RESTRICT; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."SupportTickets"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_SupportTickets_WorkTasks_WorkTaskId' AND conrelid = 'public."SupportTickets"'::regclass) THEN ALTER TABLE "SupportTickets" ADD CONSTRAINT "FK_SupportTickets_WorkTasks_WorkTaskId" FOREIGN KEY ("WorkTaskId") REFERENCES "WorkTasks" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."StageIssues"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_StageIssues_ProjectStages_StageId' AND conrelid = 'public."StageIssues"'::regclass) THEN ALTER TABLE "StageIssues" ADD CONSTRAINT "FK_StageIssues_ProjectStages_StageId" FOREIGN KEY ("StageId") REFERENCES "ProjectStages" ("Id") ON DELETE SET NULL; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."Tasks"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_Tasks_Milestones_MilestoneId' AND conrelid = 'public."Tasks"'::regclass) THEN ALTER TABLE "Tasks" ADD CONSTRAINT "FK_Tasks_Milestones_MilestoneId" FOREIGN KEY ("MilestoneId") REFERENCES "Milestones" ("Id") ON DELETE SET NULL; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."Tasks"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_Tasks_ProjectStages_StageId' AND conrelid = 'public."Tasks"'::regclass) THEN ALTER TABLE "Tasks" ADD CONSTRAINT "FK_Tasks_ProjectStages_StageId" FOREIGN KEY ("StageId") REFERENCES "ProjectStages" ("Id") ON DELETE SET NULL; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."Tasks"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_Tasks_Projects_ProjectId' AND conrelid = 'public."Tasks"'::regclass) THEN ALTER TABLE "Tasks" ADD CONSTRAINT "FK_Tasks_Projects_ProjectId" FOREIGN KEY ("ProjectId") REFERENCES "Projects" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."Tasks"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_Tasks_Sprints_SprintId' AND conrelid = 'public."Tasks"'::regclass) THEN ALTER TABLE "Tasks" ADD CONSTRAINT "FK_Tasks_Sprints_SprintId" FOREIGN KEY ("SprintId") REFERENCES "Sprints" ("Id") ON DELETE SET NULL; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."Tasks"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_Tasks_Tasks_ParentTaskId' AND conrelid = 'public."Tasks"'::regclass) THEN ALTER TABLE "Tasks" ADD CONSTRAINT "FK_Tasks_Tasks_ParentTaskId" FOREIGN KEY ("ParentTaskId") REFERENCES "Tasks" ("Id") ON DELETE RESTRICT; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."Tasks"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_Tasks_Users_AssigneeId' AND conrelid = 'public."Tasks"'::regclass) THEN ALTER TABLE "Tasks" ADD CONSTRAINT "FK_Tasks_Users_AssigneeId" FOREIGN KEY ("AssigneeId") REFERENCES "Users" ("Id") ON DELETE RESTRICT; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."Tasks"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_Tasks_Users_ReporterId' AND conrelid = 'public."Tasks"'::regclass) THEN ALTER TABLE "Tasks" ADD CONSTRAINT "FK_Tasks_Users_ReporterId" FOREIGN KEY ("ReporterId") REFERENCES "Users" ("Id") ON DELETE RESTRICT; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."Tasks"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_Tasks_WorkflowStatuses_StatusId' AND conrelid = 'public."Tasks"'::regclass) THEN ALTER TABLE "Tasks" ADD CONSTRAINT "FK_Tasks_WorkflowStatuses_StatusId" FOREIGN KEY ("StatusId") REFERENCES "WorkflowStatuses" ("Id") ON DELETE RESTRICT; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."StageIssueEvents"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_StageIssueEvents_StageIssues_IssueId' AND conrelid = 'public."StageIssueEvents"'::regclass) THEN ALTER TABLE "StageIssueEvents" ADD CONSTRAINT "FK_StageIssueEvents_StageIssues_IssueId" FOREIGN KEY ("IssueId") REFERENCES "StageIssues" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."AutomationRuns"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_AutomationRuns_Tasks_TaskId' AND conrelid = 'public."AutomationRuns"'::regclass) THEN ALTER TABLE "AutomationRuns" ADD CONSTRAINT "FK_AutomationRuns_Tasks_TaskId" FOREIGN KEY ("TaskId") REFERENCES "Tasks" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."ChecklistItems"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_ChecklistItems_Tasks_TaskId' AND conrelid = 'public."ChecklistItems"'::regclass) THEN ALTER TABLE "ChecklistItems" ADD CONSTRAINT "FK_ChecklistItems_Tasks_TaskId" FOREIGN KEY ("TaskId") REFERENCES "Tasks" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."CustomFieldValues"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_CustomFieldValues_Tasks_TaskId' AND conrelid = 'public."CustomFieldValues"'::regclass) THEN ALTER TABLE "CustomFieldValues" ADD CONSTRAINT "FK_CustomFieldValues_Tasks_TaskId" FOREIGN KEY ("TaskId") REFERENCES "Tasks" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."DevLinks"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_DevLinks_Tasks_TaskId' AND conrelid = 'public."DevLinks"'::regclass) THEN ALTER TABLE "DevLinks" ADD CONSTRAINT "FK_DevLinks_Tasks_TaskId" FOREIGN KEY ("TaskId") REFERENCES "Tasks" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."DevLinks"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_DevLinks_WorkTasks_WorkTaskId' AND conrelid = 'public."DevLinks"'::regclass) THEN ALTER TABLE "DevLinks" ADD CONSTRAINT "FK_DevLinks_WorkTasks_WorkTaskId" FOREIGN KEY ("WorkTaskId") REFERENCES "WorkTasks" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."TaskComments"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_TaskComments_Tasks_TaskId' AND conrelid = 'public."TaskComments"'::regclass) THEN ALTER TABLE "TaskComments" ADD CONSTRAINT "FK_TaskComments_Tasks_TaskId" FOREIGN KEY ("TaskId") REFERENCES "Tasks" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."TaskComments"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_TaskComments_Users_AuthorId' AND conrelid = 'public."TaskComments"'::regclass) THEN ALTER TABLE "TaskComments" ADD CONSTRAINT "FK_TaskComments_Users_AuthorId" FOREIGN KEY ("AuthorId") REFERENCES "Users" ("Id") ON DELETE RESTRICT; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."TaskDependencies"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_TaskDependencies_Tasks_DependsOnTaskId' AND conrelid = 'public."TaskDependencies"'::regclass) THEN ALTER TABLE "TaskDependencies" ADD CONSTRAINT "FK_TaskDependencies_Tasks_DependsOnTaskId" FOREIGN KEY ("DependsOnTaskId") REFERENCES "Tasks" ("Id") ON DELETE RESTRICT; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."TaskDependencies"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_TaskDependencies_Tasks_TaskId' AND conrelid = 'public."TaskDependencies"'::regclass) THEN ALTER TABLE "TaskDependencies" ADD CONSTRAINT "FK_TaskDependencies_Tasks_TaskId" FOREIGN KEY ("TaskId") REFERENCES "Tasks" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."TaskLabels"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_TaskLabels_Tasks_TaskId' AND conrelid = 'public."TaskLabels"'::regclass) THEN ALTER TABLE "TaskLabels" ADD CONSTRAINT "FK_TaskLabels_Tasks_TaskId" FOREIGN KEY ("TaskId") REFERENCES "Tasks" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."TimeEntries"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_TimeEntries_Tasks_TaskId' AND conrelid = 'public."TimeEntries"'::regclass) THEN ALTER TABLE "TimeEntries" ADD CONSTRAINT "FK_TimeEntries_Tasks_TaskId" FOREIGN KEY ("TaskId") REFERENCES "Tasks" ("Id") ON DELETE CASCADE; END IF; END $$;
                DO $$ BEGIN IF to_regclass('public."TimeEntries"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_TimeEntries_WorkTasks_WorkTaskId' AND conrelid = 'public."TimeEntries"'::regclass) THEN ALTER TABLE "TimeEntries" ADD CONSTRAINT "FK_TimeEntries_WorkTasks_WorkTaskId" FOREIGN KEY ("WorkTaskId") REFERENCES "WorkTasks" ("Id") ON DELETE CASCADE; END IF; END $$;
                """"");
            migrationBuilder.Sql("""""
                -- 4. The new tables go.
                DROP TABLE IF EXISTS "WorkItemAttachments";
                DROP TABLE IF EXISTS "WorkItemComments";
                DROP TABLE IF EXISTS "WorkItems";
                """"");
        }
    }
}
