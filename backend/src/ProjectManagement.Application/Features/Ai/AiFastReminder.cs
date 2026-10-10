using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Services;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>Recognizes a few exact commands. It never writes data: all resulting calls use the normal tools and confirmation flow.</summary>
public sealed record AiFastReminder(string? Tool, string? Input, string? Reply)
{
    private static readonly Regex Create = new(@"^(?:create|set|add) reminder (?:for|at) (?:(?<day>today|tomorrow) (?:at )?)?(?<time>\d{1,2}:\d{2}) (?:as|called|named) (?<title>[^\r\n]{2,200})$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
    private static readonly Regex Revise = new(@"^(?:change|move|reschedule) (?:it|that) (?:to|at) (?<time>\d{1,2}:\d{2})[.!?]*$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static async Task<AiFastReminder?> TryAsync(AiRun run, IAppDbContext db, AppClock clock, CancellationToken ct)
    {
        if (run.Files.Count > 0 || !run.Plan.Actions || !ZoneTime.IsKnown(run.TimeZone)) return null;
        var create = Create.Match(run.Text.Trim()); var revise = Revise.Match(run.Text.Trim());
        var timeText = create.Success ? create.Groups["time"].Value : revise.Success ? revise.Groups["time"].Value : null;
        if (timeText is null || !ZoneTime.TryParseTime(timeText, out var time)) return null;
        var zone = ZoneTime.Find(run.TimeZone);
        var day = DateOnly.FromDateTime(ZoneTime.ToLocal(clock.Now, zone));
        string tool; object input;
        if (create.Success)
        {
            if (create.Groups["day"].Value.Equals("tomorrow", StringComparison.OrdinalIgnoreCase)) day = day.AddDays(1);
            var local = ZoneTime.At(day, time);
            if (ZoneTime.ToUtc(local, zone) <= clock.Now)
                return new(null, null, $"{time:HH:mm} has already passed today in {zone.Id}. Which date should I use for this reminder?");
            tool = AiToolbox.CreateReminder;
            input = new { text = create.Groups["title"].Value.Trim(), at = ZoneTime.Write(local) };
        }
        else
        {
            var rows = await db.AiMessages.AsNoTracking().Where(m => m.ConversationId == run.Conversation.Id
                && m.UserId == run.Question.UserId && m.Role == "assistant" && m.ActionsJson != null)
                .OrderByDescending(m => m.CreatedAt).Take(5).Select(m => new { m.Id, m.ActionsJson }).ToListAsync(ct);
            var pending = rows.SelectMany(m => (JsonSerializer.Deserialize<List<AiProposal>>(m.ActionsJson!, Json) ?? [])
                .Where(p => p.Kind == "reminder" && p.Status == "proposed").Select(p => new { m.Id, Proposal = p })).ToList();
            // Ambiguous references and saved reminders go through the model, which can ask or use the saved reminder lookup.
            if (pending.Count != 1) return null;
            var prior = JsonNode.Parse(pending[0].Proposal.PayloadJson)!;
            if (!ZoneTime.TryParseLocal(prior["at"]?.GetValue<string>(), out var before)) return null;
            var local = ZoneTime.At(DateOnly.FromDateTime(before), time);
            if (ZoneTime.ToUtc(local, zone) <= clock.Now)
                return new(null, null, $"{local:dd MMM yyyy HH:mm} has already passed in {zone.Id}. Which future date should I use?");
            tool = AiToolbox.ReviseReminder;
            input = new { message_id = pending[0].Id, proposal_id = pending[0].Proposal.Id, at = ZoneTime.Write(local) };
        }
        return new(tool, JsonSerializer.Serialize(input, Json), null);
    }
}
