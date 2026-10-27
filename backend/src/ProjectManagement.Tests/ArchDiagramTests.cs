using System.Text.Json.Nodes;
using ProjectManagement.Application.Features.Documents;

namespace ProjectManagement.Tests;

/// <summary>Architecture Studio diagrams inside a document: cleaned on save, masked on read, drawn as a flowchart in the PDF and in compare.</summary>
public class ArchDiagramTests
{
    private const string Doc = """
        {"type":"doc","content":[{"type":"archDiagram","attrs":{"title":"Loan balance flow","data":{
          "nodes":[{"id":"a","kind":"icon","icon":"mobile","label":"Customer app","x":0,"y":0,"w":150,"h":64,"onclick":"alert(1)"},
                   {"id":"b","kind":"icon","icon":"mulesoft","label":"MuleSoft API (support 9876543210)","x":260,"y":0,"color":"#00a0df","ctype":"api","level":"containers","tech":".NET 9","replicas":3,"capacity":150},
                   {"id":"c","kind":"icon","icon":"database","label":"Loan DB","x":520,"y":0,"color":"red; background:url(x)"},
                   {"id":"bad id <script>","kind":"icon","label":"dropped"}],
          "edges":[{"id":"e1","source":"a","target":"b","label":"GET /balance","line":"dashed","animated":true,"protocol":"REST","rps":120},
                   {"id":"e2","source":"b","target":"c","label":"SQL"},{"id":"e3","source":"b","target":"nowhere"}]}}}]}
        """;

    [Fact]
    public void A_diagram_is_rebuilt_from_known_fields_masked_and_drawn_as_a_flowchart()
    {
        var clean = JsonNode.Parse(SectionContent.NormalizeRichText(Doc))!;
        var block = clean["content"]![0]!;
        Assert.Equal("archDiagram", block["type"]!.GetValue<string>());
        var data = block["attrs"]!["data"]!;
        Assert.Equal(3, data["nodes"]!.AsArray().Count);
        Assert.Equal(2, data["edges"]!.AsArray().Count);
        Assert.Null(data["nodes"]![0]!["onclick"]);
        Assert.Null(data["nodes"]![2]!["color"]);   // not a colour: dropped
        Assert.Equal("#00a0df", data["nodes"]![1]!["color"]!.GetValue<string>());
        Assert.True(data["edges"]![0]!["animated"]!.GetValue<bool>());
        Assert.Equal("api", data["nodes"]![1]!["ctype"]!.GetValue<string>());
        Assert.Equal("containers", data["nodes"]![1]!["level"]!.GetValue<string>());
        Assert.Equal(3, data["nodes"]![1]!["replicas"]!.GetValue<double>());
        Assert.Equal("REST", data["edges"]![0]!["protocol"]!.GetValue<string>());
        Assert.Equal(120, data["edges"]![0]!["rps"]!.GetValue<double>());
        Assert.Null(data["nodes"]![0]!["ctype"]);

        var masked = new PiiMasker().MaskRichText(clean.ToJsonString());
        Assert.DoesNotContain("9876543210", masked);
        Assert.Contains("GET /balance", masked);

        var flow = ArchDiagram.ToFlowchart(data);
        Assert.StartsWith("flowchart LR", flow);
        Assert.Contains("-->|GET /balance|", flow);
        Assert.NotNull(DiagramEngine.Draw(flow));   // the PDF can draw it
    }
}
