using System.Net;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public sealed class AiControlCentreTests(ApiFactory factory)
{
    private static string LevelOf(ApiResult r, string agent)
    {
        foreach (var a in r.Data!["agents"]!.AsArray()) if (a!["id"]!.GetValue<string>() == agent) return a["level"]!.GetValue<string>();
        throw new InvalidOperationException($"No agent {agent}");
    }

    [Fact]
    public async Task Agents_start_on_their_defaults_and_only_owners_and_admins_change_them()
    {
        var owner = await TestClient.RegisterAsync(factory); await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
        var admin = await owner.AddMemberAsync(factory, TenantRole.Admin, "Admin");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member);

        var start = await owner.Get("/api/v1/ai/control"); start.CheckStatus(HttpStatusCode.OK);
        Assert.Equal(5, start.Data!["agents"]!.AsArray().Count);
        // Each default keeps the agent doing what it did before the control centre (see AiControlCentre.Agents).
        Assert.Equal("askFirst", LevelOf(start, "project"));
        Assert.Equal("askFirst", LevelOf(start, "notetaker"));
        Assert.Equal("suggest", LevelOf(start, "mail"));
        Assert.Equal("suggest", LevelOf(start, "triage"));
        Assert.Equal("suggest", LevelOf(start, "timesheet"));
        Assert.Equal(4000, start.Data["contextLimit"]!.GetValue<int>());
        Assert.True(start.Data["canEdit"]!.GetValue<bool>());

        // Everyone may read the levels (features respect them), only owners and admins change them.
        var seen = await member.Get("/api/v1/ai/control"); seen.CheckStatus(HttpStatusCode.OK);
        Assert.False(seen.Data!["canEdit"]!.GetValue<bool>());
        (await member.Put("/api/v1/ai/control/agents/triage", new { level = "auto" })).CheckStatus(HttpStatusCode.Forbidden);

        var set = await admin.Put("/api/v1/ai/control/agents/triage", new { level = "auto" }); set.CheckStatus(HttpStatusCode.OK);
        Assert.Equal("auto", LevelOf(set, "triage"));
        Assert.Equal("auto", LevelOf(await member.Get("/api/v1/ai/control"), "triage"));
        (await owner.Put("/api/v1/ai/control/agents/mail", new { level = "Ask first" })).CheckStatus(HttpStatusCode.OK);
        (await owner.Put("/api/v1/ai/control/agents/timesheet", new { level = "off" })).CheckStatus(HttpStatusCode.OK);
        var after = await owner.Get("/api/v1/ai/control");
        Assert.Equal("askFirst", LevelOf(after, "mail"));
        Assert.Equal("off", LevelOf(after, "timesheet"));
        Assert.Equal("auto", LevelOf(after, "triage"));

        (await owner.Put("/api/v1/ai/control/agents/triage", new { level = "sometimes" })).CheckStatus(HttpStatusCode.UnprocessableEntity);
        (await owner.Put("/api/v1/ai/control/agents/robot", new { level = "auto" })).CheckStatus(HttpStatusCode.NotFound);

        // Another workspace keeps its own levels.
        var other = await TestClient.RegisterAsync(factory); await other.CreateOrgAsync();
        Assert.Equal("suggest", LevelOf(await other.Get("/api/v1/ai/control"), "triage"));
    }

    [Fact]
    public async Task Drafting_the_context_reads_the_workspace_and_saves_nothing()
    {
        var owner = await TestClient.RegisterAsync(factory); await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member);
        await owner.CreateProjectAsync("Razor pay rollout");

        (await member.Post("/api/v1/ai/control/context/draft")).CheckStatus(HttpStatusCode.Forbidden);
        var draft = await owner.Post("/api/v1/ai/control/context/draft"); draft.CheckStatus(HttpStatusCode.OK);
        var text = draft.Data!["text"]!.GetValue<string>();
        Assert.StartsWith("We are ", text);
        Assert.Contains("Razor pay rollout", text);
        Assert.True(text.Length <= 4000);
        Assert.Equal(0, (await owner.Get("/api/v1/ai/control")).Data!["contextLength"]!.GetValue<int>());
    }

    [Fact]
    public void Stored_levels_fall_back_to_defaults_when_unreadable()
    {
        Assert.Equal(AiAgentLevel.AskFirst, AiControlCentre.Parse(null)["project"]);
        Assert.Equal(AiAgentLevel.AskFirst, AiControlCentre.Parse("not json")["project"]);
        Assert.Equal(AiAgentLevel.Suggest, AiControlCentre.Parse(null)["mail"]);
        Assert.Equal(AiAgentLevel.AskFirst, AiControlCentre.Parse("{\"notetaker\":99}")["notetaker"]);
        Assert.Equal(AiAgentLevel.Off, AiControlCentre.Parse("{\"project\":0,\"unknown\":3}")["project"]);
        Assert.False(AiControlCentre.Parse("{\"unknown\":3}").ContainsKey("unknown"));
    }
}
