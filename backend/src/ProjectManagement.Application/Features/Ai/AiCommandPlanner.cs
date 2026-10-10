using System.Text.Json;
using System.Text.RegularExpressions;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Services;

namespace ProjectManagement.Application.Features.Ai;

public sealed record AiCommandPlan(string Intent, bool RequiresConfirmation, AiFastReminder Command, AiToolOutcome? ReadOutcome = null);

/// <summary>The known-intent orchestration boundary. It validates via existing tools/services and never executes a mutation.</summary>
public sealed class AiCommandPlanner(IAppDbContext db, AppClock clock, AiToolbox tools)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public static (string Intent, string Tool, string Input, bool Write)? ParseSimple(string text)
    {
        var query = text.Trim();
        if (Regex.IsMatch(query, @"\b(and|then|also)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)) return null;
        (string, string, string, bool) Read(string intent, string tool) => (intent, tool, "{}", false);
        if (Regex.IsMatch(query, @"^(?:list|show) people[.!?]*$", RegexOptions.IgnoreCase)) return Read("list_people", AiToolbox.ListPeople);
        if (Regex.IsMatch(query, @"^(?:list|show) projects[.!?]*$", RegexOptions.IgnoreCase)) return Read("list_projects", AiToolbox.ListProjects);
        if (Regex.IsMatch(query, @"^(?:my work|show my work summary|what is my workload)[.!?]*$", RegexOptions.IgnoreCase)) return Read("my_work_summary", AiToolbox.MyWorkSummary);
        var report = Regex.Match(query, @"^(?:what is the status of project|show status of project|show project status for) (?<project>[^?\r\n]{1,150}?)\s*\??$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
        if (report.Success) return ("project_status", AiToolbox.ProjectReport, JsonSerializer.Serialize(new { project = report.Groups["project"].Value.Trim() }, Json), false);
        var rename = Regex.Match(query, @"^rename project (?<project>[^\r\n]{1,150}?) to (?<name>[^\r\n]{2,120})$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
        if (rename.Success) return ("rename_project", AiToolbox.UpdateProject, JsonSerializer.Serialize(new { project = rename.Groups["project"].Value.Trim(), name = rename.Groups["name"].Value.Trim() }, Json), true);
        var assign = Regex.Match(query, @"^assign (?<key>[a-z][a-z0-9]*-\d{1,6}) to (?<person>[^\r\n]{1,150})$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
        if (assign.Success) return ("assign_task", AiToolbox.UpdateWork, JsonSerializer.Serialize(new { key = assign.Groups["key"].Value.ToUpperInvariant(), assignee = assign.Groups["person"].Value.Trim() }, Json), true);
        var status = Regex.Match(query, @"^mark (?<key>[a-z][a-z0-9]*-\d{1,6}) as (?<status>[^\r\n]{1,50})$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
        if (status.Success) return ("update_task_status", AiToolbox.UpdateWork, JsonSerializer.Serialize(new { key = status.Groups["key"].Value.ToUpperInvariant(), status = status.Groups["status"].Value.Trim() }, Json), true);
        return null;
    }

    public async Task<AiCommandPlan?> ResolveAsync(AiRun run, CancellationToken ct)
    {
        if (run.Files.Count > 0) return null; // Uploaded material never enters the authoritative command parser.
        if (AiMessageCommands.ExactRequest(run.Text) is { } message)
            return new("send_message", true, new(AiToolbox.SendMessage, JsonSerializer.Serialize(new { recipient = message.Recipient, body = message.Body }, Json), null));
        if (AiMessageCommands.MissingBodyRecipient(run.Text) is { } recipient)
            return Read("clarify_message_content", await tools.MessageClarificationAsync(recipient, ct));
        if (AiReadCommands.Tasks(run.Text) is { } tasks)
            return Read("list_person_tasks", await tools.PersonTasksAsync(tasks.Person, tasks.Page, ct));
        if (ParseSimple(run.Text) is { } simple)
        {
            if (simple.Write) return new(simple.Intent, true, new(simple.Tool, simple.Input, null));
            return Read(simple.Intent, await tools.ExecuteAsync(simple.Tool, simple.Input, run.TimeZone, run.Plan.Actions, ct, run.Conversation.Id, run.Text));
        }
        var reminder = await AiFastReminder.TryAsync(run, db, clock, ct);
        return reminder is null ? null : new("reminder", reminder.Tool is not null, reminder);
    }
    private static AiCommandPlan Read(string intent, AiToolOutcome result) => new(intent, false, new(null, null, result.Content), result);
}
