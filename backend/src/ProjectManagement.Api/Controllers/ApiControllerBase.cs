using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace ProjectManagement.Api.Controllers;

/// <summary>
/// Base for every API controller: authenticated by default, with a helper for 201 responses. Controllers live in one
/// folder per feature (mirroring Application/Features), one controller per file.
/// </summary>
[ApiController, Authorize]
public abstract class ApiControllerBase : ControllerBase
{
    protected IActionResult Created<T>(T data) => StatusCode(StatusCodes.Status201Created, data);
}
