using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Sso;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>
/// SCIM 2.0 for identity providers (Microsoft Entra ID, Okta, OneLogin ...): /scim/v2. Authenticated by an organization's SCIM bearer token
/// (Workspace settings → Single sign-on), which puts the request inside that organization. Answers in SCIM's own JSON (application/scim+json),
/// errors included, rather than the API's usual envelope.
/// </summary>
[ApiController, AllowAnonymous, Route("scim/v2")]
public class ScimController(ScimService scim, IAppDbContext db, CurrentContext ctx, TimeProvider clock) : ControllerBase, IAsyncActionFilter
{
    private const string Media = "application/scim+json";

    [NonAction]
    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        var header = Request.Headers.Authorization.ToString();
        var bearer = header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? header[7..].Trim() : null;
        var tenant = await ScimService.AuthenticateAsync(db, bearer, clock.GetUtcNow().UtcDateTime, HttpContext.RequestAborted);
        if (tenant is null) { context.Result = Error(new ScimException(401, "A valid SCIM bearer token is required.")); return; }
        ctx.TenantId = tenant;
        ctx.WorkspaceType = WorkspaceType.Organization;
        try { await next(); }
        catch (ScimException ex) { context.Result = Error(ex); }
    }

    private static ContentResult Json(JsonNode node, int status = 200) =>
        new() { Content = node.ToJsonString(new JsonSerializerOptions { WriteIndented = false }), ContentType = Media, StatusCode = status };

    private static ContentResult Error(ScimException ex)
    {
        var o = new JsonObject { ["schemas"] = new JsonArray("urn:ietf:params:scim:api:messages:2.0:Error"), ["status"] = ex.Status.ToString(), ["detail"] = ex.Message };
        if (ex.ScimType is not null) o["scimType"] = ex.ScimType;
        return Json(o, ex.Status);
    }

    /// <summary>The body as JSON, whatever the content type says (identity providers send application/scim+json).</summary>
    private async Task<JsonObject> BodyAsync()
    {
        using var reader = new StreamReader(Request.Body, Encoding.UTF8);
        var text = await reader.ReadToEndAsync();
        try { return JsonNode.Parse(text) as JsonObject ?? throw new ScimException(400, "The body must be a JSON object.", "invalidSyntax"); }
        catch (JsonException) { throw new ScimException(400, "The body is not valid JSON.", "invalidSyntax"); }
    }

    private async Task<IActionResult> Safe(Func<Task<IActionResult>> work)
    {
        try { return await work(); }
        catch (ScimException ex) { return Error(ex); }
        catch (AppException ex) { return Error(new ScimException(ex.StatusCode is 401 or 403 or 404 or 409 ? ex.StatusCode : 400, ex.Message)); }
    }

    [HttpGet("ServiceProviderConfig")] public IActionResult Config() => Json(scim.ServiceProviderConfig());
    [HttpGet("ResourceTypes")] public IActionResult ResourceTypes() => Json(scim.ResourceTypes());

    [HttpGet("Users")]
    public Task<IActionResult> Users([FromQuery] string? filter, [FromQuery] int startIndex = 1, [FromQuery] int count = 100, CancellationToken ct = default) =>
        Safe(async () => Json(await scim.ListUsersAsync(filter, startIndex, count, ct)));

    [HttpGet("Users/{id:guid}")]
    public Task<IActionResult> GetUser(Guid id, CancellationToken ct) => Safe(async () => Json(await scim.GetUserAsync(id, ct)));

    [HttpPost("Users")]
    public Task<IActionResult> CreateUser(CancellationToken ct) => Safe(async () => Json((await scim.CreateUserAsync(await BodyAsync(), ct)).Resource, 201));

    [HttpPut("Users/{id:guid}")]
    public Task<IActionResult> ReplaceUser(Guid id, CancellationToken ct) => Safe(async () => Json(await scim.ReplaceUserAsync(id, await BodyAsync(), ct)));

    [HttpPatch("Users/{id:guid}")]
    public Task<IActionResult> PatchUser(Guid id, CancellationToken ct) => Safe(async () => Json(await scim.PatchUserAsync(id, await BodyAsync(), ct)));

    [HttpDelete("Users/{id:guid}")]
    public Task<IActionResult> DeleteUser(Guid id, CancellationToken ct) => Safe(async () => { await scim.DeleteUserAsync(id, ct); return NoContent(); });

    [HttpGet("Groups")]
    public Task<IActionResult> Groups([FromQuery] string? filter, [FromQuery] int startIndex = 1, [FromQuery] int count = 100, CancellationToken ct = default) =>
        Safe(async () => Json(await scim.ListGroupsAsync(filter, startIndex, count, ct)));

    [HttpGet("Groups/{id:guid}")]
    public Task<IActionResult> Group(Guid id, CancellationToken ct) => Safe(async () => Json(await scim.GetGroupAsync(id, ct)));

    [HttpPost("Groups")]
    public Task<IActionResult> CreateGroup(CancellationToken ct) => Safe(async () => Json(await scim.CreateGroupAsync(await BodyAsync(), ct), 201));

    [HttpPut("Groups/{id:guid}")]
    public Task<IActionResult> ReplaceGroup(Guid id, CancellationToken ct) => Safe(async () => Json(await scim.ReplaceGroupAsync(id, await BodyAsync(), ct)));

    [HttpPatch("Groups/{id:guid}")]
    public Task<IActionResult> PatchGroup(Guid id, CancellationToken ct) => Safe(async () => Json(await scim.PatchGroupAsync(id, await BodyAsync(), ct)));

    [HttpDelete("Groups/{id:guid}")]
    public Task<IActionResult> DeleteGroup(Guid id, CancellationToken ct) => Safe(async () => { await scim.DeleteGroupAsync(id, ct); return NoContent(); });
}
