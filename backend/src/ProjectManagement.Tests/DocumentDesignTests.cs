using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Documents;
using ProjectManagement.Application.Features.Reports;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The look of the PDF (logo, lifecycle, request flow, masked examples) and the API stage (release D6).</summary>
[Collection("api")]
public class DocumentDesignTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    /// <summary>A small RGBA PNG: a dark block with a transparent corner.</summary>
    private static byte[] Png(int w = 40, int h = 16, int colorType = 6)
    {
        var ch = colorType == 6 ? 4 : 3;
        using var raw = new MemoryStream();
        for (var y = 0; y < h; y++)
        {
            raw.WriteByte(y % 2 == 0 ? (byte)0 : (byte)1);   // alternate "none" and "sub" filters
            var prev = new byte[ch];
            for (var x = 0; x < w; x++)
            {
                var px = colorType == 6 ? new byte[] { 20, 40, 120, (byte)(x > w - 6 && y < 6 ? 0 : 255) } : [20, 40, 120];
                if (y % 2 == 0) raw.Write(px); else { for (var c = 0; c < ch; c++) raw.WriteByte((byte)(px[c] - prev[c])); }
                prev = px;
            }
        }
        using var z = new MemoryStream();
        using (var d = new ZLibStream(z, CompressionLevel.Optimal, true)) d.Write(raw.ToArray());
        using var o = new MemoryStream();
        o.Write([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        void Chunk(string type, byte[] data)
        {
            o.Write(Be(data.Length)); var t = Encoding.ASCII.GetBytes(type); o.Write(t); o.Write(data);
            o.Write(Be((int)Crc(t.Concat(data).ToArray())));
        }
        var ihdr = new List<byte>(); ihdr.AddRange(Be(w)); ihdr.AddRange(Be(h)); ihdr.AddRange([8, (byte)colorType, 0, 0, 0]);
        Chunk("IHDR", ihdr.ToArray()); Chunk("IDAT", z.ToArray()); Chunk("IEND", []);
        return o.ToArray();
    }

    private static byte[] Be(int v) => [(byte)(v >> 24), (byte)(v >> 16), (byte)(v >> 8), (byte)v];

    private static uint Crc(byte[] bytes)
    {
        var crc = 0xFFFFFFFFu;
        foreach (var b in bytes) { crc ^= b; for (var k = 0; k < 8; k++) crc = (crc & 1) != 0 ? 0xEDB88320u ^ (crc >> 1) : crc >> 1; }
        return ~crc;
    }

    private static async Task<ApiResult> UploadLogo(TestClient c, byte[] bytes, string type = "image/png")
    {
        using var form = new MultipartFormDataContent(); var part = new ByteArrayContent(bytes); part.Headers.ContentType = new MediaTypeHeaderValue(type); form.Add(part, "file", "logo");
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/workspace/logo") { Content = form };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", c.Token);
        var res = await c.Http.SendAsync(req);
        return new ApiResult(res.StatusCode, System.Text.Json.Nodes.JsonNode.Parse(await res.Content.ReadAsStringAsync()));
    }

    [Fact]
    public void A_png_is_decoded_with_its_transparency_and_a_jpeg_is_passed_through()
    {
        var rgba = PdfImage.Read(Png());
        Assert.Equal((40, 16), (rgba.Width, rgba.Height));
        Assert.NotNull(rgba.Alpha);
        Assert.Equal("/DeviceRGB", rgba.ColorSpace);
        var opaque = PdfImage.Read(Png(colorType: 2));
        Assert.Null(opaque.Alpha);

        byte[] jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x4A, 0x46, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xD9];
        var j = PdfImage.Read(jpeg);
        Assert.Equal((64, 32), (j.Width, j.Height));
        Assert.Equal("/DCTDecode", j.Filter);
        Assert.Throws<FormatException>(() => PdfImage.Read(Encoding.ASCII.GetBytes("GIF89a......")));
        Assert.Throws<FormatException>(() => PdfImage.Read(Png()[..30]));
    }

    [Fact]
    public async Task Admins_set_the_logo_others_cannot_and_a_bad_file_is_refused()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olga");
        await owner.CreateOrgAsync(); await owner.UpgradeAsync("PRO", 5);
        var member = await owner.AddMemberAsync(factory, TenantRole.Member);
        Assert.Equal(HttpStatusCode.Forbidden, (await UploadLogo(member, Png())).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Delete("/api/v1/workspace/logo")).Status);

        Assert.False((await owner.Get("/api/v1/workspace/logo")).Data!["hasLogo"]!.GetValue<bool>());
        var ok = await UploadLogo(owner, Png());
        Assert.True(ok.Ok, ok.ToString());
        Assert.Equal(40, ok.Data!["width"]!.GetValue<int>());
        var file = await owner.Raw("/api/v1/workspace/logo/file");
        Assert.Equal("image/png", file.Content.Headers.ContentType!.MediaType);
        Assert.True((await member.Get("/api/v1/workspace/logo")).Data!["hasLogo"]!.GetValue<bool>());   // everyone's PDFs carry it

        Assert.Equal((HttpStatusCode)422, (await UploadLogo(owner, Encoding.ASCII.GetBytes("<svg onload=alert(1)></svg>"), "image/svg+xml")).Status);
        Assert.Equal((HttpStatusCode)422, (await UploadLogo(owner, new byte[1_100_000])).Status);
        Assert.True((await owner.Get("/api/v1/workspace/logo")).Data!["hasLogo"]!.GetValue<bool>());   // the good one is still there
        Assert.True((await owner.Delete("/api/v1/workspace/logo")).Ok);
        Assert.False((await owner.Get("/api/v1/workspace/logo")).Data!["hasLogo"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Raw("/api/v1/workspace/logo/file")).StatusCode);
    }

    [Fact]
    public void Credentials_in_examples_keep_their_shape_and_lose_their_value()
    {
        Assert.Equal("78g65*******fa2b", DocumentPdfBuilder.Mask("CLIENT-ID", "78g65d9f3a1c2fa2b"));
        Assert.Equal("Basic YWRta*******aW4=", DocumentPdfBuilder.Mask("Authorization", "Basic YWRtaW46c2VjcmV0cGFzcw==taW4="));
        Assert.Equal("*********", DocumentPdfBuilder.Mask("password", "short"));
        Assert.Equal("GDHY43c57WG76", DocumentPdfBuilder.Mask("CORRELATION-ID", "GDHY43c57WG76"));
        Assert.Equal("https://••••••••/••••", DocumentPdfBuilder.MaskHost("https://api.internal.example.com/v1/pay"));
    }

    [Fact]
    public void Response_fields_come_from_the_schema_with_examples_and_nesting()
    {
        var rows = DocumentPdfBuilder.SchemaRows("{\"type\":\"object\",\"required\":[\"id\"],\"properties\":{\"id\":{\"type\":\"string\",\"description\":\"The id\"},\"amount\":{\"type\":\"integer\"},\"client\":{\"type\":\"object\",\"properties\":{\"secret\":{\"type\":\"string\"}}},\"items\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"sku\":{\"type\":\"string\"}}}}}}",
            "{\"id\":\"order_1\",\"amount\":501,\"client\":{\"secret\":\"abcdefghijklmnop\"},\"items\":[{\"sku\":\"A-1\"}]}");
        Assert.Equal(["id *", "amount", "client", "client.secret", "items", "items[].sku"], rows.Select(r => r[0]));
        Assert.Equal("order_1", rows[0][2]); Assert.Equal("Number", rows[1][1]); Assert.Equal("501", rows[1][2]);
        Assert.Equal("abcde*******mnop", rows[3][2]);   // a secret in an example is masked
        Assert.Equal("A-1", rows[5][2]);
        Assert.Empty(DocumentPdfBuilder.SchemaRows("not json", null));
    }

    [Fact]
    public async Task The_pdf_carries_the_logo_the_lifecycle_the_request_flow_and_masked_credentials()
    {
        var owner = await TestClient.RegisterAsync(factory, "Prasanna Krishna");
        await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS", 5);
        Assert.True((await UploadLogo(owner, Png())).Ok);
        var type = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "API")!["id"]));
        var doc = Guid.Parse(S((await owner.Post("/api/v1/documents", new { title = "Razor pay API", typeId = type })).Data!["item"]!["id"]));
        var def = await owner.Post($"/api/v1/documents/{doc}/api/definitions", new { name = "Payment", version = "1.0.1", auth = "Basic", stage = "Uat", servers = new[] { "https://api.corp.example.com" } });
        Assert.True(def.Ok, def.ToString());
        Assert.Equal("Uat", S(def.Data!["definitions"]![0]!["stage"]));
        var defId = S(def.Data["definitions"]![0]!["id"]);
        var ep = await owner.Post($"/api/v1/documents/{doc}/api/endpoints", new
        {
            definitionId = defId, method = "POST", path = "/api/v1/create", summary = "Create an order", tag = "Payment", deprecated = false,
            details = new
            {
                parameters = new object[] { new { name = "CLIENT-SECRET", @in = "header", required = true, type = "String", example = "f56f6a0c9d4e2bd8a", description = "Keep it secret" } },
                requestBody = new { contentType = "application/json", required = true, example = "{\"amount\":100}" },
                responses = new object[] { new { status = "201", description = "Created", schema = "{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"}}}", example = "{\"id\":\"order_1\"}" } },
                flow = "flowchart LR\n  A[Portal] -->|POST| B[Gateway]\n  B --> C[Razorpay]",
            },
        });
        Assert.True(ep.Ok, ep.ToString());

        var res = await owner.Post($"/api/v1/documents/{doc}/export", new { });
        await factory.Services.GetRequiredService<ReportExportProcessor>().ProcessPendingAsync();
        var bytes = await (await owner.Raw($"/api/v1/documents/{doc}/exports/{S(res.Data!["id"])}/file")).Content.ReadAsByteArrayAsync();
        var raw = Encoding.Latin1.GetString(bytes);
        Assert.Contains("/Subtype /Image", raw);                  // the logo
        Assert.Contains("/SMask", raw);                           // with its transparency
        Assert.Contains("(STAGE 5 / 9) Tj", raw);                 // the lifecycle ring names the stage (UAT = 5th)
        Assert.Contains("(UAT) Tj", raw);
        Assert.Contains("(Gateway) Tj", raw);                     // the request flow is drawn
        Assert.Contains("f56f6*******bd8a", raw);                 // the secret header example is masked ...
        Assert.DoesNotContain("f56f6a0c9d4e2bd8a", raw);          // ... everywhere
        Assert.DoesNotContain("api.corp.example.com", raw);       // and so is the host
        Assert.Contains("(Request) Tj", raw);
        Assert.Contains("(RESPONSE FIELDS) Tj", raw);
    }

    [Fact]
    public async Task A_request_flow_that_cannot_be_drawn_is_refused_where_it_is_saved()
    {
        var owner = await TestClient.RegisterAsync(factory, "Ana");
        await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS", 5);
        var type = Guid.Parse(S((await owner.Get("/api/v1/document-types")).Data!.AsArray().First(t => S(t!["code"]) == "API")!["id"]));
        var doc = Guid.Parse(S((await owner.Post("/api/v1/documents", new { title = "API", typeId = type })).Data!["item"]!["id"]));
        var def = await owner.Post($"/api/v1/documents/{doc}/api/definitions", new { name = "A", auth = "None" });
        var defId = S(def.Data!["definitions"]![0]!["id"]);
        var bad = await owner.Post($"/api/v1/documents/{doc}/api/endpoints", new { definitionId = defId, method = "GET", path = "/x", summary = "x", deprecated = false, details = new { flow = "flowchart LR\n A -> B" } });
        Assert.Equal((HttpStatusCode)422, bad.Status);
        Assert.Contains("Request flow, line 2", bad.ToString());
        var bogusStage = await owner.Post($"/api/v1/documents/{doc}/api/definitions", new { name = "B", auth = "None", stage = "Nonsense" });
        Assert.False(bogusStage.Ok);
    }
}
