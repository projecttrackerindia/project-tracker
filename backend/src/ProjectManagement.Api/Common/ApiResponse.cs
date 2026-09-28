using System.Text.Json;
using System.Text.Json.Serialization;
using ProjectManagement.Application.Exceptions;

namespace ProjectManagement.Api.Common;

/// <summary>Standard response envelope (spec section 50).</summary>
public record ApiResponse(bool Success, object? Data, string? Message, IReadOnlyList<ApiError> Errors, string? TraceId)
{
    public static ApiResponse Ok(object? data, string? traceId) => new(true, data, null, [], traceId);
    public static ApiResponse Fail(string message, IReadOnlyList<ApiError> errors, string? traceId) => new(false, null, message, errors, traceId);
}

public static class Json
{
    public static void Configure(JsonSerializerOptions o)
    {
        o.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        o.DictionaryKeyPolicy = null; // keep feature keys (PROJECT_LIMIT) and permission names verbatim
        o.DefaultIgnoreCondition = JsonIgnoreCondition.Never;
        o.Converters.Add(new JsonStringEnumConverter());
    }
}
