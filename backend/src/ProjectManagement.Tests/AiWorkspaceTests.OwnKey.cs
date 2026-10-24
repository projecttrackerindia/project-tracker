using System.Net;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>A workspace's own Claude or ChatGPT key: set by an owner or admin, agreed to once by each person, no AI credits used.</summary>
public partial class AiWorkspaceTests
{
    private const string GoodKey = "sk-ant-good-0123456789abcdef";

    [Fact]
    public async Task An_admin_adds_the_workspace_s_own_Claude_key_and_people_agree_once_before_it_answers_them()
    {
        var o = await Setup();
        var own = factory.OwnAi; own.Reset();
        try
        {
            // Only owners and admins see or change it; to start with, Claude's current models are suggested.
            Assert.Equal(HttpStatusCode.Forbidden, (await o.Manager.Get("/api/v1/workspace/ai-provider")).Status);
            var start = (await o.Owner.Get("/api/v1/workspace/ai-provider")).Data!;
            Assert.False(start["configured"]!.GetValue<bool>());
            Assert.Equal("claude-sonnet-5-5", S(start["standardModel"]));

            // A key the provider refuses is said so plainly, and nothing is saved.
            var bad = (await o.Owner.Post("/api/v1/workspace/ai-provider/check", new { provider = "anthropic", apiKey = "sk-ant-bad-0123456789abcdef" })).Data!;
            Assert.False(bad["ok"]!.GetValue<bool>());
            Assert.Contains("refused this key", S(bad["error"]));
            Assert.Equal(422, (int)(await o.Owner.Put("/api/v1/workspace/ai-provider", Body("sk-ant-bad-0123456789abcdef"))).Status);
            // Not an Anthropic key at all.
            Assert.Equal(422, (int)(await o.Owner.Put("/api/v1/workspace/ai-provider", Body("not-a-key-0123456789abcdefgh"))).Status);
            // A model the key cannot use is refused.
            Assert.Equal(422, (int)(await o.Owner.Put("/api/v1/workspace/ai-provider", Body(GoodKey, deep: "claude-mystery-9"))).Status);

            var check = (await o.Owner.Post("/api/v1/workspace/ai-provider/check", new { provider = "anthropic", apiKey = GoodKey })).Data!;
            Assert.True(check["ok"]!.GetValue<bool>());
            Assert.Contains(check["models"]!.AsArray(), m => S(m) == "claude-opus-5-5");

            var saved = await o.Owner.Put("/api/v1/workspace/ai-provider", Body(GoodKey));
            Assert.True(saved.Ok, saved.ToString());
            Assert.Equal("cdef", S(saved.Data!["keyHint"]));
            Assert.DoesNotContain("sk-ant-good", saved.ToString());   // the key itself never comes back
            Assert.Equal(1, saved.Data["version"]!.GetValue<int>());

            // The manager has not agreed yet: the assistant asks them first, and nothing is sent anywhere.
            var status = (await o.Manager.Get("/api/v1/ai/provider-status")).Data!;
            Assert.True(status["active"]!.GetValue<bool>());
            Assert.False(status["agreed"]!.GetValue<bool>());
            Assert.Contains("Anthropic", S(status["notice"]));
            var asked = await Ask(o.Manager, "What is late in Atlas?");
            Assert.Equal(HttpStatusCode.Conflict, asked.Status);
            Assert.Equal("AI_PROVIDER_CONSENT", asked.Error!.ErrorCode);
            Assert.Empty(own.Used);

            // Once they agree, they are answered on the organization's own account, and no AI credits are used.
            var before = await CreditsUsed(o.Manager);
            Assert.True((await o.Manager.Post("/api/v1/ai/provider-consent")).Ok);
            own.Chat.Script.Enqueue(_ => FakeAiChat.Say("Two tasks are late in Atlas."));
            var answer = await Ask(o.Manager, "What is late in Atlas?");
            Assert.Equal(HttpStatusCode.OK, answer.Status);
            Assert.Contains("Two tasks are late", answer.Text);
            Assert.Single(own.Used.Where(k => k.StandardModel == "claude-sonnet-5-5"));
            Assert.Equal(before, await CreditsUsed(o.Manager));
            Assert.Equal(1, (await o.Owner.Get("/api/v1/workspace/ai-provider")).Data!["peopleAgreed"]!.GetValue<int>());

            // When the key fails and the organization chose not to fall back, the person is told why - and it is kept for the admins.
            own.Chat.Fail = new AppException(402, "AI_CREDIT_EXHAUSTED", "Anthropic says the account has no credit left.");
            var failed = await Ask(o.Manager, "And in Orion?");
            Assert.Contains(failed.All("error"), e => S(e["code"]) == "AI_WORKSPACE_KEY_FAILED" && S(e["message"]).Contains("no credit left"));
            Assert.Contains("no credit left", S((await o.Owner.Get("/api/v1/workspace/ai-provider")).Data!["lastError"]));
            own.Chat.Fail = null;

            // A new key means a new agreement; withdrawing goes back to asking.
            Assert.True((await o.Owner.Put("/api/v1/workspace/ai-provider", Body("sk-ant-good-ffffffffffffffff"))).Ok);
            Assert.False((await o.Manager.Get("/api/v1/ai/provider-status")).Data!["agreed"]!.GetValue<bool>());
            Assert.True((await o.Manager.Post("/api/v1/ai/provider-consent")).Ok);
            Assert.True((await o.Manager.Delete("/api/v1/ai/provider-consent")).Ok);
            Assert.False((await o.Manager.Get("/api/v1/ai/provider-status")).Data!["agreed"]!.GetValue<bool>());

            // Removing it returns everyone to Project Tracker's own AI; nobody is asked any more.
            Assert.Equal(HttpStatusCode.NoContent, (await o.Owner.Delete("/api/v1/workspace/ai-provider")).Status);
            Assert.False((await o.Manager.Get("/api/v1/ai/provider-status")).Data!["active"]!.GetValue<bool>());
            Chat.Script.Enqueue(_ => FakeAiChat.Say("Answered by Project Tracker's AI."));
            Assert.Contains("Project Tracker's AI", (await Ask(o.Manager, "What is late in Atlas?")).Text);
        }
        finally { own.Reset(); }

        static object Body(string key, string deep = "claude-opus-5-5") => new
        {
            provider = "anthropic", apiKey = key, quickModel = "claude-haiku-5-5", standardModel = "claude-sonnet-5-5", deepModel = deep, enabled = true, fallbackToPlatform = false,
        };
    }
}
