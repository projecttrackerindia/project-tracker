# Authorized evidence and forecast evaluation

Knowledge search combines authorized project records, work items and the existing document index. Reads recheck current permissions, explicit document denies and published/draft visibility. Source versions can be supplied to reject stale reads. Excerpts are bounded; this is keyword retrieval, not a semantic search accuracy claim. Retrieved references are attached by the server to saved answers; their presence does not prove every generated claim.

Follow-up history with tracked evidence rechecks up to twenty distinct source versions. Stale, revoked or excessive evidence causes earlier turns to be omitted with an instruction to retrieve current evidence. Conversations with tracked sources do not generate or replay unversioned compacted summaries. Private transcript retention is separate from permission to reuse its evidence in a new model request. Legacy responses without tracked references are not a calibrated knowledge corpus.

Opt-in portfolio jobs capture forecast inputs with the result in a consistent database snapshot. Cancelled or superseded workers cannot commit a forecast. Partial reviews disclose their bounds and withhold delivery predictions. Accuracy views use actual server-audited Completed transitions, one latest eligible forecast per currently authorized project, and exclude changed scope, incomplete data and reopened or unfinished projects. Confidence remains heuristic, not calibrated probability. Evaluation is private to the requester and covers the last 90 days; no autonomous business write is enabled by a score.

Review admission is serialized per workspace: 20 pending reviews per person, 100 per workspace; five schedules per person, twenty per workspace. Overlapping scheduled reviews for the same requester, kind and team are deduplicated. Full queues defer schedules instead of creating more work. These limits protect SQL workers and do not certify 5,000 simultaneous AI conversations.

Hourly bounded maintenance expires saved review payloads after 30 days and forecast evidence after 90 days. Financial entries and business records are preserved. Review metadata and request keys remain available for deduplication.

Successful scheduled reviews create one private in-app notification if the requester allows report notifications. The notification contains no project content, links to the authorized result and is committed with the fenced result. It does not request email or push delivery.

Validation: 16 focused local tests passed for current tenant boundaries, document denies, stale versions, persistent job recovery, audited outcomes, credit accounting and the query-filter bypass guard. Frontend type checking passed. No live or bulk AI calls were made for these changes.

## Forecast confidence (project finish)

The project page forecast line and Aura's `project_report` and `why_late` answers say how sure the finish date is: "Likely 22 Dec · fairly sure". The method is deterministic, in `ForecastConfidence`; no model is involved and nothing is invented.

1. **Calibration.** Every project the slip-and-fix job looks at gets a weekly forecast snapshot (`MethodologyVersion = stage-forecast-v1`, kept 90 days). When a project is completed (the audited `project.status_changed` to Completed, not reopened afterwards), its forecast is the latest snapshot taken at least 7 days before the finish; the error is real finish minus forecast, in days. Scope changes are not excluded, because they are part of why forecasts miss.
2. **Enough data.** With fewer than 5 verified completed projects in the workspace there is nothing to calibrate against: the label is "early estimate" and there is no `confidencePct`. The reasons are still listed.
3. **Percentage.** With 5 or more, `confidencePct` is the Wilson lower bound (one-sided 90%) of the share of past forecasts that landed within 3 days, rounded to 5 and kept between 5 and 95. A handful of lucky projects therefore cannot read as certainty. The base band is high at 85 and above, medium at 65 and above, otherwise low.
4. **Evidence about this project** lowers the band one step per two points of concern: earlier stages that finished 2 days late on average (1 point) or 5 and over (2); an overloaded current stage owner (2); 3 or more tasks added in the last 14 days when that is at least a fifth of the open work (1). Words: sure, fairly sure, not very sure.

The DTO is `ProjectForecastDto.Confidence` (`band`, `label`, `confidencePct`, `calibrated`, `comparableProjects`, `withinDays`, `evidence`).

## Slip and fix job

`SlipFixWorker` runs every 3 hours (`SlipFix:WorkerEnabled`, `SlipFix:IntervalSeconds`), per workspace, skipping workspaces where the Project agent is Off, AI is disabled or the AI assistant is not in the plan. For each project owner it reads their active projects, stages, open tasks and owner load in bulk, forecasts every project, and for at most 5 projects whose forecast is at least 2 days later than the promised date builds one Aura proposal card.

- **Fix choice.** If the late stage's owner is overloaded, the card hands the stage (with open tasks) to the active project member with the most free time, using `LoadService.FitAsync`. Only people who fit and are free or balanced are chosen: never stretched, overloaded, on leave, suspended, a guest or not on the project. Otherwise, if the project is on manual stage dates, the card moves the promised date, with a reason written from the evidence. A date move always carries a reason (at least 8 characters) and is refused without one.
- **Safety.** The job runs as the project owner and only for projects they can edit. The card is an `AiProposal` bound to the workspace, the owner, a payload hash and a 24 hour expiry; confirming re-checks everything (version, current stage owner, membership) and is undoable.
- **Levels.** Off: nothing. Suggest and Ask first: a card, a briefing line and an "Overdue" notice with a Do it button (the notification quick-action pattern). Auto: reassignments are confirmed by the job and logged; date moves are never run automatically.
- **Idempotency.** The card id is derived from workspace, owner, project and day, so a second run the same day creates nothing; a project with a card in the last 24 hours, or one the owner dismissed in the last 7 days, is skipped. There is no schema change.

## Accuracy scoreboard

`GET /api/v1/ai/operations/forecasts/scoreboard` returns `visible`, `verified`, `meanAbsoluteErrorDays`, `percentWithinDays` and a note. It covers the projects the person can see and is hidden (`visible: false`, no numbers) until at least 5 completions are verified. Insights shows it as a small card labelled "Heuristic": it describes past accuracy and is not a promise about future forecasts.
