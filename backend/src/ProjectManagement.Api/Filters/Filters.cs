using System.Diagnostics;
using FluentValidation;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.Infrastructure;
using ProjectManagement.Api.Common;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ValidationException = ProjectManagement.Application.Exceptions.ValidationException;

namespace ProjectManagement.Api.Filters;

/// <summary>Runs FluentValidation on every bound request model and turns failures into a 422 envelope.</summary>
public class ValidationFilter(IServiceProvider services) : IAsyncActionFilter
{
    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        foreach (var p in context.ActionDescriptor.Parameters)
        {
            if (p.BindingInfo?.BindingSource?.Id == "Body" && p.BindingInfo.EmptyBodyBehavior != EmptyBodyBehavior.Allow
                && (!context.ActionArguments.TryGetValue(p.Name, out var body) || body is null))
                throw new AppException(400, "BAD_REQUEST", "A request body is required.");
        }
        if (!context.ModelState.IsValid)
        {
            var errors = context.ModelState.Where(kv => kv.Value?.Errors.Count > 0)
                .SelectMany(kv => kv.Value!.Errors.Select(e => new ApiError("BAD_REQUEST",
                    string.IsNullOrWhiteSpace(e.ErrorMessage) ? "The value is invalid." : e.ErrorMessage, CamelCase(kv.Key))))
                .ToList();
            throw new AppException(400, "BAD_REQUEST", "The request could not be read.", errors);
        }

        var failures = new List<ApiError>();
        foreach (var arg in context.ActionArguments.Values)
        {
            if (arg is null || services.GetService(typeof(IValidator<>).MakeGenericType(arg.GetType())) is not IValidator validator) continue;
            var result = await validator.ValidateAsync(new ValidationContext<object>(arg), context.HttpContext.RequestAborted);
            failures.AddRange(result.Errors.Select(f => new ApiError("VALIDATION_FAILED", f.ErrorMessage, CamelCase(f.PropertyName))));
        }
        if (failures.Count > 0) throw new ValidationException(failures, failures[0].Message);
        await next();
    }

    private static string CamelCase(string name) =>
        string.IsNullOrEmpty(name) ? name : string.Join('.', name.Split('.').Select(s => char.ToLowerInvariant(s[0]) + s[1..]));
}

/// <summary>Wraps successful and framework-generated results in the standard envelope.</summary>
public class ApiResponseFilter : IAlwaysRunResultFilter
{
    public void OnResultExecuting(ResultExecutingContext context)
    {
        if (context.Result is not ObjectResult result || result.Value is ApiResponse) return;
        var status = result.StatusCode ?? 200;
        var trace = Activity.Current?.Id ?? context.HttpContext.TraceIdentifier;

        if (status < 400) { result.Value = ApiResponse.Ok(result.Value, trace); return; }
        var message = result.Value is ProblemDetails pd ? pd.Detail ?? pd.Title ?? "The request failed." : "The request failed.";
        result.Value = ApiResponse.Fail(message, [new ApiError($"HTTP_{status}", message)], trace);
    }

    public void OnResultExecuted(ResultExecutedContext context) { }
}

/// <summary>Endpoints that operate on tenant data need a valid current workspace (resolved server-side).</summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method)]
public class RequireWorkspaceAttribute : ActionFilterAttribute
{
    public override void OnActionExecuting(ActionExecutingContext context)
    {
        var ctx = context.HttpContext.RequestServices.GetRequiredService<ICurrentContext>();
        if (ctx.TenantId is null)
            throw new ForbiddenException("No active workspace. Select a workspace first.", "WORKSPACE_REQUIRED");
    }
}

/// <summary>
/// The caller's job role must give them at least <see cref="Level"/> in <see cref="Module"/> (default: can open it).
/// Enforced on the server, so hiding a menu in the browser is never the only protection.
/// </summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, AllowMultiple = true)]
public class RequireModuleAttribute(string module, int level = AccessLevel.View) : ActionFilterAttribute
{
    public override async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        var services = context.HttpContext.RequestServices;
        // No workspace yet: RequireWorkspace reports that with a clearer error.
        if (services.GetRequiredService<ICurrentContext>().TenantId is not null)
            await services.GetRequiredService<PermissionService>().RequireModuleAsync(module, level, context.HttpContext.RequestAborted);
        await next();
    }
}
