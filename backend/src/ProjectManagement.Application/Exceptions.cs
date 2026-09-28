namespace ProjectManagement.Application.Exceptions;

public record ApiError(string Code, string Message, string? Field = null);

/// <summary>Business-rule failure that maps to a well-defined HTTP status (spec section 51).</summary>
public class AppException(int statusCode, string code, string message, IReadOnlyList<ApiError>? errors = null)
    : Exception(message)
{
    public int StatusCode { get; } = statusCode;
    public string Code { get; } = code;
    public IReadOnlyList<ApiError> Errors { get; } = errors ?? [new ApiError(code, message)];
}

public class UnauthorizedException(string message = "Authentication is required.", string code = "UNAUTHORIZED")
    : AppException(401, code, message);

public class ForbiddenException(string message = "You do not have permission to perform this action.", string code = "FORBIDDEN")
    : AppException(403, code, message);

public class NotFoundException(string message = "The requested resource was not found.", string code = "NOT_FOUND")
    : AppException(404, code, message);

public class ConflictException(string message, string code = "CONFLICT")
    : AppException(409, code, message);

public class ValidationException(IReadOnlyList<ApiError> errors, string message = "One or more validation errors occurred.")
    : AppException(422, "VALIDATION_FAILED", message, errors)
{
    public ValidationException(string field, string message) : this([new ApiError("VALIDATION_FAILED", message, field)], message) { }
}

public class TooManyRequestsException(string message, string code = "TOO_MANY_REQUESTS")
    : AppException(429, code, message);

/// <summary>A numeric plan limit (projects, tasks, members...) has been reached.</summary>
public class PlanLimitException(string featureKey, long limit)
    : AppException(403, "PLAN_LIMIT_REACHED",
        $"You have reached the maximum number of {Describe(featureKey)} available on your current plan ({limit}). Upgrade your plan to add more.")
{
    public string FeatureKey { get; } = featureKey;

    private static string Describe(string key) => key switch
    {
        "PROJECT_LIMIT" => "projects",
        "TASK_LIMIT" => "tasks",
        "MAX_MEMBERS" => "members",
        "MAX_TEAMS" => "teams",
        _ => key.ToLowerInvariant(),
    };
}

/// <summary>A boolean plan feature is not part of the current subscription.</summary>
public class FeatureNotAvailableException(string featureKey)
    : AppException(403, "FEATURE_NOT_AVAILABLE", $"This feature is not available on your current plan ({featureKey}). Upgrade to unlock it.")
{
    public string FeatureKey { get; } = featureKey;
}
