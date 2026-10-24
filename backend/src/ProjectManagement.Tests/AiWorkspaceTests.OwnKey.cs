using System.Net;
using Microsoft.EntityFrameworkCore;
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

    [Fact]
    public async Task An_answer_on_the_organization_s_own_key_is_saved_and_each_of_its_suggestions_can_be_confirmed()
    {
        // Answers on the organization's own key hold no AI credits. The answer (and its cards) must still be saved, or Confirm cannot find them.
        var o = await Setup();
        var own = factory.OwnAi; own.Reset();
        try
        {
            Assert.True((await o.Owner.Put("/api/v1/workspace/ai-provider", new { provider = "anthropic", apiKey = GoodKey, quickModel = "claude-haiku-5-5",
                standardModel = "claude-sonnet-5-5", deepModel = "claude-opus-5-5", enabled = true, fallbackToPlatform = false })).Ok);
            Assert.True((await o.Owner.Post("/api/v1/ai/provider-consent")).Ok);
            own.Chat.Script.Enqueue(_ => FakeAiChat.UseTool("propose_create_action_item", new { project = "Atlas", title = "Share the server logs", assignee = "me", due_date = Iso(3) }, id: "toolu_a"));
            own.Chat.Script.Enqueue(_ => FakeAiChat.UseTool("propose_create_action_item", new { project = "Atlas", title = "Check why no alert was sent", assignee = "me", due_date = Iso(4) }, id: "toolu_b"));
            own.Chat.Script.Enqueue(_ => FakeAiChat.Say("Both are ready for you to confirm."));
            var res = await Ask(o.Owner, "Prepare two action items in Atlas for me to confirm: share the server logs, and check why no alert was sent");
            Assert.Equal(HttpStatusCode.OK, res.Status);
            var cards = res.All("action").Select(e => e["action"]!).ToList();
            Assert.Equal(2, cards.Count);

            // The answer is in the history with its real time, and both cards are on it.
            var messageId = S(res.Done["id"]);
            Assert.True(DateTime.Parse(S(res.Done["createdAt"])).Year >= 2020, "the saved answer carries its real time");
            Assert.NotNull(factory.WithDb(db => db.AiMessages.IgnoreQueryFilters().Where(m => m.Id == Guid.Parse(messageId)).Select(m => m.ActionsJson).Single()));

            foreach (var card in cards)
            {
                var confirm = await o.Owner.Post($"/api/v1/ai/messages/{messageId}/actions/{S(card["id"])}/confirm");
                Assert.True(confirm.Ok, confirm.ToString());
                Assert.Equal("done", S(confirm.Data!["status"]));
            }
            Assert.Equal(2, factory.WithDb(db => db.WorkTasks.IgnoreQueryFilters().Count(a => a.RelatedProjectId == o.Project
                && (a.Title == "Share the server logs" || a.Title == "Check why no alert was sent"))));
        }
        finally { own.Reset(); }
    }
}
