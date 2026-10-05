using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using ProjectManagement.Application.Features.Auth;

namespace ProjectManagement.Api.Controllers.Auth;

/// <summary>Signing in with a passkey: ask for the options, let the device sign them, send the answer back. Exactly like a password sign-in afterwards.</summary>
[Route("api/v1/auth/passkey")]
public class PasskeySignInController(PasskeyService passkeys) : ApiControllerBase
{
    [HttpPost("options"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> Options([FromBody] PasskeyLoginOptionsRequest req, CancellationToken ct) => Ok(await passkeys.BeginSignInAsync(req, ct));

    [HttpPost("verify"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> Verify([FromBody] PasskeyFinishRequest req, CancellationToken ct)
    {
        var s = await passkeys.FinishSignInAsync(req, ct);
        AuthCookies.WriteRefresh(Response, Request.IsHttps, s);
        var body = Request.Headers["X-Token-Delivery"] == "body";
        return Ok(new AuthResponse(s.AccessToken, s.ExpiresAt, s.User, body ? s.RefreshToken : null));
    }
}

/// <summary>The signed-in person's own passkeys: add one (this device or a security key), rename it, remove it.</summary>
[Route("api/v1/me/passkeys")]
public class MyPasskeysController(PasskeyService passkeys) : ApiControllerBase
{
    public record RenameRequest(string Name);

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await passkeys.ListAsync(ct));

    [HttpPost("options")]
    public async Task<IActionResult> Options(CancellationToken ct) => Ok(await passkeys.BeginRegistrationAsync(ct));

    [HttpPost]
    public async Task<IActionResult> Add([FromBody] PasskeyFinishRequest req, CancellationToken ct) => Ok(await passkeys.FinishRegistrationAsync(req, ct));

    [HttpPut("{id:guid}")]
    public async Task<IActionResult> Rename(Guid id, [FromBody] RenameRequest req, CancellationToken ct) { await passkeys.RenameAsync(id, req.Name, ct); return NoContent(); }

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Remove(Guid id, CancellationToken ct) { await passkeys.RemoveAsync(id, ct); return NoContent(); }
}
