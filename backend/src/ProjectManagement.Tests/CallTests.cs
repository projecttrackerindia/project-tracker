using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.Calls;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Join passes are signed JWTs for one room; webhooks are accepted only when signed over exactly their body.</summary>
public class LiveKitTokenTests
{
    private const string Secret = "unit-test-secret-0123456789abcdef-xyz";

    private static JsonNode Payload(string jwt)
    {
        var part = jwt.Split('.')[1].Replace('-', '+').Replace('_', '/');
        return JsonNode.Parse(Convert.FromBase64String(part.PadRight(part.Length + (4 - part.Length % 4) % 4, '=')))!;
    }

    [Fact]
    public void A_join_pass_names_the_person_and_one_room_and_is_signed()
    {
        var now = DateTimeOffset.UtcNow;
        var jwt = LiveKitTokens.Mint("key1", Secret, "user:abc", "Asha", new LiveKitGrant(Room: "pt-room", RoomJoin: true), TimeSpan.FromHours(2), now, """{"userId":"abc"}""");
        var p = Payload(jwt);
        Assert.Equal("key1", (string)p["iss"]!);
        Assert.Equal("user:abc", (string)p["sub"]!);
        Assert.Equal("Asha", (string)p["name"]!);
        Assert.Equal("pt-room", (string)p["video"]!["room"]!);
        Assert.True((bool)p["video"]!["roomJoin"]!);
        Assert.Null(p["video"]!["roomAdmin"]);
        Assert.InRange((long)p["exp"]! - now.ToUnixTimeSeconds(), 7190, 7210);
        var parts = jwt.Split('.');
        var sig = Convert.ToBase64String(HMACSHA256.HashData(Encoding.UTF8.GetBytes(Secret), Encoding.UTF8.GetBytes($"{parts[0]}.{parts[1]}"))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        Assert.Equal(sig, parts[2]);
    }

    public static string SignedWebhook(string key, string secret, string body, DateTimeOffset now)
    {
        var sha = Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(body)));
        var head = Convert.ToBase64String(Encoding.UTF8.GetBytes("""{"alg":"HS256","typ":"JWT"}""")).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var payload = Convert.ToBase64String(Encoding.UTF8.GetBytes(new JsonObject { ["iss"] = key, ["exp"] = now.AddMinutes(5).ToUnixTimeSeconds(), ["nbf"] = now.AddMinutes(-1).ToUnixTimeSeconds(), ["sha256"] = sha }.ToJsonString()))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var sig = Convert.ToBase64String(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes($"{head}.{payload}"))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return $"{head}.{payload}.{sig}";
    }

    [Fact]
    public void Webhooks_are_checked_against_the_secret_the_key_and_the_body()
    {
        var now = DateTimeOffset.UtcNow;
        const string body = """{"event":"room_finished","room":{"name":"pt-x"}}""";
        var auth = SignedWebhook("key1", Secret, body, now);
        Assert.True(LiveKitTokens.VerifyWebhook("key1", Secret, auth, body, now));
        Assert.False(LiveKitTokens.VerifyWebhook("key1", Secret, auth, body + " ", now));          // a changed body
        Assert.False(LiveKitTokens.VerifyWebhook("key2", Secret, auth, body, now));                // another key
        Assert.False(LiveKitTokens.VerifyWebhook("key1", Secret + "!", auth, body, now));          // another secret
        Assert.False(LiveKitTokens.VerifyWebhook("key1", Secret, null, body, now));
        Assert.False(LiveKitTokens.VerifyWebhook("key1", Secret, auth, body, now.AddHours(1)));    // expired
    }
}

[Collection("api")]
public class CallTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<(TestClient Owner, TestClient Manager, Guid Project)> SetupAsync()
    {
        var owner = await TestClient.RegisterAsync(factory, "Call Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var manager = await owner.AddMemberAsync(factory, TenantRole.Manager, "Mira Manager");
        return (owner, manager, await owner.CreateProjectAsync("Atlas Calls"));
    }

    private async Task<HttpStatusCode> Webhook(string body, string? auth)
    {
        using var client = factory.CreateClient();
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/calls/livekit") { Content = new StringContent(body, Encoding.UTF8, "application/webhook+json") };
        if (auth is not null) req.Headers.TryAddWithoutValidation("Authorization", auth);
        return (await client.SendAsync(req)).StatusCode;
    }

    [Fact]
    public async Task A_call_is_started_in_a_project_people_are_invited_join_with_a_pass_for_that_room_and_the_host_ends_it()
    {
        var (owner, manager, project) = await SetupAsync();
        var status = (await owner.Get("/api/v1/calls/status")).Data!;
        Assert.True(status["available"]!.GetValue<bool>());

        var started = await owner.Post("/api/v1/calls", new { projectId = project, invite = new[] { manager.UserId } });
        Assert.True(started.Ok, started.ToString());
        var call = started.Data!;
        var id = S(call["id"]);
        Assert.Equal("project", S(call["kind"]));
        Assert.Equal("Atlas Calls call", S(call["title"]));
        var room = factory.WithDb(db => db.CallRooms.IgnoreQueryFilters().Single(c => c.Id == Guid.Parse(id)).RoomName);
        Assert.True(factory.LiveKit.Open.ContainsKey(room));
        Assert.Contains(call["people"]!.AsArray(), p => S(p!["userId"]) == manager.UserId.ToString());
        Assert.True(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Any(n => n.UserId == manager.UserId && n.Link == $"/calls/{id}")));
        Assert.Contains((await manager.Get("/api/v1/calls/live")).Data!.AsArray(), c => S(c!["id"]) == id);

        // A pass for that room only, in the person's own name.
        var join = (await manager.Post($"/api/v1/calls/{id}/join")).Data!;
        Assert.Equal("wss://calls.test", S(join["url"]));
        Assert.Equal(room, S(join["room"]));
        var payload = JsonNode.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(Pad(S(join["token"]).Split('.')[1]))))!;
        Assert.Equal(CallService.Identity(manager.UserId), (string)payload["sub"]!);
        Assert.Equal("Mira Manager", (string)payload["name"]!);
        Assert.Equal(room, (string)payload["video"]!["room"]!);

        // The media server says who is in; unsigned events are refused.
        var joined = $$$"""{"event":"participant_joined","room":{"name":"{{{room}}}"},"participant":{"identity":"{{{CallService.Identity(manager.UserId)}}}"}}""";
        Assert.Equal(HttpStatusCode.Unauthorized, await Webhook(joined, null));
        Assert.Equal(HttpStatusCode.OK, await Webhook(joined, LiveKitTokenTests.SignedWebhook("testkey", ApiFactory.CallsSecret, joined, DateTimeOffset.UtcNow)));
        Assert.Contains((await owner.Get($"/api/v1/calls/{id}")).Data!["people"]!.AsArray(), p => S(p!["userId"]) == manager.UserId.ToString() && p["inCall"]!.GetValue<bool>());

        // Someone from another workspace cannot see or join it.
        var outsider = await TestClient.RegisterAsync(factory, "Out Sider");
        await outsider.CreateOrgAsync();
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Post($"/api/v1/calls/{id}/join")).Status);

        // Only the host ends it for everyone; then nobody can join.
        Assert.Equal(HttpStatusCode.Forbidden, (await manager.Post($"/api/v1/calls/{id}/end")).Status);
        var ended = await owner.Post($"/api/v1/calls/{id}/end");
        Assert.Equal("ended", S(ended.Data!["status"]));
        Assert.Contains(room, factory.LiveKit.Closed);
        Assert.Equal(HttpStatusCode.Conflict, (await manager.Post($"/api/v1/calls/{id}/join")).Status);
        Assert.DoesNotContain((await manager.Get("/api/v1/calls/live")).Data!.AsArray(), c => S(c!["id"]) == id);
    }

    private static string Pad(string s) { s = s.Replace('-', '+').Replace('_', '/'); return s.PadRight(s.Length + (4 - s.Length % 4) % 4, '='); }

    [Fact]
    public async Task The_project_agent_joins_our_own_calls_without_being_admitted_and_its_session_ends_with_the_call()
    {
        var (owner, manager, project) = await SetupAsync();
        // With the agent off the call still starts, and says why the agent is not there.
        var without = (await owner.Post("/api/v1/calls", new { projectId = project, agent = true })).Data!;
        Assert.False(without["agentEnabled"]!.GetValue<bool>());
        Assert.Contains("agent is off", S(without["agentStatus"]));
        await owner.Post($"/api/v1/calls/{S(without["id"])}/end");

        // The agent works through the AI assistant: switching it on needs one.
        var aiWas = factory.Ai.Configured;
        factory.Ai.Configured = true;
        try { var on = await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true, liveBot = true }); Assert.True(on.Ok, on.ToString()); }
        finally { factory.Ai.Configured = aiWas; }
        var call = (await owner.Post("/api/v1/calls", new { projectId = project, agent = true, title = "Sprint review" })).Data!;
        Assert.True(call["agentEnabled"]!.GetValue<bool>());
        var id = Guid.Parse(S(call["id"]));
        var (session, room) = factory.WithDb(db => db.CallRooms.IgnoreQueryFilters().Where(c => c.Id == id).Select(c => new { c.AgentSessionId, c.RoomName }).AsEnumerable().Select(c => (c.AgentSessionId!.Value, c.RoomName)).Single());

        // A worker is handed the session with the media server's address and its own pass for that room: nobody has to let it in.
        var poll = await BotWorkerClient.PollAsync(factory, "worker-calls", 2);
        var job = poll.Job(session.ToString());
        Assert.NotNull(job);
        Assert.Equal($"livekit:{room}", S(job!["meetingUrl"]));
        Assert.Equal("wss://calls.test", S(job["liveKitUrl"]));
        var pass = JsonNode.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(Pad(S(job["liveKitToken"]).Split('.')[1]))))!;
        Assert.Equal(CallService.AgentIdentity(session), (string)pass["sub"]!);
        Assert.Equal(room, (string)pass["video"]!["room"]!);

        // Ending the call ends the agent's session, so its notes are written up straight away.
        await owner.Post($"/api/v1/calls/{id}/end");
        Assert.Equal("call_ended", factory.WithDb(db => db.AgentMeetingBots.IgnoreQueryFilters().Single(b => b.Id == session).WorkerStatus));
        Assert.Null((await BotWorkerClient.PollAsync(factory, "worker-calls-2", 2)).Job(session.ToString()));
    }
}
