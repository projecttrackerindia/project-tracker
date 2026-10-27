using System.Text.Json.Nodes;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Documents;

namespace ProjectManagement.Tests;

/// <summary>Designs in the documentation: AI screens are stripped of anything active or remote; Figma links must be Figma links.</summary>
public class DesignDataTests
{
    [Fact]
    public void A_generated_screen_keeps_its_look_and_loses_scripts_handlers_and_outside_urls()
    {
        var html = DesignHtml.Clean("""
            <!-- Title: Paid --><div style="padding:24px;background:url(https://evil.example/x.png)" onclick="steal()">
            <script>alert(1)</script><img src="https://evil.example/t.gif"><a href="javascript:alert(1)">Go</a>
            <iframe src="https://evil.example"></iframe><scr<script>ipt>alert(2)</script>
            <svg width="20" height="20"><circle cx="10" cy="10" r="8" fill="#0066cc"/></svg><button style="height:44px">Continue</button></div>
            """);
        Assert.Contains("padding:24px", html);
        Assert.Contains("<circle", html);
        Assert.Contains("Continue", html);
        Assert.DoesNotContain("<script", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("onclick", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("evil.example", html);
        Assert.DoesNotContain("javascript:", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("<iframe", html, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void A_design_is_rebuilt_from_known_fields_and_figma_links_are_checked()
    {
        var figma = DesignData.Clean(JsonNode.Parse("""{"source":"figma","url":"https://www.figma.com/design/AbCdEfGhIjKlMn/Onboarding?node-id=12-4","state":"review","extra":"<x>"}"""));
        Assert.Equal("figma", figma["source"]!.GetValue<string>());
        Assert.Equal("review", figma["state"]!.GetValue<string>());
        Assert.Null(figma["extra"]);
        Assert.Throws<ValidationException>(() => DesignData.Clean(JsonNode.Parse("""{"source":"figma","url":"https://figma.com.evil.example/design/AbCdEfGhIjKlMn"}""")));
        Assert.Throws<ValidationException>(() => DesignData.Clean(JsonNode.Parse("""{"source":"image","fileId":"not-a-guid"}""")));
        Assert.Throws<ValidationException>(() => DesignData.Clean(JsonNode.Parse("""{"source":"ftp"}""")));
        var ai = DesignData.Clean(JsonNode.Parse("""{"source":"ai","html":"<div onload=\"x()\">Hi</div>","prompt":"A success screen","device":"watch"}"""));
        Assert.Equal("<div>Hi</div>", ai["html"]!.GetValue<string>());
        Assert.Equal("phone", ai["device"]!.GetValue<string>());
    }
}
