using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using ProjectManagement.Application.Exceptions;

namespace ProjectManagement.Application.Features.Documents;

/// <param name="Level">The C4 level tab the person is on (context, containers, components, deployment): boxes the model leaves without a level go there.</param>
public record DiagramDraftRequest(string Prompt, JsonNode? Current = null, IReadOnlyList<string>? Context = null, string? Level = null);
public record DiagramDraftDto(JsonObject Data, string Summary, string Model);
public record DesignDraftRequest(string Prompt, string? Device = null, string? Brand = null);
public record DesignDraftDto(string Html, string Title, string Model);

/// <summary>
/// Visual AI for documentation: an architecture diagram drawn (or changed) from a sentence, and a screen mock-up generated from a prompt.
/// Both come back cleaned: the diagram through <see cref="ArchDiagram.Clean"/>, the screen through <see cref="DesignHtml.Clean"/>, so the
/// model can never place markup, scripts or outside resources in a page.
/// </summary>
public partial class DocumentAiService
{
    public const int MaxVisualPrompt = 1500;
    private static readonly string IconKeys = "user users web mobile desktop partner gateway loadbalancer firewall auth cdn vpn mulesoft api esb queue topic webhook sftp scheduler server container function cluster cloud database cache storage warehouse file crm erp hrms loan payment bank collection whatsapp email sms voice portal logs monitor alert box note settings";

    public async Task<DiagramDraftDto> DiagramAsync(DiagramDraftRequest req, CancellationToken ct = default)
    {
        await EnsureAiAsync(ct);
        var prompt = (req.Prompt ?? "").Trim();
        if (prompt.Length == 0) throw new ValidationException("prompt", "Describe the system or the change.");
        if (prompt.Length > MaxVisualPrompt) throw new ValidationException("prompt", $"Keep it under {MaxVisualPrompt:N0} characters.");
        var current = req.Current is null ? "" : ArchDiagram.Clean(req.Current).ToJsonString();
        if (current.Length > 40_000) current = "";
        var context = string.Join("\n", (req.Context ?? []).Take(60).Select(c => "- " + Cut(c ?? "", 160)));
        var system = "You draw software architecture diagrams as JSON for a diagram editor. Answer with ONE JSON object only, no prose, no code fence: "
            + "{\"summary\":\"one short sentence of what you drew or changed\",\"nodes\":[{\"id\":\"a\",\"kind\":\"icon\",\"icon\":\"<icon key>\",\"label\":\"...\",\"x\":0,\"y\":0,\"w\":150,\"h\":64}],"
            + "\"edges\":[{\"id\":\"e1\",\"source\":\"a\",\"target\":\"b\",\"label\":\"HTTPS\",\"line\":\"solid\",\"animated\":true}]}. "
            + "kind is icon (a component), frame (a boundary that groups others: give it x,y,w,h around them and set parentId on the boxes inside) or shape. "
            + $"icon is one of: {IconKeys}. Lay the main request path left to right on one row, 230 px apart; data stores below, events above; keep every box on the grid. "
            + "Label arrows with the protocol or the call (\"GET /balance\", \"enqueue\"). Ids are short letters. Never invent real hostnames, IPs, keys or people. "
            + "Every component box also has C4 details: \"level\" (context for people and outside systems, containers for apps, services, queues and stores, components for parts inside one service, deployment for servers and clusters), "
            + "\"ctype\" (one of person, external, web, api, queue, db, cache; zone or group for frames) and \"tech\" (the technology in a few words, like \"React SPA\", \".NET 9 API\", \"PostgreSQL 16\", \"Redis\", \"MuleSoft 4\"). "
            + $"Put boxes on the {ArchDiagram.LevelOr(req.Level)} level unless the request is clearly about another one.";
        var user = (current.Length > 0 ? $"The current diagram (change it; keep ids that stay):\n{current}\n\n" : "")
            + (context.Length > 0 ? $"What this project has (use the real names where they fit):\n{context}\n\n" : "")
            + $"Request: {prompt}";
        var answer = await AskModelAsync("diagram_draft", system, user, 4000, 2, ct);
        var json = StripFence(answer.Text);
        var start = json.IndexOf('{'); var end = json.LastIndexOf('}');
        if (start < 0 || end <= start) throw new ConflictException("The assistant did not return a diagram. Try describing it differently.", "AI_BAD_DIAGRAM");
        JsonNode? parsed;
        try { parsed = JsonNode.Parse(json[start..(end + 1)]); }
        catch (JsonException) { throw new ConflictException("The assistant did not return a diagram. Try describing it differently.", "AI_BAD_DIAGRAM"); }
        var data = ArchDiagram.ApplyC4(ArchDiagram.Clean(parsed), req.Level);
        if (data["nodes"]!.AsArray().Count == 0) throw new ConflictException("The assistant did not return any boxes. Try describing it differently.", "AI_BAD_DIAGRAM");
        var summary = parsed?["summary"] is JsonValue s && s.TryGetValue<string>(out var t) ? Cut(t.Trim(), 300) : "Drawn from your description.";
        recorder.Audit("ai.used", "Document", null, null, new { feature = "diagram_draft", nodes = data["nodes"]!.AsArray().Count });
        return new DiagramDraftDto(data, summary, answer.Model);
    }

    public async Task<DesignDraftDto> DesignAsync(DesignDraftRequest req, CancellationToken ct = default)
    {
        await EnsureAiAsync(ct);
        var prompt = (req.Prompt ?? "").Trim();
        if (prompt.Length == 0) throw new ValidationException("prompt", "Describe the screen.");
        if (prompt.Length > MaxVisualPrompt) throw new ValidationException("prompt", $"Keep it under {MaxVisualPrompt:N0} characters.");
        var (w, h) = (req.Device ?? "phone") switch { "desktop" => (1440, 900), "tablet" => (834, 1112), _ => (390, 844) };
        var brand = Cut((req.Brand ?? "").Trim(), 300);
        var system = $"You design one app screen as a static HTML mock-up, {w}x{h} CSS px. Answer with the HTML only (one <div> root, inline styles or one <style> block), no prose, no code fence. "
            + "No <script>, no event attributes, no external images, fonts or links: draw pictures with CSS shapes or inline SVG. Keep it compact (under 12,000 characters). Use system-ui fonts, real-looking copy for the request "
            + "(no lorem ipsum, invented names only), 44px touch targets, clear hierarchy, generous spacing, an Apple-like clean look"
            + (brand.Length > 0 ? $", in this brand: {brand}" : "") + ". First line: an HTML comment with a short title, like <!-- Title: Payment success -->.";
        var answer = await AskModelAsync("design_draft", system, prompt, 6000, 3, ct);
        var raw = StripFence(answer.Text);
        var title = Regex.Match(raw, "<!--\\s*Title:\\s*(.{1,80}?)\\s*-->", RegexOptions.IgnoreCase) is { Success: true } m ? m.Groups[1].Value : Cut(prompt, 60);
        var html = DesignHtml.Clean(raw);
        if (html.Length < 40) throw new ConflictException("The assistant did not return a screen. Try describing it differently.", "AI_BAD_DESIGN");
        recorder.Audit("ai.used", "Document", null, null, new { feature = "design_draft", device = req.Device, length = html.Length });
        return new DesignDraftDto(html, title, answer.Model);
    }
}

/// <summary>
/// A generated screen's HTML made safe to keep and to show: scripts, frames, forms posting elsewhere, event handlers, javascript: and every
/// outside URL are removed. It is only ever shown in a sandboxed frame without scripts, under a policy that blocks all network access.
/// </summary>
public static class DesignHtml
{
    public const int MaxLength = 16_000;   // the project's visual store holds 600,000 characters in all
    private static readonly Regex[] Drop =
    [
        new("<\\s*(script|iframe|object|embed|link|meta|base|frame|frameset|applet|portal)\\b[\\s\\S]*?(<\\s*/\\s*\\1\\s*>|/?>)", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new("\\s+on[a-z]+\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new("\\s+(href|src|action|formaction|xlink:href|srcset|poster|background)\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new("url\\(\\s*(['\"]?)(?!data:image/svg\\+xml)[^)]*\\)", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new("@import[^;]*;?", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new("javascript\\s*:", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new("expression\\s*\\(", RegexOptions.IgnoreCase | RegexOptions.Compiled),
    ];

    public static string Clean(string? html)
    {
        var s = html ?? "";
        if (s.Length > MaxLength * 2) s = s[..(MaxLength * 2)];
        // Run until nothing changes, so nested or split tags cannot survive one pass.
        for (var i = 0; i < 4; i++)
        {
            var before = s;
            foreach (var r in Drop) s = r.Replace(s, "");
            if (s == before) break;
        }
        s = s.Trim();
        return s.Length > MaxLength ? s[..MaxLength] : s;
    }
}

/// <summary>
/// A design attached to a project's documentation: a Figma file or frame (kept as a link and shown with Figma's own embed), a picture
/// uploaded to the project, or a screen generated by AI (cleaned HTML). Stored beside the project's diagrams; rebuilt from known fields.
/// </summary>
public static class DesignData
{
    private static readonly Regex Figma = new("^https://(www\\.)?figma\\.com/(file|design|proto|board)/[A-Za-z0-9]{10,64}(/[^\\s<>\"']{0,300})?$", RegexOptions.Compiled);
    private static readonly HashSet<string> Sources = ["figma", "image", "ai"];
    private static readonly HashSet<string> Devices = ["phone", "tablet", "desktop"];
    private static readonly HashSet<string> States = ["draft", "review", "approved"];

    private static string Str(JsonNode? n, int max) => n is JsonValue v && v.TryGetValue<string>(out var s) ? (s.Length > max ? s[..max] : s).Trim() : "";

    public static JsonObject Clean(JsonNode? data)
    {
        var source = Str(data?["source"], 10); if (!Sources.Contains(source)) throw new ValidationException("designs", "A design is a Figma link, a picture or an AI screen.");
        var o = new JsonObject { ["source"] = source };
        var device = Str(data?["device"], 10); o["device"] = Devices.Contains(device) ? device : "phone";
        var state = Str(data?["state"], 10); o["state"] = States.Contains(state) ? state : "draft";
        var note = Str(data?["note"], 1000); if (note.Length > 0) o["note"] = note;
        var group = Str(data?["group"], 80); if (group.Length > 0) o["group"] = group;
        switch (source)
        {
            case "figma":
                var url = Str(data?["url"], 500);
                if (!Figma.IsMatch(url)) throw new ValidationException("designs", "Paste a Figma link (figma.com/design/… or figma.com/file/…).");
                o["url"] = url; break;
            case "image":
                var file = Str(data?["fileId"], 40);
                if (!Guid.TryParse(file, out var g)) throw new ValidationException("designs", "Upload the picture first.");
                o["fileId"] = g.ToString(); break;
            default:
                var html = DesignHtml.Clean(Str(data?["html"], DesignHtml.MaxLength * 2));
                if (html.Length == 0) throw new ValidationException("designs", "The generated screen is empty.");
                o["html"] = html;
                var prompt = Str(data?["prompt"], 1500); if (prompt.Length > 0) o["prompt"] = prompt;
                break;
        }
        return o;
    }
}
