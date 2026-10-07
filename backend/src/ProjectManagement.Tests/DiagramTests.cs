using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.Reports;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Diagrams written as text: parsing, layout, one drawing for screen and PDF (release D6).</summary>
[Collection("api")]
public class DiagramTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    [Fact]
    public void Boxes_shapes_arrows_and_labels_are_read()
    {
        var m = DiagramEngine.Draw("""
            flowchart LR
              %% a comment
              A[Start] --> B{Is it valid?}
              B -->|yes| C(Save it)
              B -- no --> D((Stop))
              C -.-> E[Notify]; D ==> E
              E --- F["Done: all good"]
            """);
        Assert.Equal(["A", "B", "C", "D", "E", "F"], m.Nodes.Select(n => n.Id));
        Assert.Equal("diamond", m.Nodes.Single(n => n.Id == "B").Shape);
        Assert.Equal("round", m.Nodes.Single(n => n.Id == "C").Shape);
        Assert.Equal("circle", m.Nodes.Single(n => n.Id == "D").Shape);
        Assert.Equal("Done: all good", m.Nodes.Single(n => n.Id == "F").Text);
        Assert.Equal(6, m.Edges.Count);
        Assert.Equal("yes", m.Edges.Single(e => e.From == "B" && e.To == "C").Label);
        Assert.Equal("no", m.Edges.Single(e => e.From == "B" && e.To == "D").Label);
        Assert.Equal("dotted", m.Edges.Single(e => e.From == "C" && e.To == "E").Style);
        Assert.Equal("thick", m.Edges.Single(e => e.From == "D" && e.To == "E").Style);
        Assert.False(m.Edges.Single(e => e.From == "E" && e.To == "F").Arrow);
    }

    [Theory]
    [InlineData("", "empty")]
    [InlineData("sequenceDiagram\n A->>B: hi", "Only flowcharts")]
    [InlineData("flowchart XX\n A-->B", "direction")]
    [InlineData("flowchart TD\n A[open --> B", "not closed")]
    [InlineData("flowchart TD\n A --> ", "box")]
    [InlineData("flowchart TD\n A -> B", "arrow")]
    [InlineData("flowchart TD\n A -->|label B", "second |")]
    public void Mistakes_are_reported_in_plain_words(string source, string contains)
    {
        var e = Assert.Throws<DiagramException>(() => DiagramEngine.Draw(source));
        Assert.Contains(contains, e.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void The_size_is_limited()
    {
        var big = "flowchart TD\n" + string.Join('\n', Enumerable.Range(0, 301).Select(i => $"N{i}"));
        Assert.Contains("300", Assert.Throws<DiagramException>(() => DiagramEngine.Draw(big)).Message);
        Assert.Throws<DiagramException>(() => DiagramEngine.Draw("flowchart TD\n" + new string('x', 21_000)));
    }

    [Theory]
    [InlineData("TD")] [InlineData("LR")] [InlineData("BT")] [InlineData("RL")]
    public void No_two_boxes_overlap_and_arrows_start_and_end_on_their_boxes(string dir)
    {
        var m = DiagramEngine.Draw($$"""
            flowchart {{dir}}
              A[Request] --> B{Valid?}
              B -->|yes| C[Process]
              B -->|no| D[Reject]
              C --> E[Notify user]
              D --> E
              A --> E
              E --> A
              C --> F[(Archive)]
              F --> G((End))
            """);
        for (var i = 0; i < m.Nodes.Count; i++)
            for (var j = i + 1; j < m.Nodes.Count; j++)
            {
                var a = m.Nodes[i]; var b = m.Nodes[j];
                var overlap = a.X < b.X + b.W && b.X < a.X + a.W && a.Y < b.Y + b.H && b.Y < a.Y + a.H;
                Assert.False(overlap, $"{a.Id} overlaps {b.Id} ({dir})");
            }
        Assert.All(m.Nodes, n => { Assert.True(n.X >= 0 && n.Y >= 0 && n.X + n.W <= m.Width + 0.5 && n.Y + n.H <= m.Height + 0.5, $"{n.Id} is outside the picture"); });
        foreach (var e in m.Edges)
        {
            var a = m.Nodes.Single(n => n.Id == e.From); var b = m.Nodes.Single(n => n.Id == e.To);
            bool Near(DiagramNode n, (double X, double Y) p) => p.X >= n.X - 1.5 && p.X <= n.X + n.W + 1.5 && p.Y >= n.Y - 1.5 && p.Y <= n.Y + n.H + 1.5;
            Assert.True(e.From == e.To || Near(a, e.Points[0]), $"{e.From}->{e.To} does not start on its box ({dir})");
            Assert.True(e.From == e.To || Near(b, e.Points[^1]), $"{e.From}->{e.To} does not end on its box ({dir})");
        }
    }

    [Fact]
    public void Flow_follows_the_direction_chosen()
    {
        double X(DiagramModel m, string id) => m.Nodes.Single(n => n.Id == id).X;
        double Y(DiagramModel m, string id) => m.Nodes.Single(n => n.Id == id).Y;
        var lr = DiagramEngine.Draw("flowchart LR\n A --> B --> C"); var rl = DiagramEngine.Draw("flowchart RL\n A --> B --> C");
        var td = DiagramEngine.Draw("flowchart TD\n A --> B --> C"); var bt = DiagramEngine.Draw("flowchart BT\n A --> B --> C");
        Assert.True(X(lr, "A") < X(lr, "B") && X(lr, "B") < X(lr, "C"));
        Assert.True(X(rl, "A") > X(rl, "B") && X(rl, "B") > X(rl, "C"));
        Assert.True(Y(td, "A") < Y(td, "B") && Y(td, "B") < Y(td, "C"));
        Assert.True(Y(bt, "A") > Y(bt, "B") && Y(bt, "B") > Y(bt, "C"));
    }

    [Fact]
    public void Two_hundred_boxes_are_drawn_quickly_and_the_same_way_every_time()
    {
        var sb = new StringBuilder("flowchart TD\n");
        var rnd = new Random(3);
        for (var i = 1; i < 200; i++) sb.Append($"  N{rnd.Next(Math.Max(0, i - 8), i)}[Step {i}] --> N{i}[Step {i}]\n");
        for (var i = 0; i < 40; i++) sb.Append($"  N{rnd.Next(200)} -.-> N{rnd.Next(200)}\n");
        var sw = Stopwatch.StartNew();
        var a = DiagramEngine.Draw(sb.ToString());
        sw.Stop();
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(5), $"took {sw.Elapsed}");
        Assert.Equal(200, a.Nodes.Count);
        Assert.Equal(DiagramEngine.ToSvg(a), DiagramEngine.ToSvg(DiagramEngine.Draw(sb.ToString())));
    }

    [Fact]
    public void Text_cannot_break_out_of_the_picture()
    {
        var svg = DiagramEngine.ToSvg(DiagramEngine.Draw("flowchart TD\n A[\"<script>alert(1)</script>\"] -->|\"<img src=x onerror=alert(2)>\"| B[ok]"));
        Assert.DoesNotContain("<script", svg, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("<img", svg, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("&lt;script&gt;", svg);
        var doc = new System.Xml.XmlDocument(); doc.LoadXml(svg);   // still well-formed XML
    }

    [Fact]
    public void The_screen_and_the_pdf_are_drawn_from_the_same_layout()
    {
        var m = DiagramEngine.Draw("flowchart LR\n A[Order received] -->|paid| B{In stock?}\n B -->|yes| C[Ship]\n B -->|no| D[Back-order]");
        var svg = DiagramEngine.ToSvg(m);
        var pdf = DiagramEngine.ToPdf(m, 0, 800, 1.0);
        foreach (var text in m.Nodes.Select(n => n.Text).Concat(m.Edges.Select(e => e.Label!)))
        {
            Assert.Contains(text, svg);
            Assert.Contains($"({text}) Tj", pdf);
        }
        // every box has the same position and size in both (the PDF y axis points up)
        foreach (var n in m.Nodes.Where(n => n.Shape == "rect"))
        {
            Assert.Contains($"x=\"{n.X.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture)}\" y=\"{n.Y.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture)}\"", svg);
            Assert.Contains($"{n.X.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture)} {(800 - n.Y - n.H).ToString("0.##", System.Globalization.CultureInfo.InvariantCulture)} {n.W.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture)} {n.H.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture)} re B", pdf);
        }
    }

    [Fact]
    public async Task The_service_draws_a_diagram_and_explains_a_mistake()
    {
        var owner = await TestClient.RegisterAsync(factory, "Dana");
        await owner.CreateOrgAsync();
        var ok = await owner.Post("/api/v1/documents/diagrams/render", new { source = "flowchart TD\n A[Go] --> B[Stop]" });
        Assert.True(ok.Ok, ok.ToString());
        Assert.StartsWith("<svg", S(ok.Data!["svg"]));
        Assert.Equal(2, ok.Data["nodes"]!.GetValue<int>());
        var bad = await owner.Post("/api/v1/documents/diagrams/render", new { source = "flowchart TD\n A -> B" });
        Assert.Equal((HttpStatusCode)422, bad.Status);
        Assert.Contains("Line 2", bad.ToString());
        Assert.Equal(HttpStatusCode.Unauthorized, (await new TestClient(factory).Post("/api/v1/documents/diagrams/render", new { source = "flowchart TD\n A-->B" })).Status);
    }

    [Fact]
    public async Task A_diagram_in_a_document_is_printed_as_a_drawing_in_its_pdf()
    {
        var owner = await TestClient.RegisterAsync(factory, "Dana");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS", 5);
        var brd = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "BRD")!["id"]));
        var doc = Guid.Parse(S((await owner.Post("/api/v1/documents", new { title = "Flow doc", typeId = brd })).Data!["item"]!["id"]));
        var rev = (await owner.Get($"/api/v1/documents/{doc}")).Data!["revision"]!.GetValue<int>();
        var content = """{"type":"doc","content":[{"type":"codeBlock","attrs":{"language":"mermaid"},"content":[{"type":"text","text":"flowchart LR\n  A[Draft] --> B{Reviewed?}\n  B -->|yes| C[Publish]"}]},{"type":"codeBlock","attrs":{"language":"mermaid"},"content":[{"type":"text","text":"flowchart TD\n  X -> Y"}]}]}""";
        var key = (await owner.Get($"/api/v1/documents/{doc}")).Data!["sections"]![0]!["key"]!.GetValue<string>();
        Assert.True((await owner.Put($"/api/v1/documents/{doc}/sections", new { revision = rev, sections = new[] { new { key, content } } })).Ok);

        var res = await owner.Post($"/api/v1/documents/{doc}/export", new { });
        await factory.Services.GetRequiredService<ReportExportProcessor>().ProcessPendingAsync();
        var file = await owner.Raw($"/api/v1/documents/{doc}/exports/{S(res.Data!["id"])}/file");
        var raw = Encoding.Latin1.GetString(await file.Content.ReadAsByteArrayAsync());
        Assert.Contains("(Reviewed?) Tj", raw);           // drawn as a picture: the box texts are in the page
        Assert.Contains("(Publish) Tj", raw);
        Assert.Contains("(yes) Tj", raw);
        Assert.Contains("This diagram could not be drawn", raw);   // a broken diagram does not break the export
    }
}
