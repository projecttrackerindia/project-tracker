using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Library pages with their own look and motion: a page's CSS checked on the server (imports, addresses, scripts, fixed overlays and escapes are
/// refused, 20 KB at most), the style kept with the text and changed only on purpose, motion blocks cleaned (SVG allow-list, embed size limits),
/// the workspace switches for custom CSS and interactive embeds, and the audit trail (document.style_changed, document.embed_added).
/// </summary>
[Collection("api")]
public class DocumentMotionTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    // ------------------------------------------------------------------ the CSS check

    [Theory]
    [InlineData("@import url(https://evil.example/x.css);")]
    [InlineData("@import \"x.css\";")]
    [InlineData("p { background: url(https://evil.example/track.png) }")]
    [InlineData("p { background: url('//evil.example/a.png') }")]
    [InlineData("p { background-image: image-set(\"x.png\" 1x) }")]
    [InlineData("p { width: expression(alert(1)) }")]
    [InlineData("p { behavior: url(x.htc) }")]
    [InlineData("p { -moz-binding: url(x.xml#a) }")]
    [InlineData("a { background: url(javascript:alert(1)) }")]
    [InlineData("@font-face { font-family: x; src: url(https://evil.example/f.woff) }")]
    [InlineData("p::before { content: url(data:image/png;base64,AAAA) }")]
    [InlineData("p { color: re\\64 }")]
    [InlineData("</style><script>alert(1)</script>")]
    [InlineData(".x { position: fixed; inset: 0 }")]
    [InlineData(".x { position: sticky; top: 0 }")]
    [InlineData(".x { z-index: 9999 }")]
    [InlineData("+ .sidebar { display: none }")]
    [InlineData("~ * { display: none }")]
    [InlineData(".x :root { color: red }")]
    [InlineData(":host { color: red }")]
    [InlineData("p { color: red }}")]
    [InlineData("p { color: red")]
    [InlineData("p { color: red; .x { color: blue } }")]
    [InlineData("/* never closed")]
    [InlineData("@media (prefers-color-scheme: dark) and (min-width: 1px) { p { color: red } }")]
    public void Malicious_or_broken_css_is_refused(string css) => Assert.NotEmpty(PageCss.Check(css));

    [Theory]
    [InlineData("h2 { color: #4f46e5 } .note, p > em { font-weight: 600 }")]
    [InlineData(":root { --accent: #4f46e5 } @media (prefers-color-scheme: dark) { :root { --accent: #a5b4fc } }")]
    [InlineData("@keyframes pulse { from { opacity: .4 } to { opacity: 1 } } .x { animation: pulse 2s infinite; position: relative; z-index: 10 }")]
    [InlineData("p { background: url(\"data:image/png;base64,iVBORw0KGgo=\") no-repeat } @media (max-width: 600px) { h2 { font-size: 20px } }")]
    [InlineData("/* a comment */ body p { margin: 0 }")]
    [InlineData("")]
    public void Ordinary_css_passes(string css) => Assert.Empty(PageCss.Check(css));

    [Fact]
    public void Css_is_limited_to_20_kb_and_reports_lines()
    {
        Assert.Contains("20 KB", Assert.Single(PageCss.Check(new string('x', 20_001))));
        Assert.StartsWith("Line 3:", PageCss.Check("h1 { color: red }\n\np { position: fixed }")[0]);
        Assert.NotEmpty(PageCss.Check($"p {{ background: url(data:image/png;base64,{new string('A', 13_000)}) }}"));
    }

    [Fact]
    public void A_style_is_refused_with_css_when_the_workspace_turned_custom_css_off()
    {
        var withCss = new PageStyleDto("editorial", "h2 { color: red }", true, "line");
        Assert.Throws<ValidationException>(() => MotionContent.CleanStyle(withCss, cssAllowed: false));
        Assert.NotNull(MotionContent.CleanStyle(withCss with { Css = "" }, cssAllowed: false));
        Assert.Null(MotionContent.CleanStyle(new PageStyleDto("default", "", false, "none"), cssAllowed: true));
        Assert.Throws<ValidationException>(() => MotionContent.CleanStyle(new PageStyleDto("neon", "", false, "none"), cssAllowed: true));
    }

    // ------------------------------------------------------------------ SVG and motion blocks

    [Fact]
    public void Svg_is_rebuilt_from_an_allow_list()
    {
        var svg = MotionSvg.Clean("<svg viewBox=\"0 0 10 10\" onload=\"alert(1)\"><script>alert(1)</script><foreignObject><iframe src=\"https://evil.example\"></iframe></foreignObject>"
            + "<circle cx=\"5\" r=\"4\" onclick=\"x()\"><animate attributeName=\"r\" values=\"2;4;2\" dur=\"1s\"/></circle><use href=\"https://evil.example/a.svg#x\"/><use xlink:href=\"#ok\"/>"
            + "<set attributeName=\"href\" to=\"javascript:alert(1)\"/><rect style=\"fill:url(https://evil.example/p.png)\"/><style>@import url(https://evil.example/x.css);</style></svg>")!;
        Assert.Contains("<circle cx=\"5\" r=\"4\">", svg);
        Assert.Contains("<animate attributeName=\"r\"", svg);
        Assert.Contains("xlink:href=\"#ok\"", svg);
        Assert.DoesNotContain("script", svg, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("onload", svg);
        Assert.DoesNotContain("onclick", svg);
        Assert.DoesNotContain("evil", svg);
        Assert.DoesNotContain("foreignObject", svg);
        Assert.DoesNotContain("javascript", svg);
        Assert.Null(MotionSvg.Clean("<html><script>alert(1)</script></html>"));
        Assert.Null(MotionSvg.Clean("<svg>" + string.Concat(Enumerable.Repeat("<g></g>", 30_000)) + "</svg>"));
    }

    [Fact]
    public void Motion_blocks_keep_only_known_fields_and_this_documents_files()
    {
        var mine = Guid.NewGuid(); var theirs = Guid.NewGuid();
        var body = new JsonObject
        {
            ["type"] = "doc",
            ["attrs"] = new JsonObject { ["pageStyle"] = new JsonObject { ["preset"] = "product", ["css"] = "@import url(x)" } },
            ["content"] = new JsonArray(
                new JsonObject { ["type"] = "paragraph", ["attrs"] = new JsonObject { ["motion"] = "rise", ["motionDelay"] = 200, ["motionDuration"] = 9999, ["onclick"] = "x" } },
                new JsonObject { ["type"] = "heading", ["attrs"] = new JsonObject { ["level"] = 2, ["motion"] = "explode" } },
                new JsonObject { ["type"] = "motionLottie", ["attrs"] = new JsonObject { ["fileId"] = mine.ToString(), ["caption"] = "Flow", ["height"] = 5000, ["src"] = "https://evil.example" } },
                new JsonObject { ["type"] = "motionLottie", ["attrs"] = new JsonObject { ["fileId"] = theirs.ToString() } },
                new JsonObject { ["type"] = "motionVideo", ["attrs"] = new JsonObject { ["fileId"] = mine.ToString(), ["autoplay"] = true } },
                new JsonObject { ["type"] = "motionSvg", ["attrs"] = new JsonObject { ["svg"] = "<svg><script>alert(1)</script><rect width=\"2\"/></svg>" } },
                new JsonObject { ["type"] = "sandboxEmbed", ["attrs"] = new JsonObject { ["html"] = "<b>hi</b>", ["js"] = "1+1", ["height"] = 10 } })
        }.ToJsonString();
        var clean = JsonNode.Parse(SectionContent.NormalizeRichText(body, images: new HashSet<Guid>(), media: new HashSet<Guid> { mine }))!.AsObject();
        Assert.Null(clean["attrs"]);   // a style only ever comes from the style endpoint
        var blocks = clean["content"]!.AsArray();
        Assert.Equal(6, blocks.Count);   // the Lottie of another document's file is dropped
        Assert.Equal("rise", S(blocks[0]!["attrs"]!["motion"]));
        Assert.Equal(200, blocks[0]!["attrs"]!["motionDelay"]!.GetValue<int>());
        Assert.Equal(400, blocks[0]!["attrs"]!["motionDuration"]!.GetValue<int>());
        Assert.Null(blocks[0]!["attrs"]!["onclick"]);
        Assert.Null(blocks[1]!["attrs"]!["motion"]);
        Assert.Equal(1200, blocks[2]!["attrs"]!["height"]!.GetValue<int>());
        Assert.Null(blocks[2]!["attrs"]!["src"]);
        Assert.Equal("<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"2\"/></svg>", S(blocks[4]!["attrs"]!["svg"]));
        Assert.Equal(80, blocks[5]!["attrs"]!["height"]!.GetValue<int>());

        var huge = new JsonObject { ["type"] = "doc", ["content"] = new JsonArray(new JsonObject { ["type"] = "sandboxEmbed", ["attrs"] = new JsonObject { ["js"] = new string('x', 40_001) } }) }.ToJsonString();
        Assert.Throws<ValidationException>(() => SectionContent.NormalizeRichText(huge));

        Assert.Equal("[Interactive embed - open online] Demo", DocumentDiff.MotionStill(new JsonObject { ["type"] = "sandboxEmbed", ["attrs"] = new JsonObject { ["caption"] = "Demo" } }));
        Assert.Contains(DocumentDiff.TextLines(clean.ToJsonString()), l => l.Text.StartsWith("[video]"));
    }

    [Fact]
    public void An_ai_edit_keeps_motion_blocks_and_block_motion()
    {
        var before = """{"type":"doc","content":[{"type":"heading","attrs":{"level":2,"motion":"fade","motionDelay":0,"motionDuration":400},"content":[{"type":"text","text":"Plan"}]},{"type":"sandboxEmbed","attrs":{"html":"<b>a</b>","caption":"Demo"}},{"type":"paragraph","content":[{"type":"text","text":"Old"}]},{"type":"motionVideo","attrs":{"caption":"Tour"}}]}""";
        Assert.Equal(new List<string> { "Plan", "[[keep:1]] [Interactive embed - open online] Demo", "Old", "[[keep:2]] [video] Tour" }, MotionContent.LinesForAi(before));
        // The model kept the second placeholder (moved first), dropped the first, and left a stray mark in a sentence.
        var after = """{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"[[keep:2]] [video] Tour"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"New plan"}]},{"type":"paragraph","content":[{"type":"text","text":"New [[keep:9]] text"}]}]}""";
        var kept = JsonNode.Parse(MotionContent.KeepBlocks(before, after))!["content"]!.AsArray();
        // The dropped embed goes back to its old place (second); the heading keeps its fade.
        Assert.Equal(new[] { "motionVideo", "sandboxEmbed", "heading", "paragraph" }, kept.Select(b => S(b!["type"])).ToArray());
        Assert.Equal("fade", S(kept[2]!["attrs"]!["motion"]));
        Assert.Equal("<b>a</b>", S(kept[1]!["attrs"]!["html"]));
        Assert.Equal("New  text", S(kept[3]!["content"]![0]!["text"]));
    }

    // ------------------------------------------------------------------ through the API

    private async Task<(TestClient Owner, Guid Page, int Revision)> Page(string body = """{"type":"doc","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Overview"}]},{"type":"paragraph","content":[{"type":"text","text":"Welcome."}]}]}""")
    {
        var owner = await TestClient.RegisterAsync(factory, "Mira Motion");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var type = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "PAGE")!["id"]));
        var made = await owner.Post("/api/v1/documents", new { title = "Onboarding tour", typeId = type, sections = new[] { new { key = "body", content = body } } });
        Assert.Equal(HttpStatusCode.Created, made.Status);
        return (owner, Guid.Parse(S(made.Data!["item"]!["id"])), made.Data["revision"]!.GetValue<int>());
    }

    private static JsonObject Body(ApiResult r) => JsonNode.Parse(S(r.Data!["sections"]![0]!["content"]))!.AsObject();

    [Fact]
    public async Task A_page_style_is_checked_kept_with_the_text_and_audited()
    {
        var (owner, page, rev) = await Page();
        var bad = await owner.Put($"/api/v1/documents/{page}/style", new { revision = rev, style = new { preset = "product", css = ".x { position: fixed } @import url(https://evil.example/x.css);", animateSections = true, sectionTransition = "line" } });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, bad.Status);
        var tooBig = await owner.Put($"/api/v1/documents/{page}/style", new { revision = rev, style = new { preset = "product", css = "h2{color:red}" + new string(' ', 20_000), animateSections = false, sectionTransition = "none" } });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, tooBig.Status);

        var ok = await owner.Put($"/api/v1/documents/{page}/style", new { revision = rev, style = new { preset = "editorial", css = "h2 { color: var(--accent) } :root { --accent: #4f46e5 }", animateSections = true, sectionTransition = "line" } });
        Assert.True(ok.Ok, ok.ToString());
        var style = Body(ok)["attrs"]!["pageStyle"]!;
        Assert.Equal("editorial", S(style["preset"]));
        Assert.True(style["animateSections"]!.GetValue<bool>());

        // Saving the text keeps the style; a style sent with the text is ignored.
        var rev2 = ok.Data!["revision"]!.GetValue<int>();
        var text = """{"type":"doc","attrs":{"pageStyle":{"preset":"dark-hero","css":"@import url(x)"}},"content":[{"type":"paragraph","attrs":{"motion":"rise"},"content":[{"type":"text","text":"Edited."}]}]}""";
        var saved = await owner.Put($"/api/v1/documents/{page}/sections", new { revision = rev2, sections = new[] { new { key = "body", content = text } } });
        Assert.True(saved.Ok, saved.ToString());
        var body = Body(saved);
        Assert.Equal("editorial", S(body["attrs"]!["pageStyle"]!["preset"]));
        Assert.Equal("rise", S(body["content"]![0]!["attrs"]!["motion"]));

        // Back to the default look takes the style off.
        var cleared = await owner.Put($"/api/v1/documents/{page}/style", new { revision = saved.Data!["revision"]!.GetValue<int>(), style = new { preset = "default", css = "", animateSections = false, sectionTransition = "none" } });
        Assert.True(cleared.Ok, cleared.ToString());
        Assert.Null(Body(cleared)["attrs"]);

        var actions = factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Where(a => a.EntityId == page).Select(a => a.Action).ToList());
        Assert.Equal(2, actions.Count(a => a == "document.style_changed"));
    }

    [Fact]
    public async Task Readers_cannot_change_a_style_and_only_admins_change_the_workspace_switches()
    {
        var (owner, page, rev) = await Page();
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Rafi Reader");
        Assert.True((await member.Get("/api/v1/documents/library-design")).Ok);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Put("/api/v1/documents/library-design", new { customCss = false, sandboxEmbeds = false })).Status);
        var attempt = await member.Put($"/api/v1/documents/{page}/style", new { revision = rev, style = new { preset = "editorial", css = "", animateSections = false, sectionTransition = "none" } });
        Assert.True(attempt.Status is HttpStatusCode.Forbidden or HttpStatusCode.NotFound, attempt.ToString());
    }

    [Fact]
    public async Task A_workspace_can_turn_off_custom_css_and_interactive_embeds()
    {
        var (owner, page, rev) = await Page();
        var on = (await owner.Get("/api/v1/documents/library-design")).Data!;
        Assert.True(on["customCss"]!.GetValue<bool>());
        Assert.True(on["sandboxEmbeds"]!.GetValue<bool>());

        // Adding an embed is recorded.
        var embed = """{"type":"doc","content":[{"type":"sandboxEmbed","attrs":{"html":"<button>Try</button>","js":"1","height":240}}]}""";
        var added = await owner.Put($"/api/v1/documents/{page}/sections", new { revision = rev, sections = new[] { new { key = "body", content = embed } } });
        Assert.True(added.Ok, added.ToString());
        Assert.True(factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Any(a => a.EntityId == page && a.Action == "document.embed_added")));

        var off = await owner.Put("/api/v1/documents/library-design", new { customCss = false, sandboxEmbeds = false });
        Assert.True(off.Ok, off.ToString());
        Assert.False(off.Data!["customCss"]!.GetValue<bool>());
        rev = added.Data!["revision"]!.GetValue<int>();

        var css = await owner.Put($"/api/v1/documents/{page}/style", new { revision = rev, style = new { preset = "minimal", css = "h2 { color: red }", animateSections = false, sectionTransition = "none" } });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, css.Status);
        var preset = await owner.Put($"/api/v1/documents/{page}/style", new { revision = rev, style = new { preset = "minimal", css = "", animateSections = true, sectionTransition = "none" } });
        Assert.True(preset.Ok, preset.ToString());   // presets and motion still work
        rev = preset.Data!["revision"]!.GetValue<int>();

        // The embed already there stays; a new one is refused.
        var keep = await owner.Put($"/api/v1/documents/{page}/sections", new { revision = rev, sections = new[] { new { key = "body", content = embed } } });
        Assert.True(keep.Ok, keep.ToString());
        var two = """{"type":"doc","content":[{"type":"sandboxEmbed","attrs":{"html":"a"}},{"type":"sandboxEmbed","attrs":{"html":"b"}}]}""";
        var more = await owner.Put($"/api/v1/documents/{page}/sections", new { revision = keep.Data!["revision"]!.GetValue<int>(), sections = new[] { new { key = "body", content = two } } });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, more.Status);
        Assert.True(factory.WithDb(db => db.AuditLogs.IgnoreQueryFilters().Any(a => a.Action == "document.design_settings_changed")));
    }
}
