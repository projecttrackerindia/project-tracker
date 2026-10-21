using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Integrations;

namespace ProjectManagement.Api.Controllers.Integrations;

/// <summary>
/// The OAuth server for connected apps (MCP clients such as Claude and ChatGPT): discovery documents, self-registration, the authorize
/// redirect to the consent page, tokens and revocation. Answers are plain OAuth JSON (no envelope), as the RFCs ask.
/// </summary>
[ApiController, AllowAnonymous, ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
public class OAuthController(OAuthService oauth) : ControllerBase
{
    private static readonly JsonSerializerOptions Snake = new() { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };
    private ContentResult Json(JsonNode body, int status = 200) => new() { Content = body.ToJsonString(), ContentType = "application/json", StatusCode = status };
    private ContentResult Error(OAuthException e) => Json(new JsonObject { ["error"] = e.Error, ["error_description"] = e.Message }, e.Status);

    [HttpGet("/.well-known/oauth-authorization-server"), HttpGet("/.well-known/oauth-authorization-server/{**rest}"), HttpGet("/.well-known/openid-configuration")]
    public IActionResult ServerMetadata() => Json(oauth.AuthorizationServerMetadata());

    [HttpGet("/.well-known/oauth-protected-resource"), HttpGet("/.well-known/oauth-protected-resource/{**rest}")]
    public IActionResult ResourceMetadata() => Json(oauth.ProtectedResourceMetadata());

    [HttpPost("/oauth/register")]
    public async Task<IActionResult> Register([FromBody] JsonElement body, CancellationToken ct)
    {
        try
        {
            string? Str(string k) => body.ValueKind == JsonValueKind.Object && body.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            var uris = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("redirect_uris", out var r) && r.ValueKind == JsonValueKind.Array
                ? r.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).ToList() : [];
            return Json(await oauth.RegisterAsync(new OAuthRegisterRequest(Str("client_name"), uris, Str("client_uri"), Str("logo_uri")), ct), 201);
        }
        catch (OAuthException e) { return Error(e); }
    }

    /// <summary>The browser step: checks the app and its return address, then shows the consent page (sign-in first if needed).</summary>
    [HttpGet("/oauth/authorize")]
    public async Task<IActionResult> Authorize(CancellationToken ct)
    {
        var q = Request.Query;
        var info = await oauth.ClientInfoAsync(q["client_id"].ToString(), q["redirect_uri"].ToString(), ct);
        // An unknown app or return address is never redirected to: the consent page explains instead.
        if (info.RedirectAllowed && q["response_type"].ToString() != "code")
            return Redirect($"{q["redirect_uri"]}{(q["redirect_uri"].ToString().Contains('?') ? "&" : "?")}error=unsupported_response_type&state={Uri.EscapeDataString(q["state"].ToString())}");
        return Redirect($"/connect{Request.QueryString}");
    }

    [HttpPost("/oauth/token"), Consumes("application/x-www-form-urlencoded")]
    public async Task<IActionResult> Token(CancellationToken ct)
    {
        try
        {
            var form = (await Request.ReadFormAsync(ct)).ToDictionary(x => x.Key, x => x.Value.ToString());
            var r = await oauth.TokenAsync(form, ct);
            return Json(JsonSerializer.SerializeToNode(r, Snake)!);
        }
        catch (OAuthException e) { return Error(e); }
    }

    [HttpPost("/oauth/revoke"), Consumes("application/x-www-form-urlencoded")]
    public async Task<IActionResult> Revoke(CancellationToken ct)
    {
        var form = await Request.ReadFormAsync(ct);
        await oauth.RevokeTokenAsync(form["token"].ToString(), ct);
        return Ok();
    }
}

/// <summary>The consent page and the list of apps connected to a workspace (signed in).</summary>
[Route("api/v1"), RequireWorkspace]
public class ConnectedAppsController(OAuthService oauth) : ApiControllerBase
{
    [HttpGet("oauth/client")]
    public async Task<IActionResult> Client([FromQuery] string clientId, [FromQuery] string redirectUri, CancellationToken ct) => Ok(await oauth.ClientInfoAsync(clientId, redirectUri, ct));

    [HttpPost("oauth/consent")]
    public async Task<IActionResult> Consent([FromBody] OAuthConsentRequest req, CancellationToken ct) => Ok(await oauth.ConsentAsync(req, ct));

    [HttpGet("connected-apps")]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await oauth.ListAsync(ct));

    [HttpDelete("connected-apps/{id:guid}")]
    public async Task<IActionResult> Disconnect(Guid id, CancellationToken ct)
    {
        await oauth.DisconnectAsync(id, ct);
        return NoContent();
    }
}
