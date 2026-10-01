using ProjectManagement.Application.Features.Auth;

namespace ProjectManagement.Api.Controllers.Auth;

/// <summary>What a successful sign-in, refresh or workspace switch returns.</summary>
public record AuthResponse(string AccessToken, DateTime ExpiresAt, UserDto User, string? RefreshToken);
