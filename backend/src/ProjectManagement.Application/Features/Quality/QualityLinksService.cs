using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.ApiDocs;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Quality;

/// <summary>What a test case verifies: <c>Kind</c> endpoint (an API endpoint; <c>DocumentId</c> is its API document) or document (a whole page).</summary>
public record TestCaseLinkDto(string Kind, Guid Id, Guid? DocumentId = null);
/// <summary>The latest result of a case (or of the endpoint's cases) in one environment: Pass, Fail or Blocked, from which run and when.</summary>
public record EnvResultDto(string Environment, string Status, DateTime? At, Guid RunId, string RunName, int Passed = 0, int Failed = 0, int Blocked = 0);
public record EndpointCaseDto(TestCaseDto Case, IReadOnlyList<EnvResultDto> Latest);
/// <summary>A test case written from the endpoint, not saved: "Add test case" opens with it; Groot's proposals are a list of these with <c>Kind</c> and <c>Why</c>.</summary>
public record CaseDraftDto(string Kind, string Title, string Steps, string Expected, string Priority, string Tags, string Why);
/// <summary>
/// An endpoint's "Tests": the cases linked to it, the latest run per environment, and whether it is covered (a case linked to it passed in a run
/// within <c>Days</c>). <c>Draft</c> prefills "Add test case" from the endpoint's method, path and expected status.
/// </summary>
public record EndpointTestsDto(Guid EndpointId, Guid DocumentId, string Method, string Path, Guid? ProjectId, IReadOnlyList<EndpointCaseDto> Cases,
    IReadOnlyList<EnvResultDto> Environments, bool Covered, DateTime? LastPassAt, int Days, CaseDraftDto Draft, bool CanEdit);
/// <summary>A project's API test coverage: endpoints with a passing run in the last <c>Days</c> days, of all its documented endpoints;
/// <c>Untested</c> endpoints have no case linked at all (the ids of the first few in <c>UntestedIds</c>).</summary>
public record ProjectCoverageDto(Guid ProjectId, int Endpoints, int Covered, int Linked, int Untested, int? Percent, IReadOnlyList<Guid> UntestedIds);
public record CoverageDto(int Days, IReadOnlyList<ProjectCoverageDto> Projects);

/// <summary>
/// Quality ↔ API docs. A test case names the endpoints (and documents) it verifies (<see cref="TestCase.LinksJson"/>). From that: an endpoint's
/// "Tests" with the latest result per environment, a project's coverage, and test cases proposed from the endpoint itself (happy path, a missing
/// required field, failed authentication, a downstream timeout, idempotency on retry, masked logs) for a person to confirm. Endpoints and documents
/// are read through the documents query filter, so a case can only link what the person may open, and nothing here reveals the rest.
/// </summary>
public class QualityLinksService(IAppDbContext db, AppClock clock, PermissionService permissions)
{
    public const int MaxLinks = 20;
    public const int DefaultDays = 30;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static IReadOnlyList<TestCaseLinkDto> ReadLinks(string? json)
    {
        if (string.IsNullOrWhiteSpace(json) || json == "[]") return [];
        try { return JsonSerializer.Deserialize<List<TestCaseLinkDto>>(json, Json) ?? []; }
        catch (JsonException) { return []; }
    }

    /// <summary>Checks the links (known kinds, things the person can open, at most <see cref="MaxLinks"/>) and returns them as the stored JSON.</summary>
    public async Task<string> CheckAsync(IReadOnlyList<TestCaseLinkDto> links, CancellationToken ct = default)
    {
        if (links.Count > MaxLinks) throw new ValidationException("links", $"A test case can verify at most {MaxLinks} things.");
        var clean = new List<TestCaseLinkDto>();
        var endpointIds = links.Where(l => string.Equals(l.Kind, "endpoint", StringComparison.OrdinalIgnoreCase)).Select(l => l.Id).Distinct().ToList();
        var docIds = links.Where(l => string.Equals(l.Kind, "document", StringComparison.OrdinalIgnoreCase)).Select(l => l.Id).Distinct().ToList();
        if (endpointIds.Count + docIds.Count != links.Select(l => ((l.Kind ?? "").ToLowerInvariant(), l.Id)).Distinct().Count())
            throw new ValidationException("links", "A link is to an endpoint or a document.");
        if (endpointIds.Count > 0)
        {
            var found = await (from e in db.ApiEndpoints.AsNoTracking()
                               join d in db.Documents.AsNoTracking() on e.DocumentId equals d.Id
                               where endpointIds.Contains(e.Id)
                               select new { e.Id, e.DocumentId }).ToListAsync(ct);
            if (found.Count != endpointIds.Count) throw new NotFoundException("Endpoint not found.", "ENDPOINT_NOT_FOUND");
            clean.AddRange(endpointIds.Select(id => new TestCaseLinkDto("endpoint", id, found.First(f => f.Id == id).DocumentId)));
        }
        if (docIds.Count > 0)
        {
            var found = await db.Documents.AsNoTracking().Where(d => docIds.Contains(d.Id)).Select(d => d.Id).ToListAsync(ct);
            if (found.Count != docIds.Count) throw new NotFoundException("Document not found.", "DOCUMENT_NOT_FOUND");
            clean.AddRange(docIds.Select(id => new TestCaseLinkDto("document", id)));
        }
        return JsonSerializer.Serialize(clean, Json);
    }

    /// <summary>Cases that link the endpoint (a text match narrows in the database, the parsed links decide).</summary>
    private async Task<List<TestCase>> CasesOfAsync(Guid endpointId, CancellationToken ct)
    {
        var needle = endpointId.ToString();
        var rows = await db.TestCases.AsNoTracking().Where(c => c.LinksJson.Contains(needle)).OrderBy(c => c.Number).Take(200).ToListAsync(ct);
        return rows.Where(c => ReadLinks(c.LinksJson).Any(l => l.Kind == "endpoint" && l.Id == endpointId)).ToList();
    }

    private sealed record Ran(Guid CaseId, Guid RunId, string RunName, string Environment, string Status, DateTime? At);

    private async Task<List<Ran>> ResultsAsync(IReadOnlyCollection<Guid> caseIds, CancellationToken ct) => caseIds.Count == 0 ? [] :
        (await (from r in db.TestResults.AsNoTracking()
                join run in db.TestRuns.AsNoTracking() on r.RunId equals run.Id
                where caseIds.Contains(r.CaseId) && r.Status != "NotRun"
                orderby r.At descending
                select new { r.CaseId, r.RunId, run.Name, run.Environment, r.Status, r.At, run.CreatedAt }).Take(5000).ToListAsync(ct))
        .Select(x => new Ran(x.CaseId, x.RunId, x.Name, string.IsNullOrWhiteSpace(x.Environment) ? "Default" : x.Environment!, x.Status, x.At ?? x.CreatedAt)).ToList();

    public async Task<EndpointTestsDto> EndpointAsync(Guid endpointId, int days = DefaultDays, CancellationToken ct = default)
    {
        days = Math.Clamp(days, 1, 365);
        var ep = await (from e in db.ApiEndpoints.AsNoTracking()
                        join d in db.Documents.AsNoTracking() on e.DocumentId equals d.Id
                        where e.Id == endpointId
                        select new { e.Id, e.DocumentId, e.DefinitionId, e.Method, e.Path, e.Summary, e.DetailsJson, d.ProjectId }).FirstOrDefaultAsync(ct)
                 ?? throw new NotFoundException("Endpoint not found.", "ENDPOINT_NOT_FOUND");
        var auth = await db.ApiDefinitions.AsNoTracking().Where(x => x.Id == ep.DefinitionId).Select(x => (ApiAuthScheme?)x.Auth).FirstOrDefaultAsync(ct) ?? ApiAuthScheme.None;
        var cases = await CasesOfAsync(endpointId, ct);
        var ran = await ResultsAsync(cases.Select(c => c.Id).ToList(), ct);
        var pids = cases.Where(c => c.ProjectId != null).Select(c => c.ProjectId!.Value).Distinct().ToList();
        var projectNames = pids.Count == 0 ? new Dictionary<Guid, string>() : await db.Projects.AsNoTracking().Where(p => pids.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => p.Name, ct);
        var caseDtos = cases.Select(c => new EndpointCaseDto(
            new TestCaseDto(c.Id, c.Key, c.Title, c.Steps, c.Expected, c.Priority, c.Tags, c.ProjectId, c.ProjectId is { } p ? projectNames.GetValueOrDefault(p) : null, c.CreatedAt, c.UpdatedAt, ReadLinks(c.LinksJson)),
            ran.Where(r => r.CaseId == c.Id).GroupBy(r => r.Environment).Select(g => g.OrderByDescending(r => r.At).First())
                .Select(r => new EnvResultDto(r.Environment, r.Status, r.At, r.RunId, r.RunName)).OrderBy(r => r.Environment).ToList())).ToList();
        // Per environment: the latest run that ran any of the cases, and how its cases went there.
        var envs = ran.GroupBy(r => r.Environment).Select(g =>
        {
            var latest = g.OrderByDescending(r => r.At).First();
            var inRun = g.Where(r => r.RunId == latest.RunId).ToList();
            var status = inRun.Any(r => r.Status == "Fail") ? "Fail" : inRun.Any(r => r.Status == "Blocked") ? "Blocked" : "Pass";
            return new EnvResultDto(g.Key, status, latest.At, latest.RunId, latest.RunName, inRun.Count(r => r.Status == "Pass"), inRun.Count(r => r.Status == "Fail"), inRun.Count(r => r.Status == "Blocked"));
        }).OrderBy(e => e.Environment).ToList();
        var since = clock.Now.AddDays(-days);
        var lastPass = ran.Where(r => r.Status == "Pass").Select(r => r.At).Max();
        var details = ApiJson.Read(ep.DetailsJson);
        var method = ep.Method.ToString().ToUpperInvariant();
        return new EndpointTestsDto(ep.Id, ep.DocumentId, method, ep.Path, ep.ProjectId, caseDtos, envs, lastPass is { } lp && lp >= since, lastPass, days,
            Drafts(method, ep.Path, ep.Summary, details, auth)[0], await permissions.LevelAsync(ProjectManagement.Domain.Modules.Work, ct) >= ProjectManagement.Domain.AccessLevel.Edit);
    }

    /// <summary>Groot's proposals for the endpoint: written from its own description (parameters, statuses, auth, method); nothing is saved.</summary>
    public async Task<IReadOnlyList<CaseDraftDto>> SuggestAsync(Guid endpointId, CancellationToken ct = default)
    {
        var ep = await (from e in db.ApiEndpoints.AsNoTracking()
                        join d in db.Documents.AsNoTracking() on e.DocumentId equals d.Id
                        where e.Id == endpointId
                        select new { e.Method, e.Path, e.Summary, e.DetailsJson, e.DefinitionId }).FirstOrDefaultAsync(ct)
                 ?? throw new NotFoundException("Endpoint not found.", "ENDPOINT_NOT_FOUND");
        var auth = await db.ApiDefinitions.AsNoTracking().Where(x => x.Id == ep.DefinitionId).Select(x => (ApiAuthScheme?)x.Auth).FirstOrDefaultAsync(ct) ?? ApiAuthScheme.None;
        var existing = (await CasesOfAsync(endpointId, ct)).Select(c => c.Title.ToLowerInvariant()).ToHashSet();
        return Drafts(ep.Method.ToString().ToUpperInvariant(), ep.Path, ep.Summary, ApiJson.Read(ep.DetailsJson), auth).Where(d => !existing.Contains(d.Title.ToLowerInvariant())).ToList();
    }

    /// <summary>The proposals, happy path first (which is also the "Add test case" prefill).</summary>
    public static List<CaseDraftDto> Drafts(string method, string path, string? summary, EndpointDetails d, ApiAuthScheme apiAuth)
    {
        var call = $"{method} {path}";
        var parameters = d.Parameters ?? []; var responses = d.Responses ?? []; var dependencies = d.Dependencies ?? [];
        var ok = responses.Select(r => r.Status).FirstOrDefault(s => s.StartsWith('2')) ?? (method == "POST" ? "201" : "200");
        var required = parameters.Where(p => p.Required && p.In != "header").Select(p => p.Name).ToList();
        if (d.RequestBody?.Schema is { } schema)
            try
            {
                using var doc = JsonDocument.Parse(schema);
                if (doc.RootElement.TryGetProperty("required", out var req) && req.ValueKind == JsonValueKind.Array)
                    required.AddRange(req.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!));
            }
            catch (JsonException) { /* a schema that is not JSON proposes nothing about its fields */ }
        var authed = d.Auth == "inherit" ? apiAuth != ApiAuthScheme.None : !string.Equals(d.Auth, "none", StringComparison.OrdinalIgnoreCase);
        var tag = $"API, {method}";
        var what = string.IsNullOrWhiteSpace(summary) ? call : summary.Trim();
        var list = new List<CaseDraftDto>
        {
            new("happy", $"{call} returns {ok} for a valid request", $"Send {call} with valid values{(authed ? " and a valid token" : "")}\nAssert the status\nAssert the response matches the documented schema",
                $"{ok} · response matches the documented schema", "High", tag, $"The documented success response of \"{what}\"."),
        };
        if (required.Count > 0)
        {
            var field = required.First();
            list.Add(new("required", $"{call} rejects a missing required field ({field}) with 400", $"Send {call} without {field}\nAssert the status\nAssert the error names {field}",
                "400 · error names the missing field", "High", tag, $"{string.Join(", ", required.Distinct().Take(4))} {(required.Count == 1 ? "is" : "are")} required."));
        }
        if (authed)
        {
            list.Add(new("auth", $"{call} refuses a missing or expired token with 401", $"Send {call} with no token\nSend it again with an expired token\nAssert both statuses",
                "401 · no data in the body", "Critical", $"{tag}, Security", "The API requires authentication."));
            list.Add(new("forbidden", $"{call} refuses a caller without access with 403", $"Send {call} with a valid token of a caller without access\nAssert the status",
                "403 · no data in the body", "High", $"{tag}, Security", "Valid but unauthorised callers must be refused."));
        }
        if (dependencies.Count > 0 || method != "GET")
            list.Add(new("timeout", $"{call} answers 504 when a downstream system times out", $"Make {(dependencies.FirstOrDefault()?.Name ?? "the downstream system")} slow beyond the timeout\nSend {call}\nAssert the status and that nothing was half-written",
                "504 (or 502) within the timeout · no partial write", "Medium", $"{tag}, Resilience", dependencies.Count > 0 ? $"It depends on {string.Join(", ", dependencies.Take(3).Select(x => x.Name))}." : "A write must fail cleanly."));
        if (method is "POST" or "PUT" or "PATCH")
            list.Add(new("idempotency", $"{call} is safe to retry (same idempotency key twice)", $"Send {call} with an idempotency key\nSend the same request again with the same key\nAssert one record and the same response",
                "Same response twice · one record created", "High", $"{tag}, Resilience", "Clients retry writes after a timeout."));
        list.Add(new("masking", $"{call} keeps personal data and credentials masked in logs", $"Send {call} with test personal data (mobile, PAN, account number) and a token\nRead the API logs for the request\nAssert values are masked",
            "Logs show masked values only (e.g. XXXXXX1234)", "Medium", $"{tag}, Security", "Logs must never hold personal data or credentials."));
        return list;
    }

    /// <summary>Coverage of every project the person can see that has documented endpoints (or one project).</summary>
    public async Task<CoverageDto> CoverageAsync(Guid? projectId, int days = DefaultDays, CancellationToken ct = default)
    {
        days = Math.Clamp(days, 1, 365);
        var endpoints = await (from e in db.ApiEndpoints.AsNoTracking()
                               join d in db.Documents.AsNoTracking() on e.DocumentId equals d.Id
                               where d.ProjectId != null && (projectId == null || d.ProjectId == projectId) && !e.Deprecated
                               select new { e.Id, ProjectId = d.ProjectId!.Value }).Take(20_000).ToListAsync(ct);
        if (endpoints.Count == 0) return new CoverageDto(days, []);
        var visibleProjects = endpoints.Select(e => e.ProjectId).Distinct().ToList();
        visibleProjects = await db.Projects.AsNoTracking().Where(p => visibleProjects.Contains(p.Id)).Select(p => p.Id).ToListAsync(ct);
        var linked = await db.TestCases.AsNoTracking().Where(c => c.LinksJson != "[]" && c.LinksJson.Contains("endpoint")).Select(c => new { c.Id, c.LinksJson }).Take(10_000).ToListAsync(ct);
        var byEndpoint = linked.SelectMany(c => ReadLinks(c.LinksJson).Where(l => l.Kind == "endpoint").Select(l => (Endpoint: l.Id, Case: c.Id)))
            .GroupBy(x => x.Endpoint).ToDictionary(g => g.Key, g => g.Select(x => x.Case).ToHashSet());
        var since = clock.Now.AddDays(-days);
        var caseIds = byEndpoint.Values.SelectMany(x => x).Distinct().ToList();
        var passing = caseIds.Count == 0 ? [] : (await db.TestResults.AsNoTracking().Where(r => caseIds.Contains(r.CaseId) && r.Status == "Pass" && r.At != null && r.At >= since)
            .Select(r => r.CaseId).Distinct().ToListAsync(ct)).ToHashSet();
        var list = endpoints.Where(e => visibleProjects.Contains(e.ProjectId)).GroupBy(e => e.ProjectId).Select(g =>
        {
            var total = g.Count();
            var covered = g.Count(e => byEndpoint.TryGetValue(e.Id, out var cs) && cs.Overlaps(passing));
            var untested = g.Where(e => !byEndpoint.ContainsKey(e.Id)).Select(e => e.Id).ToList();
            return new ProjectCoverageDto(g.Key, total, covered, total - untested.Count, untested.Count, total == 0 ? null : (int)Math.Round(covered * 100.0 / total), untested.Take(20).ToList());
        }).ToList();
        return new CoverageDto(days, list);
    }
}
