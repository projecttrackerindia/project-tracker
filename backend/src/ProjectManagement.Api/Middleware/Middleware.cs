using System.Diagnostics;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Api.Common;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Services;

namespace ProjectManagement.Api.Middleware;

public static class ErrorWriter
{
    public static async Task WriteAsync(HttpContext http, int status, string message, IReadOnlyList<ApiError> errors)
    {
        if (http.Response.HasStarted) return;
        http.Response.Clear();
        http.Response.StatusCode = status;
        var options = http.RequestServices.GetRequiredService<IOptions<JsonOptions>>().Value.SerializerOptions;
        await http.Response.WriteAsJsonAsync(ApiResponse.Fail(message, errors, Activity.Current?.Id ?? http.TraceIdentifier), options);
    }
}

/// <summary>Counts requests and server errors for the platform health page.</summary>
public class MetricsMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext http, ProjectManagement.Application.Common.SystemMetrics metrics)
    {
        try { await next(http); }
        finally { if (http.Request.Path.StartsWithSegments("/api")) metrics.Record(http.Response.StatusCode); }
    }
}

/// <summary>
/// While the platform is in maintenance mode, changes are refused for everyone except platform administrators (reading, signing in and
/// signing out keep working), so an upgrade or migration can run without people editing data underneath it.
/// </summary>
public class MaintenanceMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext http, ProjectManagement.Application.Features.Admin.PlatformSettingsCache settings, CurrentContext ctx)
    {
        var unsafeMethod = !(HttpMethods.IsGet(http.Request.Method) || HttpMethods.IsHead(http.Request.Method) || HttpMethods.IsOptions(http.Request.Method));
        if (unsafeMethod && http.Request.Path.StartsWithSegments("/api") && !http.Request.Path.StartsWithSegments("/api/v1/auth") && !ctx.IsPlatformAdmin
            && (await settings.GetAsync(http.RequestAborted)).MaintenanceMode)
        {
            http.Response.Headers.RetryAfter = "300";
            await ErrorWriter.WriteAsync(http, 503, "The system is being maintained. You can read your data, but changes are paused for a few minutes.", [new ApiError("MAINTENANCE_MODE", "The system is being maintained. Please try again in a few minutes.")]);
            return;
        }
        await next(http);
    }
}

/// <summary>
/// An account an administrator created starts with a password the administrator chose, so until the person replaces it nothing
/// works except signing in and out, changing the password, and reading who they are (GET /me, which the app needs to know to ask).
/// </summary>
public class PasswordChangeMiddleware(RequestDelegate next)
{
    private static bool Is(HttpContext http, string path) =>
        string.Equals(http.Request.Path.Value?.TrimEnd('/'), path, StringComparison.OrdinalIgnoreCase);

    public async Task InvokeAsync(HttpContext http, CurrentContext ctx)
    {
        var path = http.Request.Path;
        if (ctx.MustChangePassword && path.StartsWithSegments("/api")
            && !path.StartsWithSegments("/api/v1/auth") && !path.StartsWithSegments("/api/v1/consent")
            && !(HttpMethods.IsGet(http.Request.Method) && (Is(http, "/api/v1/me") || Is(http, "/api/v1/me/fingerprint")))
            && !(HttpMethods.IsPost(http.Request.Method) && Is(http, "/api/v1/me/password")))
        {
            await ErrorWriter.WriteAsync(http, 403, "Choose a new password before continuing.",
                [new ApiError("PASSWORD_CHANGE_REQUIRED", "Choose a new password before continuing.")]);
            return;
        }
        await next(http);
    }
}

/// <summary>
/// Once someone has an outdated required consent (Terms of Service / Privacy Policy), changes are paused for them
/// specifically until they accept the current version — reading, signing in/out and accepting itself keep working.
/// </summary>
public class ConsentMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext http, CurrentContext ctx, ProjectManagement.Application.Features.Consent.ConsentService consent)
    {
        var unsafeMethod = !(HttpMethods.IsGet(http.Request.Method) || HttpMethods.IsHead(http.Request.Method) || HttpMethods.IsOptions(http.Request.Method));
        if (unsafeMethod && ctx.UserId is { } userId && http.Request.Path.StartsWithSegments("/api")
            && !http.Request.Path.StartsWithSegments("/api/v1/auth") && !http.Request.Path.StartsWithSegments("/api/v1/consent") && !ctx.IsPlatformAdmin)
        {
            var status = await consent.StatusForAsync(userId, http.RequestAborted);
            if (!status.UpToDate)
            {
                await ErrorWriter.WriteAsync(http, 403, "Please review and accept our updated terms before continuing.",
                    [new ApiError("CONSENT_REQUIRED", "Please review and accept our updated terms before continuing.")]);
                return;
            }
        }
        await next(http);
    }
}

/// <summary>Maps exceptions to the standard envelope. Internal details are logged, never returned (spec section 51).</summary>
public class ApiExceptionMiddleware(RequestDelegate next, ILogger<ApiExceptionMiddleware> log)
{
    public async Task InvokeAsync(HttpContext http)
    {
        try { await next(http); }
        catch (AppException ex)
        {
            await ErrorWriter.WriteAsync(http, ex.StatusCode, ex.Message, ex.Errors);
        }
        catch (DbUpdateConcurrencyException)
        {
            await ErrorWriter.WriteAsync(http, 409, "The record was changed by someone else. Reload and try again.",
                [new ApiError("VERSION_CONFLICT", "The record was changed by someone else. Reload and try again.")]);
        }
        catch (DbUpdateException ex)
        {
            log.LogWarning(ex, "Database update failed for {Path}", http.Request.Path);
            await ErrorWriter.WriteAsync(http, 409, "The change conflicts with existing data. Please retry.",
                [new ApiError("CONFLICT", "The change conflicts with existing data. Please retry.")]);
        }
        catch (Exception ex) when (ex is BadHttpRequestException or JsonException)
        {
            await ErrorWriter.WriteAsync(http, 400, "The request could not be read.", [new ApiError("BAD_REQUEST", "The request could not be read.")]);
        }
        catch (OperationCanceledException) when (http.RequestAborted.IsCancellationRequested)
        {
            http.Response.StatusCode = 499; // client closed the request
        }
        catch (Exception ex)
        {
            log.LogError(ex, "Unhandled exception for {Method} {Path}", http.Request.Method, http.Request.Path);
            await ErrorWriter.WriteAsync(http, 500, "An unexpected error occurred.", [new ApiError("INTERNAL_ERROR", "An unexpected error occurred.")]);
        }
    }
}

/// <summary>
/// Accepts an API key (<c>Authorization: Bearer pmk_...</c> or <c>X-Api-Key</c>) as the caller's identity. The key stands for the person who made
/// it, in one workspace; read-only keys cannot change anything, and no key can reach account, billing, administration or key management.
/// </summary>
public class ApiKeyAuthMiddleware(RequestDelegate next)
{
    public const string ClaimKey = "api_key", ClaimScope = "api_scope";

    /// <summary>Areas a key can never use, whatever its owner may do: the things that manage access itself.</summary>
    private static readonly string[] Blocked = ["/api/v1/api-keys", "/api/v1/webhooks", "/api/v1/auth", "/api/v1/admin", "/api/v1/billing", "/api/v1/workspaces", "/api/v1/dev"];

    private static string? TokenOf(HttpRequest r)
    {
        var header = r.Headers.Authorization.ToString();
        if (header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) && ApiKeyFormat.LooksLikeKey(header[7..].Trim())) return header[7..].Trim();
        var custom = r.Headers["X-Api-Key"].ToString();
        return ApiKeyFormat.LooksLikeKey(custom) ? custom : null;
    }

    public async Task InvokeAsync(HttpContext http, ApiKeyAuthenticator authenticator)
    {
        var token = TokenOf(http.Request);
        if (token is null) { await next(http); return; }

        var identity = await authenticator.AuthenticateAsync(token, http.Connection.RemoteIpAddress?.ToString(), http.RequestAborted);
        if (identity is null)
        {
            await ErrorWriter.WriteAsync(http, 401, "This API key is not valid. It may have been revoked or may have expired.", [new ApiError("INVALID_API_KEY", "This API key is not valid. It may have been revoked or may have expired.")]);
            return;
        }

        if (!await authenticator.PlanAllowsAsync(identity.TenantId, http.RequestAborted))
        {
            await ErrorWriter.WriteAsync(http, 403, "API access is not included in this workspace's plan.", [new ApiError("API_ACCESS_NOT_IN_PLAN", "API access is not included in this workspace's current plan. Upgrade the plan to use API keys again; existing keys start working again automatically.")]);
            return;
        }

        var path = http.Request.Path.Value ?? "";
        var isMe = path.StartsWith("/api/v1/me", StringComparison.OrdinalIgnoreCase);
        var meContext = path.TrimEnd('/').Equals("/api/v1/me", StringComparison.OrdinalIgnoreCase) && HttpMethods.IsGet(http.Request.Method);
        if (Blocked.Any(b => path.StartsWith(b, StringComparison.OrdinalIgnoreCase)) || (isMe && !meContext))
        {
            await ErrorWriter.WriteAsync(http, 403, "API keys cannot be used for this.", [new ApiError("API_KEY_NOT_ALLOWED", "API keys cannot be used for account, billing, administration or key management.")]);
            return;
        }
        if (identity.Scope == ApiKeyScope.ReadOnly && !(HttpMethods.IsGet(http.Request.Method) || HttpMethods.IsHead(http.Request.Method) || HttpMethods.IsOptions(http.Request.Method)))
        {
            await ErrorWriter.WriteAsync(http, 403, "This API key is read-only.", [new ApiError("API_KEY_READ_ONLY", "This API key can only read data. Create a read/write key to make changes.")]);
            return;
        }

        http.User = new ClaimsPrincipal(new ClaimsIdentity(
        [
            new Claim("sub", identity.UserId.ToString()), new Claim(JwtClaims.WorkspaceId, identity.TenantId.ToString()),
            new Claim(ClaimKey, identity.KeyId.ToString()), new Claim(ClaimScope, identity.Scope.ToString()),
        ], "ApiKey"));
        http.Request.Headers.Remove("Authorization"); // the JWT handler must not try to read an API key as a token
        await next(http);
    }
}

/// <summary>
/// Establishes the request's identity, session, workspace and role *server-side* from the validated token plus the database
/// (spec sections 57-58). Revoked sessions, disabled users and removed members lose access immediately.
/// </summary>
public class CurrentContextMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext http, CurrentContext ctx, IAppDbContext db, TimeProvider clock,
        ProjectManagement.Application.Features.Organization.OrgSecurityService orgSecurity)
    {
        ctx.IpAddress = http.Connection.RemoteIpAddress?.ToString();
        ctx.UserAgent = http.Request.Headers.UserAgent.ToString();

        if (http.User.Identity?.IsAuthenticated == true)
        {
            var user = http.User;
            if (user.FindFirst(ApiKeyAuthMiddleware.ClaimKey) is not null && Guid.TryParse(user.FindFirst("sub")?.Value, out var keyUser))
            {
                var active = await db.Users.AsNoTracking().Where(u => u.Id == keyUser).Select(u => u.IsActive).FirstOrDefaultAsync(http.RequestAborted);
                if (!active)
                {
                    await ErrorWriter.WriteAsync(http, 401, "This API key is not valid.", [new ApiError("INVALID_API_KEY", "This API key is not valid.")]);
                    return;
                }
                ctx.UserId = keyUser; ctx.SessionId = null; ctx.IsPlatformAdmin = false; // a key never carries platform-admin rights
                // A key has no two-step verification of its own to check; an IP allowlist still applies to it.
                await ApplyMembershipAsync(http, ctx, db, orgSecurity, keyUser, mfaEnabled: true);
                await next(http);
                return;
            }
            if (!Guid.TryParse(user.FindFirst("sub")?.Value, out var userId) || !Guid.TryParse(user.FindFirst(JwtClaims.SessionId)?.Value, out var sessionId))
            {
                await ErrorWriter.WriteAsync(http, 401, "Invalid token.", [new ApiError("UNAUTHORIZED", "Invalid token.")]);
                return;
            }

            var now = clock.GetUtcNow().UtcDateTime;
            var session = await (from s in db.UserSessions
                                 join u in db.Users on s.UserId equals u.Id
                                 where s.Id == sessionId && s.UserId == userId && s.RevokedAt == null && s.ExpiresAt > now
                                 select new { u.IsActive, u.IsPlatformAdmin, u.MfaEnabled, u.MustChangePassword, s.SsoTenantId }).AsNoTracking().FirstOrDefaultAsync(http.RequestAborted);
            if (session is null || !session.IsActive)
            {
                await ErrorWriter.WriteAsync(http, 401, "Your session has ended. Please sign in again.", [new ApiError("SESSION_REVOKED", "Your session has ended. Please sign in again.")]);
                return;
            }

            ctx.UserId = userId;
            ctx.SessionId = sessionId;
            ctx.IsPlatformAdmin = session.IsPlatformAdmin;
            ctx.MustChangePassword = session.MustChangePassword;

            await ApplyMembershipAsync(http, ctx, db, orgSecurity, userId, session.MfaEnabled, session.SsoTenantId);
        }
        await next(http);
    }

    /// <summary>
    /// The workspace in the token counts only while the person is still a member of it, it is active, and the organization's own
    /// access rules let them in right now. A refusal is not a hard failure of the whole request (GET /me, or switching to a
    /// different workspace, must still work) — it is recorded on ctx.BlockedWorkspace so the app can explain it specifically.
    /// </summary>
    private static async Task ApplyMembershipAsync(HttpContext http, CurrentContext ctx, IAppDbContext db,
        ProjectManagement.Application.Features.Organization.OrgSecurityService orgSecurity, Guid userId, bool mfaEnabled, Guid? ssoTenantId = null)
    {
        if (!Guid.TryParse(http.User.FindFirst(JwtClaims.WorkspaceId)?.Value, out var workspaceId)) return;
        // Signed in through this organization's own single sign-on: its identity provider vouched for the person (and applies its MFA).
        if (ssoTenantId == workspaceId) mfaEnabled = true;
        var membership = await (from m in db.TenantMembers
                                join t in db.Tenants on m.TenantId equals t.Id
                                where m.UserId == userId && m.TenantId == workspaceId && t.Status == TenantStatus.Active
                                select new { m.Role, t.Type, t.ProjectVisibility }).AsNoTracking().FirstOrDefaultAsync(http.RequestAborted);
        if (membership is null) return;

        var blocked = await orgSecurity.CheckAccessAsync(workspaceId, mfaEnabled, ctx.IpAddress, http.RequestAborted);
        if (blocked is not null) { ctx.BlockedWorkspace = (workspaceId, blocked.Code, blocked.Message); return; }

        ctx.TenantId = workspaceId;
        ctx.Role = membership.Role;
        ctx.WorkspaceType = membership.Type;
        ctx.ProjectScope = await ResolveProjectScopeAsync(http, ctx, membership.ProjectVisibility);
    }

    /// <summary>
    /// Decided here, once, so that every query of the request (the screens, the reports, the assistant) is narrowed the same way by the
    /// data layer. Guests only reach projects they were added to. When the workspace limits people to their teams, everyone whose role
    /// does not carry "see every team's projects" reaches their own teams' projects and the ones they own or were added to.
    /// </summary>
    private static async Task<ProjectScope> ResolveProjectScopeAsync(HttpContext http, CurrentContext ctx, ProjectVisibility visibility)
    {
        if (ctx.WorkspaceType == WorkspaceType.Personal) return ProjectScope.None;
        if (ctx.Role == TenantRole.Guest) return ProjectScope.Members;
        if (visibility != ProjectVisibility.Teams) return ProjectScope.None;
        var permissions = http.RequestServices.GetRequiredService<ProjectManagement.Application.Services.PermissionService>();
        return await permissions.HasAsync(ProjectManagement.Domain.Permissions.ProjectsViewAll, http.RequestAborted) ? ProjectScope.None : ProjectScope.Teams;
    }
}

public class SecurityHeadersMiddleware(RequestDelegate next)
{
    public Task InvokeAsync(HttpContext http)
    {
        var h = http.Response.Headers;
        h["X-Content-Type-Options"] = "nosniff";
        h["X-Frame-Options"] = "DENY";
        h["Referrer-Policy"] = "no-referrer";
        h["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
        if (!http.Request.Path.StartsWithSegments("/swagger"))
            h["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'";
        if (http.Request.Path.StartsWithSegments("/api")) h["Cache-Control"] = "no-store";
        return next(http);
    }
}
