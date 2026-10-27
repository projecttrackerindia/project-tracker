using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// Quality: a test case testers run again and again (TC-118 "Loan dispatch API returns 200 for valid PAN"), optionally on a project.
/// <see cref="Priority"/> is Low, Medium, High or Critical; a failed Critical or High case is a release blocker.
/// </summary>
public class TestCase : TenantEntity, ITenantScoped
{
    public Guid? ProjectId { get; set; }
    /// <summary>The running number in the workspace; <see cref="Key"/> is "TC-" and this number.</summary>
    public int Number { get; set; }
    public string Key { get; set; } = "";
    public string Title { get; set; } = "";
    /// <summary>One step per line.</summary>
    public string? Steps { get; set; }
    public string? Expected { get; set; }
    public string Priority { get; set; } = "Medium";
    /// <summary>Comma-separated, e.g. "Loan dispatch, API".</summary>
    public string? Tags { get; set; }
}

/// <summary>One run of the cases on a build in an environment ("UAT 1.4" on UAT, build #214): Open, Running or Done.</summary>
public class TestRun : TenantEntity, ITenantScoped
{
    public Guid? ProjectId { get; set; }
    public string Name { get; set; } = "";
    public string? Environment { get; set; }
    public string? Build { get; set; }
    public string Status { get; set; } = "Open";
    public DateTime? StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
}

/// <summary>What one case did in one run: NotRun, Pass, Fail or Blocked, with what actually happened and the evidence (a cURL response).</summary>
public class TestResult : TenantEntity, ITenantScoped
{
    public Guid RunId { get; set; }
    public Guid CaseId { get; set; }
    public string Status { get; set; } = "NotRun";
    public string? Actual { get; set; }
    public string? Evidence { get; set; }
    public Guid? RunById { get; set; }
    public DateTime? At { get; set; }
    /// <summary>The bug filed from this result (a work item).</summary>
    public Guid? LinkedWorkItemId { get; set; }
}
