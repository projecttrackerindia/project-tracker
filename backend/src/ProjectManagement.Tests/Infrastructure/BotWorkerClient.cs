using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace ProjectManagement.Tests.Infrastructure;

/// <summary>Plays a meeting-bot worker (apps/meetbot in worker mode): reports its bots and asks the API for sessions.</summary>
public static class BotWorkerClient
{
    public const string Secret = "test-meetbot-secret-0123";

    public record Poll(HttpStatusCode Status, JsonNode? Data)
    {
        public JsonArray Jobs => Data?["jobs"]?.AsArray() ?? [];
        public JsonArray Bots => Data?["bots"]?.AsArray() ?? [];
        public JsonNode? Job(string jobId) => Jobs.FirstOrDefault(j => string.Equals(j!["jobId"]!.GetValue<string>(), jobId, StringComparison.OrdinalIgnoreCase));
        public JsonNode? Bot(string jobId) => Bots.FirstOrDefault(b => string.Equals(b!["jobId"]!.GetValue<string>(), jobId, StringComparison.OrdinalIgnoreCase));
    }

    /// <param name="bots">What the worker reports: (job id, status).</param>
    public static async Task<Poll> PollAsync(ApiFactory factory, string workerId, int capacity, IEnumerable<(string JobId, string Status)>? bots = null,
        bool draining = false, string secret = Secret)
    {
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", secret);
        var res = await client.PostAsJsonAsync("/api/v1/agent/bot-workers/poll", new
        {
            workerId, host = "test-host", version = "test", capacity, draining,
            bots = (bots ?? []).Select(b => new { jobId = b.JobId, status = b.Status, error = (string?)null, lines = 0 }).ToArray(),
        });
        var text = await res.Content.ReadAsStringAsync();
        var json = string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
        return new Poll(res.StatusCode, json?["data"] ?? json);
    }
}
