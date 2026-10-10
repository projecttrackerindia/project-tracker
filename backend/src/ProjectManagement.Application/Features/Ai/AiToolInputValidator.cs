using System.Text.Json;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>Enforces the JSON Schema subset used by the application's tool catalog. Business services remain authoritative.</summary>
public static class AiToolInputValidator
{
    public static string? Validate(AiToolDef tool, JsonElement arguments)
    {
        using var schema = JsonDocument.Parse(tool.SchemaJson);
        return Check(schema.RootElement, arguments, "arguments", required: true);
    }
    private static string? Check(JsonElement schema, JsonElement value, string path, bool required)
    {
        // Older models use null for omitted optional fields; keep that compatible with the existing tool readers.
        if (value.ValueKind == JsonValueKind.Null && !required) return null;
        if (schema.TryGetProperty("type", out var type))
        {
            var valid = type.GetString() switch
            {
                "object" => value.ValueKind == JsonValueKind.Object, "array" => value.ValueKind == JsonValueKind.Array,
                "string" => value.ValueKind == JsonValueKind.String, "boolean" => value.ValueKind is JsonValueKind.True or JsonValueKind.False,
                "integer" => value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out _), "number" => value.ValueKind == JsonValueKind.Number,
                _ => false,
            };
            if (!valid) return $"{path} must be {type.GetString()}.";
        }
        if (schema.TryGetProperty("enum", out var choices) && !choices.EnumerateArray().Any(c => c.GetRawText() == value.GetRawText()))
        {
            var allowed = choices.EnumerateArray().Select(c => c.ValueKind == JsonValueKind.String ? c.GetString()! : c.GetRawText()).ToList();
            var label = allowed.Count > 1 ? string.Join(", ", allowed.Take(allowed.Count - 1)) + " or " + allowed[^1] : string.Join(", ", allowed);
            return $"{path} must be {label}.";
        }
        if (value.ValueKind == JsonValueKind.Object)
        {
            var requiredFields = schema.TryGetProperty("required", out var fields) ? fields.EnumerateArray().Select(f => f.GetString()!).ToHashSet() : [];
            foreach (var field in requiredFields)
                if (!value.TryGetProperty(field, out var found) || found.ValueKind == JsonValueKind.Null) return $"{path}.{field} is required.";
            if (schema.TryGetProperty("properties", out var properties))
                foreach (var definition in properties.EnumerateObject())
                    if (value.TryGetProperty(definition.Name, out var field) && Check(definition.Value, field, path + "." + definition.Name, requiredFields.Contains(definition.Name)) is { } error) return error;
        }
        if (value.ValueKind == JsonValueKind.Array)
        {
            if (value.GetArrayLength() > 128) return $"{path} has too many entries.";
            if (schema.TryGetProperty("items", out var item))
                foreach (var entry in value.EnumerateArray()) if (Check(item, entry, path + "[]", true) is { } error) return error;
        }
        if (value.ValueKind == JsonValueKind.String && schema.TryGetProperty("maxLength", out var length) && value.GetString()!.Length > length.GetInt32())
            return $"{path} exceeds its maximum length.";
        if (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number))
        {
            if (schema.TryGetProperty("minimum", out var minimum) && number < minimum.GetDouble()) return $"{path} is below its minimum.";
            if (schema.TryGetProperty("maximum", out var maximum) && number > maximum.GetDouble()) return $"{path} exceeds its maximum.";
        }
        return null;
    }
}
