using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Integrations;

/// <summary>
/// Turns a webhook event into a message a chat channel can show: Slack (incoming webhook: text plus Block Kit) or Microsoft Teams
/// (a Workflows "post to a channel" webhook: an Adaptive Card). The stored delivery stays the neutral JSON event; the message is written
/// when it is sent, so the delivery log shows the same event whichever format the receiver wants.
/// </summary>
public static class ChatMessages
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static string Render(WebhookFormat format, string payload, string webBaseUrl, string workspaceName) => format switch
    {
        WebhookFormat.Slack => Slack(Read(payload, webBaseUrl), workspaceName),
        WebhookFormat.Teams => Teams(Read(payload, webBaseUrl), workspaceName),
        _ => payload,
    };

    private sealed record Message(string Title, string Text, string? Actor, DateTime At, string Link);

    /// <summary>"task.status_changed" → "Task status changed"; "audit.logged" with an action → "Audit: member.role_changed".</summary>
    public static string Label(string eventType, JsonNode? data = null)
    {
        if (eventType == "ping") return "Test message";
        if (eventType == "audit.logged" && data?["action"]?.GetValue<string>() is { } action) return $"Audit: {action}";
        var words = eventType.Replace('.', ' ').Replace('_', ' ').Trim();
        return words.Length == 0 ? "Update" : char.ToUpperInvariant(words[0]) + words[1..];
    }

    /// <summary>Where the event can be seen in the app (the task, the work task, the project), or the workspace itself.</summary>
    public static string LinkFor(JsonNode? data, string web)
    {
        var type = data?["entity"]?["type"]?.GetValue<string>();
        var id = data?["entity"]?["id"]?.ToString();
        var project = data?["projectId"]?.ToString();
        return type switch
        {
            "Task" when !string.IsNullOrEmpty(project) && !string.IsNullOrEmpty(id) => $"{web}/projects/{project}?task={id}",
            "WorkTask" when !string.IsNullOrEmpty(id) => $"{web}/operations?task={id}",
            "Project" when !string.IsNullOrEmpty(id) => $"{web}/projects/{id}",
            _ when !string.IsNullOrEmpty(project) => $"{web}/projects/{project}",
            _ => web.Length > 0 ? web : "https://projecttracker.in",
        };
    }

    private static Message Read(string payload, string web)
    {
        var root = JsonNode.Parse(payload);
        var type = root?["event"]?.GetValue<string>() ?? "event";
        var data = root?["data"];
        var at = DateTime.TryParse(root?["occurredAt"]?.ToString(), CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var t) ? t : DateTime.UtcNow;
        var text = data?["summary"]?.GetValue<string>() ?? data?["message"]?.GetValue<string>()
            ?? (type == "audit.logged" ? $"{data?["entityType"]} {data?["entityId"]}".Trim() : null) ?? Label(type, data);
        var actor = data?["actor"]?["name"]?.GetValue<string>() ?? data?["user"]?["name"]?.GetValue<string>();
        return new Message(Label(type, data), text, actor, at, LinkFor(data, web.TrimEnd('/')));
    }

    private static string SlackEscape(string s) => s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");

    private static string Slack(Message m, string workspace)
    {
        var context = $"{(m.Actor is null ? "" : $"{SlackEscape(m.Actor)} · ")}{SlackEscape(workspace)} · <!date^{new DateTimeOffset(m.At).ToUnixTimeSeconds()}^{{date_short_pretty}} {{time}}|{m.At:yyyy-MM-dd HH:mm} UTC>";
        var body = new
        {
            text = $"{m.Title}: {m.Text}",   // the notification preview, and the whole message for clients without blocks
            blocks = new object[]
            {
                new { type = "section", text = new { type = "mrkdwn", text = $"*{SlackEscape(m.Title)}*\n{SlackEscape(m.Text)}" } },
                new { type = "context", elements = new object[] { new { type = "mrkdwn", text = context } } },
                new { type = "actions", elements = new object[] { new { type = "button", text = new { type = "plain_text", text = "Open in Project Tracker" }, url = m.Link } } },
            },
        };
        return JsonSerializer.Serialize(body, Json);
    }

    private static string Teams(Message m, string workspace)
    {
        var card = new Dictionary<string, object?>
        {
            ["$schema"] = "http://adaptivecards.io/schemas/adaptive-card.json", ["type"] = "AdaptiveCard", ["version"] = "1.4",
            ["body"] = new object[]
            {
                new { type = "TextBlock", text = m.Title, weight = "Bolder", size = "Medium", wrap = true },
                new { type = "TextBlock", text = m.Text, wrap = true },
                new { type = "TextBlock", text = $"{(m.Actor is null ? "" : $"{m.Actor} · ")}{workspace} · {m.At:dd MMM yyyy HH:mm} UTC", isSubtle = true, size = "Small", spacing = "None", wrap = true },
            },
            ["actions"] = new object[] { new Dictionary<string, object> { ["type"] = "Action.OpenUrl", ["title"] = "Open in Project Tracker", ["url"] = m.Link } },
        };
        var body = new { type = "message", attachments = new object[] { new { contentType = "application/vnd.microsoft.card.adaptive", contentUrl = (string?)null, content = card } } };
        return JsonSerializer.Serialize(body, Json);
    }
}
