using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Vectors are stored compactly and pages are cut into pieces at sensible places.</summary>
public class AiSemanticIndexPrimitivesTests
{
    [Fact]
    public void Quantized_vectors_keep_their_direction()
    {
        var a = new float[] { 0.2f, -0.5f, 0.9f, 0.1f };
        var (bytes, scale) = AiSemanticIndex.Quantize(a);
        var back = bytes.Select(b => (sbyte)b * scale).ToArray();
        var unit = (float[])a.Clone(); AiSemanticIndex.Normalize(unit);
        var dot = back.Zip(unit, (x, y) => x * y).Sum();
        Assert.InRange(dot, 0.99, 1.01);
    }

    [Fact]
    public void Long_text_is_cut_into_pieces_each_carrying_the_title()
    {
        var text = string.Join("\n", Enumerable.Range(1, 40).Select(i => $"Paragraph {i}. " + new string('x', 90) + "."));
        var parts = AiSemanticIndex.Split("Handbook", text);
        Assert.InRange(parts.Count, 2, AiSemanticIndex.MaxParts);
        Assert.All(parts, p => Assert.StartsWith("Handbook\n", p));
        Assert.All(parts, p => Assert.True(p.Length <= AiSemanticIndex.MaxChunkChars + 220));
    }
}

public partial class AiWorkspaceTests
{
    private static string Rich(string t) => new JsonObject { ["type"] = "doc", ["content"] = new JsonArray(t.Split('\n').Select(line =>
        (JsonNode)new JsonObject { ["type"] = "paragraph", ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = line }) }).ToArray()) }.ToJsonString();

    private async Task<Guid> PublishedPage(TestClient owner, string title, string body, string classification = "Internal", string visibility = "Organization")
    {
        var type = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "PAGE")!["id"]));
        var created = await owner.Post("/api/v1/documents", new { title, typeId = type, visibility, classification, sections = new[] { new { key = "body", content = Rich(body) } } });
        Assert.True(created.Ok, created.ToString());
        var id = Guid.Parse(S(created.Data!["item"]!["id"]));
        var rev = (await owner.Get($"/api/v1/documents/{id}")).Data!["revision"]!.GetValue<int>();
        Assert.True((await owner.Post($"/api/v1/documents/{id}/publish", new { changeSummary = "First", major = true, revision = rev })).Ok);
        return id;
    }

    private async Task<int> IndexForMeaning()
    {
        using var scope = factory.Services.CreateScope();
        var index = scope.ServiceProvider.GetRequiredService<AiSemanticIndex>();
        var total = 0;
        for (var i = 0; i < 20; i++) { var n = await index.IndexPendingAsync(2000); total += n; if (n == 0) break; }
        return total;
    }

    [Fact]
    public async Task Search_finds_pages_by_meaning_in_any_language_but_only_what_the_reader_may_open_and_never_confidential_pages()
    {
        var o = await Setup();
        var returns = await PublishedPage(o.Owner, "Returns policy", "Customers get their money back within 7 days of purchase.");
        await PublishedPage(o.Owner, "Printer setup guide", "Connect the printer to the office wifi first.");
        var secret = await PublishedPage(o.Owner, "Refund approvals", "Refund over 50000 needs the CFO. Internal margin 12 percent.", classification: "Confidential");
        var mine = await PublishedPage(o.Owner, "Refund exceptions draft", "Money back rules for VIP clients.", visibility: "Private");
        Assert.True(await IndexForMeaning() >= 3);
        Guid[] Pieces() => factory.WithDb(db => db.AiSearchChunks.IgnoreQueryFilters().Where(c => c.SourceId == returns).Select(c => c.Id).OrderBy(x => x).ToArray());
        var first = Pieces();
        Assert.NotEmpty(first);
        await IndexForMeaning();
        Assert.Equal(first, Pieces());   // nothing changed: the same pieces, not embedded again
        Assert.False(factory.WithDb(db => db.AiSearchChunks.IgnoreQueryFilters().Any(c => c.SourceId == secret)));   // confidential pages are not sent to the model

        // "Refund rule" shares no word with "Returns policy", yet finds it; the printer guide is not dragged in.
        var found = await RunTool(o.Owner, AiToolbox.SearchKnowledge, new { query = "What's our refund rule" }, "What's our refund rule?");
        Assert.Contains(returns.ToString(), found);
        Assert.DoesNotContain("Printer setup guide", found);
        Assert.Contains("by meaning", found);
        // The same question in Hindi in Latin letters.
        Assert.Contains(returns.ToString(), await RunTool(o.Owner, AiToolbox.SearchKnowledge, new { query = "refund ka niyam kya hai" }, "refund ka niyam kya hai?"));
        // A private page is found for its owner, and never for anyone else.
        Assert.Contains(mine.ToString(), await RunTool(o.Owner, AiToolbox.SearchKnowledge, new { query = "money back rules" }, "Find the money back rules"));
        Assert.DoesNotContain(mine.ToString(), await RunTool(o.Manager, AiToolbox.SearchKnowledge, new { query = "money back rules" }, "Find the money back rules"));

        // A page deleted later leaves the index.
        Assert.True((await o.Owner.Delete($"/api/v1/documents/{returns}")).Ok);
        await IndexForMeaning();
        Assert.False(factory.WithDb(db => db.AiSearchChunks.IgnoreQueryFilters().Any(c => c.SourceId == returns)));
    }
}
