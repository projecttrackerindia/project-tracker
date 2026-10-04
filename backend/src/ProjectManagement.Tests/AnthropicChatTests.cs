using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Infrastructure.Services;

namespace ProjectManagement.Tests;

/// <summary>
/// The Claude connection of the AI workspace, run through the real SDK against a local server that replays the API's streaming format:
/// what is sent (model, thinking, effort, tools, images, caching) and how thinking, text and tool calls are put back together.
/// </summary>
public sealed class AnthropicChatTests : IDisposable
{
    private readonly HttpListener _server = new();
    private readonly string _url;
    private Func<HttpListenerRequest, string, (int Status, string Body)> _handler = (_, _) => (200, "");
    public List<JsonNode> Requests { get; } = [];

    public AnthropicChatTests()
    {
        var l = new TcpListener(IPAddress.Loopback, 0); l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port; l.Stop();
        _url = $"http://127.0.0.1:{port}";
        _server.Prefixes.Add(_url + "/");
        _server.Start();
        _ = Task.Run(async () =>
        {
            while (_server.IsListening)
            {
                HttpListenerContext ctx;
                try { ctx = await _server.GetContextAsync(); } catch { return; }
                string body;
                using (var r = new StreamReader(ctx.Request.InputStream, Encoding.UTF8)) body = await r.ReadToEndAsync();
                try { Requests.Add(JsonNode.Parse(body)!); } catch { /* not JSON */ }
                var (status, reply) = _handler(ctx.Request, body);
                ctx.Response.StatusCode = status;
                ctx.Response.ContentType = reply.StartsWith("event:") ? "text/event-stream" : "application/json";
                var bytes = Encoding.UTF8.GetBytes(reply);
                await ctx.Response.OutputStream.WriteAsync(bytes);
                ctx.Response.Close();
            }
        });
    }

    public void Dispose() => _server.Close();

    private AnthropicChat Chat(string key = "test-key") => new(Options.Create(new AiOptions { AnthropicApiKey = key, BaseUrl = _url }), NullLogger<AnthropicChat>.Instance);

    private static string Sse(params (string Event, string Data)[] events) => string.Concat(events.Select(e => $"event: {e.Event}\ndata: {e.Data}\n\n"));

    private static readonly string Weather = Sse(
        ("message_start", """{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":120,"output_tokens":1}}}"""),
        ("content_block_start", """{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}"""),
        ("content_block_delta", """{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Check the "}}"""),
        ("content_block_delta", """{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"overdue work."}}"""),
        ("content_block_delta", """{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG-ABC"}}"""),
        ("content_block_stop", """{"type":"content_block_stop","index":0}"""),
        ("content_block_start", """{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}"""),
        ("content_block_delta", """{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Let me "}}"""),
        ("content_block_delta", """{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"look."}}"""),
        ("content_block_stop", """{"type":"content_block_stop","index":1}"""),
        ("content_block_start", """{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_9","name":"find_work","input":{}}}"""),
        ("content_block_delta", """{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"overdue\":"}}"""),
        ("content_block_delta", """{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"true}"}}"""),
        ("content_block_stop", """{"type":"content_block_stop","index":2}"""),
        ("message_delta", """{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":55}}"""),
        ("message_stop", """{"type":"message_stop"}"""));

    private static AiChatRequest Request(string model = "claude-opus-5-5", string? effort = "high", bool reasoning = true, IReadOnlyList<AiTurn>? turns = null, IReadOnlyList<AiToolDef>? tools = null) =>
        new(model, "You are the assistant.", turns ?? [AiTurn.User("What is overdue?")], tools ?? [], 4000, effort, reasoning);

    private static async Task<List<AiChatEvent>> Collect(IAsyncEnumerable<AiChatEvent> stream)
    {
        var all = new List<AiChatEvent>();
        await foreach (var e in stream) all.Add(e);
        return all;
    }

    [Fact]
    public async Task A_streamed_turn_is_put_back_together_with_reasoning_text_and_the_tool_call()
    {
        _handler = (_, _) => (200, Weather);
        var tools = new[] { new AiToolDef("find_work", "Finds work items.", """{"type":"object","properties":{"overdue":{"type":"boolean"}},"required":["overdue"]}""") };
        var events = await Collect(Chat().StreamAsync(Request(tools: tools), default));

        // Live pieces, in order, for the page to show while the model works.
        Assert.Equal(["Check the ", "overdue work."], events.OfType<AiThinkingDelta>().Select(e => e.Text));
        Assert.Equal(["Let me ", "look."], events.OfType<AiTextDelta>().Select(e => e.Text));

        // The finished turn: everything the model produced, ready to go back with the tool's result.
        var end = Assert.IsType<AiTurnEnd>(events[^1]);
        Assert.True(end.WantsTools);
        Assert.Equal(120, end.InputTokens);
        Assert.Equal(55, end.OutputTokens);
        var thinking = Assert.IsType<AiThinking>(end.Assistant[0]);
        Assert.Equal("Check the overdue work.", thinking.Text);
        Assert.Equal("SIG-ABC", thinking.Signature);   // must come back unchanged on the next call
        Assert.Equal("Let me look.", Assert.IsType<AiText>(end.Assistant[1]).Text);
        var use = Assert.IsType<AiToolUse>(end.Assistant[2]);
        Assert.Equal(("toolu_9", "find_work"), (use.Id, use.Name));
        Assert.True(JsonNode.Parse(use.InputJson)!["overdue"]!.GetValue<bool>());
    }

    [Fact]
    public async Task The_request_carries_the_level_the_agent_chose()
    {
        _handler = (_, _) => (200, Weather);
        var tools = new[] { new AiToolDef("find_work", "Finds work items.", """{"type":"object","properties":{"overdue":{"type":"boolean"}},"required":["overdue"]}""") };
        await Collect(Chat().StreamAsync(Request(tools: tools), default));

        var sent = Requests[0];
        Assert.Equal("claude-opus-5-5", sent["model"]!.GetValue<string>());
        Assert.True(sent["stream"]!.GetValue<bool>());
        Assert.Equal("adaptive", sent["thinking"]!["type"]!.GetValue<string>());
        Assert.Equal("summarized", sent["thinking"]!["display"]!.GetValue<string>());
        Assert.Equal("high", sent["output_config"]!["effort"]!.GetValue<string>());
        Assert.Equal("find_work", sent["tools"]![0]!["name"]!.GetValue<string>());
        Assert.Equal("overdue", sent["tools"]![0]!["input_schema"]!["required"]![0]!.GetValue<string>());
        // The instructions are marked cacheable.
        Assert.Equal("ephemeral", sent["system"]![0]!["cache_control"]!["type"]!.GetValue<string>());
    }

    [Fact]
    public async Task The_quick_level_sends_no_thinking_and_no_effort()
    {
        _handler = (_, _) => (200, Weather);
        await Collect(Chat().StreamAsync(Request("claude-haiku-4-5", effort: null, reasoning: false), default));
        var sent = Requests[0];
        Assert.Equal("claude-haiku-4-5", sent["model"]!.GetValue<string>());
        Assert.Null(sent["thinking"]);
        Assert.Null(sent["output_config"]);
        Assert.Null(sent["tools"]);
    }

    [Fact]
    public async Task Tool_results_images_and_earlier_reasoning_go_back_in_the_form_the_api_expects()
    {
        _handler = (_, _) => (200, Weather);
        var png = new byte[] { 0x89, 0x50, 0x4E, 0x47, 1, 2, 3 };
        var turns = new List<AiTurn>
        {
            new("user", [new AiText("Here is a chart"), new AiImage("image/png", png), new AiPdf([0x25, 0x50, 0x44, 0x46], "plan.pdf")]),
            new("assistant", [new AiThinking("hmm", "SIG-1"), new AiText("Checking."), new AiToolUse("toolu_1", "find_work", """{"overdue":true}""")]),
            new("user", [new AiToolResult("toolu_1", "3 items", false)]),
        };
        await Collect(Chat().StreamAsync(Request(turns: turns), default));

        var m = Requests[0]["messages"]!.AsArray();
        Assert.Equal("image", m[0]!["content"]![1]!["type"]!.GetValue<string>());
        Assert.Equal("image/png", m[0]!["content"]![1]!["source"]!["media_type"]!.GetValue<string>());
        Assert.Equal(Convert.ToBase64String(png), m[0]!["content"]![1]!["source"]!["data"]!.GetValue<string>());
        Assert.Equal("document", m[0]!["content"]![2]!["type"]!.GetValue<string>());
        Assert.Equal("thinking", m[1]!["content"]![0]!["type"]!.GetValue<string>());
        Assert.Equal("SIG-1", m[1]!["content"]![0]!["signature"]!.GetValue<string>());
        Assert.True(m[1]!["content"]![2]!["input"]!["overdue"]!.GetValue<bool>());
        Assert.Equal("tool_result", m[2]!["content"]![0]!["type"]!.GetValue<string>());
        Assert.Equal("toolu_1", m[2]!["content"]![0]!["tool_use_id"]!.GetValue<string>());
    }

    [Fact]
    public async Task A_short_answer_is_returned_as_plain_text()
    {
        _handler = (_, _) => (200, """{"id":"msg_2","type":"message","role":"assistant","model":"claude-haiku-4-5","content":[{"type":"text","text":"deep"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":30,"output_tokens":2}}""");
        Assert.Equal("deep", await Chat().CompleteAsync("claude-haiku-4-5", "sys", "question", 20, default));
        Assert.Equal(20, Requests[0]["max_tokens"]!.GetValue<int>());
    }

    [Theory]
    [InlineData(401, "AI_KEY_REFUSED")]
    [InlineData(429, "AI_BUSY")]
    [InlineData(404, "AI_MODEL_UNKNOWN")]
    public async Task Provider_failures_become_friendly_errors_the_page_can_explain(int status, string code)
    {
        _handler = (_, _) => (status, """{"type":"error","error":{"type":"x","message":"nope"}}""");
        var ex = await Assert.ThrowsAsync<AiProviderException>(() => Collect(Chat().StreamAsync(Request(), default)));
        Assert.Equal(code, ex.Code);
        Assert.Contains("Claude", ex.Message);
    }

    [Fact]
    public async Task Nothing_is_called_without_a_key()
    {
        var chat = Chat(key: "");
        Assert.False(chat.Configured);
        var ex = await Assert.ThrowsAsync<ConflictException>(() => Collect(chat.StreamAsync(Request(), default)));
        Assert.Equal("AI_NOT_CONFIGURED", ex.Code);
        Assert.Empty(Requests);
    }
}
