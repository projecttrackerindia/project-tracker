using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Api.Realtime;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Api.Controllers.Shell;

/// <summary>
/// Realtime sync catch-up: after sleep, a lost connection or the phone coming back to the front, the app asks for the changes after the last
/// version it applied, and refreshes only what they touch. Each change is filtered with the caller's own reach (personal things only to
/// their people, project things only to people who can open that project, workspace things not to guests). "reset" means the gap is older
/// than what is kept: the app reloads its open screens instead.
/// </summary>
[Route("api/v1/realtime"), RequireWorkspace]
public class RealtimeController(ICurrentContext ctx, CurrentContext cc, IRealtimeLog log) : ApiControllerBase
{
    private const int Max = 500;

    [HttpGet("changes")]
    public async Task<IActionResult> Changes([FromQuery] long since = 0, CancellationToken ct = default)
    {
        var tenant = ctx.RequireTenantId();
        var user = ctx.RequireUserId();
        var (changes, version, complete) = await log.SinceAsync(tenant, Math.Max(0, since), Max, ct);
        // The first ask (since = 0): just the current version, the starting point for live events.
        if (since <= 0) return Ok(new { version, reset = false, changes = Array.Empty<object>() });
        var guest = cc.Role == TenantRole.Guest;
        var all = cc.ProjectScope == ProjectScope.None && cc.TeamLens is null;
        var projects = cc.ProjectIds.ToHashSet();
        var visible = changes.Where(e => e.TenantId == tenant && SyncGroups.MaySee(e, user, guest, all, projects)).Select(RealtimeDispatcher.Wire).ToList();
        var last = changes.Count > 0 ? changes[^1].Version : version;
        return Ok(new { version = complete ? Math.Max(last, since) : version, reset = !complete, changes = complete ? visible : new List<object>() });
    }
}
