using System.Collections.Concurrent;
using System.Net;
using System.Text.Json;
using ProjectManagement.Application.Features.Integrations;

namespace ProjectManagement.Tests.Infrastructure;

public sealed class FakeSlack : HttpMessageHandler
{
    private readonly ConcurrentDictionary<string, (string Team, string App)> _codes = new();
    public ConcurrentBag<string> RevokedTokens { get; } = [];
    public string IssueCode(string team, string app = "A_TEST")
    {
        var code = Guid.NewGuid().ToString("N"); _codes[code] = (team, app); return code;
    }
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        object result;
        if (request.RequestUri!.AbsolutePath == "/api/oauth.v2.access")
        {
            var form = (await request.Content!.ReadAsStringAsync(ct)).Split('&').Select(x => x.Split('=', 2)).ToDictionary(x => x[0], x => Uri.UnescapeDataString(x[1]));
            result = _codes.TryRemove(form["code"], out var grant)
                ? new { ok = true, app_id = grant.App, team = new { id = grant.Team, name = "Workspace " + grant.Team }, bot_user_id = "B_TEST", access_token = "xoxb-test-" + grant.Team, scope = SlackConnectionService.Scopes } : (object)new { ok = false, error = "invalid_code" };
        }
        else if (request.RequestUri.AbsolutePath == "/api/auth.revoke")
        {
            RevokedTokens.Add(request.Headers.Authorization!.Parameter!); result = new { ok = true };
        }
        else throw new InvalidOperationException("Unexpected Slack call; no real network requests are allowed in these tests.");
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(result)) };
    }
}
