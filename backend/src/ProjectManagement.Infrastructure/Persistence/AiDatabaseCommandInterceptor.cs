using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Infrastructure.Persistence;

/// <summary>Database execution timing within an explicitly enabled AI measurement scope, without retaining SQL.</summary>
public sealed class AiDatabaseCommandInterceptor(AiDatabaseTelemetry telemetry) : DbCommandInterceptor
{
    public override DbDataReader ReaderExecuted(DbCommand command, CommandExecutedEventData data, DbDataReader result) { telemetry.Record(data.Duration); return result; }
    public override ValueTask<DbDataReader> ReaderExecutedAsync(DbCommand command, CommandExecutedEventData data, DbDataReader result, CancellationToken ct = default) { telemetry.Record(data.Duration); return ValueTask.FromResult(result); }
    public override int NonQueryExecuted(DbCommand command, CommandExecutedEventData data, int result) { telemetry.Record(data.Duration); return result; }
    public override ValueTask<int> NonQueryExecutedAsync(DbCommand command, CommandExecutedEventData data, int result, CancellationToken ct = default) { telemetry.Record(data.Duration); return ValueTask.FromResult(result); }
    public override object? ScalarExecuted(DbCommand command, CommandExecutedEventData data, object? result) { telemetry.Record(data.Duration); return result; }
    public override ValueTask<object?> ScalarExecutedAsync(DbCommand command, CommandExecutedEventData data, object? result, CancellationToken ct = default) { telemetry.Record(data.Duration); return ValueTask.FromResult(result); }
    public override void CommandFailed(DbCommand command, CommandErrorEventData data) => telemetry.Record(data.Duration, true);
    public override Task CommandFailedAsync(DbCommand command, CommandErrorEventData data, CancellationToken ct = default) { telemetry.Record(data.Duration, true); return Task.CompletedTask; }
}
