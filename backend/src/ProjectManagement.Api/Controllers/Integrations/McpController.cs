using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;

namespace ProjectManagement.Api.Controllers.Integrations;

/// <summary>
/// ProjectTracker as an MCP server (Model Context Protocol, Streamable HTTP): Claude, ChatGPT and other AI assistants can list projects and
/// work, create and update tasks, comment and log time - as the person whose API key they were given, through the same endpoints and rules
/// as the app (a read-only key can only read). One JSON-RPC message per POST; no server-to-client stream is needed.
/// </summary>
[Route("api/v1/mcp"), RequireWorkspace, ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
public class McpController(IHttpClientFactory http, IServer server) : ApiControllerBase
{
    private const string Protocol = "2025-06-18";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>A tool with its safety annotations: read-only tools never change anything; the others change data in the workspace only (never the outside world).</summary>
    private sealed record Tool(string Name, string Description, JsonObject Schema, string Title = "", bool ReadOnly = true, bool Idempotent = true);

    private static JsonObject Schema(params (string Name, string Type, string Description, bool Required)[] props)
    {
        var p = new JsonObject(); var req = new JsonArray();
        foreach (var x in props) { p[x.Name] = new JsonObject { ["type"] = x.Type, ["description"] = x.Description }; if (x.Required) req.Add(x.Name); }
        return new JsonObject { ["type"] = "object", ["properties"] = p, ["required"] = req };
    }

    private static readonly Tool[] Tools =
    [
        new("list_projects", "List the projects you can see, optionally filtered by a search word.", Schema(("q", "string", "Search text", false)), "List projects", true, true),
        new("get_project", "One project's details: dates, status, owner, members and progress.", Schema(("projectId", "string", "Project id", true)), "Get a project", true, true),
        new("list_project_tasks", "The tasks of one project with status, assignee, priority and due date.", Schema(("projectId", "string", "Project id", true), ("q", "string", "Search text", false)), "List a project's tasks", true, true),
        new("my_work", "Everything assigned to you: tasks, issues, action items and operational work. Open items only unless open is false.",
            Schema(("open", "boolean", "Only open items (default true)", false), ("overdue", "boolean", "Only overdue items", false), ("q", "string", "Search text", false)), "My work", true, true),
        new("get_task", "One task with its description, status, assignee, dates and project.", Schema(("taskId", "string", "Task id", true)), "Get a task", true, true),
        new("create_task", "Create a task in a project.", Schema(("projectId", "string", "Project id", true), ("title", "string", "Task title", true),
            ("description", "string", "Details", false), ("priority", "string", "Low, Medium, High or Critical (default Medium)", false),
            ("dueDate", "string", "Due date, yyyy-MM-dd", false), ("assigneeId", "string", "User id of the assignee", false)), "Create a task", false, false),
        new("update_task_status", "Move a task to another status by the status's name (for example To Do, In Progress, Done).",
            Schema(("taskId", "string", "Task id", true), ("status", "string", "Status name as shown in the project", true)), "Change a task's status", false, true),
        new("add_task_comment", "Add a comment to a task.", Schema(("taskId", "string", "Task id", true), ("body", "string", "Comment text", true)), "Comment on a task", false, false),
        new("log_time", "Log time spent on a task.", Schema(("taskId", "string", "Task id", true), ("minutes", "integer", "Minutes worked", true),
            ("date", "string", "Work date, yyyy-MM-dd (default today)", false), ("note", "string", "What was done", false)), "Log time", false, false),
        new("create_work_item", "Create an operational work item (support, request, analysis) in Operations.", Schema(("title", "string", "Title", true),
            ("description", "string", "Details", false), ("priority", "string", "Low, Medium, High or Critical", false), ("workType", "string", "Work type name (default: the first one)", false)), "Create a work item", false, false),
        new("list_work_items", "Operational work (support tickets, requests, analysis) with status, priority, assignee and service level. Open items only unless open is false.",
            Schema(("q", "string", "Search text", false), ("open", "boolean", "Only open items (default true)", false), ("mine", "boolean", "Only items assigned to you", false)), "List work items"),
        new("search_api_docs", "Search the published API documentation (DocTracker) by path, summary or group. Sensitive example values stay masked.",
            Schema(("q", "string", "Words from the path, summary or group (at least 2 characters)", true)), "Search API documentation"),
        new("update_work_item_status", "Change an operational work item's status.", Schema(("workItemId", "string", "Work item id", true),
            ("status", "string", "ToDo, InProgress, OnHold, Completed or Cancelled", true)), "Change a work item's status", false, true),
    ];

    [HttpGet] public IActionResult Get() => StatusCode(405);   // no server-sent stream: every answer comes back on its POST

    [HttpPost]
    public async Task<IActionResult> Post([FromBody] JsonElement body, CancellationToken ct)
    {
        if (body.ValueKind != JsonValueKind.Object) return Rpc(null, error: (-32600, "Send one JSON-RPC request object."));
        var id = body.TryGetProperty("id", out var i) ? JsonNode.Parse(i.GetRawText()) : null;
        var method = body.TryGetProperty("method", out var m) && m.ValueKind == JsonValueKind.String ? m.GetString() : null;
        var args = body.TryGetProperty("params", out var p) && p.ValueKind == JsonValueKind.Object ? p : default;
        if (method is null) return Rpc(id, error: (-32600, "A method is required."));
        if (id is null) return Accepted();   // a notification (notifications/initialized, cancelled): nothing to answer
        switch (method)
        {
            case "initialize":
                return Rpc(id, new JsonObject
                {
                    ["protocolVersion"] = args.ValueKind == JsonValueKind.Object && args.TryGetProperty("protocolVersion", out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : Protocol,
                    ["capabilities"] = new JsonObject { ["tools"] = new JsonObject { ["listChanged"] = false } },
                    ["serverInfo"] = new JsonObject { ["name"] = "projecttracker", ["title"] = "ProjectTracker", ["version"] = "1.1.0" },
                    ["instructions"] = "Work in the user's ProjectTracker workspace: find projects and tasks before changing them, and use ids from earlier results.",
                });
            case "ping": return Rpc(id, new JsonObject());
            case "tools/list":
                return Rpc(id, new JsonObject { ["tools"] = new JsonArray(Tools.Select(t => (JsonNode)new JsonObject
                {
                    ["name"] = t.Name, ["title"] = t.Title, ["description"] = t.Description, ["inputSchema"] = t.Schema.DeepClone(),
                    ["annotations"] = new JsonObject
                    {
                        ["title"] = t.Title, ["readOnlyHint"] = t.ReadOnly, ["destructiveHint"] = !t.ReadOnly, ["idempotentHint"] = t.Idempotent, ["openWorldHint"] = false,
                    },
                }).ToArray()) });
            case "tools/call":
                var name = args.ValueKind == JsonValueKind.Object && args.TryGetProperty("name", out var n) ? n.GetString() : null;
                var input = args.ValueKind == JsonValueKind.Object && args.TryGetProperty("arguments", out var a) && a.ValueKind == JsonValueKind.Object ? a : default;
                if (Tools.All(t => t.Name != name)) return Rpc(id, error: (-32602, $"Unknown tool: {name}"));
                try
                {
                    var text = await CallAsync(name!, input, ct);
                    return Rpc(id, Result(text, false));
                }
                catch (ToolError e) { return Rpc(id, Result(e.Message, true)); }
            default: return Rpc(id, error: (-32601, $"Method not found: {method}"));
        }
    }

    private static JsonObject Result(string text, bool error) =>
        new() { ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = text }), ["isError"] = error };

    private ContentResult Rpc(JsonNode? id, JsonObject? result = null, (int Code, string Message)? error = null)
    {
        var o = new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id?.DeepClone() };
        if (error is { } e) o["error"] = new JsonObject { ["code"] = e.Code, ["message"] = e.Message }; else o["result"] = result;
        return Content(o.ToJsonString(), "application/json");
    }

    private sealed class ToolError(string message) : Exception(message);

    private static string Arg(JsonElement input, string name, bool required = true)
    {
        if (input.ValueKind == JsonValueKind.Object && input.TryGetProperty(name, out var v))
        {
            var s = v.ValueKind == JsonValueKind.String ? v.GetString() : v.ValueKind is JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False ? v.GetRawText() : null;
            if (!string.IsNullOrWhiteSpace(s)) return s.Trim();
        }
        if (required) throw new ToolError($"'{name}' is required.");
        return "";
    }
    private static string Id(JsonElement input, string name) =>
        Guid.TryParse(Arg(input, name), out var g) ? g.ToString() : throw new ToolError($"'{name}' must be an id from an earlier result.");

    private async Task<string> CallAsync(string tool, JsonElement input, CancellationToken ct)
    {
        string Q(string s) => Uri.EscapeDataString(s);
        switch (tool)
        {
            case "list_projects": return await SendAsync(HttpMethod.Get, $"projects?pageSize=50{(Arg(input, "q", false) is { Length: > 0 } q ? "&q=" + Q(q) : "")}", null, ct);
            case "get_project": return await SendAsync(HttpMethod.Get, $"projects/{Id(input, "projectId")}", null, ct);
            case "list_project_tasks":
                return await SendAsync(HttpMethod.Get, $"projects/{Id(input, "projectId")}/tasks?pageSize=100{(Arg(input, "q", false) is { Length: > 0 } tq ? "&q=" + Q(tq) : "")}", null, ct);
            case "my_work":
                var open = Arg(input, "open", false) is "false" ? "false" : "true";
                return await SendAsync(HttpMethod.Get, $"my-work?open={open}&limit=100{(Arg(input, "overdue", false) is "true" ? "&overdue=true" : "")}{(Arg(input, "q", false) is { Length: > 0 } mq ? "&q=" + Q(mq) : "")}", null, ct);
            case "get_task": return await SendAsync(HttpMethod.Get, $"tasks/{Id(input, "taskId")}", null, ct);
            case "create_task":
                var priority = Priority(Arg(input, "priority", false));
                return await SendAsync(HttpMethod.Post, $"projects/{Id(input, "projectId")}/tasks", new
                {
                    title = Arg(input, "title"), description = NullIfEmpty(Arg(input, "description", false)), priority,
                    dueDate = NullIfEmpty(Arg(input, "dueDate", false)), assigneeId = NullIfEmpty(Arg(input, "assigneeId", false)),
                }, ct);
            case "update_task_status":
            {
                var taskId = Id(input, "taskId"); var wanted = Arg(input, "status");
                using var task = JsonDocument.Parse(await SendAsync(HttpMethod.Get, $"tasks/{taskId}", null, ct));
                var projectId = task.RootElement.TryGetProperty("projectId", out var pid) ? pid.GetString() : null;
                if (projectId is null) throw new ToolError("The task's project could not be found.");
                using var statuses = JsonDocument.Parse(await SendAsync(HttpMethod.Get, $"projects/{projectId}/statuses", null, ct));
                var all = statuses.RootElement.ValueKind == JsonValueKind.Array ? statuses.RootElement.EnumerateArray().ToList() : [];
                var match = all.FirstOrDefault(s => string.Equals(s.GetProperty("name").GetString(), wanted, StringComparison.OrdinalIgnoreCase));
                if (match.ValueKind != JsonValueKind.Object)
                    throw new ToolError($"No status called '{wanted}'. This project's statuses: {string.Join(", ", all.Select(s => s.GetProperty("name").GetString()))}.");
                return await SendAsync(HttpMethod.Patch, $"tasks/{taskId}/move", new { statusId = match.GetProperty("id").GetString() }, ct);
            }
            case "add_task_comment": return await SendAsync(HttpMethod.Post, $"tasks/{Id(input, "taskId")}/comments", new { body = Arg(input, "body") }, ct);
            case "log_time":
                if (!int.TryParse(Arg(input, "minutes"), out var minutes) || minutes is < 1 or > 1440) throw new ToolError("'minutes' must be from 1 to 1440.");
                return await SendAsync(HttpMethod.Post, $"tasks/{Id(input, "taskId")}/time", new { minutes, workDate = NullIfEmpty(Arg(input, "date", false)), note = NullIfEmpty(Arg(input, "note", false)) }, ct);
            case "create_work_item":
            {
                using var types = JsonDocument.Parse(await SendAsync(HttpMethod.Get, "work-types", null, ct));
                var list = types.RootElement.ValueKind == JsonValueKind.Array ? types.RootElement.EnumerateArray().ToList() : [];
                var wanted = Arg(input, "workType", false);
                var type = list.FirstOrDefault(t => wanted.Length > 0 && string.Equals(t.GetProperty("name").GetString(), wanted, StringComparison.OrdinalIgnoreCase));
                if (type.ValueKind != JsonValueKind.Object) type = list.FirstOrDefault();
                if (type.ValueKind != JsonValueKind.Object) throw new ToolError("This workspace has no work types yet.");
                return await SendAsync(HttpMethod.Post, "work-tasks", new { title = Arg(input, "title"), description = NullIfEmpty(Arg(input, "description", false)),
                    workTypeId = type.GetProperty("id").GetString(), priority = Priority(Arg(input, "priority", false)) }, ct);
            }
            case "list_work_items":
                return await SendAsync(HttpMethod.Get, $"work-tasks?pageSize=50&open={(Arg(input, "open", false) is "false" ? "false" : "true")}{(Arg(input, "mine", false) is "true" ? "&mine=true" : "")}{(Arg(input, "q", false) is { Length: > 0 } wq ? "&q=" + Q(wq) : "")}", null, ct);
            case "search_api_docs":
                var term = Arg(input, "q");
                if (term.Length < 2) throw new ToolError("'q' needs at least 2 characters.");
                return await SendAsync(HttpMethod.Get, $"api-search?q={Q(term)}", null, ct);
            case "update_work_item_status":
                return await SendAsync(HttpMethod.Put, $"work-tasks/{Id(input, "workItemId")}/status", new { status = Arg(input, "status") }, ct);
            default: throw new ToolError($"Unknown tool: {tool}");
        }
    }

    private static string? NullIfEmpty(string s) => s.Length == 0 ? null : s;
    private static string Priority(string s) =>
        new[] { "Low", "Medium", "High", "Critical" }.FirstOrDefault(p => p.Equals(s, StringComparison.OrdinalIgnoreCase)) ?? "Medium";

    /// <summary>The app's own endpoint, called as the same caller (same key, same workspace), so every permission and rule applies unchanged.</summary>
    private async Task<string> SendAsync(HttpMethod method, string path, object? payload, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, $"{BaseUrl()}/api/v1/{path}");
        if (HttpContext.Items[ProjectManagement.Api.Middleware.ApiKeyAuthMiddleware.ItemToken] is string key) request.Headers.TryAddWithoutValidation("X-Api-Key", key);
        else if (Request.Headers.Authorization.Count > 0) request.Headers.TryAddWithoutValidation("Authorization", Request.Headers.Authorization.ToString());
        foreach (var h in Request.Headers.Where(h => h.Key.StartsWith("X-Workspace", StringComparison.OrdinalIgnoreCase) || h.Key.Equals("X-Team-Lens", StringComparison.OrdinalIgnoreCase)))
            request.Headers.TryAddWithoutValidation(h.Key, h.Value.ToString());
        if (payload is not null) request.Content = new StringContent(JsonSerializer.Serialize(payload, Json), Encoding.UTF8, "application/json");
        using var response = await http.CreateClient("mcp-self").SendAsync(request, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        JsonNode? node = null;
        try { node = JsonNode.Parse(text); } catch (JsonException) { }
        if (!response.IsSuccessStatusCode)
        {
            var message = node?["errors"]?[0]?["message"]?.GetValue<string>() ?? node?["message"]?.GetValue<string>() ?? $"The request failed ({(int)response.StatusCode}).";
            throw new ToolError(message);
        }
        var data = node?["data"] ?? node;
        var result = data?.ToJsonString() ?? "{}";
        return result.Length > 40_000 ? result[..40_000] + "…(truncated: narrow the request)" : result;
    }

    private string BaseUrl()
    {
        var address = server.Features.Get<IServerAddressesFeature>()?.Addresses.FirstOrDefault(a => a.StartsWith("http://", StringComparison.OrdinalIgnoreCase));
        if (address is not null)
        {
            var uri = address.Replace("://+", "://localhost").Replace("://*", "://localhost").Replace("://[::]", "://localhost").Replace("://0.0.0.0", "://localhost");
            if (Uri.TryCreate(uri, UriKind.Absolute, out var u)) return $"http://127.0.0.1:{u.Port}";
        }
        return $"{Request.Scheme}://{Request.Host}";
    }
}
