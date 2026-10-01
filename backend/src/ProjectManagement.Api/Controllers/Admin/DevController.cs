using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Admin;
using ProjectManagement.Application.Features.Billing;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Services;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Admin;

/// <summary>Development-only helpers. Not registered outside Development / when Dev:Mailbox is off.</summary>
[Route("api/v1/dev"), AllowAnonymous]
public class DevController(DevMailbox mailbox, IWebHostEnvironment env, IConfiguration config) : ApiControllerBase
{
    [HttpGet("emails")]
    public IActionResult Emails() =>
        env.IsDevelopment() || config.GetValue("Dev:Mailbox", false) ? Ok(mailbox.Recent()) : NotFound();
}
