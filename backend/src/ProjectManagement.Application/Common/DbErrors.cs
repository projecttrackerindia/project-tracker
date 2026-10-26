using System.Data.Common;
using Microsoft.EntityFrameworkCore;

namespace ProjectManagement.Application.Common;

/// <summary>
/// Recognises a unique-index violation from either database without the Application layer depending on a provider package. PostgreSQL
/// reports SQLSTATE 23505 with the index name in its message ("duplicate key value violates unique constraint \"IX_...\""); SQLite
/// reports "UNIQUE constraint failed: Table.Column, Table.Column".
/// </summary>
public static class DbErrors
{
    public const string ProjectKeyIndex = "IX_Projects_TenantId_Key";
    public const string TaskNumberIndex = "IX_WorkItems_Task_ProjectId_Number";
    public const string RunningTimerIndex = "IX_TimeEntries_TenantId_UserId_Running";

    public static bool IsUniqueViolation(DbUpdateException error, string indexName, string table, params string[] columns)
    {
        for (Exception? x = error; x is not null; x = x.InnerException)
        {
            if (x is DbException { SqlState: "23505" }) return x.Message.Contains(indexName, StringComparison.Ordinal);
            if (x.Message.Contains("UNIQUE constraint failed", StringComparison.Ordinal))
                return columns.All(c => x.Message.Contains($"{table}.{c}", StringComparison.Ordinal));
        }
        return false;
    }

    public static bool IsProjectKeyTaken(DbUpdateException e) => IsUniqueViolation(e, ProjectKeyIndex, "Projects", "TenantId", "Key");
    public static bool IsTaskNumberTaken(DbUpdateException e) => IsUniqueViolation(e, TaskNumberIndex, "WorkItems", "ProjectId", "Number");
    // SQLite names the columns, not the index: the running timer is the only unique index on TimeEntries (TenantId, UserId).
    public static bool IsTimerRunning(DbUpdateException e) => IsUniqueViolation(e, RunningTimerIndex, "TimeEntries", "TenantId", "UserId");
}
