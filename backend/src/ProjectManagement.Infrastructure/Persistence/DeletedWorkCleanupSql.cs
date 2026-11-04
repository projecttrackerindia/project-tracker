namespace ProjectManagement.Infrastructure.Persistence;

/// <summary>
/// One-off clean-up (migration 20261215001000_HideTracesOfDeletedWork) of what deleted projects and tasks left behind before the delete cascaded,
/// and of action items saved twice. PostgreSQL only. Nothing is ever removed: work is soft-deleted (IsDeleted), reminders are stopped with the
/// "orphaned" mark (see ReminderSync.Orphaned), notifications are archived. Every statement is idempotent. <paramref name="tenantId"/> narrows it
/// to one workspace (tests); null = every workspace.
/// </summary>
public static class DeletedWorkCleanupSql
{
    public const string Orphaned = "0a0a0a0a-0000-4000-8000-00000000de1e";
    private const string Uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

    /// <summary>Two copies of one action item: same workspace, project, title, owner, meeting, due date and state, made within this many seconds.</summary>
    public const int DuplicateWindowSeconds = 10;

    public static string[] Statements(Guid? tenantId = null)
    {
        string T(string alias) => tenantId is { } t ? $" AND {alias}.\"TenantId\" = '{t}'" : "";
        return
        [
            // 1. Tasks and action items of a deleted project.
            $"""
            UPDATE "WorkItems" w SET "IsDeleted" = TRUE, "DeletedAt" = COALESCE(p."DeletedAt", now()), "DeletedBy" = p."DeletedBy"
            FROM "Projects" p
            WHERE p."IsDeleted" AND NOT w."IsDeleted" AND w."TenantId" = p."TenantId"
              AND ((w."ItemType" = 'Task' AND w."ProjectId" = p."Id") OR (w."ItemType" = 'Work' AND w."Kind" = 'ActionItem' AND w."RelatedProjectId" = p."Id")){T("w")};
            """,
            // 2. Subtasks of a deleted task (two levels deep is as far as subtasks go; run twice to be sure).
            $"""
            UPDATE "WorkItems" c SET "IsDeleted" = TRUE, "DeletedAt" = COALESCE(t."DeletedAt", now()), "DeletedBy" = t."DeletedBy"
            FROM "WorkItems" t
            WHERE c."ItemType" = 'Task' AND t."ItemType" = 'Task' AND c."ParentTaskId" = t."Id" AND t."IsDeleted" AND NOT c."IsDeleted"{T("c")};
            """,
            $"""
            UPDATE "WorkItems" c SET "IsDeleted" = TRUE, "DeletedAt" = COALESCE(t."DeletedAt", now()), "DeletedBy" = t."DeletedBy"
            FROM "WorkItems" t
            WHERE c."ItemType" = 'Task' AND t."ItemType" = 'Task' AND c."ParentTaskId" = t."Id" AND t."IsDeleted" AND NOT c."IsDeleted"{T("c")};
            """,
            // 3. Action items saved twice: the oldest copy stays, later copies are soft-deleted.
            $"""
            UPDATE "WorkItems" d SET "IsDeleted" = TRUE, "DeletedAt" = now()
            WHERE d."ItemType" = 'Work' AND d."Kind" = 'ActionItem' AND NOT d."IsDeleted"{T("d")}
              AND EXISTS (SELECT 1 FROM "WorkItems" o
                          WHERE o."ItemType" = 'Work' AND o."Kind" = 'ActionItem' AND NOT o."IsDeleted" AND o."Id" <> d."Id"
                            AND o."TenantId" = d."TenantId"
                            AND o."RelatedProjectId" IS NOT DISTINCT FROM d."RelatedProjectId"
                            AND lower(btrim(o."Title")) = lower(btrim(d."Title"))
                            AND o."AssigneeId" IS NOT DISTINCT FROM d."AssigneeId"
                            AND o."SourceMeetingRef" IS NOT DISTINCT FROM d."SourceMeetingRef"
                            AND o."DueDate" IS NOT DISTINCT FROM d."DueDate"
                            AND o."Status" = d."Status"
                            AND (o."CreatedAt" < d."CreatedAt" OR (o."CreatedAt" = d."CreatedAt" AND o."Id" < d."Id"))
                            AND d."CreatedAt" - o."CreatedAt" <= interval '{DuplicateWindowSeconds} seconds');
            """,
            // 4. Open reminders about a deleted project or deleted (or gone) work: stopped, marked orphaned.
            $"""
            UPDATE "Reminders" r SET "State" = 'Cancelled', "LockToken" = '{Orphaned}', "LockedUntil" = NULL, "ActionTokenHash" = NULL
            WHERE r."State" IN ('Scheduled', 'Fired'){T("r")}
              AND ((r."TargetProjectId" IS NOT NULL AND EXISTS (SELECT 1 FROM "Projects" p WHERE p."Id" = r."TargetProjectId" AND p."IsDeleted"))
                OR (r."TargetType" IN ('Task', 'Issue', 'ActionItem', 'Operational') AND r."TargetId" IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM "WorkItems" w WHERE w."Id" = r."TargetId" AND NOT w."IsDeleted")));
            """,
            // 5. Notifications that open a deleted project or deleted work: archived (out of the inbox, still under Archived).
            $"""
            UPDATE "Notifications" n SET "ArchivedAt" = now(), "ReadAt" = COALESCE(n."ReadAt", now())
            WHERE n."ArchivedAt" IS NULL AND n."Link" IS NOT NULL{T("n")}
              AND (EXISTS (SELECT 1 FROM "Projects" p WHERE p."IsDeleted" AND p."Id" = CAST(substring(n."Link" from '/projects/({Uuid})') AS uuid))
                OR EXISTS (SELECT 1 FROM "WorkItems" w WHERE w."IsDeleted" AND w."Id" = CAST(substring(n."Link" from '(?:task|action)=({Uuid})') AS uuid))
                OR EXISTS (SELECT 1 FROM "WorkItems" w WHERE w."IsDeleted" AND w."Id" = CAST(substring(n."Link" from '/tasks/({Uuid})') AS uuid)));
            """,
        ];
    }
}
