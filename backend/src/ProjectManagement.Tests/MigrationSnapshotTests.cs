using System.Reflection;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.EntityFrameworkCore.Migrations.Operations;
using ProjectManagement.Infrastructure.Persistence;

namespace ProjectManagement.Tests;

/// <summary>
/// The migrations' model snapshot must match the model. On PostgreSQL, MigrateAsync refuses to run when they differ (EF's pending model
/// changes check), so a hand-written migration whose snapshot entry is off would stop the server from starting after a deploy. The
/// ordinary API tests build the schema from the model and never notice; this test lists every difference by table and column.
/// </summary>
public class MigrationSnapshotTests
{
    [Fact]
    public void The_snapshot_matches_the_model()
    {
        using var db = new DesignTimeDbContextFactory().CreateDbContext([]);
        var snapshot = db.GetService<IMigrationsAssembly>().ModelSnapshot?.Model;
        Assert.NotNull(snapshot);
        if (snapshot is IMutableModel mutable) snapshot = mutable.FinalizeModel();
        snapshot = db.GetService<IModelRuntimeInitializer>().Initialize(snapshot!, designTime: true, validationLogger: null);
        var model = db.GetService<IDesignTimeModel>().Model;
        var differences = db.GetService<IMigrationsModelDiffer>().GetDifferences(snapshot.GetRelationalModel(), model.GetRelationalModel());
        Assert.True(differences.Count == 0, $"{differences.Count} difference(s) between the snapshot and the model:\n" + string.Join("\n", differences.Select(Describe)));
    }

    private static string Describe(MigrationOperation op)
    {
        string? Prop(string name) => op.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance)?.GetValue(op) switch
        {
            null => null,
            string s => s,
            string[] a => string.Join(",", a),
            var v => v.ToString(),
        };
        var parts = new[] { op.GetType().Name.Replace("Operation", ""), Prop("Table"), Prop("Name"), Prop("Columns") is { } c ? $"({c})" : null, Prop("ClrType"),
            Prop("ColumnType"), Prop("IsNullable") is { } n ? $"nullable={n}" : null, Prop("MaxLength") is { } m ? $"max={m}" : null, Prop("IsUnique") is { } u ? $"unique={u}" : null,
            Prop("DefaultValue") is { } d ? $"default={d}" : null };
        var text = string.Join(" ", parts.Where(p => !string.IsNullOrEmpty(p)));
        if (op is AlterColumnOperation alter)
            text += $" was[{alter.OldColumn.ColumnType} nullable={alter.OldColumn.IsNullable} max={alter.OldColumn.MaxLength} default={alter.OldColumn.DefaultValue}]";
        if (op is CreateTableOperation create)
            text += " columns: " + string.Join(", ", create.Columns.Select(x => x.Name));
        return text;
    }
}
