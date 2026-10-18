using System.Collections.Concurrent;
using System.Net;
using System.Text.Json;
using ProjectManagement.Application.Features.Integrations;

namespace ProjectManagement.Tests.Infrastructure;

public sealed class FakeSlack : HttpMessageHandler
{
    private readonly ConcurrentDictionary<string, (string Team, string App)> _codes = new();
    public ConcurrentBag<string> RevokedTokens { get; } = [];
    /// <summary>What conversations.history returns (newest first, like Slack), for any channel.</summary>
    public ConcurrentQueue<(string Ts, string User, string Text)> History { get; } = new();
    public ConcurrentQueue<string> HistoryReads { get; } = new();
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
        else if (request.RequestUri.AbsolutePath == "/api/conversations.history")
        {
            HistoryReads.Enqueue(request.RequestUri.Query);
            var oldest = decimal.Parse(System.Web.HttpUtility.ParseQueryString(request.RequestUri.Query)["oldest"] ?? "0", System.Globalization.CultureInfo.InvariantCulture);
            result = new { ok = true, has_more = false, messages = History.Where(m => decimal.Parse(m.Ts, System.Globalization.CultureInfo.InvariantCulture) > oldest)
                .OrderByDescending(m => m.Ts).Select(m => new { type = "message", ts = m.Ts, user = m.User, text = m.Text }).ToArray() };
        }
        else if (request.RequestUri.AbsolutePath == "/api/users.info")
        {
            var user = System.Web.HttpUtility.ParseQueryString(request.RequestUri.Query)["user"];
            result = new { ok = true, user = new { id = user, name = "ravi", profile = new { real_name = user == "U1" ? "Ravi Kumar" : "Priya" } } };
        }
        else throw new InvalidOperationException("Unexpected Slack call; no real network requests are allowed in these tests.");
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(result)) };
    }
}
