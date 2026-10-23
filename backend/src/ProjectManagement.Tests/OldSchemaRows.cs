using Npgsql;

namespace ProjectManagement.Tests;

/// <summary>Rows written into a PostgreSQL database that is still at an older migration (upgrade tests).</summary>
internal static class OldSchemaRows
{
    /// <summary>
    /// Inserts a row with the given values, filling every other required column of the table as it is at this point of the upgrade (no default:
    /// false, 0, empty text, now). Later migrations add columns the current model maps, so the model cannot write rows into the old schema.
    /// </summary>
    public static async Task InsertAsync(string connectionString,string table,Dictionary<string,object> values)
    {
        await using var c=new NpgsqlConnection(connectionString);
        await c.OpenAsync();
        var required=new List<(string Name,string Type)>();
        await using(var q=new NpgsqlCommand("SELECT column_name, data_type FROM information_schema.columns WHERE table_name=@t AND is_nullable='NO' AND column_default IS NULL",c))
        {
            q.Parameters.AddWithValue("t",table);
            await using var r=await q.ExecuteReaderAsync();
            while(await r.ReadAsync())required.Add((r.GetString(0),r.GetString(1)));
        }
        foreach(var (name,type) in required)
        {
            if(values.ContainsKey(name))continue;
            values[name]=type switch
            {
                "boolean"=>false,
                "integer" or "smallint"=>0,
                "bigint"=>0L,
                "numeric" or "double precision" or "real"=>0m,
                "uuid"=>Guid.Empty,
                "timestamp with time zone" or "timestamp without time zone"=>DateTime.UtcNow,
                "date"=>DateOnly.FromDateTime(DateTime.UtcNow),
                _=>"",
            };
        }
        var names=values.Keys.ToList();
        await using var insert=new NpgsqlCommand($"INSERT INTO \"{table}\" ({string.Join(",",names.Select(n=>$"\"{n}\""))}) VALUES ({string.Join(",",names.Select((_,i)=>$"@p{i}"))})",c);
        for(var i=0;i<names.Count;i++)insert.Parameters.AddWithValue($"p{i}",values[names[i]]);
        await insert.ExecuteNonQueryAsync();
    }
}
