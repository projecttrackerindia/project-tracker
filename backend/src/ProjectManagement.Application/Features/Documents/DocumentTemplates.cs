using System.Text.Json;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Documents;

/// <summary>The built-in kinds of document every workspace starts with. They are copied into the workspace as rows, so a workspace can switch them off and later releases let it add its own.</summary>
public static class DocumentTemplates
{
    private static SectionTemplate Rich(string key, string title, string hint) => new(key, title, SectionKind.RichText, hint);
    private static SectionTemplate Grid(string key, string title, string hint, params string[] columns) => new(key, title, SectionKind.Table, hint, columns);

    public sealed record BuiltIn(string Code, string Name, string Description, string Icon, string Color, SectionTemplate[] Sections);

    private static readonly SectionTemplate[] Overview = [Rich("overview", "Overview", "What this document covers and who it is for."), Rich("details", "Details", "The content.")];

    public static readonly BuiltIn[] All =
    [
        new("BRD", "Business requirement document", "What the business needs, for whom and why, before anyone designs or builds it.", "file", "#7c3aed",
        [
            Rich("basicInfo", "Basic information", "Purpose, background, the business owner and the date it is needed."),
            Rich("businessRequirements", "Business requirements", "The outcomes the business needs, in plain language."),
            Rich("functionalRequirements", "Functional requirements", "What the solution must do."),
            Rich("nonFunctional", "Non-functional requirements", "Performance, availability, security, audit and similar qualities."),
            Rich("scope", "Scope", "What is in scope and, as clearly, what is out of scope."),
            Rich("dependencies", "Dependencies", "Other teams, systems, decisions or deliveries this relies on."),
            Rich("assumptions", "Assumptions", "What is taken as true without proof."),
            Grid("risks", "Risks", "What could go wrong and what will be done about it.", "Risk", "Impact", "Likelihood", "Mitigation", "Owner"),
            Grid("stakeholders", "Stakeholders", "Who is affected, who decides and who needs to be told.", "Name", "Role", "Interest"),
            Grid("systems", "Systems, APIs and endpoints", "The systems and interfaces involved.", "System or API", "Endpoint", "Purpose", "Owner"),
            Rich("architecture", "Architecture and flow", "How the parts fit together: describe the flow, add a diagram."),
            Rich("testing", "Testing requirements", "How it will be shown to work: scenarios, data, environments, acceptance."),
        ]),
        new("API", "API documentation", "How to call an interface: authentication, requests, responses and errors.", "code", "#0ea5e9",
        [
            Rich("overview", "Overview", "What the API is for and who uses it."),
            Rich("authentication", "Authentication", "How a caller proves who it is."),
            Grid("endpoints", "Endpoints", "Each operation the API offers.", "Method", "Path", "Description", "Auth", "Notes"),
            Rich("requests", "Requests and responses", "Examples of calls and what comes back."),
            Grid("errors", "Errors", "What can go wrong and how it is reported.", "Code", "Meaning", "What the caller should do"),
            Rich("dependencies", "Dependencies", "What this API relies on."),
        ]),
        new("TECH", "Technical documentation", "How something is built and why.", "tool", "#475569",
        [Rich("overview", "Overview", ""), Rich("design", "Design", "Components, data and decisions."), Rich("implementation", "Implementation notes", ""), Rich("operations", "Running it", "Configuration, monitoring and support.")]),
        new("FUNC", "Functional documentation", "What a feature does, screen by screen and rule by rule.", "list", "#16a34a",
        [Rich("overview", "Overview", ""), Rich("scenarios", "Scenarios and rules", "Who does what, and the rules that apply."), Grid("fields", "Data and fields", "The information involved.", "Field", "Type", "Rule", "Required")]),
        new("TEST_PLAN", "Test plan", "How a piece of work will be tested.", "check", "#f59e0b",
        [Rich("scope", "Scope and approach", "What is tested and how."), Rich("environments", "Environments and data", ""), Grid("schedule", "Schedule and owners", "", "Activity", "Owner", "When"), Rich("exit", "Entry and exit criteria", "")]),
        new("TEST_CASES", "Test cases", "The checks to run, with the expected result of each.", "check", "#f59e0b",
        [Rich("overview", "Overview", ""), Grid("cases", "Cases", "", "Id", "Title", "Steps", "Expected result", "Priority")]),
        new("TEST_RESULTS", "Test results", "What happened when the tests were run.", "chart", "#f59e0b",
        [Rich("summary", "Summary", "The overall outcome."), Grid("results", "Results", "", "Case", "Result", "Defect", "Notes"), Rich("conclusion", "Conclusion and sign-off", "")]),
        new("INTEG", "Integration documentation", "How two or more systems exchange information.", "link", "#06b6d4",
        [Rich("overview", "Overview", "The systems and the purpose of the exchange."), Rich("flow", "Flow", "What is sent, when, and by whom."), Grid("mapping", "Field mapping", "", "Source field", "Target field", "Rule"), Rich("errors", "Errors and retries", "")]),
        new("ARCH", "Architecture documentation", "The shape of a system and the reasons behind it.", "layers", "#8b5cf6",
        [Rich("context", "Context", "The problem and the constraints."), Rich("architecture", "Architecture", "Components and how they connect."), Rich("decisions", "Decisions", "What was chosen and why."), Rich("quality", "Quality attributes", "")]),
        new("DEPLOY", "Deployment documentation", "How to put a release into an environment.", "upload", "#ef4444",
        [Rich("prerequisites", "Prerequisites", ""), Rich("steps", "Deployment steps", ""), Rich("rollback", "Rollback", ""), Rich("verification", "Verification", "")]),
        new("OPS", "Operational documentation", "How to run and support it day to day.", "bolt", "#14b8a6",
        [Rich("overview", "Overview", ""), Rich("routine", "Routine tasks", ""), Rich("incidents", "Incidents and escalation", ""), Rich("contacts", "Contacts", "")]),
        new("PROJECT", "Project documentation", "Plans, decisions and records of a project.", "folder", "#7c3aed",
        [Rich("summary", "Summary", ""), Rich("plan", "Plan", ""), Rich("decisions", "Decisions and notes", "")]),
        new("PROCESS", "Process documentation", "How work is done: steps, roles and rules.", "route", "#22c55e",
        [Rich("purpose", "Purpose", ""), Rich("steps", "Steps", ""), Grid("roles", "Roles", "", "Role", "Responsibility")]),
        new("SECURITY", "Security documentation", "Controls, risks and how they are handled.", "shield", "#dc2626",
        [Rich("overview", "Overview", ""), Rich("controls", "Controls", ""), Grid("risks", "Risks", "", "Risk", "Impact", "Control", "Owner")]),
        new("RELEASE", "Release documentation", "What changed in a release and what to know about it.", "rocket", "#ea580c",
        [Rich("summary", "Summary", "What this release delivers."), Rich("changes", "Changes", "New, changed and fixed."), Rich("knownIssues", "Known issues", ""), Rich("upgrade", "Upgrade notes", "")]),
        new("ENV", "Environment documentation", "A system landscape: servers, URLs, access and configuration notes.", "server", "#0d9488",
        [Rich("overview", "Overview", ""), Grid("components", "Components", "", "Component", "Location", "Purpose", "Owner"), Rich("access", "Access and configuration", "Describe how access is granted. Do not paste secrets here.")]),
    ];

    public static string ToJson(SectionTemplate[] sections) => JsonSerializer.Serialize(sections, Json);

    public static SectionTemplate[] FromJson(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try { return JsonSerializer.Deserialize<SectionTemplate[]>(json, Json) ?? []; }
        catch (JsonException) { return []; }
    }

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() } };
}
