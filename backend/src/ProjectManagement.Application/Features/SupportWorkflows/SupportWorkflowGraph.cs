using System.Text.Json;
using System.Text.RegularExpressions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Support;
namespace ProjectManagement.Application.Features.SupportWorkflows;

public record SupportWorkflowNode(string Id, string Type, string Label, string? Next = null, string? Otherwise = null,
    string? Field = null, string? Value = null, int Minutes = 0, double X = 0, double Y = 0);
public record SupportWorkflowGraph(string Trigger, IReadOnlyList<SupportWorkflowNode> Nodes);

public static class SupportWorkflowGraphs
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public static readonly string[] Triggers = ["manual", "ticket_created", "message_received", "state_changed", "assignment_changed", "priority_changed", "sla_breach", "schedule"];
    private static readonly string[] Types = ["start", "condition", "note", "handoff", "assign", "wait", "approval", "end"];
    private static readonly string[] Fields = ["category", "region", "language", "state", "priority", "team", "project"];

    public static string? ConditionValue(SupportTicketDto ticket,string? field)=>field switch
    {
        "category"=>ticket.Category,"region"=>ticket.Region,"language"=>ticket.Language,"state"=>ticket.State,
        "priority"=>ticket.Work.Priority.ToString(),"team"=>ticket.TeamId?.ToString(),"project"=>ticket.Work.RelatedProject?.Id.ToString(),_=>null
    };
    public static SupportWorkflowGraph Validate(SupportWorkflowGraph graph)
    {
        void Invalid(string reason) => throw new ValidationException("graph", reason);
        if (graph is null || graph.Nodes is null || graph.Nodes.Count is < 2 or > 40 || !Triggers.Contains(graph.Trigger))
            throw new ValidationException("graph", "Choose a supported trigger and two to forty nodes.");
        if (JsonSerializer.Serialize(graph, Json).Length > 32000) Invalid("Keep the workflow under 32,000 characters.");
        if (graph.Nodes.Any(n => n is null)) Invalid("Every node must be defined.");
        if (graph.Nodes.Select(n => n.Id).Distinct(StringComparer.Ordinal).Count() != graph.Nodes.Count) Invalid("Node identifiers must be unique.");
        if (graph.Nodes.Count(n => n.Type == "start") != 1 || !graph.Nodes.Any(n => n.Type == "end")) Invalid("Include one start and at least one end node.");
        if (graph.Nodes.Any(n => n.Id is null || !Regex.IsMatch(n.Id, "^[a-zA-Z0-9_-]{1,40}$"))) Invalid("Use simple node identifiers from one to forty characters.");
        var nodes = graph.Nodes.ToDictionary(n => n.Id);
        foreach (var n in graph.Nodes)
        {
            if (n.Id is null || !Regex.IsMatch(n.Id, "^[a-zA-Z0-9_-]{1,40}$") || !Types.Contains(n.Type) || string.IsNullOrWhiteSpace(n.Label) || n.Label.Length > 100)
                Invalid("Use supported node types, short labels and simple identifiers.");
            if (!double.IsFinite(n.X) || !double.IsFinite(n.Y) || Math.Abs(n.X)>100000 || Math.Abs(n.Y)>100000) Invalid("Keep node positions within the canvas bounds.");
            if (n.Type == "end")
            {
                if (n.Next is not null || n.Otherwise is not null) Invalid("An end node cannot have outgoing connections.");
            }
            else
            {
                if (n.Next is null || !nodes.ContainsKey(n.Next)) Invalid("Every non-terminal node needs a valid next connection.");
                if (n.Type is "condition" or "approval")
                { if (n.Otherwise is null || !nodes.ContainsKey(n.Otherwise)) Invalid("Conditions and approvals need a second connection."); }
                else if (n.Otherwise is not null) Invalid("Only conditions and approvals have a second connection.");
            }
            if (n.Type == "condition" && (!Fields.Contains(n.Field) || string.IsNullOrWhiteSpace(n.Value) || n.Value.Length > 120)) Invalid("Choose a supported condition field and an exact comparison value.");
            if (n.Type is "note" or "handoff" && (string.IsNullOrWhiteSpace(n.Value) || n.Value.Length > 1000)) Invalid("Add a note or handoff reason up to 1,000 characters.");
            if (n.Type == "assign" && (!Guid.TryParse(n.Value, out var user) || user == Guid.Empty)) Invalid("Choose an assignee identifier.");
            if (n.Type == "wait" && n.Minutes is < 1 or > 10080) Invalid("Waits must be between one minute and seven days.");
        }
        if(graph.Nodes.Where(n=>n.Type=="wait").Sum(n=>n.Minutes)>10080)Invalid("The combined waits must not exceed seven days.");
        var visiting = new HashSet<string>(); var visited = new HashSet<string>(); var checkedPaths = new HashSet<(string Id, bool Approved)>();
        void Visit(string id, bool approved)
        {
            if (visiting.Contains(id)) Invalid("Workflow loops are not supported.");
            if (!checkedPaths.Add((id,approved)))return;
            visiting.Add(id);
            var node = nodes[id];
            if (node.Type is "assign" or "handoff" && !approved) Invalid("Assignments and handoffs must follow an approval on every path.");
            visited.Add(id);
            var nextApproved=(approved || node.Type == "approval") && node.Type is not ("assign" or "handoff" or "note");
            if (node.Next is not null) Visit(node.Next, nextApproved);
            // A rejected approval does not authorize an action on the rejection branch.
            if (node.Otherwise is not null) Visit(node.Otherwise, approved);
            visiting.Remove(id);
        }
        Visit(graph.Nodes.Single(n => n.Type == "start").Id, false);
        if (visited.Count != graph.Nodes.Count) Invalid("Remove unreachable nodes or connect them to the start.");
        return graph;
    }
}