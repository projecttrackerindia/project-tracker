using System.Text.Json;
using Serilog.Events;
using Serilog.Formatting;

namespace ProjectManagement.Api.Logging;

/// <summary>
/// One JSON object per line with a "level" field (debug, info, warn, error) that log platforms such as Railway read as the severity, so a
/// warning shows as a warning instead of "info", and an exception stays one searchable entry with its stack.
/// </summary>
public sealed class JsonLineFormatter : ITextFormatter
{
    public void Format(LogEvent e, TextWriter output)
    {
        using var stream = new MemoryStream();
        using (var w = new Utf8JsonWriter(stream))
        {
            w.WriteStartObject();
            w.WriteString("time", e.Timestamp.UtcDateTime.ToString("O"));
            w.WriteString("level", e.Level switch
            {
                LogEventLevel.Verbose or LogEventLevel.Debug => "debug", LogEventLevel.Information => "info", LogEventLevel.Warning => "warn", _ => "error",
            });
            w.WriteString("message", e.RenderMessage());
            if (e.Exception is { } ex) w.WriteString("exception", ex.ToString());
            foreach (var (name, value) in e.Properties)
            {
                if (name is "message" or "level" or "time") continue;
                w.WriteString(name, value is ScalarValue { Value: var v } ? v?.ToString() : value.ToString());
            }
            w.WriteEndObject();
        }
        output.Write(System.Text.Encoding.UTF8.GetString(stream.ToArray()));
        output.Write('\n');
    }
}
