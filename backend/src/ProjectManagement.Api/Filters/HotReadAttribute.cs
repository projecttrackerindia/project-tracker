using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Services;

namespace ProjectManagement.Api.Filters;

/// <summary>
/// Caches a hot GET's answer for the signed-in person in the current workspace (see <see cref="HotReadCache"/>). The key holds everything
/// that changes what a person may see - workspace, person, role, team lens, project scope, API key or session, path and query - plus the
/// workspace's tag, so any change in the workspace makes every cached answer unreachable at once. Runs after the access checks
/// (RequireWorkspace, RequireModule), so a refused request is never answered from the cache.
/// </summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class HotReadAttribute : ActionFilterAttribute
{
    public const string Header = "X-Hot-Cache";
    public HotReadAttribute() { Order = 1000; }

    public override async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        var http = context.HttpContext;
        var services = http.RequestServices;
        var cache = services.GetRequiredService<HotReadCache>();
        var ctx = services.GetRequiredService<ICurrentContext>();
        if (!HttpMethods.IsGet(http.Request.Method) || !cache.Enabled || ctx.TenantId is not { } tenant || ctx.UserId is not { } user) { await next(); return; }

        var tag = await cache.TagAsync(tenant, http.RequestAborted);
        if (tag is null) { await next(); return; }
        var key = Key(tenant, tag, user, ctx, http.Request.Path + http.Request.QueryString);

        if (await cache.GetAsync(key, http.RequestAborted) is { } hit)
        {
            using var doc = JsonDocument.Parse(hit);
            http.Response.Headers[Header] = "hit";
            context.Result = new OkObjectResult(doc.RootElement.Clone());
            return;
        }

        var done = await next();
        if (done.Exception is not null && !done.ExceptionHandled) return;
        if (done.Result is not ObjectResult { Value: { } value } result || (result.StatusCode ?? 200) != 200 || value is ProjectManagement.Api.Common.ApiResponse) return;
        var json = services.GetRequiredService<IOptions<JsonOptions>>().Value.JsonSerializerOptions;
        // The tag is read again: a change during this request moved it on, and the answer (possibly from before the change) is then not kept.
        if (await cache.TagAsync(tenant, http.RequestAborted) != tag) return;
        http.Response.Headers[Header] = "miss";
        await cache.SetAsync(key, JsonSerializer.SerializeToUtf8Bytes(value, value.GetType(), json), http.RequestAborted);
    }

    private static string Key(Guid tenant, string tag, Guid user, ICurrentContext ctx, string pathAndQuery)
    {
        var who = $"{user:N}|{ctx.Role}|{ctx.TeamLens}|{ctx.ProjectScope}|{ctx.ViaApiKey}|{ctx.IsPlatformAdmin}|{pathAndQuery.ToLowerInvariant()}";
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(who)));
        return $"hot:{tenant:N}:{tag}:{hash}";
    }
}

/// <summary>Any write request in a workspace forgets its cached hot reads too (covers bulk statements that skip the save hook).</summary>
public sealed class HotReadWriteFilter(HotReadCache cache, ICurrentContext ctx) : IAsyncActionFilter
{
    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        var method = context.HttpContext.Request.Method;
        var write = !(HttpMethods.IsGet(method) || HttpMethods.IsHead(method) || HttpMethods.IsOptions(method));
        var tenant = ctx.TenantId;
        try { await next(); }
        finally { if (write && tenant is { } t) await cache.InvalidateAsync([t], CancellationToken.None); }
    }
}
