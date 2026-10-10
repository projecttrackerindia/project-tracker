using Microsoft.AspNetCore.Mvc.Filters;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Api.Filters;

/// <summary>Holds a user's admission lease for the entire answer, including streamed responses.</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class AiRequestLimitAttribute : ActionFilterAttribute
{
    public AiRequestLimitAttribute() { Order = 100; }
    public override async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        var service = context.HttpContext.RequestServices.GetRequiredService<AiRequestLimitService>();
        await using var lease = await service.EnterAsync(context.HttpContext.RequestAborted);
        await next();
    }
}
