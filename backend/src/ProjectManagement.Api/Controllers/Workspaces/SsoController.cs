using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Sso;

namespace ProjectManagement.Api.Controllers.Workspaces;

/// <summary>Workspace settings → Single sign-on: the identity provider, verified domains and SCIM tokens (Owners and Admins).</summary>
[Route("api/v1/workspace/sso"), RequireWorkspace]
public class SsoController(SsoSettingsService sso, SsoGroupMappingService groups) : ApiControllerBase
{
    /// <summary>Which team a person joins for each group their identity provider reports at sign-in.</summary>
    [HttpGet("group-mappings")]
    public async Task<IActionResult> GroupMappings(CancellationToken ct) => Ok(await groups.ListAsync(ct));

    [HttpPost("group-mappings")]
    public async Task<IActionResult> AddGroupMapping([FromBody] AddGroupMappingRequest req, CancellationToken ct) => Created(await groups.AddAsync(req, ct));

    [HttpDelete("group-mappings/{id:guid}")]
    public async Task<IActionResult> RemoveGroupMapping(Guid id, CancellationToken ct) => Ok(await groups.RemoveAsync(id, ct));

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct) => Ok(await sso.GetAsync(ct));

    [HttpPut("connection")]
    public async Task<IActionResult> Save([FromBody] SaveSsoConnectionRequest req, CancellationToken ct) => Ok(await sso.SaveConnectionAsync(req, ct));

    /// <summary>Checks the saved settings against the provider (discovery document, or the certificate).</summary>
    [HttpPost("check")]
    public async Task<IActionResult> Check(CancellationToken ct) => Ok(await sso.CheckAsync(ct));

    [HttpPost("domains")]
    public async Task<IActionResult> AddDomain([FromBody] AddSsoDomainRequest req, CancellationToken ct) => Ok(await sso.AddDomainAsync(req, ct));

    [HttpPost("domains/{id:guid}/verify")]
    public async Task<IActionResult> VerifyDomain(Guid id, CancellationToken ct) => Ok(await sso.VerifyDomainAsync(id, ct));

    [HttpDelete("domains/{id:guid}")]
    public async Task<IActionResult> RemoveDomain(Guid id, CancellationToken ct) => Ok(await sso.RemoveDomainAsync(id, ct));

    /// <summary>A SCIM token: the secret is returned once, here, and never again.</summary>
    [HttpPost("scim-tokens")]
    public async Task<IActionResult> CreateScimToken([FromBody] CreateScimTokenRequest req, CancellationToken ct) => Created(await sso.CreateScimTokenAsync(req, ct));

    [HttpDelete("scim-tokens/{id:guid}")]
    public async Task<IActionResult> RevokeScimToken(Guid id, CancellationToken ct) => Ok(await sso.RevokeScimTokenAsync(id, ct));
}
