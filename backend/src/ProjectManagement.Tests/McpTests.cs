using System.Net;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>ProjectTracker as an MCP server: the handshake, the tool list and argument checks (tool calls reuse the app's own endpoints).</summary>
[Collection("api")]
public class McpTests(ApiFactory factory)
{
    [Fact]
    public async Task Handshake_and_tool_list_follow_the_protocol()
    {
        var me = await TestClient.RegisterAsync(factory, "Mia Mcp");
        await me.CreateOrgAsync();
        var init = await me.Post("/api/v1/mcp", new { jsonrpc = "2.0", id = 1, method = "initialize", @params = new { protocolVersion = "2025-06-18", capabilities = new { }, clientInfo = new { name = "test", version = "1" } } });
        Assert.Equal(HttpStatusCode.OK, init.Status);
        Assert.Equal("projecttracker", init.Json!["result"]!["serverInfo"]!["name"]!.GetValue<string>());
        Assert.Equal(1, init.Json!["id"]!.GetValue<int>());
        Assert.Equal(HttpStatusCode.Accepted, (await me.Post("/api/v1/mcp", new { jsonrpc = "2.0", method = "notifications/initialized" })).Status);
        var tools = await me.Post("/api/v1/mcp", new { jsonrpc = "2.0", id = "t", method = "tools/list" });
        var names = tools.Json!["result"]!["tools"]!.AsArray().Select(t => t!["name"]!.GetValue<string>()).ToList();
        Assert.Contains("create_task", names); Assert.Contains("my_work", names); Assert.Contains("update_task_status", names);
        var bad = await me.Post("/api/v1/mcp", new { jsonrpc = "2.0", id = 2, method = "tools/call", @params = new { name = "get_task", arguments = new { taskId = "nope" } } });
        Assert.True(bad.Json!["result"]!["isError"]!.GetValue<bool>());
        Assert.Equal(-32601, (await me.Post("/api/v1/mcp", new { jsonrpc = "2.0", id = 3, method = "resources/list" })).Json!["error"]!["code"]!.GetValue<int>());
        Assert.Equal(HttpStatusCode.Unauthorized, (await me.Send(HttpMethod.Post, "/api/v1/mcp", new { jsonrpc = "2.0", id = 4, method = "tools/list" }, anonymous: true)).Status);
    }
}
