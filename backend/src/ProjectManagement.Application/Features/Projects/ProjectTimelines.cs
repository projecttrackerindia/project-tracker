using ProjectManagement.Application.Exceptions;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Projects;

/// <summary>One stage of a timeline template, with the share of the project's duration it is planned to take (0 = a milestone-like marker).</summary>
public record TimelineTemplateStage(string Name, int Weight);

/// <summary>A ready-made project lifecycle chosen when a project is created. The stages are copied into the project, where they can still be edited.</summary>
public record TimelineTemplate(string Key, string Name, string Description, IReadOnlyList<TimelineTemplateStage> Stages);

/// <summary>One choice in the "Project timeline" list. Custom ones (the workspace's own) carry their id and each stage's time share so they can be edited.</summary>
public record TimelineTemplateDto(string Key, string Name, string Description, bool IsDefault, IReadOnlyList<string> Stages,
    bool IsCustom = false, Guid? Id = null, IReadOnlyList<int>? Weights = null);

public static class TimelineTemplates
{
    public const string DefaultKey = "software";

    public static readonly IReadOnlyList<TimelineTemplate> All =
    [
        new("software", "Software delivery", "The standard software lifecycle, from planning through review and testing to production.",
        [
            new("Project Created", 0), new("Requirements & Planning", 1), new("Development", 4), new("Code Review", 1),
            new("Testing / QA", 2), new("UAT", 1), new("Production Deployment", 1), new("Project Completed", 0),
        ]),
        new("simple", "Simple project", "A short plan, do and review cycle for work that does not need a formal lifecycle.",
        [
            new("Project Created", 0), new("Planning", 1), new("Execution", 4), new("Review", 1), new("Project Completed", 0),
        ]),
        new("marketing", "Marketing campaign", "From the brief to content, approval, launch and a look back at the results.",
        [
            new("Project Created", 0), new("Brief & Planning", 1), new("Content Creation", 3), new("Review & Approval", 1),
            new("Launch", 1), new("Performance Review", 1), new("Project Completed", 0),
        ]),
    ];

    /// <summary>The template with this key; the default one when none is given; a validation error for anything else.</summary>
    public static TimelineTemplate Resolve(string? key)
    {
        if (string.IsNullOrWhiteSpace(key)) key = DefaultKey;
        return All.FirstOrDefault(t => string.Equals(t.Key, key.Trim(), StringComparison.OrdinalIgnoreCase))
            ?? throw new ValidationException("timelineTemplate", "Choose one of the available project timelines.");
    }
}

/// <summary>
/// The order rule of a timeline: a stage can only be started or completed once the stage before it is completed, so stages
/// cannot be skipped. A stage is <i>locked</i> while the one before it is unfinished (a completed stage is never locked).
/// </summary>
public static class StageSequence
{
    public const string PreviousIncompleteCode = "STAGE_PREVIOUS_INCOMPLETE";

    /// <param name="ordered">The project's stages in timeline order.</param>
    public static ProjectStage? PreviousOf(IReadOnlyList<ProjectStage> ordered, ProjectStage stage)
    {
        var i = ordered.ToList().FindIndex(s => s.Id == stage.Id);
        return i > 0 ? ordered[i - 1] : null;
    }

    public static ProjectStage? NextOf(IReadOnlyList<ProjectStage> ordered, ProjectStage stage)
    {
        var i = ordered.ToList().FindIndex(s => s.Id == stage.Id);
        return i >= 0 && i < ordered.Count - 1 ? ordered[i + 1] : null;
    }

    public static bool IsLocked(ProjectStage? previous, StageStatus current) => previous is not null && previous.Status != StageStatus.Completed && current != StageStatus.Completed;

    /// <summary>"Please complete Development before completing Code Review."</summary>
    public static ConflictException Refusal(string previousName, string stageName, bool completing) =>
        new($"Please complete {previousName} before {(completing ? "completing" : "starting")} {stageName}.", PreviousIncompleteCode);

    /// <summary>Throws when <paramref name="requested"/> would start or complete a stage whose predecessor is unfinished. Going back to Pending is always fine.</summary>
    public static void EnsureAllowed(ProjectStage? previous, ProjectStage stage, StageStatus requested)
    {
        if (previous is null || previous.Status == StageStatus.Completed) return;
        if (requested == stage.Status || requested == StageStatus.Pending) return;
        throw Refusal(previous.Name, stage.Name, requested == StageStatus.Completed);
    }
}
