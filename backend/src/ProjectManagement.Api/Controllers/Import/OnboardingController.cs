using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Import;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Import;

/// <summary>The welcome tour's sample project: see whether it is here, add it, remove it in one click.</summary>
[Route("api/v1/onboarding"), RequireWorkspace]
public class OnboardingController(SampleProjectService sample) : ApiControllerBase
{
    [HttpGet("sample-project"), RequireModule(Modules.Projects)]
    public async Task<IActionResult> Get(CancellationToken ct) => Ok(await sample.GetAsync(ct));

    [HttpPost("sample-project"), RequireModule(Modules.Projects, AccessLevel.Edit)]
    public async Task<IActionResult> Add(CancellationToken ct) => Created(await sample.AddAsync(ct));

    [HttpDelete("sample-project"), RequireModule(Modules.Projects, AccessLevel.Edit)]
    public async Task<IActionResult> Remove(CancellationToken ct) => Ok(await sample.RemoveAsync(ct));
}
