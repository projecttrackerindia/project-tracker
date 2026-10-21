using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Connected apps: an MCP client (Claude, ChatGPT) discovers the OAuth server, registers, gets the person's consent with PKCE and works through MCP.</summary>
[Collection("api")]
public class OAuthTests(ApiFactory factory)
{
    private const string Redirect = "https://claude.ai/api/mcp/auth_callback";

    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static (string Verifier, string Challenge) Pkce()
    {
        var verifier = Convert.ToBase64String(RandomNumberGenerator.GetBytes(48)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var challenge = Convert.ToBase64String(SHA256.HashData(Encoding.ASCII.GetBytes(verifier))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return (verifier, challenge);
    }

    private async Task<JsonObject> Form(string url, Dictionary<string, string> form, HttpStatusCode expect = HttpStatusCode.OK)
    {
        using var http = factory.CreateClient();
        var res = await http.PostAsync(url, new FormUrlEncodedContent(form));
        var text = await res.Content.ReadAsStringAsync();
        Assert.True(res.StatusCode == expect, $"{(int)res.StatusCode} {text}");
        return (JsonNode.Parse(text) as JsonObject)!;
    }

    private async Task<(HttpStatusCode Status, JsonNode? Json, HttpResponseMessage Res)> Mcp(string? token, object body)
    {
        using var http = factory.CreateClient();
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/mcp") { Content = JsonContent.Create(body) };
        if (token is not null) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var res = await http.SendAsync(req);
        var text = await res.Content.ReadAsStringAsync();
        return (res.StatusCode, string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text), res);
    }

    private async Task<(string ClientId, TestClient Me, string ProjectId)> Setup(string name)
    {
        using var http = factory.CreateClient();
        var reg = await http.PostAsJsonAsync("/oauth/register", new { client_name = "Claude", redirect_uris = new[] { Redirect } });
        Assert.Equal(HttpStatusCode.Created, reg.StatusCode);
        var clientId = S(JsonNode.Parse(await reg.Content.ReadAsStringAsync())!["client_id"]);
        var me = await TestClient.RegisterAsync(factory, name);
        await me.CreateOrgAsync();                                                       // the Free plan: connected apps work on every plan
        var project = (await me.CreateProjectAsync("Connector project")).ToString();
        return (clientId, me, project);
    }

    private async Task<JsonObject> Connect(TestClient me, string clientId, string scope)
    {
        var (verifier, challenge) = Pkce();
        var consent = await me.Post("/api/v1/oauth/consent", new { clientId, redirectUri = Redirect, state = "s1", codeChallenge = challenge, codeChallengeMethod = "S256", scope, approve = true });
        Assert.True(consent.Ok, consent.ToString());
        var back = new Uri(S(consent.Data!["redirect"]));
        Assert.StartsWith(Redirect, back.ToString());
        var query = System.Web.HttpUtility.ParseQueryString(back.Query);
        Assert.Equal("s1", query["state"]);
        return await Form("/oauth/token", new() { ["grant_type"] = "authorization_code", ["code"] = query["code"]!, ["redirect_uri"] = Redirect, ["client_id"] = clientId, ["code_verifier"] = verifier });
    }

    [Fact]
    public async Task Discovery_registration_and_an_unsigned_mcp_call_lead_the_client_to_sign_in()
    {
        using var http = factory.CreateClient();
        var resource = JsonNode.Parse(await http.GetStringAsync("/.well-known/oauth-protected-resource/api/v1/mcp"))!;
        Assert.EndsWith("/api/v1/mcp", S(resource["resource"]));
        var server = JsonNode.Parse(await http.GetStringAsync("/.well-known/oauth-authorization-server"))!;
        Assert.Contains("S256", server["code_challenge_methods_supported"]!.AsArray().Select(S));
        Assert.EndsWith("/oauth/register", S(server["registration_endpoint"]));

        var unsigned = await Mcp(null, new { jsonrpc = "2.0", id = 1, method = "tools/list" });
        Assert.Equal(HttpStatusCode.Unauthorized, unsigned.Status);
        Assert.Contains("resource_metadata=", unsigned.Res.Headers.WwwAuthenticate.ToString());

        Assert.Equal(HttpStatusCode.BadRequest, (await http.PostAsJsonAsync("/oauth/register", new { client_name = "Bad", redirect_uris = new[] { "http://evil.example/cb" } })).StatusCode);   // http only on localhost
        var (clientId, me, _) = await Setup("Olive Oauth");
        var info = await me.Get($"/api/v1/oauth/client?clientId={clientId}&redirectUri={Uri.EscapeDataString(Redirect)}");
        Assert.True(info.Data!["redirectAllowed"]!.GetValue<bool>());
        Assert.False((await me.Get($"/api/v1/oauth/client?clientId={clientId}&redirectUri={Uri.EscapeDataString("https://other.example/cb")}")).Data!["redirectAllowed"]!.GetValue<bool>());
        Assert.Equal(422, (int)(await me.Post("/api/v1/oauth/consent", new { clientId, redirectUri = "https://other.example/cb", codeChallenge = new string('a', 43), approve = true })).Status);
    }

    [Fact]
    public async Task A_connected_app_works_through_mcp_within_its_scope_and_stops_when_disconnected()
    {
        var (clientId, me, projectId) = await Setup("Rhea Read");
        var read = await Connect(me, clientId, "mcp:read");
        var access = S(read["access_token"]);
        Assert.Equal("Bearer", S(read["token_type"]));
        Assert.Equal("mcp:read", S(read["scope"]));

        var tools = await Mcp(access, new { jsonrpc = "2.0", id = 1, method = "tools/list" });
        Assert.Equal(HttpStatusCode.OK, tools.Status);
        var list = tools.Json!["result"]!["tools"]!.AsArray();
        Assert.All(list, t => Assert.NotNull(t!["annotations"]!["readOnlyHint"]));
        Assert.True(list.First(t => S(t!["name"]) == "list_projects")!["annotations"]!["readOnlyHint"]!.GetValue<bool>());
        Assert.True(list.First(t => S(t!["name"]) == "create_task")!["annotations"]!["destructiveHint"]!.GetValue<bool>());

        // The tool really runs as the person: their project comes back.
        var projects = await Mcp(access, new { jsonrpc = "2.0", id = 2, method = "tools/call", @params = new { name = "list_projects", arguments = new { } } });
        Assert.False(projects.Json!["result"]!["isError"]!.GetValue<bool>(), projects.Json.ToJsonString());
        Assert.Contains("Connector project", projects.Json!["result"]!["content"]![0]!["text"]!.GetValue<string>());
        // Read only: no changes.
        var write = await Mcp(access, new { jsonrpc = "2.0", id = 3, method = "tools/call", @params = new { name = "create_task", arguments = new { projectId, title = "From Claude" } } });
        Assert.True(write.Json!["result"]!["isError"]!.GetValue<bool>());

        // A second connection allows changes; the refresh token rotates and the old one stops working.
        var full = await Connect(me, clientId, "mcp:read mcp:write");
        var created = await Mcp(S(full["access_token"]), new { jsonrpc = "2.0", id = 4, method = "tools/call", @params = new { name = "create_task", arguments = new { projectId, title = "From Claude" } } });
        Assert.False(created.Json!["result"]!["isError"]!.GetValue<bool>(), created.Json.ToJsonString());
        var renewed = await Form("/oauth/token", new() { ["grant_type"] = "refresh_token", ["refresh_token"] = S(full["refresh_token"]), ["client_id"] = clientId });
        Assert.NotEqual(S(full["access_token"]), S(renewed["access_token"]));
        Assert.Equal(HttpStatusCode.Unauthorized, (await Mcp(S(full["access_token"]), new { jsonrpc = "2.0", id = 5, method = "tools/list" })).Status);   // the old access token ended
        await Form("/oauth/token", new() { ["grant_type"] = "refresh_token", ["refresh_token"] = S(full["refresh_token"]), ["client_id"] = clientId }, HttpStatusCode.BadRequest);

        // A code works once.
        var apps = await me.Get("/api/v1/connected-apps");
        Assert.Equal(2, apps.Data!.AsArray().Count);
        Assert.All(apps.Data!.AsArray(), a => Assert.Equal("Claude", S(a!["clientName"])));
        Assert.DoesNotContain((await me.Get("/api/v1/api-keys")).Data?.AsArray() ?? [], k => S(k!["name"]).Contains("connected app"));

        // Disconnecting ends its tokens at once.
        foreach (var a in apps.Data!.AsArray()) Assert.Equal(HttpStatusCode.NoContent, (await me.Delete($"/api/v1/connected-apps/{S(a!["id"])}")).Status);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Mcp(S(renewed["access_token"]), new { jsonrpc = "2.0", id = 6, method = "tools/list" })).Status);
        await Form("/oauth/token", new() { ["grant_type"] = "refresh_token", ["refresh_token"] = S(renewed["refresh_token"]), ["client_id"] = clientId }, HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Codes_need_the_right_verifier_and_work_only_once()
    {
        var (clientId, me, _) = await Setup("Pia Pkce");
        var (verifier, challenge) = Pkce();
        var consent = await me.Post("/api/v1/oauth/consent", new { clientId, redirectUri = Redirect, state = "x", codeChallenge = challenge, codeChallengeMethod = "S256", scope = "mcp:read", approve = true });
        var code = System.Web.HttpUtility.ParseQueryString(new Uri(S(consent.Data!["redirect"])).Query)["code"]!;
        var bad = await Form("/oauth/token", new() { ["grant_type"] = "authorization_code", ["code"] = code, ["redirect_uri"] = Redirect, ["client_id"] = clientId, ["code_verifier"] = new string('z', 50) }, HttpStatusCode.BadRequest);
        Assert.Equal("invalid_grant", S(bad["error"]));
        await Form("/oauth/token", new() { ["grant_type"] = "authorization_code", ["code"] = code, ["redirect_uri"] = Redirect, ["client_id"] = clientId, ["code_verifier"] = verifier }, HttpStatusCode.BadRequest);   // the failed try used it
        var declined = await me.Post("/api/v1/oauth/consent", new { clientId, redirectUri = Redirect, state = "y", codeChallenge = challenge, approve = false });
        Assert.Contains("error=access_denied", S(declined.Data!["redirect"]));
    }
}
