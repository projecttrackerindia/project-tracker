using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Personal and secret data in documents is masked before it leaves the server; real values only through an audited reveal.</summary>
[Collection("api")]
public class DocumentMaskingTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static string Text(string t) => new JsonObject { ["type"] = "doc", ["content"] = new JsonArray(new JsonObject { ["type"] = "paragraph", ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = t }) }) }.ToJsonString();

    [Fact]
    public void Indian_identifiers_and_credentials_are_masked_by_shape_label_and_column()
    {
        var m = new PiiMasker();
        var text = m.MaskText("Call Ravi on 98765 43210 or ravi.kumar@example.com. PAN ABCDE1234F, Aadhaar 2345 6789 0123, IFSC HDFC0001234, UPI ravi@okhdfcbank, card 4111 1111 1111 1111. client_secret: s3cr3tValue99");
        Assert.DoesNotContain("98765 43210", text); Assert.Contains("3210", text);
        Assert.DoesNotContain("ravi.kumar@", text); Assert.Contains("@example.com", text);
        Assert.DoesNotContain("ABCDE1234F", text); Assert.DoesNotContain("2345 6789 0123", text); Assert.DoesNotContain("HDFC0001234", text);
        Assert.DoesNotContain("ravi@okhdfcbank", text); Assert.DoesNotContain("4111 1111 1111 1111", text); Assert.DoesNotContain("s3cr3tValue99", text);
        Assert.Contains("Order 4521 shipped on 2026-10-21", m.MaskText("Order 4521 shipped on 2026-10-21"));   // ordinary numbers stay

        var table = """{"columns":[{"key":"c1","label":"Customer"},{"key":"c2","label":"Mobile No"}],"rows":[{"c1":"Ravi","c2":"9876543210"}]}""";
        var masked = new PiiMasker().MaskTable(table);
        Assert.Contains("Ravi", masked); Assert.DoesNotContain("9876543210", masked);

        var json = new PiiMasker().MaskJson(JsonNode.Parse("""{"loanAccountNumber":"501001234567","status":"ACTIVE","headers":{"client_id":"abc123def456"}}"""))!.ToJsonString();
        Assert.DoesNotContain("501001234567", json); Assert.DoesNotContain("abc123def456", json); Assert.Contains("ACTIVE", json);

        var custom = new PiiMasker([new MaskRule("employee code", "exact", "last2", "Employee code")], ["E-mail"]);
        Assert.DoesNotContain("FS102938", custom.MaskText("Employee code: FS102938"));
        Assert.Contains("ravi@example.com", custom.MaskText("Mail ravi@example.com"));   // e-mail switched off
    }

    [Fact]
    public async Task Readers_see_masked_values_editors_unlock_them_and_a_masked_copy_cannot_be_saved()
    {
        var owner = await TestClient.RegisterAsync(factory, "Mona Mask");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var brd = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "BRD")!["id"]));
        var created = await owner.Post("/api/v1/documents", new { title = "Collections runbook", typeId = brd });
        var id = S(created.Data!["item"]!["id"]);
        var rev = created.Data!["revision"]!.GetValue<int>();
        var secret = "Escalate to Ravi on 9876543210, PAN ABCDE1234F.";
        var saved = await owner.Put($"/api/v1/documents/{id}/sections", new { revision = rev, sections = new[] { new { key = "scope", content = Text(secret) } } });
        Assert.True(saved.Ok, saved.ToString());
        Assert.Contains("9876543210", saved.Json!.ToJsonString());   // the editor keeps working on the real values

        var read = await owner.Get($"/api/v1/documents/{id}");
        Assert.DoesNotContain("9876543210", read.Json!.ToJsonString());
        Assert.DoesNotContain("ABCDE1234F", read.Json!.ToJsonString());
        Assert.True(read.Data!["maskedCount"]!.GetValue<int>() >= 2);
        Assert.True(read.Data!["canReveal"]!.GetValue<bool>());

        // A masked copy sent back is refused instead of wiping the real values.
        var scope = read.Data!["sections"]!.AsArray().First(s => S(s!["key"]) == "scope")!;
        var bad = await owner.Put($"/api/v1/documents/{id}/sections", new { revision = read.Data!["revision"]!.GetValue<int>(), sections = new[] { new { key = "scope", content = S(scope["content"]) } } });
        Assert.Equal(HttpStatusCode.Conflict, bad.Status);

        Assert.Equal(422, (int)(await owner.Post($"/api/v1/documents/{id}/reveal", new { purpose = "read", reason = "" })).Status);
        var revealed = await owner.Post($"/api/v1/documents/{id}/reveal", new { purpose = "read", reason = "Customer called about EMI" });
        Assert.True(revealed.Ok, revealed.ToString());
        Assert.Contains("9876543210", revealed.Json!.ToJsonString());
        Assert.True(revealed.Data!["revealed"]!.GetValue<bool>());
        Assert.True(revealed.Data!["revealSeconds"]!.GetValue<int>() >= 5);
        var edit = await owner.Post($"/api/v1/documents/{id}/reveal", new { purpose = "edit" });
        Assert.Contains("9876543210", edit.Json!.ToJsonString());

        // Version history is masked too.
        var versions = await owner.Get($"/api/v1/documents/{id}/versions");
        var draft = versions.Data!["items"]!.AsArray().First()!;
        var content = await owner.Get($"/api/v1/documents/{id}/versions/{S(draft["id"])}");
        Assert.DoesNotContain("9876543210", content.Json!.ToJsonString());

        // Switching masking off shows the values; a custom rule masks a company field.
        Assert.True((await owner.Put("/api/v1/document-security/masking", new { enabled = false })).Ok);
        Assert.Contains("9876543210", (await owner.Get($"/api/v1/documents/{id}")).Json!.ToJsonString());
        Assert.True((await owner.Put("/api/v1/document-security/masking", new { enabled = true, disabledBuiltIns = new[] { "Address" } })).Ok);
        var rules = await owner.Post("/api/v1/document-security/masking/rules", new { field = "employee code", match = "exact", strategy = "last2", label = "Employee code", enabled = true });
        Assert.True(rules.Ok, rules.ToString());
        var preview = await owner.Post("/api/v1/document-security/masking/preview", new { text = "Employee code: FS102938" });
        Assert.DoesNotContain("FS102938", S(preview.Data!["masked"]));
        Assert.Equal(422, (int)(await owner.Post("/api/v1/document-security/masking/rules", new { field = "(a+)+$[", match = "regex", strategy = "full", enabled = true })).Status);
    }
}
