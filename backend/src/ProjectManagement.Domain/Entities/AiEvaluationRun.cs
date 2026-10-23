using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// One grading of the assistant against the scenario library (tools/ai-evaluation/run-scenarios.mjs), as reported by the person who ran
/// it: how many passed, by area and by language. Numbers only; no questions or answers are stored here.
/// </summary>
public class AiEvaluationRun : TenantEntity, ITenantScoped
{
    public DateTime RanAt { get; set; }
    public string? Model { get; set; }
    public string? Mode { get; set; }
    public int Total { get; set; }
    public int Passed { get; set; }
    public int Credits { get; set; }
    /// <summary>JSON: {"byArea":{"vault":{"pass":8,"total":9}},"byLang":{...}}.</summary>
    public string SummaryJson { get; set; } = "{}";
}
